/**
 * 画布增量流式构建协议测试（v2.2）：
 *  用 fake ctx 挂载 index.js（teamMode: true），直接驱动 /stream 与 /data 两个路由，
 *  验证逐节点 NDJSON 下发顺序、增量事件语义（nodes/update/remove/done）与聚合快照一致性。
 * 运行：node --test test/stream.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../index.js'
import { applyNodeEvents, removeNodes, sigOf } from '../src/nodes-merge.js'

/* ── fake 服务与 mock ctx ── */
const mkSessions = (map) => ({ get: (id) => (map && map[id] ? map[id] : null) })

const mkCtx = (services) => ({
  get(name) { return services[name] },
  effect(fn) {
    const d = fn()
    return typeof d === 'function' ? d : () => {}
  },
  webServer: {
    _routes: {},
    register(route) {
      this._routes[route.path] = route
      return () => { delete this._routes[route.path] }
    },
  },
})

/** 运行 /stream 路由,收集全部写出行,解析为事件数组 */
const runStream = async (ctx, url) => {
  const route = ctx.webServer._routes['/plugins/dsh-agent-orchestration/stream']
  assert.ok(route, 'stream route registered')
  const lines = []
  const res = {
    writeHead() {},
    flushHeaders() {},
    write(chunk) { lines.push(String(chunk)) },
    end() {},
    writableEnded: false,
    destroyed: false,
  }
  await route.handler({ method: 'GET', url, on() {}, off() {} }, res)
  const evs = []
  for (const line of lines) {
    if (!line || line.startsWith(':')) continue // 跳过心跳注释行
    evs.push(JSON.parse(line.trim()))
  }
  return evs
}

/** 运行 /data 路由,取完整快照 */
const runData = async (ctx, url) => {
  const route = ctx.webServer._routes['/plugins/dsh-agent-orchestration/data']
  assert.ok(route, 'data route registered')
  let payload
  const res = { writeHead() {}, end(body) { payload = JSON.parse(body) } }
  await route.handler({ method: 'GET', url }, res)
  return payload
}

const baseServices = (overrides) => ({
  sessions: mkSessions({}),
  agents: { list: () => [] },
  subagents: { listDescendants: async () => [] },
  sessionQuery: {
    listEvents: async () => [],
    readSession: async () => ({ events: [] }),
    readTitleSnapshots: async (ids) => ids.map((id) => ({ sessionId: id, title: 'T-' + id })),
  },
  sessionTitle: { get: () => undefined },
  workspaceRegistry: { archivedSessionIds: [] },
  ...overrides,
})

test('stream: init → 队长 → 血缘后代逐个 → 状态 update → 汇总报告 → done', async () => {
  const services = baseServices({
    subagents: { listDescendants: async () => [
      { id: 'a-1', parentId: 'root-1', label: 'L1', mode: 'spawn' },
      { id: 'a-2', parentId: 'root-1', label: 'L2', mode: 'spawn' },
      { id: 'a-3', parentId: 'root-1', label: 'L3', mode: 'continuable' },
    ] },
  })
  const ctx = mkCtx(services)
  apply(ctx, { teamMode: true })

  const evs = await runStream(ctx, '/plugins/dsh-agent-orchestration/stream?root=root-1')

  // 1) 首事件 init,次事件即队长节点 —— 不等待血缘树构建
  assert.equal(evs[0].type, 'init')
  assert.equal(evs[0].demo, false)
  assert.equal(evs[0].rootId, 'root-1')
  assert.equal(evs[1].type, 'nodes')
  assert.equal(evs[1].nodes[0].kind, 'leader')
  assert.equal(evs[1].nodes[0].id, 'root-1')

  // 2) nodes 事件逐个下发、顺序与派发顺序一致(leader → a-1..a-3 → report)
  const nodeIds = evs.filter((e) => e.type === 'nodes').flatMap((e) => e.nodes).map((n) => n.id)
  assert.deepEqual(nodeIds, ['root-1', 'a-1', 'a-2', 'a-3', 'report:root-1'])

  // 3) 每个血缘节点都收到 update(标题修复 → label 变为 T-*),update 不新增节点
  const updated = new Set(evs.filter((e) => e.type === 'update').flatMap((e) => e.nodes).map((n) => n.id))
  assert.ok(updated.has('a-1') && updated.has('a-2') && updated.has('a-3'))
  assert.ok(updated.has('root-1'))

  // 4) 收口事件 done
  assert.equal(evs[evs.length - 1].type, 'done')

  // 5) /data 聚合快照与旧版语义一致:leader + 3 后代 + report,标题修复生效,状态已填充
  const data = await runData(ctx, '/plugins/dsh-agent-orchestration/data?root=root-1')
  assert.equal(data.demo, false)
  assert.equal(data.nodes.length, 5)
  const a1 = data.nodes.find((n) => n.id === 'a-1')
  assert.equal(a1.label, 'T-a-1')
  assert.equal(a1.status, 'idle')
  assert.equal(data.nodes.find((n) => n.id === 'report:root-1').status, 'waiting')
})

