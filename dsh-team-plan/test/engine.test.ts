import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createState, transition, nextReady, allTerminal, roundsAllowed, abortPlan, type EngineState } from '../src/engine.ts'
import { validatePlan, type Plan } from '../src/schema.ts'

const PLAN_SRC = {
  version: 1,
  goal: '三批计划：A 独立，B 依赖 A，C 独立',
  batches: [
    { id: 'A', title: 'A', prompt: '任务A', deps: [], verify: { criteria: ['cA'], maxRetries: 1 } },
    { id: 'B', title: 'B', prompt: '任务B', deps: ['A'], verify: { criteria: ['cB'], maxRetries: 3 } },
    { id: 'C', title: 'C', prompt: '任务C', deps: [], verify: { criteria: ['cC'], maxRetries: 0 } },
  ],
}
const plan = (validatePlan(PLAN_SRC) as { ok: true; plan: Plan }).plan

let T = 1000
const now = () => ++T
const t = (s: EngineState, ev: Parameters<typeof transition>[1]) => {
  const r = transition(s, ev, now())
  assert.equal(r.ok, true, JSON.stringify(r))
  return (r as { ok: true; state: EngineState }).state
}

test('plan:proposed 初始化批次,进入 running', () => {
  let s = createState('s1', now())
  s = t(s, { type: 'plan:proposed', plan })
  assert.equal(s.phase, 'running')
  assert.deepEqual(Object.values(s.batches).map((b) => b.status), ['pending', 'pending', 'pending'])
})

test('调度:依赖未满足不入队,独立批次并行,上限生效', () => {
  let s = createState('s1', now())
  s = t(s, { type: 'plan:proposed', plan })
  // A、C 无依赖 → 可入队;cap 默认 3 → 两个都 ready
  assert.deepEqual(nextReady(s).sort(), ['A', 'C'])
  s = t(s, { type: 'batch:started', id: 'A', childId: 'cA' })
  s = t(s, { type: 'batch:started', id: 'C', childId: 'cC' })
  // A、C running 后,B 依赖 A 未过 → 不入队
  assert.deepEqual(nextReady(s), [])
  s = t(s, { type: 'batch:output', id: 'A', output: '产出A' })
  s = t(s, { type: 'batch:verify:pass', id: 'A' })
  assert.deepEqual(nextReady(s), ['B'])
})

test('并行上限:cap=2 时第三次入队被压住', () => {
  const p3 = (validatePlan({
    version: 1, goal: 'x', batches: ['A', 'B', 'C'].map((id) => ({ id, title: id, prompt: 'p', deps: [], verify: { criteria: ['c'] } })),
  }) as { ok: true; plan: Plan }).plan
  let s = createState('s1', now())
  s = t(s, { type: 'plan:proposed', plan: p3 })
  assert.equal(nextReady(s, 2).length, 2)
  s = t(s, { type: 'batch:started', id: 'A', childId: 'a' })
  s = t(s, { type: 'batch:started', id: 'B', childId: 'b' })
  assert.deepEqual(nextReady(s, 2), [])
  s = t(s, { type: 'batch:output', id: 'A', output: 'o' })
  s = t(s, { type: 'batch:verify:pass', id: 'A' })
  assert.deepEqual(nextReady(s, 2), ['C'])
})

test('重试回环:fail→ready→重跑,耗尽后 exhausted', () => {
  let s = createState('s1', now())
  s = t(s, { type: 'plan:proposed', plan })
  // C 的 maxRetries=0:一次失败即耗尽
  s = t(s, { type: 'batch:started', id: 'C', childId: 'c1' })
  s = t(s, { type: 'batch:output', id: 'C', output: 'v1' })
  assert.equal(s.batches.C.status, 'verifying')
  s = t(s, { type: 'batch:verify:fail', id: 'C', issues: ['问题1'] })
  assert.equal(s.batches.C.status, 'exhausted') // 0 次重试:首次失败即耗尽
  assert.equal(s.batches.C.attempts, 1)

  // A 的 maxRetries=1:首次失败→ready,重跑后再失败→exhausted
  s = t(s, { type: 'batch:started', id: 'A', childId: 'a1' })
  s = t(s, { type: 'batch:output', id: 'A', output: 'v1' })
  s = t(s, { type: 'batch:verify:fail', id: 'A', issues: ['问题1'] })
  assert.equal(s.batches.A.status, 'ready')
  assert.equal(s.batches.A.attempts, 1)
  s = t(s, { type: 'batch:started', id: 'A', childId: 'a2' })
  s = t(s, { type: 'batch:output', id: 'A', output: 'v2' })
  s = t(s, { type: 'batch:verify:fail', id: 'A', issues: ['问题2'] })
  assert.equal(s.batches.A.status, 'exhausted')
  assert.equal(s.batches.A.attempts, 2)
})

