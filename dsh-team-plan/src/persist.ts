/**
 * dsh-team-plan/persist — 引擎状态 JSON 原子落盘。
 *
 * 无 DSH 依赖的纯 Node 实现：tmp + rename 保证写一半也不产生坏文件；
 * loadState 对损坏/缺失文件返回 null（由驱动层决定重建或报错）。
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { EngineState } from './engine.ts'

export async function saveState(file: string, state: EngineState): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`
  await writeFile(tmp, JSON.stringify(state, null, 2), 'utf8')
  await rename(tmp, file)
}

export async function loadState(file: string): Promise<EngineState | null> {
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
  try {
    const obj = JSON.parse(raw)
    if (obj === null || typeof obj !== 'object' || (obj as { v?: unknown }).v !== 1) return null
    return obj as EngineState
  } catch {
    return null
  }
}

/** 状态文件命名约定：<dir>/<sessionId>.json */
export function stateFile(dir: string, sessionId: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 96)
  return `${dir.replace(/\/$/, '')}/${safe}.json`
}
