/**
 * file-cleanup 的 Host 侧测试：只依赖 Node 内置模块。
 *
 * 跑法（不要用 `node --test`，受限沙箱下它会 spawn EPERM）：
 *   node test/cleanup.test.mjs
 *
 * 覆盖：规则表命中与不命中、`isWithin` 的严格子路径语义、扫描预览、
 * 只删白名单、范围围栏、保护区、链接跳过、只回收本次变空的目录。
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	buildPlan,
	classifyEntry,
	cleanItems,
	isWithin,
	resolveDshHome,
	scanPlan,
} from '../lib/core.js';

let passed = 0;
const failures = [];

/** 记录一条断言结果。 */
function check(name, fn) {
	return Promise.resolve()
		.then(fn)
		.then(() => {
			passed += 1;
			console.log(`ok   ${name}`);
		})
		.catch((error) => {
			failures.push({ name, error });
			console.log(`FAIL ${name}\n     ${error?.message ?? error}`);
		});
}

/** 写一个文件（自动建父目录）。 */
function write(root, relativePath, content = 'x') {
	const full = join(root, relativePath);
	mkdirSync(join(full, '..'), { recursive: true });
	writeFileSync(full, content);
	return full;
}

/** 目录里有没有这个东西。 */
function has(root, relativePath) {
	return existsSync(join(root, relativePath));
}

const base = mkdtempSync(join(tmpdir(), 'file-cleanup-test-'));
const workspace = join(base, 'workspace');
const dshHome = join(base, 'dsh-home');
mkdirSync(workspace, { recursive: true });
mkdirSync(dshHome, { recursive: true });

// ── 规则表 ─────────────────────────────────────────────────────────────────
await check('临时文件命中白名单', () => {
	for (const name of ['a.tmp', 'b.TEMP', 'c.part', 'd.partial', 'e.crdownload', 'f.download', 'g.swp', 'h.swo', 'i.swn', 'j.stackdump', 'k.$$$', 'foo.txt~', '~$report.docx', 'hs_err_pid1234.log']) {
		assert.equal(classifyEntry(name, false), 'temp', `${name} 应判为临时文件`);
	}
});

await check('系统噪声命中白名单', () => {
	for (const name of ['Thumbs.db', 'ehthumbs.db', 'desktop.ini', '.DS_Store', '._resource', 'npm-debug.log.1', 'yarn-error.log', 'pnpm-debug.log.2', 'a.orig', 'b.rej', 'core.1234', '.eslintcache', '.stylelintcache']) {
		assert.equal(classifyEntry(name, false), 'noise', `${name} 应判为噪声`);
	}
});

await check('源码 / 文档 / 配置 / 构建产物都不命中', () => {
	for (const name of ['core.js', 'index.js', 'README.md', 'package.json', 'bundle.js', 'app.ts', 'notes.txt', 'data.json', 'core.js.bak', 'temp.js', 'thumbs.db.txt', 'report.docx', 'dist']) {
		assert.equal(classifyEntry(name, false), null, `${name} 不该被判为垃圾`);
	}
});

await check('缓存目录只认目录形式', () => {
	assert.equal(classifyEntry('__pycache__', true), 'cache');
	assert.equal(classifyEntry('.cache', true), 'cache');
	assert.equal(classifyEntry('.cache', false), null, '同名文件不算缓存目录');
	assert.equal(classifyEntry('node_modules', true), null, 'node_modules 不在白名单');
});

await check('isWithin 是严格子路径', () => {
	assert.equal(isWithin('C:\\a\\b', 'C:\\a\\b\\c'), true);
	assert.equal(isWithin('C:\\a\\b', 'C:\\a\\b'), false, '相等不算在内部');
	assert.equal(isWithin('C:\\a\\b', 'C:\\a'), false);
	assert.equal(isWithin('C:\\a\\b', 'C:\\a\\bc'), false);
	if (process.platform === 'win32') assert.equal(isWithin('C:\\A\\B', 'c:\\a\\b\\d'), true, 'Windows 大小写不敏感');
});

await check('DSH_HOME 解析支持 ~ 与回退', () => {
	assert.equal(resolveDshHome({ DSH_HOME: '' }), resolveDshHome({}), '空值回退到默认');
	assert.ok(resolveDshHome({ DSH_HOME: '~/x' }).endsWith(join('x')), '~ 会展开');
});

