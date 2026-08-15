import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { saveState, loadState, stateFile } from '../src/persist.ts'
import { createState } from '../src/engine.ts'

test('save/load 往返一致', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-team-plan-'))
  try {
    const s = createState('sess-1', 1234)
    const file = stateFile(dir, 'sess-1')
    await saveState(file, s)
    const loaded = await loadState(file)
    assert.deepEqual(loaded, s)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('缺失文件返回 null', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-team-plan-'))
  try {
    assert.equal(await loadState(join(dir, 'nope.json')), null)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('损坏文件返回 null(不抛异常)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-team-plan-'))
  try {
    const file = join(dir, 'bad.json')
    await writeFile(file, '{ 这不是 json', 'utf8')
    assert.equal(await loadState(file), null)
    const wrong = join(dir, 'wrong-v.json')
    await writeFile(wrong, JSON.stringify({ v: 2 }), 'utf8')
    assert.equal(await loadState(wrong), null)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('原子写:目录自动创建,内容可读', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-team-plan-'))
  try {
    const file = join(base, 'deep', 'nested', 's.json')
    await saveState(file, createState('s', 1))
    const raw = await readFile(file, 'utf8')
    assert.ok(raw.includes('"v": 1'))
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('sessionId 中危险字符被清洗', () => {
  assert.equal(stateFile('/x', 'a/b\\c d'), '/x/a_b_c_d.json')
})
