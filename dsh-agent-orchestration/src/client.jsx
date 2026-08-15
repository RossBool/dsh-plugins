/**
 * dsh-agent-orchestration — 画布客户端源码（esbuild 打包前，JSX/ESM）。
 *
 * v2 设计（见 DESIGN-canvas-v2.md）：纯拓扑图。
 *  - 唯一形态：横向 DAG 树——队长（源点）在左，派发边逐层向右，
 *    叶子用虚线汇总边收口到最右的"汇总报告"（汇点）。
 *  - 轻松随意：贝塞尔柔性连线（可拖弯、端点可滑动重连）、宽松节点间距、
 *    软化圆角与对比度、柔和氛围阴影；状态色保留语义但降饱和。
 *  - 性能（实测驱动）：hover 暗化零 React 渲染（直接写 DOM class + CSS :has），
 *    拖拽中屏蔽 hover 联动，轮询零变更零渲染，视口裁剪，拖拽中暂停 transition。
 *  - v2.2 增量加载：/stream NDJSON 逐节点下发，客户端随到随显（不再等全部节点
 *    构建完成后一次性呈现）；流式期间抑制轮询与自动视野，完成后收口 fitView。
 */
import { useState, useEffect, useRef, useCallback, useMemo, useReducer, memo } from 'react'
import { ReactFlow, ReactFlowProvider, useReactFlow, Background, BackgroundVariant, Handle, Position, MarkerType, BaseEdge, EdgeLabelRenderer } from '@xyflow/react'
import rfCss from '@xyflow/react/dist/style.css'
import { sigOf, applyNodeEvents as mergeNodeEvents, removeNodes as removeNodesPure } from './nodes-merge.js'