test('worker-error 与 verify:fail 同样消耗一轮', () => {
  let s = createState('s1', now())
  s = t(s, { type: 'plan:proposed', plan })
  s = t(s, { type: 'batch:started', id: 'B', childId: 'b1' })
  s = t(s, { type: 'batch:worker-error', id: 'B', error: '子代理超时' })
  assert.equal(s.batches.B.status, 'ready')
  assert.equal(s.batches.B.attempts, 1)
  assert.equal(s.batches.B.workerError, '子代理超时')
})

test('交付门禁:存在非终态批次时 deliver 被拒绝', () => {
  let s = createState('s1', now())
  s = t(s, { type: 'plan:proposed', plan })
  const r = transition(s, { type: 'deliver' }, now())
  assert.equal(r.ok, false)
})

test('全链路:并行跑通全部批次,失败批次不阻塞交付', () => {
  let s = createState('s1', now())
  s = t(s, { type: 'plan:proposed', plan })
  // C 直接耗尽(0 次重试)
  s = t(s, { type: 'batch:started', id: 'C', childId: 'c' })
  s = t(s, { type: 'batch:output', id: 'C', output: 'x' })
  s = t(s, { type: 'batch:verify:fail', id: 'C', issues: ['坏'] })
  // A 通过
  s = t(s, { type: 'batch:started', id: 'A', childId: 'a' })
  s = t(s, { type: 'batch:output', id: 'A', output: 'ok' })
  s = t(s, { type: 'batch:verify:pass', id: 'A' })
  // B 依赖 A,通过
  s = t(s, { type: 'batch:started', id: 'B', childId: 'b' })
  s = t(s, { type: 'batch:output', id: 'B', output: 'ok' })
  s = t(s, { type: 'batch:verify:pass', id: 'B' })
  assert.equal(allTerminal(s), true)
  assert.equal(s.batches.C.status, 'exhausted') // 失败批次不阻塞
  s = t(s, { type: 'deliver' })
  assert.equal(s.phase, 'delivering')
  s = t(s, { type: 'done' })
  assert.equal(s.phase, 'done')
})

test('确定性:同一事件序列两次执行,状态完全一致', () => {
  const run = () => {
    let s = createState('s1', 5000)
    const evs: Parameters<typeof transition>[1][] = [
      { type: 'plan:proposed', plan },
      { type: 'batch:started', id: 'A', childId: 'a' },
      { type: 'batch:output', id: 'A', output: 'o' },
      { type: 'batch:verify:pass', id: 'A' },
      { type: 'batch:started', id: 'B', childId: 'b' },
      { type: 'batch:output', id: 'B', output: 'o' },
      { type: 'batch:verify:pass', id: 'B' },
      { type: 'batch:started', id: 'C', childId: 'c' },
      { type: 'batch:output', id: 'C', output: 'o' },
      { type: 'batch:verify:fail', id: 'C', issues: ['i'] }, // maxRetries=0 → exhausted
      { type: 'deliver' },
      { type: 'done' },
    ]
    for (const ev of evs) {
      const r = transition(s, ev, 9000)
      assert.equal(r.ok, true, JSON.stringify(r))
      s = (r as { ok: true; state: EngineState }).state
    }
    return s
  }
  assert.deepEqual(run(), run())
})

test('无效迁移不改状态', () => {
  let s = createState('s1', now())
  s = t(s, { type: 'plan:proposed', plan })
  s = t(s, { type: 'batch:started', id: 'A', childId: 'x' })
  const before = JSON.stringify(s)
  const r = transition(s, { type: 'batch:started', id: 'A', childId: 'y' }, now()) // running 中不能重复启动
  assert.equal(r.ok, false)
  assert.equal(JSON.stringify(s), before)
  const r2 = transition(s, { type: 'done' }, now()) // running 阶段不能直接 done
  assert.equal(r2.ok, false)
})

test('roundsAllowed = maxRetries + 1', () => {
  assert.equal(roundsAllowed(0), 1)
  assert.equal(roundsAllowed(3), 4)
})

test('plan:abort:非终态批次→exhausted(用户中止),passed 保留', () => {
  let s = createState('s1', now())
  s = t(s, { type: 'plan:proposed', plan })
  s = t(s, { type: 'batch:started', id: 'A', childId: 'a' })
  s = t(s, { type: 'batch:output', id: 'A', output: 'ok' })
  s = t(s, { type: 'batch:verify:pass', id: 'A' })
  const r = abortPlan(s, now())
  assert.equal(r.ok, true)
  if (r.ok) {
    assert.equal(r.state.batches.A.status, 'passed') // 已通过不受影响
    assert.equal(r.state.batches.B.status, 'exhausted')
    assert.equal(r.state.batches.C.status, 'exhausted')
    assert.equal(r.state.batches.B.workerError, '用户中止')
  }
  // 中止后允许交付
  const d = transition(r.ok ? r.state : s, { type: 'deliver' }, now())
  assert.equal(d.ok, true)
})

test('plan:abort:idle/done 阶段拒绝', () => {
  const s = createState('s1', now())
  assert.equal(abortPlan(s, now()).ok, false)
})
