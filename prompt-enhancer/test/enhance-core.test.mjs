/**
 * 服务端增强核心纯函数单测（node --test，零依赖）。
 * 被测代码从 index.js 的 @pure-start…@pure-end 区抽取进 vm 求值——
 * 单一事实源，测的就是线上跑的同一份函数。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'index.js'), 'utf8')
const match = source.match(/\/\/ @pure-start\n([\s\S]*?)\n\/\/ @pure-end/)
if (!match) throw new Error('index.js 缺少 @pure 区')
const sandbox = { Error, JSON, String, Number, Object, Array, Boolean }
vm.createContext(sandbox)
vm.runInContext(
  match[1] + '\n;__pure = { DEFAULT_SYSTEM, enhanceFailure, validateRoutePair, resolveRoute, frameInput, stripWrappingQuotes, extractEnhancedText, finishError, mapCaughtError, detectLanguage }',
  sandbox,
)
const pure = sandbox.__pure

const cfg = (provider, model) => ({ provider, model })

// vm 求值的对象与测试 realm 原型不同（deepStrictEqual 会因 prototype 失败），统一走 JSON 归一化比较
const plain = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)))

test('validateRoutePair：provider/model 必须成对', () => {
  assert.doesNotThrow(() => pure.validateRoutePair(cfg('a', 'b')))
  assert.doesNotThrow(() => pure.validateRoutePair({}))
  assert.throws(() => pure.validateRoutePair(cfg('a', undefined)), /成对/)
  assert.throws(() => pure.validateRoutePair(cfg(undefined, 'b')), /成对/)
  assert.throws(() => pure.validateRoutePair(cfg('', 'b')), /成对/)
})

test('resolveRoute：优先级 显式配置 > 会话上下文 > 默认模型 > undefined', () => {
  const config = cfg('cfg-p', 'cfg-m')
  const context = cfg('ctx-p', 'ctx-m')
  const defaults = cfg('def-p', 'def-m')
  // 1. 配置赢
  assert.deepEqual(plain(pure.resolveRoute(config, context, defaults)), plain(config))
  // 2. 无配置 → 上下文
  assert.deepEqual(plain(pure.resolveRoute({}, context, defaults)), plain(context))
  // 3. 都无 → 默认
  assert.deepEqual(plain(pure.resolveRoute({}, undefined, defaults)), plain(defaults))
  // 4. 全无 → undefined（调用方映射 provider_unavailable）
  assert.equal(pure.resolveRoute({}, undefined, undefined), undefined)
  // 5. 上下文中只有 provider 或只有 model → 视为无效，落到默认
  assert.deepEqual(plain(pure.resolveRoute({}, cfg('ctx-p', undefined), defaults)), plain(defaults))
})

test('detectLanguage：语言是可计算的事实（含 CJK 即中文，否则英文）', () => {
  const d = pure.detectLanguage
  assert.equal(d('帮我写个爬虫'), 'zh')
  assert.equal(d('Write a function'), 'en')
  assert.equal(d('中英混合 mixed input 也有中文'), 'zh')
  assert.equal(d(''), 'en')
  assert.equal(d(undefined), 'en')
  assert.equal(d(null), 'en')
})

test('frameInput：任意文本（含 {input} 字面量/换行/引号/JSON 敏感字符）无损进 JSON 边界，尾部带双层语言指令', () => {
  const tricky = '含 {input} 字面量、\n换行、\t制表、"双引号" 与 \\ 反斜杠'
  const framed = pure.frameInput({ prompt: tricky, language: 'auto' })
  assert.ok(framed.startsWith('Enhance the raw prompt described by this JSON object.'))
  // 第一段是完整 JSON：往返解析必须还原原文——这正是「用户文本无法破坏结构边界」的验收
  const jsonPart = framed.split('\n\n')[0].split('\n').slice(1).join('\n')
  const parsed = JSON.parse(jsonPart)
  assert.equal(parsed.prompt, tricky)
  assert.equal(parsed.language, 'auto')
  // 第二层语言约束：auto → 检测指令；指定语言 → 强制指令
  const directive = framed.split('\n\n')[1]
  assert.ok(/LANGUAGE CONSISTENCY/.test(directive))
  assert.ok(/detect the language of the USER INPUT/.test(directive))
  const framedZh = pure.frameInput({ prompt: 'x', language: 'zh' })
  assert.ok(/written in Chinese/.test(framedZh.split('\n\n')[1]))
  const framedEn = pure.frameInput({ prompt: 'x', language: 'en' })
  assert.ok(/written in English/.test(framedEn.split('\n\n')[1]))
})

test('stripWrappingQuotes：中英文单双引号各一层（FR-10 核心用例）', () => {
  const s = pure.stripWrappingQuotes
  // 双引号
  assert.equal(s('"帮我写个爬虫"'), '帮我写个爬虫')
  // 单引号
  assert.equal(s("'enhance this'"), 'enhance this')
  // 中文弯引号
  assert.equal(s('“结构化任务提示词”'), '结构化任务提示词')
  // 中文单弯引号
  assert.equal(s('‘结构化任务提示词’'), '结构化任务提示词')
  // 书名引号
  assert.equal(s('「写一个爬虫」'), '写一个爬虫')
  assert.equal(s('『写一个爬虫』'), '写一个爬虫')
})

test('stripWrappingQuotes：边界与防御用例', () => {
  const s = pure.stripWrappingQuotes
  // 无引号 → 原样（首尾 trim）
  assert.equal(s('普通文本'), '普通文本')
  // 只剥一层：外层引号内还有引号，内层保留
  assert.equal(s('"他说「开始」"'), '他说「开始」')
  // 引号不成对 → 原样
  assert.equal(s('"只开不闭'), '"只开不闭')
  assert.equal(s('只闭不开"'), '只闭不开"')
  // 开头结尾是不同引号字符 → 原样
  assert.equal(s('"混搭’'), '"混搭’')
  // 剥完为空 → 保留原样（防空串回填）
  assert.equal(s('""'), '""')
  // 空字符串输入原样返回
  assert.equal(s(''), '')
  // 引号内多余空白被清理
  assert.equal(s('"  有空格  "'), '有空格')
  // 非字符串输入不炸
  assert.equal(s(null), '')
  assert.equal(s(undefined), '')
})

test('extractEnhancedText：信封解析——取标签内文本，无标签时退回全文', () => {
  const e = pure.extractEnhancedText
  // 标准信封
  assert.equal(e('<enhanced-prompt>帮我写一个爬虫</enhanced-prompt>'), '帮我写一个爬虫')
  // 标签外有唠叨，只取标签内
  assert.equal(e('好的，以下是增强结果：\n<enhanced-prompt>结果是这个</enhanced-prompt>\n希望对你有帮助'), '结果是这个')
  // 无标签 → 原样（fail-open，交由上层剥引号）
  assert.equal(e('没有标签的纯文本'), '没有标签的纯文本')
  // 只有开标签 → 原样
  assert.equal(e('<enhanced-prompt>没闭合'), '<enhanced-prompt>没闭合')
  // 内层为空 → 原样
  assert.equal(e('<enhanced-prompt>  </enhanced-prompt>'), '<enhanced-prompt>  </enhanced-prompt>')
  // 多对标签 → 取第一对
  assert.equal(e('<enhanced-prompt>第一段</enhanced-prompt> 另外 <enhanced-prompt>第二段</enhanced-prompt>'), '第一段')
  // 标签被 Markdown 代码围栏包裹也能取到
  assert.equal(e('```\n<enhanced-prompt>围栏里的结果</enhanced-prompt>\n```'), '围栏里的结果')
  // 非字符串不炸
  assert.equal(e(null), '')
  assert.equal(e(undefined), '')
})

test('finishError：finish 块 → 带 code 的错误（abort/错误/截断/工具调用/未知，保留上游机器码）', () => {
  const f = pure.finishError
  assert.equal(f({ kind: 'stop' }), undefined)
  assert.equal(f({ kind: 'aborted', failure: { message: 'boom' } }).code, 'aborted')
  assert.equal(f({ kind: 'error', failure: { code: 'TIMEOUT' } }).code, 'timeout')
  assert.equal(f({ kind: 'error', failure: { code: 'UNSUPPORTED_REASONING_EFFORT' } }).code, 'unsupported_effort')
  assert.equal(f({ kind: 'error', failure: { code: 'RATE_LIMITED', message: '限流' } }).code, 'llm_error')
  assert.equal(f({ kind: 'error', failure: undefined }).code, 'llm_error')
  assert.equal(f({ kind: 'max-tokens' }).code, 'max_tokens')
  assert.equal(f({ kind: 'tool-calls' }).code, 'tool_calls')
  assert.equal(f({ kind: 'something-new' }).code, 'llm_error') // 未知 finish 不误判成功
})

test('mapCaughtError：迭代抛错路径归一化（adapter abort 是抛错不是 finish 块）', () => {
  const m = pure.mapCaughtError
  const aborted = new Error('DeepSeek request aborted by caller')
  aborted.code = 'ABORTED'
  assert.equal(m(aborted).code, 'aborted')
  const timeout = new Error('TIMEOUT')
  timeout.code = 'TIMEOUT'
  assert.equal(m(timeout).code, 'timeout')
  const plain = new Error('网络炸了')
  assert.equal(m(plain), plain) // 普通错误原样透传，保留消息
  assert.equal(m('字符串错误').code, 'llm_error')
  assert.equal(m(null).code, 'llm_error')
})

test('enhanceFailure：稳定 code 挂载与消息前缀', () => {
  const e = pure.enhanceFailure('empty_result', '没有文本输出')
  assert.equal(e.code, 'empty_result')
  assert.ok(e.message.includes('prompt-enhancer: 没有文本输出'))
  assert.ok(e instanceof Error)
})

test('DEFAULT_SYSTEM：原文增强契约——语言一致 + 同形态 + 同量级 + 不发明 + 代码块保护 + 信封协议', () => {
  const sys = pure.DEFAULT_SYSTEM
  assert.ok(/LANGUAGE CONSISTENCY IS THE HIGHEST PRIORITY/i.test(sys), '语言一致性必须是最强约束')
  assert.ok(/中文输入→中文回复/.test(sys) && /English input→English reply/.test(sys), '中英双语约束都在')
  assert.ok(/PRESERVE the original form and voice/.test(sys), '必须保留原文形态（散文进→散文出，不转固定格式）')
  assert.ok(/Do NOT restructure the text into labeled sections/.test(sys), '必须显式禁止角色/目标/步骤式结构化分段')
  assert.ok(/same order of magnitude/.test(sys), '长度必须与原文同量级（防超长带偏，也不做无谓压缩）')
  assert.ok(/Do not invent tasks, requirements, or facts/.test(sys), '必须保留「不得发明需求」原则')
  assert.ok(/triple backticks/.test(sys) && /keep it unchanged/.test(sys), '代码块必须保护为不可改')
  assert.ok(/<enhanced-prompt>rewritten text here<\/enhanced-prompt>/.test(sys), '输出必须是信封协议（标签包裹）')
})
