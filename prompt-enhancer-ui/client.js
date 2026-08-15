window.__ModuleLoader__.load({
	id: "prompt-enhancer-ui",
	factory: (require) => {
		/**
 * enhance-machine — 「增强提示词」输入框状态机（纯函数，零依赖，无副作用）。
 *
 * 设计不变量（第一性原理）：
 *   1. 内容不变量：增强结果只在「draft 仍等于发送时的 snapshot」时应用。
 *      这一条同时吞掉三类竞态：迟到响应、增强期间用户编辑、会话间串扰。
 *      铁律编码在 reducer 内部（success 事件携带当前 draft，由 reducer 判定），
 *      因此它是可单测的纯逻辑，而非散落在组件里的脆弱守卫。
 *   2. 生命周期不变量：本模块只产出「状态 + 效果描述」；abort / fetch / setDraft
 *      等副作用由绑定层（React 组件）执行，unmount 时绑定层负责 abort。
 *
 * 状态机：idle → enhancing → enhanced → idle
 * 效果描述（effects）只三种：{type:'fetch', text} / {type:'abort'} / {type:'setDraft', text}
 *
 * 本文件同时是：
 *   - node --test 的测试对象（ESM export）；
 *   - 客户端 bundle 的源码（build.mjs 把 export 前缀剥掉后嵌入 client.js 工厂函数内）。
 */

/** 按钮启用的最短文本长度（trim 后）。 */
const MIN_TEXT_LENGTH = 1

/** 初始状态。 */
function initialState() {
  return {
    phase: 'idle', // 'idle' | 'enhancing' | 'enhanced'
    snapshot: null, // 发送给服务端的原文快照（enhancing 期间）
    applied: null, // 已应用进草稿的增强结果（enhanced 期间，用于比对修改）
    backup: null, // 可恢复的原文（enhanced 期间）
    error: null, // 人类可读错误（idle 期间展示）
  }
}

/**
 * 纯转移：state + event → 新状态（含 effects），事件不适用时返回 null。
 * 调用方拿到 null 表示事件被丢弃（守卫失败），不做任何事。
 */
function reduce(state, event) {
  switch (event.type) {
    case 'start': {
      if (state.phase !== 'idle') return null
      const text = typeof event.text === 'string' ? event.text : ''
      if (text.trim().length < MIN_TEXT_LENGTH) return null
      return {
        phase: 'enhancing',
        snapshot: text,
        applied: null,
        backup: null,
        error: null,
        effects: [{ type: 'fetch', text }],
      }
    }
    case 'success': {
      if (state.phase !== 'enhancing') return null // 迟到成功（已取消/已结束）→ 丢弃
      const result = typeof event.result === 'string' ? event.result.trim() : ''
      // 铁律：apply 时草稿必须仍是发送时的快照，否则丢弃，绝不覆盖用户编辑
      if (state.snapshot !== null && event.draft !== state.snapshot) {
        return {
          phase: 'idle',
          snapshot: null,
          applied: null,
          backup: null,
          error: 'edited',
        }
      }
      if (!result) {
        return {
          phase: 'idle',
          snapshot: null,
          applied: null,
          backup: null,
          error: 'empty_result',
        }
      }
      return {
        phase: 'enhanced',
        snapshot: null,
        applied: result,
        backup: state.snapshot,
        error: null,
        effects: [{ type: 'setDraft', text: result }],
      }
    }
    case 'fail': {
      if (state.phase !== 'enhancing') return null
      return {
        phase: 'idle',
        snapshot: null,
        applied: null,
        backup: null,
        error: typeof event.error === 'string' ? event.error : 'unknown',
      }
    }
    case 'cancel': {
      if (state.phase !== 'enhancing') return null
      return {
        phase: 'idle',
        snapshot: null,
        applied: null,
        backup: null,
        error: null,
        effects: [{ type: 'abort' }],
      }
    }
    case 'revert': {
      if (state.phase !== 'enhanced' || state.backup === null) return null
      return {
        phase: 'idle',
        snapshot: null,
        applied: null,
        backup: null,
        error: null,
        effects: [{ type: 'setDraft', text: state.backup }],
      }
    }
    case 'draftChanged': {
      // 修改即失效：enhanced 期间草稿一旦偏离已应用结果，恢复能力立刻清除
      if (state.phase === 'enhanced' && state.applied !== null && event.draft !== state.applied) {
        return {
          phase: 'idle',
          snapshot: null,
          applied: null,
          backup: null,
          error: null,
        }
      }
      return null
    }
    default:
      return null
  }
}

/** 派生：是否处于增强进行中（按钮 busy / 可取消）。 */
function isBusy(state) {
  return state.phase === 'enhancing'
}

/** 派生：是否展示「恢复」按钮。 */
function canRevert(state) {
  return state.phase === 'enhanced' && state.backup !== null
}

/** 派生：增强按钮是否可点（非 busy 且草稿非空）。 */
function canEnhance(state, draft) {
  return state.phase === 'idle' && typeof draft === 'string' && draft.trim().length >= MIN_TEXT_LENGTH
}

/**
 * 绑定层守卫工厂（reducer 的 null 契约 ↔ useReducer 语义之间的适配器）。
 *
 * 递归不变量：dispatch 只会收到「reduce 在当前状态上有定义」的事件——
 * 被丢弃（返回 null）的事件绝不进入 dispatch，因此 null 永远不会成为状态。
 * 这是修复 mount 崩溃（draftChanged 把 null 写回状态 → isBusy(null) 读 null.phase）
 * 的机制，固化为纯函数以便单测锁死回归。
 *
 * getState() 必须返回最新状态：调用方请传 () => ref.current（而非闭包捕获的
 * 陈旧变量），否则异步续体（如 fetch 回调）里的预检会建立在过期状态上。
 */
function createSend(getState, dispatch) {
  return (event) => {
    if (reduce(getState(), event) === null) return false
    dispatch(event)
    return true
  }
}
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react_jsx_runtime = require("react/jsx-runtime");
		let react = require("react");
		let primitives = require("@deepseek-ai/dsh-client-ui-primitives");

		// 图标按钮样式：与模型选择触发器的视觉语言一致（复用 dsh 主题变量）；busy 时图标旋转
		const CSS = ".pe-enhance{display:inline-flex;align-items:center;min-width:0}" +
			".pe-enhance-btn{min-width:0;height:28px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;border-radius:24px;outline:none;align-items:center;justify-content:center;padding:0 6px;display:inline-flex}" +
			".pe-enhance-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}" +
			".pe-enhance-btn:focus-visible{box-shadow:0 0 0 2px var(--dsw-alias-border-l3)}" +
			".pe-enhance-btn:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}" +
			".pe-enhance-btn.pe-busy svg{animation:pe-spin 1s linear infinite}" +
			".pe-enhance-btn.pe-error{color:var(--dsw-alias-state-error-primary)}" +
			".pe-enhance-btn.pe-revert{color:var(--dsw-alias-state-info-primary)}" +
			"@keyframes pe-spin{to{transform:rotate(360deg)}}";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin=prompt-enhancer-ui]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "prompt-enhancer-ui";
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}

		/**
		 * Notion AI 风格图标：四芒不对称火花（顶刺拉长、微向右倾）+ 右上角小加号。
		 */
		function AiSparkleIcon({ size = 14, className }) {
			return react_jsx_runtime.jsxs("svg", {
				width: size,
				height: size,
				viewBox: "0 0 16 16",
				fill: "none",
				"aria-hidden": true,
				className,
				children: [
					react_jsx_runtime.jsx("path", {
						d: "M3.4 0.9Q6.37 8.39 10.6 5.6Q6.07 9.25 7.6 14.2Q5.43 8.81 1.2 9.8Q5.65 7.92 3.4 0.9Z",
						fill: "currentColor",
					}),
					react_jsx_runtime.jsx("path", {
						d: "M14.9 1.2 V4.8 M13.1 3 H16.7",
						stroke: "currentColor",
						strokeWidth: 1.5,
						strokeLinecap: "round",
					}),
				],
			});
		}

		/** 字典命名空间（独立命名，避免与其他客户端模块冲突）。 */
		const NS = "prompt-enhancer-ui";
		const zh = {
			"button.aria": "增强输入框中的提示词",
			"button.aria.busy": "取消正在进行的增强",
			"button.aria.revert": "恢复增强前的原文",
			"button.title": "提示词增强：把当前输入改写成更清晰、更高质量的它本身（同语言、同形态、同意图）后填入输入框",
			"button.title.busy": "正在增强，点击取消",
			"button.title.revert": "恢复增强前的原文",
			"button.title.error": "增强失败",
			"error.empty_input": "输入为空",
			"error.provider_unavailable": "没有可用的模型路由，请检查模型配置",
			"error.llm_error": "模型调用失败，请重试",
			"error.timeout": "增强超时，请重试",
			"error.rate_limited": "并发增强过多，请稍后再试",
			"error.unknown": "增强失败",
		};
		const en = {
			"button.aria": "Enhance the prompt in the input box",
			"button.aria.busy": "Cancel the enhancement in progress",
			"button.aria.revert": "Restore the text before enhancement",
			"button.title": "Prompt enhancement: rewrite the current input into a clearer, higher-quality version of itself (same language, same form, same intent), then fill the input box",
			"button.title.busy": "Enhancing, click to cancel",
			"button.title.revert": "Restore the text before enhancement",
			"button.title.error": "Enhancement failed",
			"error.empty_input": "Input is empty",
			"error.provider_unavailable": "No model route available, check model settings",
			"error.llm_error": "Model call failed, please retry",
			"error.timeout": "Enhancement timed out, please retry",
			"error.rate_limited": "Too many concurrent enhancements, please wait",
			"error.unknown": "Enhancement failed",
		};

		/** 服务端契约错误码 → 本地化文案 key。'edited'（结果因用户编辑被丢弃）不提示——与 WorkBuddy 行为一致。 */
		const ERROR_KEYS = {
			empty_input: "error.empty_input",
			provider_unavailable: "error.provider_unavailable",
			llm_error: "error.llm_error",
			timeout: "error.timeout",
			rate_limited: "error.rate_limited",
			unknown: "error.unknown",
			edited: null,
			empty_result: "error.llm_error",
		};

		/** 执行 reducer 产出的效果描述（setDraft / abort）。 */
		function runEffects(effects, inputActions, controllerRef) {
			for (const effect of effects ?? []) {
				if (effect.type === "setDraft" && typeof effect.text === "string") inputActions.setDraft(effect.text);
				else if (effect.type === "abort" && controllerRef.current) controllerRef.current.abort();
			}
		}

		/**
		 * 输入框工具栏按钮（模型选择旁边）：
		 * 状态机三态：idle（✨）/ busy（spinner，点击取消）/ enhanced（恢复图标）。
		 * 铁律由 reduce 保证：迟到成功不覆盖已编辑输入（success 事件携带当前 draft 由 reducer 判定）；
		 * 修改即失效由 draftChanged 事件保证；unmount（切会话）→ abort 请求。
		 */
		function EnhanceButton({ useInput, inputActions, sessionId, getSessionModel, t }) {
			const draft = useInput((s) => (s && typeof s.draft === "string" ? s.draft : ""));
			const [machine, dispatch] = react.useReducer(reduce, undefined, initialState);
			const draftRef = react.useRef(draft);
			draftRef.current = draft;
			const machineRef = react.useRef(machine);
			machineRef.current = machine;
			const controllerRef = react.useRef(null);
			const aliveRef = react.useRef(true);

			// 契约守卫（递归基例，逻辑在 machine.js 的 createSend 中，由单测锁定回归）：
			// 被丢弃的事件绝不 dispatch，null 永不落库；预检始终读取最新状态（machineRef 防闭包陈旧）。
			const send = createSend(() => machineRef.current, dispatch);

			// 生命周期不变量：组件卸载（会话切换）→ 取消进行中的请求
			react.useEffect(() => () => {
				aliveRef.current = false;
				if (controllerRef.current) controllerRef.current.abort();
			}, []);

			// 修改即失效：草稿变化喂给 reducer，enhanced 期间偏离 applied 即清除恢复能力。
			// 必须走 send 守卫：idle/enhancing 下 draftChanged 返回 null，直接 dispatch 会把
			// null 写成状态（useReducer 语义），导致下一帧 isBusy(null) 崩溃。
			react.useEffect(() => {
				send({ type: "draftChanged", draft });
			}, [draft]);

			const beginEnhance = async () => {
				const snapshot = draft;
				if (!send({ type: "start", text: snapshot })) return;
				const controller = new AbortController();
				controllerRef.current = controller;
				try {
					const sessionModel = typeof getSessionModel === "function" ? getSessionModel() : null;
					const body = { text: snapshot };
					if (sessionModel && sessionModel.provider && sessionModel.model) {
						body.provider = sessionModel.provider;
						body.model = sessionModel.model;
					}
					if (typeof sessionId === "string" && sessionId) body.sessionId = sessionId;
					const res = await fetch("/api/enhance-prompt", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify(body),
						signal: controller.signal,
					});
					let payload = null;
					try { payload = await res.json(); } catch { /* 非 JSON 响应按 unknown 处理 */ }
					if (!aliveRef.current) return;
					if (controller.signal.aborted) return; // 用户取消：reducer 已回 idle，静默
					if (res.ok && payload && payload.ok === true && typeof payload.text === "string") {
						// 异步续体里的 machine 是点击时刻的陈旧闭包，预检必须用 machineRef.current
						const event = { type: "success", result: payload.text, draft: draftRef.current };
						const next2 = reduce(machineRef.current, event);
						if (next2 === null) return;
						send(event);
						runEffects(next2.effects, inputActions, controllerRef);
					} else {
						const code = payload && typeof payload.code === "string" ? payload.code : "unknown";
						send({ type: "fail", error: code });
					}
				} catch (err) {
					if (!aliveRef.current) return;
					if (controller.signal.aborted) return; // 取消/卸载产生的 AbortError 不是错误
					const code = err && err.name === "TypeError" && /fetch|network/i.test(String(err.message)) ? "llm_error" : "unknown";
					send({ type: "fail", error: code });
				} finally {
					if (controllerRef.current === controller) controllerRef.current = null;
				}
			};

			const onClick = () => {
				if (isBusy(machine)) {
					const next = reduce(machineRef.current, { type: "cancel" });
					if (next === null) return;
					send({ type: "cancel" });
					runEffects(next.effects, inputActions, controllerRef);
					return;
				}
				if (canRevert(machine)) {
					const next = reduce(machineRef.current, { type: "revert" });
					if (next === null) return;
					send({ type: "revert" });
					runEffects(next.effects, inputActions, controllerRef);
					return;
				}
				void beginEnhance();
			};

			const busy = isBusy(machine);
			const revert = canRevert(machine);
			const disabled = !busy && !revert && !canEnhance(machine, draft);
			const errorKey = ERROR_KEYS[machine.error] ?? ERROR_KEYS.unknown;
			const errorText = machine.error && errorKey ? t(errorKey) : null;
			const icon = busy
				? react_jsx_runtime.jsx(primitives.IconLoadingOutline16, { size: 14 })
				: revert
					? react_jsx_runtime.jsx(primitives.IconRefreshOutline16, { size: 14 })
					: react_jsx_runtime.jsx(AiSparkleIcon, { size: 14 });
			const className = "pe-enhance-btn" + (busy ? " pe-busy" : "") + (revert ? " pe-revert" : "") + (errorText !== null ? " pe-error" : "");
			const aria = busy ? t("button.aria.busy") : revert ? t("button.aria.revert") : t("button.aria");
			const title = errorText !== null
				? t("button.title.error") + ": " + errorText
				: busy ? t("button.title.busy") : revert ? t("button.title.revert") : t("button.title");
			return react_jsx_runtime.jsx("button", {
				type: "button",
				className,
				disabled,
				"aria-label": aria,
				title,
				onClick,
				children: icon,
			});
		}

		/** 客户端依赖：插槽注册表、本地化（会话模型读取为可选能力，缺失时走服务端默认）。 */
		const inject = ["slots", "locale"];

		/** 客户端插件入口：注册字典 + 把按钮挂到模型选择旁的 conversation.input.right 插槽。 */
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "prompt-enhancer-ui: dictionaries");
			ctx.slots.inject("conversation.input.right", () => ctx.slots.register({
				name: "conversation.input.right",
				id: "prompt-enhancer-ui",
				locale: NS,
				inject: (sessionId) => ({
					sessionId,
					getSessionModel: () => {
						// FR-09：模型跟随会话当前选中模型（可选能力，读取失败则服务端回退默认）
						const directories = ctx.get("modelDirectories");
						if (!directories || typeof directories.directoryFor !== "function") return null;
						try {
							return directories.directoryFor(sessionId).store.getSnapshot().current ?? null;
						} catch {
							return null;
						}
					},
				}),
			}, EnhanceButton));
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
