// voice-aec-io.swift
// macOS VoiceProcessingIO 双向语音 sidecar：
// - 上行：麦克风经原生 AEC 后输出 PCM16@16k（带帧协议）
// - 下行：从 FIFO 接收 PCM16@24k，统一走 AVAudioEngine 播放，给 AEC 提供参考信号
// - stdin：clear / mute / unmute 控制；父进程退出导致 EOF 时立即退出

import Foundation
import AVFoundation

private let upstreamSampleRate: Double = 16_000
private let downstreamSampleRate: Double = 24_000
private let levelInterval: TimeInterval = 0.1

// 看门狗：连续这么久一帧不产就判定采集已死并写 error 帧。
// 选值理由：VPIO 冷启动到首帧实测 0.1–0.3s，实测两次「引擎自杀」发生在 start() 后 +0.32s/+0.38s，
// 自愈重建实测 <0.5s；4s 是正常首帧耗时的十倍以上（不会误杀），又远小于 Rust 侧 30s 启动超时
// （保证 host 拿到的是「明确的错误」而不是「超时」）。
private let frameStallTimeout: TimeInterval = 4
private let watchdogInterval: TimeInterval = 1
// 配置变更自愈的熔断：短窗内反复重建说明设备在抖，继续重试只会让用户听一段断续的假通话。
private let recoveryWindow: TimeInterval = 10
private let maxRecoveriesInWindow = 3

private enum OutputFrameKind: UInt8 {
    case audio = 1
    case levels = 2
    case ready = 3
    case error = 4
}

private enum VoiceAecError: Error, CustomStringConvertible {
    case invalidArguments
    case fifoOpenFailed(String)
    case audioFormatUnavailable

    var description: String {
        switch self {
        case .invalidArguments:
            return "usage: voice-aec-io --upstream-fifo <path> --downstream-fifo <path>"
        case .fifoOpenFailed(let path):
            return "failed to open FIFO: \(path)"
        case .audioFormatUnavailable:
            return "failed to create PCM audio format"
        }
    }
}

private struct Arguments {
    let upstreamFifo: String
    let downstreamFifo: String

    static func parse(_ raw: [String]) throws -> Arguments {
        var upstream: String?
        var downstream: String?
        var index = 1
        while index < raw.count {
            switch raw[index] {
            case "--upstream-fifo" where index + 1 < raw.count:
                upstream = raw[index + 1]
                index += 2
            case "--downstream-fifo" where index + 1 < raw.count:
                downstream = raw[index + 1]
                index += 2
            default:
                throw VoiceAecError.invalidArguments
            }
        }
        guard let upstream, let downstream else {
            throw VoiceAecError.invalidArguments
        }
        return Arguments(upstreamFifo: upstream, downstreamFifo: downstream)
    }
}

private final class VoiceAecIO {
    private let engine = AVAudioEngine()
    private let player = AVAudioPlayerNode()
    private let upstream: FileHandle
    private let downstream: FileHandle
    private let upstreamFormat: AVAudioFormat
    private let downstreamFormat: AVAudioFormat
    private var converter: AVAudioConverter?

    private let writeLock = NSLock()
    private let stateLock = NSLock()
    private var muted = false
    private var playbackLevel: Float = 0
    private var playbackUntil: TimeInterval = 0
    private var lastLevelAt: TimeInterval = 0
    private var stopped = false
    private var lastFrameAt: TimeInterval = 0
    private var readySent = false
    private var failed = false
    private var recoveryPending = false
    private var tapInstalled = false

    // 自愈与看门狗都跑在这条串行队列上：重建期间看门狗自然被挡住，不必再加一把锁。
    private let recoveryQueue = DispatchQueue(label: "voice-aec-io.recovery")
    private let recoveryQueueKey = DispatchSpecificKey<Void>()
    private var watchdogTimer: DispatchSourceTimer?
    private var configObserver: NSObjectProtocol?
    private var recoveryTimestamps: [TimeInterval] = []

    init(arguments: Arguments) throws {
        guard let upstream = FileHandle(forWritingAtPath: arguments.upstreamFifo) else {
            throw VoiceAecError.fifoOpenFailed(arguments.upstreamFifo)
        }
        guard let downstream = FileHandle(forReadingAtPath: arguments.downstreamFifo) else {
            try? upstream.close()
            throw VoiceAecError.fifoOpenFailed(arguments.downstreamFifo)
        }
        guard
            let upstreamFormat = AVAudioFormat(
                commonFormat: .pcmFormatInt16,
                sampleRate: upstreamSampleRate,
                channels: 1,
                interleaved: true
            ),
            let downstreamFormat = AVAudioFormat(
                commonFormat: .pcmFormatInt16,
                sampleRate: downstreamSampleRate,
                channels: 1,
                interleaved: true
            )
        else {
            try? upstream.close()
            try? downstream.close()
            throw VoiceAecError.audioFormatUnavailable
        }
        self.upstream = upstream
        self.downstream = downstream
        self.upstreamFormat = upstreamFormat
        self.downstreamFormat = downstreamFormat
        recoveryQueue.setSpecific(key: recoveryQueueKey, value: ())
    }

