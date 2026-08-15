# 画布 v2 设计:纯拓扑图(轻松随意 · 柔性连线)

> 2026-08-16 · 已获用户批准的简化方案。替代原"三布局 + 抽屉 + 状态栏"的仪器级设计。

## 决策记录

1. **只保留拓扑一种形态**:横向 DAG 树(源点队长在左 → 派发边逐层向右 → 叶子虚线汇总边收口到最右"汇总报告")。删除纵向(flow)、泳道(lane)布局与三布局切换器。
2. **纯图**:头部只留标题 + 关闭(Esc);删除跟随/复位/刷新按钮、团队模式徽章、底部状态栏、右侧详情抽屉。
3. **详情改轻量浮层**:点节点 → 在点击位置弹出 320px 小面板(标题/状态/统计/时间线),点空白或 Esc 关闭。
4. **柔性连线**:全部贝塞尔曲线;线中点有可拖"弯曲把手"(拖垂直方向改变曲率,持久化到 ref + edge data);端点重连走 React Flow 内置锚点(`edgesReconnectable`);命中区加宽。
5. **间距放宽**:层距 250→340px,行距 130→190px,fitView padding 0.25。
6. **弹簧物理不做**(用户"只做图"的最小化取向),视觉取"轻快松弛":暗色底不变,圆角加大、边框对比度降低、允许柔和氛围阴影、状态色降饱和。

## 性能修复(实测驱动,26 节点 40 连线基线:8 个 50~79ms 长任务 / 最坏帧 408ms)

| # | 根因(第一性原理) | 修复 |
|---|---|---|
| P1 | hover 暗化走 React 状态:setHoverId → edges useMemo 依赖 hoverId → 每次翻转重建全部 40 条边 → 全量 reconcile + 40 次 className 写入,拖拽途中高频触发 | 移除 hoverId 状态;节点 hover 暗化改为**直接写 DOM class**(O(E) 写、零重渲染);边 hover 暗化改纯 CSS `:has()` |
| P2 | 拖拽经过其他节点触发 enter/leave 联动 | `draggingRef` 拖拽中忽略 hover 联动 |
| P3 | `mergePoll` 数据未变也返回新数组 → 每 2.5s 全图 26 节点 + 40 边 reconcile | 签名全等时返回原数组引用,零变更零渲染 |
| P4 | 视口外节点/边照常渲染 | `onlyRenderVisibleElements` |
| P5 | 拖拽中 40 条边 opacity transition 反复重启 | 拖拽期间 `[data-dragging]` 暂停 transition |

## 验收口径

- 构建:`node build-client.mjs` 成功;`node --check dist/client.js` 通过。
- 重测:同一浏览器实测方法(真实鼠标拖拽 + rAF/长任务探针),26 节点图上长任务数应显著下降(目标 0~1 个)、最坏帧 <100ms。
- 交互:三布局按钮/抽屉/状态栏不存在;点节点出浮层;线中点可拖弯;边端点可滑动重连;Esc 逐层关闭。

## 实测记录(实现期发现,比计划多出 5 个坑)

| # | 现象 | 根因 | 处置 |
|---|---|---|---|
| D1 | 把手拖不动,onBend 零调用 | RF 平移系统(d3-zoom)在 viewport 层 stopImmediatePropagation 吃掉 pane 内 mousedown 冒泡 | 把手加 `nopan` 豁免类 + 用 mouse 事件(pointer 事件同样被截断) |
| D2 | 改曲率后路径纹丝不动 | v12.11.3 的 `getBezierPath` 对"源右→目标左"朝向忽略 curvature(offset 恒为 0.5*distance) | 弃用 curvature,自算二次贝塞尔:控制点 = 中点 + 可拖偏移(节点移动时弯曲跟随) |
| D3 | updateEdgeData 不生效 | 受控模式下 store 更新不触发渲染(不报错静默失败) | onBend 走受控路径:写 ref + bendTick 触发 edges memo 重建 |
| D4 | 大图切换后只渲染 3 个节点 | 节点数变化不重排视野,onlyRenderVisibleElements 裁掉视口外节点,且复位按钮已删 | 节点数增减时自动 fitView(拖拽中跳过) |
| D5 | 重连锚点不渲染 | 受控模式要求显式 onReconnect 回调;且声明顺序 bug(reconnectRef 在 edges memo 之后声明导致 TDZ) | onReconnect 本地覆盖 ref + 重建边;声明上移 |

## 验证结果

- 纯图形态:0 布局切换 / 0 状态栏 / 0 抽屉,头部仅关闭钮;点节点弹 320px 详情浮层 ✓
- 弯曲把手:真实/合成事件均可拖,路径即时变化,轮询后持久 ✓
- 重连:8 个锚点已渲染(RF 官方 wiring 生效);**完整拖拽重连需人工实测**(自动化无法驱动 RF 连接内部依赖的可信事件流)
- 性能复测(26 节点/40 连线,真实鼠标拖拽,修复前后对比):