/* ────────────────────────────── 设计令牌（OKLCH，DSH 暗色系，降饱和轻快版） ────────────────────────────── */
const CSS = `
.orch-canvas-overlay{
  --orch-scrim:oklch(0.17 0.015 280);
  --orch-surface:oklch(0.21 0.020 280);
  --orch-surface-2:oklch(0.24 0.025 280);
  --orch-surface-3:oklch(0.28 0.030 280);
  --orch-border:oklch(0.34 0.030 280);
  --orch-border-strong:oklch(0.46 0.050 280);
  --orch-ink:oklch(0.94 0.015 280);
  --orch-ink-sub:oklch(0.73 0.035 280);
  --orch-accent:oklch(0.68 0.110 278);
  --orch-running:oklch(0.80 0.130 160);
  --orch-done:oklch(0.72 0.100 262);
  --orch-fail:oklch(0.72 0.130 25);
  --orch-wait:oklch(0.79 0.085 80);
  --orch-idle:oklch(0.68 0.045 278);
  --orch-current:oklch(0.83 0.120 85);
  --orch-radius:16px;
  --space-xs:4px; --space-sm:8px; --space-md:12px; --space-lg:16px; --space-xl:24px;
  --z-canvas:6400;
  position:fixed;inset:0;background:var(--orch-scrim);z-index:var(--z-canvas);
  display:flex;flex-direction:column;overflow:hidden;color:var(--orch-ink);
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;
  font-size:13px;line-height:1.55;
}
.orch-canvas-overlay:focus{outline:none}
.orch-canvas-head{flex:0 0 auto;display:flex;align-items:center;gap:var(--space-md);
  padding:var(--space-sm) var(--space-lg);background:var(--orch-surface);border-bottom:1px solid var(--orch-border)}
.orch-canvas-title{font-size:14px;font-weight:600;letter-spacing:0.01em;white-space:nowrap}
.orch-canvas-sub{font-size:12px;color:var(--orch-ink-sub);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.orch-spacer{flex:1}
.orch-close{position:relative;background:none;border:none;color:var(--orch-ink-sub);font-size:18px;cursor:pointer;line-height:1;padding:6px;border-radius:8px}
.orch-close::before{content:'';position:absolute;inset:-8px} /* 44px 命中区 */
.orch-close:hover{color:var(--orch-ink);background:var(--orch-surface-3)}
.orch-close:focus-visible{outline:2px solid var(--orch-accent);outline-offset:2px}
.orch-canvas-body{flex:1 1 auto;position:relative;min-height:0}
.orch-flow{background:var(--orch-scrim)}

/* ── 节点：状态色描边（柔和）+ 柔和氛围阴影 ── */
.orch-node{width:236px;background:var(--orch-surface-2);border:1px solid var(--orch-idle);border-radius:var(--orch-radius);
  padding:12px 14px;display:flex;gap:10px;align-items:flex-start;cursor:grab;user-select:none;-webkit-user-select:none;
  box-shadow:0 8px 24px -16px rgba(0,0,0,0.6);
  transition:border-color 150ms ease-out,background-color 150ms ease-out}
.orch-node:active{cursor:grabbing}
.orch-node.is-hover{border-color:var(--orch-border-strong);background:var(--orch-surface-3)}
.orch-node:focus-visible{outline:2px solid var(--orch-accent);outline-offset:3px}
.orch-node.is-current{outline:2px solid var(--orch-current);outline-offset:3px}
.orch-node-icon{font-size:15px;line-height:1.6;flex:0 0 auto}
.orch-node-body{flex:1 1 auto;min-width:0}
.orch-node-title{color:var(--orch-ink);white-space:pre-line;word-break:break-word;font-weight:500}
.orch-node-meta{display:flex;align-items:center;gap:6px;margin-top:4px;font-size:11px;color:var(--orch-ink-sub)}
.orch-status-dot{font-size:10px;line-height:1}
.orch-status-dot.is-running{color:var(--orch-running)}
.orch-status-dot.is-done{color:var(--orch-done)}
.orch-status-dot.is-failed{color:var(--orch-fail)}
.orch-status-dot.is-waiting{color:var(--orch-wait)}
.orch-status-dot.is-idle{color:var(--orch-idle)}
.orch-node.bd-running{border-color:var(--orch-running)}
.orch-node.bd-done{border-color:var(--orch-done)}
.orch-node.bd-failed{border-color:var(--orch-fail)}
.orch-node.bd-waiting{border-color:var(--orch-wait)}
.orch-node.bd-idle{border-color:var(--orch-idle)}
.orch-handle{width:6px;height:6px;min-width:6px;min-height:6px;background:var(--orch-border-strong);border:1px solid var(--orch-scrim);opacity:0;transition:opacity 150ms ease-out}
.orch-node:hover .orch-handle{opacity:1}

/* ── 连线：贝塞尔柔性曲线；暗化零 React 渲染（CSS :has + 直接写 class） ── */
.orch-flow .react-flow__edge-path{transition:opacity 180ms ease-out}
.orch-flow .react-flow__edge.is-dimmed .react-flow__edge-path{opacity:0.2}
.orch-flow .react-flow__edges:has(.react-flow__edge:hover) .react-flow__edge:not(:hover){opacity:0.3}
.orch-flow .react-flow__edge.animated path{animation:orchDash 0.9s linear infinite}
@keyframes orchDash{to{stroke-dashoffset:-12}}
.orch-canvas-overlay[data-dragging] .react-flow__edge-path{transition:none}

/* 边线流动性:每条连线叠加一层流动粒子(虚线偏移动画),运行中的边加速高亮 */
.orch-flow-line{fill:none;stroke:oklch(0.92 0.03 280 / 0.55);stroke-width:1.5;stroke-dasharray:2 12;
  stroke-linecap:round;pointer-events:none;animation:orchFlow 2.2s linear infinite}
 orchFlow{to{stroke-dashoffset:-28}}
.orch-flow .react-flow__edge.animated .orch-flow-line{animation-duration:0.9s;stroke:var(--orch-running);stroke-width:1.8}
.orch-flow .react-flow__edge.is-dimmed .orch-flow-line{opacity:0.25}
 (prefers-reduced-motion: reduce){.orch-flow-line{animation:none;opacity:0.35}}

/* 弯曲把手：线中点的小圆点，拖垂直方向改变曲率 */
.orch-bend{position:absolute;width:12px;height:12px;border-radius:50%;
  background:var(--orch-surface-3);border:1.5px solid var(--orch-border-strong);
  opacity:0.35;cursor:grab;pointer-events:auto;transition:opacity 150ms ease-out,transform 60ms linear}
.orch-bend:hover,.orch-bend.is-on{opacity:1}
.orch-bend:active{cursor:grabbing}
@media (prefers-reduced-motion: reduce){
  .orch-flow .react-flow__edge.animated path{animation:none}
  .orch-node,.orch-flow .react-flow__edge-path,.orch-bend{transition:none!important}
}

/* ── 详情浮层（轻量，非模态） ── */
.orch-pop{position:fixed;width:320px;max-width:calc(100vw - 16px);z-index:6500;
  background:var(--orch-surface);border:1px solid var(--orch-border);border-radius:var(--orch-radius);
  box-shadow:0 16px 40px -16px rgba(0,0,0,0.7);display:flex;flex-direction:column;overflow:hidden}
.orch-pop-head{flex:0 0 auto;display:flex;align-items:flex-start;justify-content:space-between;gap:var(--space-md);
  padding:10px 12px;border-bottom:1px solid var(--orch-border)}
.orch-pop-title{font-size:13px;font-weight:600;color:var(--orch-ink);white-space:pre-line;word-break:break-word}
.orch-pop-sub{font-size:11px;color:var(--orch-ink-sub);margin-top:2px}
.orch-pop-close{position:relative;background:none;border:none;color:var(--orch-ink-sub);font-size:16px;cursor:pointer;line-height:1;padding:2px}
.orch-pop-close::before{content:'';position:absolute;inset:-8px}
.orch-pop-close:hover{color:var(--orch-ink)}
.orch-pop-body{flex:1 1 auto;overflow-y:auto;padding:10px 12px;max-height:min(60vh,480px)}
.orch-stat{display:flex;gap:var(--space-sm);flex-wrap:wrap;margin-bottom:var(--space-sm)}
.orch-stat span{background:var(--orch-surface-2);border:1px solid var(--orch-border);border-radius:8px;padding:2px 8px;font-size:11px;color:var(--orch-ink-sub)}
.orch-line{display:flex;gap:var(--space-sm);padding:5px 0;border-bottom:1px solid var(--orch-surface-3);font-size:12px;color:var(--orch-ink);align-items:flex-start}
.orch-line .t{flex:0 0 auto;width:36px;color:var(--orch-ink-sub);font-variant-numeric:tabular-nums}
.orch-line .i{flex:0 0 auto;width:18px;text-align:center}
.orch-line.think{color:var(--orch-ink-sub)}
.orch-line.ok{color:var(--orch-done)}
.orch-line.fail{color:var(--orch-fail)}
.orch-line.agent{color:var(--orch-wait)}
.orch-line.turn{font-weight:600}
.orch-pop-loading{padding:var(--space-lg);color:var(--orch-ink-sub);font-size:12px;text-align:center}
`

/* ────────────────────────────── 状态语义表（颜色 + 字形双编码） ────────────────────────────── */
const KIND_META = {
  engine: { icon: '⚙️', color: 'var(--orch-accent)' },
  plan: { icon: '🗒️', color: 'var(--orch-idle)' },
  worker: { icon: '🔨', color: 'var(--orch-wait)' },
  verifier: { icon: '🧪', color: 'var(--orch-running)' },
  leader: { icon: '🧭', color: 'var(--orch-current)' },
  agent: { icon: '🤖', color: 'var(--orch-done)' },
  workflow: { icon: '🛰️', color: 'var(--orch-accent)' },
  phase: { icon: '📦', color: 'var(--orch-running)' },
  member: { icon: '🧩', color: 'var(--orch-wait)' },
  review: { icon: '✅', color: 'var(--orch-running)' },
  report: { icon: '📋', color: 'var(--orch-accent)' },
}
const STATUS_META = {
  passed: { key: 'done', glyph: '✓', label: '已验证' },
  verifying: { key: 'running', glyph: '◉', label: '验证中' },
  exhausted: { key: 'failed', glyph: '✕', label: '已耗尽' },
  ready: { key: 'waiting', glyph: '◷', label: '待重试' },
  running: { key: 'running', glyph: '◉', label: '运行中' },
  'in-progress': { key: 'running', glyph: '◉', label: '运行中' },
  active: { key: 'running', glyph: '◉', label: '运行中' },
  thinking: { key: 'running', glyph: '◉', label: '思考中' },
  done: { key: 'done', glyph: '✓', label: '已完成' },
  completed: { key: 'done', glyph: '✓', label: '已完成' },
  pass: { key: 'done', glyph: '✓', label: '通过' },
  success: { key: 'done', glyph: '✓', label: '成功' },
  failed: { key: 'failed', glyph: '✕', label: '失败' },
  fail: { key: 'failed', glyph: '✕', label: '失败' },
  error: { key: 'failed', glyph: '✕', label: '出错' },
  blocked: { key: 'failed', glyph: '✕', label: '受阻' },
  cancelled: { key: 'failed', glyph: '✕', label: '已取消' },
  waiting: { key: 'waiting', glyph: '◷', label: '等待中' },
  pending: { key: 'waiting', glyph: '◷', label: '等待中' },
  idle: { key: 'idle', glyph: '●', label: '空闲' },
}
const statusOf = (n, current) => {
  if (n.status) return n.status
  if (current && n.id === current) return 'running'
  return 'idle'
}

