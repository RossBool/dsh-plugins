import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EngineDriver, renderWorkerPrompt, buildReport, type DriverDeps, type VerifyResult } from '../src/driver.ts'
import { validatePlan, type Plan, type PlanBatch } from '../src/schema.ts'
import type { EngineState } from '../src/engine.ts'

const PLAN = (validatePlan({
  version: 1,
  goal: '两批并行 + 一批依赖',
  batches: [
    { id: 'A', title: '任务A', prompt: '做A', deps: [], verify: { criteria: ['ok'], maxRetries: 1 } },
    { id: 'B', title: '任务B', prompt: '做B,引用 {b.A.output}', deps: ['A'], verify: { criteria: ['ok'], maxRetries: 1 } },
    { id: 'C', title: '任务C', prompt: '做C', deps: [], verify: { criteria: ['ok'], maxRetries: 1 } },
  ],
}) as { ok: true; plan: Plan }).plan

interface Rec { kind: string; [k: string]: unknown }

function makeDeps(verify: (spec: PlanBatch, output: string) => Promise<VerifyResult>) {
  const rec: Rec[] = []
  const counter: Record<string, number> = {}
  let saved: EngineState[] = []
  let t = 1000
  const deps: DriverDeps = {
    now: () => ++t,
    save: async (state) => { saved.push(JSON.parse(JSON.stringify(state))) },
    spawnWorker: async (spec, prompt) => { counter[spec.id] = (counter[spec.id] || 0) + 1; rec.push({ kind: 'spawn', id: spec.id, prompt }); return { childId: 'child-' + spec.id + '-' + counter[spec.id] } },
    verifyBatch: verify,
    log: () => {},
    deliverReport: async (report) => { rec.push({ kind: 'deliver', report }); return true },
  }
  return { deps, rec, saved: () => saved, lastSaved: () => saved[saved.length - 1] }
}

test('propose:依赖满足的批次立即并行派发,依赖未满足等待', async () => {
  const { deps, rec } = makeDeps(async () => ({ verdict: 'PASS' }))
  const d = new EngineDriver('s1', 3, deps)
  await d.propose(PLAN)
  assert.deepEqual(rec.map((r) => r.id), ['A', 'C']) // B 依赖 A,不派发
  assert.equal(d.snapshot?.batches.A.status, 'running')
  assert.equal(d.snapshot?.batches.B.status, 'pending')
})

test('全链路:A/C 通过 → B 派发 → 全部通过 → 交付报告', async () => {
  const { deps, rec, lastSaved } = makeDeps(async () => ({ verdict: 'PASS' }))
  const d = new EngineDriver('s1', 3, deps)
  await d.propose(PLAN)
  await d.onChildSettled('child-A-1', '产出A')
  await d.onChildSettled('child-C-1', '产出C')
  assert.deepEqual(rec.map((r) => r.id), ['A', 'C', 'B'])
  await d.onChildSettled('child-B-1', '产出B')
  assert.equal(d.snapshot?.phase, 'done')
  const delivered = rec.find((r) => r.kind === 'deliver')
  assert.ok(String(delivered?.report).includes('✅ A'))
  assert.ok(String(delivered?.report).includes('任务B'))
  // 落盘终态
  assert.equal(lastSaved().phase, 'done')
})

test('重试:FAIL → 重新派发(问题清单注入提示词)→ PASS', async () => {
  let failFirst = true
  const { deps, rec } = makeDeps(async (spec, output) => {
    if (failFirst) { failFirst = false; return { verdict: 'FAIL', issues: ['缺单元测试'] } }
    return { verdict: 'PASS' }
  })
  const d = new EngineDriver('s1', 3, deps)
  await d.propose(PLAN)
  await d.onChildSettled('child-A-1', '产出A v1')
  // A 重试:B 仍被依赖挡住,C 继续
  assert.equal(d.snapshot?.batches.A.status, 'running')
  const spawns = rec.filter((r) => r.kind === 'spawn' && r.id === 'A')
  assert.equal(spawns.length, 2)
  assert.ok(String(spawns[1].prompt).includes('缺单元测试'))
  await d.onChildSettled('child-A-2', '产出A v2')
  assert.equal(d.snapshot?.batches.A.status, 'passed')
  assert.equal(d.snapshot?.batches.A.attempts, 1) // attempts 只计失败轮数,通过不递增
})

