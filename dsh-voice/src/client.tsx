// dsh-voice 客户端 UI 插件：输入框右侧麦克风按钮
// 浏览器原生录音（AudioWorklet 优先，ScriptProcessor 兜底）→ 静音自动停止 → POST /voice/transcribe → 填入输入框
//
// 数据通道使用框架标准 kit（useInput / inputActions / sessionId），不再自定义 inject 'input'：
// 该插槽的 owner（conversation.composer.bar 链）会把 zone={session,input} 作为 owner props 传下来，
// 且渲染器「owner 优先」——自定义注入的同名 input 会被 owner 的 input（纯状态快照，无方法）覆盖，
// 导致 input.notify / input.setDraft 运行时不存在（TypeError: input?.notify is not a function）。
import { useEffect, useRef, useState } from 'react'

export const name = 'dsh-voice-ui'
// 客户端模块的 inject 是 cordis 服务依赖；本模块只消费插槽 + 框架标准 kit，无需声明服务
export const inject: string[] = []

interface ClientParams {
  fillMode: 'transcript' | 'enhanced'
  maxDurationSec: number
  silenceStopSec: number
  silenceThresholdDb: number
  language: string
}

const DEFAULT_PARAMS: ClientParams = { fillMode: 'transcript', maxDurationSec: 300, silenceStopSec: 0, silenceThresholdDb: -40, language: 'zh-CN' }

// 电平指示条的高度变化系数：中间高两边低，让 5 根小条看起来像在「听」而不是整齐的栅栏
const EQ_MULT = [0.5, 0.75, 1, 0.7, 0.45]

interface RecorderHandle {
  /** 手动停止录音（自动静音停止 / 手动停止后 done 都会结算） */
  stop: () => void
  /** 录音结束时结算的 Promise：resolve(音频 Blob) / reject(错误) */
  done: Promise<Blob>
  setOnLevel: (cb: ((p: number) => void) | null) => void
  /** 实时 16kHz Int16 PCM 回调（供 WebSocket 实时转写上传） */
  setOnPcm: (cb: ((pcm: Int16Array) => void) | null) => void
  /** 录音停止前的钩子（用于通知实时会话结束音频） */
  setOnStop: (cb: (() => void) | null) => void
  /** 查询录音是否已停止（供异步建立的实时会话判断是否错过停止时机） */
  isStopped: () => boolean
}

// —— 实时转写 WebSocket 会话 ——
interface LiveSession {
  sendPcm: (pcm: Int16Array) => void
  end: () => void
  done: Promise<{ text: string; confidence: number; enhanced?: string }>
  close: () => void
}

/**
 * 打开 /voice/live 实时转写会话：录音期间 sendPcm 上传 16kHz Int16 PCM，
 * 服务端把 native 流式识别的 partial 结果实时回调 onPartial，录音结束调用 end()，
 * done 在最终文本（final）返回后 resolve。
 */
function openLiveSession(language: string, onPartial: (t: string) => void): Promise<LiveSession> {
  return new Promise((resolve, reject) => {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const url = `${proto}//${location.host}/voice/live?lang=${encodeURIComponent(language)}`
    let ws: WebSocket
    try { ws = new WebSocket(url) } catch (err) { reject(err); return }
    // outer settled：连接建立（onopen）前失败必须 reject 外层 Promise，
    // 否则 onClick 里 await openLiveSession 会永久挂起、录音结束后无人结算
    let settled = false
    let finished = false
    const donePromise = new Promise<{ text: string; confidence: number; enhanced?: string }>((res, rej) => {
      ws.onmessage = (ev) => {
        let m: any
        try { m = JSON.parse(ev.data) } catch { return }
        if (m.type === 'partial' && typeof m.text === 'string') onPartial(m.text)
        else if (m.type === 'final') {
          finished = true
          res({ text: String(m.text ?? ''), confidence: Number(m.confidence ?? 0), enhanced: typeof m.enhanced === 'string' ? m.enhanced : undefined })
        }
        else if (m.type === 'error') { finished = true; rej(new Error(String(m.message ?? '实时识别失败'))) }
      }
      ws.onerror = () => {
        if (!settled) { settled = true; reject(new Error('实时识别连接失败')) }
        if (!finished) rej(new Error('实时识别连接失败'))
      }
      ws.onclose = () => {
        if (!settled) { settled = true; reject(new Error('实时识别连接中断')) }
        if (!finished) rej(new Error('实时识别连接中断'))
      }
    })
    ws.onopen = () => {
      if (settled) return
      settled = true
      resolve({
        sendPcm: (pcm) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength))
          }
        },
        end: () => { if (ws.readyState === WebSocket.OPEN) ws.send('end') },
        done: donePromise,
        close: () => { try { ws.close() } catch {} },
      })
    }
  })
}

