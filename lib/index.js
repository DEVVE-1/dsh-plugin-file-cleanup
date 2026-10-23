/**
 * 文件清理插件 —— Host 半边。
 *
 * 左上角「文件清理」按钮 → 浏览器半边调这条同源接口 → 这里扫描 / 删除。
 * 接口只有一条固定路由，三件事：`describe`（有哪些范围）、`scan`（预览，不删）、
 * `clean`（只删回传的那份清单）。
 *
 * 常驻的东西只有一条路由和一个布尔锁，没有定时器、没有文件监视。
 *
 * @module file-cleanup
 */

import { CleanupError, buildPlan, cleanItems, resolveDshHome, scanPlan } from './core.js';

/** 插件名（Loader 内的模块级名字）。 */
export const name = 'file-cleanup';

/** webServer 就绪后才应用。 */
export const inject = ['webServer'];

/**
 * 接口路径。
 *
 * 不做成插件配置：浏览器半边是预构建产物、地址写死，允许改路由只会让两边各记
 * 一个路径，改完就是 404。
 */
const ROUTE = '/file-cleanup';

/** 请求体上限：确认清单最多 2000 条路径，1MB 够用。 */
const MAX_BODY_BYTES = 1024 * 1024;

/**
 * 回环地址判定：`localhost` / `127.0.0.0/8` / `::1`。
 *
 * 只比 `Origin == Host` 挡不住 DNS rebinding：攻击者把域名解析到 127.0.0.1 时，
 * 两个头会一起变成同一个非回环域名。所以这里只认回环 Host。
 *
 * @param host - `Host` 头（可能带端口）。
 * @returns 是回环时为 true。
 */
