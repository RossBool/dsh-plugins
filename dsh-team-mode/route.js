/**
 * dsh-team-mode/route — 团队协作路由层（Host）。
 *
 * 继承 dsh-agent-orchestration/route 的核心思路（信号检测 + 子句拆分 +
 * 子代理团队派发 + 队长汇总注入），但增加 **团队模式门控**：
 *
 *   团队模式（teamMode.isActive(sessionId) === true）开启时
 *     → 监听 agent/pre-step、检测协作信号、派发子代理团队
 *   团队模式关闭时
 *     → apply() 内部完全短路：所有协作信号当普通文本处理
 *
 * 级联防护（五重，沿用并增强）：
 *   1. 顶层会话限定：agents.roots() 校验
 *   2. 全局任务指纹去重：5 分钟内全局只派一次
 *   3. 级联标记拦截：子代理提示特征直接放行
 *   4. 全局组队频控：10 分钟窗口内最多 6 次
 *   5. 单会话终身限制：每会话最多 2 次、每回合 1 次
 *   6. 团队模式门控：本插件新增——模式关闭时不进入任何判断
 *
 * 用户输入 `/team on|off|once|auto` 等控制指令的处理放在
 * dsh-team-mode/control（独立插件）；本路由只读不写 teamMode。
 *
 * 默认安装的 dsh-agent-orchestration/route 因为缺少团队模式门控，
 * 默认情况下对"我想并行检查两个事情"这类自然语言会强行派发。
 * 本插件与其并存：若两者同时装配，`agent/pre-step` 多个监听器按注册顺序
 * 串行执行，本路由因持有 teamMode 短路逻辑，会在模式关闭时抢先放行。
 */

export const name = 'team-mode-route'
export const inject = ['subagents']

const SIGNAL = /并行|同时|分头|多角度|组队|团队|一起跑|兵分|几个\s*(?:agent|智能体|子代理)|多个\s*(?:agent|智能体|子代理)|拆成|分给/
const CASCADE_MARK = /你是协作团队的一名成员|你是多智能体协作团队的一名成员|你的分工/

const textOf = (blocks) => {
  if (!Array.isArray(blocks)) return ''
  const out = []
  for (const b of blocks) {
    if (b && typeof b === 'object' && typeof b.text === 'string') out.push(b.text)
  }
  return out.join(' ')
}

const isHuman = (m) => !!(m && m.role === 'user' && m.source && typeof m.source === 'object' && m.source.kind === 'user')
const isOwnNote = (m) => typeof m.id === 'string' && m.id.indexOf('team-mode-route-') === 0

const splitTasks = (text) => {
  const raw = String(text || '')
  const clauses = raw.split(/[；;。\n]+/).map((s) => s.trim()).filter((s) => s.length >= 4)
  if (clauses.length >= 2) return clauses.slice(0, 4).map((c) => ({ text: c, label: c.slice(0, 14) }))
  const parts = raw.split(/[、，,]+/).map((s) => s.trim()).filter((s) => s.length >= 6)
  if (parts.length >= 2) return parts.slice(0, 4).map((c) => ({ text: c, label: c.slice(0, 14) }))
  return []
}

const log = (...args) => console.log('team-mode-route:', ...args)

