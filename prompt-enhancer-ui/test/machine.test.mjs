/**
 * 状态机全转移边单测（node --test）。
 * 每条用例注明「为什么」——这些断言编码的是体验铁律，不是行为快照。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { reduce, initialState, isBusy, canRevert, canEnhance, createSend, MIN_TEXT_LENGTH } from '../machine.js'

const start = (text) => ({ type: 'start', text })
const success = (result, draft) => ({ type: 'success', result, draft })
const fail = (error) => ({ type: 'fail', error })
const cancel = () => ({ type: 'cancel' })
const revert = () => ({ type: 'revert' })
const draftChanged = (draft) => ({ type: 'draftChanged', draft })

test('start：空/纯空白输入被守卫拒绝', () => {
  assert.equal(reduce(initialState(), start('')), null)
  assert.equal(reduce(initialState(), start('   ')), null)
  assert.equal(reduce(initialState(), start(undefined)), null)
})

test('start：合法输入进入 enhancing，快照存原文并发出 fetch 效果', () => {
  const next = reduce(initialState(), start('帮我写个爬虫'))
  assert.equal(next.phase, 'enhancing')
  assert.equal(next.snapshot, '帮我写个爬虫')
  assert.deepEqual(next.effects, [{ type: 'fetch', text: '帮我写个爬虫' }])
  assert.equal(isBusy(next), true)
})

test('start：busy 期间重复 start 被丢弃（防双击/防并发）', () => {
  const busy = reduce(initialState(), start('x'))
  assert.equal(reduce(busy, start('y')), null)
})

test('success：草稿未变 → 应用结果，backup=快照，发出 setDraft 效果（happy path）', () => {
  const busy = reduce(initialState(), start('原始输入'))
  const next = reduce(busy, success('增强后的输入', '原始输入'))
  assert.equal(next.phase, 'enhanced')
  assert.equal(next.applied, '增强后的输入')
  assert.equal(next.backup, '原始输入')
  assert.deepEqual(next.effects, [{ type: 'setDraft', text: '增强后的输入' }])
  assert.equal(canRevert(next), true)
})

test('铁律①：增强期间用户编辑了草稿 → 迟到成功被丢弃，绝不覆盖用户编辑', () => {
  // 为什么：这是 WorkBuddy 原版踩过的坑——迟到的响应覆盖用户新输入，等于删用户内容。
  const busy = reduce(initialState(), start('原始输入'))
  const next = reduce(busy, success('增强结果', '原始输入（我改过了）'))
  assert.equal(next.phase, 'idle')
  assert.equal(next.error, 'edited')
  assert.equal(next.effects, undefined) // 没有任何 setDraft
  assert.equal(canRevert(next), false)
})

test('success：空结果按错误处理，不让空串回填', () => {
  const busy = reduce(initialState(), start('x'))
  const next = reduce(busy, success('   ', 'x'))
  assert.equal(next.phase, 'idle')
  assert.equal(next.error, 'empty_result')
})

test('fail：进入 idle 并携带错误，原文不动（无 setDraft 效果）', () => {
  const busy = reduce(initialState(), start('x'))
  const next = reduce(busy, fail('llm_error'))
  assert.equal(next.phase, 'idle')
  assert.equal(next.error, 'llm_error')
  assert.equal(next.effects, undefined)
})

test('cancel：进入 idle 并发出 abort 效果，无任何草稿写入', () => {
  const busy = reduce(initialState(), start('x'))
  const next = reduce(busy, cancel())
  assert.equal(next.phase, 'idle')
  assert.equal(next.error, null)
  assert.deepEqual(next.effects, [{ type: 'abort' }])
})

test('revert：恢复原文（setDraft(backup)），回到 idle', () => {
  let state = reduce(initialState(), start('原文'))
  state = reduce(state, success('增强文', '原文'))
  const next = reduce(state, revert())
  assert.equal(next.phase, 'idle')
  assert.deepEqual(next.effects, [{ type: 'setDraft', text: '原文' }])
  assert.equal(canRevert(next), false)
})

test('铁律②：修改即失效——enhanced 后草稿偏离已应用结果，恢复能力立刻清除', () => {
  // 为什么：恢复的是「被替换的原文」；用户已经在增强结果上继续编辑，
  // 此时恢复会把用户新编辑的内容也一起删掉——必须禁止。
  let state = reduce(initialState(), start('原文'))
  state = reduce(state, success('增强文', '原文'))
  assert.equal(canRevert(state), true)
  const next = reduce(state, draftChanged('增强文，但我又加了点'))
  assert.equal(next.phase, 'idle')
  assert.equal(next.backup, null)
  assert.equal(canRevert(next), false)
  // 失效后再点恢复：守卫拒绝
  assert.equal(reduce(next, revert()), null)
})

test('draftChanged：草稿仍等于已应用结果 → 无操作（恢复能力保留）', () => {
  let state = reduce(initialState(), start('原文'))
  state = reduce(state, success('增强文', '原文'))
  assert.equal(reduce(state, draftChanged('增强文')), null)
  assert.equal(canRevert(state), true)
})

test('draftChanged：idle/enhancing 状态下不敏感', () => {
  assert.equal(reduce(initialState(), draftChanged('随便')), null)
  const busy = reduce(initialState(), start('x'))
  assert.equal(reduce(busy, draftChanged('改了点')), null) // enhancing 期间由 success 的铁律处理
})

test('铁律③：取消后迟到的 success 被 phase 守卫丢弃（双保险）', () => {
  // 为什么：abort 生效前响应可能已在路上；即使绑定层漏判，状态机也要拒收。
  let state = reduce(initialState(), start('x'))
  state = reduce(state, cancel())
  assert.equal(reduce(state, success('迟到结果', 'x')), null)
})

test('非法事件类型被忽略', () => {
  assert.equal(reduce(initialState(), { type: 'nonsense' }), null)
})

test('完整循环：增强→恢复→再增强（FR 的恢复循环用例）', () => {
  let state = initialState()
  state = reduce(state, start('第一版'))
  assert.equal(state.phase, 'enhancing')
  state = reduce(state, success('第二版', '第一版'))
  assert.equal(state.phase, 'enhanced')
  state = reduce(state, revert())
  assert.equal(state.phase, 'idle')
  state = reduce(state, start('第一版'))
  assert.equal(state.phase, 'enhancing')
  state = reduce(state, success('第三版', '第一版'))
  assert.equal(state.phase, 'enhanced')
  assert.equal(state.backup, '第一版')
  assert.equal(canRevert(state), true)
})

test('派生谓词：canEnhance / isBusy / canRevert 覆盖全相位', () => {
  const idle = initialState()
  assert.equal(canEnhance(idle, '有内容'), true)
  assert.equal(canEnhance(idle, '   '), false)
  assert.equal(canEnhance(idle, ''), false)
  assert.equal(isBusy(idle), false)
  assert.equal(canRevert(idle), false)

  const busy = reduce(idle, start('x'))
  assert.equal(canEnhance(busy, '有内容'), false) // busy 不可再点
  assert.equal(isBusy(busy), true)

  const enhanced = reduce(busy, success('结果', 'x'))
  assert.equal(isBusy(enhanced), false)
  assert.equal(canRevert(enhanced), true)
  assert.equal(canEnhance(enhanced, '结果'), false) // enhanced 相位只有「恢复」一个出口
})

test('MIN_TEXT_LENGTH 常量导出（绑定层与测试共用同一阈值）', () => {
  assert.equal(MIN_TEXT_LENGTH, 1)
})

// ---------------------------------------------------------------------------
// createSend 守卫回归测试（锁死「null 落库 → isBusy(null) 崩溃」这一事故）
// 为什么：事故根因是绑定层绕过了 null 丢弃契约直接 dispatch。createSend 把
// 「预检 → dispatch」合并为唯一入口后，null 在结构上不可能成为状态。
// ---------------------------------------------------------------------------

/** 复刻 useReducer 语义的最小调度器：dispatch(event) 后状态 = reduce(state, event)。 */
function makeBinding() {
  let state = initialState()
  const dispatched = []
  const dispatch = (event) => {
    const next = reduce(state, event)
    assert.notEqual(next, null, 'createSend 不应放行会导致 null 的事件（null 落库回归）')
    dispatched.push(event)
    state = next
  }
  return { send: createSend(() => state, dispatch), dispatched, getState: () => state }
}

