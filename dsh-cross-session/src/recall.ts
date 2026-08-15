import type { Context } from '@deepseek-ai/cordis'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import type { SessionQueryEngine, SessionSearchExecContext } from '@deepseek-ai/dsh-session-query'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Config } from './index.ts'
import {
  CrossSessionError,
  asSessionId,
  boundText,
  errorMessage,
  isoTime,
  projectSurfaceEvent,
  requireSessionQuery,
} from './shared.ts'

type SearchHitRow = {
  sessionId: string
  seq: number
  type: string
  snippet: string
} & Record<string, JsonValue>

/** 全文索引被部署禁用（openAt: never）时的标准错误码。 */
function isSearchDisabledError(error: unknown): boolean {
  return typeof error === 'object' && error !== null
    && 'code' in error
    && (error as { code?: unknown }).code === 'SESSION_QUERY_SEARCH_DISABLED'
}

/** 回退扫描把关键词当作字面量正则，转义元字符避免误报/报错。 */
function escapeRegex(query: string): string {
  return query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 逐会话 filterEvents 文本扫描（不依赖 SQLite 全文索引）。 */
async function scanSearch(
  ctx: Context,
  sq: SessionQueryEngine,
  config: Config,
  query: string,
  sessionId: string | undefined,
  limit: number,
  signal: AbortSignal,
): Promise<SearchHitRow[]> {
  const hits: SearchHitRow[] = []
  const ids = sessionId
    ? [asSessionId(sessionId)]
    : (await sq.listSessions(signal)).map((record) => record.header.id)
  const pattern = escapeRegex(query)
  for (const id of ids) {
    if (hits.length >= limit) break
    let docs
    try {
      docs = await sq.filterEvents(id, [{ kind: 'text', text: pattern }])
    } catch (error) {
      // 单个会话读取失败不影响整体搜索结果
      console.warn('[cross-session] 扫描会话 ' + id + ' 失败：' + errorMessage(error))
      continue
    }
    for (const doc of docs) {
      if (hits.length >= limit) break
      hits.push({
        sessionId: id,
        seq: doc.seq,
        type: doc.type,
        snippet: boundText(doc.text, config.maxSearchSnippetChars),
      })
    }
  }
  return hits
}

export function registerRecallTools(ctx: Context, config: Config): void {
  ctx.tools.register(defineTool({
    name: 'session_list',
    description:
      '列出所有会话（运行中与已持久化的），返回 id、标题、工作目录、状态与创建时间，用于发现可交互的目标会话。'
      + '可用 query 按会话 id / 标题 / 工作目录做大小写不敏感的模糊过滤。',
    parameters: {
      query: { type: 'string', description: '可选的过滤关键词（匹配会话 id / 标题 / 工作目录）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          total: { type: 'integer', required: true },
          sessions: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: true,
              properties: {
                id: { type: 'string', required: true },
                title: { type: 'string' },
                cwd: { type: 'string' },
                live: { type: 'boolean', required: true },
                persisted: { type: 'boolean', required: true },
                createdAt: { type: 'number', required: true },
                parent: { type: 'string' },
                self: { type: 'boolean', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const lines = value.sessions.map((s) => {
          const flags = [
            s.live ? '运行中' : '已停止',
            s.persisted ? '已持久化' : '仅内存',
            s.self ? '★当前会话' : '',
          ].filter((flag) => flag !== '').join('/')
          return '- ' + s.id + '「' + (s.title ?? '') + '」cwd=' + (s.cwd ?? '-')
            + ' 创建于 ' + isoTime(s.createdAt) + ' ' + flags
            + (s.parent !== undefined ? ' parent=' + s.parent : '')
        })
        return [{
          type: 'text',
          text: boundText('共 ' + value.total + ' 个会话：\n' + lines.join('\n'), config.maxRecallChars),
        }]
      },
    },
    async execute(args, exec) {
      const sq = requireSessionQuery(ctx)
      const records = await sq.listSessions(exec.signal)
      const ids = records.map((record) => record.header.id)
      const titleResults = await sq.readTitleSnapshots(ids, exec.signal)
      const titles = new Map<string, string>()
      for (const result of titleResults) {
        if (result.status === 'fulfilled' && result.value.title) {
          titles.set(result.sessionId, result.value.title.title)
        }
      }
      const selfId = exec.agent?.id
      const keyword = args.query?.trim().toLowerCase()
      const rows = []
      for (const record of records) {
        const header = record.header
        const title = titles.get(header.id)
        if (keyword) {
          const haystack = header.id + ' ' + (title ?? '') + ' ' + (header.cwd ?? '')
          if (!haystack.toLowerCase().includes(keyword)) continue
        }
        rows.push({
          id: header.id,
          ...(title !== undefined ? { title } : {}),
          ...(header.cwd !== undefined ? { cwd: header.cwd } : {}),
          live: record.live,
          persisted: record.persisted,
          createdAt: header.createdAt,
          ...(header.parentSession !== undefined ? { parent: header.parentSession } : {}),
          self: header.id === selfId,
        })
      }
      return { total: rows.length, sessions: rows }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'session_read',
    description:
      '读取另一个会话最近的消息记录（模型可见表面：用户 / 助手 / 工具结果），用于了解对方会话的上下文或回顾其结论。'
      + '返回纯文本转录，受 maxRecallChars 限制。',
    parameters: {
      sessionId: { type: 'string', required: true, description: '要读取的会话 id' },
      limit: { type: 'integer', description: '最多读取最近多少条消息，默认 20' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          sessionId: { type: 'string', required: true },
          title: { type: 'string' },
          readCount: { type: 'integer', required: true },
          text: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: '会话 ' + value.sessionId + (value.title ? '「' + value.title + '」' : '')
          + ' 最近 ' + value.readCount + ' 条消息：\n\n'
          + (value.text || '（该会话没有可读的表面消息）'),
      }],
    },
    async execute(args, exec) {
      const sq = requireSessionQuery(ctx)
      const limit = Math.min(Math.max(args.limit ?? 20, 1), config.maxReadMessages)
      const snapshot = await sq.readSurface(asSessionId(args.sessionId))
      const events = snapshot.events.slice(-limit)
      const lines: string[] = []
      for (const ev of events) {
        const projected = projectSurfaceEvent(ev)
        if (projected !== null) lines.push('[seq ' + ev.seq + '] ' + projected)
      }
      let title: string | undefined
      try {
        title = (await sq.readTitle(asSessionId(args.sessionId)))?.title
      } catch {
        title = undefined
      }
      return {
        sessionId: args.sessionId,
        ...(title !== undefined ? { title } : {}),
        readCount: events.length,
        text: boundText(lines.join('\n\n'), config.maxRecallChars),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'session_search',
    description:
      '在会话记录中搜索关键词（跨所有会话，或限定某个会话）。优先用全文索引；索引未启用时自动回退为逐会话文本扫描。'
      + '返回命中位置与片段。',
    parameters: {
      query: { type: 'string', required: true, description: '搜索关键词' },
      sessionId: { type: 'string', description: '可选：只搜这个会话' },
      limit: { type: 'integer', description: '最多返回多少条命中，默认 20' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          engine: { type: 'string', required: true },
          query: { type: 'string', required: true },
          total: { type: 'integer', required: true },
          hits: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: true,
              properties: {
                sessionId: { type: 'string', required: true },
                seq: { type: 'integer', required: true },
                type: { type: 'string', required: true },
                snippet: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const lines = value.hits.map((h) => '- ' + h.sessionId + ' seq=' + h.seq + ' [' + h.type + '] ' + h.snippet)
        return [{
          type: 'text',
          text: boundText(
            '搜索「' + value.query + '」命中 ' + value.total + ' 条（引擎：' + value.engine + '）：\n' + lines.join('\n'),
            config.maxRecallChars,
          ),
        }]
      },
    },
    async execute(args, exec) {
      const sq = requireSessionQuery(ctx)
      const limit = Math.min(Math.max(args.limit ?? config.maxSearchResults, 1), config.maxSearchResults)
      const query = args.query.trim()
      if (!query) throw new CrossSessionError('INVALID_QUERY', '搜索关键词不能为空')
      const execCtx: SessionSearchExecContext = { signal: exec.signal }
      let engine: 'fts' | 'scan' = 'fts'
      let hits: SearchHitRow[] = []
      if (args.sessionId) {
        try {
          const page = await sq.searchEvents({ sessionId: asSessionId(args.sessionId), query, limit }, execCtx)
          hits = page.items.map((item) => ({
            sessionId: args.sessionId as string,
            seq: item.seq,
            type: item.type,
            snippet: boundText(item.snippet, config.maxSearchSnippetChars),
          }))
        } catch (error) {
          if (!isSearchDisabledError(error)) throw error
          engine = 'scan'
        }
      } else {
        try {
          const page = await sq.searchSessions({ query, limit }, execCtx)
          hits = page.items.map((item) => ({
            sessionId: item.header.id,
            seq: item.bestMatch.seq,
            type: item.bestMatch.type,
            snippet: boundText(item.bestMatch.snippet, config.maxSearchSnippetChars),
          }))
        } catch (error) {
          if (!isSearchDisabledError(error)) throw error
          engine = 'scan'
        }
      }
      if (engine === 'scan') {
        hits = await scanSearch(ctx, sq, config, query, args.sessionId, limit, exec.signal)
      }
      return { engine, query, total: hits.length, hits }
    },
  }))
}

