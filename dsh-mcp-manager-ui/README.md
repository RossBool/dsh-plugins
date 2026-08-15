# dsh-mcp-manager-ui — MCP 服务器管理 Web UI

在 DSH Web GUI 的「Settings → MCP 服务器」页面提供 MCP 服务器的可视化管理。

## 功能简介

- 可视化增删改查 MCP 服务器（stdio / streamable-http 两种传输）。
- 启用/停用开关，运行时状态实时展示：连接中 / 已连接 N 个工具 / 重连中 / 失败。
- 所有改动通过 settings wire API 写入 Host（settings.yaml 用户层），实时热生效，无需命令行或手工编辑文件。

## 能力

| 能力 | 说明 |
| --- | --- |
| 服务器增删改查 | 表单化配置 stdio（command/args/env/cwd）或 streamable-http（url/headers） |
| 启停开关 | 停用即卸载实例并取消注册其工具 |
| 状态展示 | 状态色圆点 + 已注册工具列表 + 错误信息 |
| 状态轮询 | 通过 `/mcp-status` 返回的 JSON 刷新页面 |

## 使用方式

1. 与 `dsh-mcp-manager`（Host）一起挂载（见其 README）。
2. 打开 GUI 的「Settings → MCP 服务器」页面即可管理。
3. 客户端源码 `client.js` 修改后刷新浏览器页面即生效，无需重启进程。

宿主侧为无操作占位（`apply()` 为空），真正的功能在 `./client`。