    func start() throws {
        try recoveryQueue.sync {
            let input = engine.inputNode
            let output = engine.outputNode

            engine.attach(player)
            engine.connect(player, to: engine.mainMixerNode, format: downstreamFormat)

            configObserver = NotificationCenter.default.addObserver(
                forName: .AVAudioEngineConfigurationChange,
                object: engine,
                queue: nil
            ) { [weak self] _ in
                self?.scheduleConfigurationRecovery()
            }

            // 两端必须同时进入 VoiceProcessingIO：输入负责采集，输出提供 AEC 参考信号。
            // 顺序不能反：必须先把播放图搭好再开 voice processing——先开 VP 会让输出单元
            // 在 24k 播放格式下 kAUInitialize 失败（-10875，本机可复现），图先行则正常。
            try input.setVoiceProcessingEnabled(true)
            try output.setVoiceProcessingEnabled(true)
            try rebuildInputAndStartEngine()
            startWatchdog()
        }

        startDownstreamReader()
        fputs("voice-aec-io: engine started; waiting for first capture frame\n", stderr)
    }

    func handle(command: String) {
        switch command.trimmingCharacters(in: .whitespacesAndNewlines) {
        case "clear":
            stateLock.lock()
            playbackLevel = 0
            playbackUntil = 0
            stateLock.unlock()
            player.stop()
            player.reset()
            if engine.isRunning {
                player.play()
            }
        case "mute":
            stateLock.lock()
            muted = true
            stateLock.unlock()
        case "unmute":
            stateLock.lock()
            muted = false
            stateLock.unlock()
        case "":
            break
        default:
            fputs("voice-aec-io: ignored unknown command '\(command)'\n", stderr)
        }
    }

    func stop() {
        stateLock.lock()
        if stopped {
            stateLock.unlock()
            return
        }
        stopped = true
        stateLock.unlock()

        runOnRecoveryQueueSync {
            stopWatchdog()
            removeConfigurationObserver()
            removeInputTap()
            player.stop()
            engine.stop()
        }
        try? upstream.close()
        try? downstream.close()
        fputs("voice-aec-io: stopped\n", stderr)
    }

    func reportStartupError(_ error: Error) {
        writeFrame(kind: .error, payload: Data(String(describing: error).utf8))
    }

    private func consumeInput(_ input: AVAudioPCMBuffer, converter: AVAudioConverter) {
        let ratio = upstreamSampleRate / input.format.sampleRate
        let capacity = max(1, AVAudioFrameCount(ceil(Double(input.frameLength) * ratio)) + 1)
        guard let output = AVAudioPCMBuffer(pcmFormat: upstreamFormat, frameCapacity: capacity) else {
            return
        }

        var supplied = false
        var conversionError: NSError?
        let status = converter.convert(to: output, error: &conversionError) { _, outputStatus in
            if supplied {
                outputStatus.pointee = .noDataNow
                return nil
            }
            supplied = true
            outputStatus.pointee = .haveData
            return input
        }
        guard status != .error, conversionError == nil, output.frameLength > 0 else {
            return
        }

        let byteCount = Int(output.frameLength) * MemoryLayout<Int16>.size
        guard let raw = output.audioBufferList.pointee.mBuffers.mData else {
            return
        }
        var pcm = Data(bytes: raw, count: byteCount)
        let micRms = rms(pcm)

        stateLock.lock()
        guard !stopped, !failed else {
            stateLock.unlock()
            return
        }
        let isMuted = muted
        let now = Date.timeIntervalSinceReferenceDate
        lastFrameAt = now
        let shouldSendReady = !readySent
        if shouldSendReady {
            readySent = true
        }
        if isMuted {
            pcm.resetBytes(in: 0..<pcm.count)
        }
        if now >= playbackUntil {
            playbackLevel = 0
        }
        let currentPlaybackLevel = playbackLevel
        let shouldReportLevel = now - lastLevelAt >= levelInterval
        if shouldReportLevel {
            lastLevelAt = now
        }
        stateLock.unlock()

        if shouldSendReady {
            writeFrame(kind: .ready, payload: Data("ready".utf8))
            fputs("voice-aec-io: capturing (first upstream frame produced)\n", stderr)
        }
        writeFrame(kind: .audio, payload: pcm)
        if shouldReportLevel {
            var mic = isMuted ? Float(0) : micRms
            var playback = currentPlaybackLevel
            let payload = withUnsafeBytes(of: &mic) { micBytes in
                withUnsafeBytes(of: &playback) { playbackBytes in
                    var data = Data(micBytes)
                    data.append(contentsOf: playbackBytes)
                    return data
                }
            }
            writeFrame(kind: .levels, payload: payload)
        }
    }