// ── 造一棵像工作区的树 ─────────────────────────────────────────────────────
const keepFiles = [
	['keep.txt', 'keep-me'],
	['src/app.js', 'console.log(1)'],
	['notes.md', '# notes'],
	['dist/bundle.js', 'built'],
	['core.js', 'plugin source'],
];
for (const [relative, content] of keepFiles) write(workspace, relative, content);

const junkFiles = ['a.tmp', 'sub/b.temp', 'c.part', 'Thumbs.db', '.DS_Store', 'npm-debug.log', 'x.orig', 'core.4242', 'deep/inner/foo.txt~'];
for (const relative of junkFiles) write(workspace, relative, 'junk');

write(workspace, '__pycache__/mod.pyc', 'pyc');
write(workspace, 'pkg/__pycache__/other.pyc', 'pyc');
write(workspace, '.cache/blob.bin', 'cache');
write(workspace, '.pytest_cache/v/cache/lastfailed', '{}');
write(workspace, 'node_modules/dep/index.js', 'dep');
write(workspace, 'node_modules/dep/.cache/keep.bin', 'dep-cache');
write(workspace, '.git/config', 'git');
mkdirSync(join(workspace, 'pre-empty'), { recursive: true });
mkdirSync(join(workspace, 'will-empty'), { recursive: true });
write(workspace, 'will-empty/only.tmp', 'junk');
try {
	symlinkSync(join(workspace, 'src'), join(workspace, 'link-to-src'), 'junction');
} catch {
	/* 没有建链接的权限就跳过这一项 */
}

const plan = buildPlan({ scope: 'workspaces', workspaces: [{ path: workspace, title: 'ws' }], dshHome });
const preview = await scanPlan(plan);

await check('预览里没有不该删的东西', () => {
	const paths = preview.items.map((item) => item.path);
	const forbidden = ['keep.txt', 'src\\app.js', 'notes.md', 'dist\\bundle.js', 'core.js', 'node_modules\\dep\\index.js', '.git\\config'];
	for (const relative of forbidden) {
		assert.ok(!paths.includes(join(workspace, relative)), `${relative} 不该进清单`);
	}
});

await check('预览命中垃圾与缓存目录', () => {
	const paths = preview.items.map((item) => item.path);
	for (const relative of ['a.tmp', 'Thumbs.db', 'deep\\inner\\foo.txt~']) {
		assert.ok(paths.includes(join(workspace, relative)), `${relative} 应该进清单`);
	}
	assert.ok(paths.includes(join(workspace, '__pycache__')), '__pycache__ 应作为整目录候选');
	assert.ok(paths.includes(join(workspace, '.cache')), '.cache 应作为整目录候选');
	assert.ok(preview.totals.files > 0 && preview.totals.bytes > 0, '统计应大于 0');
	assert.equal(preview.capped, false);
});

await check('预览按体积降序且带范围标签', () => {
	const sizes = preview.items.map((item) => item.bytes);
	const sorted = [...sizes].sort((a, b) => b - a);
	assert.deepEqual(sizes, sorted);
	assert.equal(preview.rootsLabel[0].path, plan.roots[0]);
});

// ── 删除 ───────────────────────────────────────────────────────────────────
const result = await cleanItems(plan, preview.items);

await check('垃圾真的没了', () => {
	for (const relative of ['a.tmp', 'Thumbs.db', '__pycache__', '.cache', '.pytest_cache', 'will-empty']) {
		assert.ok(!has(workspace, relative), `${relative} 应被删除`);
	}
});

await check('白名单外的东西逐字节不变', () => {
	for (const [relative, content] of keepFiles) {
		assert.equal(readFileSync(join(workspace, relative), 'utf8'), content, `${relative} 内容被改了`);
	}
	assert.ok(has(workspace, 'node_modules/dep/index.js'), 'node_modules 不应被动');
	assert.ok(has(workspace, '.git/config'), '.git 不应被动');
	assert.ok(has(workspace, 'pre-empty'), '原本就空的目录不该被回收');
});

await check('只回收本次变空的目录', () => {
	assert.ok(result.removedEmptyDirs.includes(join(workspace, 'will-empty')), 'will-empty 应该被回收');
	assert.ok(!result.removedEmptyDirs.includes(join(workspace, 'pre-empty')), 'pre-empty 不该被回收');
	assert.ok(!result.removedEmptyDirs.includes(workspace), '选中根本身永远不回收');
});

