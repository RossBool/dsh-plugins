// dsh-voice VoiceKit — macOS 原生录音 + 语音识别 helper
// 用法:
//   voicekit record --out <wav> --seconds <n> [--silence <s>] [--threshold <dB>] [--rate <hz>]
//   voicekit transcribe --in <audio> --lang <locale>
//   voicekit devices
// 输出: 一行 JSON 到 stdout。

import Foundation
import AVFoundation
import Speech

struct CliError: Error { let message: String }

func log(_ obj: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: obj, options: []),
       let text = String(data: data, encoding: .utf8) {
        FileHandle.standardOutput.write((text + "\n").data(using: .utf8)!)
    }
}

func fail(_ message: String) -> Never {
    log(["ok": false, "error": message])
    exit(1)
}

func parseArgs() -> [String: String] {
    var out: [String: String] = [:]
    let a = CommandLine.arguments
    var i = 2
    while i < a.count {
        let key = a[i]
        if key.hasPrefix("--"), i + 1 < a.count {
            out[String(key.dropFirst(2))] = a[i + 1]
            i += 2
        } else {
            i += 1
        }
    }
    return out
}

// MARK: - 麦克风权限 (macOS 原生 TCC 弹窗)

func ensureMicPermission() throws {
    let sem = DispatchSemaphore(value: 0)
    var granted = false
    if #available(macOS 14.0, *) {
        AVAudioApplication.requestRecordPermission { ok in
            granted = ok
            sem.signal()
        }
    } else {
        AVCaptureDevice.requestAccess(for: .audio) { ok in
            granted = ok
            sem.signal()
        }
    }
    _ = sem.wait(timeout: .now() + 60)
    guard granted else {
        throw CliError(message: "麦克风权限被拒绝。请在 系统设置 → 隐私与安全性 → 麦克风 中为运行 dsh 的应用开启权限后重试。")
    }
}

// MARK: - 录音 (AVAudioEngine → 16kHz 单声道 16-bit WAV)