/* ────────────────────────────── 文本换行（无省略号，≤3 行） ────────────────────────────── */
const estWidth = (s, fontPx) => {
  if (!s) return 0
  let w = 0
  for (const ch of String(s)) {
    const c = ch.codePointAt(0)
    if (c > 0xffff) w += 1.6
    else if (c >= 0x2e80) w += 1.02
    else if (ch >= 'A' && ch <= 'Z') w += 0.72
    else if (ch >= 'a' && ch <= 'z') w += 0.62
    else if (ch >= '0' && ch <= '9') w += 0.68
    else w += 0.52
  }
  return w * fontPx
}
const wrapLines = (s, maxWidth, fontPx) => {
  if (!s) return ['']
  const out = []
  let cur = ''
  for (const ch of String(s)) {
    if (ch === '\n') { out.push(cur); cur = ''; continue }
    if (cur && estWidth(cur + ch, fontPx) > maxWidth) { out.push(cur); cur = ch; continue }
    cur += ch
  }
  if (cur) out.push(cur)
  return out.length ? out : ['']
}
const fitNodeText = (s, maxW, fontPx, maxLines) => {
  const lines = wrapLines(s, maxW, fontPx)
  const shown = lines.slice(0, maxLines)
  if (lines.length > maxLines) {
    const last = shown[shown.length - 1]
    if (last && last.length > 1) shown[shown.length - 1] = last.slice(0, last.length - 1)
    return shown.join('\n') + '…'
  }
  return shown.join('\n')
}

/* ────────────────────────────── 共享状态（画布开合） ────────────────────────────── */
const canvasState = { open: false, pinnedRoot: undefined }
const listeners = new Set()
const setCanvas = (patch) => { Object.assign(canvasState, patch); for (const l of listeners) l() }

/* 团队模式：本插件只被 team 预设（团队模式）挂载，画布入口仅在团队会话展示。 */
const checkTeamMode = (sessionId, onResult, maxRetries, delayMs) => {
  let stopped = false
  let tries = 0
  let timer = null
  const q = sessionId ? ('?session=' + encodeURIComponent(sessionId)) : ''
  const check = () => {
    if (stopped) return
    tries += 1
    fetch('/plugins/dsh-agent-orchestration/team-mode' + q, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('http ' + r.status))))
      .then((d) => {
        if (stopped) return
        const on = !!(d && typeof d === 'object' && d.teamMode === true)
        onResult(on)
        if (!on && tries < maxRetries) timer = setTimeout(check, delayMs)
      })
      .catch(() => {
        if (stopped) return
        onResult(false)
        if (tries < maxRetries) timer = setTimeout(check, delayMs)
      })
  }
  check()
  return () => { stopped = true; if (timer) clearTimeout(timer) }
}

const useCanvasStore = () => {
  const [, force] = useReducer((n) => n + 1, 0)
  useEffect(() => {
    const l = () => force()
    listeners.add(l)
    return () => { listeners.delete(l) }
  }, [])
  return canvasState
}

/* ────────────────────────────── 布局：拓扑树（唯一形态） ────────────────────────────── */
const COL_X = 340   // 层间距：放宽，留呼吸空间
const ROW_Y = 190   // 行间距：放宽
const px = (gx, gy) => ({ x: gx * COL_X + 60, y: gy * ROW_Y + 60 })

/* 有向图分层：BFS 从源点（无父边）按深度分层；report（汇总报告）恒为汇点（最右层）。 */
const computeLayers = (nodes) => {
  const present = new Set()
  const kids = {}
  for (const n of nodes) present.add(n.id)
  for (const n of nodes) {
    if (n.kind === 'report') continue
    if (n.parentId && present.has(n.parentId)) (kids[n.parentId] || (kids[n.parentId] = [])).push(n.id)
  }
  const depth = {}
  const visit = (id, d) => {
    if (depth[id] !== undefined && depth[id] >= d) return
    depth[id] = d
    for (const c of kids[id] || []) visit(c, d + 1)
  }
  for (const n of nodes) {
    if (n.kind === 'report') continue
    if (n.parentId && present.has(n.parentId)) continue
    visit(n.id, 0)
  }
  let maxD = -1
  for (const k of Object.keys(depth)) if (depth[k] > maxD) maxD = depth[k]
  for (const n of nodes) if (n.kind === 'report') depth[n.id] = Math.max(0, maxD) + 1
  return depth
}

/* 各层节点保持派发顺序，层内纵向居中：x = 深度层（源在左、汇点最右）。 */
const treePositions = (nodes) => {
  const depth = computeLayers(nodes)
  const layers = {}
  for (const n of nodes) (layers[depth[n.id]] || (layers[depth[n.id]] = [])).push(n)
  const maxLen = Math.max.apply(null, Object.keys(layers).map((k) => layers[k].length).concat([0]))
  const out = {}
  for (const k of Object.keys(layers)) {
    const off = (maxLen - layers[k].length) / 2
    layers[k].forEach((n, i) => { out[n.id] = px(Number(k), off + i) })
  }
  return out
}

