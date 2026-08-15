/**
 * dsh-team-plan/driver — 引擎驱动器:状态机 × 副作用(派发/验证/交付)的粘合层。
 *
 * 纯状态机在 engine.ts;本层通过依赖注入承载全部副作用(派发 Worker、调用 Verifier、
 * 落盘),因此可用 mock 完整测试。所有状态变更走 promise 队列串行化,避免并发
 * 子代理结算竞争。
 */

import type { Plan, PlanBatch } from './schema.ts'
import { createState, transition, nextReady, allTerminal, abortPlan, type EngineState, type EngineEvent } from './engine.ts'

export type VerifyResult = { verdict: 'PASS' } | { verdict: 'FAIL'; issues: string[] }

export interface DriverDeps {
  now(): number
  save(state: EngineState): Promise<void>
  spawnWorker(spec: PlanBatch, prompt: string): Promise<{ childId: string }>
  verifyBatch(spec: PlanBatch, output: string): Promise<VerifyResult>
  log(msg: string): void
  /** 单批执行超时(ms);缺省不启用超时归因 */
  workerTimeoutMs?: number
  /** 交付:把最终报告送到用户会话(隔离架构下由 followup 完成);返回是否投递成功 */
  deliverReport(report: string): Promise<boolean>
}

export class EngineDriver {
  private state: EngineState | null = null
  private queue: Promise<void> = Promise.resolve()

  private sessionId: string
  private parentSessionId?: string
  private maxParallel: number
  private deps: DriverDeps

  constructor(sessionId: string, maxParallel: number, deps: DriverDeps, parentSessionId?: string) {
    this.sessionId = sessionId
    this.parentSessionId = parentSessionId
    this.maxParallel = maxParallel
    this.deps = deps
  }

  get snapshot(): EngineState | null { return this.state }

  /** 断点恢复:接管已落盘状态并继续调度;同时扫一遍超时(重启后挂起的批次不再等) */
  async adopt(loaded: EngineState): Promise<void> {
    this.state = loaded
    await this.sweepTimeouts()
    await this.pump()
  }

  /** 提交计划并开始调度 */
  propose(plan: Plan): Promise<void> {
    return this.run(async () => {
      if (!this.state) this.state = createState(this.sessionId, this.deps.now(), this.parentSessionId)
      if (this.state.phase !== 'idle') throw new Error('本会话已有进行中的计划(phase=' + this.state.phase + ')')
      this.state = this.t(this.state, { type: 'plan:proposed', plan })
      await this.save()
      await this.pumpLocked()
    })
  }

  /** 子代理结算:记产出 → 验证 → 通过/重试 → 继续调度或交付 */
  onChildSettled(childId: string, output: string): Promise<void> {
    return this.run(async () => {
      if (!this.state) return
      const batch = Object.values(this.state.batches).find((b) => b.childId === childId && b.status === 'running')
      if (!batch) return
      const spec = this.state.plan?.batches.find((s) => s.id === batch.id)
      if (!spec) return
      this.state = this.t(this.state, { type: 'batch:output', id: batch.id, output })
      await this.save()
      const v = await this.deps.verifyBatch(spec, output)
      if (v.verdict === 'PASS') {
        this.deps.log(`batch ${batch.id} 验证通过`)
        this.state = this.t(this.state, { type: 'batch:verify:pass', id: batch.id })
      } else {
        this.deps.log(`batch ${batch.id} 验证失败(${v.issues.length} 个问题),进入重试`)
        this.state = this.t(this.state, { type: 'batch:verify:fail', id: batch.id, issues: v.issues })
      }
      await this.save()
      if (allTerminal(this.state)) await this.deliverLocked()
      else await this.pumpLocked()
    })
  }

  /** 超时归因扫频:running 且超过 workerTimeoutMs 的批次记 worker-error(消耗一轮重试) */
  sweepTimeouts(): Promise<void> {
    return this.run(async () => {
      if (!this.state || !this.deps.workerTimeoutMs) return
      const now = this.deps.now()
      const overdue = Object.values(this.state.batches).filter(
        (b) => b.status === 'running' && b.workerStartedAt !== undefined && now - b.workerStartedAt > this.deps.workerTimeoutMs!,
      )
      if (!overdue.length) return
      for (const b of overdue) {
        this.deps.log(`batch ${b.id} 执行超时(>${this.deps.workerTimeoutMs}ms),记为 worker-error`)
        this.state = this.t(this.state, { type: 'batch:worker-error', id: b.id, error: '执行超时' })
      }
      await this.save()
      if (allTerminal(this.state)) await this.deliverLocked()
      else await this.pumpLocked()
    })
  }