func record(_ args: [String: String]) {
    guard let out = args["out"] else { fail("record 缺少 --out") }
    let maxSeconds = Double(args["seconds"] ?? "60") ?? 60
    let silenceStop = Double(args["silence"] ?? "1.6") ?? 1.6
    let thresholdDb = Double(args["threshold"] ?? "-40") ?? -40
    let sampleRate = Double(args["rate"] ?? "16000") ?? 16000

    do {
        try ensureMicPermission()
        let engine = AVAudioEngine()
        let input = engine.inputNode
        let hwFormat = input.inputFormat(forBus: 0)
        guard let targetFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32,
                                               sampleRate: sampleRate,
                                               channels: 1,
                                               interleaved: false) else {
            fail("无法创建目标音频格式")
        }
        // 两段式：tap 用硬件格式录到临时文件（无丢帧），结束后整体转码为 16kHz 单声道
        let tmpUrl = URL(fileURLWithPath: out + ".raw.wav")
        let tmpSettings: [String: Any] = [
            AVFormatIDKey: kAudioFormatLinearPCM,
            AVSampleRateKey: hwFormat.sampleRate,
            AVNumberOfChannelsKey: hwFormat.channelCount,
            AVLinearPCMBitDepthKey: 16,
            AVLinearPCMIsFloatKey: false,
            AVLinearPCMIsBigEndianKey: false
        ]
        var file: AVAudioFile? = try AVAudioFile(forWriting: tmpUrl, settings: tmpSettings,
                                   commonFormat: .pcmFormatFloat32, interleaved: false)
        let thresholdLinear = pow(10.0, thresholdDb / 20.0)
        let start = Date()
        var lastVoice = Date()
        var startedVoice = false
        var peakDb: Float = -120
        let minDuration = 0.6
        var stopRequested = false
        let queue = DispatchQueue(label: "dsh-voice.record")

        input.installTap(onBus: 0, bufferSize: 1024, format: hwFormat) { buffer, _ in
            guard let channel = buffer.floatChannelData?[0] else { return }
            let n = Int(buffer.frameLength)
            guard n > 0 else { return }
            var sum: Float = 0
            for i in 0..<n {
                let v = channel[i]
                sum += v * v
            }
            let rms = sqrt(sum / Float(n))
            let rmsDb = 20 * log10(max(rms, 1e-9))
            if rmsDb > peakDb { peakDb = rmsDb }
            let now = Date()
            if rms > Float(thresholdLinear) {
                if !startedVoice { startedVoice = true }
                lastVoice = now
            }
            do { try file?.write(from: buffer) } catch {}
            let elapsed = now.timeIntervalSince(start)
            let silence = now.timeIntervalSince(lastVoice)
            let stop = (elapsed >= maxSeconds)
                || (startedVoice && elapsed >= minDuration && silence >= silenceStop)
            if stop && !stopRequested {
                stopRequested = true
                queue.async {
                    input.removeTap(onBus: 0)
                    engine.stop()
                }
            }
        }

        engine.connect(input, to: engine.mainMixerNode, format: hwFormat)
        engine.prepare()
        try engine.start()
        while engine.isRunning {
            RunLoop.main.run(until: Date(timeIntervalSinceNow: 0.05))
        }
        let seconds = Date().timeIntervalSince(start)
        let hasSignal = startedVoice
        // 释放写入句柄，确保缓冲落盘后再读取转码
        file = nil

        // —— 整体转码: tmp(硬件格式) → out(16kHz 单声道 16bit) ——
        let srcFile = try AVAudioFile(forReading: tmpUrl)
        let srcFormat = srcFile.processingFormat
        let dstFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32,
                                      sampleRate: sampleRate,
                                      channels: 1,
                                      interleaved: false)!
        let dstSettings: [String: Any] = [
            AVFormatIDKey: kAudioFormatLinearPCM,
            AVSampleRateKey: sampleRate,
            AVNumberOfChannelsKey: 1,
            AVLinearPCMBitDepthKey: 16,
            AVLinearPCMIsFloatKey: false,
            AVLinearPCMIsBigEndianKey: false
        ]
        let dstFile = try AVAudioFile(forWriting: URL(fileURLWithPath: out), settings: dstSettings)
        let converter = AVAudioConverter(from: srcFormat, to: dstFormat)!
        let cap: AVAudioFrameCount = 16384
        guard let inputBuf = AVAudioPCMBuffer(pcmFormat: srcFormat, frameCapacity: cap),
              let outputBuf = AVAudioPCMBuffer(pcmFormat: dstFormat, frameCapacity: cap) else {
            fail("无法分配转码缓冲")
        }
        while true {
            var convErr: NSError?
            outputBuf.frameLength = 0
            let status = converter.convert(to: outputBuf, error: &convErr) { _, outStatus in
                do {
                    try srcFile.read(into: inputBuf)
                } catch {
                    inputBuf.frameLength = 0
                }
                outStatus.pointee = inputBuf.frameLength == 0 ? .endOfStream : .haveData
                return inputBuf
            }
            if convErr != nil { fail("转码失败: \(convErr!.localizedDescription)") }
            if outputBuf.frameLength > 0 { try dstFile.write(from: outputBuf) }
            if status == .endOfStream || status == .error { break }
        }
        try? FileManager.default.removeItem(at: tmpUrl)
        log(["ok": true, "file": out, "seconds": Double(round(seconds * 100) / 100),
             "peakDb": Double(round(peakDb * 10) / 10), "speechDetected": hasSignal])
    } catch {
        fail("录音失败: \(error.localizedDescription)")
    }
}

// MARK: - 语音识别 (Speech framework)