test('createSend：mount 回归——idle 下 draftChanged 被丢弃，状态保持合法', () => {
  // 原始崩溃序列：mount → effect dispatch(draftChanged) → reduce 返回 null →
  // useReducer 把 null 写成状态 → 下一帧 isBusy(null) 读 null.phase 抛 TypeError。
  const { send, dispatched, getState } = makeBinding()
  assert.equal(send({ type: 'draftChanged', draft: '' }), false)
  assert.equal(send({ type: 'draftChanged', draft: '随便' }), false)
  assert.equal(dispatched.length, 0, '被丢弃的事件不得进入 dispatch')
  assert.equal(isBusy(getState()), false) // 原 bug 在此行崩溃
  assert.equal(canRevert(getState()), false)
  assert.equal(canEnhance(getState(), '有内容'), true)
})

test('createSend：idle 下所有互斥事件都被守卫拒绝（null 永不落库）', () => {
  const { send, dispatched, getState } = makeBinding()
  for (const event of [
    { type: 'success', result: '结果', draft: 'x' },
    { type: 'fail', error: 'unknown' },
    { type: 'cancel' },
    { type: 'revert' },
    { type: 'draftChanged', draft: 'x' },
    { type: 'nonsense' },
  ]) {
    assert.equal(send(event), false, `idle 下应拒绝 ${event.type}`)
  }
  assert.equal(dispatched.length, 0)
  assert.equal(getState().phase, 'idle')
})