function isLoopbackHost(host) {
	if (typeof host !== 'string' || host.length === 0) return false;
	let hostname = host;
	if (hostname.startsWith('[')) {
		const end = hostname.indexOf(']');
		if (end === -1) return false;
		hostname = hostname.slice(1, end);
	} else {
		const colon = hostname.lastIndexOf(':');
		if (colon !== -1) hostname = hostname.slice(0, colon);
	}
	const lower = hostname.toLowerCase();
	if (lower === 'localhost' || lower === '::1' || lower === '0:0:0:0:0:0:0:1') return true;
	const parts = lower.split('.');
	if (parts.length !== 4 || parts[0] !== '127') return false;
	return parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

/**
 * 只允许本机同源请求。
 * @param req - Node 请求对象。
 * @returns 允许时为 true。
 */
function sameOrigin(req) {
	const host = req.headers.host;
	if (!isLoopbackHost(host)) return false;
	const site = req.headers['sec-fetch-site'];
	if (typeof site === 'string' && site.length > 0) {
		const normalized = site.toLowerCase();
		if (normalized !== 'same-origin' && normalized !== 'none') return false;
	}
	const origin = req.headers.origin;
	if (typeof origin !== 'string' || origin.length === 0) return true;
	if (origin === 'null') return false;
	let originHost;
	try {
		originHost = new URL(origin).host;
	} catch {
		return false;
	}
	return originHost.toLowerCase() === host.toLowerCase();
}

/**
 * 读取并解析 JSON 请求体（超长 413、非法 JSON 400）。
 * @param req - Node 请求对象。
 * @returns `{ ok: true, body }` 或 `{ ok: false, code }`。
 */
function readJsonBody(req) {
	return new Promise((done) => {
		let size = 0;
		let settled = false;
		const chunks = [];
		const finish = (value) => {
			if (settled) return;
			settled = true;
			done(value);
		};
		req.on('data', (chunk) => {
			if (settled) return;
			size += chunk.length;
			if (size > MAX_BODY_BYTES) {
				finish({ ok: false, code: 'payload-too-large' });
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on('end', () => {
			if (settled) return;
			try {
				finish({ ok: true, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
			} catch {
				finish({ ok: false, code: 'bad-request' });
			}
		});
		req.on('error', () => finish({ ok: false, code: 'bad-request' }));
	});
}

/**
 * 发送 JSON 响应。
 * @param res - Node 响应对象。
 * @param status - HTTP 状态码。
 * @param payload - 响应体。
 */
function send(res, status, payload) {
	const body = JSON.stringify(payload);
	res.writeHead(status, {
		'content-type': 'application/json; charset=utf-8',
		'content-length': Buffer.byteLength(body),
		'cache-control': 'no-store',
	});
	res.end(body);
}

/**
 * 工作区列表：优先问运行时注册表，拿不到就退回 workspace.json。
 * @param ctx - Cordis 上下文。
 * @param dshHome - DSH_HOME 绝对路径。
 * @returns `{ id, path, title }` 列表。
 */
async function listWorkspaces(ctx, dshHome) {
	const registry = ctx.get?.('workspaceRegistry');
	if (registry !== null && registry !== undefined && typeof registry.list === 'function') {
		try {
			const entries = registry.list();
			if (Array.isArray(entries)) {
				return entries.map((entry) => ({
					id: typeof entry?.id === 'string' ? entry.id : '',
					path: typeof entry?.path === 'string' ? entry.path : '',
					title: typeof entry?.title === 'string' ? entry.title : '',
				}));
			}
		} catch (error) {
			ctx.logger?.warn?.(`file-cleanup: 读取工作区注册表失败：${String(error)}`);
		}
	}
	try {
		const { promises: fsp } = await import('node:fs');
		const { join } = await import('node:path');
		const raw = await fsp.readFile(join(dshHome, 'storages', 'workspace.json'), 'utf8');
		const parsed = JSON.parse(raw);
		const table = parsed?.tables?.workspaces;
		if (table === null || typeof table !== 'object') return [];
		return Object.entries(table).map(([id, record]) => ({
			id,
			path: typeof record?.path === 'string' ? record.path : '',
			title: typeof record?.title === 'string' ? record.title : '',
		}));
	} catch {
		return [];
	}
}

/**
 * `describe`：这个环境里能选哪些清理范围。
 * @param ctx - Cordis 上下文。
 * @param state - 插件状态（`busy` 锁）。
 * @returns 描述对象。
 */
async function describe(ctx, state) {
	const dshHome = resolveDshHome();
	const workspaces = await listWorkspaces(ctx, dshHome);
	return {
		dshHome,
		workspaces,
		scopes: [
			{ id: 'workspaces', count: workspaces.length },
			{ id: 'dsh-home', path: dshHome },
		],
		busy: state.busy,
	};
}

/**
 * 把范围字符串收敛成两个合法值。
 * @param value - 请求里的 `scope`。
 * @returns `'workspaces'` 或 `'dsh-home'`。
 */
function normalizeScope(value) {
	if (value === 'workspaces' || value === 'dsh-home') return value;
	throw new CleanupError('bad-scope', `未知的清理范围：${String(value)}`, { status: 400 });
}

/**
 * 处理一次接口调用。
 * @param ctx - Cordis 上下文。
 * @param req - Node 请求对象。
 * @param res - Node 响应对象。
 * @param state - 插件状态（`busy` 锁）。
 */
async function handleRequest(ctx, req, res, state) {
	try {
		if (req.method !== 'POST') {
			send(res, 405, { ok: false, code: 'method-not-allowed', message: '请使用 POST' });
			return;
		}
		if (!sameOrigin(req)) {
			send(res, 403, { ok: false, code: 'forbidden', message: '拒绝跨站请求' });
			return;
		}
		if (!String(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
			send(res, 415, { ok: false, code: 'unsupported-media-type', message: '请求体必须是 application/json' });
			return;
		}
		const parsed = await readJsonBody(req);
		if (!parsed.ok) {
			if (parsed.code === 'payload-too-large') {
				send(res, 413, { ok: false, code: 'payload-too-large', message: `请求体超过 ${MAX_BODY_BYTES} 字节` });
				return;
			}
			send(res, 400, { ok: false, code: 'bad-request', message: '请求体不是合法 JSON' });
			return;
		}
		const body = parsed.body;
		if (body === null || typeof body !== 'object') {
			send(res, 400, { ok: false, code: 'bad-request', message: '请求体必须是 JSON 对象' });
			return;
		}

		if (body.action === 'describe') {
			send(res, 200, { ok: true, result: await describe(ctx, state) });
			return;
		}

		if (body.action === 'scan') {
			const scope = normalizeScope(body.scope);
			if (state.busy) {
				send(res, 409, { ok: false, code: 'busy', message: '已有清理任务在跑' });
				return;
			}
			const dshHome = resolveDshHome();
			const workspaces = await listWorkspaces(ctx, dshHome);
			const plan = buildPlan({ scope, workspaces, dshHome });
			const preview = await scanPlan(plan);
			send(res, 200, { ok: true, result: preview });
			return;
		}

		if (body.action === 'clean') {
			const scope = normalizeScope(body.scope);
			if (body.confirm !== true) {
				send(res, 428, { ok: false, code: 'confirm-required', message: '清理请求必须显式带上 confirm: true' });
				return;
			}
			if (!Array.isArray(body.items)) {
				send(res, 400, { ok: false, code: 'bad-request', message: '缺少 items（要删除的清单）' });
				return;
			}
			if (state.busy) {
				send(res, 409, { ok: false, code: 'busy', message: '已有清理任务在跑' });
				return;
			}
			state.busy = true;
			try {
				const dshHome = resolveDshHome();
				const workspaces = await listWorkspaces(ctx, dshHome);
				const plan = buildPlan({ scope, workspaces, dshHome });
				const result = await cleanItems(plan, body.items);
				ctx.logger?.info?.(
					`file-cleanup: ${scope} 清理完成，文件 ${result.removedFileCount} / 目录 ${result.removedDirCount} / ` +
						`空目录 ${result.removedEmptyDirCount}，释放 ${result.freedBytes} 字节，失败 ${result.failureCount}`,
				);
				send(res, 200, { ok: true, result });
			} finally {
				state.busy = false;
			}
			return;
		}

		send(res, 400, { ok: false, code: 'bad-action', message: `未知的 action：${String(body.action)}` });
	} catch (error) {
		if (error instanceof CleanupError) {
			send(res, error.status, { ok: false, code: error.code, message: error.message, details: error.details });
			return;
		}
		// 意外错误只进日志：回显内部细节等于把这一半的实现送给浏览器。
		ctx.logger?.warn?.(error);
		send(res, 500, { ok: false, code: 'internal', message: '清理失败：服务端内部错误，详情见 Host 日志' });
	}
}

/**
 * 注册清理路由。
 * @param ctx - Cordis 上下文（已注入 webServer）。
 * @param config - 预留配置（当前无字段）。
 */
export function apply(ctx, config) {
	const state = { busy: false };
	const handler = (req, res) => handleRequest(ctx, req, res, state);
	const dispose = ctx.webServer.register({ kind: 'exact', path: ROUTE, handler });
	ctx.effect(() => dispose, 'file-cleanup: route');
	ctx.logger?.info?.(`file-cleanup: 清理接口已挂载 ${ROUTE}（config=${JSON.stringify(config ?? {})}）`);
}