/**
 * 因果线性插值重采样到 16kHz（AudioContext 采样率通常 44.1k/48k）。
 * 用已见样本 [idx-1, idx] 插值（不用未来样本 idx+1），对实时流是因果的，
 * 代价是恒定 1 个源采样点的滞后（16kHz 下 ~62.5µs），对 ASR 无影响。
 * 跨帧通过 prev（上一帧末样本）保持相位连续。
 * 返回 (Float32Array) => Float32Array；step = 源采样率 / 目标采样率。
 */
function createResampler(targetRate: number, sourceRate: number) {
  const step = sourceRate / targetRate
  let pos = 0
  let prev = 0
  let hasPrev = false
  return (input: Float32Array): Float32Array => {
    const out: number[] = []
    const n = input.length
    while (pos < n) {
      const idx = Math.floor(pos)
      const frac = pos - idx
      const s0 = idx > 0 ? input[idx - 1] : (hasPrev ? prev : input[0])
      const s1 = input[idx]
      out.push(s0 + (s1 - s0) * frac)
      pos += step
    }
    pos -= n
    if (n > 0) { prev = input[n - 1]; hasPrev = true }
    return new Float32Array(out)
  }
}

let activeHandle: RecorderHandle | null = null

function wavEncode(chunks: Int16Array[], sampleRate: number): Blob {
  let n = 0
  for (const c of chunks) n += c.length
  const buf = new ArrayBuffer(44 + n * 2)
  const view = new DataView(buf)
  const ws = (off: number, s: string) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)) }
  ws(0, 'RIFF'); view.setUint32(4, 36 + n * 2, true); ws(8, 'WAVE')
  ws(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true)
  ws(36, 'data'); view.setUint32(40, n * 2, true)
  let off = 44
  for (const c of chunks) {
    for (let i = 0; i < c.length; i++) { view.setInt16(off, c[i], true); off += 2 }
  }
  return new Blob([buf], { type: 'audio/wav' })
}

// AudioWorklet 采集器源码：postMessage 回传 Float32Array（transferable，零拷贝）
const WORKLET_SOURCE = `
class DshVoicePcmProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0]
    if (input && input[0] && input[0].length > 0) {
      this.port.postMessage(input[0], [input[0].buffer])
    }
    return true
  }
}
registerProcessor('dsh-voice-pcm', DshVoicePcmProcessor)
`

