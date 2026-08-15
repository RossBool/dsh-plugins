# DSH 插件关键 API 事实清单（可写代码版）

> 目标插件：`dsh-team-plan`（Leader LLM 生成计划 → 确定性状态机 → 派发 Worker 子代理 → Verifier LLM 对抗式验证 → 重试回环 → 交付）
>
> 检出版本：`@deepseek-ai/dsh` **0.1.0-rc.6**（严格只读）
> 根路径简写：
> - `DSH` = `/Users/zhoujunren/Library/PhpWebStudy/app/nodejs/v22.21.1/lib/node_modules/@deepseek-ai/dsh`
> - `PKG` = `DSH/node_modules/@deepseek-ai`
> - `WS` = `/Users/zhoujunren/Code/LocalCode`
>
> 所有证据为 `文件路径 + 行号 + 关键摘录`；行号以本清单所依据的检出版本为准。

---

## 1. LLM 调用：`ctx.llm`（LlmRuntime，Service 名 `"llm"`）

### 1.1 服务注入方式

LLM 服务通过 **Cordis 模块声明合并** 暴露为 `ctx.llm`，类型声明明确存在：

```ts
// PKG/dsh-llm/lib/types/index.d.ts:26-28
declare module '@deepseek-ai/cordis' {
    interface Context {
        llm: LlmRuntime;
    }
```

- **硬依赖注入**：`export const inject = ['llm']`，则 `apply(ctx)` 执行时 `ctx.llm` 必可用。真实例子（会话标题 LLM 调用插件）：

```js
// PKG/dsh-session-title-first-prompt-llm/lib/index.js:6-11
const inject = [
    "sessionTitle",
    "llm",
    "sessions"
];
```

- **惰性/可选解析**：`ctx.get('llm')`（Cordis 反射层，无 inject 要求）：

```ts
// PKG/cordis/src/reflect.ts:17-19
get<K extends string & keyof this>(name: K, strict?: boolean): undefined | this[K]
get(name: string, strict?: boolean): any
```

> 注意：直接读属性 `ctx.llm` 需要 `inject: ['llm']`，否则代理抛 `cannot get property "llm" without inject`；`ctx.get('llm')` 是“无硬依赖”的惰性读取（返回 `undefined` 当未就绪）。
> 可选依赖的**异步注入**另有一种写法（plan-mode 用它注入可选 `commands`）：`ctx.inject(['commands'], (commandCtx) => { ... })`（见 `PKG/dsh-plan-mode/lib/index.js:182`）。

### 1.2 LlmRuntime 公开方法签名

```ts
// PKG/dsh-llm/lib/types/index.d.ts:198
export declare class LlmRuntime extends Service {
    registerAdapter(providers: string[], adapter: LlmAdapter): AdapterRegistrationHandle;   // :215
    listProviders(): LlmProviderInfo[];                                                        // :234
    listConfigurableProviders(): LlmConfigurableProvider[];                                   // :248
    registerModelDiscovery(settingsNs, discover): () => void;                                 // :259
    discoverModels(settingsNs, request): Promise<LlmDiscoveredModel[]>;                       // :269
    providerRetryPolicy(provider): ResolvedRetryPolicy;                                       // :275
    listModels(provider): Promise<LlmModelInfo[]>;                                            // :284
    resolveModelInfo(provider, model, signal?): Promise<LlmResolvedModelInfo>;                // :294
    resolveCallConfig(config: LlmCallConfig, signal?): Promise<LlmCallConfig>;                // :306
    prepareCall(config: LlmCallConfig, signal?): Promise<PreparedLlmCall>;                    // :316
    stream(options: GenerateOptions): AsyncIterable<StreamChunk>;                             // :337
    private adapterStream;   // :325 —— 私有，插件不可直接调用
}
```

关键结论：
- **`prepareCall`** 返回 `PreparedLlmCall`，它把“能力解析结果 + 适配器注册”绑定到一次性句柄，句柄自带 `stream()`：

```ts
// PKG/dsh-llm/lib/types/index.d.ts:89-106
export interface PreparedLlmCall {
    readonly config: LlmCallConfig;
    readonly retryPolicy: ResolvedRetryPolicy;
    readonly context?: LlmModelContext;
    readonly adapterDefaults: LlmCallConfigAdapterDefaults;
    stream(options: GenerateOptions): AsyncIterable<StreamChunk>;   // :105
}
```

- **`stream(options)`** 是一步到位的流式入口（内部做了适配器选择、失败归一化为终态 `finish` chunk、并套上 `llm/stream` waterfall）。**写“一次调用拿全文”用 `ctx.llm.stream()` 即可**，无需 `prepareCall`。`adapterStream` 是 `private`，不是插件 API。
- 拦截点：`llm/stream` 是 waterfall 事件（可在返回迭代器前后做包裹/短路）：

```ts
// PKG/dsh-llm/lib/types/index.d.ts:43
'llm/stream'(this: LlmRuntime, options: GenerateOptions, next: () => AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk>;
```

### 1.3 请求参数形状 `GenerateOptions`

```ts
// PKG/dsh-llm/lib/types/types.d.ts:312-348（节选）
export interface GenerateOptions {
    provider: string;            // 已注册的 provider 路由（选择适配器实例）
    model: string;
    reasoningEffort?: ReasoningEffortId;
    messages: Message[];         // 有序对话消息（system 之外的完整历史）
    system?: string;             // 系统提示词文本
    tools?: ToolSchema[];        // 工具 schema（映射到 provider 的 tools 字段）
    temperature?: number;
    maxTokens?: number;
    stop?: string[];
    signal?: AbortSignal;
    sessionId?: Branded<'SessionId'>;
    purpose?: 'compaction' | 'session-title';
}
```

