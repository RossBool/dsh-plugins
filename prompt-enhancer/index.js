/**
 * prompt-enhancer — 提示词增强插件（重构版）
 *
 * 用 LLM 把一条粗略的提示词改写成更清晰、更高质量的它本身（同语言、同形态、同意图，
 * 只提升清晰度）。四个入口共享同一增强核心：
 *   1. POST /api/enhance-prompt —— 输入框按钮专用 HTTP 路由（JSON 无损传输、
 *      单一请求-响应、端到端 abort；仅当 webServer 服务存在时注册）
 *   2. /enhance <prompt>         —— 斜杠命令（同步增强，直接返回结果）
 *   3. enhance_prompt            —— 模型可用工具（agent 在任务模糊时先增强再执行）
 *   4. autoEnhance 配置开启后    —— agent/pre-step 自动增强（fail-open）
 *
 * 相对上一版的重构（见 docs/enhance-prompt-refactor-review.md）：
 *   - 删除 job 表与 /enhance-start、/enhance-poll：模块级状态在 ?rev 热替换下丢任务、
 *     无取消、轮询重；改为单请求 HTTP 路由 + 端到端 abort；
 *   - 新增 stripWrappingQuotes（FR-10）、用量/耗时日志（FR-11）、缓存命中观测；
 *   - 模型路由解析链：显式配置 → 会话/agent 上下文 → agentDefaultModel 当前选择；
 *   - 安全层：Origin/Sec-Fetch-Site 跨站校验、请求体上限、并发上限；
 *   - abort 形态修正：adapter 在取消时是「迭代抛 LlmError(ABORTED)」而非 finish 块
 *     （dsh-llm-deepseek），错误处理同时覆盖两条路径；
 *   - 客户端断开检测用 res 'close' + !writableEnded（实测 req 'close' 在请求体
 *     读完时立即触发，不是断开信号——见排查记录）。
 *
 * 配置：cordis.yml 的 config: 字段（组合层）+ 设置界面 prompt-enhancer 命名空间（用户层）。
 *
 * @module prompt-enhancer
 */
import { createUserMessage, BlockAssembler } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'

export const name = 'prompt-enhancer'

/** 依赖的服务：LLM 运行时、工具注册表、agent 注册表（pre-step 事件）、系统提示词、斜杠命令。webServer/settings 为可选能力。 */
export const inject = ['llm', 'tools', 'agents', 'systemPrompt', 'commands']

/** 插件配置：凡是不同部署可能取不同值的参数都定义在这里。 */
export const Config = z.object({
  /** 自动增强进入 agent 的用户消息（默认关闭，避免意外的 LLM 调用）。 */
  autoEnhance: z.boolean().default(false),
  /** 增强调用使用的 provider 路由；缺省时依次跟随会话模型、harness 默认模型。 */
  provider: z.string().min(1),
  /** 增强调用使用的模型；必须与 provider 成对配置。 */
  model: z.string().min(1),
  /** 增强调用的最大输出 token 数。 */
  maxTokens: z.number().step(1).min(64).max(32768).default(1024),
  /** 增强调用超时（毫秒）。 */
  timeoutMs: z.number().step(1).min(1000).max(600000).default(30000),
  /** 增强调用采样温度。 */
  temperature: z.number().min(0).max(2).default(0.3),
  /** 推理强度；改写任务默认 'off'（省 token 省延迟）。模型不支持时自动回退到默认。 */
  reasoningEffort: z.string().default('off'),
  /** 自动增强时是否把原文附在增强结果后面供模型核对。 */
  includeOriginal: z.boolean().default(true),
  /** 增强结果的输出语言：'auto' 保持原文语言，或指定如 'zh'、'en'。 */
  language: z.string().min(1).default('auto'),
  /** 自动增强的最短消息长度：低于此长度（如"继续"、"/compact"）原样放行。 */
  minLength: z.number().step(1).min(1).max(10000).default(12),
  /** 是否向系统提示词注册说明段。 */
  section: z.boolean().default(true),
  /** 自定义增强指令；非空时替换内置指令。 */
  system: z.string().default(''),
})

