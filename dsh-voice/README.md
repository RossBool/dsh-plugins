# dsh-voice — 语音输入插件（客户端 UI + 实时转写 + 录音转文字）

给 DeepSeek Harness 的 Web GUI 加上**麦克风按钮**：点击说话 → 浏览器原生录音（系统麦克风）→ **实时转写（边说边出字，native 流式识别）** → 结束后把**原始识别文本原样填入**输入框，实现「agent voice 编程」。

## 功能

**客户端 UI（输入框右侧麦克风按钮）**
- 点击开始录音，**再次点击才结束**（默认禁用静音自动停止 `client.silenceStopSec: 0`，只有手动关闭；`maxDurationSec` 秒硬上限兜底，UI 显示"最长 M:SS"）
- 实时电平指示（红点脉冲 + 底部电平条）、录音计时
- 录音过程中通过 WebSocket（`/voice/live`）把 16kHz PCM 实时上传，native 后端流式识别并**实时回传转写文字**（录音卡片内实时预览）
- 识别结束后把**原始识别文本原样填入**输入框（默认 `client.fillMode: transcript`；WS 不可用时自动降级为录完一次性上传）
- **术语纠偏**（`asr.correction`，默认开启）：转写后把 ASR 的谐音误识别替换为标准拼写（如「道可」→ Docker、「派森」→ Python、「金仓」→ Git），确定性替换、不调 LLM、不改句子结构、实时与一次性路径一致
- 结果提示（info/error）通过输入框 notice 展示

**宿主服务（HTTP/WS 端点）**
- `POST /voice/transcribe`：multipart 上传音频 → 转文字，返回 `{ ok, text, confidence, backend }`（LLM 增强默认关闭，`text` 为原始识别结果）
- `GET /voice/status`：后端/ASR/增强状态与客户端参数
- `WS /voice/live?lang=…`：实时转写。客户端上行二进制 16kHz 16-bit mono PCM 块，文本 `end` 结束；服务端下行 `{"type":"partial","text":…}` / `{"type":"final","text":…,"confidence":…}` / `{"type":"error","message":…}`

**Agent 语音工具（agent 可调用，语音双向对话）**
- `voice_listen`：提示音 + TTS 提示 → 系统原生麦克风录音 → 转写，**原样返回识别结果**（不再套固定模板，默认不做 LLM 增强）
- `voice_ask`：TTS 提问 → 录制语音回答 → 转写，原样返回
- `voice_transcribe`：转写本地音频文件（wav/aiff/m4a/mp3，自动归一化 16kHz）
- `voice_status`：语音能力状态检查

## 英文识别的两条处理路径

语音转文字按识别语言自动分流，英文**不做翻译**：

1. **英文直接识别输出**（默认）：`asr.language` 设为 `en-US`（或工具 `language` 参数传 `en-US`）→ 用英文识别器直接识别英文 → **只做英文拼写/大小写规范化**（如 `Doker`→`Docker`、`python`→`Python`），**不做中文谐音「翻译」**，原样输出识别结果。
2. **英文 AI 增强**：在路径 1 基础上开启 `enhance.enabled: true` → 调用 LLM 对英文转写做**润色、补全、优化表达**（修正语法/标点、补全残缺句、让表达更自然专业），保持原意，输出增强后的英文文本。

**发音相近替代纠偏**（第三类识别错误）：ASR 会把词汇表外的领域专有名词识别成发音相近的常见词/缩写（拼写差异大，编辑距离失效）——如「DeepSeek」→ `DC`、「Harness」→ `Honey`。这类错误通过 `terms.ts` 内置的 `EN_MISCORRECTION` 精确映射纠正（`dc`→`DeepSeek`、`honey`→`Harness`），并扩充了 DSH 生态专有名词词库（Harness/Cordis/Schemastery/Cosmokit/Typert）；AI 增强路径的 prompt 也会据上下文二次纠偏。

中文（`zh-*`）路径保持原有行为：谐音纠偏（「道可」→ Docker）+ 结构化编程任务增强。

## 架构

```
浏览器 (client.tsx)
  getUserMedia + AudioWorklet → 16-bit PCM（JS 编码）
        │  录音中实时：重采样 16kHz → WS /voice/live 上行
        │  结束后：end → 收 final 原样填入输入框
        ▼
宿主插件 (src/index.ts, WS /voice/live)
        │  spawn voicekit stream（stdin 管道）
        ▼
macOS 原生流式识别（SFSpeechAudioBufferRecognitionRequest）
  实时 partial/final JSON lines → 服务端转发给客户端
        ▼
客户端实时预览 → 结束原样填入输入框 → 发送给 agent
```

macOS 的 `native` 后端使用自带 Swift helper（`src/swift/voicekit.swift`，运行时自动用 `swiftc` 编译）：
`record` 用 AVAudioEngine 录硬件格式（不丢帧）→ 整体转码 16kHz 单声道 16-bit WAV；`transcribe` 用 SFSpeechRecognizer 文件级转写；
`stream` 从 stdin 收 16kHz PCM 实时流式识别（支持 zh-CN/en-US…）。
无需安装 ffmpeg/sox，无需下载模型，无需 API Key（转写离线可用；增强走已配置的 DeepSeek 模型，默认关闭）。

## 安装

已在当前机器的 web profile 安装完成：

```sh
dsh plugin --profile web add /Users/zhoujunren/Code/LocalCode/dsh-voice
```

（等价改动：profile `package.json` 增加 `"dsh-voice": "link:…"` 依赖 + `dsh.profile.bundles` 追加 `"dsh-voice"`）

