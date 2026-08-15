/**
 * dsh-team-mode — 团队模式开关（Host）。
 *
 * 职责：
 *   - 注册一个进程级单例 `teamMode` 服务，供其他插件查询；
 *   - 维护两层状态：
 *       global         — 进程级总开关（默认 false）
 *       sessions[ id ] — 会话级覆盖（true 强制开启 / false 强制关闭 / undefined 跟随 global）
 *   - 提供同进程内的事件订阅：`team-mode/change`，payload = { global, sessionId?, value, source }
 *
 * 设计动机：
 *   原 dsh-agent-orchestration 默认对所有顶层会话暴露协作画布 / 协作路由，
 *   这让"我只想正常提问"的用户也会被动看到画布、被动触发分句派发。
 *   改为：协作类插件（画布 + 协作路由）应当只在团队模式开启时启用。
 *
 * 接入范式（消费方）：
 *   import { name as OrchestrationHost } from '@deepseek-ai/dsh-agent-orchestration'
 *   const teamMode = ctx.get('teamMode')
 *   ctx.effect(() => {
 *     const off = teamMode.subscribe(() => { /* 重读最新状态并按需挂载/卸载自己 */ })
 *     return off
 *   }, 'orchestration: react to team mode')
 *
 *   或者：消费方挂载时直接根据 teamMode.isActive(sessionId) 决定是否注册路由。
 */

export const name = 'team-mode-host'

const str = (v) => {
  if (v === undefined || v === null) return undefined
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return undefined
}

const buildApi = (state) => ({
  /**
   * 查询是否在团队模式。
   *   - 不传 sessionId：仅看 global；
   *   - 传 sessionId：先看该会话覆盖，再看 global（覆盖优先）。
   */
  isActive(sessionId) {
    if (sessionId !== undefined && sessionId !== null) {
      const sid = str(sessionId)
      if (sid && Object.prototype.hasOwnProperty.call(state.sessionOverrides, sid)) {
        return !!state.sessionOverrides[sid]
      }
    }
    return !!state.global
  },
  /** 当前全局开关原始值。 */
  getGlobal() { return !!state.global },
  /** 当前所有会话覆盖的快照（id → boolean）。 */
  getSessionOverrides() {
    const out = {}
    for (const k of Object.keys(state.sessionOverrides)) out[k] = !!state.sessionOverrides[k]
    return out
  },
  /** 设置全局开关；返回切换后全局值。 */
  setGlobal(next) {
    const v = !!next
    if (v === state.global) return v
    state.global = v
    emit('global', undefined, v, 'host')
    return v
  },
  /** 设置会话级覆盖；sessionId 为 null/undefined 表示删除覆盖。 */
  setSession(sessionId, next) {
    const sid = str(sessionId)
    if (!sid) return state.sessionOverrides[sid]
    if (next === undefined || next === null) {
      if (Object.prototype.hasOwnProperty.call(state.sessionOverrides, sid)) {
        delete state.sessionOverrides[sid]
        emit('session-clear', sid, undefined, 'host')
      }
      return undefined
    }
    const v = !!next
    const prev = state.sessionOverrides[sid]
    state.sessionOverrides[sid] = v
    if (prev !== v) emit('session', sid, v, 'host')
    return v
  },
  /** 订阅团队模式变化；handler(payload) 返回 disposer。 */
  subscribe(handler) {
    if (typeof handler !== 'function') return () => {}
    state.subscribers.push(handler)
    return () => {
      const i = state.subscribers.indexOf(handler)
      if (i >= 0) state.subscribers.splice(i, 1)
    }
  },
  /** 给消费方打点用：列出当前观察到的所有覆盖会话。 */
  snapshot() {
    return { global: !!state.global, sessionOverrides: this.getSessionOverrides() }
  },
})

const buildClientApi = (api) => ({
  isActive: (sid) => api.isActive(sid),
  getGlobal: () => api.getGlobal(),
  subscribe: (h) => api.subscribe(h),
  snapshot: () => api.snapshot(),
  // JSON 通道：客户端可以远程操作（前提是配置允许 host→client remote toggle）
  setGlobal: (v) => api.setGlobal(v),
  setSession: (sid, v) => api.setSession(sid, v),
})

export function apply(ctx) {
  // 不做硬 inject：teamMode 是开关基础设施，所有插件都应当能惰性 ctx.get('teamMode') 拿到它。
  const state = {
    global: false,
    sessionOverrides: {},
    subscribers: [],
  }
  const api = buildApi(state)
  const emit = (kind, sessionId, value, source) => {
    const payload = { kind, sessionId, value: value === undefined ? undefined : !!value, source: source || 'host' }
    for (const h of state.subscribers.slice()) {
      try { h(payload) } catch (e) { console.log('team-mode subscriber error: ' + String((e && e.message) || e)) }
    }
  }

  // 暴露进程级单例。
  ctx.effect(() => ctx.registry.register({ name: 'teamMode', value: api }), 'team-mode: register teamMode service')

  // 跨会话协作：暴露给 Client 的 JSON 通道，方便 UI 切换。
  ctx.effect(() => ctx.harness.handle('team-mode/get', () => api.snapshot()), 'team-mode: client get')
  ctx.effect(() => ctx.harness.handle('team-mode/set-global', async (args) => {
    const v = args && typeof args === 'object' ? args.value : undefined
    return { global: api.setGlobal(v) }
  }), 'team-mode: client set-global')
  ctx.effect(() => ctx.harness.handle('team-mode/set-session', async (args) => {
    const sid = args && typeof args === 'object' ? args.sessionId : undefined
    const v = args && typeof args === 'object' ? args.value : undefined
    return { sessionId: sid, value: api.setSession(sid, v) }
  }), 'team-mode: client set-session')
  ctx.effect(() => ctx.harness.handle('team-mode/subscribe', async (args, signal) => {
    // 返回当前快照 + 一条长连接通知；为了简单，这里仅返回快照 + 一个轮询式接口。
    return { snapshot: api.snapshot() }
  }), 'team-mode: client subscribe (snapshot only)')

  console.log('team-mode-host: teamMode service registered (default off)')
}