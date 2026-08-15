/**
 * 画布节点增量合并(纯函数)——客户端 client.jsx 与单元测试共用。
 * v2.2 增量流式构建:每个到达的节点立即合并进现有数组,画布随到随显。
 */

/** 节点数据签名:内容未变时复用旧对象(零渲染);轮询 merge 与流式 upsert 共用 */
export const sigOf = (n) => [n.id, n.kind, n.status, n.label, n.mode, n.parentId, n.sessionId, n.retryTo].join('|')

/**
 * 把一批流式事件节点合并进现有数组:
 *  - type 'nodes'  : 全量对象合并(拓扑事件);新节点按到达顺序追加,
 *                    既有节点同签名时复用原对象(拖拽/过渡不被打断)
 *  - type 'update' : 仅覆盖已定义字段(状态/标签补丁),节点位置不变
 * 返回新数组;无任何变化时返回原数组引用(零渲染)。
 */
export const applyNodeEvents = (prev, type, list) => {
  const byId = {}
  for (const n of prev) byId[n.id] = n
  let changed = false
  for (const raw of list || []) {
    if (!raw || !raw.id) continue
    const old = byId[raw.id]
    const merged = { ...(old || {}) }
    if (type === 'nodes') Object.assign(merged, raw)
    else { for (const k of Object.keys(raw)) { if (raw[k] !== undefined) merged[k] = raw[k] } }
    const sig = sigOf(merged)
    if (old && old.__sig === sig) continue
    merged.__sig = sig
    byId[raw.id] = merged
    changed = true
  }
  if (!changed) return prev
  const next = prev.slice()
  for (let i = 0; i < next.length; i++) {
    if (byId[next[i].id] !== next[i]) next[i] = byId[next[i].id]
  }
  for (const raw of list || []) {
    if (raw && raw.id && !prev.some((p) => p.id === raw.id)) next.push(byId[raw.id])
  }
  return next
}

/** 移除指定 id 节点(工作流折叠 remove 事件);无变化返回原数组引用 */
export const removeNodes = (prev, ids) => {
  const s = new Set(ids)
  const next = prev.filter((n) => !s.has(n.id))
  return next.length === prev.length ? prev : next
}