export function apply(ctx) {
  const subagents = ctx.subagents
  const teamMode = ctx.get('teamMode') // 由 team-mode-host 注册；本路由不写只读
  const state = { lastTurn: {}, count: {}, recent: {}, spawns: [] }
  let seq = 0

  const getAgents = () => ctx.get('agents')

  const windowOk = () => {
    const now = Date.now()
    state.spawns = state.spawns.filter((t) => now - t < 600000)
    return state.spawns.length < 6
  }

  // 团队模式门控：模式关闭 → 直接放行（return decision）。
  const activeFor = (sid) => {
    if (!teamMode || typeof teamMode.isActive !== 'function') return false
    try { return teamMode.isActive(sid) } catch (e) { return false }
  }

  ctx.on('agent/pre-step', async (payload, next) => {
    let decision
    try { decision = await next() } catch (e) { return undefined }
    if (!decision || decision.kind !== 'enter') return decision
    try {
      const agent = payload && payload.agent
      const sid = agent && agent.id
      const turn = payload && payload.turn
      const messages = payload && Array.isArray(payload.messages) ? payload.messages : []
      if (!sid || typeof turn !== 'number') return decision

      // guard 6: 团队模式门控（最优先——关闭时完全短路）
      if (!activeFor(sid)) return decision

      // guard 1: 顶层会话限定
      const agents = getAgents()
      if (agents && typeof agents.roots === 'function') {
        let isRoot = false
        try { isRoot = agents.roots().some((r) => r && r.id === sid) } catch (e) {}
        if (!isRoot) return decision
      }
      if (state.lastTurn[sid] === turn) return decision
      if ((state.count[sid] || 0) >= 2) return decision

      const userMsgs = messages.filter((m) => isHuman(m) && !isOwnNote(m))
      if (!userMsgs.length) return decision
      const text = userMsgs.map((m) => textOf(m.content)).join('\n')
      if (!text || !SIGNAL.test(text) || CASCADE_MARK.test(text)) return decision

      const tasks = splitTasks(text)
      if (tasks.length < 2) return decision

      // guard 2: 全局任务指纹去重
      const hash = text.replace(/\s+/g, '').slice(0, 80)
      const now = Date.now()
      if (state.recent[hash] && now - state.recent[hash] < 300000) return decision

      // guard 4: 全局组队频控
      if (!windowOk()) return decision

      state.recent[hash] = now
      state.lastTurn[sid] = turn
      const providers = Array.isArray(subagents.list()) ? subagents.list() : []
      const provider = providers.indexOf('spawn') >= 0 ? 'spawn' : providers[0]
      if (!provider) return decision

      const spawned = []
      for (const t of tasks) {
        try {
          const res = await subagents.startContinuable({
            provider,
            label: t.label,
            request: {
              prompt: [{ type: 'text', text: '你是协作团队的一名成员。\n任务背景：' + text + '\n你的分工：' + t.text + '\n请独立完成你的分工（可以读取工作区文件、执行命令），完成后用中文返回简短的结果报告。' }],
              parent: agent,
            },
            signal: payload.signal,
          })
          if (res && res.childId) spawned.push({ childId: res.childId, label: t.label })
        } catch (e) { log('spawn failed:', (e && e.message) || e) }
      }
      if (spawned.length < 2) return decision
      state.count[sid] = (state.count[sid] || 0) + 1
      state.spawns.push(Date.now())
      seq += 1
      const note = {
        role: 'user',
        source: { kind: 'user' },
        id: 'team-mode-route-' + Date.now() + '-' + seq,
        content: [{ type: 'text', text: '【团队模式已派发】当前会话处于团队模式，已为你的请求并行派出 ' + spawned.length + ' 名成员：' + spawned.map((s) => s.label).join('、') + '。成员会各自完成后把报告发回来；请在收到所有报告后合并成一份总结回复用户，不要重复执行成员负责的工作。' }],
      }
      return { kind: 'enter', messages: decision.messages.concat([note]) }
    } catch (e) {
      log('pre-step error:', (e && e.message) || e)
      return decision
    }
  })

  // 订阅团队模式变化（仅日志；本路由的派发逻辑由 activeFor() 在每一回合重读）
  if (teamMode && typeof teamMode.subscribe === 'function') {
    const off = teamMode.subscribe((detail) => {
      log('teamMode change:', JSON.stringify(detail))
    })
    ctx.effect(() => off, 'team-mode-route: teamMode subscription disposer')
  }

  log('collaboration router active (gated by teamMode; 6 cascade guards)')
}