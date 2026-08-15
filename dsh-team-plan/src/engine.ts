/**
 * dsh-team-plan/engine — 确定性状态机（纯函数 reducer）。
 *
 * 对应图中 Team Engine：依赖满足即入队、批内并行上限可配、Verifier 重试回环、
 * 批次耗尽重试后标记 exhausted 并继续其余独立批次。
 *
 * 确定性约定：
 *  - transition(state, event, now) 是纯函数：同一状态+事件序列必得同一结果（含时间戳）；
 *  - 无效迁移返回 { ok:false, error }，状态不变；
 *  - 驱动层（插件）负责在每次迁移后落盘、派发 Worker、调用 Verifier——
 *    本模块不做任何 IO。
 */

import type { Plan } from './schema.ts'

export type BatchStatus = 'pending' | 'ready' | 'running' | 'verifying' | 'passed' | 'exhausted'
export type EnginePhase = 'idle' | 'running' | 'delivering' | 'done'

export interface BatchState {
  id: string
  status: BatchStatus
  /** 失败轮数（verify:fail / worker-error 次数；通过不递增） */
  attempts: number
  childId?: string
  output?: string
  issues?: string[]
  workerError?: string
  workerStartedAt?: number
  updatedAt: number
}

export interface EngineState {
  v: 1
  phase: EnginePhase
  sessionId: string
  /** 任务所属的用户会话(隔离重构:M4 后任务跑在独立任务会话) */
  parentSessionId?: string
  /** 交付报告是否已成功投递回用户会话(休眠兜底用) */
  delivered?: boolean
  plan?: Plan
  planError?: string
  batches: Record<string, BatchState>
  seq: number
  updatedAt: number
}

export type EngineEvent =
  | { type: 'plan:proposed'; plan: Plan }
  | { type: 'plan:failed'; error: string }
  | { type: 'batch:started'; id: string; childId: string }
  | { type: 'batch:output'; id: string; output: string }
  | { type: 'batch:verify:pass'; id: string }
  | { type: 'batch:verify:fail'; id: string; issues: string[] }
  | { type: 'batch:worker-error'; id: string; error: string }
  | { type: 'deliver' }
  | { type: 'done' }

export type TransitionResult = { ok: true; state: EngineState } | { ok: false; error: string }

/** 新建引擎状态 */
export function createState(sessionId: string, now: number, parentSessionId?: string): EngineState {
  return { v: 1, phase: 'idle', sessionId, ...(parentSessionId ? { parentSessionId } : {}), batches: {}, seq: 0, updatedAt: now }
}

const MAX_PARALLEL_DEFAULT = 3

/** 总允许轮数 = 1（首次）+ maxRetries */
export function roundsAllowed(maxRetries: number): number {
  return maxRetries + 1
}

/** 全部批次是否已到终态（passed | exhausted） */
export function allTerminal(state: EngineState): boolean {
  const list = Object.values(state.batches)
  return list.length > 0 && list.every((b) => b.status === 'passed' || b.status === 'exhausted')
}

/** 依赖全部 passed 且处于 pending/ready 的批次（按声明顺序） */
export function nextReady(state: EngineState, cap = MAX_PARALLEL_DEFAULT): string[] {
  if (!state.plan) return []
  const running = Object.values(state.batches).filter((b) => b.status === 'running').length
  const slots = Math.max(0, cap - running)
  if (slots === 0) return []
  const out: string[] = []
  for (const spec of state.plan.batches) {
    const b = state.batches[spec.id]
    if (!b || (b.status !== 'pending' && b.status !== 'ready')) continue
    if (!spec.deps.every((d) => state.batches[d]?.status === 'passed')) continue
    out.push(b.id)
    if (out.length >= slots) break
  }
  return out
}

/** 迁移主函数。无效迁移返回 error 且状态不变。 */
/** 依赖级联封堵:某批次耗尽后,所有(传递)依赖它的 pending 批次标记 exhausted */
export function blockDependents(batches: Record<string, BatchState>, plan: Plan | undefined, failedId: string, now: number): Record<string, BatchState> {
  if (!plan) return batches
  const failed = new Set<string>([failedId])
  let changed = false
  for (let pass = 0; pass < plan.batches.length + 1; pass++) {
    let added = false
    for (const spec of plan.batches) {
      const b = batches[spec.id]
      if (!b || b.status !== 'pending') continue
      if (spec.deps.some((d) => failed.has(d))) {
        batches = { ...batches, [spec.id]: { ...b, status: 'exhausted', workerError: '依赖的批次失败:' + [...failed].filter((f) => spec.deps.includes(f)).join(','), updatedAt: now } }
        failed.add(spec.id)
        added = true
        changed = true
      }
    }
    if (!added) break
  }
  return changed ? batches : batches
}

