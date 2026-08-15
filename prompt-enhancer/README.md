# prompt-enhancer — 提示词增强插件（重构版）

用 LLM 把一条粗略的提示词改写成更清晰、更高质量的它本身：同语言、同形态（散文还是散文、列表还是列表）、同意图，只提升清晰度——不做「角色 / 目标 / 步骤 / 约束 / 输出格式」的固定格式转写。

## 使用方式

- **输入框按钮（推荐）**：输入框工具栏、模型选择左侧的 Notion AI 风格 ✨ 图标按钮。点击后图标变 loading（再点=取消），完成后增强文本直接填入输入框，你检查后自己发送。
  - 增强完成后按钮变「恢复」图标：一键回撤原文；一旦你在增强结果上继续编辑，恢复能力自动失效。
  - 增强期间你手动编辑了草稿 → 结果自动丢弃，**绝不覆盖你的编辑**（内容不变量）。
  - 切换会话 → 进行中的增强自动取消。
  - 失败时图标变红，鼠标悬浮看原因（按错误码本地化）。
- **斜杠命令**：输入 `/enhance 帮我写个爬虫`，直接返回增强后的提示词。
- **模型工具**：对话中说“把这段提示词增强一下”，agent 会调用 `enhance_prompt` 工具。
- **自动增强**（可选）：配置 `autoEnhance: true` 后，进入 agent 的用户消息会被自动增强；失败时自动放行原文。短消息（如“继续”）与 `/` 开头的指令不会被改写。

## 架构（四个入口共享一个增强核心）

```
POST /api/enhance-prompt   —— 输入框按钮：JSON 无损传输、单一请求-响应、端到端 abort
/enhance <prompt>          —— 斜杠命令（同步）
enhance_prompt 工具         —— agent 调用
agent/pre-step autoEnhance —— 自动增强（fail-open）
```

- **模型路由解析链**：显式配置 `provider/model` → 会话当前选中模型（按钮经请求体；工具/命令经 agent.options）→ harness 默认模型（`agentDefaultModel.currentSelection()`）。
- **HTTP 路由安全**：Origin/Sec-Fetch-Site 跨站校验（防恶意网页刷本机额度）、请求体 ≤64KB、并发上限 4。
- **路由自愈注册（2026-08-15）**：`webServer` 是独立纤维提供的服务，apply 时可能尚未就绪；本插件监听 `internal/service` 事件，服务一出现即注册路由（重启后不再出现「启动窗口内按钮 404 直到下次热重载」的问题）。
- **取消/断开**：浏览器 abort → `res close` → `AbortController` → `llm.stream` 全链路 abort（实测验证：curl 中途断开后服务端门闩立即释放）。
- **语言保持（双层约束）**：系统提示词最高优先级规则 + 用户消息尾部硬性指令；`auto` 在服务端用 CJK 检测落成具体语言（可计算的事实不委托 LLM），英文输入不再漂移成中文。
- **输出信封协议（2026-08-15，抄自 WorkBuddy 官方 /enhance-prompt）**：模型输出 `<enhanced-prompt>…</enhanced-prompt>` 标签，`extractEnhancedText` 取标签内文本、无标签时退回全文（fail-open）——比裸文本协议更抗"模型带前缀/后缀唠叨"。
- **代码块保护（同上来源）**：输入里三反引号内的代码视为代码样例、保持原样——增强不会改写用户贴的代码。
- **FR-10 引号清理**、**FR-11 用量/耗时日志**（含 `cacheReadTokens` 缓存命中观测）。

## HTTP 契约

```
POST /api/enhance-prompt
Req : { "text": string, "provider"?: string, "model"?: string, "sessionId"?: string }
Resp: 200 { "ok": true,  "text": "增强后文本（已去包裹引号）" }
      4xx/5xx { "ok": false, "code": "empty_input" | "provider_unavailable"
              | "llm_error" | "timeout" | "rate_limited" | "unknown",
              "error": "人类可读信息" }
```

## 配置