### 1.4 流 chunk 形状与“如何判断结束 / 组装全文”

```ts
// PKG/dsh-llm/lib/types/types.d.ts:267-297
export type StreamChunk =
    | { type: 'block-start'; index: number; blockType: ContentBlockType }
    | { type: 'text-delta'; index: number; text: string }
    | { type: 'reasoning-delta'; index: number; text: string }
    | { type: 'tool-call-delta'; index: number; id: CallId; name?: string; argumentsDelta: string }
    | { type: 'block-end'; index: number; block: ContentBlock }
    | { type: 'usage'; usage: TokenUsage }
    | { type: 'finish'; reason: FinishReason; replayState?: unknown };
```

- **结束信号 = `type === 'finish'`** 的 chunk；之后适配器不再发任何 chunk。
- **失败也被归一化为终态 `finish`**（不会 throw）：`FinishReason` 的 `kind` 为 `'error'` / `'aborted'`，携带 `failure: LlmFailure`：

```ts
// PKG/dsh-llm/lib/types/types.d.ts:94-114
export interface FinishReasonMap {
    'stop': { kind: 'stop' };
    'tool-calls': { kind: 'tool-calls' };
    'max-tokens': { kind: 'max-tokens' };
    'aborted': { kind: 'aborted'; failure: LlmFailure };
    'error': { kind: 'error'; failure: LlmFailure };
}
```

- **组装全文：官方 `BlockAssembler`**（增量把 chunk 折成完整 `ContentBlock[]` 与最终 assistant `Message`）：

```ts
// PKG/dsh-llm/lib/types/assembler.d.ts:21-55
export declare class BlockAssembler {
    push(chunk: StreamChunk): void;
    blocks(): ContentBlock[];        // 按流序的完整块
    get usage(): TokenUsage | undefined;
    get finish(): FinishReason;      // 无 finish 时默认 { kind: 'stop' }
    get replayState(): unknown;
    message(source?: MessageSource): Message;
}
```

### 1.5 消息构造 API

```ts
// PKG/dsh-llm/lib/types/message.d.ts
export declare function createMessage<T extends NewMessage>(input: T & { id?: never }): T & Pick<Message, 'id'>;          // :163
export declare function createUserMessage<T extends NewUserMessage>(input: T & { id?: never; role?: never }): ...;        // :171
export declare function createAssistantMessage(input: NewAssistantMessage & {...}): AssistantMessage;                      // :180
export declare function createToolResultMessage(input: ToolResultMessageInput): ToolResultMessage;                          // :195
```

- `Message` / `UserMessage` 形状：

```ts
// PKG/dsh-llm/lib/types/message.d.ts:120-133
export interface Message {
    readonly id: MessageId;
    readonly role: 'system' | 'user' | 'assistant';
    readonly content: ContentBlock[];   // { type:'text', text } | { type:'reasoning', text } | { type:'tool-call',... } | { type:'tool-result',... } | { type:'image',... }
    readonly source: MessageSource;     // { kind:'user' } | { kind:'plugin', plugin } | { kind:'model',... } | { kind:'tool',... }
}
export interface UserMessage extends Message { readonly role: 'user'; }
```

> `createUserMessage` 的入参是 **`{ content: ContentBlock[], source: MessageSource }`**（`id` 与 `role` 由函数补全并 `freeze`）。`source` 常用 `{ kind: 'user' }` 或 `{ kind: 'plugin', plugin: 'xxx' }`。

### 1.6 最小可用代码示例（一次调用拿全文）

真实证据：`PKG/dsh-session-title-llm/lib/index.js:196-207`（构造消息）+ `:227-235`（stream 循环 + 组装）：

```js
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'

export const name = 'team-plan-leader'
export const inject = ['llm']                       // 硬依赖：apply 时 ctx.llm 就绪

export function apply(ctx) {
  async function askModel(provider, model, system, text, signal) {
    const messages = [createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'plugin', plugin: 'team-plan-leader' },
    })]
    const assembler = new BlockAssembler()
    for await (const chunk of ctx.llm.stream({ provider, model, messages, system, signal })) {
      signal?.throwIfAborted()
      assembler.push(chunk)
    }
    // 结束 = 流自然耗尽；失败从 finish 判定，不依赖 throw
    if (assembler.finish.kind === 'error' || assembler.finish.kind === 'aborted') {
      throw new Error(`llm failed: ${assembler.finish.failure?.code} ${assembler.finish.failure?.message}`)
    }
    // 组装全文：只取 text 块拼接（Verifier 同样用这段）
    return assembler.blocks().filter(b => b.type === 'text').map(b => b.text).join('')
  }
  // ...
}
```

> 若需要“解析一次、日志一次、派发多次共享同一适配器注册”，改用 `const prepared = await ctx.llm.prepareCall({ provider, model }); prepared.stream(options)`；普通一次性调用直接 `ctx.llm.stream(options)`。

---

## 2. 斜杠命令：真实机制 = `ctx.commands` 命令服务（`/plan`、`/goal`），`/team` 不是命令

### 2.1 真实命令服务：`ctx.commands`（CommandRuntime）

存在官方命令注册表服务（不是纯文本拦截）：

```ts
// PKG/dsh-commands/lib/types/index.d.ts:48-52
declare module '@deepseek-ai/cordis' {
    interface Context {
        commands: CommandRuntime;
    }
}
```

核心 API：

