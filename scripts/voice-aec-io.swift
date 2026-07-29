// voice-aec-io.swift
// macOS VoiceProcessingIO 双向语音 sidecar：
// - 上行：麦克风经原生 AEC 后输出 PCM16@16k（带帧协议）
// - 下行：从 FIFO 接收 PCM16@24k，统一走 AVAudioEngine 播放，给 AEC 提供参考信号
// - stdin：clear / mute / unmute 控制；父进程退出导致 EOF 时立即退出

import Foundation
import AVFoundation
import AudioToolbox
import CoreAudio

private let upstreamSampleRate: Double = 16_000
private let downstreamSampleRate: Double = 24_000
private let levelInterval: TimeInterval = 0.1

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
            return "usage: voice-aec-io --upstream-fifo <path> --downstream-fifo <path> [--input-device <name>]"
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
    let inputDevice: String?

    static func parse(_ raw: [String]) throws -> Arguments {
        var upstream: String?
        var downstream: String?
        var inputDevice: String?
        var index = 1
        while index < raw.count {
            switch raw[index] {
            case "--upstream-fifo" where index + 1 < raw.count:
                upstream = raw[index + 1]
                index += 2
            case "--downstream-fifo" where index + 1 < raw.count:
                downstream = raw[index + 1]
                index += 2
            case "--input-device" where index + 1 < raw.count:
                let value = raw[index + 1].trimmingCharacters(in: .whitespacesAndNewlines)
                inputDevice = value.isEmpty ? nil : value
                index += 2
            default:
                throw VoiceAecError.invalidArguments
            }
        }
        guard let upstream, let downstream else {
            throw VoiceAecError.invalidArguments
        }
        return Arguments(
            upstreamFifo: upstream,
            downstreamFifo: downstream,
            inputDevice: inputDevice
        )
    }
}

private func audioObjectString(
    _ objectID: AudioObjectID,
    selector: AudioObjectPropertySelector
) -> String? {
    var address = AudioObjectPropertyAddress(
        mSelector: selector,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    guard AudioObjectHasProperty(objectID, &address) else { return nil }
    var value: Unmanaged<CFString>?
    var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    let status = AudioObjectGetPropertyData(objectID, &address, 0, nil, &size, &value)
    return status == noErr ? value?.takeUnretainedValue() as String? : nil
}

private func hasInputStreams(_ deviceID: AudioDeviceID) -> Bool {
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioDevicePropertyStreams,
        mScope: kAudioDevicePropertyScopeInput,
        mElement: kAudioObjectPropertyElementMain
    )
    var size: UInt32 = 0
    return AudioObjectGetPropertyDataSize(deviceID, &address, 0, nil, &size) == noErr
        && size >= UInt32(MemoryLayout<AudioStreamID>.size)
}

private func inputDevice(named requestedName: String) -> AudioDeviceID? {
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDevices,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(
        AudioObjectID(kAudioObjectSystemObject),
        &address,
        0,
        nil,
        &size
    ) == noErr else {
        return nil
    }
    let count = Int(size) / MemoryLayout<AudioDeviceID>.size
    guard count > 0 else { return nil }
    var devices = [AudioDeviceID](repeating: 0, count: count)
    let status = devices.withUnsafeMutableBytes { bytes in
        AudioObjectGetPropertyData(
            AudioObjectID(kAudioObjectSystemObject),
            &address,
            0,
            nil,
            &size,
            bytes.baseAddress!
        )
    }
    guard status == noErr else { return nil }
    return devices.first { deviceID in
        hasInputStreams(deviceID)
            && audioObjectString(deviceID, selector: kAudioObjectPropertyName) == requestedName
    }
}

/**
 * AVAudioEngine 开启 voice processing 后底层是 VoiceProcessingIO。CoreAudio UID
 * 与 Web deviceId 不互通，所以只按持久化 label 找 AudioDeviceID，再设置当前输入设备。
 * 找不到或设置失败都留在系统默认，设备偏好不能阻断通话。
 */
private func selectInputDeviceIfRequested(
    named requestedName: String?,
    inputNode: AVAudioInputNode
) {
    guard let requestedName else { return }
    guard let deviceID = inputDevice(named: requestedName) else {
        fputs(
            "voice-aec-io: input device '\(requestedName)' not found; using system default\n",
            stderr
        )
        return
    }
    guard let audioUnit = inputNode.audioUnit else {
        fputs(
            "voice-aec-io: input device '\(requestedName)' cannot be selected; using system default\n",
            stderr
        )
        return
    }
    var selectedDeviceID = deviceID
    let status = AudioUnitSetProperty(
        audioUnit,
        kAudioOutputUnitProperty_CurrentDevice,
        kAudioUnitScope_Global,
        0,
        &selectedDeviceID,
        UInt32(MemoryLayout<AudioDeviceID>.size)
    )
    guard status == noErr else {
        fputs(
            "voice-aec-io: failed to select input device '\(requestedName)' (OSStatus \(status)); using system default\n",
            stderr
        )
        return
    }
    fputs("voice-aec-io: selected input device '\(requestedName)'\n", stderr)
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
    }

    func start() throws {
        let input = engine.inputNode
        let output = engine.outputNode

        // 两端必须同时进入 VoiceProcessingIO：输入负责采集，输出提供 AEC 参考信号。
        try input.setVoiceProcessingEnabled(true)
        try output.setVoiceProcessingEnabled(true)
        selectInputDeviceIfRequested(named: arguments.inputDevice, inputNode: input)

        engine.attach(player)
        engine.connect(player, to: engine.mainMixerNode, format: downstreamFormat)

        let inputFormat = input.outputFormat(forBus: 0)
        guard let converter = AVAudioConverter(from: inputFormat, to: upstreamFormat) else {
            throw VoiceAecError.audioFormatUnavailable
        }
        self.converter = converter

        input.installTap(onBus: 0, bufferSize: 1024, format: inputFormat) { [weak self] buffer, _ in
            self?.consumeInput(buffer)
        }

        engine.prepare()
        try engine.start()
        player.play()

        startDownstreamReader()
        writeFrame(kind: .ready, payload: Data("ready".utf8))
        fputs("voice-aec-io: started (AEC input 16kHz ↔ playback 24kHz)\n", stderr)
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

        engine.inputNode.removeTap(onBus: 0)
        player.stop()
        engine.stop()
        try? upstream.close()
        try? downstream.close()
        fputs("voice-aec-io: stopped\n", stderr)
    }

    func reportStartupError(_ error: Error) {
        writeFrame(kind: .error, payload: Data(String(describing: error).utf8))
    }

    private func consumeInput(_ input: AVAudioPCMBuffer) {
        guard let converter else { return }
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
        let isMuted = muted
        let now = Date.timeIntervalSinceReferenceDate
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
