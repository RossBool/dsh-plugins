/**
 * dsh-team-mode/toggle — 团队模式切换器（Client）。
 *
 * 提供一个紧凑的 UI 控件:
 *   - 在 DSH Web 主界面右上/侧栏的固定位置显示团队模式徽章
 *   - 点击切换全局团队模式（off → on / on → off）
 *   - 通过 host.call('team-mode/set-global') 写回 host
 *   - 通过 host.call('team-mode/get') / 'team-mode/subscribe' 读取状态
 *
 * 设计意图（与 PRODUCT.md "克制 · 精确 · 可信" 对齐）：
 *   - 状态色 + 状态字形双编码（on=绿色 ●，off=灰色 ○，色盲安全）
 *   - 一眼即读：标签"团队模式"始终可见，按下态用填充表达
 *   - 操作零惊奇：单击即翻转，焦点环可见，键盘可达
 *   - 融入宿主：复用 OKLCH 中性色板，与 dsh-agent-orchestration 同源
 *   - reduced-motion：transition 全静态
 */

import React, { useState, useEffect, useRef } from 'react'

/* ────────────────────────────── 设计令牌（与 dsh-agent-orchestration 同源） ────────────────────────────── */
const CSS = `
.tm-fab{
  position:fixed;top:14px;right:14px;z-index:6200;
  display:inline-flex;align-items:center;gap:8px;
  padding:6px 12px 6px 10px;
  background:oklch(0.22 0.033 278);
  border:1px solid oklch(0.31 0.045 278);
  border-radius:10px;
  color:oklch(0.93 0.020 280);
  font:500 12px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;
  cursor:pointer;
  transition:border-color 150ms ease-out,background-color 150ms ease-out,color 150ms ease-out;
  min-height:30px;
  letter-spacing:0.01em;
  -webkit-user-select:none;user-select:none;
}
.tm-fab:hover{border-color:oklch(0.40 0.070 278)}
.tm-fab:focus-visible{outline:2px solid oklch(0.60 0.190 278);outline-offset:2px}
.tm-fab[aria-pressed="true"]{
  background:oklch(0.25 0.040 278);
  border-color:oklch(0.66 0.160 160);
  color:oklch(0.93 0.020 280);
}
.tm-fab .tm-glyph{
  display:inline-flex;align-items:center;justify-content:center;
  width:14px;height:14px;border-radius:50%;
  font-size:11px;line-height:1;
  border:1.5px solid currentColor;color:oklch(0.71 0.060 278);
}
.tm-fab[aria-pressed="true"] .tm-glyph{
  background:oklch(0.78 0.190 160);color:oklch(0.20 0.028 278);border-color:oklch(0.78 0.190 160);
}
.tm-fab .tm-label{white-space:nowrap}
.tm-fab .tm-hint{
  font-weight:400;color:oklch(0.71 0.060 278);font-size:11px;
  padding-left:6px;border-left:1px solid oklch(0.31 0.045 278);margin-left:2px;
}
.tm-fab[aria-pressed="true"] .tm-hint{color:oklch(0.78 0.190 160)}
.tm-fab[aria-disabled="true"]{opacity:0.6;cursor:progress}

.tm-toast{
  position:fixed;top:54px;right:14px;z-index:6201;
  padding:6px 10px;
  background:oklch(0.20 0.028 278);
  border:1px solid oklch(0.40 0.070 278);
  border-radius:8px;
  color:oklch(0.93 0.020 280);
  font:500 12px/1.4 -apple-system,BlinkMacSystemFont,system-ui,sans-serif;
  box-shadow:none;
  pointer-events:none;
}
@media (prefers-reduced-motion: reduce){
  .tm-fab,.tm-toast{transition:none!important}
}
`

const STYLE_ID = 'dsh-team-mode-css'

function ensureStyle() {
  if (typeof document === 'undefined') return
  if (document.getElementById(STYLE_ID)) return
  const el = document.createElement('style')
  el.id = STYLE_ID
  el.textContent = CSS
  document.head.appendChild(el)
}

export function apply(ctx) {
  ensureStyle()

  const host = ctx.host
  const on = host && typeof host.call === 'function' ? host : null

  // ---- React 组件 ----
  const Toggle = () => {
    const [active, setActive] = useState(false)
    const [pending, setPending] = useState(false)
    const [hint, setHint] = useState('')
    const hintTimer = useRef(null)

    const showHint = (text) => {
      setHint(text)
      if (hintTimer.current) clearTimeout(hintTimer.current)
      hintTimer.current = setTimeout(() => setHint(''), 1600)
    }

    // 初始拉取 + 轮询式同步（host 端 subscribe 当前是 snapshot 形式，2s 一次足够）
    useEffect(() => {
      let stop = false
      const fetchOnce = async () => {
        if (!on) return
        try {
          const res = await on.call('team-mode/get', {})
          if (stop) return
          if (res && typeof res === 'object' && typeof res.global === 'boolean') setActive(!!res.global)
        } catch (e) {}
      }
      fetchOnce()
      const iv = setInterval(fetchOnce, 2000)
      return () => { stop = true; clearInterval(iv) }
    }, [])

    const onClick = async () => {
      if (!on || pending) return
      setPending(true)
      const next = !active
      try {
        const res = await on.call('team-mode/set-global', { value: next })
        if (res && typeof res === 'object' && typeof res.global === 'boolean') {
          setActive(!!res.global)
          showHint(res.global ? '团队模式已开启' : '团队模式已关闭')
        }
      } catch (e) {
        showHint('切换失败：' + ((e && e.message) || String(e)))
      } finally {
        setPending(false)
      }
    }

    const glyph = active ? '●' : '○'
    const label = active ? '团队模式 开' : '团队模式 关'
    const hintText = active ? '本会话协作路由已启用' : '默认单 agent，普通对话直通'
    return React.createElement(React.Fragment, null,
      React.createElement('button', {
        className: 'tm-fab',
        type: 'button',
        'aria-pressed': active ? 'true' : 'false',
        'aria-label': label + '，点击' + (active ? '关闭' : '开启'),
        title: '团队模式开关（默认关闭）。开启后，本会话的自然语言协作信号会触发多 agent 并行派发。',
        onClick,
        'aria-disabled': pending ? 'true' : 'false',
      },
        React.createElement('span', { className: 'tm-glyph', 'aria-hidden': 'true' }, glyph),
        React.createElement('span', { className: 'tm-label' }, label),
        React.createElement('span', { className: 'tm-hint' }, hintText),
      ),
      hint ? React.createElement('div', { className: 'tm-toast', role: 'status', 'aria-live': 'polite' }, hint) : null,
    )
  }

  // 把按钮挂到 document.body（不动宿主布局）
  const mount = () => {
    if (typeof document === 'undefined') return
    if (document.getElementById('dsh-team-mode-toggle-root')) return
    const root = document.createElement('div')
    root.id = 'dsh-team-mode-toggle-root'
    document.body.appendChild(root)
    ctx.react.mount(Toggle, root)
  }
  if (typeof document !== 'undefined' && document.body) mount()
  else if (typeof window !== 'undefined') window.addEventListener('DOMContentLoaded', mount, { once: true })

  // 卸载
  ctx.on('dispose', () => {
    if (typeof document === 'undefined') return
    const root = document.getElementById('dsh-team-mode-toggle-root')
    if (root) root.remove()
  })
}