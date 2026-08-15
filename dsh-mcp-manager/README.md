# dsh-mcp-manager — MCP 服务器管理器（Host）

在 DeepSeek Harness 中管理 MCP 服务器：配置增删改查、启停、运行时状态监控，改动实时热生效。

## 功能简介

- 通过 settings 命名空间 `mcp-servers` 持久化服务器配置（写入 `$DSH_HOME/settings.yaml` 用户层）。
- 对每个启用的服务器动态挂载官方 `@deepseek-ai/dsh-mcp-client` 实例，工具注册为 `mcp__<serverName>__<tool>`，失败自动重连、配置变化热卸载。
- 提供 `/mcp-status` 命令，返回各服务器运行时状态 JSON。

## 能力

- 支持两种传输：`stdio`（本地子进程）与 `streamable-http`（远程端点）。
- 配置变化自动对账：新增/变更 → 挂载，删除/停用 → 卸载。
- 失败自愈：挂载失败 1.2s 后自动重试一次，60s 内不再重试；每 10s 自愈检查 settings 注册健在。
- 首次启动自动植入一个演示服务器（`mcp-demo-server`），可在 UI 中删除。

## 使用方式

### 安装与挂载

在 `cordis.patch.yml` 中插入宿主行（配合 `dsh-mcp-manager-ui` 提供管理页面）：

```yaml
- insert:
    - id: dsh-mcp-manager-host
      name: /path/to/dsh-mcp-manager/index.js
    - id: dsh-mcp-manager-ui
      name: dsh-mcp-manager-ui
```

### 命令

| 命令 | 作用 |
| --- | --- |
| `/mcp-status` | 返回各 MCP 服务器运行时状态（serverName/enabled/state/toolCount/tools） |

### 服务器配置结构

```jsonc
{
  "servers": {
    "demo": {
      "transport": "stdio",            // 或 "streamable-http"
      "command": "/usr/bin/node",
      "args": ["/path/to/server.js"],
      "env": {},                        // 额外环境变量
      "cwd": "",
      "enabled": true,
      "toolCallTimeoutMs": 60000
    }
  }
}
```

`streamable-http` 形态改为 `{ "transport": "streamable-http", "url": "...", "headers": {} }`。
服务器名须满足 `[A-Za-z0-9_-]{1,32}`。

> 配置由 `dsh-mcp-manager-ui` 页面写入，无需手工编辑 settings.yaml。