  /** 串行化:同一时刻只有一个状态迁移序列在执行 */
  private run<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.queue.then(fn, fn)
    this.queue = p.then(() => undefined, (e) => {
      this.deps.log('driver 队列异常: ' + String((e as Error)?.message ?? e))
    })
    return p
  }

  private t(s: EngineState, ev: EngineEvent): EngineState {
    const r = transition(s, ev, this.deps.now())
    if (!r.ok) throw new Error('engine transition failed: ' + r.error)
    return r.state
  }

  private async save(): Promise<void> {
    if (this.state) await this.deps.save(this.state)
  }

  private async pump(): Promise<void> {
    return this.run(() => this.pumpLocked())
  }

  private async pumpLocked(): Promise<void> {
    while (this.state) {
      const ids = nextReady(this.state, this.maxParallel)
      if (!ids.length) break
      for (const id of ids) await this.startBatchLocked(id)
    }
    // 派发失败可能让批次在泵内耗尽(如依赖级联封堵),补一次终态检查
    if (this.state && allTerminal(this.state)) await this.deliverLocked()
  }

  private async startBatchLocked(id: string): Promise<void> {
    if (!this.state?.plan) return
    const spec = this.state.plan.batches.find((b) => b.id === id)
    if (!spec) return
    const prompt = renderWorkerPrompt(spec, this.state)
    try {
      const { childId } = await this.deps.spawnWorker(spec, prompt)
      this.state = this.t(this.state, { type: 'batch:started', id, childId })
    } catch (e) {
      this.deps.log(`batch ${id} 派发失败: ${String((e as Error)?.message ?? e)}`)
      this.state = this.t(this.state, { type: 'batch:worker-error', id, error: '派发失败:' + String((e as Error)?.message ?? e) })
    }
    await this.save()
  }



  /** 中止当前计划:非终态批次全部置 exhausted(用户中止)并直接交付 */
  abort(reason = '用户中止'): Promise<void> {
    return this.run(async () => {
      if (!this.state) return
      if (this.state.phase === 'done' || this.state.phase === 'idle') return
      const r = abortPlan(this.state, this.deps.now())
      if (!r.ok) { this.deps.log('abort 失败:' + r.error); return }
      this.state = r.state
      await this.save()
      await this.deliverLocked()
    })
  }


  private async deliverLocked(): Promise<void> {
    if (!this.state) return
    const report = buildReport(this.state)
    this.state = this.t(this.state, { type: 'deliver' })
    this.state = this.t(this.state, { type: 'done' })
    await this.save()
    const ok = await this.deps.deliverReport(report)
    if (ok) {
      this.state = { ...this.state, delivered: true }
      await this.save()
    }
  }
}

/** Worker 提示词渲染:占位符 {b.<id>.output} 替换 + 重试问题清单追加 */
export function renderWorkerPrompt(spec: PlanBatch, state: EngineState): string {
  let text = spec.prompt.replace(/\{b\.([A-Za-z0-9_-]+)\.output\}/g, (_m, id: string) => state.batches[id]?.output ?? '')
  const b = state.batches[spec.id]
  if (b && Array.isArray(b.issues) && b.issues.length) {
    text += '\n\n【上一轮验证未通过,请针对以下问题修复后重新交付】\n' + b.issues.map((s, i) => `${i + 1}. ${s}`).join('\n')
  }
  text += '\n\n完成后用中文输出最终成果。这是执行任务:不要派发子代理、不要向用户提问,直接交付结果。'
  return text
}

/** Leader 控制面提示词:受约束 LLM 单次调用,只输出计划 JSON */
export function buildLeaderPrompt(requirement: string): { system: string; user: string } {
  const system = [
    '你是「Leader 控制面」:把用户需求拆解成可并行执行的批次计划,交给确定性引擎派发 Worker 执行。',
    '只输出一个 JSON 对象,不要输出任何其他文字、解释或 markdown 代码块。',
    'JSON 结构:{"version":1,"goal":"一句话目标","batches":[{"id":"A","title":"简短标题","prompt":"交给 Worker 的完整任务书(可引用 {b.<id>.output} 表示依赖批次的产出)","deps":[],"verify":{"criteria":["可客观判定的验收标准"],"maxRetries":3}}]}',
    '规则:',
    '- batches 1~12 个;id 用大写字母(A、B、C…),唯一;',
    '- 可并行的任务拆成多个无依赖批次;有先后依赖的用 deps 声明(依赖的批次必须先通过验证);',
    '- 每个批次 verify.criteria 写 1~3 条可客观判定的验收标准;',
    '- prompt 必须自包含:Worker 只能看到它自己的 prompt;',
    '- maxRetries 0~5,默认 3。',
  ].join('\n')
  return { system, user: '用户需求:\n' + requirement }
}

/** 交付报告:批次终态汇总(注入主会话) */
export function buildReport(state: EngineState): string {
  const plan = state.plan
  if (!plan) return '【计划引擎】无计划。'
  const lines: string[] = ['【计划引擎交付报告】目标:' + plan.goal]
  const passed: string[] = []
  const exhausted: string[] = []
  for (const spec of plan.batches) {
    const b = state.batches[spec.id]
    if (!b) continue
    if (b.status === 'passed') {
      passed.push(`- ✅ ${spec.id} ${spec.title}${b.output ? ': ' + truncate(b.output, 240) : ''}`)
    } else if (b.status === 'exhausted') {
      const why = b.workerError ? `(执行失败:${truncate(b.workerError, 80)})` : b.issues?.length ? `(验证问题:${b.issues.join(';').slice(0, 120)})` : ''
      exhausted.push(`- ❌ ${spec.id} ${spec.title} 重试耗尽 ${why}`)
    }
  }
  if (passed.length) lines.push('通过批次:\n' + passed.join('\n'))
  if (exhausted.length) lines.push('失败批次(已耗尽重试,其余批次不受影响):\n' + exhausted.join('\n'))
  return lines.join('\n')
}

function truncate(s: string, n: number): string {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n) + '…' : t
}