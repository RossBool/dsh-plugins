/**
 * dsh-agent-orchestration/route — 自然语言协作路由层（Host）。
 *
 * 挂载 agent/pre-step 瀑布：检测顶层会话中真人输入的显式协作信号
 * （并行/分头/组队/多角度…），按分句拆解任务并派发持久化并行子代理团队，
 * 向主会话注入队长汇总指令。普通对话零开销直通。
 *
 * 仅当「团队模式」开启时才执行派发。团队模式是 Agent 预设级开关：
 * 本行只被 `team` 预设（团队模式）以 `config.teamMode: true` 挂载，
 * 其它预设根本不加载本插件。config 缺省一律按关闭处理（保守默认）。
 *
 * 级联防护（六重）：
 *  0. 团队模式 guard：config.teamMode !== true 直接 return decision（第一道闸门）
 *  1. 顶层会话限定：agents.roots() 校验，子代理永不二次组队（结构性斩断递归）
 *  2. 全局任务指纹去重：同一任务文本 5 分钟内全局只组队一次
 *  3. 级联标记拦截：子代理提示特征文本直接放行
 *  4. 全局组队频控：10 分钟窗口内全进程最多 6 次组队
 *  5. 每会话频控：单个会话终身最多 2 次组队、每回合 1 次
 */

export const name = 'orchestration-route'
export const inject = ['subagents']

const SIGNAL = /并行|同时|分头|多角度|组队|团队|一起跑|兵分|几个\s*(?:agent|智能体|子代理)|多个\s*(?:agent|智能体|子代理)|拆成|分给/
const CASCADE_MARK = /你是协作团队的一名成员|你是多智能体协作团队的一名成员/

const textOf = (blocks) => {
  if (!Array.isArray(blocks)) return ''
  const out = []
  for (const b of blocks) {
    if (b && typeof b === 'object' && typeof b.text === 'string') out.push(b.text)
  }
  return out.join(' ')
}

const isHuman = (m) => !!(m && m.role === 'user' && m.source && typeof m.source === 'object' && m.source.kind === 'user')
const isOwnNote = (m) => typeof m.id === 'string' && m.id.indexOf('orchestration-route-') === 0

const splitTasks = (text) => {
  const raw = String(text || '')
  const clauses = raw.split(/[；;。\n]+/).map((s) => s.trim()).filter((s) => s.length >= 4)
  if (clauses.length >= 2) return clauses.slice(0, 4).map((c) => ({ text: c, label: c.slice(0, 80) }))
  const parts = raw.split(/[、，,]+/).map((s) => s.trim()).filter((s) => s.length >= 6)
  if (parts.length >= 2) return parts.slice(0, 4).map((c) => ({ text: c, label: c.slice(0, 80) }))
  return []
}

export function apply(ctx, config) {
  // guard 0: team mode — 只有 team 预设（团队模式）通过 config.teamMode: true
  // 挂载本行时才派发并行团队；其它模式根本不加载本插件，加载了但没开
  // teamMode 也一律直通。零派发、零开销。
  if (!config || config.teamMode !== true) {
    console.log('orchestration-route: skipped (teamMode=' + (config && config.teamMode) + '，默认 false — 非团队模式不派发)')
    return
  }
  const subagents = ctx.subagents
  const state = { lastTurn: {}, count: {}, recent: {}, spawns: [] }
  let seq = 0

  const getAgents = () => ctx.get('agents')

  const windowOk = () => {
    const now = Date.now()
    state.spawns = state.spawns.filter((t) => now - t < 600000)
    return state.spawns.length < 6
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
      // guard 1: top-level sessions only
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
      // guard 2: global fingerprint dedupe
      const hash = text.replace(/\s+/g, '').slice(0, 80)
      const now = Date.now()
      if (state.recent[hash] && now - state.recent[hash] < 300000) return decision
      // guard 4: global rate limit
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
        } catch (e) { console.log('orchestration-route spawn failed: ' + String((e && e.message) || e)) }
      }
      if (spawned.length < 2) return decision
      state.count[sid] = (state.count[sid] || 0) + 1
      state.spawns.push(Date.now())
      seq += 1
      const note = {
        role: 'user',
        source: { kind: 'user' },
        id: 'orchestration-route-' + Date.now() + '-' + seq,
        content: [{ type: 'text', text: '【协作路由已派发团队】已为你的请求并行派出 ' + spawned.length + ' 名成员：' + spawned.map((s) => s.label).join('、') + '。成员会各自完成后把报告发回来；请在收到所有报告后合并成一份总结回复用户，不要重复执行成员负责的工作。' }],
      }
      return { kind: 'enter', messages: decision.messages.concat([note]) }
    } catch (e) {
      console.log('orchestration-route pre-step error: ' + String((e && e.message) || e))
      return decision
    }
  })

  console.log('orchestration-route: collaboration router active (team mode ON, 6 cascade guards)')
}
