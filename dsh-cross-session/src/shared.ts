import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionId, SurfaceEvent } from '@deepseek-ai/dsh-session'
import type { SessionQueryEngine } from '@deepseek-ai/dsh-session-query'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'

/** 本插件的消息来源标识（relay 形态：其他 agent 投递来的消息）。 */
export const PLUGIN_ID = 'dsh-cross-session'

/** 跨会话插件的结构化错误：code 供模型与调用方分支，message 面向人类。 */
export class CrossSessionError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'CrossSessionError'
    this.code = code
  }
}

/** 把消息内容块投影为纯文本（跳过 reasoning，递归展开嵌套 tool-result）。 */
export function textOf(content: readonly ContentBlock[]): string {
  let out = ''
  for (const block of content) {
    if (block.type === 'text') {
      out += block.text
    } else if (block.type === 'tool-result') {
      out += textOf(block.content)
    }
  }
  return out.trim()
}

/** 按字符上限截断，超限时以 … 结尾。 */
export function boundText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return text.slice(0, Math.max(0, maxChars - 1)) + '…'
}

export function isoTime(ms: number): string {
  return new Date(ms).toISOString()
}

export function asSessionId(id: string): SessionId {
  return id as SessionId
}

/**
 * 可选依赖：ctx.sessionQuery。由 session-query-sqlite 行提供；
 * 缺失时抛结构化错误（插件本体仍可加载，仅查询类工具不可用）。
 */
export function requireSessionQuery(ctx: Context): SessionQueryEngine {
  const sq = ctx.get('sessionQuery') as SessionQueryEngine | undefined
  if (!sq) {
    throw new CrossSessionError(
      'SESSION_QUERY_UNAVAILABLE',
      '当前部署未挂载 ctx.sessionQuery 服务（需要 session-query-sqlite 提供方）',
    )
  }
  return sq
}

/** 当前工具调用的发起 Agent（exec.agent 优先，回退 initiator 作用域）。 */
export function callerAgent(ctx: Context, exec: ToolRunContext): Agent {
  const agent = exec.agent ?? ctx.agents.currentInitiator()
  if (!agent) {
    throw new CrossSessionError('NO_CALLER_AGENT', '无法确定调用方会话：该工具必须在 agent 执行链内调用')
  }
  return agent
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 把一条表面事件投影为一行可读文本；无法投影（理论上不会发生，表面事件
 * 只有三种类型）时返回 null。
 */
export function projectSurfaceEvent(ev: SurfaceEvent): string | null {
  switch (ev.type) {
    case 'user/message': {
      const source = ev.data.source
      const isRelay = source.kind === 'plugin'
        && 'form' in source
        && (source as { form?: unknown }).form === 'relay'
      const label = isRelay ? '跨会话消息' : '用户'
      return '【' + label + '】' + textOf(ev.data.content)
    }
    case 'assistant/message':
      return '【助手】' + textOf(ev.data.message.content)
    case 'tool/result':
      return '【工具结果】' + textOf(ev.data.message.content)
  }
  return null
}
