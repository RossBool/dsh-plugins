/**
 * dsh-agent-orchestration — 协作画布数据服务（Host）。
 *
 * 向 Web 客户端提供三条 REST 路由（webServer 服务注册）：
 *   GET /plugins/dsh-agent-orchestration/data   画布编排树（子代理血缘 + 工作流折叠 + 归档过滤）
 *   GET /plugins/dsh-agent-orchestration/detail 节点执行详情时间线
 *   GET /plugins/dsh-agent-orchestration/stream 增量流式构建：逐节点 NDJSON 下发
 *     （init / nodes / update / remove / done + ':hb' 心跳），客户端随到随显
 *
 * 数据源全部来自 DSH 现有服务：subagents.listDescendants（血缘树）、
 * 活体会话内存日志（tool-workflow/* 事件折叠）、workspaceRegistry
 * （归档过滤）、sessionQuery（标题/冷会话读取）。
 *
 * 激活时序：硬 inject ['webServer'] 确保路由注册在 HTTP 服务就绪后执行；
 * 其余服务在请求到达时用 ctx.get() 惰性解析（handler 必然晚于全部服务激活）。
 *
 * 团队模式开关（teamMode）：默认 false。仅当用户在 cordis.patch.yml 把
 * config.teamMode 设为 true 时，本插件才注册路由——其余模式静默离场，不占
 * HTTP 路径、不打日志。
 */

export const name = 'orchestration-host'
export const inject = ['webServer']

import { readFile } from 'node:fs/promises'
import path from 'node:path'

/** 计划引擎状态文件目录(dsh-team-plan 插件落盘位置,与其实现在同一约定下) */
const planStateDir = () => {
  const home = process.env.DSH_HOME || (process.env.HOME ? path.join(process.env.HOME, '.dsh') : '')
  return home ? path.join(home, 'storages', 'dsh-team-plan') : ''
}

/** 读取本会话的计划引擎状态,叠加为画布的 plan 层节点(engine/plan/worker/verifier + 重试环)。
 *  v2.2:emitNode 回调逐节点下发(增量流式构建),每个候选会话状态文件独立读取、读到即发。 */
const PLAN_STATUS = { pending: 'waiting', ready: 'waiting', running: 'running', verifying: 'running', passed: 'done', exhausted: 'fail' }

async function loadPlanLayer(rootId, candidateIds, emitNode) {
  // 隔离架构(M4):计划引擎跑在独立任务会话里,状态文件按任务会话 id 命名。
  // 对每个候选会话(根本身 + 血缘后代)查找状态文件,命中则把 plan 层节点
  // 挂在对应任务节点之下 —— 每个任务在画布上是一棵独立子树。
  const ids = Array.isArray(candidateIds) ? candidateIds : [rootId]
  let count = 0
  for (const ownerId of ids) {
    try {
      const dir = planStateDir()
      if (!dir) continue
      const safe = String(ownerId).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 96)
      const raw = await readFile(path.join(dir, safe + '.json'), 'utf8')
      const s = JSON.parse(raw)
      if (!s || s.v !== 1 || !s.plan || !Array.isArray(s.plan.batches) || !s.batches) continue
      const engineId = 'plan-engine:' + ownerId
      const planId = 'plan-doc:' + ownerId
      emitNode({ id: engineId, parentId: ownerId, kind: 'engine', label: '计划引擎', status: s.phase === 'done' ? 'done' : 'running' })
      emitNode({ id: planId, parentId: engineId, kind: 'plan', label: 'plan · ' + s.plan.batches.length + ' 批', status: s.phase === 'done' ? 'done' : 'running', meta: String(s.plan.goal || '').slice(0, 40) })
      for (const spec of s.plan.batches) {
        const b = s.batches[spec.id]
        const batchId = 'plan-batch:' + ownerId + ':' + spec.id
        const verifyId = 'plan-verify:' + ownerId + ':' + spec.id
        const bStatus = b ? (PLAN_STATUS[b.status] || 'waiting') : 'waiting'
        emitNode({ id: batchId, parentId: planId, kind: 'worker', label: String(spec.title || spec.id).slice(0, 60), status: bStatus, meta: spec.id + ' · ' + (b ? b.attempts : 0) + ' 轮' })
        const vStatus = !b ? 'waiting' : b.status === 'verifying' ? 'running' : b.status === 'passed' ? 'done' : b.status === 'exhausted' ? 'fail' : 'waiting'
        const vNode = { id: verifyId, parentId: batchId, kind: 'verifier', label: '验证 ' + spec.id, status: vStatus }
        if (b && b.attempts > 0) vNode.retryTo = batchId // 红色重试环(客户端渲染)
        emitNode(vNode)
        count += 2
      }
      count += 2
    } catch (e) { /* 该候选无状态文件或不可读,跳过 */ }
  }
  return count
}

const str = (v, max) => {
  const t = typeof v === 'string' ? v : (typeof v === 'number' || typeof v === 'boolean' ? String(v) : undefined)
  if (t === undefined) return undefined
  return max ? t.slice(0, max) : t
}

const snip = (s, n) => { const t = s === undefined || s === null ? '' : String(s); return t.length > n ? t.slice(0, n) + '…' : t }

