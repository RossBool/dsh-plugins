# dsh-cross-session 跨会话交互插件

让 DeepSeek Harness 的多个对话会话（agent）可以互相发现、读取、搜索、发消息，以及同步问答。基于 dsh 官方公开 API：`ctx.agents`（Agent 注册表与 inbox 投递）、`ctx.sessionQuery`（跨会话读取/检索）、`relay` 上下文形态（跨会话消息标准标记）。

## 工具

| 工具 | 作用 |
|---|---|
| `session_list` | 列出所有会话（id/标题/cwd/运行状态/创建时间），支持关键词过滤 |
| `session_read` | 读取另一个会话最近的消息记录（用户/助手/工具结果） |
| `session_search` | 跨会话搜索关键词；全文索引未启用时自动回退为文本扫描 |
| `session_send` | 异步投递消息给另一个会话（唤醒对方，对方可用同一工具回复） |
| `session_ask` | 同步提问：投递后等待对方处理完，取回完整回复（带超时） |

## 安装

### 1. 安装依赖（符号链接到本机 dsh 安装目录）

```sh
cd /Users/zhoujunren/Code/LocalCode/dsh-cross-session
npm install
```

`package.json` 里的 `@deepseek-ai/*` 依赖用 `file:` 协议指向本机 dsh 安装目录下的同版本包，保证与宿主进程版本一致。

### 2. 挂载并启动

```sh
dsh --profile web --patch /Users/zhoujunren/Code/LocalCode/dsh-cross-session/cordis.yml
```

> 注意：`--patch` 是 launcher 参数，必须放在 `web` 之前（`web` 别名不接受 launcher 参数）。

或者把 `cordis.yml` 里的 `insert` 条目合并进你的 profile / home 级 `cordis.patch.yml`，随现有启动方式生效。启动后看到日志：

```
[cross-session] 跨会话交互插件已加载：session_list / session_read / session_search / session_send / session_ask
```

> 注意：需要重启 Web 应用才会加载插件（当前部署未启用 HMR 热更新）。

## 使用

在任意会话里直接让 agent 干活即可，例如：

- 「用 session_list 看看有哪些会话」
- 「把下面这段话用 session_send 发给会话 <id>」
- 「用 session_ask 问会话 <id>：帮我看看 xxx 项目的启动命令是什么，30 秒内回复」
- 「用 session_read 看看会话 <id> 最近的进展」
- 「用 session_search 搜一下哪个会话讨论过『支付回调』」

### 双向对话

消息到达目标会话时会带标准【跨会话消息】信头（含来源会话 id 与标题），目标 agent 用同一个 `session_send` 就能回复；收到回复的一方也会被唤醒处理，形成双向交互。

## 配置

在 `cordis.yml` 的 `config:` 下覆盖（配置变更会自动热替换插件实例）：

| 配置 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 插件总开关 |
| `allowSessionIds` | `[]` | 允许交互的会话白名单（空 = 不限） |
| `denySessionIds` | `[]` | 拒绝交互的会话黑名单 |
| `allowSelf` | `false` | 是否允许会话给自己发消息 |
| `maxRelayChars` | `8000` | 发送消息正文最大字符数 |
| `maxRecallChars` | `30000` | 读取/回复/搜索输出最大字符数 |
| `maxReadMessages` | `50` | `session_read` 最多读取条数 |
| `maxSearchResults` | `20` | `session_search` 最多命中数 |
| `maxSearchSnippetChars` | `300` | 搜索片段最大字符数 |
| `askTimeoutMs` | `300000` | `session_ask` 等待超时（毫秒） |
| `autoResume` | `false` | 目标离线时自动恢复持久化会话（处理完自动回收） |

## 注意事项

- **`session_send` / `session_ask` 只触达运行中的会话**；要触达离线但已持久化的会话请开启 `autoResume`（恢复出的会话处理完消息后自动回收）。
- **避免互相 `session_ask`**：两个会话互相同步等待会死锁到超时。纯互聊场景用 `session_send`。
- `session_ask` 返回 `timedOut: true` 时，`reply` 是已产生的部分回复；`concurrent: true` 表示等待期间对方还处理了其他输入，回复可能混杂。
- 默认部署 `session-query-sqlite` 的 `openAt: never`，全文检索不可用；`session_search` 会自动回退为逐会话文本扫描（`engine: scan`）。
- 发送的消息以官方 `relay` 上下文形态进入目标会话的持久化日志，可被会话历史回放与 UI 识别。

## 开发

```sh
npm run typecheck        # tsc 严格类型检查（noEmit）
```

目录结构：`src/index.ts`（插件入口 + 配置）、`src/relay.ts`（发送/提问）、`src/recall.ts`（列出/读取/搜索）、`src/shared.ts`（公共工具函数）。

