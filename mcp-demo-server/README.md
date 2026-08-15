# mcp-demo-server — MCP 演示服务器

一个最小的 stdio MCP 服务器，用于演示 DeepSeek Harness 的 MCP 桥接：每个注册的工具都会成为 Agent 的 `mcp__demo__<tool>` 工具，并附带一个轻量持久化字符串 KV 存储。

## 功能简介

- 基于 `@modelcontextprotocol/sdk`，通过 stdio 与 Harness 的 `@deepseek-ai/dsh-mcp-client` 桥接。
- 同时作为「真实能力」演示：内置一个持久化字符串 KV 存储（落盘 `storage.json`）。

## 能力（工具）

| 工具 | 作用 |
| --- | --- |
| `echo` | 原样回显文本（连通性冒烟测试） |
| `add` | 两数相加 |
| `now` | 返回当前时间（ISO 8601 + epoch 毫秒） |
| `uuid` | 生成随机 UUID v4 |
| `memory_set` | 持久化一个 key → 字符串 |
| `memory_get` | 读取 key 对应值（不存在返回空串） |
| `memory_list` | 列出所有 key |
| `memory_delete` | 删除 key |

## 使用方式

### 独立运行

```bash
node server.js
```

（通过 stdio 通信，stderr 用于日志。）

### 挂载到 DSH

由 `dsh-mcp-manager` 首次启动时自动植入为演示服务器；或手动在 settings 中配置：

```jsonc
{
  "transport": "stdio",
  "command": "/path/to/node",
  "args": ["/path/to/mcp-demo-server/server.js"],
  "cwd": "/path/to/mcp-demo-server",
  "enabled": true
}
```

挂载后 Agent 获得 `mcp__demo__*` 工具族。

## 配置

| 环境变量 | 默认 | 说明 |
| --- | --- | --- |
| `MCP_DEMO_STORAGE` | `<插件目录>/storage.json` | KV 存储落盘路径 |

辅助脚本：`smoke.mjs`（连通性冒烟）、`schema-check.mjs`、`check-patch.mjs`。
