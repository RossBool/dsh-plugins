import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractChildOutput, stripSettledPrefix, type ExtEvent } from '../src/extract.ts'

test('优先取最后一条 assistant/message 的文本块', () => {
  const events: ExtEvent[] = [
    { type: 'user/message', data: { message: { content: [{ type: 'text', text: '任务' }] } } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '第一版' }] } } },
    { type: 'assistant/chunk', data: { chunk: { type: 'block-end', block: { type: 'text', text: '分块文本' } } } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'reasoning', text: '思考' }, { type: 'text', text: '最终成果' }] } } },
  ]
  assert.equal(extractChildOutput(events), '最终成果')
})

test('assistant/message 缺失时用 block-end 块拼接', () => {
  const events: ExtEvent[] = [
    { type: 'assistant/chunk', data: { chunk: { type: 'block-end', block: { type: 'reasoning', text: '思考过程' } } } },
    { type: 'assistant/chunk', data: { chunk: { type: 'block-end', block: { type: 'text', text: '段落一' } } } },
    { type: 'assistant/chunk', data: { chunk: { type: 'block-end', block: { type: 'text', text: '段落二' } } } },
  ]
  assert.equal(extractChildOutput(events), '段落一\n段落二')
})

test('全空返回空串', () => {
  assert.equal(extractChildOutput([]), '')
  assert.equal(extractChildOutput([{ type: 'user/message', data: {} }]), '')
})

test('stripSettledPrefix:提取 closing message / 剥离背景前缀', () => {
  const withClosing = 'Background subagent abc-123 finished and will do no further work unless you send it more.\nIts closing message:\nA'
  assert.equal(stripSettledPrefix(withClosing), 'A')
  const plain = 'Background subagent abc-123 finished and will do no further work unless you send it more.'
  assert.equal(stripSettledPrefix(plain), '')
  assert.equal(stripSettledPrefix('正常产出内容'), '正常产出内容')
})