// ============================================================================
// 纯函数区（@pure-start … @pure-end：无 import 依赖，供 node --test 直接抽取执行）
// ============================================================================
// @pure-start

/** 默认增强系统提示词（固定文本保前缀缓存；被 config.system 覆盖时不再使用）。 */
const DEFAULT_SYSTEM = [
  'You are an expert prompt editor. Rewrite the user\u2019s text into a better version of ITSELF: same language, same form (prose stays prose, lists stay lists, code stays code), same intent \u2014 only the clarity improves.',
  '',
  'Rules:',
  '1. PRESERVE the original form and voice. Do NOT restructure the text into labeled sections (no 角色/目标/背景/步骤/约束/输出格式, no "Role/Goal/Steps"), do NOT add headings, templates, or a new skeleton. A sentence in \u2192 a better sentence out.',
  '2. PRESERVE all information and intent. Do not invent tasks, requirements, or facts the user did not provide. Where the text is vague, disambiguate inline with brief, explicit assumptions.',
  '3. LANGUAGE CONSISTENCY IS THE HIGHEST PRIORITY: reply in the language of the user\u2019s input (中文输入→中文回复; English input→English reply; mixed input may follow the mix). Never switch languages.',
  '4. Keep the result at the same order of magnitude as the input: a 20-character prompt should not become 200 characters. Expand only where the input is genuinely underspecified.',
  '5. Do not answer the prompt or explain how to do things \u2014 rewrite it. Focus on WHAT, not HOW.',
  '6. Do not wrap the rewritten text in quotes or any decoration.',
  '7. If the input contains code in triple backticks (```), treat it as a code sample and keep it unchanged.',
  '',
  'Output rules:',
  '- Output ONLY the envelope: <enhanced-prompt>rewritten text here</enhanced-prompt>.',
  '- No explanations, no commentary, no Markdown fences, no text outside the tags.',
  '',
  'Examples:',
  'Input: "帮我写个爬虫"',
  'Output: "<enhanced-prompt>帮我写一个爬虫：抓取指定网页的正文内容，去重后保存为本地文件。</enhanced-prompt>"',
  '',
  'Input: "Can you fix the bug"',
  'Output: "<enhanced-prompt>Please fix the bug in this project: locate the failing code path, correct it, and explain the fix in one sentence.</enhanced-prompt>"',
].join('\n')

/** 带稳定 code 的业务错误：四个入口统一 catch 后按 code 映射为契约错误码。 */
function enhanceFailure(code, message) {
  const error = new Error('prompt-enhancer: ' + message)
  error.code = code
  return error
}

/** provider / model 必须成对配置（允许两者同时缺省）。 */
function validateRoutePair(config) {
  const hasProvider = config?.provider !== undefined && config?.provider !== null && String(config.provider).trim() !== ''
  const hasModel = config?.model !== undefined && config?.model !== null && String(config.model).trim() !== ''
  if (hasProvider !== hasModel) throw new Error('prompt-enhancer: provider 与 model 必须成对配置')
}

/**
 * 解析增强调用使用的模型路由，优先级：
 *   1. 显式配置（部署级覆盖）；
 *   2. 会话/agent 上下文（工具、命令、autoEnhance 用 agent.options；HTTP 路由用请求体）；
 *   3. harness 默认模型（agentDefaultModel.currentSelection()）。
 * 返回 undefined 表示无可用路由（调用方映射为 provider_unavailable）。
 */
function resolveRoute(config, contextRoute, defaultSelection) {
  if (config.provider && config.model) return { provider: config.provider, model: config.model }
  if (contextRoute && contextRoute.provider && contextRoute.model) return { provider: contextRoute.provider, model: contextRoute.model }
  if (defaultSelection && defaultSelection.provider && defaultSelection.model) {
    return { provider: defaultSelection.provider, model: defaultSelection.model }
  }
  return undefined
}