/* ────────────────────────────── 柔性连线：二次贝塞尔 + 可拖控制点 ──────────────────────────────
   说明：v12.11.3 的 getBezierPath 对"源右→目标左"朝向完全忽略 curvature（offset 恒为
   0.5*distance），因此不用其 curvature 参数，自算二次贝塞尔：控制点 = 中点 + 可拖偏移，
   节点移动时弯曲跟随，拖把手即"把曲线拉向任意方向"。 */
const SoftEdge = memo(function SoftEdge({ id, sourceX, sourceY, targetX, targetY, data, style, markerEnd, selected }) {
  const { screenToFlowPosition } = useReactFlow()
  const off = data && data.bendOffset ? data.bendOffset : { x: 0, y: 0 }
  const mx = (sourceX + targetX) / 2
  const my = (sourceY + targetY) / 2
  const cpx = mx + off.x
  const cpy = my + off.y
  const path = 'M' + sourceX + ',' + sourceY + ' Q' + cpx + ',' + cpy + ' ' + targetX + ',' + targetY
  // 二次贝塞尔 t=0.5 处的曲线点：把手放在这里，拖哪弯哪
  const labelX = (sourceX + 2 * cpx + targetX) / 4
  const labelY = (sourceY + 2 * cpy + targetY) / 4
  const [bending, setBending] = useState(false)
  const dragState = useRef(null)

  /* RF 平移系统会截断 pane 内 pointer 事件的冒泡（实测：bend 的 pointer 事件到不了 React
     root），因此把手用 mouse 事件 + nopan 豁免；mousedown 后监听 window 的 mousemove/mouseup，
     鼠标拖出 12px 圆点范围也能连续调整。 */
  const onDown = (e) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation() // 阻止 RF 平移/框选
    setBending(true)
    dragState.current = { mx, my }
    const move = (ev) => {
      const st = dragState.current
      if (!st) return
      const p = screenToFlowPosition({ x: ev.clientX, y: ev.clientY })
      let ox = p.x - st.mx
      let oy = p.y - st.my
      const mag = Math.hypot(ox, oy)
      const LIMIT = 260
      if (mag > LIMIT) { ox = (ox / mag) * LIMIT; oy = (oy / mag) * LIMIT }
      ox = Math.round(ox * 10) / 10
      oy = Math.round(oy * 10) / 10
      if (data && data.onBend) data.onBend(id, { x: ox, y: oy })
    }
    const up = () => {
      dragState.current = null
      setBending(false)
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  return (
    <>
      <BaseEdge path={path} style={style} markerEnd={markerEnd} interactionWidth={26} />
      <path className="orch-flow-line" d={path} fill="none" aria-hidden="true" />
      <EdgeLabelRenderer>
        <div
          className={'orch-bend nopan' + (selected || bending ? ' is-on' : '')}
          style={{ transform: 'translate(-50%,-50%) translate(' + labelX + 'px,' + labelY + 'px)' }}
          title="拖动弯曲连线"
          onMouseDown={onDown}
        />
      </EdgeLabelRenderer>
    </>
  )
})

/* ────────────────────────────── 节点组件 ────────────────────────────── */
const OrchNode = memo(function OrchNode({ data, positionAbsoluteX, positionAbsoluteY }) {
  const meta = KIND_META[data.kind] || KIND_META.agent
  const st = STATUS_META[data.status] || STATUS_META.idle
  const [hover, setHover] = useState(false)
  const { screenToFlowPosition } = useReactFlow()
  const dragRef = useRef(null)

  /* 自研节点拖拽(替代 RF 内置 XYDrag,本环境实测不生效):
     mousedown 记录起点,window 级 mousemove 把指针换算成 flow 坐标增量,
     叠加在节点实时绝对位置(positionAbsolute)上回写受控位置。 */
  const onMouseDown = (e) => {
    if (e.button !== 0 || !data.onDrag || !data.nodeId) return
    if (e.target && typeof e.target.closest === 'function' && e.target.closest('.orch-handle')) return
    e.stopPropagation() // 不让 RF 的 d3 拖动/框选介入(配合 nodesDraggable=false 双重保险)
    const startFlow = screenToFlowPosition({ x: e.clientX, y: e.clientY })
    const base = { x: positionAbsoluteX ?? 0, y: positionAbsoluteY ?? 0 }
    dragRef.current = { startFlow, base }
    if (data.onDragStart) data.onDragStart() // 自研拖拽开始:置 draggingRef + data-dragging
    const move = (ev) => {
      const st = dragRef.current
      if (!st) return
      const p = screenToFlowPosition({ x: ev.clientX, y: ev.clientY })
      data.onDrag(data.nodeId, { x: st.base.x + (p.x - st.startFlow.x), y: st.base.y + (p.y - st.startFlow.y) })
    }
    const up = () => {
      dragRef.current = null
      if (data.onDragStop) data.onDragStop() // 自研拖拽结束:清 draggingRef + data-dragging
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  return (
    <div
      className={'orch-node bd-' + st.key + (data.isCurrent ? ' is-current' : '') + (hover ? ' is-hover' : '')}
      tabIndex={0}
      role="button"
      aria-label={data.label + '，' + st.label + '，回车查看执行详情'}
      onMouseDown={onMouseDown}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (data.onOpen) data.onOpen() }
      }}
    >
      <Handle type="target" position={Position.Left} className="orch-handle" />
      <span className="orch-node-icon" aria-hidden="true" style={{ color: meta.color }}>{meta.icon}</span>
      <div className="orch-node-body">
        <div className="orch-node-title">{data.titleLines}</div>
        {data.meta ? (
          <div className="orch-node-meta">
            <span className={'orch-status-dot is-' + st.key} aria-hidden="true">{st.glyph}</span>
            <span>{data.meta}</span>
          </div>
        ) : null}
      </div>
      <Handle type="source" position={Position.Right} className="orch-handle" />
    </div>
  )
})
const nodeTypes = { orch: OrchNode }
const edgeTypes = { soft: SoftEdge }

