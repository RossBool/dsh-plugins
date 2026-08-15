# dsh-topic-timeline — 话题时间轴侧栏插件

Topic Tick Axis / Thread Ruler for the DeepSeek Harness Web GUI（dsh web）。

在会话内容区左侧渲染一条竖排刻度轴，设计借鉴 ZCode 桌面版的 task timeline
（内容渲染、动效、时间分组算法）：

- 每条短横线 = 一个话题（一条用户消息开启的 turn），刻度簇集中在中部
- **默认刻度统一长度（16px），只有当前正在查看的话题加长到 30px 蓝色高亮 + 三层辉光呼吸**（滚动时
  自动跟随视口）；正在生成的话题显示流光渐变（1.2s 扫过 + 1.2s 停）+ 发光呼吸脉冲
- 平时刻度保持固定长度，**鼠标悬停时：悬停条变为最长（37px）并变白、弹出 mini
  卡片（话题标题 + 「今天 14:32 · N 步」meta 行）；其他光条按距离做长度联动
  （30→26→22→18→16px 衰减，颜色不变），移开后整体回弹**；刻度带透明扩展命中区
  （约 18px 高），不用精确对准 2px 的细条
- **日期分组只进文案不画分隔**：ZCode 式分档（今天/昨天/{n} 天前/本周/上周/
  本月/上月/更早）仅用于 tip 的时间前缀，轴上不再渲染圆点分隔符
- 话题过多时自动压缩刻度间距，保证整条轴留在可视区内
- 全部动效尊重 `prefers-reduced-motion`；键盘可达（focus-visible 同 hover 效果）
- **双语**：文案走 harness 官方 locale 系统（设置页语言 → 浏览器主语言 → zh 兜底），
  时间格式 zh 用 24 小时制、en 用 12 小时制
- 注意：标题与时间戳受“已加载历史窗口”限制——更早的 turn 在其页面加载前可能
  显示为 `#<turn>`，属数据源的窗口语义而非 bug

## 结构

- 'lib/index.js' — node half（占位 apply，出现在 host Loader 中）
- 'lib/client.js' — browser half，**单一 factory**（`dsh-topic-timeline`）内分三层：
  纯数据层（`__GROUPING_SOURCE__` 标记区，零 DOM，被单测提取后直接在 Node 下执行）
  + 样式/UI 工具 + React 绑定与插件接线。故意不用第二个 factory：loader 的
  `invalidate(id)` 只清主 id，辅助 factory 会残留并让下一次 HMR 热重载抛
  `duplicate factory registration`（详见对抗式审查记录）
- 'test/grouping.test.mjs' — 数据层单测（分档边界、跨年、保序、时间格式）
- 数据来源：ctx.sessions 的 ConversationSnapshot（chat.timeline / chat.locations）

## 安装

1. 把本目录链入 web profile 的 node_modules：

   ln -s "$(pwd)" ~/.dsh/profiles/web/node_modules/dsh-topic-timeline

2. 在 ~/.dsh/profiles/web/cordis.patch.yml 追加：

   - insert:
       - id: topic-timeline
         name: dsh-topic-timeline

   保存后 dsh web 会热加载（无需重启），刷新浏览器页面即可。

3. 卸载：删除 cordis.patch.yml 中的条目并刷新（再次热卸载），最后删掉软链。

## 迭代

- 修改 'lib/client.js' 后刷新页面即生效（bundle 按 no-cache 提供，rev 仅为缓存键）。
- 数据层改动先跑 `node test/grouping.test.mjs`（12 个用例，约 1 秒）。
- 新增/删除插件条目需要 dsh web 进程重启（loader 条目在启动时固定）。