```ts
// PKG/dsh-commands/lib/types/index.d.ts:59-110（节选）
export declare function parseCommand(line: string): ParsedCommand | undefined;   // :59
export declare class CommandRuntime extends TypertRemoteService {
    register(definition: CommandDefinition): () => void;     // :77 注册（effect 作用域，卸载自动清理）
    list(agent: Agent): readonly CommandDescriptor[];        // :83
    find(agent: Agent, name: string): CommandDefinition | undefined;  // :90
    execute(agent: Agent, line: string, signal: AbortSignal): Promise<CommandExecution | undefined>;  // :110
}
```

命令定义与调用入参：

```ts
// PKG/dsh-commands/lib/types/index.d.ts:14-40（节选）
export interface CommandInvocation {
    readonly commandId: CommandId;
    readonly agent: Agent;         // 接收该命令的精确 agent
    readonly rawInput: string;     // 命令名之后的原文（含分隔空白）
    readonly signal: AbortSignal;
}
export interface CommandDefinition {
    readonly name: string;         // 小写、不含前导斜杠
    readonly description: string;
    readonly input?: CommandInputDescriptor;   // { hint: string }
    readonly recordInput?: boolean;
    readonly handler: (invocation: CommandInvocation) => CommandResult | Promise<CommandResult>;
}
```

**关键语义**：命令 handler **直接对接收 agent 执行，不把命令文本发给模型**（"without sending the command to the model"）。执行过程写两条日志事件 `command/run` / `command/done`（`PKG/dsh-commands/lib/types/types.d.ts:70-101`）。

### 2.2 `/plan` 是真实命令（由 `dsh-plan-mode` 注册）

```js
// PKG/dsh-plan-mode/lib/index.js:182-190
ctx.inject(["commands"], (commandCtx) => {
    commandCtx.commands.register({
        name: "plan",
        description: "Enter or leave plan mode",
        input: { hint: "[off|message]" },
        handler: ({ agent, rawInput }) => { /* set(agent, active) + agent.steer(...) */ }
    });
});
```

`/goal` 同型证据：

```js
// PKG/dsh-command-goal/lib/index.js:142-147
function apply(ctx) {
    ctx.commands.register({
        name: "goal",
        description: "set or view the goal for a long-running task",
        input: { hint: "[<objective>|clear|edit <objective>|pause|resume]" },
        handler: (invocation) => executeGoalCommand(ctx, invocation)
    });
}
```

**运行 profile 里的真实实例**（`/mcp-status`，硬 `inject: ['commands']` + 直接返回 `{ kind:'success', text }`）：

```js
// /Users/zhoujunren/.dsh/profiles/plugins/dsh-mcp-manager/index.js（末段）
export const inject = ['tools', 'commands', 'settings', 'timer']
// ...
ctx.commands.register({
  name: 'mcp-status',
  description: '内部命令：返回 MCP 服务器运行时状态 JSON（供设置页轮询）',
  recordInput: false,                       // 不把 rawInput 写进会话日志
  handler: () => ({ kind: 'success', text: JSON.stringify({ servers }) }),
})
```

### 2.3 `/team` 不是斜杠命令（重要结论）

- `dsh-team-mode/route.js` 注释提到“`/team on|off|once|auto` 控制指令放在 `dsh-team-mode/control`（独立插件）”，但该文件 **不存在**：

```js
// WS/dsh-team-mode/route.js:20-21
 * 用户输入 `/team on|off|once|auto` 等控制指令的处理放在
 * dsh-team-mode/control（独立插件）；本路由只读不写 teamMode。
```

  实测：`WS/dsh-team-mode/` 只有 `index.js / route.js / src/client.jsx / cordis.patch.yml`，`package.json` exports 也只有 `.` / `./route` / `./client`；全包 `grep 'commands'` 无任何 `ctx.commands.register`，`grep '/team'` 仅命中上述注释。

- 团队模式实际是 **config 开关 + `agent/pre-step` 文本拦截**，开关经 `teamMode` 服务（`ctx.registry.register({ name:'teamMode', value: api })`，`WS/dsh-team-mode/index.js:125`）与 `ctx.harness.handle('team-mode/set-global', …)` JSON 通道切换，**不是** `/team` 命令。

### 2.4 `agent/pre-step` 拦截模式（精确事件名 + payload 形状）

事件名 **`agent/pre-step`**，waterfall，签名：

```ts
// PKG/dsh-agent/lib/types/runtime-types.d.ts:235-241
'agent/pre-step'(this: Scoped<Agent>, payload: {
    agent: Agent;
    messages: UserMessage[];   // 本步从 inbox 摘出的消息
    turn: number;
    step: number;
    signal: AbortSignal;
}, next: () => Promise<PreStepDecision>): Promise<PreStepDecision>;
```

决策类型：

```ts
// PKG/dsh-agent/lib/types/runtime-types.d.ts:47-52
export type PreStepDecision =
    | { kind: 'reject' }
    | { kind: 'enter'; messages: UserMessage[] };
```

真实拦截用法（`/team` 式协作路由即此模式）：

```js
// WS/dsh-agent-orchestration/route.js:68-129（节选）
ctx.on('agent/pre-step', async (payload, next) => {
  let decision
  try { decision = await next() } catch (e) { return undefined }
  if (!decision || decision.kind !== 'enter') return decision
  const agent = payload.agent; const sid = agent.id
  const turn = payload.turn
  const messages = payload.messages ?? []
  // ... 信号检测 / 级联防护 ...
  const res = await subagents.startContinuable({ provider, label, request: { prompt:[{type:'text',text}], parent: agent }, signal: payload.signal })
  if (res && res.childId) spawned.push({ childId: res.childId, label })
  // 向主会话注入一条队长指令（拼接 user 消息进 decision.messages）
  const note = { role:'user', source:{kind:'user'}, id:'...', content:[{type:'text',text:'...'}] }
  return { kind: 'enter', messages: decision.messages.concat([note]) }
})
```