/* ────────────────────────────── 画布主体 ────────────────────────────── */
function CanvasInner({ state, current, curTitle }) {
  const { fitView } = useReactFlow()
  const [demo, setDemo] = useState(false)
  const [rootTitle, setRootTitle] = useState('编排会话')
  const [note, setNote] = useState('')
  const [nodesData, setNodesData] = useState([])
  const [detail, setDetail] = useState(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [pop, setPop] = useState(null) // 浮层锚点（client 坐标）
  const positionsRef = useRef({})
  const [positionsTick, setPositionsTick] = useState(0)
  const justDraggedUntil = useRef(0)
  const draggingRef = useRef(false)
  const openDetailRef = useRef(null)
  const dataCacheRef = useRef({})
  const bendRef = useRef({})
  const overlayRef = useRef(null)
  // 增量流式构建状态(/stream):streaming 抑制轮询与自动视野,streamPhase 驱动头部进度文案
  const streamingRef = useRef(false)
  const streamAbortRef = useRef(null)
  const streamFitRef = useRef(false)
  const fitTimerRef = useRef(null)
  const [streamPhase, setStreamPhase] = useState('idle')
  // 弯曲交互的受控信号：onBend 只写 ref + tick 一下，由本组件重建边（受控模式，确定生效）
  const [bendTick, setBendTick] = useState(0)
  /* 端点重连（本地覆盖）：onReconnect 把新端点存 ref 并重建边；
     轮询重建时若端点已不存在则丢弃覆盖，回到数据驱动的连线。 */
  const reconnectRef = useRef({})
  const onReconnect = useCallback((oldEdge, conn) => {
    if (conn && conn.source && conn.target) {
      reconnectRef.current[oldEdge.id] = { source: conn.source, target: conn.target }
      setBendTick((t) => t + 1)
    }
  }, [])

  const root = current || state.pinnedRoot

  // 轮询结果未变化时复用旧对象；全部未变则返回原数组引用（零渲染，拖拽不被打断）
  const mergePoll = (fresh) => {
    setNodesData((prev) => {
      const same = fresh.length === prev.length && fresh.every((n, i) => prev[i] && prev[i].__sig === sigOf(n))
      if (same) return prev
      return fresh.map((n) => {
        const sig = sigOf(n)
        const old = prev.find((p) => p.id === n.id)
        return old && old.__sig === sig ? old : { ...n, __sig: sig }
      })
    })
  }

  const load = useCallback(async (r) => {
    try {
      const res = await fetch('/plugins/dsh-agent-orchestration/data?root=' + encodeURIComponent(r || ''), { cache: 'no-store' })
      const data = await res.json()
      if (!data || typeof data !== 'object') return
      if (data.demo) {
        setRootTitle(data.rootTitle || '编排会话')
        setDemo(true)
        setNote(data.note || '')
      } else {
        setRootTitle(data.rootTitle || '编排会话')
        setDemo(false)
        setNote('')
      }
      mergePoll(data.nodes || [])
    } catch (e) { setNote('加载失败：' + (e && e.message ? e.message : String(e))) }
  }, [])
  const loadRef = useRef(load)
  loadRef.current = load

  /* ────────────────────────────── 增量流式构建（v2.2） ──────────────────────────────
     /stream 逐节点下发 NDJSON 事件(init/nodes/update/remove/done + ':hb' 心跳),
     每收到一个节点立即 upsert 进 nodesData —— 画布随构建过程逐步可见,
     不再等待全部节点构建完成后一次性呈现。失败/超时自动回退全量 /data。 */
  const applyNodeEvents = useCallback((type, list) => {
    setNodesData((prev) => mergeNodeEvents(prev, type, list))
  }, [])

  const removeNodes = useCallback((ids) => {
    setNodesData((prev) => removeNodesPure(prev, ids))
  }, [])

  const fitSoon = useCallback((delay) => {
    if (fitTimerRef.current) clearTimeout(fitTimerRef.current)
    fitTimerRef.current = setTimeout(() => {
      fitTimerRef.current = null
      if (draggingRef.current) return
      try { fitView({ padding: 0.25, maxZoom: 1.3, duration: 350 }) } catch (e) {}
    }, delay)
  }, [fitView])

  const startStream = useCallback((r) => {
    const key = r || ''
    const ctrl = new AbortController()
    const prev = streamAbortRef.current
    streamAbortRef.current = ctrl
    if (prev) { try { prev.abort() } catch (e) {} }
    streamingRef.current = true
    streamFitRef.current = false
    setStreamPhase('streaming')
    setNote('')
    let sawInit = false
    let finished = false
    let hadError = false
    let watchdogFired = false

    const quietDone = () => {
      streamingRef.current = false
      setStreamPhase('done')
      fitSoon(140)
    }
    const fallback = () => {
      if (ctrl.signal.aborted && !watchdogFired) return
      if (streamAbortRef.current !== ctrl) return
      streamingRef.current = false
      setStreamPhase('idle')
      loadRef.current(key)
    }

    const handleLine = (line) => {
      let ev
      try { ev = JSON.parse(line) } catch (e) { return }
      if (!ev || typeof ev !== 'object' || !ev.type) return
      if (ev.type === 'init') {
        sawInit = true
        setNodesData([])
        setRootTitle(ev.rootTitle || '编排会话')
        setDemo(ev.demo === true)
        setNote(ev.note || '')
      } else if (ev.type === 'nodes') {
        applyNodeEvents('nodes', ev.nodes)
        if (streamingRef.current && !streamFitRef.current) {
          streamFitRef.current = true
          fitSoon(200)
        }
      } else if (ev.type === 'update') {
        applyNodeEvents('update', ev.nodes)
      } else if (ev.type === 'remove') {
        if (Array.isArray(ev.ids)) removeNodes(ev.ids)
      } else if (ev.type === 'done') {
        finished = true
        quietDone()
      } else if (ev.type === 'error') {
        hadError = true
        streamingRef.current = false
        setStreamPhase('idle')
        if (sawInit) setNote('流式加载中断：' + String(ev.message || ''))
        else fallback()
      }
    }

    const watchdog = setTimeout(() => {
      watchdogFired = true
      try { ctrl.abort() } catch (e) {}
    }, 30000)

    const finishIfNeeded = () => {
      if (streamAbortRef.current !== ctrl) return
      clearTimeout(watchdog)
      if (finished || hadError) return
      if (sawInit) quietDone()
      else fallback()
    }

    ;(async () => {
      let res
      try {
        res = await fetch('/plugins/dsh-agent-orchestration/stream?root=' + encodeURIComponent(key), { cache: 'no-store', signal: ctrl.signal })
      } catch (e) {
        fallback()
        clearTimeout(watchdog)
        return
      }
      if (!res.ok || !res.body || typeof res.body.getReader !== 'function') {
        fallback()
        clearTimeout(watchdog)
        return
      }
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      const drain = () => {
        let i
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).replace(/\r$/, '')
          buf = buf.slice(i + 1)
          if (line && line.charCodeAt(0) !== 58) handleLine(line) // ':' 开头 = NDJSON 注释(心跳)
        }
      }
      try {
        for (;;) {
          const chunk = await reader.read()
          if (chunk.done) break
          buf += decoder.decode(chunk.value, { stream: true })
          drain()
        }
        buf += decoder.decode()
        drain()
      } catch (e) {
        if (ctrl.signal.aborted) {
          if (!watchdogFired) return // 主动中止(切根/关画布),静默退出
          // watchdog 超时:走 finishIfNeeded 兜底
        } else if (sawInit) {
          hadError = true
          streamingRef.current = false
          setStreamPhase('idle')
          setNote('流式加载中断：' + String((e && e.message) || e))
        } else {
          fallback()
        }
      } finally {
        try { reader.releaseLock() } catch (e) {}
        finishIfNeeded()
      }
    })()
  }, [applyNodeEvents, removeNodes, fitSoon])

  // ref 模式:effect 只随 root 变化重启流(避免 fitView 身份变化触发 effect 重跑)
  const startStreamRef = useRef(startStream)
  startStreamRef.current = startStream

  useEffect(() => {
    startStreamRef.current(root || '')
    const iv = setInterval(() => {
      if (!draggingRef.current && !streamingRef.current) loadRef.current(root || '')
    }, 2500)
    return () => {
      clearInterval(iv)
      if (streamAbortRef.current) { try { streamAbortRef.current.abort() } catch (e) {}; streamAbortRef.current = null }
      streamingRef.current = false
    }
  }, [root])

  // 根会话变化：清空用户位移并自适应视野
  const prevFit = useRef(null)
  useEffect(() => {
    if (prevFit.current === root) return
    prevFit.current = root
    positionsRef.current = {}
    const t = setTimeout(() => {
      try { fitView({ padding: 0.25, maxZoom: 1.3, duration: 350 }) } catch (e) {}
    }, 80)
    return () => clearTimeout(t)
  }, [root, fitView])

  // 图结构变化（节点数增减）：自动适配视野，保证新出现的节点可见（纯图形态无复位按钮）
  const countRef = useRef(0)
  useEffect(() => {
    if (!nodesData.length || nodesData.length === countRef.current) return
    countRef.current = nodesData.length
    if (draggingRef.current || streamingRef.current) return
    const t = setTimeout(() => {
      try { fitView({ padding: 0.25, maxZoom: 1.3, duration: 350 }) } catch (e) {}
    }, 100)
    return () => clearTimeout(t)
  }, [nodesData.length, fitView])

  const openDetail = useCallback(async (node, ev) => {
    let ax = ev && typeof ev.clientX === 'number' ? ev.clientX : null
    let ay = ev && typeof ev.clientY === 'number' ? ev.clientY : null
    if (ax === null) {
      const el = document.querySelector('[data-testid="rf__node-' + node.id + '"]')
      if (el) { const r = el.getBoundingClientRect(); ax = r.left + r.width / 2; ay = r.top + r.height / 2 }
    }
    setPop({ x: ax ?? 160, y: ay ?? 120 })
    setDetailLoading(true)
    try {
      const q = 'root=' + encodeURIComponent(root || '') + '&node=' + encodeURIComponent(JSON.stringify(node))
      const res = await fetch('/plugins/dsh-agent-orchestration/detail?' + q, { cache: 'no-store' })
      const data = await res.json()
      setDetail(data && typeof data === 'object' ? data : { lines: [], stats: {}, title: node.label })
    } catch (e) {
      setDetail({ lines: [{ time: '', icon: '❌', text: '加载失败：' + (e && e.message ? e.message : String(e)), level: 'fail' }], stats: {}, title: node.label })
    } finally { setDetailLoading(false) }
  }, [root])
  openDetailRef.current = openDetail

  const closePop = useCallback(() => { setDetail(null); setDetailLoading(false); setPop(null) }, [])
  const close = useCallback(() => { closePop(); setCanvas({ open: false }) }, [closePop])

  // Esc：先关浮层，再关画布
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape') return
      if (detail || detailLoading) closePop()
      else close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [detail, detailLoading, closePop, close])

  const layouted = useMemo(() => treePositions(nodesData), [nodesData])

  // 自研拖拽(节点层回调):绕过 RF 内置 XYDrag(本环境实测不生效,见 DESIGN 记录)
  const onDragNode = useCallback((id, pos) => {
    positionsRef.current[id] = pos
    justDraggedUntil.current = Date.now() + 300
    setPositionsTick((t) => t + 1)
  }, [])
  // 拖拽状态由自研拖拽直接置位(RF 内置节点拖拽已禁用,onNodeDragStart/Stop 不再触发)
  const onDragStart = useCallback(() => {
    draggingRef.current = true
    if (overlayRef.current) overlayRef.current.setAttribute('data-dragging', '1')
  }, [])
  const onDragStop = useCallback(() => {
    draggingRef.current = false
    if (overlayRef.current) overlayRef.current.removeAttribute('data-dragging')
  }, [])
  const nodes = useMemo(() => {
    const cache = dataCacheRef.current
    const alive = {}
    const result = nodesData.map((n) => {
      const stKey = statusOf(n, current)
      const key = n.id + '|' + (n.__sig || '') + '|' + (current || '')
      let data = cache[key]
      if (!data) {
        const stMeta = STATUS_META[stKey] || STATUS_META.idle
        const label = n.label || n.title || n.id || '未命名'
        const modeText = n.kind === 'agent'
          ? (n.mode === 'spawn' ? '子代理' : (n.mode === 'continuable' ? '子代理 · 可续接' : undefined))
          : (n.kind === 'member' ? '工作流成员'
            : (n.kind === 'workflow' ? '工作流'
              : (n.kind === 'leader' ? '主 Agent · 队长'
                : (n.kind === 'report' ? '流程终点 · 汇总' : undefined))))
        data = {
          label,
          titleLines: fitNodeText(String(label), 236 - 28 - 30, 13, 3),
          kind: n.kind,
          status: stKey,
          meta: modeText || stMeta.label,
          isCurrent: !!current && (n.id === current || (n.sessionId && n.sessionId === current)),
          nodeId: n.id,
          onDrag: onDragNode,
          onDragStart,
          onDragStop,
          onOpen: (ev) => {
            if (Date.now() < justDraggedUntil.current) return // 拖拽结束后的 click 不开浮层
            if (openDetailRef.current) openDetailRef.current(n, ev)
          },
        }
        cache[key] = data
      }
      alive[key] = true
      return {
        id: n.id,
        type: 'orch',
        position: positionsRef.current[n.id] || layouted[n.id] || { x: 0, y: 0 },
        width: 236, // 与 .orch-node CSS 一致：仅作 fitView 边界估算；RF measured 由 ResizeObserver 写入，拖拽已禁用故不再依赖它
        data,
      }
    })
    for (const k of Object.keys(cache)) if (!alive[k]) delete cache[k]
    dataCacheRef.current = cache
    return result
  }, [nodesData, layouted, current, positionsTick, onDragNode, onDragStart, onDragStop])

  /* 有向图边集：
     1) 派发边（实线）：源点 fan-out —— 主 Agent → 成员 / 成员 → 其子代理（串行链）
     2) 汇总边（虚线，强调色）：所有执行叶节点 fan-in → 汇总报告（终止点收口）
     全部为柔性二次贝塞尔（type: soft），弯曲偏移存 bendRef，可拖弯；端点可重连。 */
  const edges = useMemo(() => {
    const byId = {}
    for (const n of nodesData) byId[n.id] = n
    const out = []
    const isParent = {}
    for (const n of nodesData) {
      if (n.kind === 'report') continue
      if (!n.parentId || !byId[n.parentId]) continue
      isParent[byId[n.parentId].id] = true
      const st = STATUS_META[statusOf(n, current)] || STATUS_META.idle
      const color = st.key === 'running' ? 'var(--orch-running)' : st.key === 'done' ? 'var(--orch-done)' : st.key === 'failed' ? 'var(--orch-fail)' : st.key === 'waiting' ? 'var(--orch-wait)' : 'var(--orch-idle)'
      const eid = 'e:' + byId[n.parentId].id + '->' + n.id
      out.push({
        id: eid,
        source: byId[n.parentId].id,
        target: n.id,
        type: 'soft',
        reconnectable: true,
        animated: st.key === 'running',
        deletable: false,
        interactionWidth: 26,
        data: { bendOffset: bendRef.current[eid] ?? { x: 0, y: 0 }, onBend: (eid2, off) => { bendRef.current[eid2] = off; setBendTick((t) => t + 1) } },
        style: { stroke: color, strokeWidth: st.key === 'running' ? 2 : 1.75 },
        markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color },
      })
    }
    const report = nodesData.find((n) => n.kind === 'report')
    if (report) {
      for (const n of nodesData) {
        if (n.kind === 'leader' || n.kind === 'report') continue
        if (isParent[n.id]) continue
        const eid = 'm:' + n.id + '->' + report.id
        out.push({
          id: eid,
          source: n.id,
          target: report.id,
          type: 'soft',
          reconnectable: true,
          deletable: false,
          interactionWidth: 26,
          data: { bendOffset: bendRef.current[eid] ?? { x: 0, y: 0 }, onBend: (eid2, off) => { bendRef.current[eid2] = off; setBendTick((t) => t + 1) } },
          style: { stroke: 'var(--orch-accent)', strokeWidth: 1.5, strokeDasharray: '6 5' },
          markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: 'var(--orch-accent)' },
        })
      }
    }
    // 重试回环(含环图):verifier 节点带 retryTo 时,画红色虚线回边 verifier → worker
    for (const n of nodesData) {
      if (!n.retryTo || !byId[n.retryTo]) continue
      const eid = 'retry:' + n.id + '->' + n.retryTo
      out.push({
        id: eid,
        source: n.id,
        target: n.retryTo,
        type: 'soft',
        reconnectable: true,
        deletable: false,
        interactionWidth: 26,
        data: { bendOffset: bendRef.current[eid] ?? { x: 0, y: -44 }, onBend: (eid2, off) => { bendRef.current[eid2] = off; setBendTick((t) => t + 1) } },
        style: { stroke: 'var(--orch-fail)', strokeWidth: 1.6, strokeDasharray: '5 3' },
        markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: 'var(--orch-fail)' },
      })
    }
    for (const e of out) {
      const rc = reconnectRef.current[e.id]
      if (rc && byId[rc.source] && byId[rc.target]) { e.source = rc.source; e.target = rc.target }
      else if (rc) delete reconnectRef.current[e.id]
    }
    return out
  }, [nodesData, current, bendTick])

  /* hover 暗化：直接写 DOM class，零 React 重渲染（P1 修复） */
  const dimEdges = useCallback((nodeId, on) => {
    const els = document.querySelectorAll('.orch-flow .react-flow__edge')
    for (const el of els) {
      const eid = el.getAttribute('data-id') || ''
      const hit = eid.endsWith('->' + nodeId) || eid.startsWith('e:' + nodeId + '->') || eid.startsWith('m:' + nodeId + '->')
      if (!hit) el.classList.toggle('is-dimmed', on)
    }
  }, [])

  const onNodesChange = useCallback((changes) => {
    let dirty = false
    for (const c of changes) {
      if (c.type === 'position' && c.position) {
        positionsRef.current[c.id] = { x: c.position.x, y: c.position.y }
        dirty = true
      }
    }
    if (dirty) setPositionsTick((t) => t + 1)
  }, [])

  const onNodeClick = useCallback((e, node) => {
    if (node && node.data && node.data.onOpen) node.data.onOpen(e)
  }, [])

  const onNodeMouseEnter = useCallback((e, n) => {
    if (draggingRef.current || !n || !n.data) return
    dimEdges(n.id, true)
  }, [dimEdges])
  const onNodeMouseLeave = useCallback((e, n) => {
    if (draggingRef.current || !n || !n.data) return
    dimEdges(n.id, false)
  }, [dimEdges])

  const onPaneClick = useCallback(() => {
    if (detail || detailLoading) closePop()
  }, [detail, detailLoading, closePop])

  const popStyle = pop ? {
    left: Math.min(Math.max(pop.x - 8, 8), (typeof window !== 'undefined' ? window.innerWidth : 1200) - 336),
    top: Math.min(Math.max(pop.y + 10, 8), Math.max(8, (typeof window !== 'undefined' ? window.innerHeight : 800) - 300)),
  } : undefined

  const popover = (detail || detailLoading) && popStyle ? (
    <aside className="orch-pop" style={popStyle} aria-label="节点执行详情">
      <div className="orch-pop-head">
        <div>
          <div className="orch-pop-title">{(detail && detail.title) || '加载中…'}</div>
          {detail ? <div className="orch-pop-sub">{detail.demo ? '演示数据' : '实时执行日志'}</div> : null}
        </div>
        <button className="orch-pop-close" onClick={closePop} aria-label="关闭详情">×</button>
      </div>
      {detailLoading ? (
        <div className="orch-pop-loading">加载中…</div>
      ) : (
        <div className="orch-pop-body">
          <div className="orch-stat">
            <span>🔄 回合 {detail.stats && detail.stats.turns || 0}</span>
            <span>💭 步骤 {detail.stats && detail.stats.steps || 0}</span>
            <span>🔧 工具 {detail.stats && detail.stats.tools || 0}</span>
            <span>{detail.status || 'idle'}</span>
          </div>
          {(detail.lines || []).map((l, i) => (
            <div key={i} className={'orch-line ' + (l.level || '')}>
              <span className="t">{l.time || ''}</span>
              <span className="i">{l.icon || '·'}</span>
              <span>{l.text || ''}</span>
            </div>
          ))}
          {(!detail.lines || !detail.lines.length) && <div className="orch-pop-loading">暂无执行事件</div>}
        </div>
      )}
    </aside>
  ) : null

  return (
    <div
      className="orch-canvas-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="团队协作画布"
      tabIndex={-1}
      ref={(el) => { overlayRef.current = el; if (el) el.focus() }}
    >
      <header className="orch-canvas-head">
        <span className="orch-canvas-title">👥 团队协作画布</span>
        <span className="orch-canvas-sub">
          {(root === current ? '跟随：' + curTitle : rootTitle) + (demo ? '（演示）' : '') + (streamPhase === 'streaming' ? ' · 增量构建中' : '') + (note ? ' · ' + note : '')}
        </span>
        <div className="orch-spacer" />
        <button className="orch-close" title="关闭（Esc）" onClick={close} aria-label="关闭画布">✕</button>
      </header>
      <div className="orch-canvas-body">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodesChange={onNodesChange}
          onNodeClick={onNodeClick}
          onNodeMouseEnter={onNodeMouseEnter}
          onNodeMouseLeave={onNodeMouseLeave}
          onPaneClick={onPaneClick}
          onReconnect={onReconnect}
          nodesDraggable={false}
          minZoom={0.3}
          maxZoom={2.5}
          selectionOnDrag={false}
          nodesConnectable={false}
          edgesReconnectable={true}
          reconnectRadius={24}
          onlyRenderVisibleElements={true}
          deleteKeyCode={null}
          fitViewOptions={{ padding: 0.25, duration: 350, maxZoom: 1.3 }}
          className="orch-flow"
        >
          <Background variant={BackgroundVariant.Dots} gap={30} size={1} color="oklch(0.33 0.030 280)" />
        </ReactFlow>
        {popover}
      </div>
    </div>
  )
}

