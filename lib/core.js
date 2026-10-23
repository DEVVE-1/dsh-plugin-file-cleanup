/**
 * 文件清理插件 —— Host 半边的纯逻辑。
 *
 * 这里只有「判什么算垃圾」「扫哪些目录」「删之前怎么复核」三类事，不碰 Cordis、
 * 不碰 HTTP，方便用 `node --test` 之外的普通脚本直接跑（见 `test/cleanup.test.mjs`）。
 *
 * 设计口径只有一条：**白名单，不是黑名单**。规则表里没命中的东西永远不进候选，
 * 误判方向永远是「少删」。
 *
 * @module file-cleanup/core
 */

import { existsSync, lstatSync, promises as fsp, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';

/** 临时文件 / 半成品文件名规则。 */
export const TEMP_FILE_PATTERNS = [
	/\.tmp$/i,
	/\.temp$/i,
	/\.part$/i,
	/\.partial$/i,
	/\.crdownload$/i,
	/\.download$/i,
	/\.swp$/i,
	/\.swo$/i,
	/\.swn$/i,
	/\.stackdump$/i,
	/\.\$\$\$$/i,
	/~$/i,
	/^~\$/,
	/^hs_err_pid.*\.log$/i,
];

/** 系统噪声文件名（小写精确匹配）。 */
export const NOISE_FILE_NAMES = new Set([
	'thumbs.db',
	'ehthumbs.db',
	'desktop.ini',
	'.ds_store',
	'.eslintcache',
	'.stylelintcache',
]);

/** 系统噪声文件名规则。 */
export const NOISE_FILE_PATTERNS = [
	/^\._/,
	/^npm-debug\.log/i,
	/^yarn-error\.log/i,
	/^pnpm-debug\.log/i,
	/\.orig$/i,
	/\.rej$/i,
	/^core\.\d+$/,
];

/** 可再生缓存目录：命中就整棵删。 */
export const CACHE_DIR_NAMES = new Set([
	'__pycache__',
	'.pytest_cache',
	'.mypy_cache',
	'.ruff_cache',
	'.pytype',
	'.hypothesis',
	'.ipynb_checkpoints',
	'.cache',
	'.parcel-cache',
	'.turbo',
	'.sass-cache',
	'.nyc_output',
]);

/** 工作区里整棵跳过的目录（版本库与依赖树）。 */
export const SKIP_DIR_NAMES = new Set(['.git', '.hg', '.svn', 'node_modules']);

/** `DSH_HOME` 里绝不进入的目录。 */
export const DSH_HOME_PROTECTED = new Set([
	'sessions',
	'storages',
	'profiles',
	'attachments',
	'dsh-runtimes',
	'llm-deepseek',
	'node_modules',
]);

/** 清单上限：确认框最多列这么多条。 */
export const MAX_ITEMS = 2000;
/** 一次扫描最多访问的目录项数。 */
export const MAX_VISITED = 500000;
/** 扫描失败项回传上限。 */
export const MAX_SCAN_FAILURES = 100;
/** 删除结果里每类路径的回传上限。 */
export const MAX_RESULT_PATHS = 400;
/** 删除失败项回传上限。 */
export const MAX_FAILURES = 100;

/** 带 code / status 的错误，Host 半边据此回状态码。 */
export class CleanupError extends Error {
	/**
	 * @param code - 机器可读的错误码。
	 * @param message - 面向用户的说明。
	 * @param options - 额外的 `status` 与 `details`。
	 */
	constructor(code, message, options = {}) {
		super(message);
		this.name = 'CleanupError';
		this.code = code;
		this.status = typeof options.status === 'number' ? options.status : 400;
		this.details = options.details;
	}
}

/**
 * 把错误压成一行可读文本。
 * @param error - 任意错误。
 * @returns 说明文字。
 */
function messageOf(error) {
	if (error instanceof Error) return error.message;
	return String(error);
}

/**
 * 路径比较键：Windows 下大小写不敏感。
 * @param path - 路径。
 * @returns 归一后的键。
 */
function pathKey(path) {
	const normalized = resolve(path);
	return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

/**
 * 解析 DSH_HOME：非空 `$DSH_HOME`（支持 `~`）→ `~/.dsh`。
 * @param env - 环境变量对象，默认 `process.env`。
 * @returns 绝对路径（未做 realpath）。
 */
export function resolveDshHome(env = process.env) {
	const raw = typeof env.DSH_HOME === 'string' ? env.DSH_HOME.trim() : '';
	if (raw.length === 0) return join(homedir(), '.dsh');
	if (raw === '~') return homedir();
	if (raw.startsWith('~/') || raw.startsWith('~\\')) return join(homedir(), raw.slice(2));
	return resolve(raw);
}

/**
 * 目录是否是卷根（`D:\`、`/`）。
 * @param path - 绝对路径。
 * @returns 是卷根时为 true。
 */
export function isVolumeRoot(path) {
	const normalized = resolve(path);
	const root = parse(normalized).root;
	return normalized === root || normalized === root.replace(/[\\/]$/, '');
}

/**
 * 严格子路径判定：`target` 必须位于 `root` **之内**，等于 `root` 时为 false。
 * @param root - 选中的根目录。
 * @param target - 待判定的路径。
 * @returns 严格位于内部时为 true。
 */
export function isWithin(root, target) {
	if (typeof root !== 'string' || typeof target !== 'string') return false;
	const rootKey = pathKey(root);
	const targetKey = pathKey(target);
	if (rootKey === targetKey) return false;
	const rel = relative(rootKey, targetKey);
	if (rel.length === 0 || isAbsolute(rel)) return false;
	return !rel.split(sep).some((part) => part === '..');
}

/**
 * 两个目录是否互相重叠（相等 / 包含 / 被包含）。
 * @param left - 目录 A。
 * @param right - 目录 B。
 * @returns 重叠时为 true。
 */
export function directoriesOverlap(left, right) {
	const a = pathKey(left);
	const b = pathKey(right);
	return a === b || isWithin(a, b) || isWithin(b, a);
}

/**
 * 按名字判类别。目录只看缓存目录表，文件看临时 / 噪声两张表。
 * @param name - 目录项名字。
 * @param isDirectory - 是否是目录。
 * @returns `'cache'`、`'temp'`、`'noise'` 或 `null`。
 */
export function classifyEntry(name, isDirectory) {
	const lower = name.toLowerCase();
	if (isDirectory) return CACHE_DIR_NAMES.has(lower) ? 'cache' : null;
	if (NOISE_FILE_NAMES.has(lower)) return 'noise';
	if (NOISE_FILE_PATTERNS.some((pattern) => pattern.test(name))) return 'noise';
	if (TEMP_FILE_PATTERNS.some((pattern) => pattern.test(name))) return 'temp';
	return null;
}

/**
 * 文件是否命中白名单。
 * @param name - 文件名。
 * @returns 命中时为 true。
 */
export function isCleanableFile(name) {
	return classifyEntry(name, false) !== null;
}

/**
 * 目录名是否是可再生缓存目录。
 * @param name - 目录名。
 * @returns 是缓存目录时为 true。
 */
export function isCacheDirName(name) {
	return CACHE_DIR_NAMES.has(name.toLowerCase());
}

/**
 * 当前范围下要整棵跳过的目录名。
 * @param name - 目录名。
 * @param scope - `'workspaces'` 或 `'dsh-home'`。
 * @returns 需要跳过时为 true。
 */
export function isSkippedDir(name, scope) {
	const lower = name.toLowerCase();
	if (SKIP_DIR_NAMES.has(lower)) return true;
	if (scope === 'dsh-home' && DSH_HOME_PROTECTED.has(lower)) return true;
	return false;
}

/**
 * 把路径归一成真实路径（解析目录联接 / 符号链接）。
 *
 * Windows 必须用 `realpathSync.native`：JS 版 realpath 不解析目录联接。
 *
 * @param path - 绝对路径。
 * @returns 真实路径；路径不存在时抛错。
 */
export function canonicalPath(path) {
	return realpathSync.native(path);
}

/**
 * 收集工作区的候选根：去重、canonical 化、剔除与 DSH_HOME 重叠或本身是卷根的项。
 * @param workspaces - `{ path, title }` 列表。
 * @param dshHome - DSH_HOME 绝对路径。
 * @returns `{ roots, labels, warnings }`。
 */
function planWorkspaceRoots(workspaces, dshHome) {
	const roots = [];
	const labels = [];
	const warnings = [];
	const seen = new Set();
	const dshKey = pathKey(dshHome);
	for (const workspace of workspaces) {
		const raw = typeof workspace?.path === 'string' ? workspace.path : '';
		if (raw.length === 0) continue;
		let canonical;
		try {
			if (!existsSync(raw)) throw new Error('目录不存在');
			canonical = canonicalPath(raw);
		} catch (error) {
			warnings.push({ code: 'workspace-skipped', path: raw, message: `跳过工作区 ${raw}：${messageOf(error)}` });
			continue;
		}
		const key = pathKey(canonical);
		if (seen.has(key)) continue;
		seen.add(key);
		if (isVolumeRoot(canonical)) {
			warnings.push({ code: 'workspace-is-volume-root', path: canonical, message: `跳过工作区 ${canonical}：不能把整个卷当清理范围` });
			continue;
		}
		if (directoriesOverlap(canonical, dshKey)) {
			warnings.push({
				code: 'workspace-overlaps-dsh-home',
				path: canonical,
				message: `跳过工作区 ${canonical}：与 DSH_HOME 重叠，清理它会碰到 DSH 自己的数据`,
			});
			continue;
		}
		// 嵌套工作区只留最外层：同一条垃圾不在清单里出现两次、体积也不翻倍。
		if (roots.some((root) => isWithin(root, canonical))) continue;
		roots.push(canonical);
		labels.push({ path: canonical, title: typeof workspace?.title === 'string' && workspace.title.length > 0 ? workspace.title : basename(canonical) });
	}
	return { roots, labels, warnings };
}

/**
 * 组装一次清理计划：范围根、缓存根、显示标签与警告。
 * @param input - `{ scope, workspaces, dshHome }`。
 * @returns `{ scope, roots, cacheRoots, rootsLabel, warnings }`。
 */
export function buildPlan(input) {
	const scope = input.scope === 'dsh-home' ? 'dsh-home' : 'workspaces';
	const dshHome = resolve(input.dshHome);
	if (scope === 'dsh-home') {
		if (!existsSync(dshHome)) {
			throw new CleanupError('no-dsh-home', `找不到 DSH_HOME：${dshHome}`, { status: 400 });
		}
		let canonical;
		try {
			canonical = canonicalPath(dshHome);
		} catch (error) {
			throw new CleanupError('no-dsh-home', `DSH_HOME 不可用：${messageOf(error)}`, { status: 400 });
		}
		if (isVolumeRoot(canonical)) {
			throw new CleanupError('no-dsh-home', `DSH_HOME 退化成了卷根（${canonical}），拒绝按整个卷清理`, { status: 400 });
		}
		const cacheCandidate = join(canonical, 'cache');
		const cacheRoots = [];
		if (existsSync(cacheCandidate)) {
			try {
				cacheRoots.push(canonicalPath(cacheCandidate));
			} catch {
				/* 缓存目录不可解析时按没有缓存根处理 */
			}
		}
		return {
			scope,
			roots: [canonical],
			cacheRoots,
			rootsLabel: [{ path: canonical, title: 'DSH_HOME' }],
			warnings: [],
		};
	}
	const planned = planWorkspaceRoots(Array.isArray(input.workspaces) ? input.workspaces : [], dshHome);
	// 一个能用的工作区都没有时不报错：让人看到「跳过它们的原因」，比甩一个错误更有用。
	return {
		scope,
		roots: planned.roots,
		cacheRoots: [],
		rootsLabel: planned.labels,
		warnings: planned.warnings,
	};
}

/**
 * 统计一棵目录树的大小（不跟随链接）。
 * @param start - 目录。
 * @param counters - 共享的访问计数（`{ visited, capped }`）。
 * @returns `{ files, dirs, bytes }`。
 */
async function measureTree(start, counters) {
	const totals = { files: 0, dirs: 0, bytes: 0 };
	const stack = [start];
	while (stack.length > 0) {
		const dir = stack.pop();
		let entries;
		try {
			entries = await fsp.readdir(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			counters.visited += 1;
			if (counters.visited > MAX_VISITED) {
				counters.capped = true;
				return totals;
			}
			if (entry.isSymbolicLink()) continue;
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				totals.dirs += 1;
				stack.push(full);
				continue;
			}
			if (!entry.isFile()) continue;
			try {
				totals.files += 1;
				totals.bytes += (await fsp.lstat(full)).size;
			} catch {
				/* 中途消失的文件按 0 计 */
			}
		}
	}
	return totals;
}

/**
 * 扫描一份计划，产出预览（不删除任何东西）。
 * @param plan - `buildPlan` 的产物。
 * @returns 预览对象。
 */
export async function scanPlan(plan) {
	const counters = { visited: 0, capped: false };
	const items = [];
	const scanFailures = [];
	let scanFailureCount = 0;
	const cacheRootKeys = new Set((plan.cacheRoots ?? []).map((path) => pathKey(path)));
	const totals = { files: 0, dirs: 0, bytes: 0 };
	const categories = {
		temp: { count: 0, bytes: 0 },
		noise: { count: 0, bytes: 0 },
		cache: { count: 0, bytes: 0 },
	};

	const recordFailure = (path, error) => {
		scanFailureCount += 1;
		if (scanFailures.length < MAX_SCAN_FAILURES) scanFailures.push({ path, message: messageOf(error) });
	};

	const pushCache = (path, measured) => {
		items.push({ path, kind: 'dir', category: 'cache', bytes: measured.bytes });
		categories.cache.count += 1;
		categories.cache.bytes += measured.bytes;
		totals.dirs += 1 + measured.dirs;
		totals.files += measured.files;
		totals.bytes += measured.bytes;
	};

	for (const root of plan.roots) {
		const stack = [root];
		while (stack.length > 0 && !counters.capped) {
			const dir = stack.pop();
			let entries;
			try {
				entries = await fsp.readdir(dir, { withFileTypes: true });
			} catch (error) {
				recordFailure(dir, error);
				continue;
			}
			for (const entry of entries) {
				if (counters.capped) break;
				counters.visited += 1;
				if (counters.visited > MAX_VISITED) {
					counters.capped = true;
					break;
				}
				const full = join(dir, entry.name);
				if (cacheRootKeys.has(pathKey(full))) continue;
				if (entry.isSymbolicLink()) continue;
				if (entry.isDirectory()) {
					if (isSkippedDir(entry.name, plan.scope)) continue;
					if (isCacheDirName(entry.name)) {
						pushCache(full, await measureTree(full, counters));
						continue;
					}
					// 目录联接在部分 Windows 版本里不以 Dirent 的 symlink 上报，这里再确认一次。
					try {
						if (process.platform === 'win32' && lstatSync(full).isSymbolicLink()) continue;
					} catch (error) {
						recordFailure(full, error);
						continue;
					}
					stack.push(full);
					continue;
				}
				if (!entry.isFile()) continue;
				const category = classifyEntry(entry.name, false);
				if (category === null) continue;
				let size = 0;
				try {
					size = (await fsp.lstat(full)).size;
				} catch (error) {
					recordFailure(full, error);
					continue;
				}
				items.push({ path: full, kind: 'file', category, bytes: size });
				categories[category].count += 1;
				categories[category].bytes += size;
				totals.files += 1;
				totals.bytes += size;
			}
		}
	}

	// `cache` 目录本身保留，只回收它的内容，所以这些根不进主遍历。
	for (const cacheRoot of plan.cacheRoots ?? []) {
		let entries;
		try {
			entries = await fsp.readdir(cacheRoot, { withFileTypes: true });
		} catch (error) {
			if (error?.code !== 'ENOENT') recordFailure(cacheRoot, error);
			continue;
		}
		for (const entry of entries) {
			if (counters.capped) break;
			counters.visited += 1;
			if (counters.visited > MAX_VISITED) {
				counters.capped = true;
				break;
			}
			const full = join(cacheRoot, entry.name);
			if (entry.isSymbolicLink()) continue;
			if (entry.isDirectory()) {
				pushCache(full, await measureTree(full, counters));
				continue;
			}
			if (!entry.isFile()) continue;
			let size = 0;
			try {
				size = (await fsp.lstat(full)).size;
			} catch (error) {
				recordFailure(full, error);
				continue;
			}
			items.push({ path: full, kind: 'file', category: 'cache', bytes: size });
			categories.cache.count += 1;
			categories.cache.bytes += size;
			totals.files += 1;
			totals.bytes += size;
		}
	}

	items.sort((left, right) => right.bytes - left.bytes);
	const limited = items.slice(0, MAX_ITEMS);
	return {
		scope: plan.scope,
		roots: plan.roots,
		cacheRoots: plan.cacheRoots ?? [],
		rootsLabel: plan.rootsLabel,
		totals,
		categories,
		items: limited,
		itemsTruncated: items.length > limited.length,
		scanFailures,
		scanFailureCount,
		warnings: plan.warnings ?? [],
		visited: counters.visited,
		capped: counters.capped,
	};
}

/**
 * 路径是否落在 DSH_HOME 的保护区内。
 * @param path - 待判定路径。
 * @param plan - 计划。
 * @returns 命中保护区时为 true。
 */
function isProtectedPath(path, plan) {
	if (plan.scope !== 'dsh-home') return false;
	const root = plan.roots[0];
	if (!isWithin(root, path)) return false;
	const rel = relative(root, path);
	const first = rel.split(sep)[0];
	return first.length > 0 && DSH_HOME_PROTECTED.has(first.toLowerCase());
}

/**
 * 从被删项所在目录往上回收「因为本次删除才变空」的目录，碰到选中根就停。
 * @param startDir - 起始目录（被删项的父目录）。
 * @param plan - 计划（用第一个根作为围栏）。
 * @param record - 记录回收结果的回调。
 */
async function reclaimEmptyParents(startDir, plan, record) {
	let dir = startDir;
	for (;;) {
		// `cache` 根只回收内容，目录本身要留着。
		if ((plan.cacheRoots ?? []).some((root) => pathKey(root) === pathKey(dir))) return;
		const insideSomeRoot = plan.roots.some((root) => isWithin(root, dir));
		if (!insideSomeRoot) return;
		let entries;
		try {
			entries = await fsp.readdir(dir);
		} catch {
			return;
		}
		if (entries.length > 0) return;
		try {
			await fsp.rmdir(dir);
		} catch {
			return;
		}
		record(dir);
		dir = dirname(dir);
	}
}

/**
 * 按清单删除。
 *
 * 浏览器回传的清单只当「申请」：每一条都要重新过一遍范围、白名单与 `lstat`，
 * 不合格的进 `failures` 而不是被执行。
 *
 * @param plan - `buildPlan` 的产物。
 * @param items - 回传的清单，`{ path }` 列表。
 * @returns 删除结果。
 */
export async function cleanItems(plan, items) {
	const allowedRoots = [...(plan.roots ?? []), ...(plan.cacheRoots ?? [])];
	const removedFiles = [];
	const removedDirs = [];
	const removedEmptyDirs = [];
	const failures = [];
	let removedFileCount = 0;
	let removedDirCount = 0;
	let removedEmptyDirCount = 0;
	let failureCount = 0;
	let freedBytes = 0;

	const fail = (path, message) => {
		failureCount += 1;
		if (failures.length < MAX_FAILURES) failures.push({ path, message });
	};
	const recordEmpty = (path) => {
		removedEmptyDirCount += 1;
		if (removedEmptyDirs.length < MAX_RESULT_PATHS) removedEmptyDirs.push(path);
	};

	for (const raw of Array.isArray(items) ? items : []) {
		const rawPath = typeof raw?.path === 'string' ? raw.path : '';
		if (rawPath.length === 0) {
			fail('', '清单项缺少路径');
			continue;
		}
		let path;
		try {
			path = resolve(rawPath);
		} catch {
			fail(rawPath, '路径不合法');
			continue;
		}
		if (!allowedRoots.some((root) => isWithin(root, path))) {
			fail(path, '拒绝删除选中范围之外的路径');
			continue;
		}
		if (isProtectedPath(path, plan)) {
			fail(path, '位于 DSH_HOME 保护区，拒绝删除');
			continue;
		}
		let stat;
		try {
			stat = await fsp.lstat(path);
		} catch (error) {
			// 扫描到确认之间文件自己消失了：不算失败，也不需要删。
			if (error?.code === 'ENOENT') continue;
			fail(path, messageOf(error));
			continue;
		}
		if (stat.isSymbolicLink()) {
			fail(path, '符号链接 / 目录联接，跳过');
			continue;
		}
		// `$DSH_HOME/cache` 的内容整体回收：那里的子项不必再叫缓存目录的名字。
		const insideCacheRoot = (plan.cacheRoots ?? []).some((root) => isWithin(root, path));
		if (stat.isDirectory()) {
			if (!insideCacheRoot && !isCacheDirName(basename(path))) {
				fail(path, '不是可回收的缓存目录');
				continue;
			}
			let measured = { files: 0, dirs: 0, bytes: 0 };
			try {
				measured = await measureTree(path, { visited: 0, capped: false });
			} catch {
				/* 量不出来就按 0 计体积 */
			}
			try {
				await fsp.rm(path, { recursive: true, force: true });
			} catch (error) {
				fail(path, messageOf(error));
				continue;
			}
			removedDirCount += 1;
			if (removedDirs.length < MAX_RESULT_PATHS) removedDirs.push(path);
			freedBytes += measured.bytes;
			await reclaimEmptyParents(dirname(path), plan, recordEmpty);
			continue;
		}
		if (!stat.isFile()) {
			fail(path, '既不是文件也不是目录，跳过');
			continue;
		}
		if (!insideCacheRoot && !isCleanableFile(basename(path))) {
			fail(path, '不在清理白名单内');
			continue;
		}
		try {
			await fsp.unlink(path);
		} catch (error) {
			fail(path, messageOf(error));
			continue;
		}
		removedFileCount += 1;
		if (removedFiles.length < MAX_RESULT_PATHS) removedFiles.push(path);
		freedBytes += stat.size;
		await reclaimEmptyParents(dirname(path), plan, recordEmpty);
	}

	return {
		scope: plan.scope,
		roots: plan.roots,
		cacheRoots: plan.cacheRoots ?? [],
		rootsLabel: plan.rootsLabel,
		removedFiles,
		removedFileCount,
		removedDirs,
		removedDirCount,
		removedEmptyDirs,
		removedEmptyDirCount,
		freedBytes,
		failures,
		failureCount,
		warnings: plan.warnings ?? [],
	};
}
