# dsh-voice — 语音输入插件（客户端 UI + 录音转文字 + AI 增强）

给 DeepSeek Harness 的 Web GUI 加上**麦克风按钮**：点击说话 → 浏览器原生录音（系统麦克风）→ 语音转文字 → **LLM 修正/扩充/总结** → 自动填入输入框，实现「agent voice 编程」。

## 功能

**客户端 UI（输入框右侧麦克风按钮）**
- 点击开始录音，再次点击（或静音 `silenceStopSec` 秒）自动停止
- 实时电平指示（红点脉冲 + 底部电平条）、录音计时
- 静音自动停止（VAD），最长 `maxDurationSec` 秒
- 识别结果自动填入输入框；默认填入 **AI 增强后的结构化指令**（`client.fillMode: enhanced`，可改 `transcript` 填原始转写）
- 结果提示（info/error）通过输入框 notice 展示

**宿主服务（HTTP 端点）**
- `POST /voice/transcribe`：multipart 上传音频 → 转文字（+ 可选 LLM 增强扩充总结），返回 `{ ok, text, enhanced, summary, confidence, backend }`
- `GET /voice/status`：后端/ASR/增强状态与客户端参数

**Agent 语音工具（agent 可调用，语音双向对话）**
- `voice_listen`：提示音 + TTS 提示 → 系统原生麦克风录音 → 转写 → LLM 增强扩充总结
- `voice_ask`：TTS 提问 → 录制语音回答 → 转写（+增强）
- `voice_transcribe`：转写本地音频文件（wav/aiff/m4a/mp3，自动归一化 16kHz）
- `voice_status`：语音能力状态检查

## 架构

```
浏览器 (client.tsx)
  getUserMedia + ScriptProcessor → 16-bit PCM WAV（JS 编码）
        │  POST multipart
        ▼
宿主插件 (src/index.ts, /voice/transcribe)
        │
        ├─ ASR：native(macOS Speech framework, 免配置离线可用) / http(OpenAI 兼容) / whisper-cli
        ▼
LLM 增强 (ctx.llm，走 harness 当前模型)：修正谐音/术语错误 → 结构化任务 → 一句话总结
        ▼
客户端填入输入框 → 发送给 agent
```

macOS 的 `native` 后端使用自带 Swift helper（`src/swift/voicekit.swift`，运行时自动用 `swiftc` 编译）：
AVAudioEngine 录硬件格式（不丢帧）→ 整体转码 16kHz 单声道 16-bit WAV → SFSpeechRecognizer 转写（支持 zh-CN/en-US…）。
无需安装 ffmpeg/sox，无需下载模型，无需 API Key（转写离线可用；增强走已配置的 DeepSeek 模型）。

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
2. 说完停顿约 1.6 秒自动停止（或再点一次）
3. 等待「识别中…」转圈结束，结构化指令自动填入输入框，点发送

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
      provider: native       # auto | native | http | whisper-cli
      language: zh-CN
      http:                  # OpenAI 兼容 /audio/transcriptions
        baseURL: https://api.openai.com/v1
        apiKey: ''
        model: whisper-1
      whisperCli:
        command: whisper-cli -m {model} -f {file} -l {language} --no-timestamps --output-txt
        model: ''
    enhance:
      enabled: true          # LLM 修正/扩充/总结；provider/model 留空 = 用设置里的默认模型
      language: zh
    tts:
      enabled: true          # voice_listen / voice_ask 的语音提示
      beep: true
    client:
      fillMode: enhanced     # enhanced | transcript
      maxDurationSec: 60
      silenceStopSec: 1.6
      silenceThresholdDb: -40
      maxAudioBytes: 26214400
      allowedOrigins: []     # 额外的跨域白名单（默认仅回环地址）
```

## 测试端点

```sh
curl http://127.0.0.1:3099/voice/status   # 或 3080（重启后）
curl -F "file=@test.wav;type=audio/wav" -F "language=zh-CN" http://127.0.0.1:3080/voice/transcribe
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

- 录音音频仅在本机处理：native 转写走 macOS 本地 Speech；上传走 /voice/transcribe 仅限回环地址（同源校验，跨站 origin 拒绝）
- 音频临时文件用完即删；LLM 增强只发送转写文本
- 若用 http/whisper-cli 后端，音频会发送到对应服务端点
- `asr.http.apiKey` 以明文持久化在插件配置（settings.yaml），请留意文件权限
- whisper-cli 后端已改为**无 shell 的 argv 执行**，并对 `language` 做白名单校验，杜绝命令注入
