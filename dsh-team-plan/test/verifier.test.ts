import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseVerifierJson, runVerifier, buildVerifierPrompt } from '../src/verifier.ts'
import { validatePlan, type PlanBatch } from '../src/schema.ts'

const PLAN = validatePlan({ version: 1, goal: 'x', batches: [{ id: 'A', title: 't', prompt: '做X', deps: [], verify: { criteria: ['输出必须包含回文'], maxRetries: 2 } }] })
const SPEC = ((PLAN.ok ? PLAN : null) as { plan: { batches: PlanBatch[] } }).plan.batches[0]

test('parseVerifierJson:PASS / FAIL / 代码块 / 非法', () => {
  assert.deepEqual(parseVerifierJson('{"verdict":"PASS"}'), { ok: true, v: { verdict: 'PASS' } })
  const f = parseVerifierJson('```json\n{"verdict":"FAIL","issues":["缺测试","格式错"]}\n```')
  assert.equal(f.ok, true)
  if (f.ok) assert.deepEqual(f.v, { verdict: 'FAIL', issues: ['缺测试', '格式错'] })
  assert.equal(parseVerifierJson('不是json').ok, false)
  assert.equal(parseVerifierJson('{"verdict":"MAYBE"}').ok, false)
  assert.equal(parseVerifierJson('{"verdict":"FAIL","issues":[]}').ok, false)
  // issues 截断到 10 条、过滤空串
  const many = parseVerifierJson('{"verdict":"FAIL","issues":["","a","b","c","d","e","f","g","h","i","j","k"]}')
  if (many.ok && many.v.verdict === 'FAIL') assert.equal(many.v.issues.length, 10)
})

test('buildVerifierPrompt 包含任务书/验收标准/产出', () => {
  const { system, user } = buildVerifierPrompt(SPEC, '我的产出')
  assert.ok(system.includes('对抗式验证者'))
  assert.ok(user.includes('做X'))
  assert.ok(user.includes('输出必须包含回文'))
  assert.ok(user.includes('我的产出'))
})

test('runVerifier:合法 FAIL 原样透传', async () => {
  const v = await runVerifier(async () => '{"verdict":"FAIL","issues":["没有回文"]}', SPEC, '普通文本')
  assert.deepEqual(v, { verdict: 'FAIL', issues: ['没有回文'] })
})

test('runVerifier:验证器输出非法 → FAIL 且说明原因(不静默)', async () => {
  const v = await runVerifier(async () => '胡言乱语', SPEC, 'x')
  assert.equal(v.verdict, 'FAIL')
  if (v.verdict === 'FAIL') assert.ok(v.issues[0].includes('无法解析'))
})

test('runVerifier:模型异常向上抛', async () => {
  await assert.rejects(
    () => runVerifier(async () => { throw new Error('llm failed') }, SPEC, 'x'),
    /llm failed/,
  )
})