| 指标 | 修复前 | 修复后(拖拽隔离) |
|---|---|---|
| 长任务(>50ms) | 8 个(50~79ms) | **0** |
| 最坏帧 | 408ms | **16.8ms** |
| >32ms 掉帧 | 45 | **0** |
| p99 | 21.6ms | **16.8ms** |

## v2.1 修复与增强(2026-08-16,用户反馈)

| 项 | 问题/需求 | 处置 | 验证 |
|---|---|---|---|
| 节点拖拽失效 | RF 内置 XYDrag 在本环境完全不生效(实测:d3 mousedowned 监听器已挂载、直接调用也不产生位移,根因未明) | **自研拖拽**:OrchNode 自己处理 mousedown(window 级 move/up 追踪 + screenToFlowPosition 增量 + positionAbsolute 基线),受控位置 state 回写;拖拽结束 300ms 内抑制 click 浮层 | 真实拖拽节点位移 128→521;拖拽不开浮层、纯点击开浮层;位置跨轮询保持 |
| 边线"死板" | 需要流动性 | 每条连线叠加 `.orch-flow-line` 流动粒子层(虚线偏移动画,2.2s 循环;运行中边 0.9s 加速高亮;reduced-motion 静态);不影响弯曲把手与重连 | 23 条连线全部带流线,弯曲把手拖拽仍正常 |
| 浮层崩溃 | onDragNode 在 nodes memo 之后声明导致 TDZ(与早期 reconnectRef 同类错误) | 声明上移 | 画布正常打开 |

## v2.2 增量流式加载(2026-08-16,用户反馈:加载缓慢)

**问题**:画布要等 Host 端把全部节点(血缘树 + 逐会话状态扫描 + 工作流折叠 + 标题修复 + 计划层)构建完成后才一次性返回,客户端拿到完整数组才渲染——大量冷会话读取时首屏长时间空白。

**方案**:增量式、逐个实时构建并渲染。

| 层 | 处置 |
|---|---|
| Host | 新增 `GET /plugins/dsh-agent-orchestration/stream`:NDJSON 逐行下发事件(`init / nodes / update / remove / done` + `:hb` 心跳),`x-accel-buffering: no` 防缓冲;客户端断开即停止。原 `fetchData` 重构为 `buildCanvas(rootId, emit, staggerMs)` 增量构建器:`/stream` 逐条写出,`/data` 复用同一事件流聚合为旧版快照(轮询与回退兼容,响应语义不变) |
| 构建顺序 | init → **队长(立即)** → 血缘后代**逐个下发**(占位状态) → 状态扫描**并发执行、完成一个 update 一个** → 工作流折叠(补 `remove` 事件剔除被折叠成员) → 汇总报告(有后代即随拓扑下发,不等工作流折叠) → 标题修复 → 计划层逐文件下发 → `done` |
| Client | `fetch` + `ReadableStream` 逐行解析,每到一个节点立即 `applyNodeEvents` upsert 进 `nodesData`(抽为 `src/nodes-merge.js` 纯函数:追加保序、update 原位、同签名复用原对象零渲染);流式期间抑制轮询与自动 fitView,首帧/收口各 fit 一次;头部显示「增量构建中」;失败/30s 看门狗自动回退全量 `/data` |
| 语义保持 | `/data` 聚合快照与旧版字段/优先级一致(标题 > 「你的分工」标签 > 截断标签;状态解析逻辑不变),由 `titledIds` 保护流式乱序下的标签优先级 |

**验证证据**(`node --test test/stream.test.mjs`,6/6 通过):

- 事件序列:init → 队长 → 后代逐个 → update → done;工作流折叠 emit `remove`;演示模式带 60ms stagger 逐节点呈现。
- 时序(慢冷会话读取 350ms 场景):4 个拓扑节点全部 <300ms 下发,update/done ≥300ms——**慢扫描不再阻塞拓扑可见**。
- 聚合一致性:`/data` 快照与旧版字段一致(5 节点场景、状态解析、「你的分工」标签修复、工作流折叠)。
- 语法门禁:`node --check index.js` / `node --check dist/client.js` / `node --check src/nodes-merge.js` 通过;`node build-client.mjs` 产出 439831 bytes。

**生效方式**:服务端模块(`link:` 挂载)需重启 GUI(`bash ~/.dsh/restart-dsh-web.sh`)后刷新页面;旧服务端无 `/stream` 路由时客户端自动回退 `/data`,兼容过渡期。
