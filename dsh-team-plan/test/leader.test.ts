import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runLeader } from '../src/leader.ts'

const GOOD_JSON = JSON.stringify({
  version: 1,
  goal: '重构支付模块',
  batches: [
    { id: 'A', title: '梳理', prompt: '读代码', deps: [], verify: { criteria: ['覆盖调用点'] } },
    { id: 'B', title: '重构', prompt: '动手', deps: ['A'], verify: { criteria: ['测试通过'] } },
  ],
})

test('一次输出合法计划即成功', async () => {
  let calls = 0
  const r = await runLeader(async () => { calls++; return GOOD_JSON }, '需求')
  assert.equal(r.ok, true)
  assert.equal(calls, 1)
  if (r.ok) assert.equal(r.plan.batches.length, 2)
})

test('校验失败 → 带问题清单重写一次 → 成功', async () => {
  const outputs = ['不是json{', '```json\n' + GOOD_JSON + '\n```']
  const seen: string[] = []
  const r = await runLeader(async (_sys, user) => { seen.push(user); return outputs.shift() ?? '' }, '需求')
  assert.equal(r.ok, true)
  assert.equal(seen.length, 2)
  assert.ok(seen[1].includes('未通过校验'))
})

test('两次失败 → 显式错误,不静默', async () => {
  const r = await runLeader(async () => '依然不是 json', '需求')
  assert.equal(r.ok, false)
  if (!r.ok) {
    assert.ok(r.error.includes('两次校验均失败'))
    assert.ok(r.error.includes('JSON'))
  }
})

test('模型失败异常向上抛(由命令 handler 转 error 结果)', async () => {
  await assert.rejects(
    () => runLeader(async () => { throw new Error('llm failed: quota') }, '需求'),
    /llm failed/,
  )
})