> 结论（可直接写进代码）：**要加 `/plan` 这类可发现命令 → `inject:['commands']` + `ctx.commands.register({ name, description, input:{hint}, handler })`；要做“自然语言触发多代理派发/截断改写模型输入” → `ctx.on('agent/pre-step', …)` 瀑布，`await next()` 拿原 decision，改写 `messages` 后 `return { kind:'enter', messages }`。**

---

## 3. 子代理：`ctx.subagents`（SubagentRuntime）

### 3.1 (a) 服务 API 签名

```ts
// PKG/dsh-subagent/lib/types/index.d.ts
export declare class SubagentRuntime extends Service {
    startContinuable(spec: ContinuableStartSpec): Promise<ContinuableStart>;          // :120
    followup(parent, childId, content, options): Promise<MessageId>;                  // :136
    interrupt(targetSessionId, authority): void;                                       // :152
    reportFrom(child, content, options): Promise<MessageId>;                          // :164
    registerContinuableSetup(contribution): () => void;                               // :173
    drainContinuableDescendants(parents): Promise<void>;                              // :184
    listChildren(parentSessionId, signal?): Promise<SubagentListEntry[]>;             // :213
    listDescendants(rootSessionId, signal?): Promise<SubagentDescendantListEntry[]>;  // :229
    registerProvider(provider): () => void;                                           // :237
    getProvider(name): SubagentProvider | undefined;                                  // :243
    list(): string[];                                                                 // :248  ← 返回 provider 名字符串数组（如 ['spawn','fork']）
    start(name: string, request: SubagentStartRequest): Promise<SubagentRun>;         // :259  ← 一次性前台
}
```

### 3.2 `startContinuable` 入参与返回

```ts
// PKG/dsh-subagent/lib/types/continuation.d.ts:80-99
export interface ContinuableStartSpec {
    readonly provider: string;                                  // ctx.subagents provider 名（如 'spawn'）
    readonly label: string;                                     // 持久化的子代理创建标签
    readonly request: Omit<SubagentStartRequest, 'label' | 'signal' | 'outputSchema'>;
    readonly signal: AbortSignal;
}
export interface ContinuableStart {
    readonly childId: SessionId;    // 持久子会话 id（跨 activation 稳定）
    readonly messageId: MessageId;  // 初始 prompt 被 inbox 接受的 message id
}
```

`SubagentStartRequest`（`request` 字段的完整形状）：

```ts
// PKG/dsh-subagent/lib/types/types.d.ts:91-140（节选）
export interface SubagentStartRequest {
    readonly label?: string;
    readonly prompt: ContentBlock[];     // 子代理的首条 user 消息内容（如 [{type:'text',text}]
    readonly parent: Agent;              // 派发方 agent（用于 workspace/lineage/depth 派生）
    readonly signal: AbortSignal;
    readonly agentOptions?: AgentOptions;          // { provider?, model?, maxTokens? }
    readonly outputSchema?: ObjectJsonSchema;      // 结构化解：子代理返回 SubagentResult.structured
    readonly maxDepth?: number;
    readonly toolFilter?: ToolRestriction;
    readonly persona?: string;
}
```

一次性 `start()` 的返回 `SubagentRun`：

```ts
// PKG/dsh-subagent/lib/types/types.d.ts:233-259（节选）
export interface SubagentRun {
    readonly id: SessionId;
    readonly localAgent: Agent | undefined;
    readonly result: Promise<SubagentResult>;   // 失败不 reject，用 stopReason 表达
    dispose(): Promise<void>;
}
// :204-223
export interface SubagentResult {
    readonly output: ContentBlock[];    // 子代理最后一条非空 assistant 消息内容
    readonly structured?: unknown;      // 请求 outputSchema 成功时的结构化结果
    readonly stopReason: SubagentStopReason;  // 'completed'|'aborted'|'error'|'max-tokens'|'refusal'
}
```

### 3.3 (b) 父会话如何得知子代理完成并拿到产出

**机制：不是轮询，而是“子代理结算/上报 → 以 UserMessage 打进父 agent 的 inbox → 父 agent 下一回合领取”。** 三条证据链：

1. **上报消息的持久化 source 类型**（声明合并进 `MessageSourceMap`）：

```ts
// PKG/dsh-subagent/lib/types/continuation.d.ts:39-62
export interface SubagentReportMessageSource {   // 子代理显式 report（子代理选择的内容）
    readonly kind: 'subagent-report'; readonly form: 'relay'; readonly senderSessionId: SessionId;
}
export interface SubagentSettledMessageSource {  // 运行时结算声明（子代理“最终是什么结局”）
    readonly kind: 'subagent-settled'; readonly form: 'notice'; readonly summary: string; readonly senderSessionId: SessionId;
}
```

2. **结算投递**：continuation manager 在子代理 quiescent 后 `notifySettlement`，把 `subagent-settled` 消息投给父（waking send）；子代理自己可用 `reportFrom` 主动上报（`subagent-report`）：

```ts
// PKG/dsh-subagent/lib/types/continuation.d.ts:405-423（注释节选）
 * Tell the durable direct parent that this child produced everything it is
 * going to. Unconditional for every child the caller received an id for ...
 * the child's own Session remains the durable record either way.
```