## 启用（重要）

**重启 dsh web 后生效**（当前运行的 GUI 不会热加载新组合包）：

```sh
# 停止当前 dsh web，然后
dsh web
```

刷新浏览器页面（127.0.0.1:3080），输入框右侧出现麦克风按钮。

## 使用

1. 点击输入框右侧 🎤 按钮，开始说话（首次会弹出系统麦克风授权，请在 系统设置 → 隐私与安全性 → 麦克风 中允许）
2. 说完**再次点击按钮结束录音**（默认不自动停止；录音卡片会实时显示转写文字）
3. 等待「识别中…」转圈结束，**原始识别文本**自动填入输入框，点发送

首次使用 `native` 转写会弹出「语音识别」权限请求，允许即可。

## 配置

在 profile 的 `cordis.patch.yml` 覆盖（按 id 覆盖整行 config）：

```yaml
- id: voice
  config:
    record:
      backend: native        # auto | native | ffmpeg | sox | arecord | powershell
      maxDurationSec: 60
      silenceStopSec: 1.6    # 静音自动停止秒数
      silenceThresholdDb: -40
    asr:
      provider: native       # auto | native | http | whisper-cli（实时转写仅 native 支持，其余后端自动降级为录完上传）
      language: zh-CN        # 识别语言；英文场景设 en-US（英文直接识别，不做谐音翻译）
      http:                  # OpenAI 兼容 /audio/transcriptions
        baseURL: https://api.openai.com/v1
        apiKey: ''
        model: whisper-1
      whisperCli:
        command: whisper-cli -m {model} -f {file} -l {language} --no-timestamps --output-txt
        model: ''
      correction:
        enabled: true        # 术语纠偏。英文（en-*）只做拼写/大小写规范化；中文（zh-*）做谐音翻译 + 拼写纠错
        terms: {}            # 自定义扩展 {误识别: 标准拼写}；内置表见 src/terms.ts（编程语境，个别词如「卡夫卡→Kafka」有极低误伤，可在此覆盖或整体关闭）
    enhance:
      enabled: false         # LLM 增强。默认关闭 = 原样输出。英文（en-*）→ 润色/补全/优化表达；中文（zh-*）→ 结构化编程任务。provider/model 留空 = 用设置里的默认模型
      language: zh
    tts:
      enabled: true          # voice_listen / voice_ask 的语音提示
      beep: true
    client:
      fillMode: transcript   # transcript（默认，原样识别文本）| enhanced（需开启 enhance）
      maxDurationSec: 300    # 录音硬上限（防呆；默认 300s，仅手动关闭，除非达到该上限）
      silenceStopSec: 0      # 0 = 禁用静音自动停止（默认，只有手动关闭）；>0 = 停顿 N 秒自动停止
      silenceThresholdDb: -40
      maxAudioBytes: 26214400
      allowedOrigins: []     # 额外的跨域白名单（默认仅回环地址）
```

> 说明：`record.silenceStopSec`（服务端录音，voice_listen/voice_ask 用）默认 1.6s，保留静音自动停止——那是 agent 无人值守驱动、没有"手动关闭"按钮的场景，靠停顿收尾；GUI 麦克风按钮（`client.silenceStopSec`）默认 0，完全手动控制。
>
> 说明 2：实时转写（`/voice/live`）只回传原始识别文本（`transcript`）；`fillMode: enhanced` 仅在「降级为录完上传」路径生效。`arecord`/`powershell` 后端不支持静音自动停止（只按 `-d` 时长录满），如需 VAD 请用 native/ffmpeg。

## 测试端点

```sh
curl http://127.0.0.1:3099/voice/status   # 或 3080（重启后）
curl -F "file=@test.wav;type=audio/wav" -F "language=zh-CN" http://127.0.0.1:3080/voice/transcribe
# 实时转写（WebSocket）：上行 16kHz 16-bit mono PCM 块，下行 partial/final JSON
node -e '
const fs=require("fs");
const ws=new WebSocket("ws://127.0.0.1:3080/voice/live?lang=zh-CN");
const pcm=fs.readFileSync("/tmp/t16.pcm");
ws.onopen=()=>{for(let i=0;i<pcm.length;i+=8000)ws.send(pcm.subarray(i,i+8000));ws.send("end")};
ws.onmessage=e=>console.log(e.data);
'
```

## 开发

```sh
npm install                 # esbuild + 运行时依赖（cordis/dsh-tools/dsh-llm/schemastery）
node build-client.mjs       # 重建 dist/client.js（改 client.tsx 后必须重建并重启 dsh web）
# 快速冒烟（不碰主 GUI）：
dsh --profile web --patch ./test-patch.yml --port 3099   # 仅宿主插件
```

宿主插件（src/index.ts）是 strip-only TypeScript，被 loader 直接加载；修改后重启 dsh 生效。
客户端 bundle 修改后需 `node build-client.mjs` 重建 + 重启 dsh web + 浏览器刷新。

## 隐私与安全

- native 转写走 macOS Speech framework：**优先 on-device 离线识别，但部分机型/语言不支持 on-device 时会回退到 Apple 服务器识别（音频可能离开本机）**；如需严格离线，可在系统设置中关闭联网识别，或改用 whisper-cli 本地模型
- 录音音频临时文件用完即删（启动时会清理 24h 以上的残留）；LLM 增强只发送转写文本
- `/voice/transcribe` 仅限回环地址（同源校验，跨站 origin 拒绝）；`/voice/live` 校验 WebSocket 握手与 Origin
- 若用 http/whisper-cli 后端，音频会发送到对应服务端点