test('重试耗尽 → exhausted,不影响其余批次交付', async () => {
  const { deps, lastSaved, rec } = makeDeps(async (spec) => {
    if (spec.id === 'C') return { verdict: 'FAIL', issues: ['永远不满足'] }
    return { verdict: 'PASS' }
  })
  const d = new EngineDriver('s1', 3, deps)
  await d.propose(PLAN)
  // C 两次失败(1 次首次 + 1 次重试 = maxRetries 1 → 耗尽)
  await d.onChildSettled('child-C-1', 'c1')
  await d.onChildSettled('child-C-2', 'c2')
  assert.equal(d.snapshot?.batches.C.status, 'exhausted')
  await d.onChildSettled('child-A-1', 'a1')
  await d.onChildSettled('child-B-1', 'b1')
  assert.equal(d.snapshot?.phase, 'done')
  const delivered = rec.find((r) => r.kind === 'deliver')
  assert.ok(String(delivered?.report).includes('❌ C'))
  assert.ok(String(delivered?.report).includes('✅ B'))
  assert.equal(lastSaved().batches.C.attempts, 2)
})

test('并发结算不互相覆盖(队列串行化)', async () => {
  const { deps } = makeDeps(async () => ({ verdict: 'PASS' }))
  const d = new EngineDriver('s1', 3, deps)
  await d.propose(PLAN)
  await Promise.all([
    d.onChildSettled('child-A-1', 'a'),
    d.onChildSettled('child-C-1', 'c'),
  ])
  await d.onChildSettled('child-B-1', 'b')
  assert.equal(d.snapshot?.phase, 'done')
  assert.equal(d.snapshot?.batches.A.status, 'passed')
  assert.equal(d.snapshot?.batches.C.status, 'passed')
})

test('重复结算同一 child 被忽略', async () => {
  const { deps, rec } = makeDeps(async () => ({ verdict: 'PASS' }))
  const d = new EngineDriver('s1', 3, deps)
  await d.propose(PLAN)
  await d.onChildSettled('child-A-1', 'a')
  assert.equal(d.snapshot?.batches.A.status, 'passed')
  assert.equal(d.snapshot?.batches.A.output, 'a')
  await d.onChildSettled('child-A-1', '重复结算')
  const verifies = rec.filter((r) => r.kind === 'verify')
  assert.equal(verifies.length, 0) // 未触发第二次验证
  assert.equal(d.snapshot?.batches.A.output, 'a') // 产出未被覆盖
})

test('adopt 断点恢复后继续调度', async () => {
  const { deps, rec, saved } = makeDeps(async () => ({ verdict: 'PASS' }))
  const d1 = new EngineDriver('s1', 3, deps)
  await d1.propose(PLAN)
  // 模拟进程重启:只恢复了已派发的 A/C,尚未结算
  const d2 = new EngineDriver('s1', 3, deps)
  const loaded = JSON.parse(JSON.stringify(d1.snapshot)) as EngineState
  await d2.adopt(loaded)
  assert.equal(d2.snapshot?.batches.A.status, 'running')
  await d2.onChildSettled('child-A-1', 'a')
  await d2.onChildSettled('child-C-1', 'c')
  assert.ok(rec.some((r) => r.id === 'B')) // B 在恢复后被派发
})

test('renderWorkerPrompt:占位符替换 + 重试问题注入', () => {
  const { deps } = makeDeps(async () => ({ verdict: 'PASS' }))
  const d = new EngineDriver('s1', 3, deps)
  return d.propose(PLAN).then(() => {
    const s = d.snapshot as EngineState
    const specB = PLAN.batches.find((b) => b.id === 'B') as PlanBatch
    const s2 = { ...s, batches: { ...s.batches, A: { ...s.batches.A, output: 'A的产出', status: 'passed' as const } } }
    const p = renderWorkerPrompt(specB, s2)
    assert.ok(p.includes('A的产出'))
    assert.ok(!p.includes('{b.A.output}'))
  })
})

test('buildReport 简洁且含终态标注', async () => {
  const { deps } = makeDeps(async () => ({ verdict: 'PASS' }))
  const d = new EngineDriver('s1', 3, deps)
  await d.propose(PLAN)
  await d.onChildSettled('child-A-1', 'a')
  await d.onChildSettled('child-C-1', 'c')
  await d.onChildSettled('child-B-1', 'b')
  const r = buildReport(d.snapshot as EngineState)
  assert.ok(r.includes('✅ A 任务A'))
  assert.ok(r.includes('✅ B 任务B'))
  assert.ok(r.includes('✅ C 任务C'))
})