export function transition(state: EngineState, event: EngineEvent, now: number): TransitionResult {
  const err = (error: string): TransitionResult => ({ ok: false, error })
  const next = (patch: Partial<EngineState>): TransitionResult => ({
    ok: true,
    state: { ...state, ...patch, seq: state.seq + 1, updatedAt: now },
  })
  const patchBatch = (id: string, patch: Partial<BatchState>): Partial<EngineState> => {
    const b = state.batches[id]
    if (!b) throw new Error('missing batch: ' + id)
    return { batches: { ...state.batches, [id]: { ...b, ...patch, updatedAt: now } } }
  }

  switch (event.type) {
    case 'plan:proposed': {
      if (state.phase !== 'idle') return err(`plan:proposed 只允许在 idle 阶段（当前 ${state.phase}）`)
      const batches: Record<string, BatchState> = {}
      for (const spec of event.plan.batches) {
        batches[spec.id] = { id: spec.id, status: 'pending', attempts: 0, updatedAt: now }
      }
      return next({ phase: 'running', plan: event.plan, planError: undefined, batches })
    }
    case 'plan:failed': {
      if (state.phase !== 'idle') return err(`plan:failed 只允许在 idle 阶段（当前 ${state.phase}）`)
      return next({ planError: event.error })
    }
    case 'batch:started': {
      const b = state.batches[event.id]
      if (!b) return err(`批次不存在：${event.id}`)
      if (b.status !== 'pending' && b.status !== 'ready') {
        return err(`批次 ${event.id} 状态为 ${b.status}，不能启动（需 pending/ready）`)
      }
      return next(patchBatch(event.id, { status: 'running', childId: event.childId, workerStartedAt: now, workerError: undefined }))
    }
    case 'batch:output': {
      const b = state.batches[event.id]
      if (!b) return err(`批次不存在：${event.id}`)
      if (b.status !== 'running') return err(`批次 ${event.id} 状态为 ${b.status}，不能收产出（需 running）`)
      return next(patchBatch(event.id, { status: 'verifying', output: event.output }))
    }
    case 'batch:verify:pass': {
      const b = state.batches[event.id]
      if (!b) return err(`批次不存在：${event.id}`)
      if (b.status !== 'verifying') return err(`批次 ${event.id} 状态为 ${b.status}，不能验收（需 verifying）`)
      return next(patchBatch(event.id, { status: 'passed', issues: undefined }))
    }
    case 'batch:verify:fail': {
      const b = state.batches[event.id]
      if (!b) return err(`批次不存在：${event.id}`)
      if (b.status !== 'verifying') return err(`批次 ${event.id} 状态为 ${b.status}，不能判定失败（需 verifying）`)
      const spec = state.plan?.batches.find((s) => s.id === event.id)
      const maxRetries = spec?.verify.maxRetries ?? 3
      const attempts = b.attempts + 1
      const exhausted = attempts >= roundsAllowed(maxRetries)
      const base = patchBatch(event.id, {
        status: exhausted ? 'exhausted' : 'ready',
        attempts,
        issues: event.issues,
        output: undefined,
        childId: undefined,
      })
      if (!exhausted) return next(base)
      return next({ batches: blockDependents(base.batches as Record<string, BatchState>, state.plan, event.id, now) })
    }
    case 'batch:worker-error': {
      const b = state.batches[event.id]
      if (!b) return err(`批次不存在：${event.id}`)
      // 允许 pending/ready/running:派发失败也会记 worker-error(消耗一轮),覆盖重试派发失败的死角
      if (b.status !== 'running' && b.status !== 'ready' && b.status !== 'pending') {
        return err(`批次 ${event.id} 状态为 ${b.status}，不能记错误（需 pending/ready/running）`)
      }
      const spec = state.plan?.batches.find((s) => s.id === event.id)
      const maxRetries = spec?.verify.maxRetries ?? 3
      const attempts = b.attempts + 1
      const exhausted = attempts >= roundsAllowed(maxRetries)
      const base = patchBatch(event.id, {
        status: exhausted ? 'exhausted' : 'ready',
        attempts,
        workerError: event.error,
        output: undefined,
        childId: undefined,
      })
      if (!exhausted) return next(base)
      return next({ batches: blockDependents(base.batches as Record<string, BatchState>, state.plan, event.id, now) })
    }
    case 'deliver': {
      if (state.phase !== 'running') return err(`deliver 只允许在 running 阶段（当前 ${state.phase}）`)
      if (!allTerminal(state)) return err('仍有批次未到终态，不能交付')
      return next({ phase: 'delivering' })
    }
    case 'done': {
      if (state.phase !== 'delivering') return err(`done 只允许在 delivering 阶段（当前 ${state.phase}）`)
      return next({ phase: 'done' })
    }
    default:
      return err('未知事件：' + JSON.stringify(event))
  }
}

/** 中止计划:所有非终态批次标记 exhausted(用户中止),保留已通过结果 */
export function abortPlan(state: EngineState, now: number): TransitionResult {
  if (state.phase !== 'running' && state.phase !== 'delivering') {
    return { ok: false, error: `只能在 running/delivering 阶段中止(当前 ${state.phase})` }
  }
  const batches: Record<string, BatchState> = {}
  for (const [id, b] of Object.entries(state.batches)) {
    if (b.status === 'passed' || b.status === 'exhausted') { batches[id] = b; continue }
    batches[id] = { ...b, status: 'exhausted', workerError: '用户中止', updatedAt: now }
  }
  return { ok: true, state: { ...state, batches, seq: state.seq + 1, updatedAt: now } }
}
