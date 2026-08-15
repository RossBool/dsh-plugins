/**
 * dsh-team-plan/extract — 从子代理会话事件里提取最终产出文本(纯函数)。
 *
 * M1 实测发现:结算消息到达父 inbox 的瞬间,子代理的 assistant/message 可能
 * 尚未进入活体投影;持久 JSONL 里事件形状为:
 *   {"type":"assistant/message","data":{"message":{"content":[{"type":"text","text":…}]}}}
 *   {"type":"assistant/chunk","data":{"chunk":{"type":"block-end","block":{"type":"text","text":…}}}}
 */

export interface ExtEvent {
  type?: string
  data?: {
    message?: { content?: Array<{ type?: string; text?: string }> }
    chunk?: { type?: string; block?: { type?: string; text?: string } }
  }
}

/** 提取优先级:最后一条 assistant/message 的文本块 → block-end 文本块(倒序收集)→ 空串 */
export function extractChildOutput(events: ExtEvent[]): string {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]
    if (!ev || ev.type !== 'assistant/message') continue
    const blocks = ev.data?.message?.content || []
    const text = blocks.filter((b) => b && b.type === 'text').map((b) => b.text ?? '').join('\n').trim()
    if (text) return text
  }
  const ends: string[] = []
  for (let i = 0; i < events.length; i++) {
    const ev = events[i]
    if (!ev || ev.type !== 'assistant/chunk') continue
    const chunk = ev.data?.chunk
    if (chunk && chunk.type === 'block-end' && chunk.block?.type === 'text' && chunk.block.text) {
      ends.push(chunk.block.text)
    }
  }
  return ends.join('\n').trim()
}

/**
 * 结算通知文本兜底清理:子代理的 settled 消息可能带 "Background subagent <id>
 * finished and will do no further work unless you send it more." 前缀,并可能
 * 以 "Its closing message:" 嵌入最终产出。提取其中真正的成果文本。
 * (M3 实测:Verifier 抓到该前缀污染产出,导致"恰好一个字符"类标准误判)
 */
export function stripSettledPrefix(text: string): string {
  const t = String(text ?? '')
  const closing = t.match(/Its closing message:\s*([\s\S]*)$/i)
  if (closing) return closing[1].trim()
  return t
    .replace(/^Background subagent\s+[^\n]*finished[^\n]*\n?/i, '')
    .replace(/^Background subagent\s+[^\n]*settled[^\n]*\n?/i, '')
    .trim()
}