test('createSend：放行条件 = 当前状态上 reduce 有定义，且合法事件正常转移', () => {
  const { send, dispatched, getState } = makeBinding()

  // start 放行 → enhancing
  assert.equal(send({ type: 'start', text: '原文' }), true)
  assert.equal(getState().phase, 'enhancing')
  assert.equal(isBusy(getState()), true)

  // busy 期间重复 start 被拒绝
  assert.equal(send({ type: 'start', text: '再点一次' }), false)
  assert.equal(dispatched.length, 1)

  // success 放行 → enhanced（异步续体预检走最新状态的场景）
  assert.equal(send({ type: 'success', result: '增强文', draft: '原文' }), true)
  assert.equal(getState().phase, 'enhanced')
  assert.equal(canRevert(getState()), true)
  assert.deepEqual(dispatched.map((e) => e.type), ['start', 'success'])

  // enhanced 下 draftChanged 偏离 applied → 放行并回到 idle（修改即失效）
  assert.equal(send({ type: 'draftChanged', draft: '增强文，我又加了点' }), true)
  assert.equal(getState().phase, 'idle')
  assert.equal(canRevert(getState()), false)
})

test('createSend：穷举——任何种子状态下，放行当且仅当 reduce 返回非 null', () => {
  const seeds = [
    initialState(),
    reduce(initialState(), start('x')),
    reduce(reduce(initialState(), start('x')), success('y', 'x')),
  ]
  const events = [
    { type: 'start', text: 'x' },
    { type: 'success', result: 'y', draft: 'x' },
    { type: 'fail', error: 'unknown' },
    { type: 'cancel' },
    { type: 'revert' },
    { type: 'draftChanged', draft: 'x' },
    { type: 'nonsense' },
  ]
  for (const seed of seeds) {
    let state = seed
    const dispatch = (event) => {
      const next = reduce(state, event)
      assert.notEqual(next, null, '不变量：null 不得成为状态')
      state = next
    }
    const send = createSend(() => state, dispatch)
    for (const event of events) {
      const before = state
      const expected = reduce(before, event) !== null
      assert.equal(send(event), expected, `seed=${before.phase} event=${event.type}`)
      assert.equal(state === before, !expected, `seed=${before.phase} event=${event.type} 状态变更应符合预期`)
      state = before // 回退，让每个事件在同一初始态上独立测试
    }
  }
})