/**
 * 语言检测：输入语言是可计算的事实，不委托给 LLM 猜（'auto' 曾导致英文输入
 * 整段漂移成中文）。含 CJK 字符即判中文，否则英文。
 */
function detectLanguage(text) {
  if (typeof text !== 'string' || text.length === 0) return 'en'
  return /[\u4e00-\u9fff\u3400-\u4dbf]/.test(text) ? 'zh' : 'en'
}

/**
 * 把增强输入框成 JSON + 尾部语言指令（双层语言约束的第二层）：
 * JSON 保证用户文本无法破坏结构边界；尾部的语言指令是 WorkBuddy 被真实
 * 语言漂移问题打出来的补丁——单靠 system prompt 一条规则不够，英文输入
 * 曾整段漂移成中文，尾部指令利用 recency 效应压住漂移。
 */
function frameInput(input) {
  const language = input?.language ?? 'auto'
  const directive = language === 'auto'
    ? 'CRITICAL PRIORITY \u2014 LANGUAGE CONSISTENCY: detect the language of the USER INPUT field and reply ONLY in that language (Chinese input \u2192 Chinese reply; English input \u2192 English reply; mixed input may follow the mix). Language consistency outranks every other consideration.'
    : 'CRITICAL PRIORITY \u2014 LANGUAGE CONSISTENCY: the enhanced text must be written in ' + (language === 'zh' ? 'Chinese (中文)' : 'English') + '. Reply ONLY in that language. Language consistency outranks every other consideration.'
  return 'Enhance the raw prompt described by this JSON object. Use the optional fields, when present, to sharpen the enhancement.\n'
    + JSON.stringify(input, null, 2)
    + '\n\n'
    + directive
}

/**
 * 去掉一层包裹引号（FR-10）：LLM 常把整个输出用引号包起来，回填前剥掉。
 * 支持中英文单双引号与中文书名引号；只剥一层；剥空则保留原样。
 */
function stripWrappingQuotes(text) {
  if (text === null || text === undefined) return ''
  const out = String(text).trim()
  if (out.length < 2) return out
  const pairs = [['"', '"'], ["'", "'"], ['“', '”'], ['‘', '’'], ['「', '」'], ['『', '』']]
  for (const [open, close] of pairs) {
    if (out.startsWith(open) && out.endsWith(close)) {
      const inner = out.slice(open.length, out.length - close.length).trim()
      return inner.length > 0 ? inner : out
    }
  }
  return out
}

/**
 * 输出信封解析：优先取 <enhanced-prompt>…</enhanced-prompt> 标签内内容
 * （官方 /enhance-prompt 的协议，抗"模型带前缀/后缀唠叨"）；模型未按协议
 * 输出时退回全文（fail-open，再由上层 stripWrappingQuotes 清理引号）。
 * 取第一对完整标签之间的内容；无完整标签对或内层为空 → 原样返回。
 */
function extractEnhancedText(text) {
  if (typeof text !== 'string' || text.length === 0) return ''
  const open = '<enhanced-prompt>'
  const close = '</enhanced-prompt>'
  const start = text.indexOf(open)
  if (start === -1) return text
  const contentStart = start + open.length
  const end = text.indexOf(close, contentStart)
  if (end === -1) return text
  const inner = text.slice(contentStart, end).trim()
  return inner.length > 0 ? inner : text
}

/** 把非正常结束原因翻译成带 code 的错误（finish 块路径），保留上游机器码。 */
function finishError(finish) {
  const code = finish.failure?.code
  switch (finish.kind) {
    case 'stop': return undefined
    case 'aborted': return enhanceFailure('aborted', '增强调用失败: ' + (finish.failure?.message ?? 'aborted'))
    case 'error':
      if (code === 'TIMEOUT') return enhanceFailure('timeout', '增强调用超时')
      if (code === 'UNSUPPORTED_REASONING_EFFORT') return enhanceFailure('unsupported_effort', finish.failure?.message ?? '模型不支持指定的 reasoning effort')
      return enhanceFailure('llm_error', '增强调用失败: ' + (finish.failure?.message ?? 'error'))
    case 'max-tokens': return enhanceFailure('max_tokens', '增强调用触达 maxTokens 上限')
    case 'tool-calls': return enhanceFailure('tool_calls', '增强模型意外请求了工具')
    default: return enhanceFailure('llm_error', '增强调用以 "' + String(finish.kind) + '" 结束')
  }
}