两层配置：`~/.dsh/profiles/web/cordis.patch.yml` 的 `config:`（组合层）与 `~/.dsh/settings.yaml` 的 `prompt-enhancer` 命名空间（用户层，实时生效，优先级更高）。

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `autoEnhance` | `false` | 是否自动增强进入 agent 的用户消息 |
| `provider` / `model` | 未设置 | 增强调用模型路由；缺省时依次跟随会话模型、harness 默认模型 |
| `maxTokens` | `1024` | 增强输出上限 |
| `timeoutMs` | `30000` | 增强调用超时 |
| `temperature` | `0.3` | 采样温度 |
| `reasoningEffort` | `off` | 推理强度（改写任务不需要推理，省 token 省延迟）；模型不支持时自动回退默认 |
| `includeOriginal` | `true` | 自动增强时是否附上原文供模型核对 |
| `language` | `auto` | 增强结果语言；`auto` 按输入检测（含 CJK 字符→中文） |
| `minLength` | `12` | 自动增强的最短消息长度（更短的放行） |
| `section` | `true` | 是否注册系统提示词说明段 |
| `system` | 内置指令 | 自定义增强指令，非空时替换内置指令 |

## 安装与更新

挂载见 `~/.dsh/profiles/web/cordis.patch.yml`：

```yaml
- insert:
    # 服务端：绝对路径 + ?rev 加载，改代码后递增 rev 即可热更新（绕过 ESM 缓存）
    - id: prompt-enhancer
      name: /Users/zhoujunren/.dsh/profiles/plugins/prompt-enhancer/index.js?rev=14
    # Web UI 客户端
    - id: prompt-enhancer-ui
      name: prompt-enhancer-ui
```

**单一真身（2026-08-15 起）**：`profiles/web/node_modules/prompt-enhancer` 与 `prompt-enhancer-ui` 都是指向 `profiles/plugins/` 的**符号链接**，`package.json` 用 `link:` 声明——`pnpm install` 不会把它们变回拷贝。改 `profiles/plugins/` 下的文件即可，**不存在需要手动同步的第二份副本**。

**更新步骤（顺序重要：先客户端后服务端，避免窗口期按钮调不到新路由）**：

1. **客户端**（改 `machine.js` 或 `client.template.js`）：运行 `node build.mjs`（把纯状态机嵌入 bundle；部署路径经符号链接即本目录），浏览器热更新/刷新生效。
2. **服务端**（改 `index.js`）：把 yaml 里的 `?rev=14` 递增为 `?rev=15`（每次 +1）即热加载，**无需重启进程**；改完用 `curl -s -X POST http://127.0.0.1:3080/api/enhance-prompt -H 'content-type: application/json' --data '{"text":"帮我写个爬虫"}'` 验证生效。
3. UI 包首次安装或 package.json 变化：`dsh plugin --profile web add file:/Users/zhoujunren/.dsh/profiles/plugins/prompt-enhancer-ui`。

## 测试

零依赖（node 内置 test runner）：

```sh
node --test test/enhance-core.test.mjs   # 服务端纯函数：引号清理/错误映射/路由解析/语言检测/framing（10 用例）
cd ../prompt-enhancer-ui && node --test test/machine.test.mjs   # 状态机全转移枚举 + createSend 守卫回归（21 用例）
```

被测代码就是线上代码：服务端从 `index.js` 的 `@pure-start…@pure-end` 区抽取求值；客户端状态机 `machine.js` 经 `build.mjs` 嵌入 bundle，单一事实源。

## 文件

- `plugins/prompt-enhancer/index.js`：服务端插件（四个入口 + HTTP 路由 + 安全层）
- `plugins/prompt-enhancer/test/enhance-core.test.mjs`：服务端纯函数单测
- `plugins/prompt-enhancer-ui/machine.js`：纯状态机（单一事实源）
- `plugins/prompt-enhancer-ui/client.template.js`：客户端 bundle 模板
- `plugins/prompt-enhancer-ui/build.mjs`：嵌入 machine → 产出并部署 `client.js`
- `plugins/prompt-enhancer-ui/index.js`：客户端包的宿主占位（无操作）
