// dsh-voice 宿主插件：HTTP 转写端点 + 原生录音/转写引擎 + 语音工具
// 客户端 UI 插件见 src/client.tsx（构建产物 dist/client.js）
import { spawn } from 'node:child_process'
import { mkdir, writeFile, readFile, rm, stat, chmod } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { BlockAssembler } from '@deepseek-ai/dsh-llm'
import Schema from '@deepseek-ai/schemastery'

export const name = 'dsh-voice'
export const inject = ['tools', 'llm']

export interface Config {
  record: {
    backend: 'auto' | 'native' | 'ffmpeg' | 'sox' | 'arecord' | 'powershell'
    maxDurationSec: number
    silenceStopSec: number
    silenceThresholdDb: number
    device: string
  }
  asr: {
    provider: 'auto' | 'native' | 'http' | 'whisper-cli'
    language: string
    http: { baseURL: string; apiKey: string; model: string }
    whisperCli: { command: string; model: string }
  }
  enhance: { enabled: boolean; provider: string; model: string; language: string }
  tts: { enabled: boolean; voice: string; beep: boolean }
  client: {
    fillMode: 'transcript' | 'enhanced'
    maxDurationSec: number
    silenceStopSec: number
    silenceThresholdDb: number
    maxAudioBytes: number
    allowedOrigins: string[]
  }
  workDir: string
}

export const Config: Schema<Config> = Schema.object({
  record: Schema.object({
    backend: Schema.union(['auto', 'native', 'ffmpeg', 'sox', 'arecord', 'powershell'] as const).default('auto'),
    maxDurationSec: Schema.number().min(5).max(600).default(60),
    silenceStopSec: Schema.number().min(0.4).max(10).default(1.6),
    silenceThresholdDb: Schema.number().min(-60).max(-5).default(-40),
    device: Schema.string().default(''),
  }).default({}),
  asr: Schema.object({
    provider: Schema.union(['auto', 'native', 'http', 'whisper-cli'] as const).default('auto'),
    language: Schema.string().default('zh-CN'),
    http: Schema.object({
      baseURL: Schema.string().default('https://api.openai.com/v1'),
      apiKey: Schema.string().default(''),
      model: Schema.string().default('whisper-1'),
    }).default({}),
    whisperCli: Schema.object({
      command: Schema.string().default('whisper-cli -m {model} -f {file} -l {language} --no-timestamps --output-txt'),
      model: Schema.string().default(''),
    }).default({}),
  }).default({}),
  enhance: Schema.object({
    enabled: Schema.boolean().default(true),
    provider: Schema.string().default(''),
    model: Schema.string().default(''),
    language: Schema.string().default('zh'),
  }).default({}),
  tts: Schema.object({
    enabled: Schema.boolean().default(true),
    voice: Schema.string().default(''),
    beep: Schema.boolean().default(true),
  }).default({}),
  client: Schema.object({
    fillMode: Schema.union(['transcript', 'enhanced'] as const).default('enhanced'),
    maxDurationSec: Schema.number().min(5).max(300).default(60),
    silenceStopSec: Schema.number().min(0.4).max(10).default(1.6),
    silenceThresholdDb: Schema.number().min(-60).max(-5).default(-40),
    maxAudioBytes: Schema.number().min(1024).default(25 * 1024 * 1024),
    allowedOrigins: Schema.array(Schema.string()).default([]),
  }).default({}),
  workDir: Schema.string().default(''),
}).default({})

const ENHANCE_SYSTEM = `你是「语音编程编译器」，把语音转写文本转换为清晰、完整、可直接执行的编程任务描述。
规则：
1. 修正语音识别错误（谐音、同音字、吞字），尤其是技术术语：例如「斯佳佳」→ C++，「派森」→ Python，「迪夫」→ diff，「金仓/给他」→ Git，「扎哇」→ Java，「麦斯扣」→ MySQL。
2. 保留原意，不要添加用户没有提到的新需求；不确定的地方标注「（此处语音不清，疑似…）」。
3. 把口语化、跳跃的表达扩充为结构化指令：任务目标、具体要求、约束与注意事项、建议执行步骤。
4. 输出 Markdown，按以下固定结构：
## 语音原意（转写修正）
<精简整理后的原意，尽量保留用户原话>
## 任务目标
<一句话目标>
## 具体要求
<分条列出>
## 约束与注意事项
<分条列出；没有可写「无」>
## 建议执行步骤
<编号步骤>
## 一句话总结
<一句话>。输出必须从「## 语音原意」开始，不要任何开场白。`

