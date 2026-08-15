# dsh-agent-orchestration — 协作画布与编排

把不可见的「多智能体协作」变成一张可读、可信、可操作的结构图，并支持用自然语言触发子代理团队协作。

## 功能简介

- **协作画布（React Flow）**：实时展示子代理血缘树——谁派生了谁、每个成员在做什么、工作流如何折叠、连线如何流动。
- **自然语言协作路由**：检测用户输入中的协作信号（并行/分头/组队/多角度…），按分句拆解任务并派发并行子代理团队，向主会话注入队长汇总指令。
- 普通对话零开销直通；仅当团队模式开启时才执行派发（保守默认关闭）。

## 能力

| 模块 | 说明 |
| --- | --- |
| `index.js`（Host） | 画布数据服务 + 编排 REST 路由 |
| `route.js`（Host） | 自然语言协作路由层（`agent/pre-step` 瀑布 + 六重级联防护） |
| `src/client.jsx`（Client） | React Flow 协作画布 |

提供的 REST 路由：

| 路由 | 作用 |
| --- | --- |
| `GET /plugins/dsh-agent-orchestration/data` | 画布编排树（子代理血缘 + 工作流折叠 + 归档过滤） |
| `GET /plugins/dsh-agent-orchestration/detail` | 节点执行详情时间线 |
| `GET /plugins/dsh-agent-orchestration/stream` | 增量流式构建：逐节点 NDJSON 下发 |
| `GET /plugins/dsh-agent-orchestration/team-mode` | 团队模式状态 |

## 使用方式

### 安装与挂载

通过 profile 挂载，装配见 `cordis.patch.yml`（`orchestration-host` + `orchestration-route` 两行）。协作路由默认关闭，需在预设中以 `config.teamMode: true` 开启。

### 构建客户端 bundle

```bash
npm install
npm run build   # 生成 dist/client.js（浏览器端画布）
```

### 触发协作

在顶层会话输入含协作信号的自然语言（如「并行检查 A 和 B」），路由会拆分任务并派发子代理团队，画布实时展示协作结构。

## 配置

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `teamMode` | `false` | 是否启用协作路由（保守默认关闭） |

更多产品与设计细节见 `PRODUCT.md`、`DESIGN-canvas-v2.md`。
