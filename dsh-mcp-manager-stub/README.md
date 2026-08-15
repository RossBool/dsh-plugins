# dsh-mcp-manager-stub — 占位包

无操作占位插件：接管旧客户端条目 id `dsh-mcp-manager`，保持 boot 清单干净。

## 功能简介

真正的 MCP 管理功能由 `dsh-mcp-manager`（Host）与 `dsh-mcp-manager-ui`（Web UI）提供。本包仅作为一个无操作的客户端条目占位，避免旧的客户端加载器按 id `dsh-mcp-manager` 找不到模块而报错。

## 能力

- 宿主侧 `apply()` 无操作。
- 客户端侧注册一个空的 `dsh-mcp-manager` 工厂，返回 `apply = () => {}`、`inject = []`。

## 使用方式

无需单独使用，与 MCP 管理器套件一起挂载即可。无需构建、无需配置、无运行时行为。
