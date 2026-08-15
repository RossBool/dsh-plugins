import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { isSurfaceEvent, type SurfaceEvent } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Config } from './index.ts'
import {
  PLUGIN_ID,
  CrossSessionError,
  asSessionId,
  boundText,
  callerAgent,
  errorMessage,
  isoTime,
  projectSurfaceEvent,
  requireSessionQuery,
} from './shared.ts'

interface ResolvedTarget {
  agent: Agent
  /** 仅当通过 autoResume 恢复了离线会话时才存在；用完必须 dispose。 */
  handle?: AgentHandle
  resumed: boolean
}

/** 解析目标会话：优先取运行中的 agent；离线且开启 autoResume 时尝试恢复。 */
async function resolveTarget(ctx: Context, config: Config, targetId: string): Promise<ResolvedTarget> {
  const live = ctx.agents.get(asSessionId(targetId))
  if (live) return { agent: live, resumed: false }
  if (!config.autoResume) {
    throw new CrossSessionError(
      'TARGET_NOT_LIVE',
      '会话 ' + targetId + ' 当前不在运行中。若要触达已持久化的离线会话，请把 autoResume 配置打开（恢复出的会话处理完消息后会被自动回收）。',
    )
  }
  try {
    const handle = await ctx.agents.resume({ resumeSessionId: asSessionId(targetId) })
    return { agent: handle.agent, handle, resumed: true }
  } catch (error) {
    throw new CrossSessionError('SESSION_RESUME_FAILED', '恢复会话 ' + targetId + ' 失败：' + errorMessage(error))
  }
}

/** 交互权限检查：自我投递、白名单、黑名单。 */
function guardAccess(config: Config, fromId: string, targetId: string): void {
  if (targetId === fromId && !config.allowSelf) {
    throw new CrossSessionError('SELF_INTERACTION_DENIED', '不允许向自己所在的会话发送消息（allowSelf=false），请选择其他会话')
  }
  if (config.allowSessionIds.length > 0 && !config.allowSessionIds.includes(targetId)) {
    throw new CrossSessionError('TARGET_NOT_ALLOWED', '会话 ' + targetId + ' 不在 allowSessionIds 白名单内')
  }
  if (config.denySessionIds.includes(targetId)) {
    throw new CrossSessionError('TARGET_DENIED', '会话 ' + targetId + ' 在 denySessionIds 黑名单内')
  }
}

/**
 * 构造一条跨会话消息：正文前附发送者信息与回复指引；
 * source 采用官方 relay 上下文形态（另一 agent 投递来的消息）。
 */
async function buildRelayMessage(ctx: Context, from: Agent, body: string): Promise<UserMessage> {
  let fromTitle: string | undefined
  try {
    const sq = requireSessionQuery(ctx)
    fromTitle = (await sq.readTitle(asSessionId(from.id)))?.title
  } catch {
    // 标题获取失败不影响投递
  }
  const header = [
    '【跨会话消息】',
    '来自会话：' + from.id + (fromTitle ? '「' + fromTitle + '」' : ''),
    '时间：' + isoTime(Date.now()),
    '若要回复，请调用 session_send 工具，把消息发回上面的会话 id。',
  ].join('\n')
  return createUserMessage({
    content: [{ type: 'text', text: header + '\n\n' + body }],
    source: { kind: 'plugin', plugin: PLUGIN_ID, form: 'relay' },
  })
}

/**
 * 后台回收 autoResume 恢复出来的会话：等它空闲后 dispose；
 * 用硬超时兜底，插件卸载时同步回收。
 */
function scheduleCleanup(ctx: Context, handle: AgentHandle, hardTimeoutMs: number): void {
  let done = false
  const dispose = () => {
    if (done) return
    done = true
    void Promise.resolve(handle.dispose()).catch(() => {})
  }
  void handle.agent.whenIdle().then(dispose, dispose)
  const timer = setTimeout(dispose, hardTimeoutMs)
  ctx.effect(() => () => {
    clearTimeout(timer)
    dispose()
  })
}

type WaitOutcome = 'idle' | 'timeout'