    private func rebuildInputAndStartEngine() throws {
        let input = engine.inputNode
        removeInputTap()
        engine.stop()

        let inputFormat = input.outputFormat(forBus: 0)
        guard let converter = AVAudioConverter(from: inputFormat, to: upstreamFormat) else {
            throw VoiceAecError.audioFormatUnavailable
        }
        // VoiceProcessingIO 可能在设备重构后从 1 声道变成 7 声道。AVAudioConverter
        // 无法自行推导 discrete → mono 的降混矩阵；显式保留第 0 路，避免恢复后恒静音。
        converter.channelMap = [0]
        self.converter = converter
        fputs(
            "voice-aec-io: input \(inputFormat.channelCount)ch@\(Int(inputFormat.sampleRate))Hz channelMap=\(converter.channelMap)\n",
            stderr
        )

        input.installTap(onBus: 0, bufferSize: 1024, format: inputFormat) { [weak self, converter] buffer, _ in
            self?.consumeInput(buffer, converter: converter)
        }
        tapInstalled = true

        engine.prepare()
        try engine.start()
        if !player.isPlaying {
            player.play()
        }

        stateLock.lock()
        lastFrameAt = Date.timeIntervalSinceReferenceDate
        stateLock.unlock()
    }

    private func scheduleConfigurationRecovery() {
        stateLock.lock()
        guard !stopped, !failed, !recoveryPending else {
            stateLock.unlock()
            return
        }
        recoveryPending = true
        stateLock.unlock()

        recoveryQueue.async { [weak self] in
            self?.recoverFromConfigurationChange()
        }
    }

    private func recoverFromConfigurationChange() {
        stateLock.lock()
        guard !stopped, !failed else {
            recoveryPending = false
            stateLock.unlock()
            return
        }
        stateLock.unlock()

        let now = Date.timeIntervalSinceReferenceDate
        recoveryTimestamps.removeAll { now - $0 > recoveryWindow }
        guard recoveryTimestamps.count < maxRecoveriesInWindow else {
            stateLock.lock()
            recoveryPending = false
            stateLock.unlock()
            failLoud("AEC_CONFIG_CHANGE_LOOP")
            return
        }
        recoveryTimestamps.append(now)

        fputs(
            "voice-aec-io: configuration changed; rebuilding capture (\(recoveryTimestamps.count)/\(maxRecoveriesInWindow))\n",
            stderr
        )
        do {
            try rebuildInputAndStartEngine()
            fputs("voice-aec-io: configuration recovery restarted engine\n", stderr)
        } catch {
            stateLock.lock()
            recoveryPending = false
            stateLock.unlock()
            failLoud("AEC_CONFIG_RECOVERY_FAILED: \(error)")
            return
        }

        stateLock.lock()
        recoveryPending = false
        stateLock.unlock()
    }

    private func startWatchdog() {
        let timer = DispatchSource.makeTimerSource(queue: recoveryQueue)
        timer.schedule(
            deadline: .now() + watchdogInterval,
            repeating: watchdogInterval
        )
        timer.setEventHandler { [weak self] in
            self?.checkCaptureHealth()
        }
        watchdogTimer = timer
        timer.resume()
    }

    private func stopWatchdog() {
        watchdogTimer?.setEventHandler {}
        watchdogTimer?.cancel()
        watchdogTimer = nil
    }

    private func checkCaptureHealth() {
        stateLock.lock()
        let shouldFail = !stopped
            && !failed
            && Date.timeIntervalSinceReferenceDate - lastFrameAt >= frameStallTimeout
        stateLock.unlock()
        if shouldFail {
            failLoud("AEC_CAPTURE_STALLED")
        }
    }

    private func failLoud(_ reason: String) {
        stateLock.lock()
        guard !stopped, !failed else {
            stateLock.unlock()
            return
        }
        failed = true
        recoveryPending = false
        stateLock.unlock()

        fputs("voice-aec-io: fatal \(reason)\n", stderr)
        writeFrame(kind: .error, payload: Data(reason.utf8))
        stopWatchdog()
        removeConfigurationObserver()
        removeInputTap()
        player.stop()
        engine.stop()
    }