3. **投递落点 = 父 agent 的 inbox**，可观察事件有两层：
   - 活体 Cordis 事件 **`agent/inbox/inserted`**（`PKG/dsh-agent/lib/types/runtime-types.d.ts:180-183`，payload `{ agent, message }`）；
   - 持久化会话事件 **`agent/inbox/spliced`**（`SessionEventMap` 条目，落进会话日志）：

```ts
// PKG/dsh-agent/lib/types/types.d.ts:16-23
'agent/inbox/spliced': {
    target: InboxTarget;          // 'next-turn' | 'next-step'
    start: number;
    removedCount?: number;
    inserted: UserMessage[];      // 被 splice 进来的消息（含 child 的 report/settled 消息）
    outcome?: 'canceled';
};
```

   `Inbox` 的 splice/append 语义见 `PKG/dsh-agent/lib/types/inbox.d.ts:19-91`（`append/prepend/splice/claim`，每次 mutation 都会“先写持久事件、再变活体投影”）。

> **给 `dsh-team-plan` 的落点结论**：Leader 派发 `startContinuable` 拿到 `childId`；等待 Worker 完成有两种等价选择——
> (1) **订阅父 agent 的 inbox**：监听 `agent/inbox/inserted`（活体）或读父会话日志里的 `agent/inbox/spliced` 事件，按 `message.source.kind === 'subagent-settled' | 'subagent-report'` 过滤，从 `source.senderSessionId` 对应 `childId`，消息 `content` 即产出；
> (2) **轮询血缘/会话**：`subagents.listDescendants(rootId)` + `sessions.get(childId).events` 扫 `turn/end`（`dsh-agent-orchestration` 的做法）。

### 3.4 `dsh-agent-orchestration/index.js` 血缘树读的是什么

```js
// WS/dsh-agent-orchestration/index.js:157（fetchData 内）
const subagents = ctx.get('subagents')
// :280-281 —— 血缘树来自 listDescendants，不是事件
(await withTimeout(subagents.listDescendants(rootId), 8000)) || []
// :126 / :212 —— 活体会话日志
const sessions = ctx.get('sessions')
const s = sessions.get(id); if (s && Array.isArray(s.events)) events = s.events
// :226-255 —— sessionScan 从事件判定状态：扫 turn/end（reason）、turn/start、user/message（取「你的分工：」任务文本）
```

- `SubagentDescendantListEntry` 形状（父链 + 深度）：

```ts
// PKG/dsh-subagent/lib/types/list-children.d.ts:74-79
export type SubagentDescendantListEntry = SubagentListEntry & {
    readonly parentId: SessionId;   // 持久直接父
    readonly depth: number;         // 距 root 的边数
};
```

- 事件名对照（`mapEvents`，`WS/dsh-agent-orchestration/index.js:396-420`）：`turn/start`、`turn/end`、`user/message`、`step/start`、`assistant/chunk`、`assistant/message`、`tool/call`、`tool/result`、`tool-workflow/run-start|agent-start|agent-end|run-end`、`todo/write`。
- **子代理 report 如何拼回主会话**：正是上面 3.3 的 inbox 机制——report/settled 作为 `UserMessage` 被 splice 进父 inbox（持久事件 `agent/inbox/spliced`，活体事件 `agent/inbox/inserted`），父 agent 的下一个 step 由 `agent/pre-step` 瀑布领取（`payload.messages` 里会带这些 `subagent-report`/`subagent-settled` source 的消息）。

### 3.5 派发最小代码（沿用 route.js 真实用法）

```js
// 参照 WS/dsh-agent-orchestration/route.js:101-116
const providers = ctx.subagents.list()                 // ['spawn', ...]
const provider = providers.includes('spawn') ? 'spawn' : providers[0]
const res = await ctx.subagents.startContinuable({
  provider,
  label: 'worker-1',
  request: {
    prompt: [{ type: 'text', text: '你是 Worker。你的分工：...' }],
    parent: agent,                                     // payload.agent
  },
  signal: payload.signal,
})
if (res?.childId) { /* 记录 childId 进入状态机 */ }
```

---

## 4. 插件持久化：`ctx.storage` 中枢 + `dsh-atomic-write` + `dsh-home-paths`（官方目录约定 = `$DSH_HOME/storages`）

### 4.1 `ctx.storage` 是真实服务（存储中枢，非直接 KV 文件）

```ts
// PKG/dsh-storage/lib/types/index.d.ts:23-26, 39-62
declare module '@deepseek-ai/cordis' { interface Context { storage: Storage; } }
export declare class Storage extends Service {
    readonly backend: BackendRegistry;   // 具名 backend 表（多个并存）
    mount<K extends keyof StorageForms>(form: K, facility: StorageForms[K]): () => void;  // :51
    form<K extends keyof StorageForms>(form: K): StorageForms[K];                          // :57
    get domain(): ...;                    // 域数据表单
}
```

backend 注册/解析（`BackendRegistry`，`PKG/dsh-storage/lib/types/registry.d.ts:21-32`）：`register(name, backend)` / `get(name)` / `names()`。

### 4.2 `dsh-storage-json`：官方“一单元一 JSON 文件”KV backend

```ts
// PKG/dsh-storage-json/lib/types/index.d.ts:20-36
export interface Config { root: string; }   // 目录，无默认值（避免 cwd 漂移）
export declare class JsonStorageBackend implements StorageBackend { readonly kv: KvFacet; ... }
// 注册为 backend 'json'，根目录下每 unit 一个 <unit>.json，原子整文件重写
```