/**
 * 把增强流迭代中抛出的错误归一化（迭代抛错路径）：
 * adapter 在取消/超时时抛 LlmError(code:'ABORTED'|'TIMEOUT') 而非 finish 块。
 */
function mapCaughtError(error) {
  const code = error && typeof error === 'object' ? error.code : undefined
  if (code === 'ABORTED') return enhanceFailure('aborted', '增强调用被取消')
  if (code === 'TIMEOUT') return enhanceFailure('timeout', '增强调用超时')
  if (error instanceof Error) return error
  return enhanceFailure('llm_error', '增强调用失败: ' + String(error))
}

// @pure-end
// ============================================================================

/** 通过共享 LLM 服务完成一次增强；返回 { text, usage, elapsedMs }，失败时抛出带 code 的错误。 */
async function enhanceCore(ctx, config, input, route, sessionId, signal) {
  const runOnce = async (reasoningEffort) => {
    signal?.throwIfAborted?.()
    const started = Date.now()
    // 'auto' 语言在服务端落成具体值（可计算的事实不委托 LLM）
    const resolvedInput = input?.language === 'auto'
      ? { ...input, language: detectLanguage(input?.prompt) }
      : input
    const messages = [createUserMessage({
      content: [{ type: 'text', text: frameInput(resolvedInput) }],
      source: { kind: 'plugin', plugin: name },
    })]
    const options = {
      provider: route.provider,
      model: route.model,
      messages,
      system: config.system && config.system.trim() ? config.system : DEFAULT_SYSTEM,
      maxTokens: config.maxTokens,
      temperature: config.temperature,
      signal,
      ...(reasoningEffort !== undefined && reasoningEffort !== null && String(reasoningEffort) !== ''
        ? { reasoningEffort: String(reasoningEffort) }
        : {}),
      ...(sessionId !== undefined && sessionId !== null ? { sessionId } : {}),
    }
    const assembler = new BlockAssembler()
    try {
      for await (const chunk of ctx.llm.stream(options)) assembler.push(chunk)
      const failure = finishError(assembler.finish)
      if (failure !== undefined) throw failure
      const raw = assembler.blocks()
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('')
        .trim()
      if (!raw) throw enhanceFailure('empty_result', '增强调用没有产生文本输出')
      const text = extractEnhancedText(raw).trim()
      return { text, usage: assembler.usage, elapsedMs: Date.now() - started }
    } catch (error) {
      if (error?.code !== undefined) throw error // 已是归一化业务错误（含 abort/timeout/empty_result）
      throw mapCaughtError(error)
    }
  }
  // 模型不支持配置的 reasoning effort 时回退到默认并重试一次（不同 provider 的 effort id 不同）
  const effort = config.reasoningEffort !== undefined && config.reasoningEffort !== null && String(config.reasoningEffort) !== ''
    ? String(config.reasoningEffort)
    : undefined
  if (effort === undefined) return runOnce(undefined)
  try {
    return await runOnce(effort)
  } catch (error) {
    if (error?.code === 'unsupported_effort') return runOnce(undefined)
    throw error
  }
}

/** 组装自动增强后进入模型的消息正文。 */
function composeAutoText(enhanced, original, config) {
  if (!config.includeOriginal) return enhanced
  return [
    enhanced,
    '',
    '--- 原始用户消息（供核对；上方增强后的提示词为准） ---',
    original,
  ].join('\n')
}

