# dsh-plugins

DeepSeek Harness（DSH）插件合集：本仓库集中收录我开发的一批 DSH 插件，涵盖协作编排、计划驱动协作、话题时间轴、语音输入、MCP 管理、提示词增强等能力。

## 插件清单

| 目录 | 说明 |
| --- | --- |
| `dsh-agent-orchestration` | Agent 协作与编排：协作画布（React Flow）+ 自然语言协作路由层，由 team 预设以 `config.teamMode: true` 挂载 |
| `dsh-team-plan` | 计划驱动协作引擎：Leader 生成计划 → 确定性状态机 → Worker 子代理 → Verifier 对抗式质量门禁（重试回环） |
| `dsh-topic-timeline` | 话题时间轴侧栏（Topic Tick Axis）：对话旁蓝色竖向刻度轨 + 日期分组 + 迷你卡片 tooltip |
| `dsh-voice` | 语音输入：麦克风按钮 → 浏览器原生录音 → 转文字 → 填入输入框（支持 AI 增强扩充） |
| `dsh-mcp-manager` | MCP 服务器管理（服务端） |
| `dsh-mcp-manager-ui` | MCP 服务器管理页面的 Web UI 客户端（Settings → MCP 服务器） |
| `mcp-demo-server` | MCP 演示服务器（add/echo/memory/uuid/now 等示例工具） |
| `prompt-enhancer` | 提示词增强（服务端）：`enhance_prompt` 工具 + `/enhance` 命令 + 后台增强任务 |
| `prompt-enhancer-ui` | 提示词增强的 Web UI 客户端（输入框工具栏图标按钮） |

## 目录结构

```
dsh-plugins/
├── dsh-agent-orchestration/   # 协作编排
├── dsh-team-plan/             # 计划驱动协作引擎
├── dsh-topic-timeline/        # 话题时间轴
├── dsh-voice/                 # 语音输入
├── dsh-mcp-manager/           # MCP 管理（服务端）
├── dsh-mcp-manager-ui/        # MCP 管理（Web UI）
├── mcp-demo-server/           # MCP 演示服务器
├── prompt-enhancer/           # 提示词增强（服务端）
└── prompt-enhancer-ui/        # 提示词增强（Web UI）
```

## 构建说明

部分带客户端 UI 的插件（`dsh-agent-orchestration`、`dsh-voice` 等）的浏览器端 bundle `dist/client.js` 为构建产物，未纳入版本控制。使用时先安装依赖并构建：

```bash
cd <插件目录>
npm install
npm run build        # 生成 dist/client.js
```

纯服务端插件（如 `dsh-team-plan`）可用 `npm run typecheck` / `npm test` 做校验。

## 安装到 DSH

插件通过 profile 挂载（`file:` 安装或软链），详见各插件目录内的 `cordis.patch.yml` / `cordis.yml` 与 README。挂载配置属本地环境，不随本仓库分发。