test('stream: 工作流成员折叠 → remove 事件移除对应血缘节点,聚合快照一致', async () => {
  const services = baseServices({
    sessions: mkSessions({
      'root-wf': {
        seq: 1,
        events: [
          { type: 'tool-workflow/run-start', data: { runId: 'w1', name: '测试流' } },
          { type: 'tool-workflow/agent-start', data: { runId: 'w1', seq: 1, label: '成员一', phase: 'P1', childId: 'a-1' } },
          { type: 'tool-workflow/agent-end', data: { runId: 'w1', seq: 1, outcome: 'completed' } },
          { type: 'tool-workflow/run-end', data: { runId: 'w1', stopReason: 'done' } },
        ],
      },
      'a-1': { events: [] },
      'a-2': { events: [] },
    }),
    subagents: { listDescendants: async () => [
      { id: 'a-1', parentId: 'root-wf', label: 'L1', mode: 'spawn' },
      { id: 'a-2', parentId: 'root-wf', label: 'L2', mode: 'spawn' },
    ] },
  })
  const ctx = mkCtx(services)
  apply(ctx, { teamMode: true })

  const evs = await runStream(ctx, '/plugins/dsh-agent-orchestration/stream?root=root-wf')

  // remove 事件:a-1 被工作流成员折叠
  const rem = evs.find((e) => e.type === 'remove')
  assert.ok(rem, 'remove event emitted')
  assert.deepEqual(rem.ids, ['a-1'])

  // 工作流子树出现,a-1 不再作为独立血缘节点存在,a-2 保留
  const nodeIds = evs.filter((e) => e.type === 'nodes').flatMap((e) => e.nodes).map((n) => n.id)
  assert.ok(nodeIds.includes('wf:w1'))
  assert.ok(nodeIds.includes('wf:w1:p0'))
  assert.ok(nodeIds.includes('wf:w1:m1'))
  assert.ok(nodeIds.includes('a-2'))
  assert.ok(nodeIds.includes('report:root-wf'))

  // 聚合快照与流式终态一致
  const data = await runData(ctx, '/plugins/dsh-agent-orchestration/data?root=root-wf')
  assert.equal(data.nodes.find((n) => n.id === 'a-1'), undefined)
  const member = data.nodes.find((n) => n.id === 'wf:w1:m1')
  assert.ok(member)
  assert.equal(member.status, 'completed')
  assert.equal(member.sessionId, 'a-1')
})

test('stream demo: 无 root 时逐节点演示(带 stagger)并收口 done', async () => {
  const services = baseServices({})
  const ctx = mkCtx(services)
  apply(ctx, { teamMode: true })

  const t0 = Date.now()
  const evs = await runStream(ctx, '/plugins/dsh-agent-orchestration/stream')
  const elapsed = Date.now() - t0

  assert.equal(evs[0].type, 'init')
  assert.equal(evs[0].demo, true)
  const nodeIds = evs.filter((e) => e.type === 'nodes').flatMap((e) => e.nodes).map((n) => n.id)
  assert.equal(nodeIds.length, 11) // demo-root + DEMO_TREE(10)
  assert.equal(nodeIds[0], 'demo-root')
  assert.equal(evs[evs.length - 1].type, 'done')
  assert.ok(elapsed >= 500, 'demo stagger 生效(10×60ms)')
})

test('/data 快照与旧版字段一致:状态解析(事件序列)与「你的分工」标签修复', async () => {
  const services = baseServices({
    sessions: mkSessions({
      'a-1': {
        events: [
          { type: 'user/message', data: { content: [{ type: 'text', text: '你的分工：修复登录超时问题\n并跑回归' }] } },
          { type: 'turn/start', data: { turn: 1 } },
          { type: 'turn/end', data: { turn: 1, reason: {} } },
        ],
      },
      'a-2': {
        events: [
          { type: 'turn/start', data: { turn: 1 } },
        ],
      },
    }),
    subagents: { listDescendants: async () => [
      { id: 'a-1', parentId: 'root-2', label: '旧标签', mode: 'spawn' },
      { id: 'a-2', parentId: 'root-2', label: '旧标签2', mode: 'spawn' },
    ] },
  })
  const ctx = mkCtx(services)
  apply(ctx, { teamMode: true })

  const data = await runData(ctx, '/plugins/dsh-agent-orchestration/data?root=root-2')
  const a1 = data.nodes.find((n) => n.id === 'a-1')
  const a2 = data.nodes.find((n) => n.id === 'a-2')
  // 标题修复(T-a-1)压过「你的分工」标签 —— 与旧版优先级一致
  assert.equal(a1.label, 'T-a-1')
  assert.equal(a1.status, 'done') // turn/end 晚于 turn/start,reason 空 → done
  assert.equal(a2.label, 'T-a-2')
  assert.equal(a2.status, 'running') // 有未结束的 turn/start → running
})