async function startRecording(params: ClientParams): Promise<RecorderHandle> {
  if (activeHandle) throw new Error('已有录音进行中')
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('当前浏览器不支持麦克风录音（需要 getUserMedia）')
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  })
  const AudioCtx = (window as any).AudioContext || (window as any).webkitAudioContext
  if (!AudioCtx) throw new Error('当前浏览器不支持 Web Audio')
  const actx: any = new AudioCtx()
  try { await actx.resume() } catch { /* 用户手势下 resume 一般都会成功 */ }
  const source = actx.createMediaStreamSource(stream)

  const chunks: Int16Array[] = []
  let levelCb: ((p: number) => void) | null = null
  let pcmCb: ((pcm: Int16Array) => void) | null = null
  let stopCb: (() => void) | null = null
  let lastVoice = performance.now()
  let startedVoice = false
  let stopped = false
  const startedAt = performance.now()
  const threshold = Math.pow(10, params.silenceThresholdDb / 20)
  const maxMs = params.maxDurationSec * 1000
  const silenceMs = params.silenceStopSec * 1000
  const resample = createResampler(16000, actx.sampleRate)

  const onSamples = (input: Float32Array) => {
    if (stopped) return
    const n = input.length
    if (!n) return
    const out = new Int16Array(n)
    let sum = 0
    for (let i = 0; i < n; i++) {
      const v = Math.max(-1, Math.min(1, input[i]))
      out[i] = v < 0 ? v * 0x8000 : v * 0x7fff
      sum += v * v
    }
    chunks.push(out)
    // 实时转写：重采样到 16kHz 后按 Int16 上传
    if (pcmCb) {
      const r16 = resample(input)
      if (r16.length > 0) {
        const pcm16 = new Int16Array(r16.length)
        for (let i = 0; i < r16.length; i++) {
          const v = Math.max(-1, Math.min(1, r16[i]))
          pcm16[i] = v < 0 ? v * 0x8000 : v * 0x7fff
        }
        pcmCb(pcm16)
      }
    }
    const rms = Math.sqrt(sum / n)
    levelCb?.(rms)
    const now = performance.now()
    if (rms > threshold) { startedVoice = true; lastVoice = now }
    // silenceStopSec<=0 = 禁用静音自动停止（默认）：录音只由手动关闭（或 maxDurationSec 硬上限）结束
    const vadStop = silenceMs > 0 && startedVoice && now - lastVoice >= silenceMs
    if (now - startedAt >= maxMs || vadStop) {
      stop()
    }
  }

  let resolveStop: (b: Blob) => void = () => {}
  let rejectStop: (e: Error) => void = () => {}
  const stopPromise = new Promise<Blob>((res, rej) => { resolveStop = res; rejectStop = rej })

  let proc: any = null
  let workletNode: any = null
  let workletUrl = ''

  const cleanup = () => {
    try { proc?.disconnect(); source.disconnect() } catch {}
    try { workletNode?.disconnect() } catch {}
    try { actx.close() } catch {}
    stream.getTracks().forEach(t => t.stop())
    if (workletUrl) URL.revokeObjectURL(workletUrl)
    activeHandle = null
  }

  const stop = () => {
    if (stopped) return
    stopped = true
    stopCb?.()
    if (noAudioTimer) clearTimeout(noAudioTimer)
    try { proc && (proc.onaudioprocess = null) } catch {}
    cleanup()
    if (chunks.length === 0) {
      rejectStop(new Error('没有采集到音频：请检查麦克风权限，或到 系统设置 → 隐私与安全性 → 麦克风 允许浏览器访问'))
    } else {
      resolveStop(wavEncode(chunks, actx.sampleRate))
    }
  }

  // 优先 AudioWorklet（现代 Chrome/Safari/Firefox），失败回退 ScriptProcessor
  // 两条链路都接到 0 增益节点再进 destination：保证节点被渲染引擎拉取（process 会被调用），
  // 同时避免把麦克风信号播到扬声器（回声）。
  const mute: any = actx.createGain()
  mute.gain.value = 0
  mute.connect(actx.destination)
  if (actx.audioWorklet) {
    try {
      workletUrl = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'application/javascript' }))
      await actx.audioWorklet.addModule(workletUrl)
      workletNode = new AudioWorkletNode(actx, 'dsh-voice-pcm', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 })
      workletNode.port.onmessage = (ev: any) => {
        const data = ev.data
        if (data instanceof Float32Array) onSamples(data)
      }
      source.connect(workletNode)
      workletNode.connect(mute)
    } catch {
      try { workletNode?.disconnect(); workletNode = null } catch {}
    }
  }
  if (!workletNode) {
    if (!actx.createScriptProcessor) {
      // 采集链路没建起来就抛出：此时 stopPromise 还没有任何消费者，看门狗也还没创建，
      // 直接清理抛错即可，不会留下未处理的 rejection 或悬挂计时器
      cleanup()
      throw new Error('当前浏览器不支持音频采集（缺少 AudioWorklet 与 ScriptProcessor）')
    }
    proc = actx.createScriptProcessor(4096, 1, 1)
    proc.onaudioprocess = (ev: any) => {
      if (stopped) return
      onSamples(ev.inputBuffer.getChannelData(0) as Float32Array)
    }
    source.connect(proc)
    proc.connect(mute)
  }

  // 看门狗：采集链路就绪后 2.5 秒内一个采样都没收到 → 判定链路失效，避免上传空音频。
  // 必须在链路建立之后创建：setup 抛错路径不会有悬挂计时器去结算无消费者的 Promise
  let noAudioTimer: any = setTimeout(() => {
    if (!stopped && chunks.length === 0) {
      console.error('[dsh-voice] watchdog: 2.5s 内没有收到任何采样')
      stop()
    }
  }, 2500)

  const handle: RecorderHandle = {
    stop: () => { stop() },
    done: stopPromise,
    setOnLevel: (cb) => { levelCb = cb },
    setOnPcm: (cb) => { pcmCb = cb },
    setOnStop: (cb) => { stopCb = cb },
    isStopped: () => stopped,
  }
  activeHandle = handle
  return handle
}

