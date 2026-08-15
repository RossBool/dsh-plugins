# dsh-team-mode — 团队模式开关

为协作类能力（协作画布、协作路由）提供显式启停的进程级与会话级开关。

## 功能简介

- 注册进程级单例 `teamMode` 服务，供其他插件查询/订阅。
- 维护两层状态：全局开关 `global`（默认 false）+ 会话级覆盖 `sessions[id]`（true 强制开 / false 强制关 / undefined 跟随全局）。
- 客户端提供团队模式切换按钮；Host 提供协作路由（仅团队模式开启时触发多 agent 派发）。

## 能力

| 模块 | 说明 |
| --- | --- |
| `index.js`（team-mode-host） | 注册 `teamMode` 服务 + JSON 通道（get/set-global/set-session/subscribe） |
| `route.js`（team-mode-route） | 团队协作路由：检测协作信号 → 拆分任务 → 派发子代理团队（团队模式门控） |
| `src/client.jsx`（team-mode-toggle） | 右上角团队模式徽章按钮，点击切换全局开关 |

`teamMode` 服务接口：

| 方法 | 作用 |
| --- | --- |
| `isActive(sessionId?)` | 查询是否团队模式（会话覆盖优先于全局） |
| `getGlobal()` / `setGlobal(v)` | 读写全局开关 |
| `getSessionOverrides()` / `setSession(id, v)` | 读写会话覆盖 |
| `subscribe(handler)` | 订阅 `team-mode/change` 事件，返回 disposer |
| `snapshot()` | 当前全局值 + 覆盖快照 |

## 使用方式

### 安装与挂载

装配见 `cordis.patch.yml`（三行）：

```yaml
- insert:
    - id: team-mode-host
      name: dsh-team-mode
    - id: team-mode-route
      name: dsh-team-mode/route
    - id: team-mode-toggle
      name: dsh-team-mode/toggle
```

### 使用

- 点击 GUI 右上角「团队模式」徽章切换全局开关（绿色=开，灰色=关）。
- 开启后，输入含协作信号的自然语言（并行/同时/分头/组队/多角度/一起跑/兵分/拆成/分给…）即触发团队协作路由。
- 控制指令 `/team on|off|once|auto` 由独立的 control 插件处理；本路由只读不写 teamMode。

### 级联防护

路由内置多重防护：顶层会话限定、全局任务指纹去重、级联标记拦截、组队频控（10 分钟 ≤6 次）、单会话终身限制（≤2 次/每回合 1 次）、团队模式门控。

### 构建客户端

```bash
npm run build   # 生成 dist/client.js
```