KV 面 API（`KvFacet` / `KvUnit`）：

```ts
// PKG/dsh-storage/lib/types/backend.d.ts:26-39, 60-97
export interface KvFacet { open(descriptor: KvUnitDescriptor): Promise<KvUnit>; }
export interface KvUnit {
    loadAll(): Promise<{ tables: Record<string, Record<string, unknown>>; global: unknown }>;
    putRecord(table, key, value): Promise<void>;    // 覆盖写，durable
    deleteRecord(table, key): Promise<void>;
    setGlobal(value): Promise<void>;
    close(): Promise<void>;
}
```

> 结论：官方提供了**两层**持久化——重型路线用 `ctx.storage` + `storage-json` backend（KV 单元，适合大量结构化记录）；但 `ctx.storage` 本身不保证任何 backend 被装配（需 assembly 显式配置 `storage-json` 的 `root`），**对单个插件的小型 JSON 状态文件偏重**。

### 4.3 轻量原子写：`dsh-atomic-write`（零依赖，推荐直接使用）

```ts
// PKG/dsh-atomic-write/lib/types/index.d.ts:43, 56
export declare function writeFileAtomic(filename: string, content: string, options: WriteFileAtomicOptions): Promise<void>;
export declare function withFileLock<T>(filename: string, operation: () => Promise<T>): Promise<T>;
// :16-28
export interface WriteFileAtomicOptions { mode: number; dirMode?: number; }   // mode 必填；私有数据目录用 dirMode 0o700
```

  语义：先写随机后缀兄弟临时文件（`wx` 独占创建，防 symlink 跟随），再 `rename` 覆盖目标；读者始终看到旧/新完整内容；多进程写者用 `withFileLock` 串行（`<file>.lock`）。

### 4.4 路径约定：`dsh-home-paths`（`$DSH_HOME` / `~/.dsh`）

```ts
// PKG/dsh-home-paths/lib/types/index.d.ts
export declare const DSH_HOME_DIR_NAME = ".dsh";          // :7
export declare const DSH_HOME_ENV = "DSH_HOME";           // :11
export declare function resolveDshHome(configured?, env?): string;   // :48  优先级: configured > $DSH_HOME > ~/.dsh
export declare function dshHomePath(...segments: string[]): string;  // :54  拼到 home 下
```

- **官方 `storages` 子目录约定确实存在**：web 装配里 `storage-json` 后端的 `root` 被显式指向 `dshHomePath('storages')`：

```yaml
# DSH/node_modules/@deepseek-ai/dsh-web-app/cordis.patch.yml:51-62
- id: storage
  name: '@deepseek-ai/dsh-storage'
- id: storage-json
  name: '@deepseek-ai/dsh-storage-json'
  config:
    root: !!js dshHomePath('storages')     # ← 即 $DSH_HOME/storages（默认 ~/.dsh/storages）
- id: storage-domain
  name: '@deepseek-ai/dsh-storage-domain'
  config:
    backend: json
```

  实测运行 home `~/.dsh/storages/` 已存在，内有 `workspace.json`、`session_projcache.json`（`storage-json` 每 unit 一个 `<unit>.json`）。
  注意：`storage-json` 的 `Config.root` 本身**无默认值**（`PKG/dsh-storage-json/lib/types/index.d.ts:20-25`），`storages` 这个目录名是 **web 装配（dsh-web-app）注入的约定**，不是包内默认；`dsh-settings-file` 这类独立数据仍落 home 根（`<harness home>/settings.yaml`，`PKG/dsh-settings-file/lib/index.js:31`）。

### 4.5 结论 + 推荐写法

**有官方约定**：轻量插件直接写 `dshHomePath('storages', '<plugin>', '<name>.json')`（默认 `~/.dsh/storages/<plugin>/…`）+ `dsh-atomic-write.writeFileAtomic`；与 DSH 自身对 `workspace.json` 的落盘目录一致：

```js
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { join } from 'node:path'
import { mkdir } from 'node:fs/promises'

export const name = 'team-plan-state'

export function apply(ctx, config) {
  const dir = dshHomePath('storages', 'dsh-team-plan')   // 官方约定目录
  async function save(filename, obj) {
    await mkdir(dir, { recursive: true })
    await writeFileAtomic(join(dir, filename), JSON.stringify(obj, null, 2), { mode: 0o600, dirMode: 0o700 })
  }
  // ...
}
```

> 若要“逐记录 KV + 并发写”，改用 `ctx.storage.backend.get('json').kv.open({ name, version, tables:[...], hasGlobal:false })`，但前提是 assembly 已装配 `@deepseek-ai/dsh-storage-json` 并配置 `config.root`。

### 4.6 用户可编辑配置：`ctx.settings`（落 `settings.yaml`，推荐给「插件配置」而非「内部状态」）

DSH 对「用户可改的插件配置」有独立服务 `ctx.settings`（`@deepseek-ai/dsh-settings`，默认由 `dsh-settings-file` 提供，落 `<harness home>/settings.yaml`，热重载 + watch）：

```ts
// PKG/dsh-settings/lib/types/index.d.ts
export declare function settingsNamespace(value: string): SettingsNamespace;   // :20 品牌化命名空间，如 'mcp-servers'
declare module '@deepseek-ai/cordis' { interface Context { settings: SettingsProvider; } }  // :114
// :225
register<T>(ns: SettingsNamespace, schema: z<T>, options?: SettingsRegisterOptions<T>): SettingsScope<T>;
// SettingsScope<T>（:85-110）：get() / watch((next, prev) => …) / update(patch) / replace(section)
```