await check('删除结果与统计自洽', () => {
	assert.equal(result.failureCount, 0, `不该有失败项：${JSON.stringify(result.failures)}`);
	assert.ok(result.removedFileCount >= junkFiles.length, '文件计数应覆盖垃圾文件');
	assert.ok(result.removedDirCount >= 3, '目录计数应覆盖缓存目录');
	assert.ok(result.freedBytes > 0, '释放体积应大于 0');
});

// ── 复核：回传清单只当申请 ──────────────────────────────────────────────────
await check('范围外的路径被拒', async () => {
	const outside = join(base, 'outside.tmp');
	writeFileSync(outside, 'x');
	const outcome = await cleanItems(plan, [{ path: outside }]);
	assert.equal(outcome.failureCount, 1);
	assert.ok(outcome.failures[0].message.includes('范围之外'));
	assert.ok(existsSync(outside), '范围外的文件不该被删');
	rmSync(outside, { force: true });
});

await check('白名单外的路径被拒', () => {
	const target = join(workspace, 'keep.txt');
	const outcome = cleanItems(plan, [{ path: target }]);
	return outcome.then((value) => {
		assert.equal(value.failureCount, 1);
		assert.ok(value.failures[0].message.includes('白名单'));
		assert.ok(existsSync(target), 'keep.txt 不该被删');
	});
});

await check('选中根本身不能删', async () => {
	const outcome = await cleanItems(plan, [{ path: workspace }]);
	assert.equal(outcome.failureCount, 1);
	assert.ok(existsSync(workspace));
});

// ── DSH_HOME 范围 ──────────────────────────────────────────────────────────
write(dshHome, 'stray.tmp', 'junk');
write(dshHome, 'sessions/s1/session.tmp', 'protected');
write(dshHome, 'profiles/desktop/package.tmp', 'protected');
write(dshHome, 'cache/img/a.png', 'cache');
write(dshHome, 'cache/deep/b.bin', 'cache');
mkdirSync(join(dshHome, 'cache'), { recursive: true });

const homePlan = buildPlan({ scope: 'dsh-home', workspaces: [], dshHome });
const homePreview = await scanPlan(homePlan);

await check('DSH_HOME 只碰白名单与 cache 内容', () => {
	const paths = homePreview.items.map((item) => item.path);
	assert.ok(paths.includes(join(dshHome, 'stray.tmp')));
	assert.ok(paths.includes(join(dshHome, 'cache', 'img')));
	for (const path of paths) {
		assert.ok(!path.includes('sessions'), 'sessions 不该进清单');
		assert.ok(!path.includes('profiles'), 'profiles 不该进清单');
	}
});

await check('DSH_HOME 清理后 cache 目录本身还在', async () => {
	await cleanItems(homePlan, homePreview.items);
	assert.ok(has(dshHome, 'cache'), 'cache 目录本身要保留');
	assert.ok(!has(dshHome, 'cache/img'), 'cache 内容应被回收');
	assert.ok(has(dshHome, 'sessions/s1/session.tmp'), 'sessions 内容必须原样保留');
	assert.ok(has(dshHome, 'profiles/desktop/package.tmp'), 'profiles 内容必须原样保留');
	assert.ok(!has(dshHome, 'stray.tmp'));
});

await check('工作区与 DSH_HOME 重叠时整条跳过', () => {
	const plan = buildPlan({
		scope: 'workspaces',
		workspaces: [{ path: dshHome, title: 'overlap' }, { path: join(dshHome, 'sessions'), title: 'inside' }],
		dshHome,
	});
	assert.equal(plan.roots.length, 0);
});

await check('卷根与不存在的工作区被拒', () => {
	const volume = join(tmpdir(), '..', '..');
	const plan = buildPlan({
		scope: 'workspaces',
		workspaces: [{ path: volume, title: 'vol' }, { path: join(base, 'nope'), title: 'missing' }],
		dshHome,
	});
	assert.equal(plan.roots.length, 0);
	assert.ok(plan.warnings.length >= 1);
});

// ── 收尾 ───────────────────────────────────────────────────────────────────
rmSync(base, { recursive: true, force: true });
if (failures.length > 0) {
	console.error(`\n${failures.length} 个测试失败，通过 ${passed} 个`);
	process.exit(1);
}
console.log(`\n全部通过（${passed} 个测试）`);
