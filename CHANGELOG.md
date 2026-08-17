# Changelog

本仓库所有值得注意的变更记录于此。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### dsh-voice

#### Added
- 流式实时转写（`WS /voice/live` 端点）：浏览器录音时实时上传 16kHz PCM，macOS native 后端流式识别，边说边出字，实时写入输入框（不再悬浮卡片展示）。
- Swift 新增 `stream` 子命令：stdin PCM → `SFSpeechRecognizer` 流式识别，实时输出 partial/final JSON。
- 术语纠偏（`asr.correction`）三层：中文谐音映射（`道可`→Docker）、英文拼写规范化（`Doker`→Docker）、发音相近替代纠偏（`DC`→DeepSeek、`Honey`→Harness）。
- 英文直接识别 + AI 增强两条处理路径：英文（`en-*`）不做谐音翻译，原样输出；开启 `enhance` 后走 LLM 润色/补全/优化表达。
- AI 润色后处理（`enhance.mode: polish`，默认）：语音识别出原始文字稿后，调用 LLM 去口语化/口头禅/冗余词（呃/就是/之类的）+ 修补语病 + 增强流畅与逻辑，保留原意输出规范文本；确定性预过滤（`stripInterjections`）先删纯语气字，语义级冗余交 LLM。

#### Changed
- 录音默认仅手动关闭（`client.silenceStopSec: 0`，禁用静音自动停止），`maxDurationSec` 兜底。
- 语音工具（`voice_listen`/`voice_ask`/`voice_transcribe`）输出改为原样识别结果，`enhance` 默认关闭。

#### Fixed
- 发音相近替代识别错误：ASR 把「DeepSeek」识别成「DC」、「Harness」识别成「Honey」。
- WebSocket 安全与生命周期：握手校验、帧长/并发上限、空闲超时、AbortSignal 预中止、断连自动降级、live 会话泄漏。
- 录音中途输入框卡住：英文词级 partial 高频 `setDraft` 打爆输入状态机/React 重渲染，改为 150ms trailing 节流 + 录音结束停止 partial 写入（final 独占）。

#### Security
- `/voice/live` 增加 Origin/握手（Upgrade/Version/Key）校验、帧长上限（8MB）、并发进程上限、客户端掩码校验。

## [0.1.0] - 2026-08-16

### Added
- 初始化 `dsh-plugins` monorepo，收录协作编排、跨会话、团队模式、话题时间轴、语音、MCP 管理、提示词增强等一批 DSH 插件。
- 为 8 个插件补充 README。

### Security
- 修复审计发现的命令注入与端点防护，补安全说明。
- `mcp-demo-server` 开发脚本去除硬编码个人绝对路径。