/** 系统提示词说明段（每次组装时按当前配置求值）。 */
function sectionText(config) {
  const lines = [
    'A prompt-enhancement system (prompt-enhancer) is active in this session.',
    '- The user can run /enhance <prompt> to rewrite a raw prompt into a clearer, higher-quality version of itself (same language, same form, same intent).',
    '- Use the enhance_prompt tool when a task is vague or the user asks to improve/optimize/enhance a prompt (提示词增强/提示词优化) before executing it.',
  ]
  if (config.autoEnhance) {
    lines.push('- Incoming user messages are auto-enhanced before you see them: treat the enhanced version as the authoritative task specification and the original (kept for reference) as supporting context.')
  }
  return lines.join('\n')
}

/** 自动增强：注册 agent/pre-step 监听器，替换进入步骤的用户消息。 */
function registerAutoEnhance(ctx, getConfig, log) {
  return ctx.on('agent/pre-step', async ({ agent, messages, step, signal }, next) => {
    const decision = await next()
    if (decision.kind !== 'enter' || step !== 1 || signal.aborted) return decision
    const config = getConfig()
    const humanIndexes = []
    const attachments = []
    let original = ''
    messages.forEach((message, index) => {
      if (!message.source || message.source.kind !== 'user') return
      humanIndexes.push(index)
      for (const block of message.content ?? []) {
        if (block && block.type === 'text') original += (original ? '\n\n' : '') + block.text
        else if (block) attachments.push(block)
      }
    })
    original = original.trim()
    if (humanIndexes.length === 0 || !original) return decision
    // 短消息与控制指令（"继续"、"/compact" 等）原样放行
    if (original.length < config.minLength || original.startsWith('/')) return decision
    try {
      const contextRoute = agent?.options?.provider && agent?.options?.model
        ? { provider: agent.options.provider, model: agent.options.model }
        : undefined
      const route = resolveRoute(config, contextRoute, ctx.get('agentDefaultModel')?.currentSelection?.())
      if (route === undefined) throw enhanceFailure('provider_unavailable', '没有可用的模型路由')
      const callSignal = combinedSignal(signal, config.timeoutMs)
      const result = await enhanceCore(ctx, config, { prompt: original, language: config.language }, route, agent?.id, callSignal)
      const injected = createUserMessage({
        content: [{ type: 'text', text: composeAutoText(result.text, original, config) }, ...attachments],
        source: {
          kind: 'plugin',
          plugin: name,
          form: 'snapshot',
          sections: [{ name: 'auto-enhanced', text: result.text }],
        },
      })
      const nextMessages = decision.messages.filter((_, index) => !humanIndexes.includes(index))
      nextMessages.splice(Math.min(humanIndexes[0], nextMessages.length), 0, injected)
      return { kind: 'enter', messages: nextMessages }
    } catch (error) {
      // 增强失败时放行原文（fail-open），绝不阻塞用户任务
      log.warn('自动增强失败，原样放行用户消息:', error)
      return decision
    }
  }, { prepend: true })
}

/** 组合取消信号与超时信号。 */
function combinedSignal(base, timeoutMs) {
  const timer = AbortSignal.timeout(timeoutMs)
  return base ? AbortSignal.any([base, timer]) : timer
}

/** 从 agent 上下文提取会话模型路由（工具/命令入口用）。 */
function contextRouteOf(agent) {
  if (agent?.options?.provider && agent?.options?.model) {
    return { provider: agent.options.provider, model: agent.options.model }
  }
  return undefined
}

// ----------------------------------------------------------------------------
// HTTP 路由：POST /api/enhance-prompt —— 输入框按钮专用传输
// ----------------------------------------------------------------------------

const MAX_BODY_BYTES = 64 * 1024
const MAX_INFLIGHT = 4

/** 防御性 JSON 响应：客户端断开后写入静默失败，不抛错。 */
function sendJson(res, status, payload) {
  if (res.writableEnded || res.destroyed) return
  try {
    const body = JSON.stringify(payload)
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' })
    res.end(body)
  } catch {
    /* 客户端已断开：静默 */
  }
}

