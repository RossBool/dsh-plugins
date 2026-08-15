/**
 * dsh-team-plan — 计划驱动协作引擎插件(M1:Leader 生成计划 + Worker 派发闭环)。
 *
 * 对应「MiniMax Agent Team 协作模型」:Leader 控制面 → plan(批次/依赖/验证标准)
 * → 确定性状态机(engine.ts)→ Worker 子代理(harness subagents)→ Verifier(M2 接入)
 * → 重试回环 → 交付报告注入主会话。与现有自由协作路由并存,/plan 显式触发。
 *
 * 依赖事实(见 research/dsh-api-facts.md):
 *  - ctx.llm.stream + BlockAssembler 一次调用拿全文(失败归一化为 finish kind)
 *  - ctx.commands.register 注册 /plan 命令(handler 不发模型)
 *  - ctx.subagents.startContinuable 派发持久化 Worker;父会话经 agent/inbox/inserted
 *    收到 subagent-settled/report 消息
 *  - 状态落盘 $DSH_HOME/storages/dsh-team-plan/<sessionId>.json(原子写)
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-subagent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import Schema from '@deepseek-ai/schemastery'
import { BlockAssembler, createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { loadState, saveState, stateFile } from './persist.ts'
import { runLeader } from './leader.ts'
import { runVerifier } from './verifier.ts'
import { extractChildOutput, stripSettledPrefix, type ExtEvent } from './extract.ts'
import { EngineDriver, buildReport, type VerifyResult } from './driver.ts'
import type { PlanBatch, Plan } from './schema.ts'

export const name = 'team-plan'

export interface Config {
  enabled: boolean
  provider: string
  model: string
  maxParallel: number
  leaderTimeoutMs: number
  verifierTimeoutMs: number
  workerTimeoutMs: number
}

export const Config: Schema<Config> = Schema.object({
  enabled: Schema.boolean().default(true),
  provider: Schema.string().default('deepseek-official'),
  model: Schema.string().default('deepseek-v4-flash'),
  maxParallel: Schema.number().min(1).max(6).default(3),
  leaderTimeoutMs: Schema.number().min(5000).default(120000),
  verifierTimeoutMs: Schema.number().min(5000).default(120000),
  workerTimeoutMs: Schema.number().min(30000).default(900000),
})

export const inject = ['llm', 'subagents', 'agents', 'commands']

export function apply(ctx: Context, config: Config) {
  if (!config.enabled) {
    console.log('[dsh-team-plan] skipped (enabled=false)')
    return
  }
  const stateDir = dshHomePath('storages', 'dsh-team-plan')
  const drivers = new Map<string, EngineDriver>() // taskSessionId → driver
  const pendingReports = new Map<string, string>() // userSessionId → 待注入的交付报告(休眠兜底)

  const askModel = async (system: string, user: string, signal?: AbortSignal): Promise<string> => {
    const messages = [createUserMessage({
      content: [{ type: 'text', text: user }],
      source: { kind: 'plugin', plugin: 'dsh-team-plan' },
    })]
    const assembler = new BlockAssembler()
    for await (const chunk of ctx.llm.stream({ provider: config.provider, model: config.model, messages, system, signal })) {
      if (signal?.aborted) throw new Error('llm call aborted')
      assembler.push(chunk)
    }
    if (assembler.finish.kind === 'error' || assembler.finish.kind === 'aborted') {
      throw new Error('llm failed: ' + (assembler.finish.failure?.message || assembler.finish.kind))
    }
    const blocks = assembler.blocks() as Array<{ type: string; text?: string }>
    return blocks.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('')
  }

  // 任务会话(隔离执行容器)的初始提示词:静默等待,收到交付报告后原样输出并结束。
  // 子代理永不二次组队(协作路由的顶层限定会放行它,见 route.js guard 1)。
  const TASK_CONTAINER_PROMPT = '你是「计划任务执行容器」。第一步:输出一行「任务已启动,后台执行中,完成后交付报告会回到主会话。」然后结束本轮。此后你会收到 Worker 子代理的结算消息,不要处理它们的内容、不要输出任何东西、不要派发子代理,静默等待。当收到以【交付报告】开头的消息时,把该消息的内容原样输出(不要修改、不要补充),然后结束。'

  // 隔离架构(M4):引擎跑在独立任务会话(taskId)内,Worker 是任务会话的子代理,
  // 结算只进任务会话 inbox;完成后由任务容器原样输出交付报告,经结算通知
  // 以「一条消息」投递回用户会话(parentSessionId)——用户会话零占用。
  const makeDriver = (taskId: string, parentSessionId?: string): EngineDriver => {
    const abort = new AbortController()
    return new EngineDriver(taskId, config.maxParallel, {
      workerTimeoutMs: config.workerTimeoutMs,
      now: () => Date.now(),
      save: (state) => saveState(stateFile(stateDir, taskId), state),
      spawnWorker: async (spec: PlanBatch, prompt: string) => {
        const agents = ctx.get('agents')
        let parent = agents?.get(taskId as SessionId) || agents?.roots().find((a: { id: string }) => a.id === taskId)
        if (!parent) {
          // 任务容器已结算休眠:followup 唤醒(空转一轮)后重新取活体 agent,再派发
          const userAgent = parentSessionId
            ? agents?.get(parentSessionId as SessionId) || agents?.roots().find((a: { id: string }) => a.id === parentSessionId)
            : undefined
          if (!userAgent) throw new Error('任务容器休眠且用户会话不可用,无法唤醒')
          await ctx.subagents.followup(userAgent, taskId as SessionId, [{ type: 'text', text: '保持待命。' }], { source: { kind: 'plugin', plugin: 'dsh-team-plan' }, signal: abort.signal })
          for (let i = 0; i < 30; i++) {
            parent = agents?.get(taskId as SessionId) || agents?.roots().find((a: { id: string }) => a.id === taskId)
            if (parent) break
            await new Promise((r) => setTimeout(r, 1000))
          }
          if (!parent) throw new Error('唤醒任务容器失败(30s 内未变为活体)')
        }
        const providers = ctx.subagents.list()
        const provider = providers.includes('spawn') ? 'spawn' : providers[0]
        if (!provider) throw new Error('无可用 subagent provider')
        const res = await ctx.subagents.startContinuable({
          provider,
          label: spec.title.slice(0, 40),
          request: { prompt: [{ type: 'text', text: prompt }], parent },
          signal: abort.signal,
        })
        return { childId: res.childId }
      },
      verifyBatch: async (spec: PlanBatch, output: string): Promise<VerifyResult> => {
        const signal = AbortSignal.timeout(config.verifierTimeoutMs)
        return runVerifier(askModel, spec, output, signal)
      },
      log: (m) => console.log('[dsh-team-plan] ' + m),
      deliverReport: async (report: string): Promise<boolean> => {
        // 主路径:followup 送进任务容器 → 容器原样输出 → 结算通知自动投递回用户会话(即时)
        // 兜底:用户会话休眠(followup 无活体父 agent)→ 登记 pendingReports,
        //       用户下次打开该会话时经 agent/pre-step 注入
        const agents = ctx.get('agents')
        const userAgent = parentSessionId ? agents?.get(parentSessionId as SessionId) || agents?.roots().find((a: { id: string }) => a.id === parentSessionId) : undefined
        if (!userAgent) {
          if (parentSessionId) pendingReports.set(parentSessionId, report)
          console.log('[dsh-team-plan] deliver: 用户会话 agent 不可用,报告转入休眠兜底')
          return false
        }
        try {
          await ctx.subagents.followup(userAgent, taskId as SessionId, [{ type: 'text', text: '【交付报告】\n' + report + '\n\n请原样输出以上交付报告(不要修改、不要补充),然后结束。' }], { source: { kind: 'plugin', plugin: 'dsh-team-plan' }, signal: abort.signal })
          return true
        } catch (e) {
          if (parentSessionId) pendingReports.set(parentSessionId, report)
          console.log('[dsh-team-plan] deliver followup failed, 转休眠兜底: ' + String((e as Error)?.message ?? e))
          return false
        }
      },
    }, parentSessionId)
  }

  // 断点恢复:按任务会话 id 加载未完成状态
  const resume = async (taskId: string): Promise<EngineDriver | null> => {
    const loaded = await loadState(stateFile(stateDir, taskId))
    if (!loaded || loaded.phase === 'done' || loaded.phase === 'idle') return null
    const d = makeDriver(taskId, loaded.parentSessionId)
    await d.adopt(loaded)
    return d
  }

  // 用户会话 → 进行中的任务驱动(按状态里的 parentSessionId 关联)
  const findDriverForUser = (userSid: string): EngineDriver | undefined => {
    for (const d of drivers.values()) {
      const st = d.snapshot
      if (st && st.parentSessionId === userSid && st.phase !== 'done' && st.phase !== 'idle') return d
    }
    return undefined
  }

  // /tplan 命令:显式触发计划引擎
  // 命名注:官方 dsh-plan-mode 已占用 /plan(进入/离开计划模式,实测拦截本插件),
  // 故本引擎用 /tplan(team plan)避免冲突。
  ctx.commands.register({
    name: 'tplan',
    description: '计划驱动协作:Leader 拆解批次计划,确定性引擎派发 Worker 并行执行,验收后交付',
    input: { hint: '<需求描述> | status | abort' },
    handler: async ({ agent, rawInput, signal }) => {
      const sessionId = agent.id
      const text = String(rawInput ?? '').trim()
      const agents = ctx.get('agents')
      const isRoot = agents?.roots().some((r: { id: string }) => r.id === sessionId)
      if (!isRoot) return { kind: 'error', text: '子代理不支持 /tplan 命令。' }

      let driver = findDriverForUser(sessionId)

      if (text === 'abort') {
        if (!driver || !driver.snapshot || driver.snapshot.phase === 'done' || driver.snapshot.phase === 'idle') {
          return { kind: 'success', text: '当前会话没有进行中的计划,无需中止。' }
        }
        await driver.abort()
        return { kind: 'success', text: '计划已中止:未完成的批次标记为失败(用户中止),交付报告已生成。' }
      }

      if (text === 'status' || text === '') {
        if (!driver || !driver.snapshot) return { kind: 'success', text: '当前会话没有进行中的计划。用 /tplan <需求描述> 启动。' }
        const s = driver.snapshot
        if (!s.plan) return { kind: 'success', text: '计划状态:' + s.phase }
        const lines = s.plan.batches.map((b) => {
          const st = s.batches[b.id]
          return `- ${b.id} ${b.title} [${st.status} ×${st.attempts}]`
        })
        return { kind: 'success', text: `计划(${s.phase}):${s.plan.goal}\n${lines.join('\n')}` }
      }

      if (driver) {
        return { kind: 'error', text: '已有进行中的计划任务。用 /tplan status 查看进度,/tplan abort 中止。' }
      }

      // 隔离派发:创建独立任务会话(本会话的持久子代理),引擎在任务会话内运行
      let taskId: string | null = null
      try {
        const providers = ctx.subagents.list()
        const provider = providers.includes('spawn') ? 'spawn' : providers[0]
        if (!provider) return { kind: 'error', text: '无可用 subagent provider,无法创建任务会话。' }
        const spawned = await ctx.subagents.startContinuable({
          provider,
          label: '计划任务',
          request: { prompt: [{ type: 'text', text: TASK_CONTAINER_PROMPT }], parent: agent },
          signal,
        })
        taskId = spawned.childId

        const timeout = AbortSignal.timeout(config.leaderTimeoutMs)
        const r = await runLeader(askModel, text, timeout)
        if (!r.ok) {
          try { ctx.subagents.interrupt(taskId as SessionId, { kind: 'ancestor', agent }) } catch (e2) { /* 尽力清理空容器 */ }
          return { kind: 'error', text: 'Leader 无法生成合法计划:\n' + r.error }
        }
        const d = makeDriver(taskId, sessionId)
        drivers.set(taskId, d)
        await d.propose(r.plan)
        const brief = r.plan.batches.map((b) => b.id + ' ' + b.title).join(';')
        return { kind: 'success', text: `计划已派发到独立任务会话(不影响本会话):${r.plan.batches.length} 个批次 — ${brief}。完成后交付报告会回到这里。` }
      } catch (e) {
        if (taskId) { try { ctx.subagents.interrupt(taskId as SessionId, { kind: 'ancestor', agent }) } catch (e2) { /* 尽力清理 */ } }
        return { kind: 'error', text: '计划生成失败:' + String((e as Error)?.message ?? e) }
      }
    },
  })

  // 收 Worker 结算 → 驱动状态机(subagent-settled/report 消息进父 inbox)
  ctx.on('agent/inbox/inserted', async (payload) => {
    const agent = payload?.agent
    const message = payload?.message
    if (!agent || !message || !message.source) return
    const kind = message.source.kind
    if (kind !== 'subagent-settled' && kind !== 'subagent-report') return
    const childId = message.source.senderSessionId
    if (!childId) return
    const driver = drivers.get(agent.id)
    if (!driver) return

    // 产出提取:结算瞬间子代理事件可能未进入活体投影(M1 实测),延迟重读一次;
    // extractChildOutput 优先 assistant/message,兜底 assistant/chunk 的 block-end 块
    const readOutput = (): string => {
      try {
        const sessions = ctx.get('sessions')
        const child = sessions?.get(childId)
        if (child && Array.isArray(child.events)) {
          return extractChildOutput(child.events as ExtEvent[])
        }
      } catch (e) { /* 回退 */ }
      return ''
    }
    let output = readOutput()
    if (!output) {
      await new Promise((r) => setTimeout(r, 400))
      output = readOutput()
    }
    if (!output) {
      const blocks = (Array.isArray(message.content) ? message.content : []) as Array<{ type?: string; text?: string }>
      const settledText = blocks.filter((b) => b && b.type === 'text').map((b) => b.text ?? '').join('\n')
      output = stripSettledPrefix(settledText)
    }
    if (!output) return
    void driver.onChildSettled(childId, output)
  })

  // 休眠兜底:用户会话恢复活动后,把待投递的交付报告注入其下一步
  ctx.on('agent/pre-step', async (payload, next) => {
    let decision: Awaited<ReturnType<typeof next>>
    try { decision = await next() } catch (e) { return { kind: 'reject' } }
    if (!decision || decision.kind !== 'enter') return decision
    const sid = payload?.agent?.id
    if (!sid || !pendingReports.has(sid)) return decision
    const text = pendingReports.get(sid) || ''
    pendingReports.delete(sid)
    const note: UserMessage = createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    })
    return { kind: 'enter', messages: decision.messages.concat([note]) }
  })

  // 超时归因扫频:30s 一次,把超时未结算的批次记为 worker-error(消耗一轮重试)
  ctx.effect(() => {
    const t = setInterval(() => {
      for (const d of drivers.values()) void d.sweepTimeouts()
    }, 30000)
    return () => clearInterval(t)
  }, 'team-plan: timeout sweep')

  // 启动自恢复:接管所有未完成的计划状态(否则 GUI 重启后挂起批次会永久卡 running)
  ctx.effect(() => {
    void (async () => {
      try {
        const files = await readdir(stateDir).catch(() => [])
        for (const f of files) {
          if (!f.endsWith('.json')) continue
          const sid = f.slice(0, -5)
          if (drivers.has(sid)) continue
          const loaded = await loadState(path.join(stateDir, f))
          if (!loaded) continue
          if (loaded.phase === 'done' || loaded.phase === 'idle') {
            // 已完成但交付报告未投递(当时用户会话休眠)→ 转入休眠兜底
            if (loaded.phase === 'done' && !loaded.delivered && loaded.parentSessionId) {
              pendingReports.set(loaded.parentSessionId, buildReport(loaded))
              console.log('[dsh-team-plan] queued dormant delivery for ' + loaded.parentSessionId)
            }
            continue
          }
          const d = makeDriver(sid, loaded.parentSessionId)
          await d.adopt(loaded) // adopt 内含超时扫频
          drivers.set(sid, d)
          console.log('[dsh-team-plan] resumed unfinished plan for ' + sid)
        }
      } catch (e) { console.log('[dsh-team-plan] boot resume skipped: ' + String((e as Error)?.message ?? e)) }
    })()
    return () => {}
  }, 'team-plan: boot resume')

  console.log('[dsh-team-plan] 计划驱动协作引擎已装配(/tplan 命令, stateDir=' + stateDir + ')')
}

export type { Plan }