interface RecordOutcome { file: string; seconds: number; peakDb: number; speechDetected: boolean; backend: string }
interface AsrOutcome { text: string; confidence: number; backend: string }
interface StatusInfo {
  ok: boolean
  platform: string
  recorder: { backend: string; available: boolean; nativeBinary: boolean }
  asr: { provider: string; available: boolean; language: string }
  enhance: { enabled: boolean; provider: string; model: string; resolved: boolean }
  client: { fillMode: string; maxDurationSec: number; silenceStopSec: number; silenceThresholdDb: number }
}

interface SpawnResult { stdout: string; stderr: string; code: number | null }

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

class VoiceEngine {
  private workDir = ''
  private swiftBin = ''
  private compiling: Promise<string> | null = null
  private queue: Promise<unknown> = Promise.resolve()
  private ctx: Context
  private config: Config

  constructor(ctx: Context, config: Config) {
    this.ctx = ctx
    this.config = config
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn)
    this.queue = run.then(() => undefined, () => undefined)
    return run
  }

  private async dir(): Promise<string> {
    if (!this.workDir) {
      const base = this.config.workDir || path.join(tmpdir(), 'dsh-voice')
      await mkdir(base, { recursive: true })
      this.workDir = base
    }
    return this.workDir
  }

  private async run(cmd: string, args: string[], opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<SpawnResult> {
    return await new Promise<SpawnResult>((resolve, reject) => {
      const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: false })
      let stdout = ''
      let stderr = ''
      let settled = false
      const timer = opts.timeoutMs ? setTimeout(() => {
        if (!settled) { settled = true; child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 1000) }
      }, opts.timeoutMs) : null
      const onAbort = () => {
        if (!settled) { settled = true; child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 1000) }
      }
      opts.signal?.addEventListener('abort', onAbort, { once: true })
      child.stdout.on('data', (d: Uint8Array) => { stdout += d.toString() })
      child.stderr.on('data', (d: Uint8Array) => { stderr += d.toString() })
      child.on('error', (err) => {
        if (timer) clearTimeout(timer)
        opts.signal?.removeEventListener('abort', onAbort)
        if (!settled) { settled = true; reject(err) }
      })
      child.on('close', (code) => {
        if (timer) clearTimeout(timer)
        opts.signal?.removeEventListener('abort', onAbort)
        if (!settled) { settled = true; resolve({ stdout, stderr, code }) }
      })
    })
  }

  private async has(cmd: string): Promise<boolean> {
    try {
      const r = await this.run('sh', ['-c', `command -v "${cmd}"`], { timeoutMs: 5000 })
      return r.code === 0 && r.stdout.trim().length > 0
    } catch {
      return false
    }
  }

  private async ensureSwift(): Promise<string> {
    if (this.swiftBin && existsSync(this.swiftBin)) return this.swiftBin
    if (this.compiling) return await this.compiling
    this.compiling = (async () => {
      const src = fileURLToPath(new URL('./swift/voicekit.swift', import.meta.url))
      if (!existsSync(src)) throw new Error('找不到 voicekit.swift（原生录音 helper 源码缺失）')
      const dir = await this.dir()
      const bin = path.join(dir, 'voicekit-native')
      const srcMtime = (await stat(src)).mtimeMs
      let binMtime = 0
      try { binMtime = (await stat(bin)).mtimeMs } catch {}
      if (!existsSync(bin) || binMtime < srcMtime) {
        const r = await this.run('swiftc', ['-O', src, '-o', bin], { timeoutMs: 180000 })
        if (r.code !== 0) throw new Error(`voicekit 编译失败: ${r.stderr.slice(-800)}`)
        await chmod(bin, 0o755).catch(() => undefined)
      }
      this.swiftBin = bin
      return bin
    })().finally(() => { this.compiling = null })
    return await this.compiling
  }

  private pickRecorder(): string {
    const cfg = this.config.record.backend
    if (cfg !== 'auto') return cfg
    if (process.platform === 'darwin') return 'native'
    if (process.platform === 'win32') return 'ffmpeg'
    return 'ffmpeg'
  }

  async status(): Promise<StatusInfo> {
    const platform = process.platform
    const recorder = this.pickRecorder()
    let nativeBinary = false
    if (recorder === 'native') {
      try { await this.ensureSwift(); nativeBinary = true } catch {}
    }
    const asrProvider = this.resolveAsrProvider()
    let asrAvailable = true
    if (asrProvider === 'native') {
      asrAvailable = platform === 'darwin'
      if (asrAvailable) { try { await this.ensureSwift() } catch { asrAvailable = false } }
    } else if (asrProvider === 'whisper-cli') {
      const [first] = this.config.asr.whisperCli.command.split(' ')
      asrAvailable = await this.has(first)
    }
    let resolved = false
    try { const route = await this.resolveLlmRoute(); resolved = !!route.provider } catch {}
    return {
      ok: true,
      platform,
      recorder: { backend: recorder, available: true, nativeBinary },
      asr: { provider: asrProvider, available: asrAvailable, language: this.config.asr.language },
      enhance: { enabled: this.config.enhance.enabled, provider: this.config.enhance.provider, model: this.config.enhance.model, resolved },
      client: {
        fillMode: this.config.client.fillMode,
        maxDurationSec: this.config.client.maxDurationSec,
        silenceStopSec: this.config.client.silenceStopSec,
        silenceThresholdDb: this.config.client.silenceThresholdDb,
        maxAudioBytes: this.config.client.maxAudioBytes,
      },
    }
  }

  private resolveAsrProvider(): string {
    const cfg = this.config.asr.provider
    if (cfg !== 'auto') return cfg
    if (process.platform === 'darwin') return 'native'
    if (this.config.asr.http.apiKey) return 'http'
    return 'whisper-cli'
  }

  private async record(durationSec: number, signal?: AbortSignal): Promise<RecordOutcome> {
    const backend = this.pickRecorder()
    const dir = await this.dir()
    const out = path.join(dir, `voice-${Date.now()}-${Math.floor(Math.random() * 1e6)}.wav`)
    const cfg = this.config.record
    if (backend === 'native') {
      const bin = await this.ensureSwift()
      const r = await this.run(bin, ['record', '--out', out, '--seconds', String(durationSec), '--silence', String(cfg.silenceStopSec), '--threshold', String(cfg.silenceThresholdDb)], { signal, timeoutMs: (durationSec + 30) * 1000 })
      const line = r.stdout.trim().split('\n').pop() ?? ''
      let meta: any = {}
      try { meta = JSON.parse(line) } catch {}
      if (!meta.ok) throw new Error(meta.error ?? `原生录音失败: ${r.stderr.slice(-300)}`)
      return { file: out, seconds: Number(meta.seconds ?? 0), peakDb: Number(meta.peakDb ?? 0), speechDetected: !!meta.speechDetected, backend }
    }
    if (backend === 'ffmpeg') {
      const dev = cfg.device || (process.platform === 'darwin' ? ':0' : 'default')
      const input = process.platform === 'darwin' ? ['-f', 'avfoundation', '-i', dev] : process.platform === 'win32' ? ['-f', 'dshow', '-i', `audio="${dev}"`] : ['-f', 'pulse', '-i', dev]
      const r = await this.run('ffmpeg', ['-y', ...input, '-t', String(durationSec), '-ar', '16000', '-ac', '1', '-af', `silenceremove=stop_periods=1:stop_duration=${Math.max(cfg.silenceStopSec, 0.5)}:stop_threshold=${cfg.silenceThresholdDb}dB`, out], { signal, timeoutMs: (durationSec + 30) * 1000 })
      if (r.code !== 0) throw new Error(`ffmpeg 录音失败: ${r.stderr.slice(-300)}`)
      return { file: out, seconds: durationSec, peakDb: 0, speechDetected: true, backend }
    }
    if (backend === 'sox') {
      const r = await this.run('sox', ['-d', '-r', '16000', '-c', '1', '-t', 'wav', out, 'silence', '1', '0.3', '2%', '1', String(cfg.silenceStopSec), '2%', 'trim', '0', String(durationSec)], { signal, timeoutMs: (durationSec + 30) * 1000 })
      if (r.code !== 0) throw new Error(`sox 录音失败: ${r.stderr.slice(-300)}`)
      return { file: out, seconds: durationSec, peakDb: 0, speechDetected: true, backend }
    }
    if (backend === 'arecord') {
      const args = ['-f', 'S16_LE', '-r', '16000', '-c', '1', '-d', String(durationSec)]
      if (cfg.device) args.push('-D', cfg.device)
      args.push(out)
      const r = await this.run('arecord', args, { signal, timeoutMs: (durationSec + 30) * 1000 })
      if (r.code !== 0) throw new Error(`arecord 录音失败: ${r.stderr.slice(-300)}`)
      return { file: out, seconds: durationSec, peakDb: 0, speechDetected: true, backend }
    }
    if (backend === 'powershell') {
      const script = `$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms
# 依赖 Windows.Media.WinRT 投影；失败时请改用 ffmpeg dshow 后端
[Windows.Media.Capture.MediaCapture,Windows.Media,ContentType=WindowsRuntime] | Out-Null
`
      throw new Error('powershell 录音后端暂未实现完整脚本，请改用 ffmpeg（dshow）后端')
    }
    throw new Error(`未知录音后端: ${backend}`)
  }

  private async runAsr(file: string, language: string, signal?: AbortSignal): Promise<AsrOutcome> {
    const provider = this.resolveAsrProvider()
    if (provider === 'native') {
      const bin = await this.ensureSwift()
      const r = await this.run(bin, ['transcribe', '--in', file, '--lang', language], { signal, timeoutMs: 320000 })
      const line = r.stdout.trim().split('\n').pop() ?? ''
      let meta: any = {}
      try { meta = JSON.parse(line) } catch {}
      if (!meta.ok) throw new Error(meta.error ?? `原生转写失败: ${r.stderr.slice(-300)}`)
      return { text: String(meta.text ?? ''), confidence: Number(meta.confidence ?? 0), backend: 'native' }
    }
    if (provider === 'http') {
      const cfg = this.config.asr.http
      const data = await readFile(file)
      const form = new FormData()
      form.append('file', new Blob([new Uint8Array(data)], { type: 'audio/wav' }), 'voice.wav')
      form.append('model', cfg.model)
      if (language) form.append('language', language)
      const headers: Record<string, string> = {}
      if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`
      const res = await fetch(`${cfg.baseURL.replace(/\/$/, '')}/audio/transcriptions`, { method: 'POST', headers, body: form, signal })
      if (!res.ok) throw new Error(`ASR HTTP 请求失败: ${res.status} ${(await res.text()).slice(0, 300)}`)
      const json: any = await res.json()
      return { text: String(json.text ?? '').trim(), confidence: 0, backend: 'http' }
    }
    if (provider === 'whisper-cli') {
      const cfg = this.config.asr.whisperCli
      const cmd = cfg.command
        .split('{file}').join(file)
        .split('{model}').join(cfg.model)
        .split('{language}').join(language)
      const r = await this.run('sh', ['-c', cmd], { signal, timeoutMs: 600000 })
      if (r.code !== 0) throw new Error(`whisper-cli 转写失败: ${r.stderr.slice(-300)}`)
      const text = r.stdout.trim().split('\n').pop() ?? ''
      if (!text) throw new Error('whisper-cli 没有输出文本')
      return { text, confidence: 0, backend: 'whisper-cli' }
    }
    throw new Error(`未知 ASR provider: ${provider}`)
  }

  private async resolveLlmRoute(): Promise<{ provider: string; model: string }> {
    const cfg = this.config.enhance
    if (cfg.provider && cfg.model) return { provider: cfg.provider, model: cfg.model }
    const settings = this.ctx.get('settings') as { get?: (ns: string) => unknown } | undefined
    const def = settings?.get?.('agent-default-model') as { provider?: string; model?: string } | undefined
    if (def?.provider && def?.model) return { provider: def.provider, model: def.model }
    const providers = this.ctx.llm.listProviders()
    if (providers.length) {
      const p = providers[0].id
      const models = await this.ctx.llm.listModels(p)
      if (models.length) return { provider: p, model: models[0].id }
    }
    throw new Error('无法解析 LLM 路由：请在插件配置里设置 enhance.provider / enhance.model，或先在设置中配置默认模型')
  }

  private async enhance(transcript: string, signal?: AbortSignal): Promise<{ enhanced: string; summary: string }> {
    if (!this.config.enhance.enabled) return { enhanced: transcript, summary: '' }
    const route = await this.resolveLlmRoute()
    const lang = this.config.enhance.language === 'auto' ? '' : this.config.enhance.language
    const hint = lang ? `\n\n（增强输出语言：${lang === 'zh' ? '中文' : 'English'}）` : ''
    const stream = this.ctx.llm.stream({
      provider: route.provider,
      model: route.model,
      system: ENHANCE_SYSTEM,
      messages: [{ role: 'user', content: [{ type: 'text', text: transcript + hint }] }],
      temperature: 0.3,
      maxTokens: 1600,
      signal,
    })
    const assembler = new BlockAssembler()
    for await (const chunk of stream) assembler.push(chunk)
    const finish = assembler.finish
    if (finish.kind === 'error' || finish.kind === 'aborted') {
      throw new Error(`LLM 增强失败: ${finish.failure?.message ?? finish.kind}`)
    }
    const text = assembler.blocks().filter((b: any) => b.type === 'text').map((b: any) => b.text).join('')
    const m = text.match(/## 一句话总结\s*\n([\s\S]+?)(?:\n## |$)/)
    const summary = (m ? m[1] : '').trim().replace(/^#+\s*/, '')
    return { enhanced: text.trim() || transcript, summary }
  }

  private async tts(text: string): Promise<void> {
    if (!this.config.tts.enabled || !text) return
    const voice = this.config.tts.voice ? ['-v', this.config.tts.voice] : []
    if (process.platform === 'darwin') await this.run('say', [...voice, text], { timeoutMs: 60000 }).catch(() => undefined)
    else if (process.platform === 'win32') await this.run('powershell', ['-NoProfile', '-Command', `Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).Speak('${text.replace(/'/g, "''")}')`], { timeoutMs: 60000 }).catch(() => undefined)
    else await this.run('espeak-ng', [text], { timeoutMs: 60000 }).catch(() => undefined)
  }

  private async beep(): Promise<void> {
    if (!this.config.tts.beep) return
    const dir = await this.dir()
    const beepFile = path.join(dir, 'beep.wav')
    if (!existsSync(beepFile)) {
      // 生成 0.12s 880Hz 衰减正弦波 WAV
      const rate = 16000
      const n = Math.floor(rate * 0.12)
      const bytes = new Uint8Array(44 + n * 2)
      const view = new DataView(bytes.buffer)
      const writeStr = (off: number, s: string) => { for (let i = 0; i < s.length; i++) bytes[off + i] = s.charCodeAt(i) }
      writeStr(0, 'RIFF'); view.setUint32(4, 36 + n * 2, true); writeStr(8, 'WAVE')
      writeStr(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true)
      view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true)
      writeStr(36, 'data'); view.setUint32(40, n * 2, true)
      for (let i = 0; i < n; i++) {
        const env = Math.exp(-i / (n * 0.35))
        const v = Math.round(Math.sin(2 * Math.PI * 880 * i / rate) * 0.45 * env * 32767)
        view.setInt16(44 + i * 2, v, true)
      }
      await writeFile(beepFile, bytes)
    }
    if (process.platform === 'darwin') await this.run('afplay', [beepFile], { timeoutMs: 5000 }).catch(() => undefined)
    else if (process.platform === 'win32') await this.run('powershell', ['-NoProfile', '-Command', `(New-Object System.Media.SoundPlayer '${beepFile}').PlaySync()`], { timeoutMs: 5000 }).catch(() => undefined)
    else await this.run('aplay', ['-q', beepFile], { timeoutMs: 5000 }).catch(() => undefined)
  }

  async listen(args: { purpose?: string; durationSec?: number; language?: string }, signal?: AbortSignal) {
    return await this.enqueue(async () => {
      const purpose = args.purpose?.trim() || '编程指令'
      const language = args.language?.trim() || this.config.asr.language
      const durationSec = args.durationSec ?? this.config.record.maxDurationSec
      await this.beep()
      await this.tts(`请开始说话：${purpose}`)
      const rec = await this.record(durationSec, signal)
      if (!rec.speechDetected) throw new Error('未检测到语音，请重试或检查麦克风权限（系统设置 → 隐私与安全性 → 麦克风）')
      const asr = await this.runAsr(rec.file, language, signal)
      let enhanced = ''
      let summary = ''
      if (this.config.enhance.enabled) {
        const e = await this.enhance(asr.text, signal)
        enhanced = e.enhanced
        summary = e.summary
      }
      return {
        transcript: asr.text,
        enhanced,
        summary,
        confidence: asr.confidence,
        durationSec: Math.round(rec.seconds * 10) / 10,
        audioPath: rec.file,
        asrBackend: asr.backend,
      }
    })
  }

  async ask(args: { question: string; language?: string }, signal?: AbortSignal) {
    return await this.enqueue(async () => {
      const language = args.language?.trim() || this.config.asr.language
      await this.beep()
      await this.tts(args.question)
      const rec = await this.record(this.config.record.maxDurationSec, signal)
      if (!rec.speechDetected) throw new Error('未检测到语音回答')
      const asr = await this.runAsr(rec.file, language, signal)
      let enhancedAnswer = ''
      if (this.config.enhance.enabled) {
        const e = await this.enhance(asr.text, signal)
        enhancedAnswer = e.enhanced
      }
      return { question: args.question, answer: asr.text, enhancedAnswer, confidence: asr.confidence, durationSec: Math.round(rec.seconds * 10) / 10 }
    })
  }

  async transcribeFile(filePath: string, language?: string, signal?: AbortSignal) {
    return await this.enqueue(async () => {
      if (!existsSync(filePath)) throw new Error(`音频文件不存在: ${filePath}`)
      const asr = await this.runAsr(filePath, (language?.trim() || this.config.asr.language), signal)
      let enhanced = ''
      let summary = ''
      let enhanceWarning = ''
      if (this.config.enhance.enabled) {
        try {
          const e = await this.enhance(asr.text, signal)
          enhanced = e.enhanced
          summary = e.summary
        } catch (err: any) {
          // 增强失败不应吞掉一份有效的转写：降级返回原始文本并附 warning
          enhanceWarning = `LLM 增强失败，已返回原始转写：${String(err?.message ?? err)}`
        }
      }
      return {
        text: asr.text, enhanced, summary, enhanceWarning,
        confidence: asr.confidence, backend: asr.backend,
        language: language?.trim() || this.config.asr.language,
      }
    })
  }
}