async function transcribe(blob: Blob, language: string, signal?: AbortSignal): Promise<{ text: string; enhanced: string; warning?: string }> {
  const form = new FormData()
  form.append('file', blob, 'voice.wav')
  if (language) form.append('language', language)
  const res = await fetch('/voice/transcribe', { method: 'POST', body: form, signal })
  const data: any = await res.json().catch(() => ({}))
  if (!res.ok || !data.ok) throw new Error(data.error ?? (`转写失败（HTTP ${res.status}）`))
  return { text: String(data.text ?? ''), enhanced: String(data.enhanced ?? ''), warning: data.warning ? String(data.warning) : undefined }
}

const CSS = `
.dsh-voice-wrap {
  position: relative;
  display: inline-flex;
  align-items: center;
  flex: none;
}
.dsh-voice-btn {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--dsw-alias-label-tertiary, #8b93a1);
  cursor: pointer;
  transition: color .15s ease, background-color .15s ease;
  flex: none;
}
.dsh-voice-btn:hover { color: var(--dsw-alias-label-primary, #e6e9ef); background: var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,.08)); }
.dsh-voice-btn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #4d7cfe); outline-offset: 2px; }
/* 录音态：品牌蓝 =「正在听」，不再用红色（红色只属于错误） */
.dsh-voice-btn.recording { color: var(--dsw-alias-state-business-primary, #4d7cfe); background: var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,.08)); }
.dsh-voice-btn.working { color: var(--dsw-alias-label-secondary, #cfd3d6); }
.dsh-voice-btn.error { color: var(--dsw-alias-state-error-primary, #f25a5a); }
.dsh-voice-spin {
  width: 13px; height: 13px; border-radius: 50%;
  border: 2px solid currentColor; border-top-color: transparent;
  animation: dsh-voice-rotate .8s linear infinite;
}
/* 录音/识别状态卡：浮在按钮上方，时间+电平+实时转写+下一步提示，全部可见、不依赖 hover */
.dsh-voice-live {
  position: absolute;
  bottom: calc(100% + 8px);
  right: 0;
  z-index: 50;
  display: inline-flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
  width: max-content;
  max-width: 340px;
  padding: 7px 12px;
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-2, #232529);
  border: 1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.1));
  box-shadow: 0 2px 8px rgb(0 0 0 / .18);
  font-size: 12px;
  line-height: 1.5;
  animation: dsh-voice-rise .16s cubic-bezier(.16, 1, .3, 1);
  white-space: nowrap;
}
.dsh-voice-live-row {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  white-space: nowrap;
}
.dsh-voice-eq {
  display: inline-flex;
  align-items: flex-end;
  gap: 2px;
  height: 16px;
  flex: none;
}
.dsh-voice-eq i {
  display: block;
  width: 3px;
  min-height: 4px;
  border-radius: 2px;
  background: var(--dsw-alias-state-business-primary, #4d7cfe);
  transition: height .1s ease-out;
}
.dsh-voice-time {
  font-family: var(--ds-font-family-code, ui-monospace, "SF Mono", Menlo, Consolas, monospace);
  font-variant-numeric: tabular-nums;
  color: var(--dsw-alias-label-primary, #e6e9ef);
  flex: none;
}
.dsh-voice-hint { color: var(--dsw-alias-label-secondary, #cfd3d6); }
.dsh-voice-live.working .dsh-voice-hint { color: var(--dsw-alias-label-tertiary, #8b93a1); }
/* 错误提示：有真实宽度（修复原先 46px 竖条不可读），错误红只在这里出现 */
.dsh-voice-error {
  position: absolute;
  bottom: calc(100% + 8px);
  right: 0;
  z-index: 50;
  width: max-content;
  min-width: 220px;
  max-width: 340px;
  padding: 8px 12px;
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-2, #232529);
  border: 1px solid var(--dsw-alias-state-error-primary, #f25a5a);
  color: var(--dsw-alias-label-primary, #e6e9ef);
  font-size: 12px;
  line-height: 1.6;
  text-align: left;
  white-space: normal;
  word-break: break-word;
  animation: dsh-voice-rise .16s cubic-bezier(.16, 1, .3, 1);
}
@keyframes dsh-voice-rotate { to { transform: rotate(360deg); } }
@keyframes dsh-voice-rise { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }
@media (prefers-reduced-motion: reduce) {
  .dsh-voice-live, .dsh-voice-error { animation: none; }
  .dsh-voice-eq i { transition: none; }
  .dsh-voice-spin { animation: none; border-top-color: currentColor; }
}
`

