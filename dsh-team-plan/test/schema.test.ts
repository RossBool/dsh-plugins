import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validatePlan, parsePlanJson } from '../src/schema.ts'

const GOOD = {
  version: 1,
  goal: '重构支付模块并跑通回归',
  batches: [
    { id: 'A', title: '梳理现状', prompt: '读代码输出现状报告', deps: [], verify: { criteria: ['覆盖全部调用点'], maxRetries: 2 } },
    { id: 'B', title: '实施重构', prompt: '按报告重构', deps: ['A'], verify: { criteria: ['测试通过'] } },
    { id: 'C', title: '回归验证', prompt: '跑回归', deps: ['A'], verify: { criteria: ['全绿'] } },
  ],
}

test('合法计划通过校验', () => {
  const r = validatePlan(GOOD)
  assert.equal(r.ok, true)
  if (r.ok) {
    assert.equal(r.plan.batches.length, 3)
    assert.equal(r.plan.batches[1].verify.maxRetries, 3) // 缺省默认
    assert.equal(r.plan.batches[0].verify.maxRetries, 2)
  }
})

test('非法输入逐条报错', () => {
  const cases: Array<[unknown, RegExp]> = [
    [null, /JSON 对象/],
    [{ version: 2, goal: 'x', batches: [] }, /version 必须为 1/],
    [{ version: 1, goal: '', batches: [] }, /goal/],
    [{ version: 1, goal: 'x', batches: [] }, /1~12 个批次/],
    [{ version: 1, goal: 'x', batches: [{ id: 'A!', title: '', prompt: '', deps: [], verify: { criteria: [] } }] }, /id 必须匹配/],
    [{ version: 1, goal: 'x', batches: [{ id: 'A', title: 't', prompt: 'p', deps: [], verify: { criteria: [] } }] }, /criteria/],
    [{ version: 1, goal: 'x', batches: [{ id: 'A', title: 't', prompt: 'p', deps: [], verify: { criteria: ['c'], maxRetries: 9 } }] }, /maxRetries/],
  ]
  for (const [input, re] of cases) {
    const r = validatePlan(input)
    assert.equal(r.ok, false)
    if (!r.ok) assert.ok(r.errors.some((e) => re.test(e)), `期望匹配 ${re}，实际 ${JSON.stringify(r.errors)}`)
  }
})

test('依赖成环/不存在/自依赖被拒绝', () => {
  const cyc = { version: 1, goal: 'x', batches: [
    { id: 'A', title: 'a', prompt: 'p', deps: ['B'], verify: { criteria: ['c'] } },
    { id: 'B', title: 'b', prompt: 'p', deps: ['A'], verify: { criteria: ['c'] } },
  ] }
  const r1 = validatePlan(cyc)
  assert.equal(r1.ok, false)
  if (!r1.ok) assert.ok(r1.errors.some((e) => e.includes('成环')), JSON.stringify(r1.errors))

  const missing = { version: 1, goal: 'x', batches: [
    { id: 'A', title: 'a', prompt: 'p', deps: ['Z'], verify: { criteria: ['c'] } },
  ] }
  const r2 = validatePlan(missing)
  assert.equal(r2.ok, false)
  if (!r2.ok) assert.ok(r2.errors.some((e) => e.includes('不存在')), JSON.stringify(r2.errors))

  const self = { version: 1, goal: 'x', batches: [
    { id: 'A', title: 'a', prompt: 'p', deps: ['A'], verify: { criteria: ['c'] } },
  ] }
  const r3 = validatePlan(self)
  assert.equal(r3.ok, false)
  if (!r3.ok) assert.ok(r3.errors.some((e) => e.includes('自身')), JSON.stringify(r3.errors))
})

test('重复 id 被拒绝', () => {
  const dup = { version: 1, goal: 'x', batches: [
    { id: 'A', title: 'a', prompt: 'p', deps: [], verify: { criteria: ['c'] } },
    { id: 'A', title: 'b', prompt: 'p', deps: [], verify: { criteria: ['c'] } },
  ] }
  const r = validatePlan(dup)
  assert.equal(r.ok, false)
  if (!r.ok) assert.ok(r.errors.some((e) => e.includes('重复')), JSON.stringify(r.errors))
})

test('parsePlanJson 容忍 ```json 代码块', () => {
  const text = '好的，计划如下：\n```json\n' + JSON.stringify(GOOD) + '\n```'
  const r = parsePlanJson(text)
  assert.equal(r.ok, true)
})

test('parsePlanJson 对坏 JSON 报错', () => {
  const r = parsePlanJson('这不是 json {')
  assert.equal(r.ok, false)
  if (!r.ok) assert.ok(r.errors.some((e) => e.includes('JSON')))
})
