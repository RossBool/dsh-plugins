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
export const MIN_TEXT_LENGTH = 1

/** 初始状态。 */
export function initialState() {
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
export function reduce(state, event) {
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
export function isBusy(state) {
  return state.phase === 'enhancing'
}

/** 派生：是否展示「恢复」按钮。 */
export function canRevert(state) {
  return state.phase === 'enhanced' && state.backup !== null
}

/** 派生：增强按钮是否可点（非 busy 且草稿非空）。 */
export function canEnhance(state, draft) {
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
export function createSend(getState, dispatch) {
  return (event) => {
    if (reduce(getState(), event) === null) return false
    dispatch(event)
    return true
  }
}