test('超时归因:running 超时批次记 worker-error 并重试', async () => {
  let t = 1000000
  const spawns: string[] = []
  const deps: DriverDeps = {
    now: () => t,
    save: async () => {},
    spawnWorker: async (spec) => { spawns.push(spec.id); return { childId: 'child-' + spec.id + '-' + spawns.filter((x) => x === spec.id).length } },
    verifyBatch: async () => ({ verdict: 'PASS' }),
    log: () => {},
    workerTimeoutMs: 1000,
    deliverReport: async () => true,
  }
  const d = new EngineDriver('s1', 3, deps)
  await d.propose(PLAN)
  assert.deepEqual(spawns, ['A', 'C'])
  t += 5000 // 双双超时
  await d.sweepTimeouts()
  assert.deepEqual(spawns, ['A', 'C', 'A', 'C']) // 超时→worker-error→重试重新派发
  assert.equal(d.snapshot?.batches.A.attempts, 1)
  t += 100 // 新派发未超时
  await d.sweepTimeouts()
  assert.equal(d.snapshot?.batches.A.status, 'running')
})

test('超时耗尽(maxRetries=0)直接 exhausted 并交付', async () => {
  const p0 = (validatePlan({
    version: 1, goal: 'x',
    batches: [{ id: 'A', title: 'a', prompt: 'p', deps: [], verify: { criteria: ['c'], maxRetries: 0 } }],
  }) as { ok: true; plan: Plan }).plan
  let t = 1000000
  const deps: DriverDeps = {
    now: () => t,
    save: async () => {},
    spawnWorker: async () => ({ childId: 'child-A-1' }),
    verifyBatch: async () => ({ verdict: 'PASS' }),
    log: () => {},
    workerTimeoutMs: 1000,
    deliverReport: async () => true,
  }
  let deliveredReport = ''
  const d2 = deps; deps.deliverReport = async (report) => { deliveredReport = report; return true }
  const d = new EngineDriver('s1', 3, deps)
  await d.propose(p0)
  t += 5000
  await d.sweepTimeouts()
  assert.equal(d.snapshot?.batches.A.status, 'exhausted')
  assert.equal(d.snapshot?.phase, 'done')
  assert.ok(deliveredReport.includes('❌ A'))
  void d2
})

test('adopt 断点恢复后立即扫超时', async () => {
  let t = 1000000
  const spawns: string[] = []
  const deps: DriverDeps = {
    now: () => t,
    save: async () => {},
    spawnWorker: async (spec) => { spawns.push(spec.id); return { childId: 'child-' + spec.id + '-1' } },
    verifyBatch: async () => ({ verdict: 'PASS' }),
    log: () => {},
    workerTimeoutMs: 1000,
    deliverReport: async () => true,
  }
  const d1 = new EngineDriver('s1', 3, deps)
  await d1.propose(PLAN)
  t += 999999 // 远超超时(模拟重启后的时间跳跃)
  const loaded = JSON.parse(JSON.stringify(d1.snapshot)) as EngineState
  const d2 = new EngineDriver('s1', 3, deps)
  await d2.adopt(loaded) // adopt 内先扫超时
  assert.equal(d2.snapshot?.batches.A.attempts, 1) // 超时计一轮(workerError 已被重试启动清零)
  assert.ok(spawns.length >= 4) // 超时重试后重新派发
})

test('重试派发失败(容器休眠场景):worker-error 从 ready 生效,不卡死', async () => {
  let spawnCalls = 0
  let delivered = ''
  const deps: DriverDeps = {
    now: () => Date.now(),
    save: async () => {},
    spawnWorker: async (spec) => {
      spawnCalls++
      if (spawnCalls === 1) return { childId: 'child-A-1' }
      throw new Error('找不到任务会话 agent') // 第二次(重试)派发失败
    },
    verifyBatch: async () => ({ verdict: 'FAIL', issues: ['不满足'] }),
    log: () => {},
    workerTimeoutMs: 600000,
    deliverReport: async (r) => { delivered = r; return true },
  }
  const d = new EngineDriver('s1', 3, deps)
  await d.propose(PLAN)
  await d.onChildSettled('child-A-1', 'v1')
  // 首轮 FAIL → 重试派发失败 → worker-error 消耗一轮 → A maxRetries=1 → exhausted
  assert.equal(d.snapshot?.batches.A.status, 'exhausted')
  assert.equal(d.snapshot?.batches.A.attempts, 2)
  assert.ok(String(d.snapshot?.batches.A.workerError).includes('派发失败'))
  // 依赖级联:B 依赖 A → 自动 exhausted(依赖的批次失败),不卡在 pending
  assert.equal(d.snapshot?.batches.B.status, 'exhausted')
  assert.ok(String(d.snapshot?.batches.B.workerError).includes('依赖的批次失败'))
  // 独立批次 C 继续跑完(其重试派发也失败 → exhausted)→ 全终态 → 交付
  await d.onChildSettled('child-C-1', 'c')
  assert.equal(d.snapshot?.batches.C.status, 'exhausted')
  assert.equal(d.snapshot?.phase, 'done')
  assert.ok(delivered.includes('❌ A'))
  assert.ok(delivered.includes('❌ B'))
})