/** 读取请求体（Buffer 拼接，上限 MAX_BODY_BYTES）。超限返回 null。 */
async function readBody(req) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > MAX_BODY_BYTES) return null
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * 单个增强请求的完整处理：守卫 → 解析 → 路由解析 → 增强 → 响应。
 *
 * 客户端断连检测：res 'close' 且 !writableEnded = 客户端在响应写完前断开
 * （浏览器 fetch abort / 页面关闭）→ abortController → llm.stream 全链路传播。
 * 注意：不能用 req 'close'——实测该事件在请求体读完时立即触发（req.complete=true），
 * 是消息生命周期事件而非断开信号。
 */
async function handleEnhanceRequest(ctx, getConfig, req, res, gate, log) {
  // 1. 方法守卫
  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, code: 'unknown', error: 'method not allowed' })
    return
  }
  // 2. 跨站守卫：浏览器跨站 simple POST 无 CORS 门槛即可送达（表单/text-plain），
  //    校验 Origin 与 Sec-Fetch-Site，防止恶意网页刷本机 LLM 额度。
  const origin = req.headers.origin
  const host = req.headers.host ?? ''
  if (origin !== undefined) {
    let sameOrigin = false
    try { sameOrigin = new URL(origin).host === host } catch { /* 非法 Origin 一律拒绝 */ }
    if (!sameOrigin) {
      sendJson(res, 403, { ok: false, code: 'unknown', error: 'cross-origin request rejected' })
      return
    }
  }
  if (req.headers['sec-fetch-site'] === 'cross-site') {
    sendJson(res, 403, { ok: false, code: 'unknown', error: 'cross-origin request rejected' })
    return
  }
  // 3. 并发上限
  if (!gate.tryAcquire()) {
    sendJson(res, 429, { ok: false, code: 'rate_limited', error: '并发增强过多，请稍后再试' })
    return
  }
  const abortController = new AbortController()
  const onResponseClose = () => {
    // 响应未写完就关闭 = 客户端在飞行中断开/取消
    if (!res.writableEnded) abortController.abort()
  }
  res.on('close', onResponseClose)
  let timeoutSignal = undefined
  try {
    // 4. 读 body 并解析
    const raw = await readBody(req)
    if (raw === null) {
      sendJson(res, 413, { ok: false, code: 'unknown', error: '请求体过大' })
      return
    }
    let body
    try {
      body = JSON.parse(raw)
    } catch {
      sendJson(res, 400, { ok: false, code: 'unknown', error: '请求体不是合法 JSON' })
      return
    }
    const text = typeof body?.text === 'string' ? body.text : ''
    if (!text.trim()) {
      sendJson(res, 400, { ok: false, code: 'empty_input', error: '输入为空' })
      return
    }
    // 5. 模型路由：显式配置 → 请求体（会话当前选中模型） → harness 默认
    const config = getConfig()
    const sessionRoute = typeof body?.provider === 'string' && typeof body?.model === 'string'
      ? { provider: body.provider, model: body.model }
      : undefined
    const route = resolveRoute(config, sessionRoute, ctx.get('agentDefaultModel')?.currentSelection?.())
    if (route === undefined) {
      sendJson(res, 400, { ok: false, code: 'provider_unavailable', error: '没有可用的模型路由' })
      return
    }
    const known = ctx.llm.listProviders().some((p) => p.id === route.provider)
    if (!known) {
      sendJson(res, 400, { ok: false, code: 'provider_unavailable', error: 'provider 未注册: ' + route.provider })
      return
    }
    // 6. 增强（超时 + 客户端断开双信号）
    timeoutSignal = AbortSignal.timeout(config.timeoutMs)
    const signal = AbortSignal.any([abortController.signal, timeoutSignal])
    const sessionId = typeof body?.sessionId === 'string' && body.sessionId ? body.sessionId : undefined
    const result = await enhanceCore(ctx, config, { prompt: text, language: config.language }, route, sessionId, signal)
    const cleaned = stripWrappingQuotes(result.text)
    if (!cleaned) {
      sendJson(res, 502, { ok: false, code: 'llm_error', error: '增强结果为空' })
      return
    }
    log.info('enhance ok', {
      provider: route.provider,
      model: route.model,
      inputChars: text.length,
      outputChars: cleaned.length,
      elapsedMs: result.elapsedMs,
      inputTokens: result.usage?.inputTokens,
      outputTokens: result.usage?.outputTokens,
      cacheReadTokens: result.usage?.cacheReadTokens,
      cacheWriteTokens: result.usage?.cacheWriteTokens,
    })
    sendJson(res, 200, { ok: true, text: cleaned })
  } catch (error) {
    const clientAborted = abortController.signal.aborted && !(timeoutSignal?.aborted ?? false)
    const timedOut = (timeoutSignal?.aborted ?? false) || error?.code === 'timeout'
    if (clientAborted) {
      // 用户取消/断开：静默，无响应可写
      log.debug('enhance aborted by client')
    } else if (timedOut) {
      log.warn('enhance timeout', { timeoutMs: getConfig().timeoutMs })
      sendJson(res, 504, { ok: false, code: 'timeout', error: '增强超时' })
    } else if (error?.code === 'provider_unavailable') {
      sendJson(res, 400, { ok: false, code: 'provider_unavailable', error: error.message })
    } else if (error?.code === 'empty_result') {
      sendJson(res, 502, { ok: false, code: 'llm_error', error: error.message })
    } else {
      log.warn('enhance failed:', error?.message ?? error)
      sendJson(res, 502, { ok: false, code: 'llm_error', error: error?.message ?? '增强失败' })
    }
  } finally {
    res.off('close', onResponseClose)
    gate.release()
  }
}