const DEMO_TREE = [
  { id: 'd-plan', parentId: 'demo-root', kind: 'plan', label: '规划 · 目标拆解', status: 'done' },
  { id: 'd-perf', parentId: 'd-plan', kind: 'agent', label: '性能分析 Agent', status: 'done' },
  { id: 'd-perf-r1', parentId: 'd-perf', kind: 'review', label: 'review · 基准测试', status: 'pass' },
  { id: 'd-perf-r2', parentId: 'd-perf', kind: 'review', label: 'review · 热点剖析', status: 'pass' },
  { id: 'd-sec', parentId: 'd-plan', kind: 'agent', label: '安全审查 Agent', status: 'running' },
  { id: 'd-sec-r1', parentId: 'd-sec', kind: 'review', label: 'review · 依赖审计', status: 'running' },
  { id: 'd-sec-r2', parentId: 'd-sec', kind: 'review', label: 'review · 权限检查', status: 'pending' },
  { id: 'd-prod', parentId: 'd-plan', kind: 'agent', label: '产品体验 Agent', status: 'blocked' },
  { id: 'd-prod-r1', parentId: 'd-prod', kind: 'review', label: 'review · 交互走查', status: 'fail' },
  { id: 'd-sum', parentId: 'demo-root', kind: 'report', label: '汇总报告', status: 'pending' },
]

const valTxt = (v) => {
  if (v === undefined || v === null) return ''
  if (typeof v === 'object') { try { return JSON.stringify(v).slice(0, 24) } catch (e) { return '(对象)' } }
  return String(v)
}

const extractText = (v) => {
  const out = []
  const walk = (x, depth) => {
    if (depth > 3 || out.length > 12) return
    if (typeof x === 'string') { out.push(x); return }
    if (!x || typeof x !== 'object') return
    if (Array.isArray(x)) { for (const y of x) walk(y, depth + 1); return }
    if (typeof x.type === 'string' && typeof x.text === 'string' && (x.type === 'text' || x.type === 'thinking' || x.type === 'reasoning' || x.type === 'delta')) out.push(x.text)
    if (typeof x.text === 'string' && x.type === undefined) out.push(x.text)
    if (typeof x.content === 'string') out.push(x.content)
    else if (Array.isArray(x.content)) walk(x.content, depth + 1)
    if (Array.isArray(x.parts)) walk(x.parts, depth + 1)
  }
  walk(v, 0)
  return out
}

const fmtTime = (t) => {
  if (typeof t !== 'number' || !isFinite(t)) return ''
  const d = new Date(t)
  const p = (n) => (n < 10 ? '0' : '') + n
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds())
}

const foldWorkflow = (events) => {
  const runs = {}
  for (const ev of events) {
    if (!ev || typeof ev !== 'object') continue
    const t = ev.type
    if (typeof t !== 'string' || t.indexOf('tool-workflow/') !== 0) continue
    const d = ev.data
    if (!d || typeof d !== 'object') continue
    const rid = String((d.runId !== undefined ? d.runId : d.id) || '')
    if (!rid) continue
    if (t === 'tool-workflow/run-start') {
      const r = runs[rid] || (runs[rid] = { id: rid, name: '工作流', status: 'running', members: [] })
      const nm = str(d.name, 40)
      if (nm) r.name = nm
    } else if (t === 'tool-workflow/agent-start') {
      const r = runs[rid] || (runs[rid] = { id: rid, name: '工作流', status: 'running', members: [] })
      r.members.push({ seq: d.seq, label: str(d.label, 40) || '成员', phase: str(d.phase, 40), childId: str(d.childId), status: 'running' })
    } else if (t === 'tool-workflow/agent-end') {
      const r = runs[rid]
      if (!r) continue
      for (const m of r.members) {
        if (String(m.seq) === String(d.seq)) { m.status = str(d.outcome) || 'failed'; break }
      }
    } else if (t === 'tool-workflow/run-end') {
      const r = runs[rid]
      if (!r) continue
      const sr = str(d.stopReason)
      r.status = sr === 'error' ? 'failed' : (sr === 'cancelled' ? 'cancelled' : (sr || 'completed'))
    }
  }
  const out = []
  for (const rid of Object.keys(runs)) out.push(runs[rid])
  return out
}

const logErr = (msg, e) => console.log('orchestration-host ' + msg + ': ' + String((e && e.message) || e))