func transcribe(_ args: [String: String]) {
    guard let inputFile = args["in"] else { fail("transcribe 缺少 --in") }
    let lang = args["lang"] ?? "zh-CN"
    let onDeviceOnly = (args["on-device"] ?? "false") == "true"

    guard FileManager.default.fileExists(atPath: inputFile) else {
        fail("音频文件不存在: \(inputFile)")
    }
    guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: lang)) else {
        fail("当前系统不支持该语音识别语言: \(lang)（macOS 需要下载对应语音包）")
    }
    if recognizer.supportsOnDeviceRecognition {
        recognizer.supportsOnDeviceRecognition = true
    }
    recognizer.defaultTaskHint = .dictation

    let sem = DispatchSemaphore(value: 0)
    var status: SFSpeechRecognizerAuthorizationStatus = .notDetermined
    SFSpeechRecognizer.requestAuthorization { s in
        status = s
        sem.signal()
    }
    _ = sem.wait(timeout: .now() + 60)
    guard status == .authorized else {
        fail("语音识别权限未授权（状态: \(status.rawValue)）。请在 系统设置 → 隐私与安全性 → 语音识别 中授权。")
    }

    // 归一化：非 16kHz 单声道的输入先转码为临时 16kHz WAV
    var url = URL(fileURLWithPath: inputFile)
    var tmpConv: URL?
    do {
        let probe = try AVAudioFile(forReading: url)
        let fmt = probe.processingFormat
        if fmt.sampleRate != 16000 || fmt.channelCount != 1 {
            let dstUrl = URL(fileURLWithPath: inputFile + ".16k.wav")
            let dstFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16000, channels: 1, interleaved: false)!
            let dstSettings: [String: Any] = [
                AVFormatIDKey: kAudioFormatLinearPCM,
                AVSampleRateKey: 16000,
                AVNumberOfChannelsKey: 1,
                AVLinearPCMBitDepthKey: 16,
                AVLinearPCMIsFloatKey: false,
                AVLinearPCMIsBigEndianKey: false
            ]
            let dstFile = try AVAudioFile(forWriting: dstUrl, settings: dstSettings)
            let converter = AVAudioConverter(from: fmt, to: dstFormat)!
            let cap: AVAudioFrameCount = 16384
            guard let inBuf = AVAudioPCMBuffer(pcmFormat: fmt, frameCapacity: cap),
                  let outBuf = AVAudioPCMBuffer(pcmFormat: dstFormat, frameCapacity: cap) else {
                fail("无法分配转码缓冲")
            }
            while true {
                var convErr: NSError?
                outBuf.frameLength = 0
                let st = converter.convert(to: outBuf, error: &convErr) { _, outStatus in
                    do { try probe.read(into: inBuf) } catch { inBuf.frameLength = 0 }
                    outStatus.pointee = inBuf.frameLength == 0 ? .endOfStream : .haveData
                    return inBuf
                }
                if convErr != nil { fail("音频转码失败: \(convErr!.localizedDescription)") }
                if outBuf.frameLength > 0 { try dstFile.write(from: outBuf) }
                if st == .endOfStream || st == .error { break }
            }
            url = dstUrl
            tmpConv = dstUrl
        }
    } catch {
        fail("无法读取音频文件: \(error.localizedDescription)")
    }
    let request = SFSpeechURLRecognitionRequest(url: url)
    request.shouldReportPartialResults = false
    if onDeviceOnly { request.requiresOnDeviceRecognition = true }

    var finalText = ""
    var confidence: Float = 0
    var errorMsg: String?
    var finished = false

    // 必须强引用 task，否则被 ARC 提前释放会导致识别中途截断
    var task: SFSpeechRecognitionTask?
    task = recognizer.recognitionTask(with: request) { result, error in
        if let r = result, r.isFinal {
            finalText = r.bestTranscription.formattedString
            var conf: Float = 0
            var count = 0
            for seg in r.bestTranscription.segments {
                conf += seg.confidence
                count += 1
            }
            if count > 0 { confidence = conf / Float(count) }
            finished = true
        } else if let error = error {
            errorMsg = error.localizedDescription
            finished = true
        }
    }
    // 泵 RunLoop 等待，避免阻塞主线程导致回调死锁
    let deadline = Date().addingTimeInterval(300)
    while !finished && Date() < deadline {
        RunLoop.main.run(until: Date(timeIntervalSinceNow: 0.05))
    }
    task = nil
    if !finished { fail("语音识别超时（300s）") }
    if let e = errorMsg { fail("语音识别失败: \(e)") }
    if let t = tmpConv { try? FileManager.default.removeItem(at: t) }
    let trimmed = finalText.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.isEmpty { fail("没有识别到语音内容（可能是录音为空或环境噪声）") }
    log(["ok": true, "text": trimmed, "confidence": Double(round(confidence * 1000) / 1000),
         "onDeviceCapable": recognizer.supportsOnDeviceRecognition])
}

// MARK: - 设备列表

func devices() {
    let session = AVCaptureDevice.DiscoverySession(
        deviceTypes: [.microphone],
        mediaType: .audio,
        position: .unspecified
    )
    var list: [[String: Any]] = []
    for d in session.devices {
        list.append([
            "name": d.localizedName,
            "id": d.uniqueID,
            "connected": d.isConnected
        ])
    }
    log(["ok": true, "devices": list])
}

// MARK: - main

let args = CommandLine.arguments
guard args.count >= 2 else {
    log(["ok": false, "error": "用法: voicekit <record|transcribe|devices> [--选项 ...]"])
    exit(1)
}
switch args[1] {
case "record": record(parseArgs())
case "transcribe": transcribe(parseArgs())
case "devices": devices()
default:
    log(["ok": false, "error": "未知子命令: \(args[1])"])
    exit(1)
}