/**
 * 注册 /api/enhance-prompt 路由（webServer 为可选能力）。
 *
 * 健壮性（2026-08-15 修复）：webServer 是独立纤维提供的服务，apply() 运行时它可能
 * 尚未就绪。旧实现遇到 undefined 直接跳过且永不重试——重启后的启动窗口内，HTTP 服务
 * 已监听但路由未认领，fallback 对 /api/enhance-prompt 统一回 404，按钮持续失败直到
 * 下一次插件热重载才恢复。现在改为：
 *   1. apply 时立即尝试注册；
 *   2. 未就绪则监听 Cordis 'internal/service' 事件，webServer 一出现就注册；
 *   3. webServer 服务实例被替换（自身热重载）时自动摘旧挂新。
 */
function registerEnhanceRoute(ctx, getConfig, log) {
  let current = null
  let dispose = () => {}
  const adopt = (server) => {
    if (!server || typeof server.register !== 'function' || server === current) return
    dispose() // 服务实例被替换时先摘掉旧注册
    const gate = {
      count: 0,
      tryAcquire() {
        if (this.count >= MAX_INFLIGHT) return false
        this.count += 1
        return true
      },
      release() {
        if (this.count > 0) this.count -= 1
      },
    }
    const routeDispose = server.register({
      kind: 'exact',
      path: '/api/enhance-prompt',
      handler: (req, res) => handleEnhanceRequest(ctx, getConfig, req, res, gate, log),
    })
    dispose = routeDispose
    current = server
    log.info('已注册 POST /api/enhance-prompt')
  }
  adopt(ctx.get('webServer'))
  const cancel = ctx.on('internal/service', (name, value) => {
    if (name === 'webServer') adopt(value)
  })
  const cleanup = () => {
    cancel()
    dispose()
  }
  return ctx.effect(() => cleanup, 'prompt-enhancer: /api/enhance-prompt route')
}

// ----------------------------------------------------------------------------
// 插件入口
// ----------------------------------------------------------------------------