test('客户端合并纯函数:逐个到达追加、update 原位更新、remove 剔除、同签名零渲染', () => {
  // 逐个 nodes 事件到达 → 按到达顺序追加(画布随到随显)
  let state = []
  const leader = { id: 'root', parentId: '', kind: 'leader', label: '队长', status: 'idle' }
  const a1 = { id: 'a-1', parentId: 'root', kind: 'agent', label: 'L1', mode: 'spawn', status: 'idle' }
  const a2 = { id: 'a-2', parentId: 'root', kind: 'agent', label: 'L2', mode: 'spawn', status: 'idle' }
  state = applyNodeEvents(state, 'nodes', [leader])
  state = applyNodeEvents(state, 'nodes', [a1])
  state = applyNodeEvents(state, 'nodes', [a2])
  assert.deepEqual(state.map((n) => n.id), ['root', 'a-1', 'a-2'])

  // update 只覆盖已定义字段且不挪位置
  const a1Ref = state[1]
  state = applyNodeEvents(state, 'update', [{ id: 'a-1', status: 'running' }])
  assert.equal(state.map((n) => n.id).join(','), 'root,a-1,a-2')
  assert.equal(state[1].status, 'running')
  assert.equal(state[1].label, 'L1') // 未定义字段保留
  assert.notEqual(state[1], a1Ref) // 内容变化 → 换新对象(仅该节点重渲染)

  // 同签名重复到达 → 返回原数组引用(零渲染)
  const before = state
  state = applyNodeEvents(state, 'nodes', [{ id: 'a-1', parentId: 'root', kind: 'agent', label: 'L1', mode: 'spawn', status: 'running' }])
  assert.equal(state, before)

  // remove:工作流折叠剔除节点;无命中时返回原引用
  const beforeRm = state
  state = removeNodes(state, ['a-1'])
  assert.deepEqual(state.map((n) => n.id), ['root', 'a-2'])
  assert.equal(removeNodes(state, ['nope']), state)
  assert.equal(removeNodes(beforeRm, []), beforeRm)

  // 早到的 update(节点尚未存在)按拓扑语义容错:以 patch 为准追加
  const early = applyNodeEvents([], 'update', [{ id: 'x', status: 'waiting' }])
  assert.deepEqual(early.map((n) => n.id), ['x'])
  assert.ok(sigOf(early[0]))
})

test('stream 时序:慢扫描(冷会话读取)不阻塞拓扑 —— 节点逐个即时下发,done 等更新落地', async () => {
  // 模拟慢冷会话读取:每个 sessionScan 要 350ms —— 旧版此场景下首屏要等全部扫描完成
  const slowReadSession = () => new Promise((resolve) => setTimeout(() => resolve({ events: [] }), 350))
  const services = baseServices({
    sessionQuery: {
      listEvents: async () => [],
      readSession: slowReadSession,
      readTitleSnapshots: async (ids) => ids.map((id) => ({ sessionId: id, title: 'T-' + id })),
    },
    subagents: { listDescendants: async () => [
      { id: 's-1', parentId: 'root-3', label: 'L1', mode: 'spawn' },
      { id: 's-2', parentId: 'root-3', label: 'L2', mode: 'spawn' },
    ] },
  })
  const ctx = mkCtx(services)
  apply(ctx, { teamMode: true })

  const route = ctx.webServer._routes['/plugins/dsh-agent-orchestration/stream']
  const timed = []
  const res = {
    writeHead() {},
    flushHeaders() {},
    write(chunk) { timed.push({ t: Date.now(), line: String(chunk) }) },
    end() {},
    writableEnded: false,
    destroyed: false,
  }
  const t0 = Date.now()
  await route.handler({ method: 'GET', url: '/plugins/dsh-agent-orchestration/stream?root=root-3', on() {}, off() {} }, res)
  const evs = timed.map((x) => ({ at: x.t - t0, ev: JSON.parse(x.line.trim()) }))

  // 拓扑节点(队长 + 2 后代 + 汇总报告)在慢扫描完成前就已逐个下发
  const nodeLines = evs.filter((x) => x.ev.type === 'nodes')
  assert.equal(nodeLines.length, 4) // leader + s-1 + s-2 + report
  for (const x of nodeLines) {
    assert.ok(x.at < 300, `节点 ${x.ev.nodes[0].id} 在 ${x.at}ms 下发(应远早于 350ms 慢扫描)`)
  }
  // update 事件(状态补齐)在扫描完成后到达
  const updates = evs.filter((x) => x.ev.type === 'update')
  assert.ok(updates.length >= 3)
  for (const x of updates) assert.ok(x.at >= 300)
  // done 收口等待全部更新落地
  const last = evs[evs.length - 1]
  assert.equal(last.ev.type, 'done')
  assert.ok(last.at >= 300)
})