function json(res: any, code: number, body: unknown) {
  if (res.writableEnded || res.destroyed) return
  try {
    const data = JSON.stringify(body)
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(data) })
    res.end(data)
  } catch {
    try { res.destroy() } catch {}
  }
}

function originAllowed(origin: string | undefined, extra: string[]): boolean {
  if (!origin || origin === 'null') return true
  try {
    const u = new URL(origin)
    if (['127.0.0.1', 'localhost', '::1', '[::1]'].includes(u.hostname)) return true
    return extra.includes(origin)
  } catch {
    return false
  }
}

/** 解析 WAV 中 data chunk 的字节数（兼容 JUNK/FLLR 等扩展 chunk），返回 -1 表示非法 WAV */
function wavDataBytes(buf: Uint8Array): number {
  if (buf.length < 12) return -1
  const ascii = (off: number, len: number) => String.fromCharCode(...buf.subarray(off, off + len))
  if (ascii(0, 4) !== 'RIFF' || ascii(8, 4) !== 'WAVE') return -1
  let off = 12
  while (off + 8 <= buf.length) {
    const id = ascii(off, 4)
    const size = buf[off + 4] | (buf[off + 5] << 8) | (buf[off + 6] << 16) | (buf[off + 7] << 24)
    if (id === 'data') return Math.min(size, buf.length - off - 8)
    off += 8 + size + (size % 2)
  }
  return -1
}