    private func removeInputTap() {
        if tapInstalled {
            engine.inputNode.removeTap(onBus: 0)
            tapInstalled = false
        }
        converter = nil
    }

    private func removeConfigurationObserver() {
        if let configObserver {
            NotificationCenter.default.removeObserver(configObserver)
            self.configObserver = nil
        }
    }

    private func runOnRecoveryQueueSync(_ work: () -> Void) {
        if DispatchQueue.getSpecific(key: recoveryQueueKey) != nil {
            work()
        } else {
            recoveryQueue.sync(execute: work)
        }
    }

    private func startDownstreamReader() {
        DispatchQueue.global(qos: .userInteractive).async { [weak self] in
            guard let self else { return }
            var pending = Data()
            do {
                while true {
                    let chunk = try self.downstream.read(upToCount: 8192) ?? Data()
                    if chunk.isEmpty {
                        self.stop()
                        exit(0)
                    }
                    pending.append(chunk)
                    let playableBytes = pending.count - (pending.count % MemoryLayout<Int16>.size)
                    if playableBytes == 0 { continue }
                    let pcm = pending.prefix(playableBytes)
                    pending.removeFirst(playableBytes)
                    self.schedulePlayback(Data(pcm))
                }
            } catch {
                self.reportStartupError(error)
                self.stop()
                exit(1)
            }
        }
    }

    private func schedulePlayback(_ pcm: Data) {
        guard !pcm.isEmpty else { return }
        let frameCount = AVAudioFrameCount(pcm.count / MemoryLayout<Int16>.size)
        guard let buffer = AVAudioPCMBuffer(pcmFormat: downstreamFormat, frameCapacity: frameCount),
              let target = buffer.audioBufferList.pointee.mBuffers.mData else {
            return
        }
        buffer.frameLength = frameCount
        pcm.copyBytes(to: target.assumingMemoryBound(to: UInt8.self), count: pcm.count)

        let level = rms(pcm)
        let now = Date.timeIntervalSinceReferenceDate
        stateLock.lock()
        playbackLevel = level
        playbackUntil = max(now, playbackUntil) + Double(frameCount) / downstreamSampleRate
        stateLock.unlock()

        player.scheduleBuffer(buffer)
    }

    private func rms(_ pcm: Data) -> Float {
        guard !pcm.isEmpty else { return 0 }
        return pcm.withUnsafeBytes { raw in
            let samples = raw.bindMemory(to: Int16.self)
            guard !samples.isEmpty else { return 0 }
            var sum: Double = 0
            for sample in samples {
                let value = Double(sample) / 32768.0
                sum += value * value
            }
            return Float(sqrt(sum / Double(samples.count)))
        }
    }

    private func writeFrame(kind: OutputFrameKind, payload: Data) {
        var frame = Data([kind.rawValue])
        var length = UInt32(payload.count).littleEndian
        withUnsafeBytes(of: &length) { frame.append(contentsOf: $0) }
        frame.append(payload)

        writeLock.lock()
        defer { writeLock.unlock() }
        do {
            try upstream.write(contentsOf: frame)
        } catch {
            stop()
            exit(0)
        }
    }
}

private let arguments: Arguments
do {
    arguments = try Arguments.parse(CommandLine.arguments)
} catch {
    fputs("voice-aec-io: \(error)\n", stderr)
    exit(2)
}

private let voiceIO: VoiceAecIO
do {
    voiceIO = try VoiceAecIO(arguments: arguments)
} catch {
    fputs("voice-aec-io: \(error)\n", stderr)
    exit(1)
}

func stopAndExit(_ code: Int32) {
    voiceIO.stop()
    exit(code)
}

func setupSignalHandler(_ signalNumber: Int32) {
    let source = DispatchSource.makeSignalSource(signal: signalNumber, queue: .main)
    source.setEventHandler {
        stopAndExit(0)
    }
    source.resume()
    signal(signalNumber, SIG_IGN)
}

setupSignalHandler(SIGINT)
setupSignalHandler(SIGTERM)
signal(SIGPIPE, SIG_IGN)

do {
    try voiceIO.start()
} catch {
    voiceIO.reportStartupError(error)
    fputs("voice-aec-io: failed to start: \(error)\n", stderr)
    stopAndExit(1)
}

// stdin 由 Rust 父进程持有；EOF 表示父进程已退出，sidecar 不得成为孤儿。
DispatchQueue.global(qos: .userInteractive).async {
    while let command = readLine(strippingNewline: true) {
        voiceIO.handle(command: command)
    }
    stopAndExit(0)
}

RunLoop.main.run()