真实运行实例（`dsh-mcp-manager/index.js`）：

```js
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
const settingsService = ctx.root.get('settings')   // 每次实时解析，避免热替换后旧实例失效
const scope = settingsService.register(
  settingsNamespace('mcp-servers'),   // 命名空间
  Config,                              // Schemastery schema（与 cordis config 共用）
  { base: config, applies: 'live', validate: validateServers },  // base=入口 config；applies: 'live'|'restart'
)
const live = scope.get()               // 当前解析值（schema 默认 → base → 用户层）
scope.watch((next) => { live = next; reconcile(next) })  // 用户改 settings.yaml / UI 写 → 热更新
```

> 语义：解析顺序 = schema 默认值 → `base`（入口 `config`）→ 用户文档层；`apply(ctx, config)` 拿到的 `config` 是入口层，`scope.get()` 是合并了用户层的最终值。`installSettingsSection(ctx, ns, schema, entry, hooks)`（`PKG/dsh-settings/lib/types/index.d.ts` 末尾）是官方「可选 settings」接线助手。

### 4.7 类型化领域层：`ctx.storageDomain`（`defineDomain` / `domainTable`）

在 raw `KvUnit` 之上有 schema 校验 + 变更事件 + 单写链的类型化层：

```ts
// PKG/dsh-storage-domain/lib/types/index.d.ts
declare module '@deepseek-ai/cordis' { interface Context { storageDomain: DomainFacility; } }  // :27
// :80
open<S extends DomainSpec>(spec: S): Promise<Domain<S>>;   // spec 用 defineDomain 声明
// PKG/dsh-storage-domain/lib/types/domain.d.ts（Domain<KvTable>）
//   domain.table(name).get(key) / .put(key, value) / .delete(key) / .update(key, fn) / .entries()
//   domain.global.get() / .set(value)
```

装配前提：web 装配里 `storage-domain` 已挂 `backend: json`（`dsh-web-app/cordis.patch.yml:59-62`），领域数据与 `storage-json` 一样落 `$DSH_HOME/storages/`。**选型**：用户可改的配置 → `ctx.settings`；插件内部结构化状态 → `ctx.storageDomain`（类型化表）或 `dsh-atomic-write`（单文件 JSON）。

---

## 5. 配置 Schema：Schemastery `Config` 写法与 `cordis.patch.yml` 传法

### 5.1 现有插件实例（TS 插件 + typecheck 范本）

```ts
// WS/dsh-cross-session/src/index.ts:8-45
export interface Config {
  enabled: boolean
  allowSessionIds: string[]
  denySessionIds: string[]
  allowSelf: boolean
  maxRelayChars: number
  maxRecallChars: number
  maxReadMessages: number
  maxSearchResults: number
  maxSearchSnippetChars: number
  askTimeoutMs: number
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
export function apply(ctx: Context, config: Config) { /* 拿到校验+默认值后的 config */ }
```

### 5.2 Schemastery 构造器与实例方法（官方 API 面）

```ts
// PKG/schemastery/src/index.ts（Static 接口，节选）
object<X>(dict): Schema<ObjectS<X>, ObjectT<X>>
string(): Schema<string>
number(): Schema<number>
boolean(): Schema<boolean>
array<X>(inner): Schema<TypeS<X>[], TypeT<X>[]>
dict<X, Y>(inner, sKey?): Schema<Dict<...>, Dict<...>>
union<const X>(list): Schema<TypeS<X>, TypeT<X>>
intersect<const X>(list)
const<const T>(value): Schema<T>
natural(): Schema<number>; percent(): Schema<number>
// 实例方法（链式）：
required(value?: boolean): Schema<S, T>   // :157
default(value: T): Schema<S, T>           // :167
description(text): Schema<S, T>           // :171
min(value): Schema<S, T>                  // :185
max(value): Schema<S, T>                  // :183
pattern(regexp): Schema<S, T>             // :181
```

> 要点：`Config` 必须是 Standard Schema（`Schema<Config>` = `Schema.object({...})` 返回值），**不要导出普通对象字面量**；`required()` 用于严格必填（缺省即校验失败、插件加载失败并报错）；`.default()` 提供缺省值。

**`union` / `dict` / `const` / 数值约束的真实实例**（`/Users/zhoujunren/.dsh/profiles/plugins/dsh-mcp-manager/index.js`）：

```js
import z from '@deepseek-ai/schemastery'
const commonFields = {
  enabled: z.boolean().default(true),
  toolCallTimeoutMs: z.number().step(1).min(1000).max(600000).default(60000),  // step/min/max 链式
}
const ServerSpec = z.union([                      // union：二选一
  z.object({ ...commonFields, transport: z.const('stdio'),   // const：字面量枚举
             command: z.string().min(1), args: z.array(z.string()).default([]),
             env: z.dict(z.string()).default({}) }),          // dict：{ key: string }
  z.object({ ...commonFields, transport: z.const('streamable-http'),
             url: z.string().min(1), headers: z.dict(z.string()).default({}) }),
])
export const Config = z.object({ servers: z.dict(ServerSpec).default({}) })
```

### 5.3 `cordis.patch.yml` 里 `config:` 的传法

真实 patch 层（`dsh-base` bundle）示例：