/* ────────────────────────────── 浮层外壳（root 作用域 slot） ────────────────────────────── */
const CanvasOverlay = memo(function CanvasOverlay(props) {
  const { useSessions } = props
  const state = useCanvasStore()
  const current = useSessions((s) => s.current)
  const curTitle = useSessions((s) => {
    const c = s.current
    const e = c ? s.byId[c] : undefined
    return e && (e.title || e.displayTitle) ? String(e.title || e.displayTitle).slice(0, 40) : '当前会话'
  })
  if (!state.open) return null
  return (
    <ReactFlowProvider>
      <CanvasInner state={state} current={current} curTitle={curTitle} />
    </ReactFlowProvider>
  )
})

/* ────────────────────────────── 头部动作按钮（session 作用域 slot） ────────────────────────────── */
function CanvasAction(props) {
  const { sessionId } = props
  // 会话级团队模式判定：只有该会话挂载 team 预设时才展示画布入口。
  const [teamOn, setTeamOn] = useState(false)
  const teamOnRef = useRef(false)
  teamOnRef.current = teamOn
  useEffect(() => {
    const stop = checkTeamMode(sessionId, setTeamOn, 12, 1500)
    const onFocus = () => {
      if (!teamOnRef.current) checkTeamMode(sessionId, setTeamOn, 4, 1500)
    }
    window.addEventListener('focus', onFocus)
    return () => { stop(); window.removeEventListener('focus', onFocus) }
  }, [sessionId])
  if (!teamOn) return null
  return (
    <button
      type="button"
      className="orch-action-btn"
      title="团队协作画布：查看主 Agent 与子代理的协作流程"
      onClick={() => setCanvas({ open: true, pinnedRoot: sessionId })}
    >
      <span>👥 团队协作</span>
    </button>
  )
}

/* ────────────────────────────── 插件入口 ────────────────────────────── */
const inject = ['slots']
function apply(ctx) {
  ctx.effect(() => {
    if (document.getElementById('orch-canvas-css')) return
    const el = document.createElement('style')
    el.id = 'orch-canvas-css'
    el.textContent = rfCss + '\n' + CSS
    document.head.appendChild(el)
    return () => { el.remove() }
  }, 'dsh-agent-orchestration: canvas styles')

  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'dsh-agent-orchestration-canvas',
    order: 9000,
  }, CanvasOverlay))

  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
    name: 'conversation.session.header.actions',
    id: 'dsh-agent-orchestration-action',
    order: 9000,
    label: '团队协作',
  }, CanvasAction))
}

export { apply, inject }
