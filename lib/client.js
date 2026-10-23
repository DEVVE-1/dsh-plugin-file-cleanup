window.__ModuleLoader__.load({
	id: "file-cleanup",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");
		const { jsx, jsxs, Fragment } = require("react/jsx-runtime");
		const primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		const { createSnapshotStore } = require("@deepseek-ai/dsh-client-store");

		/** Host 半边注册的清理接口；路径固定，两边共用同一个常量（见 Host 的 ROUTE）。 */
		const ENDPOINT = "/file-cleanup";
		/** 字典命名空间。 */
		const NS = "file-cleanup";
		/** 桌面 preload 注入的标题栏菜单条。 */
		const MENUBAR_HOST = "[data-windows-menu]";
		/** 找不到原生菜单条时，兜底按钮的固定落点（就在「应用 / 编辑」右边）。 */
		const FALLBACK_ANCHOR = { top: 6, left: 132 };

		const CSS = [
			".fc-body{display:flex;flex-direction:column;gap:10px}",
			".fc-lead{color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}",
			".fc-scopes{display:flex;flex-direction:column;gap:8px}",
			".fc-scope{display:flex;flex-direction:column;gap:2px;width:100%;padding:10px 12px;border:.5px solid var(--dsw-alias-border-l4,rgba(255,255,255,.14));border-radius:var(--dsw-radius-lg,10px);background:transparent;color:inherit;text-align:left;cursor:pointer;font:inherit}",
			".fc-scope:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06))}",
			".fc-scope:disabled{opacity:.6;cursor:default}",
			".fc-scope-title{font-size:14px;line-height:20px;color:var(--dsw-alias-label-primary)}",
			".fc-scope-hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);word-break:break-all}",
			".fc-section{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);margin-top:2px}",
			".fc-risk-title{font-size:12px;line-height:18px;color:var(--dsw-alias-state-warn-primary,#d29922);font-weight:600}",
			".fc-risk{margin:0;padding-left:18px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}",
			".fc-paths{font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary);word-break:break-all;max-height:54px;overflow:auto}",
			".fc-stats{font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary)}",
			".fc-list{height:115px;box-sizing:border-box;padding:8px 10px;overflow:auto;border:.5px solid var(--dsw-alias-border-l4,rgba(255,255,255,.14));border-radius:var(--dsw-radius-md,8px);font-size:12px;line-height:18px;background:rgba(0,0,0,.12)}",
			".fc-row{display:flex;gap:10px;justify-content:space-between;white-space:nowrap}",
			".fc-row-path{overflow:hidden;text-overflow:ellipsis;color:var(--dsw-alias-label-primary)}",
			".fc-row-size{flex:none;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}",
			".fc-note{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}",
			".fc-status{font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}",
			".fc-error{font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary,#e5484d)}",
			".fc-ok{font-size:13px;line-height:20px;color:var(--dsw-alias-state-success-primary,#3fb950)}",
			".fc-failure{font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary,#e5484d);word-break:break-all}",
			".fc-danger:not(:disabled){color:var(--dsw-alias-state-error-primary,#e5484d)}",
			".fc-done-green:not(:disabled){color:var(--dsw-alias-state-success-primary,#3fb950)}",
			`.fc-fallback{position:fixed;top:${FALLBACK_ANCHOR.top}px;left:${FALLBACK_ANCHOR.left}px;z-index:1101;height:28px;padding:0 10px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:14px;-webkit-app-region:no-drag;cursor:default}`,
			".fc-fallback:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08));color:var(--dsw-alias-label-primary)}",
		].join("");

		const zh = {
			"entry.label": "文件清理",
			"dialog.title": "文件清理",
			"dialog.description": "只删白名单内的垃圾文件：临时文件、系统噪声、可再生缓存目录。删除不可逆，不进回收站。",
			"scope.lead": "先选清理哪里。这一步只读取路径，不扫描、不删除。",
			"scope.workspaces": "所有工作区",
			"scope.workspaces.hint": "共 {count} 个工作区：{paths}",
			"scope.workspaces.empty": "还没有登记任何工作区",
			"scope.dsh-home": "DSH_HOME",
			"scope.dsh-home.hint": "{path}（额外回收 cache 的内容）",
			"scanning": "正在扫描…",
			"confirm.area": "本次清理区域",
			"confirm.risk": "风险提示",
			"risk.1": "删除不可逆：不进回收站，删掉就没了。",
			"risk.2": "只删白名单内的垃圾；源码、文档、配置、构建产物、附件、会话日志一律不动。",
			"risk.3": "只删下面这份清单：扫描之后才出现的文件不会被顺手带走。",
			"risk.4": "被占用的文件会跳过，并作为失败项列在结果里，不影响其余删除。",
			"confirm.stats": "文件 {files} 个 · 目录 {dirs} 个 · 预计释放 {size}",
			"confirm.truncated": "只列出体积最大的 {count} 项。",
			"confirm.empty": "没有找到可以清理的垃圾，这个范围很干净。",
			"cleaning": "正在清理…",
			"result.summary": "已清理 {files} 个文件、{dirs} 个目录（回收空目录 {empty} 个），释放 {size}。",
			"result.failures": "有 {count} 项没删掉：",
			"result.more": "还有 {count} 项未列出。",
			"cancel": "取消",
			"start": "开始清理",
			"done": "完成",
			"copy": "复制清单",
			"copied": "已复制",
			"error.endpoint": "清理服务不可用（Host 半边未加载，或当前不是 Web 运行方式）。",
			"error.generic": "清理请求失败",
		};
		const en = {
			"entry.label": "File cleanup",
			"dialog.title": "File cleanup",
			"dialog.description": "Deletes only whitelisted junk: temp files, system noise, and regenerable cache directories. Deletion is permanent — nothing goes to the recycle bin.",
			"scope.lead": "Pick where to clean. This step only reads paths; it scans and deletes nothing.",
			"scope.workspaces": "All workspaces",
			"scope.workspaces.hint": "{count} workspaces: {paths}",
			"scope.workspaces.empty": "No workspace registered yet",
			"scope.dsh-home": "DSH_HOME",
			"scope.dsh-home.hint": "{path} (also reclaims the contents of cache)",
			"scanning": "Scanning…",
			"confirm.area": "This cleanup covers",
			"confirm.risk": "Before you continue",
			"risk.1": "Deletion is permanent: nothing goes to the recycle bin.",
			"risk.2": "Only whitelisted junk is removed; source, documents, config, build output, attachments, and session logs are untouched.",
			"risk.3": "Only the list below is deleted — files that appear after the scan are never swept up.",
			"risk.4": "Busy files are skipped and reported as failures; the rest still gets deleted.",
			"confirm.stats": "{files} files · {dirs} directories · about {size} to free",
			"confirm.truncated": "Only the {count} largest items are listed.",
			"confirm.empty": "Nothing to clean here — this scope is already tidy.",
			"cleaning": "Cleaning…",
			"result.summary": "Removed {files} files and {dirs} directories ({empty} empty directories reclaimed), freeing {size}.",
			"result.failures": "{count} items could not be deleted:",
			"result.more": "{count} more not listed.",
			"cancel": "Cancel",
			"start": "Start cleanup",
			"done": "Done",
			"copy": "Copy list",
			"copied": "Copied",
			"error.endpoint": "The cleanup service is unavailable (host half not loaded, or not running in Web mode).",
			"error.generic": "Cleanup request failed",
		};

		/** 注入一次样式，返回移除函数。 */
		function installStyles() {
			const tagId = "file-cleanup/style.css";
			const selector = 'style[data-plugin-css="' + tagId + '"]';
			if (typeof document === "undefined" || document.querySelector(selector) !== null) return () => {};
			const tag = document.createElement("style");
			tag.dataset.plugin = "file-cleanup";
			tag.dataset.pluginCss = tagId;
			tag.textContent = CSS;
			document.head.appendChild(tag);
			return () => tag.remove();
		}

		/** 字节数格式化。 */
		function formatBytes(bytes) {
			const value = typeof bytes === "number" && Number.isFinite(bytes) ? bytes : 0;
			if (value < 1024) return value + " B";
			const units = ["KB", "MB", "GB", "TB"];
			let size = value / 1024;
			let index = 0;
			while (size >= 1024 && index < units.length - 1) {
				size /= 1024;
				index += 1;
			}
			return (size >= 10 ? size.toFixed(0) : size.toFixed(1)) + " " + units[index];
		}

		/** 错误转一行文字。 */
		function messageOf(reason) {
			return reason instanceof Error ? reason.message : String(reason);
		}

		/** 当前界面语言是否是中文。 */
		function prefersChinese() {
			const lang = typeof document === "undefined" ? "" : String(document.documentElement.lang || "");
			return lang.toLowerCase().startsWith("zh");
		}

		/**
		 * 把「文件清理」挂进桌面标题栏菜单条。
		 *
		 * 菜单条是 Desktop preload 用 `div[data-windows-menu]` + open shadow root 注入的，
		 * 里面只有 `[role=menubar]` 与它自己的两个按钮（应用 / 编辑）；preload 的 update()
		 * 只改自己那两个按钮的 textContent，外来节点不会被清掉。所以这里直接往后 append，
		 * 样式由 shadow root 里的 `button { ... }` 规则接管，和「编辑」长得一样。
		 *
		 * @param open - 打开面板的回调。
		 * @param label - 按钮文字。
		 * @returns 挂上了返回句柄，否则 null。
		 */
		function mountNativeEntry(open, label) {
			if (typeof document === "undefined") return null;
			const host = document.querySelector(MENUBAR_HOST);
			const shadow = host === null ? null : host.shadowRoot;
			if (shadow === null || shadow === undefined) return null;
			const bar = shadow.querySelector('[role="menubar"]');
			if (bar === null) return null;
			let button = shadow.querySelector('button[data-file-cleanup]');
			if (button === null) {
				button = document.createElement("button");
				button.type = "button";
				button.dataset.fileCleanup = "";
				// 与 preload 的做法一致：不抢焦点，编辑器里的选区不丢。
				button.addEventListener("pointerdown", (event) => event.preventDefault());
				button.addEventListener("mousedown", (event) => event.preventDefault());
				button.addEventListener("click", () => open());
				bar.append(button);
			}
			if (button.textContent !== label) button.textContent = label;
			return {
				button,
				dispose: () => button.remove(),
				setDisabled: (disabled) => {
					button.disabled = disabled;
				},
			};
		}

		/** 范围卡片。 */
		function ScopeCard({ title, hint, disabled, onClick }) {
			return jsxs("button", {
				type: "button",
				className: "fc-scope",
				disabled,
				onClick,
				children: [
					jsx("span", { className: "fc-scope-title", children: title }),
					jsx("span", { className: "fc-scope-hint", children: hint }),
				],
			});
		}

		/** 清单框：一次性全部渲染，靠固定高度滚动。 */
		function ItemList({ items }) {
			return jsx("div", {
				className: "fc-list",
				role: "list",
				children: items.map((item) =>
					jsxs(
						"div",
						{
							className: "fc-row",
							role: "listitem",
							title: item.path,
							children: [
								jsx("span", { className: "fc-row-path", children: item.path }),
								jsx("span", { className: "fc-row-size", children: formatBytes(item.bytes) }),
							],
						},
						item.path,
					),
				),
			});
		}

		/** 面板主体：按步骤切换内容。 */
		function PanelBody({ state, t, chooseScope, close }) {
			const error = state.error === null ? null : jsx("div", { className: "fc-error", role: "alert", children: state.error });

			if (state.step === "scope") {
				const describe = state.describe;
				const workspaces = describe === null ? [] : describe.workspaces;
				const paths = workspaces
					.slice(0, 5)
					.map((workspace) => workspace.path)
					.join("\n");
				return jsxs("div", {
					className: "fc-body",
					children: [
						jsx("div", { className: "fc-lead", children: t("scope.lead") }),
						jsxs("div", {
							className: "fc-scopes",
							children: [
								jsx(ScopeCard, {
									title: t("scope.workspaces"),
									hint:
										workspaces.length === 0
											? t("scope.workspaces.empty")
											: t("scope.workspaces.hint", {
													count: workspaces.length,
													paths: paths + (workspaces.length > 5 ? "\n…" : ""),
												}),
									disabled: describe === null || workspaces.length === 0,
									onClick: () => chooseScope("workspaces"),
								}),
								jsx(ScopeCard, {
									title: t("scope.dsh-home"),
									hint:
										describe === null
											? t("scanning")
											: t("scope.dsh-home.hint", { path: describe.dshHome }),
									disabled: describe === null,
									onClick: () => chooseScope("dsh-home"),
								}),
							],
						}),
						error,
					],
				});
			}

			if (state.step === "scanning") {
				return jsx("div", { className: "fc-status", role: "status", children: t("scanning") });
			}

			if (state.step === "cleaning") {
				return jsx("div", { className: "fc-status", role: "status", children: t("cleaning") });
			}

			if (state.step === "confirm" && state.preview !== null) {
				const preview = state.preview;
				const empty = preview.totals.files + preview.totals.dirs === 0;
				const roots = preview.rootsLabel.length > 0 ? preview.rootsLabel : preview.roots.map((path) => ({ path, title: "" }));
				const hints = [
					t("risk.1"),
					t("risk.2"),
					t("risk.3"),
					t("risk.4"),
				];
				return jsxs("div", {
					className: "fc-body",
					children: [
						jsx("div", { className: "fc-section", children: t("confirm.area") }),
						jsx("div", {
							className: "fc-paths",
							children: roots.map((root) =>
								jsx("div", { children: root.title.length > 0 ? root.title + " — " + root.path : root.path }, root.path),
							),
						}),
						empty ? null : jsx("div", { className: "fc-risk-title", children: t("confirm.risk") }),
						empty
							? null
							: jsx("ul", {
									className: "fc-risk",
									children: hints.map((hint, index) => jsx("li", { children: hint }, "risk-" + index)),
								}),
						empty
							? jsx("div", { className: "fc-ok", role: "status", children: t("confirm.empty") })
							: jsx("div", {
									className: "fc-stats",
									children: t("confirm.stats", {
										files: preview.totals.files,
										dirs: preview.totals.dirs,
										size: formatBytes(preview.totals.bytes),
									}),
								}),
						empty ? null : jsx(ItemList, { items: preview.items }),
						empty || !preview.itemsTruncated
							? null
							: jsx("div", { className: "fc-note", children: t("confirm.truncated", { count: preview.items.length }) }),
						preview.warnings.length === 0
							? null
							: jsx("div", {
									className: "fc-note",
									children: preview.warnings.map((warning) => warning.message).join("\n"),
								}),
						preview.scanFailureCount === 0
							? null
							: jsx("div", { className: "fc-note", children: preview.scanFailures.map((failure) => failure.message).join("\n") }),
						error,
					],
				});
			}

			if (state.step === "done" && state.result !== null) {
				const result = state.result;
				return jsxs("div", {
					className: "fc-body",
					children: [
						jsx("div", {
							className: "fc-ok",
							role: "status",
							children: t("result.summary", {
								files: result.removedFileCount,
								dirs: result.removedDirCount,
								empty: result.removedEmptyDirCount,
								size: formatBytes(result.freedBytes),
							}),
						}),
						result.failureCount === 0 ? null : jsx("div", { className: "fc-error", children: t("result.failures", { count: result.failureCount }) }),
						result.failureCount === 0
							? null
							: jsx("div", {
									className: "fc-list",
									role: "list",
									children: result.failures.map((failure) =>
										jsx(
											"div",
											{
												className: "fc-failure",
												role: "listitem",
												title: failure.path,
												children: failure.path + " — " + failure.message,
											},
											failure.path,
										),
									),
								}),
						result.failureCount > result.failures.length
							? jsx("div", {
									className: "fc-note",
									children: t("result.more", { count: result.failureCount - result.failures.length }),
								})
							: null,
						jsx("div", { className: "fc-note", children: formatBytes(result.freedBytes) }),
						error,
					],
				});
			}

			return error;
		}

		/** 面板 footer：按步骤给按钮。 */
		function PanelFooter({ state, t, close, startClean, copyList }) {
			if (state.step === "confirm" && state.preview !== null) {
				const empty = state.preview.totals.files + state.preview.totals.dirs === 0;
				return jsxs(Fragment, {
					children: [
						empty
							? null
							: jsx(primitives.Button, { variant: "outline", onClick: close, children: t("cancel") }),
						empty
							? jsx(primitives.Button, {
									variant: "outline",
									className: "fc-done-green",
									onClick: close,
									children: t("done"),
								})
							: jsx(primitives.Button, {
									variant: "outline",
									className: "fc-danger",
									onClick: startClean,
									children: t("start"),
								}),
					],
				});
			}
			if (state.step === "done") {
				return jsxs(Fragment, {
					children: [
						jsx(primitives.Button, {
							variant: "outline",
							onClick: copyList,
							children: state.copied ? t("copied") : t("copy"),
						}),
						jsx(primitives.Button, { variant: "outline", onClick: close, children: t("done") }),
					],
				});
			}
			if (state.step === "cleaning") {
				return jsx(primitives.Button, { variant: "outline", disabled: true, children: t("done") });
			}
			return jsx(primitives.Button, { variant: "outline", onClick: close, children: t("cancel") });
		}

		/** `shell.overlay` 的唯一入口：标题栏按钮的兜底 + 清理面板。 */
		function FileCleanupOverlay(props) {
			const { useCleanup, t, close, chooseScope, startClean, copyList, open } = props;
			const state = useCleanup((value) => value);
			const children = [];
			if (state.fallback && !state.open) {
				children.push(
					jsx("button", { type: "button", className: "fc-fallback", onClick: open, children: t("entry.label") }, "fallback"),
				);
			}
			if (state.open) {
				children.push(
					jsx(
						primitives.Modal,
						{
							open: true,
							onClose: state.step === "cleaning" ? () => {} : close,
							closeLabel: t("cancel"),
							title: t("dialog.title"),
							description: t("dialog.description"),
							footer: jsx(PanelFooter, { state, t, close, startClean, copyList }),
							children: jsx(PanelBody, { state, t, chooseScope, close }),
						},
						"panel",
					),
				);
			}
			return jsx(Fragment, { children });
		}

		const inject = ["slots", "locale"];

		function apply(ctx) {
			ctx.effect(() => installStyles(), "file-cleanup: styles");
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "file-cleanup: dictionaries");

			const t = (key, params) => ctx.locale.bind(NS)(key, params);
			const initial = {
				open: false,
				step: "scope",
				scope: null,
				preview: null,
				result: null,
				error: null,
				describe: null,
				copied: false,
				fallback: false,
			};
			const store = createSnapshotStore(initial);
			const view = { ...initial };
			const update = (patch) => {
				Object.assign(view, patch);
				store.set({ ...view });
			};

			let native = null;
			const setNativeBusy = (busy) => {
				if (native !== null) native.setDisabled(busy);
			};

			const request = async (body) => {
				let response;
				try {
					response = await fetch(ENDPOINT, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify(body),
					});
				} catch {
					throw new Error(t("error.endpoint"));
				}
				let payload = null;
				try {
					payload = await response.json();
				} catch {
					payload = null;
				}
				if (payload === null || typeof payload !== "object") {
					if (response.status === 404) throw new Error(t("error.endpoint"));
					throw new Error(t("error.generic") + "（HTTP " + response.status + "）");
				}
				if (payload.ok !== true) {
					throw new Error(String(payload.message ?? t("error.generic")));
				}
				return payload.result;
			};

			const open = () => {
				if (view.step === "cleaning") return;
				update({
					open: true,
					step: "scope",
					scope: null,
					preview: null,
					result: null,
					error: null,
					copied: false,
				});
				if (view.describe === null) {
					request({ action: "describe" })
						.then((describe) => update({ describe }))
						.catch((reason) => update({ error: messageOf(reason) }));
				}
			};

			const close = () => {
				if (view.step === "cleaning") return;
				update({ open: false, error: null });
			};

			const chooseScope = (scope) => {
				update({ step: "scanning", scope, preview: null, result: null, error: null });
				request({ action: "scan", scope })
					.then((preview) => update({ step: "confirm", preview }))
					.catch((reason) => update({ step: "scope", error: messageOf(reason) }));
			};

			const startClean = () => {
				const preview = view.preview;
				if (preview === null || view.step === "cleaning") return;
				update({ step: "cleaning", error: null });
				setNativeBusy(true);
				request({
					action: "clean",
					scope: preview.scope,
					confirm: true,
					items: preview.items.map((item) => ({ path: item.path })),
				})
					.then((result) => {
						setNativeBusy(false);
						update({ step: "done", result, preview: null });
					})
					.catch((reason) => {
						setNativeBusy(false);
						update({ step: "confirm", error: messageOf(reason) });
					});
			};

			const copyList = () => {
				const result = view.result;
				if (result === null) return;
				const lines = [...result.removedFiles, ...result.removedDirs, ...result.removedEmptyDirs];
				const text = lines.join("\n");
				if (text.length === 0) {
					update({ copied: true });
					return;
				}
				Promise.resolve()
					.then(() => navigator.clipboard.writeText(text))
					.then(() => update({ copied: true }))
					.catch(() => update({ copied: false }));
			};

			// 标题栏入口：先等 preload 把菜单条挂上（它要等 [data-shell-overlay] 出现），
			// 挂上之后断掉观察者；实在没有就退到固定落点的兜底按钮。
			const tryMount = () => {
				if (native !== null) return true;
				const mounted = mountNativeEntry(open, prefersChinese() ? zh["entry.label"] : en["entry.label"]);
				if (mounted === null) return false;
				native = mounted;
				update({ fallback: false });
				observer.disconnect();
				clearTimeout(fallbackTimer);
				return true;
			};
			const observer =
				typeof MutationObserver === "undefined"
					? { observe: () => {}, disconnect: () => {} }
					: new MutationObserver(() => tryMount());
			const fallbackTimer = setTimeout(() => {
				if (native === null) update({ fallback: true });
			}, 3000);
			if (!tryMount()) {
				observer.observe(document.body, { childList: true, subtree: true });
				const retry = setInterval(() => {
					if (tryMount()) clearInterval(retry);
				}, 500);
				ctx.effect(() => () => clearInterval(retry), "file-cleanup: titlebar retry");
			}
			ctx.effect(
				() => () => {
					observer.disconnect();
					clearTimeout(fallbackTimer);
					if (native !== null) native.dispose();
					native = null;
				},
				"file-cleanup: titlebar",
			);

			ctx.slots.inject("shell.overlay", () =>
				ctx.slots.register(
					{
						name: "shell.overlay",
						id: "file-cleanup.overlay",
						order: 600,
						locale: NS,
						inject: () => ({
							hooks: { cleanup: store },
							open,
							close,
							chooseScope,
							startClean,
							copyList,
						}),
					},
					FileCleanupOverlay,
				),
			);
		}

		exports.apply = apply;
		exports.inject = inject;
		exports.name = "file-cleanup";
		return module.exports;
	},
});