let styleInstalled = false
function ensureStyle() {
  if (styleInstalled || typeof document === 'undefined') return
  styleInstalled = true
  const el = document.createElement('style')
  el.setAttribute('data-plugin', 'dsh-voice')
  el.textContent = CSS
  document.head.appendChild(el)
}

function MicIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 10v1a7 7 0 0 0 14 0v-1" />
      <line x1="12" y1="19" x2="12" y2="22" />
    </svg>
  )
}

function StopIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
      <rect x="5" y="5" width="14" height="14" rx="2" />
    </svg>
  )
}

// 标准 kit 由框架注入：useInput（草稿状态 hook）、inputActions（setDraft 等动作）、sessionId
function VoiceButton(props: any) {
  const { useInput, inputActions, sessionId } = props
  const [phase, setPhase] = useState<'idle' | 'recording' | 'working'>('idle')
  const [seconds, setSeconds] = useState(0)
  const [level, setLevel] = useState(0)
  const [error, setError] = useState('')
  const handleRef = useRef<RecorderHandle | null>(null)
  const liveRef = useRef<LiveSession | null>(null)
  const paramsRef = useRef<ClientParams>({ ...DEFAULT_PARAMS })
  const timerRef = useRef<any>(null)
  const mountedRef = useRef(true)
  const abortRef = useRef<AbortController | null>(null)
  const startingRef = useRef(false)
  const draftRef = useRef('')
  // 录音开始前输入框已有的草稿：实时 partial 与最终文本都基于它拼接，直接显示在输入框内
  const baseDraftRef = useRef('')
  // partial 写输入框的节流（trailing throttle）：英文词级 partial 频率高，逐词 setDraft 会打爆
  // InputMachine 事务链 + 整个 InputBar 重渲染导致主线程假死，故合并到 ~150ms 一次
  const partialThrottleRef = useRef<{ timer: any; pending: string | null }>({ timer: null, pending: null })
  // 是否接受 partial 写入输入框：录音中为 true，录音结束（finish 开始）后置 false，让 final 独占最终填入
  const acceptingPartialRef = useRef(true)
  const draft = typeof useInput === 'function' ? useInput((s: any) => (s && typeof s.draft === 'string' ? s.draft : '')) : ''
  draftRef.current = draft

  useEffect(() => {
    // StrictMode 开发双挂载 / 复用实例时，effect 重跑必须重新武装 mounted 标志，
    // 否则清理函数置 false 后实例永久失活（finish/错误回调全部静默）。
    mountedRef.current = true
    ensureStyle()
    fetch('/voice/status').then(r => r.json()).then((s: any) => {
      if (s?.ok && s.client) {
        paramsRef.current = { ...DEFAULT_PARAMS, ...s.client, language: s.asr?.language || DEFAULT_PARAMS.language }
        // 服务端上传上限约束：录音时长不能超过 maxAudioBytes 能装下的 PCM 量（按 48kHz 16bit 保守估算）
        const maxBytes = Number(s.client.maxAudioBytes) || 0
        if (maxBytes > 0) {
          paramsRef.current.maxDurationSec = Math.max(5, Math.min(paramsRef.current.maxDurationSec, Math.floor(maxBytes / (48000 * 2)) - 2))
        }
      }
    }).catch((err: any) => {
      // 不再静默：参数拉取失败时保留默认值，但留一条可诊断的日志（默认参数仍可用）
      console.error('[dsh-voice] 无法获取 /voice/status，使用默认录音参数：', err?.message ?? err)
    })
    return () => {
      mountedRef.current = false
      if (timerRef.current) clearInterval(timerRef.current)
      if (partialThrottleRef.current.timer) clearTimeout(partialThrottleRef.current.timer)
      abortRef.current?.abort()
      liveRef.current?.close()
      liveRef.current = null
      handleRef.current?.stop()
      handleRef.current = null
    }
  }, [])

  const showError = (msg: string) => {
    setError(msg)
    console.error('[dsh-voice]', msg)
  }

  // 把识别文本实时写入输入框：基于「录音开始前草稿」拼接（实时 partial 与最终文本共用，避免重复追加）
  const applyDraft = (text: string) => {
    if (!inputActions || typeof inputActions.setDraft !== 'function') {
      console.error('[dsh-voice] inputActions.setDraft 不可用，无法写入输入框（框架注入缺失？）')
      return
    }
    const base = baseDraftRef.current
    inputActions.setDraft(base ? base + '\n' + text : text)
  }

  // 节流后的 partial 写入：合并 ~150ms 内的多次 partial，只写最后一次，降低状态机/React 压力。
  // 注：partial 走 setDraft 会污染框架输入状态机的 undo 栈（每次 pushTxn 记一条 undo，LOG_LIMIT=100），
  // 节流只能缓解不能根治；这是「实时进输入框」产品需求 vs 框架 setDraft 副作用的已知权衡——
  // 若未来需要彻底避免，可改回「独立 preview 状态 + 仅 final 走 setDraft」（但会偏离实时进输入框的诉求）。
  const applyDraftPartial = (text: string) => {
    if (!acceptingPartialRef.current) return
    partialThrottleRef.current.pending = text
    if (partialThrottleRef.current.timer) return
    partialThrottleRef.current.timer = setTimeout(() => {
      partialThrottleRef.current.timer = null
      const p = partialThrottleRef.current.pending
      partialThrottleRef.current.pending = null
      if (p !== null && mountedRef.current && acceptingPartialRef.current) applyDraft(p)
    }, 150)
  }

  // 停止接收 partial 并清掉待写的节流文本（录音结束 / 组件卸载时调用）
  const stopAcceptingPartial = () => {
    acceptingPartialRef.current = false
    if (partialThrottleRef.current.timer) clearTimeout(partialThrottleRef.current.timer)
    partialThrottleRef.current = { timer: null, pending: null }
  }

  // blob：录音产物（降级路径用）；sess：实时会话（null = 实时不可用，降级走旧上传）
  const finish = async (blob: Blob, sess: LiveSession | null) => {
    setPhase('working')
    setSeconds(0)
    setLevel(0)
    setError('')
    // 录音已结束：停止 partial 写输入框，清掉待写的节流文本，让 final 独占最终填入
    stopAcceptingPartial()
    try {
      if (sess) {
        // 实时路径：录音已停止（end 已发），等待最终识别结果；fillMode=enhanced 且服务端返回增强文本时填入增强结果
        try {
          const result = await sess.done
          const params = paramsRef.current
          let text = result.text?.trim()
          if (params.fillMode === 'enhanced' && result.enhanced && result.enhanced.trim()) {
            text = result.enhanced.trim()
          }
          if (!text) throw new Error('没有识别到语音内容，请重试')
          applyDraft(text)
        } catch (liveErr: any) {
          // 实时会话中途断开/失败：手里已有完整录音，降级为一次性上传，不丢结果
          console.warn('[dsh-voice] 实时转写中断，降级为录完上传：', liveErr?.message ?? liveErr)
          abortRef.current = new AbortController()
          const result = await transcribe(blob, paramsRef.current.language, abortRef.current.signal)
          const text = result.text
          if (!text) throw new Error('没有识别到语音内容，请重试')
          applyDraft(text)
          if (result.warning) {
            console.warn('[dsh-voice]', result.warning)
            setError(result.warning)
          }
        }
      } else {
        // 降级路径：录完一次性上传转写
        abortRef.current = new AbortController()
        const result = await transcribe(blob, paramsRef.current.language, abortRef.current.signal)
        const params = paramsRef.current
        const text = params.fillMode === 'transcript' || !result.enhanced ? result.text : result.enhanced
        if (text) {
          applyDraft(text)
          if (result.warning) {
            console.warn('[dsh-voice]', result.warning)
            setError(result.warning) // 非致命提示：已填入原始转写
          }
        } else {
          throw new Error('没有识别到语音内容，请重试')
        }
      }
    } catch (err: any) {
      if (err?.name === 'AbortError') return
      showError(err?.message ?? String(err ?? '语音识别失败'))
    } finally {
      abortRef.current = null
      if (sess) sess.close()
      setPhase('idle')
    }
  }

  const onClick = async () => {
    // startingRef：同步抢占启动权，堵住 async 启动窗口（getUserMedia 权限弹窗期间）的重复点击
    // → 防止双录音实例 / 双重 POST（React state 更新是异步的，光靠 phase 挡不住同 tick 连点）
    if (startingRef.current) return
    if (phase === 'working') {
      abortRef.current?.abort() // 识别中点击 = 取消（不再静默吞掉点击）
      return
    }
    if (phase === 'recording') {
      handleRef.current?.stop()
      return
    }
    startingRef.current = true
    setError('')
    baseDraftRef.current = draftRef.current // 记录录音前的草稿，实时文字基于它写入输入框
    // 重新开启 partial 接受 + 清掉上一轮的节流残留（含未触发的 timer）
    if (partialThrottleRef.current.timer) clearTimeout(partialThrottleRef.current.timer)
    acceptingPartialRef.current = true
    partialThrottleRef.current = { timer: null, pending: null }
    setPhase('working') // 权限弹窗期间显示 spinner，不再显得像没反应
    try {
      const h = await startRecording(paramsRef.current)
      handleRef.current = h
      h.setOnLevel(p => setLevel(Math.min(1, p * 8)))
      setPhase('recording')
      setSeconds(0)
      if (timerRef.current) clearInterval(timerRef.current)
      timerRef.current = setInterval(() => setSeconds(s => s + 1), 1000)
      // 尝试建立实时转写会话：边录边出字（节流写入输入框）；失败则降级为录完一次性上传
      try {
        const sess = await openLiveSession(paramsRef.current.language, (t) => {
          if (mountedRef.current) applyDraftPartial(t)
        })
        liveRef.current = sess
        h.setOnPcm(pcm => sess.sendPcm(pcm))
        h.setOnStop(() => sess.end())
        // 会话建立期间录音可能已停止（快速点停/到 maxMs）：此时 stopCb 已错过，需补发 end，
        // 否则 sess.done 永不结算、finish 永久挂起
        if (h.isStopped()) sess.end()
      } catch (err: any) {
        console.warn('[dsh-voice] 实时转写不可用，降级为录完上传：', err?.message ?? err)
      }
      // 只监听结算 Promise，不再主动调用 stop（旧版 h.stop() 会立即停止录音并上传空音频）
      h.done.then(blob => {
        if (timerRef.current) clearInterval(timerRef.current)
        timerRef.current = null
        handleRef.current = null
        const sess = liveRef.current
        liveRef.current = null
        if (mountedRef.current) finish(blob, sess)
      }).catch((err: any) => {
        if (timerRef.current) clearInterval(timerRef.current) // 拒绝路径同样要清计时器，否则重试会双计时
        timerRef.current = null
        stopAcceptingPartial()
        liveRef.current?.close()
        liveRef.current = null
        if (mountedRef.current) {
          setPhase('idle')
          showError(`录音失败：${err?.message ?? err}`)
        }
      })
    } catch (err: any) {
      stopAcceptingPartial()
      showError(`无法开始录音：${err?.message ?? err}`)
      setPhase('idle')
    } finally {
      startingRef.current = false
    }
  }

  if (sessionId === undefined) return null
  const fmtTime = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
  const vadSec = paramsRef.current.silenceStopSec
  const maxSec = Math.max(5, Math.round(paramsRef.current.maxDurationSec))
  const stopHint = vadSec > 0
    ? `停顿 ${Math.round(vadSec * 10) / 10}s 自动停止 · 点击结束`
    : `点击结束 · 最长 ${fmtTime(maxSec)}`
  return (
    <span className="dsh-voice-wrap">
      <button
        className={`dsh-voice-btn ${phase === 'recording' ? 'recording' : ''} ${phase === 'working' ? 'working' : ''} ${error ? 'error' : ''}`}
        title={phase === 'recording' ? '点击结束录音' : phase === 'working' ? '点击取消识别' : error ? '语音输入出错（详见上方提示）' : '语音输入'}
        aria-label={phase === 'recording' ? '结束录音' : '语音输入'}
        aria-pressed={phase === 'recording'}
        onClick={onClick}
        type="button"
      >
        {phase === 'idle' && <MicIcon />}
        {phase === 'recording' && <StopIcon />}
        {phase === 'working' && <span className="dsh-voice-spin" />}
      </button>
      {(phase === 'recording' || phase === 'working') && (
        <div className={`dsh-voice-live${phase === 'working' ? ' working' : ''}`} role="status">
          <span className="dsh-voice-live-row">
            {phase === 'recording' && (
              <span className="dsh-voice-eq" aria-hidden="true">
                {EQ_MULT.map((m, i) => (
                  <i key={i} style={{ height: `${Math.max(4, Math.round(4 + level * 12 * m))}px` }} />
                ))}
              </span>
            )}
            {phase === 'recording' && <span className="dsh-voice-time">{fmtTime(seconds)}</span>}
            <span className="dsh-voice-hint">
              {phase === 'recording' ? stopHint : '识别中…（点击可取消）'}
            </span>
          </span>
        </div>
      )}
      {error && <div className="dsh-voice-error" role="alert">{error}</div>}
    </span>
  )
}

export function apply(ctx: any) {
  ctx.inject(['slots'], (scope: any) => {
    scope.slots.inject('conversation.input.right', () =>
      scope.slots.register({
        name: 'conversation.input.right',
        id: 'voice-record',
        order: 100,
      }, VoiceButton),
    )
  })
}