/** 等待目标 agent 空闲，支持调用方取消与超时；返回等待结果。 */
function waitForIdle(agent: Agent, timeoutMs: number, callerSignal: AbortSignal): Promise<WaitOutcome> {
  if (callerSignal.aborted) {
    return Promise.reject(callerSignal.reason instanceof Error ? callerSignal.reason : new Error('调用已被取消'))
  }
  return new Promise<WaitOutcome>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let settled = false
    const finish = (outcome: WaitOutcome) => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      callerSignal.removeEventListener('abort', onAbort)
      resolve(outcome)
    }
    const onAbort = () => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      reject(callerSignal.reason instanceof Error ? callerSignal.reason : new Error('调用已被取消'))
    }
    callerSignal.addEventListener('abort', onAbort, { once: true })
    timer = setTimeout(() => finish('timeout'), timeoutMs)
    void agent.whenIdle().then(
      () => finish('idle'),
      (error: unknown) => {
        if (settled) return
        settled = true
        if (timer !== undefined) clearTimeout(timer)
        callerSignal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

export function registerRelayTools(ctx: Context, config: Config): void {
  ctx.tools.register(defineTool({
    name: 'session_send',
    description:
      '向另一个会话（另一个 agent 对话）异步投递一条消息：目标会话会被唤醒，并把它作为新一轮用户输入处理，它可以用同一个工具回复你。'
      + '先用 session_list 找到目标会话 id。消息不等待对方回复，立即返回。',
    parameters: {
      sessionId: { type: 'string', required: true, description: '目标会话 id' },
      message: { type: 'string', required: true, description: '要发送的消息正文' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          delivered: { type: 'boolean', required: true },
          to: { type: 'string', required: true },
          messageId: { type: 'string', required: true },
          resumed: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: '消息已投递给会话 ' + value.to + '（messageId: ' + value.messageId
          + (value.resumed ? '；该会话此前离线，已自动恢复' : '')
          + '）。对方处理完后可能回复你；你无需等待。',
      }],
    },
    async execute(args, exec) {
      const from = callerAgent(ctx, exec)
      const target = await resolveTarget(ctx, config, args.sessionId)
      guardAccess(config, from.id, target.agent.id)
      const body = boundText(args.message, config.maxRelayChars)
      let msg: UserMessage
      try {
        msg = await buildRelayMessage(ctx, from, body)
        target.agent.followup(msg)
      } catch (error) {
        if (target.handle) void Promise.resolve(target.handle.dispose()).catch(() => {})
        if (error instanceof CrossSessionError) throw error
        throw new CrossSessionError('DELIVERY_FAILED', '投递到会话 ' + target.agent.id + ' 失败：' + errorMessage(error))
      }
      if (target.handle) scheduleCleanup(ctx, target.handle, config.askTimeoutMs)
      return { delivered: true, to: target.agent.id, messageId: msg.id, resumed: target.resumed }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'session_ask',
    description:
      '向另一个会话提问并同步等待它的完整回复：投递消息后阻塞当前步骤，直到对方会话空闲、超时或当前调用被取消。'
      + '超时时返回已产生的部分回复并标记 timedOut。'
      + '警告：不要向“会反向调用 session_ask 回来找你的会话”提问，否则双方互相等待直至超时；'
      + '纯互聊场景请用 session_send。',
    parameters: {
      sessionId: { type: 'string', required: true, description: '目标会话 id' },
      question: { type: 'string', required: true, description: '要问的问题' },
      timeoutMs: { type: 'integer', description: '等待超时（毫秒），省略则用配置 askTimeoutMs' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          to: { type: 'string', required: true },
          timedOut: { type: 'boolean', required: true },
          concurrent: { type: 'boolean', required: true },
          resumed: { type: 'boolean', required: true },
          reply: { type: 'string', required: true },
          targetEvents: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: '会话 ' + value.to + ' 的回复'
          + (value.timedOut ? '（等待超时，以下为已产生的部分回复）' : '')
          + (value.concurrent ? '（等待期间对方还处理了其他输入，回复可能混杂）' : '')
          + '：\n\n'
          + (value.reply || '（对方在等待期间没有产生新的模型可见消息）'),
      }],
    },
    async execute(args, exec) {
      const from = callerAgent(ctx, exec)
      const target = await resolveTarget(ctx, config, args.sessionId)
      guardAccess(config, from.id, target.agent.id)
      const question = boundText(args.question, config.maxRelayChars)
      const msg = await buildRelayMessage(ctx, from, question)
      try {
        target.agent.followup(msg)
      } catch (error) {
        if (target.handle) void Promise.resolve(target.handle.dispose()).catch(() => {})
        throw new CrossSessionError('DELIVERY_FAILED', '投递到会话 ' + target.agent.id + ' 失败：' + errorMessage(error))
      }
      // 投递同步完成后记录日志边界：seq >= boundary 的事件都是投递之后产生的
      const boundary = target.agent.session.events.length
      const waitMs = Math.min(Math.max(args.timeoutMs ?? config.askTimeoutMs, 1), config.askTimeoutMs)
      let outcome: WaitOutcome = 'idle'
      try {
        outcome = await waitForIdle(target.agent, waitMs, exec.signal)
      } catch (error) {
        // 调用方取消：恢复出来的会话交给后台回收，不悬挂
        if (target.handle) scheduleCleanup(ctx, target.handle, config.askTimeoutMs)
        throw error
      }
      const delta = target.agent.session.events.slice(boundary)
      const reply = delta
        .filter((ev): ev is SurfaceEvent => isSurfaceEvent(ev))
        .map(projectSurfaceEvent)
        .filter((line): line is string => line !== null)
        .join('\n\n')
      const concurrent = delta.some((ev) => ev.type === 'user/message' && ev.data.id !== msg.id)
      if (target.handle) await Promise.resolve(target.handle.dispose()).catch(() => {})
      return {
        to: target.agent.id,
        timedOut: outcome === 'timeout',
        concurrent,
        resumed: target.resumed,
        reply: boundText(reply, config.maxRecallChars),
        targetEvents: delta.length,
      }
    },
  }))
}