```yaml
# PKG/dsh-base/cordis.patch.yml（节选）
- insert:
    - id: hmr
      name: '@deepseek-ai/cordis-plugin-hmr'
      config:
        root: ['.']                        # 数组
    - id: session-title
      name: '@deepseek-ai/dsh-session-title'
      config:
        fallbackMaxWords: 5
        fallbackMaxBytes: 40
        maxTitleBytes: 80
    - id: agent-default-model
      name: '@deepseek-ai/dsh-agent-default-model'
      config:
        provider: deepseek-official
        model: deepseek-v4-flash           # 标量/字符串
```

工作区 `--patch` 覆盖层里带注释的 config 示例（相对 profile 目录解析，插件路径用绝对路径）：

```yaml
# WS/dsh-cross-session/cordis.yml（节选）
- insert:
    - id: cross-session
      name: '/Users/zhoujunren/Code/LocalCode/dsh-cross-session/src/index.ts'
      # config:
      #   enabled: true
      #   maxRelayChars: 8000
      #   ...
```

> 结论：`cordis.patch.yml`（或 `--patch` 覆盖层）在 `insert` 行的 `config:` 下按 Schema 字段名平铺传值；**“一个 patch 替换整行 `config`，不做深合并”**（`dsh-base/cordis.patch.yml` 顶部注释明确说明）——因此插件需给全量字段或依赖 `.default()` 兜底。`dsh-agent-orchestration` 的 `teamMode` 即如此：`config: { teamMode: true }` 由 team 预设注入（见 `WS/dsh-agent-orchestration/cordis.patch.yml` 与 `index.js:117-120` 的 `config.teamMode !== true` guard）。

---

## 附：dsh-team-plan 插件落地速查（综合上述证据）

| 环节 | 用法 |
|---|---|
| Leader/Verifier 调模型拿全文 | `inject:['llm']`；`ctx.llm.stream({provider,model,messages,system,signal})` + `BlockAssembler`；`finish.kind==='error'/'aborted'` 判定失败；`createUserMessage({content:[{type:'text',text}],source:{kind:'plugin',plugin}})` 构造消息 |
| 确定性状态机 | 纯 JS 状态机（无 DSH 约束），持久化走 §4 `writeFileAtomic` |
| 派发 Worker | `inject:['subagents']`；`ctx.subagents.list()` 选 provider；`startContinuable({provider,label,request:{prompt,parent},signal})` → `{childId}`；要结构化回传加 `outputSchema`（one-shot `start()` 用，continuable 的 `request` 不含 `outputSchema` 字段） |
| 收到 Worker 产出 | 监听父 agent `agent/inbox/inserted` 或读父会话 `agent/inbox/spliced`，按 `message.source.kind` 过滤；或 `subagents.listDescendants(rootId)` + `sessions.get(childId).events` |
| Verifier 对抗验证 | 同 Leader 的 LLM 调用；失败重试 = 状态机里 `startContinuable` 再次派发（`followup`/`interrupt` 可选） |
| 配置 | `export interface Config` + `export const Config = Schema.object({...})`；`cordis.patch.yml` 的 `config:` 平铺传值 |

---

## 未找到 / 不确定清单（诚实标注）

1. ~~无官方 `$DSH_HOME/storages` 目录约定~~（已更正）—— **官方约定存在**：`dsh-web-app/cordis.patch.yml:57` 把 `storage-json` 的 `root` 配为 `!!js dshHomePath('storages')`（默认 `~/.dsh/storages`），实测 `~/.dsh/storages/` 已有 `workspace.json`、`session_projcache.json`。但 `storages` 这个目录名是 **web 装配注入**、非 `dsh-storage-json` 包内默认（其 `Config.root` 无默认值）；§4.4 已按此更正。
2. **`/team` 斜杠命令不存在**：`dsh-team-mode/route.js:20-21` 引用的 `dsh-team-mode/control` 独立插件**未实现/未装配**，全包无 `ctx.commands.register('team', …)`；团队模式靠 `config.teamMode` + `agent/pre-step` + `teamMode` 服务切换。`/plan`、`/goal`、`/compact` 才是经 `ctx.commands` 注册的真命令。
3. **`ctx.llm.adapterStream` 是 `private`**（`dsh-llm/lib/types/index.d.ts:325`），插件不可调用；公开流式入口只有 `stream()` 与 `PreparedLlmCall.stream()`。
4. **`outputSchema`（结构化结果）仅在一次性 `start()` 的 `SubagentStartRequest` 上**；`startContinuable` 的 `request` 类型是 `Omit<SubagentStartRequest,'label'|'signal'|'outputSchema'>`（`continuation.d.ts:89`），即 **continuable 路径拿不到 `structured`**，产出靠 report/settled 消息文本或 `agent/inbox/spliced`。
5. **“父会话得知子代理完成”没有专门的 `subagent/finished` 事件给父会话订阅**：`subagent/end` 事件 payload（`SubagentRunEndInfo`，`types.d.ts:49-66`）不携带 parent；父侧正确信号是 inbox 注入（`agent/inbox/inserted`/`agent/inbox/spliced`）或轮询会话日志（见 §3.3/§3.4）。这部分结论来自类型声明与 `dsh-agent-orchestration` 的实现推断，未逐行读 `SubagentContinuationManager` 的 `notifySettlement` 运行实现。
6. **`ctx.harness.handle(...)` / `ctx.registry.register({name,value})` / `ctx.webServer.register(...)`** 在 `dsh-team-mode` / `dsh-agent-orchestration` 中出现，但本清单未深挖其类型声明（`ctx.harness` 的 `handle`、`ctx.webServer` 的 `register` 签名），如需在 `dsh-team-plan` 里注册 REST/JSON 通道需另行核对这两个服务的 `.d.ts`。
