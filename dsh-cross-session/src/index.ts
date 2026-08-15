import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { registerRelayTools } from './relay.ts'
import { registerRecallTools } from './recall.ts'

export const name = 'cross-session'

export interface Config {
  /** 插件总开关；false 时不注册任何工具。 */
  enabled: boolean
  /** 允许交互的会话白名单；空数组 = 不限。 */
  allowSessionIds: string[]
  /** 拒绝交互的会话黑名单。 */
  denySessionIds: string[]
  /** 是否允许会话给自己发消息（默认禁止）。 */
  allowSelf: boolean
  /** 发送消息正文的最大字符数。 */
  maxRelayChars: number
  /** 读取/回复/搜索结果输出的最大字符数。 */
  maxRecallChars: number
  /** session_read 单次最多读取的消息条数。 */
  maxReadMessages: number
  /** session_search 单次最多返回的命中数。 */
  maxSearchResults: number
  /** session_search 单条命中片段的最大字符数。 */
  maxSearchSnippetChars: number
  /** session_ask 等待对方会话空闲的超时（毫秒）。 */
  askTimeoutMs: number
  /** 目标会话不在运行时，是否自动恢复已持久化的会话（处理完后自动回收）。 */
  autoResume: boolean
}

export const Config: Schema<Config> = Schema.object({
  enabled: Schema.boolean().default(true),
  allowSessionIds: Schema.array(Schema.string()).default([]),
  denySessionIds: Schema.array(Schema.string()).default([]),
  allowSelf: Schema.boolean().default(false),
  maxRelayChars: Schema.number().default(8000),
  maxRecallChars: Schema.number().default(30000),
  maxReadMessages: Schema.number().default(50),
  maxSearchResults: Schema.number().default(20),
  maxSearchSnippetChars: Schema.number().default(300),
  askTimeoutMs: Schema.number().default(300000),
  autoResume: Schema.boolean().default(false),
})

export const inject = ['tools', 'agents']

export function apply(ctx: Context, config: Config) {
  if (!config.enabled) {
    console.log('[cross-session] 插件已禁用（enabled=false），不注册工具')
    return
  }
  registerRelayTools(ctx, config)
  registerRecallTools(ctx, config)
  console.log('[cross-session] 跨会话交互插件已加载：session_list / session_read / session_search / session_send / session_ask')
}