/** 判断错误是否属于「用户可自行处理」级别（录音/权限问题），返回 422 而不是 500 */
function isUserLevelError(msg: string): boolean {
  return /no speech|没有识别到语音|没有检测到语音|录音为空|音频为空|未检测到语音|麦克风权限|语音识别权限|权限未授权|权限被拒绝|音频文件不存在|不支持.*语言|音频超过大小限制/i.test(msg)
}

/** 把底层错误翻译成对用户更友好的提示 */
function friendlyError(err: unknown): string {
  const msg = String((err as any)?.message ?? err)
  if (/No speech detected/i.test(msg)) return '没有检测到语音内容：请靠近麦克风、声音大一点再试（录音过短或全是环境噪音时也会出现该提示）'
  return msg
}

export function apply(ctx: Context, config: Config) {
  const engine = new VoiceEngine(ctx, config)

  // —— HTTP 端点（客户端 UI 插件使用）——
  // 用 ctx.inject 等待 webServer 服务就绪（loader 并行加载存在竞态），自动随插件卸载清理
  ctx.inject(['webServer'], (scope: any) => {
    {
      const unregister = scope.webServer.register({
        kind: 'exact',
        path: '/voice/transcribe',
        handler: async (req, res) => {
          if (!originAllowed(req.headers.origin, config.client.allowedOrigins)) {
            return json(res, 403, { ok: false, error: '跨域请求被拒绝' })
          }
          if (req.method !== 'POST') {
            res.setHeader('Allow', 'POST')
            return json(res, 405, { ok: false, error: '仅支持 POST' })
          }
          try {
            // 客户端断开检测只能挂在 res 上：Node 里 req 的 'close' 在「请求体读完」时就触发（正常完成也触发），
            // 挂在 req 上会让每次请求在上传结束后立刻 abort，LLM 流以已中止的 signal 启动 → "aborted by caller"。
            // res 的 'close' 才是「连接在响应写完之前关闭」= 客户端真断开；配合 !res.writableEnded 过滤正常完成。
            const ac = new AbortController()
            const onClose = () => { if (!res.writableEnded) ac.abort() }
            res.on('close', onClose)
            const parts: Uint8Array[] = []
            let total = 0
            for await (const c of req) { parts.push(c); total += c.length; if (total > config.client.maxAudioBytes) throw new Error('音频超过大小限制') }
            const body = new Uint8Array(total)
            let off = 0
            for (const p of parts) { body.set(p, off); off += p.length }
            let form: FormData
            try {
              form = await new Request(`http://localhost${req.url ?? '/'}`, { method: 'POST', headers: req.headers as any, body }).formData()
            } catch {
              return json(res, 400, { ok: false, error: '请求不是有效的 multipart/form-data' })
            }
            const file = form.get('file')
            if (!file || typeof file === 'string') return json(res, 400, { ok: false, error: '缺少 file 字段（multipart/form-data）' })
            const language = String(form.get('language') ?? config.asr.language)
            const data = new Uint8Array(await (file as File).arrayBuffer())
            if (data.length === 0) return json(res, 400, { ok: false, error: '音频为空' })
            const dataLen = wavDataBytes(data)
            if (dataLen === -1) return json(res, 422, { ok: false, error: '上传的不是有效的 WAV 音频' })
            if (dataLen === 0) return json(res, 422, { ok: false, error: '录音为空：浏览器没有采集到音频数据。请检查麦克风权限（系统设置 → 隐私与安全性 → 麦克风）后重试' })
            const dir = path.join(tmpdir(), 'dsh-voice-uploads')
            await mkdir(dir, { recursive: true })
            const tmp = path.join(dir, `upload-${Date.now()}-${Math.floor(Math.random() * 1e6)}.wav`)
            await writeFile(tmp, data)
            try {
              const asr = await engine.transcribeFile(tmp, language, ac.signal)
              let enhanced = asr.enhanced
              let summary = asr.summary
              if (!config.enhance.enabled) { enhanced = ''; summary = '' }
              json(res, 200, {
                ok: true, text: asr.text, enhanced, summary,
                confidence: asr.confidence, backend: asr.backend, language: asr.language,
                ...(asr.enhanceWarning ? { warning: asr.enhanceWarning } : {}),
              })
            } finally {
              res.off('close', onClose)
              await rm(tmp, { force: true }).catch(() => undefined)
            }
          } catch (err: any) {
            if (res.writableEnded) return
            const msg = friendlyError(err)
            json(res, isUserLevelError(msg) ? 422 : 500, { ok: false, error: msg })
          }
        },
      })
      const unregister2 = scope.webServer.register({
        kind: 'exact',
        path: '/voice/status',
        handler: async (req, res) => {
          if (!originAllowed(req.headers.origin, config.client.allowedOrigins)) {
            return json(res, 403, { ok: false, error: '跨域请求被拒绝' })
          }
          if (req.method !== 'GET' && req.method !== 'OPTIONS') return json(res, 405, { ok: false, error: '仅支持 GET' })
          try {
            json(res, 200, await engine.status())
          } catch (err: any) {
            json(res, 500, { ok: false, error: String(err?.message ?? err) })
          }
        },
      })
      return () => { unregister(); unregister2() }
    }
  })

  // —— 语音工具（agent 可调用，实现 agent voice 编程）——
  ctx.tools.register(defineTool({
    name: 'voice_listen',
    description: '通过系统原生麦克风录制用户语音并转文字，再用 LLM 修正识别错误、扩充为结构化编程任务。调用前会播放提示音并用 TTS 提醒用户说话；用户说完后自动停止。适合语音驱动编程：听取用户口述需求后继续编码。',
    parameters: {
      purpose: { type: 'string', description: '本轮录音的主题（如"修复登录超时问题"），用于 TTS 提示用户说什么' },
      durationSec: { type: 'integer', description: '最大录音秒数，默认取配置 record.maxDurationSec' },
      language: { type: 'string', description: '识别语言（如 zh-CN / en-US），默认取配置 asr.language' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          transcript: { type: 'string' },
          enhanced: { type: 'string' },
          summary: { type: 'string' },
          confidence: { type: 'number' },
          durationSec: { type: 'number' },
          audioPath: { type: 'string' },
          asrBackend: { type: 'string' },
        },
        additionalProperties: false,
      },
      render: (_args: unknown, value: any) => [{
        type: 'text',
        text: `【语音转写】\n${value.transcript}\n\n【AI 增强扩充】\n${value.enhanced || '（未启用增强）'}\n\n总结：${value.summary || '无'}\n录音时长 ${value.durationSec}s · 识别后端 ${value.asrBackend} · 音频 ${value.audioPath}`,
      }],
    },
    timeoutMs: 360000,
    isConcurrencySafe: () => false,
    async execute(args: any, exec: any) {
      return await engine.listen(args, exec.signal)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'voice_ask',
    description: '用 TTS 向用户语音提问，录制用户的语音回答并转文字（可 LLM 增强）。用于语音双向对话：agent 边问边编程。',
    parameters: {
      question: { type: 'string', required: true, description: '要朗读给用户的问题' },
      language: { type: 'string', description: '识别语言，默认取配置 asr.language' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          question: { type: 'string' },
          answer: { type: 'string' },
          enhancedAnswer: { type: 'string' },
          confidence: { type: 'number' },
          durationSec: { type: 'number' },
        },
        additionalProperties: false,
      },
      render: (_args: unknown, value: any) => [{
        type: 'text',
        text: `问题：${value.question}\n回答：${value.answer}\n增强：${value.enhancedAnswer || '（未启用）'}`,
      }],
    },
    timeoutMs: 360000,
    isConcurrencySafe: () => false,
    async execute(args: any, exec: any) {
      return await engine.ask(args, exec.signal)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'voice_transcribe',
    description: '把本地音频文件（wav/aiff/m4a/mp3）转成文字，可选 LLM 增强扩充总结。用于处理用户已有的音频材料。',
    parameters: {
      filePath: { type: 'string', required: true, description: '音频文件绝对路径' },
      language: { type: 'string', description: '识别语言，默认取配置 asr.language' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          enhanced: { type: 'string' },
          summary: { type: 'string' },
          confidence: { type: 'number' },
          backend: { type: 'string' },
          language: { type: 'string' },
        },
        additionalProperties: false,
      },
      render: (_args: unknown, value: any) => [{
        type: 'text',
        text: `转写：${value.text}\n\n增强：${value.enhanced || '（未启用增强）'}\n\n总结：${value.summary || '无'}`,
      }],
    },
    timeoutMs: 600000,
    async execute(args: any, exec: any) {
      return await engine.transcribeFile(args.filePath, args.language, exec.signal)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'voice_status',
    description: '报告语音插件状态：平台、录音后端、ASR 提供方与可用性、LLM 增强配置、录音参数。用于排查语音功能不可用的问题。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          platform: { type: 'string' },
          recorder: { type: 'object', properties: { backend: { type: 'string' }, available: { type: 'boolean' }, nativeBinary: { type: 'boolean' } }, additionalProperties: false },
          asr: { type: 'object', properties: { provider: { type: 'string' }, available: { type: 'boolean' }, language: { type: 'string' } }, additionalProperties: false },
          enhance: { type: 'object', properties: { enabled: { type: 'boolean' }, provider: { type: 'string' }, model: { type: 'string' }, resolved: { type: 'boolean' } }, additionalProperties: false },
          client: { type: 'object', properties: { fillMode: { type: 'string' }, maxDurationSec: { type: 'number' }, silenceStopSec: { type: 'number' }, silenceThresholdDb: { type: 'number' } }, additionalProperties: false },
        },
        additionalProperties: false,
      },
      render: (_args: unknown, value: any) => [{
        type: 'text',
        text: `平台 ${value.platform} · 录音后端 ${value.recorder.backend}（可用 ${value.recorder.available}，原生二进制 ${value.recorder.nativeBinary}）\nASR ${value.asr.provider}（可用 ${value.asr.available}，语言 ${value.asr.language}）\nLLM 增强 ${value.enhance.enabled}（provider ${value.enhance.provider || 'auto'} / model ${value.enhance.model || 'auto'}）`,
      }],
    },
    timeoutMs: 30000,
    async execute() {
      return await engine.status()
    },
  }))

  ctx.logger?.info?.('[dsh-voice] 插件已加载：语音 UI 端点 /voice/transcribe、/voice/status + 工具 voice_listen/voice_ask/voice_transcribe/voice_status')
}