export function apply(ctx, config) {
  validateRoutePair(config)
  const log = ctx.logger(name)

  // 实时配置：cordis.yml 配置作为组合层，设置界面（settings 命名空间）作为用户层
  let live = config
  let disposeAuto = () => {}
  const refreshAuto = () => {
    disposeAuto()
    if (live.autoEnhance) disposeAuto = registerAutoEnhance(ctx, () => live, log)
  }
  const settingsService = ctx.get('settings')
  if (settingsService && typeof settingsService.register === 'function') {
    try {
      const scope = settingsService.register('prompt-enhancer', Config, {
        base: config,
        applies: 'live',
        validate: validateRoutePair,
      })
      live = scope.get()
      scope.watch((next) => {
        live = next
        refreshAuto()
      })
    } catch (error) {
      log.warn('settings 命名空间注册失败，仅使用 cordis.yml 配置:', error)
    }
  }
  refreshAuto()

  // 1. 系统提示词说明段（order 500，避开 100–199 的工具指引区）
  if (live.section) {
    ctx.systemPrompt.section({
      name,
      order: 500,
      text: () => sectionText(live),
    })
  }

  // 2. 模型可用工具
  ctx.tools.register(defineTool({
    name: 'enhance_prompt',
    description: 'Enhance a raw prompt into a clearer, higher-quality version of itself using an LLM: same language, same form, same intent, better clarity. Use it when the user asks to improve/optimize/enhance a prompt (提示词增强/提示词优化), or when a task is vague and would benefit from inline disambiguation. Returns the enhanced text.',
    parameters: {
      prompt: { type: 'string', required: true, description: '要增强的原始提示词。' },
      goal: { type: 'string', description: '期望达成的目标（原文未明确时补充）。' },
      context: { type: 'string', description: '补充背景信息。' },
      requirements: { type: 'array', items: { type: 'string' }, description: '额外约束或要求。' },
      language: { type: 'string', description: "增强结果的输出语言：'auto' 保持原文语言，或指定如 'zh'、'en'。默认 'auto'。" },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    timeoutMs: live.timeoutMs + 15000,
    async execute(args, exec) {
      const route = resolveRoute(live, contextRouteOf(exec?.agent), ctx.get('agentDefaultModel')?.currentSelection?.())
      if (route === undefined) throw enhanceFailure('provider_unavailable', '没有可用的模型路由')
      const signal = combinedSignal(exec?.signal, live.timeoutMs)
      const input = {
        prompt: args.prompt,
        ...(args.goal ? { goal: args.goal } : {}),
        ...(args.context ? { context: args.context } : {}),
        ...(Array.isArray(args.requirements) && args.requirements.length > 0 ? { requirements: args.requirements } : {}),
        language: args.language || live.language,
      }
      const result = await enhanceCore(ctx, live, input, route, exec?.agent?.id, signal)
      return stripWrappingQuotes(result.text)
    },
  }))

  // 3. 斜杠命令：/enhance <prompt>（同步增强，直接返回结果）
  ctx.commands.register({
    name: 'enhance',
    description: '增强一条提示词：把粗略的想法改写成更清晰、更高质量的它本身（同语言、同形态、同意图）',
    input: { hint: '<prompt>' },
    recordInput: true,
    handler: async (invocation) => {
      const raw = invocation.rawInput.trim()
      if (!raw) return { kind: 'error', text: '用法：/enhance <要增强的提示词>' }
      try {
        const route = resolveRoute(live, contextRouteOf(invocation.agent), ctx.get('agentDefaultModel')?.currentSelection?.())
        if (route === undefined) return { kind: 'error', text: '提示词增强失败：没有可用的模型路由（请在设置中配置 provider/model 或默认模型）' }
        const signal = combinedSignal(invocation.signal, live.timeoutMs)
        const result = await enhanceCore(ctx, live, { prompt: raw, language: live.language }, route, invocation.agent?.id, signal)
        return { kind: 'success', text: stripWrappingQuotes(result.text) }
      } catch (error) {
        return { kind: 'error', text: '提示词增强失败：' + (error instanceof Error ? error.message : String(error)) }
      }
    },
  })

  // 4. 输入框按钮传输：POST /api/enhance-prompt
  registerEnhanceRoute(ctx, () => live, log)
}