export function apply(ctx, config) {
  if (!config || config.teamMode !== true) {
    console.log('orchestration-host: skipped (teamMode=' + (config && config.teamMode) + '，默认 false — 其他模式不启用协作画布)')
    return
  }

  const wfCache = { key: '', runs: [] }

  const foldWfForRoot = async (rootId) => {
    if (!rootId) return []
    const sessions = ctx.get('sessions')
    const sessionQuery = ctx.get('sessionQuery')
    let live = null
    try { live = sessions && sessions.get(rootId) } catch (e) {}
    if (live && Array.isArray(live.events)) {
      const key = rootId + ':live:' + live.seq
      if (wfCache.key === key) return wfCache.runs
      const runs = foldWorkflow(live.events)
      wfCache.key = key
      wfCache.runs = runs
      return runs
    }
    if (!sessionQuery || typeof sessionQuery.listEvents !== 'function') return []
    try {
      const recs = await sessionQuery.listEvents(rootId)
      if (!Array.isArray(recs)) return []
      const lastSeq = recs.length ? recs[recs.length - 1].seq : -1
      const key = rootId + ':cold:' + recs.length + ':' + lastSeq
      if (wfCache.key === key) return wfCache.runs
      let snap = null
      if (typeof sessionQuery.readSession === 'function') {
        try { snap = await sessionQuery.readSession(rootId) } catch (e) { logErr('readSession', e) }
      }
      const runs = foldWorkflow(snap && Array.isArray(snap.events) ? snap.events : [])
      wfCache.key = key
      wfCache.runs = runs
      return runs
    } catch (e) { logErr('wf events', e); return [] }
  }

  /**
   * 增量构建画布(v2.2):每产生一个节点立即通过 emit 下发——
   *   /stream 路由把事件逐条写出(客户端随到随显),
   *   /data  路由把同一事件流聚合成与旧版一致的完整快照(轮询与回退兼容)。
   * 构建顺序与旧版 fetchData 完全一致:
   *   init → 队长 → 血缘后代(逐个) → 逐节点状态更新 → 工作流折叠 →
   *   汇总报告 → 标题修复 → 计划层 → done。
   * 旧版"全部节点构建完才一次性返回"的等待被拆成逐节点下发:
   * 队长与拓扑立即可见,慢扫描(8s 上限、并行)只延迟状态字段、不阻塞拓扑。
   */
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

  const buildCanvas = async (rootId, emit, staggerMs) => {
    const subagents = ctx.get('subagents')
    const agents = ctx.get('agents')
    const sessionQuery = ctx.get('sessionQuery')
    const sessions = ctx.get('sessions')
    const sessionTitle = ctx.get('sessionTitle')
    const workspaceRegistry = ctx.get('workspaceRegistry')

    const titleOf = (id) => {
      try {
        const s = sessions && sessions.get(id)
        if (s && sessionTitle) {
          const t = sessionTitle.get(s)
          if (typeof t === 'string' && t) return t.slice(0, 40)
          if (t && typeof t === 'object' && typeof t.title === 'string' && t.title) return t.title.slice(0, 40)
        }
      } catch (e) {}
      return undefined
    }
    const archivedIds = () => {
      const set = new Set()
      try {
        let arch
        try { arch = workspaceRegistry && workspaceRegistry.archivedSessionIds } catch (e) {}
        if (Array.isArray(arch)) for (const id of arch) set.add(id)
      } catch (e) {}
      return set
    }

    const liveAgents = {}
    if (agents && typeof agents.list === 'function') {
      try {
        for (const a of agents.list()) {
          if (!a || typeof a !== 'object') continue
          const id = str(a.id)
          if (!id) continue
          liveAgents[id] = str(a.status) || str(a.state) || str(a.activity)
        }
      } catch (e) {}
    }

    // 状态解析：以会话事件序列为准（与聊天中实际产生的结果一致）。
    // 从尾部扫描：最后 turn/end 晚于最后 turn/start ⇒ 已结束
    // （reason error/blocked/cancelled ⇒ failed，否则 done）；
    // 还有未结束的 turn/start ⇒ running；无任何回合 ⇒ 活体 waiting / 冷会话 idle。
    // 同时从成员会话的首条用户消息提取「你的分工：」后的完整任务文本，
    // 用于修复派发时截断的标签（历史派发的 40 字残标签也一并还原）。
    const statusCache = new Map()
    const labelCache = new Map()
    const sessionScan = async (id) => {
      if (statusCache.has(id) && labelCache.has(id)) {
        return { status: statusCache.get(id), taskLabel: labelCache.get(id) }
      }
      let events = null
      let cold = false
      try {
        const s = sessions && sessions.get(id)
        if (s && Array.isArray(s.events)) events = s.events
      } catch (e) {}
      if (!events && sessionQuery && typeof sessionQuery.readSession === 'function') {
        try {
          const snap = await sessionQuery.readSession(id)
          if (snap && Array.isArray(snap.events)) { events = snap.events; cold = true }
        } catch (e) {}
      }
      if (!events || !events.length) return { status: liveAgents[id] ? 'waiting' : 'idle', taskLabel: undefined }
      let lastEnd = -1
      let lastStart = -1
      let reason = ''
      let taskLabel
      for (let i = events.length - 1; i >= 0; i--) {
        const ev = events[i]
        const t = ev && ev.type
        if (t === 'turn/end' && lastEnd < 0) {
          lastEnd = i
          const d = ev.data && typeof ev.data === 'object' ? ev.data : {}
          const r = d.reason && typeof d.reason === 'object' ? d.reason : {}
          reason = String(r.kind || r.type || r.name || '')
        } else if (t === 'turn/start' && lastStart < 0) {
          lastStart = i
        }
        if (lastEnd >= 0 && lastStart >= 0) break
      }
      for (const ev of events) {
        if (ev && ev.type === 'user/message') {
          const d = ev.data && typeof ev.data === 'object' ? ev.data : {}
          if (Array.isArray(d.content)) {
            for (const b of d.content) {
              if (b && typeof b === 'object' && typeof b.text === 'string') {
                const i = b.text.indexOf('你的分工：')
                if (i >= 0) {
                  taskLabel = b.text.slice(i + 5).split('\n')[0].trim().slice(0, 80)
                  break
                }
              }
            }
          }
          if (taskLabel) break
        }
      }
      let status
      if (lastEnd >= 0 && lastEnd >= lastStart) {
        status = (reason === 'error' || reason === 'blocked' || reason === 'cancelled' || reason.indexOf('fail') >= 0) ? 'failed' : 'done'
      } else if (lastStart > lastEnd) {
        status = 'running'
      } else {
        status = liveAgents[id] ? 'waiting' : 'idle'
      }
      if (cold && (status === 'done' || status === 'failed' || status === 'idle')) statusCache.set(id, status)
      if (cold && taskLabel) labelCache.set(id, taskLabel)
      return { status, taskLabel }
    }
    const statusOfSession = async (id) => (await sessionScan(id)).status

    const withTimeout = (p, ms) => Promise.race([
      Promise.resolve(p).catch(() => undefined),
      new Promise((resolve) => setTimeout(() => resolve(undefined), ms)),
    ])
    if (!rootId) {
      // 演示树:逐节点下发;流式路由附带 stagger 逐帧呈现逐节点构建的效果
      emit({ type: 'init', demo: true, rootId: 'demo-root', rootTitle: '编排队长（演示）', note: '未指定会话，展示演示编排' })
      const demoNodes = [{ id: 'demo-root', parentId: '', kind: 'leader', label: '编排队长（演示）', status: 'done' }].concat(DEMO_TREE)
      for (const n of demoNodes) {
        emit({ type: 'nodes', nodes: [n] })
        if (staggerMs > 0) await sleep(staggerMs)
      }
      emit({ type: 'done' })
      return
    }
    // ── init + 队长:立即可见(不等待血缘/工作流/状态扫描) ──
    emit({ type: 'init', demo: false, rootId, rootTitle: titleOf(rootId) || '主 Agent（队长）', note: '' })
    const provisional = liveAgents[rootId] ? 'waiting' : 'idle'
    const leaderLabel = titleOf(rootId) || '主 Agent（队长）'
    emit({ type: 'nodes', nodes: [{ id: rootId, parentId: '', kind: 'leader', label: leaderLabel, status: provisional }] })
    // 队长状态后台解析:完成后更新队长;若汇总报告此刻已出现则一并更新。
    // 队长与成员的语义区分:成员「已结束回合」= 已产出结果(done);
    // 队长在回合之间仍是活体会话,显示 waiting(等待下一步指示)。
    const reportStatusOf = (raw) => (raw === 'done' ? 'done' : raw === 'running' ? 'running' : 'waiting')
    let reportEmitted = false
    let resolvedRoot = null
    const rootStatusPromise = (async () => {
      const raw = (await withTimeout(statusOfSession(rootId), 8000)) || provisional
      resolvedRoot = { raw }
      const rootStatus = raw === 'done' && liveAgents[rootId] ? 'waiting' : raw
      emit({ type: 'update', nodes: [{ id: rootId, status: rootStatus }] })
      if (reportEmitted) emit({ type: 'update', nodes: [{ id: 'report:' + rootId, status: reportStatusOf(raw) }] })
    })()
    // ── 血缘拓扑:listDescendants 一返回就逐个下发(占位状态,扫描完成后逐个更新) ──
    const entriesPromise = (async () => {
      if (!subagents || typeof subagents.listDescendants !== 'function') return []
      try { return (await withTimeout(subagents.listDescendants(rootId), 8000)) || [] } catch (e) { logErr('listDescendants', e); return [] }
    })()
    const wfPromise = foldWfForRoot(rootId)
    const entries = await entriesPromise
    const arch = archivedIds()
    const nodes = []
    const descIds = new Set()
    for (const e of entries) {
      if (!e || typeof e !== 'object') continue
      const id = str(e.id) || str(e.sessionId)
      if (!id) continue
      if (arch.has(id) || descIds.has(id)) continue
      descIds.add(id)
      nodes.push({
        id,
        parentId: str(e.parentId) || rootId,
        kind: 'agent',
        label: str(e.label, 80),
        mode: str(e.mode, 24),
        status: liveAgents[id] ? 'waiting' : 'idle', // 占位:真实状态由扫描完成后逐个 update
      })
    }
    // 父节点不在树内（归档/过滤）的条目挂回主流程，不允许游离成独立树
    for (const n of nodes) {
      if (n.parentId !== rootId && !descIds.has(n.parentId)) n.parentId = rootId
    }
    // 逐节点下发拓扑(画布随到随显),随后逐个解析真实状态并发 update
    for (const n of nodes) emit({ type: 'nodes', nodes: [n] })
    // 有血缘后代 ⇒ 必有汇点:立即下发汇总报告(占位状态,队长状态解析完成后 update)。
    // 不必等待工作流折叠 —— 折叠只影响成员形态,不影响"有没有流程"。
    if (nodes.length > 0) {
      emit({ type: 'nodes', nodes: [{ id: 'report:' + rootId, kind: 'report', label: '汇总报告', status: resolvedRoot ? reportStatusOf(resolvedRoot.raw) : 'waiting' }] })
      reportEmitted = true
    }
    // titledIds:标题修复一旦下发,「你的分工」标签就不得再覆盖它(流式乱序保护)
    const titledIds = new Set()
    const scanPromises = nodes.map((n) => (async () => {
      try {
        // 状态对齐:以每个子会话的真实事件序列解析(与实际对话结果一致)
        const scan = await withTimeout(sessionScan(n.id), 8000)
        const patch = { id: n.id, status: (scan && scan.status) || (liveAgents[n.id] ? 'waiting' : 'idle') }
        // 用「你的分工:」完整文本修复截断标签(标题已修复则让位)
        if (scan && scan.taskLabel && !titledIds.has(n.id)) patch.label = scan.taskLabel
        emit({ type: 'update', nodes: [patch] })
      } catch (e) { emit({ type: 'update', nodes: [{ id: n.id, status: liveAgents[n.id] ? 'waiting' : 'idle' }] }) }
    })())
    const wfRuns = await wfPromise
    const memberIds = {}
    const wfNodes = []
    for (const r of wfRuns) {
      const runId = 'wf:' + r.id
      wfNodes.push({ id: runId, parentId: rootId, kind: 'workflow', label: r.name, status: r.status })
      const phases = {}
      for (const m of r.members) {
        if (m.childId) memberIds[m.childId] = true
        const key = m.phase === undefined || m.phase === null ? '__none__' : String(m.phase).slice(0, 40)
        const arr = phases[key] || (phases[key] = [])
        arr.push(m)
      }
      let pi = 0
      for (const key of Object.keys(phases)) {
        const phId = runId + ':p' + (pi++)
        const ms = phases[key]
        const hasRun = ms.some((m) => m.status === 'running')
        const hasFail = ms.some((m) => m.status === 'failed' || m.status === 'cancelled')
        wfNodes.push({ id: phId, parentId: runId, kind: 'phase', label: key === '__none__' ? '未分组' : key, status: hasRun ? 'running' : hasFail ? 'fail' : 'done' })
        for (const m of ms) {
          wfNodes.push({ id: runId + ':m' + m.seq, parentId: phId, kind: 'member', label: m.label, status: m.status === 'cancelled' ? 'fail' : m.status, sessionId: m.childId })
        }
      }
    }
    const filtered = nodes.filter((n) => !(n.kind === 'agent' && memberIds[n.id]))
    // 被工作流折叠的血缘节点:已提前下发,此处补 remove 事件让客户端移除
    const suppressed = nodes.filter((n) => n.kind === 'agent' && memberIds[n.id]).map((n) => n.id)
    if (suppressed.length) emit({ type: 'remove', ids: suppressed })
    for (const n of wfNodes) emit({ type: 'nodes', nodes: [n] })
    const all = filtered.concat(wfNodes)
    if (filtered.length && sessionQuery && typeof sessionQuery.readTitleSnapshots === 'function') {
      try {
        const res = await sessionQuery.readTitleSnapshots(filtered.map((n) => n.id))
        if (Array.isArray(res)) {
          const byId = {}
          for (const r of res) {
            if (!r || typeof r !== 'object') continue
            const rid = str(r.sessionId) || str(r.id)
            if (rid) byId[rid] = r
          }
          for (const n of filtered) {
            const r = byId[n.id]
            if (r && typeof r.title === 'string' && r.title) {
              // 会话标题优先于派发时的截断标签（消除"团队…"类截断文字）；
              // titledIds 保证标题在流式乱序更新中始终压过「你的分工」标签
              const t = r.title.slice(0, 40)
              titledIds.add(n.id)
              emit({ type: 'update', nodes: [{ id: n.id, label: t, title: t }] })
            }
          }
        }
      } catch (e) { logErr('titles', e) }
    }
    // 汇总报告（汇点）——有血缘后代时已随拓扑立即下发;此处覆盖"仅工作流"场景。
    // 汇总报告是汇点：不设 parentId，由客户端把所有执行叶节点 fan-in 到它，
    // 作为流程终止点收口（子 Agent 并行/串行执行 → 最终汇总节点收尾）。
    const hasFlow = all.length > 0
    if (hasFlow && !reportEmitted) {
      emit({ type: 'nodes', nodes: [{ id: 'report:' + rootId, kind: 'report', label: '汇总报告', status: resolvedRoot ? reportStatusOf(resolvedRoot.raw) : 'waiting' }] })
      reportEmitted = true
    }
    // 计划引擎层:本会话存在 dsh-team-plan 状态文件时,叠加 engine/plan/worker/verifier
    // 节点与重试环(retryTo 字段由客户端渲染为红色虚线回边)——逐个读取、逐个下发
    const planCandidates = [rootId].concat(entries.map((e) => str(e.id) || str(e.sessionId)).filter(Boolean))
    await loadPlanLayer(rootId, planCandidates, (node) => emit({ type: 'nodes', nodes: [node] }))
    // 等全部状态更新落地后收口(每个扫描 8s 上限、并行执行;拓扑早已可见)
    await Promise.all(scanPromises.concat([rootStatusPromise]))
    emit({ type: 'done' })
  }

  /** /data 快照:复用 buildCanvas,把增量事件聚合成与旧版一致的完整响应。 */
  const fetchData = async (rootId) => {
    const meta = { demo: false, rootId: undefined, rootTitle: '编排会话', note: '', nodes: [] }
    const map = new Map()
    const order = []
    const clean = (obj) => {
      const out = {}
      for (const k of Object.keys(obj)) { if (obj[k] !== undefined) out[k] = obj[k] }
      return out
    }
    const emit = (ev) => {
      if (ev.type === 'init') {
        meta.demo = ev.demo === true
        meta.rootId = ev.rootId
        meta.rootTitle = ev.rootTitle || '编排会话'
        meta.note = ev.note || ''
      } else if (ev.type === 'nodes') {
        for (const raw of ev.nodes) {
          if (!raw || !raw.id) continue
          const prev = map.get(raw.id)
          map.set(raw.id, { ...(prev || {}), ...clean(raw) })
          if (!prev) order.push(raw.id)
        }
      } else if (ev.type === 'update') {
        for (const raw of ev.nodes) {
          if (!raw || !raw.id || !map.has(raw.id)) continue
          map.set(raw.id, { ...map.get(raw.id), ...clean(raw) })
        }
      } else if (ev.type === 'remove') {
        const s = new Set(ev.ids || [])
        for (const id of s) map.delete(id)
      }
    }
    await buildCanvas(rootId, emit, 0)
    meta.nodes = order.filter((id) => map.has(id)).map((id) => map.get(id))
    return meta
  }

  const mapEvents = (events) => {
    const lines = []
    const stats = { turns: 0, steps: 0, tools: 0 }
    let bufThink = ''
    let bufText = ''
    let lastTime = ''
    const flush = () => {
      if (bufThink) lines.push({ time: lastTime, icon: '💭', text: snip(bufThink.trim(), 200), level: 'think' })
      if (bufText) lines.push({ time: lastTime, icon: '💬', text: snip(bufText.trim(), 200), level: 'reply' })
      bufThink = ''
      bufText = ''
    }
    for (const ev of events) {
      if (!ev || typeof ev !== 'object' || typeof ev.type !== 'string') continue
      const t = ev.type
      const d = ev.data && typeof ev.data === 'object' ? ev.data : {}
      lastTime = fmtTime(ev.time)
      if (t === 'turn/start') { flush(); stats.turns += 1; lines.push({ time: lastTime, icon: '🚩', text: '回合 #' + d.turn + ' 开始', level: 'turn' }) }
      else if (t === 'user/message') { flush(); const src = d.source; lines.push({ time: lastTime, icon: '📥', text: (src === 'user' ? '用户输入：' : '上下文注入：') + snip(extractText(d.content).join(' '), 110), level: 'turn' }) }
      else if (t === 'step/start') { flush(); stats.steps += 1; lines.push({ time: lastTime, icon: '💭', text: '开始思考（回合 #' + d.turn + ' · 步骤 #' + d.step + '）', level: 'step' }) }
      else if (t === 'assistant/chunk') {
        const c = d.chunk && typeof d.chunk === 'object' ? d.chunk : {}
        const isThink = c.type === 'thinking' || c.type === 'reasoning'
        const text = typeof c.delta === 'string' ? c.delta : (typeof c.text === 'string' ? c.text : (typeof c.content === 'string' ? c.content : ''))
        if (isThink) bufThink += text
        else bufText += text
      }
      else if (t === 'assistant/message') { if (!bufText && !bufThink) bufText += extractText(d.message).join(' ') }
      else if (t === 'tool/call') { flush(); stats.tools += 1; let desc = ''; try { const arg = typeof d.arguments === 'string' ? JSON.parse(d.arguments) : undefined; if (arg && typeof arg === 'object') desc = Object.keys(arg).slice(0, 2).map((k) => k + '=' + snip(valTxt(arg[k]), 16)).join(', '); else if (typeof arg === 'string') desc = snip(arg, 36) } catch (e) { desc = snip(d.arguments, 36) } lines.push({ time: lastTime, icon: '🔧', text: '调用工具 ' + d.name + (desc ? '（' + desc + '）' : ''), level: 'tool' }) }
      else if (t === 'tool/result') { const err = d.error; lines.push({ time: lastTime, icon: err ? '❌' : '✅', text: err ? '工具失败（' + (err.code || err.name || 'error') + '）' : '工具完成', level: err ? 'fail' : 'ok' }) }
      else if (t === 'tool-workflow/run-start') { flush(); lines.push({ time: lastTime, icon: '🚀', text: '工作流启动：' + snip(d.name, 60), level: 'agent' }) }
      else if (t === 'tool-workflow/agent-start') { flush(); lines.push({ time: lastTime, icon: '🤖', text: '派发成员：' + snip(d.label, 60), level: 'agent' }) }
      else if (t === 'tool-workflow/agent-end') { lines.push({ time: lastTime, icon: d.outcome === 'failed' ? '❌' : '✅', text: '成员结束：' + snip(d.label, 60) + '（' + (d.outcome || '') + '）', level: d.outcome === 'failed' ? 'fail' : 'ok' }) }
      else if (t === 'tool-workflow/run-end') { lines.push({ time: lastTime, icon: '🏁', text: '工作流结束：' + (d.stopReason || ''), level: 'turn' }) }
      else if (t === 'todo/write') { lines.push({ time: lastTime, icon: '📋', text: '任务清单更新（' + (Array.isArray(d.todos) ? d.todos.length : 0) + ' 项）', level: 'step' }) }
      else if (t === 'turn/end') { flush(); const reasonText = typeof d.reason === 'object' && d.reason !== null ? snip(JSON.stringify(d.reason), 30) : String(d.reason === undefined ? '' : d.reason); lines.push({ time: lastTime, icon: '🏁', text: '回合 #' + d.turn + ' 结束 · ' + reasonText, level: 'turn' }) }
    }
    flush()
    return { lines: lines.slice(-90), stats }
  }

  const fetchDetail = async (rootId, node) => {
    const nowLine = () => { const d = new Date(); const p = (n) => (n < 10 ? '0' : '') + n; return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()) }
    const sessionQuery = ctx.get('sessionQuery')
    if (!node || !sessionQuery || typeof sessionQuery.readSession !== 'function') {
      const t0 = nowLine()
      return {
        demo: true,
        title: node && node.label ? node.label : '演示节点',
        status: node && node.status ? node.status : 'running',
        stats: { turns: 1, steps: 1, tools: 1 },
        lines: [
          { time: t0, icon: '🚩', text: '回合 #1 开始', level: 'turn' },
          { time: t0, icon: '📥', text: '用户输入：从性能和体验两个角度检查这次改动', level: 'turn' },
          { time: t0, icon: '💭', text: '模型思考：任务可拆为两个独立子任务，适合并行执行…', level: 'think' },
          { time: t0, icon: '🔧', text: '调用工具 bash（git diff --stat）', level: 'tool' },
          { time: t0, icon: '✅', text: '工具完成', level: 'ok' },
          { time: t0, icon: '🤖', text: '派发子代理：性能分析', level: 'agent' },
          { time: t0, icon: '🏁', text: '回合 #1 结束 · end_turn', level: 'turn' },
        ],
      }
    }
    const sessions = ctx.get('sessions')
    const kind = node.kind
    let sessionId
    if (typeof node.sessionId === 'string' && node.sessionId) sessionId = node.sessionId
    else if ((kind === 'agent' || kind === 'leader') && typeof node.id === 'string') sessionId = node.id
    else if (kind === 'report' && rootId) sessionId = rootId // 汇总节点：展示主 Agent 的收口回合
    let runIdMatch
    if ((kind === 'workflow' || kind === 'phase') && typeof node.id === 'string') {
      if (node.id.indexOf('wf:') === 0) runIdMatch = node.id.slice(3).split(':p')[0]
    }
    const events = []
    try {
      const target = sessionId || rootId
      if (target) {
        let live = null
        try { live = sessions && sessions.get(target) } catch (e) {}
        if (live && Array.isArray(live.events)) {
          for (const ev of live.events) {
            if (runIdMatch) {
              if (typeof ev.type !== 'string' || ev.type.indexOf('tool-workflow/') !== 0) continue
              const d = ev.data && typeof ev.data === 'object' ? ev.data : {}
              if (String(d.runId) !== runIdMatch) continue
            }
            events.push(ev)
          }
        } else {
          const snap = await sessionQuery.readSession(target)
          if (snap && Array.isArray(snap.events)) {
            for (const ev of snap.events.slice(-800)) {
              if (!ev || typeof ev !== 'object' || typeof ev.type !== 'string') continue
              if (runIdMatch) {
                if (ev.type.indexOf('tool-workflow/') !== 0) continue
                const d = ev.data && typeof ev.data === 'object' ? ev.data : {}
                if (String(d.runId) !== runIdMatch) continue
              }
              events.push(ev)
            }
          }
        }
      }
    } catch (e) { logErr('detail read', e) }
    let mapped
    try { mapped = mapEvents(events) } catch (e) { mapped = { lines: [], stats: { turns: 0, steps: 0, tools: 0 } } }
    if (kind === 'member' && (!mapped.lines || !mapped.lines.length) && rootId) {
      try {
        const runs = await foldWfForRoot(rootId)
        let mSeq
        if (typeof node.id === 'string') {
          const i = node.id.indexOf(':m')
          if (i >= 0) mSeq = node.id.slice(i + 2)
        }
        const runIdRaw = runIdMatch || (typeof node.id === 'string' && node.id.indexOf('wf:') === 0 ? node.id.slice(3).split(':')[0] : undefined)
        for (const r of runs) {
          if (String(r.id) !== String(runIdRaw)) continue
          const member = r.members.find((m) => String(m.seq) === String(mSeq))
          const fb = []
          fb.push({ time: '', icon: '🚀', text: '工作流启动：' + snip(r.name, 50), level: 'agent' })
          fb.push({ time: '', icon: '🤖', text: '派发成员：' + snip(member ? member.label : (node.label || ''), 50), level: 'agent' })
          fb.push({ time: '', icon: member && (member.status === 'failed' || member.status === 'cancelled') ? '❌' : '✅', text: '成员结束：' + snip(member ? member.label : (node.label || ''), 50) + '（' + (member ? member.status : '') + '）', level: member && member.status === 'failed' ? 'fail' : 'ok' })
          fb.push({ time: '', icon: 'ℹ️', text: '该子会话无独立执行日志，以上为编排层记录', level: 'turn' })
          mapped = { lines: fb, stats: { turns: 0, steps: 0, tools: 0 } }
          break
        }
      } catch (e) {}
    }
    const out = { demo: false, title: node.label || '', status: node.status || '', stats: mapped.stats, lines: mapped.lines }
    if (sessionId) out.sessionId = sessionId
    return out
  }

  // ---- HTTP routes (client↔host channel) ----
  const json = (res, payload, code = 200) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(payload))
  }

  // 同源防护：拒绝跨站浏览器请求（CSRF / DNS rebinding 缓解）。
  // 非浏览器客户端（curl 等）不携带 sec-fetch-site，按同机放行。
  const isCrossSite = (req) => !!(req.headers && req.headers['sec-fetch-site'] === 'cross-site')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/plugins/dsh-agent-orchestration/data',
    handler: async (req, res) => {
      if (isCrossSite(req)) { json(res, { error: 'forbidden' }, 403); return }
      try {
        const url = new URL(req.url ?? '/', 'http://x')
        const rootId = url.searchParams.get('root') || undefined
        json(res, await fetchData(rootId))
      } catch (e) { json(res, { error: String((e && e.message) || e) }, 500) }
    },
  }), 'orchestration-host: data route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/plugins/dsh-agent-orchestration/stream',
    handler: async (req, res) => {
      if (isCrossSite(req)) { json(res, { error: 'forbidden' }, 403); return }
      if (req.method !== 'GET') { json(res, { error: 'method not allowed' }, 405); return }
      const url = new URL(req.url ?? '/', 'http://x')
      const rootId = url.searchParams.get('root') || undefined
      // NDJSON 流式响应:每行一个事件(init/nodes/update/remove/done),':hb' 心跳注释行保活
      res.writeHead(200, {
        'content-type': 'application/x-ndjson; charset=utf-8',
        'cache-control': 'no-store',
        'x-accel-buffering': 'no',
      })
      if (typeof res.flushHeaders === 'function') { try { res.flushHeaders() } catch (e) {} }
      let closed = false
      const onClose = () => { closed = true }
      req.on('close', onClose)
      const hb = setInterval(() => {
        if (!closed && !res.writableEnded && !res.destroyed) { try { res.write(':hb\n') } catch (e) {} }
      }, 4000)
      const CLOSED = Symbol('stream-closed')
      const emit = (ev) => {
        if (closed || res.writableEnded || res.destroyed) throw CLOSED
        res.write(JSON.stringify(ev) + '\n')
      }
      try {
        await buildCanvas(rootId, emit, 60)
      } catch (e) {
        if (e !== CLOSED && !closed && !res.writableEnded && !res.destroyed) {
          try { res.write(JSON.stringify({ type: 'error', message: String((e && e.message) || e) }) + '\n') } catch (e2) {}
        }
      } finally {
        clearInterval(hb)
        req.off('close', onClose)
        if (!res.writableEnded) { try { res.end() } catch (e) {} }
      }
    },
  }), 'orchestration-host: stream route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/plugins/dsh-agent-orchestration/detail',
    handler: async (req, res) => {
      if (isCrossSite(req)) { json(res, { error: 'forbidden' }, 403); return }
      try {
        const url = new URL(req.url ?? '/', 'http://x')
        const rootId = url.searchParams.get('root') || undefined
        const node = JSON.parse(url.searchParams.get('node') || 'null')
        json(res, await fetchDetail(rootId, node))
      } catch (e) { json(res, { error: String((e && e.message) || e) }, 500) }
    },
  }), 'orchestration-host: detail route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/plugins/dsh-agent-orchestration/team-mode',
    handler: async (req, res) => {
      if (isCrossSite(req)) { json(res, { error: 'forbidden' }, 403); return }
      try {
        // 团队模式状态快照：本路由只在 config.teamMode === true 时注册，
        // 所以能访问到就等价于「团队模式已开启」。
        if (req.method !== 'GET') { json(res, { error: 'method not allowed' }, 405); return }
        // 会话级判定：客户端传入 ?session=<会话ID> 时，按该会话真实挂载的
        // 预设回答（team 预设 ⇒ true；其它预设 ⇒ false）。这是对「常驻挂载
        // 进程级可见」的收口——某个团队会话激活后，其它模式的页面也不会
        // 展示画布入口。会话未找到/未传时保守返回 false（无法验证则不展示）。
        const url = new URL(req.url ?? '/', 'http://x')
        const sid = url.searchParams.get('session') || undefined
        let teamMode = true
        let source = 'preset'
        if (sid) {
          source = 'session-preset'
          teamMode = false
          const agents = ctx.get('agents')
          const agentPresets = ctx.get('agentPresets')
          const agent = agents && typeof agents.get === 'function' ? agents.get(sid) : undefined
          const preset = agent && agent.ctx && agentPresets && typeof agentPresets.composedPreset === 'function'
            ? agentPresets.composedPreset(agent.ctx)
            : undefined
          if (preset === 'team') teamMode = true
        }
        json(res, { teamMode, source })
      } catch (e) { json(res, { error: String((e && e.message) || e) }, 500) }
    },
  }), 'orchestration-host: team-mode route')

  console.log('orchestration-host: canvas routes registered (/data /detail /stream /team-mode) — 团队模式 ON')
}
