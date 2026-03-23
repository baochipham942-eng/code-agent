// system-audio-capture.swift
// 使用 ScreenCaptureKit 采集系统音频（耳机/外放都能捕获），输出 16kHz mono int16 PCM 到 stdout。
// 编译: swiftc -O -framework ScreenCaptureKit -framework AVFoundation -framework CoreMedia -o system-audio-capture system-audio-capture.swift
// 用法: ./system-audio-capture
// 需要: macOS 13+, Screen Recording 权限

import Foundation
import ScreenCaptureKit
import AVFoundation
import CoreMedia

// MARK: - Audio Capture Delegate

final class SystemAudioCapture: NSObject, SCStreamOutput, SCStreamDelegate {
    private var stream: SCStream?
    private var converter: AVAudioConverter?
    private let targetSampleRate: Double = 16000
    private let targetChannels: UInt32 = 1
    private var started = false

    func start() async throws {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        guard let display = content.displays.first else {
            throw CaptureError.noDisplay
        }

        let config = SCStreamConfiguration()
        // 音频配置
        config.capturesAudio = true
        config.sampleRate = 48000
        config.channelCount = 1  // 请求 mono
        config.excludesCurrentProcessAudio = true  // 排除自身音频

        // 最小化视频开销（SCK 要求必须有 display，但我们只要音频）
        config.width = 2
        config.height = 2
        config.minimumFrameInterval = CMTime(value: 10, timescale: 1) // 0.1 fps
        config.showsCursor = false

        let filter = SCContentFilter(display: display, excludingWindows: [])
        stream = SCStream(filter: filter, configuration: config, delegate: self)

        let queue = DispatchQueue(label: "audio-capture", qos: .userInteractive)
        try stream!.addStreamOutput(self, type: .audio, sampleHandlerQueue: queue)
        // 添加 screen output 避免视频帧积压
        try stream!.addStreamOutput(self, type: .screen, sampleHandlerQueue: DispatchQueue(label: "video-discard", qos: .background))

        try await stream!.startCapture()
        started = true
        fputs("system-audio-capture: started (48kHz→16kHz mono int16)\n", stderr)
    }

    func stop() {
        guard started else { return }
        started = false
        Task {
            try? await stream?.stopCapture()
        }
        fputs("system-audio-capture: stopped\n", stderr)
    }

    // MARK: - SCStreamOutput

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        // 丢弃视频帧
        guard type == .audio else { return }
        guard CMSampleBufferDataIsReady(sampleBuffer) else { return }

        guard let formatDesc = CMSampleBufferGetFormatDescription(sampleBuffer),
              let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(formatDesc)?.pointee else { return }

        let numSamples = CMSampleBufferGetNumSamples(sampleBuffer)
        guard numSamples > 0 else { return }

        // 提取音频数据
        var audioBufferList = AudioBufferList()
        var blockBuffer: CMBlockBuffer?

        let status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
            sampleBuffer,
            bufferListSizeNeededOut: nil,
            bufferListOut: &audioBufferList,
            bufferListSize: MemoryLayout<AudioBufferList>.size,
            blockBufferAllocator: nil,
            blockBufferMemoryAllocator: nil,
            flags: 0,
            blockBufferOut: &blockBuffer
        )
        guard status == noErr else { return }

        let buffer = audioBufferList.mBuffers
        guard let rawData = buffer.mData else { return }

        let sourceSampleRate = asbd.mSampleRate  // 48000
        let float32Count = Int(buffer.mDataByteSize) / MemoryLayout<Float>.size
        guard float32Count > 0 else { return }

        let float32Ptr = rawData.bindMemory(to: Float.self, capacity: float32Count)

        // 降采样: 48kHz → 16kHz (ratio 3:1)
        let ratio = Int(sourceSampleRate / targetSampleRate)
        guard ratio > 0 else { return }
        let outputCount = float32Count / ratio

        // 简单均值降采样（对语音足够好）+ float32 → int16
        var int16Samples = [Int16](repeating: 0, count: outputCount)
        for i in 0..<outputCount {
            var sum: Float = 0
            let base = i * ratio
            for j in 0..<ratio {
                sum += float32Ptr[base + j]
            }
            let avg = sum / Float(ratio)
            let clamped = max(-1.0, min(1.0, avg))
            int16Samples[i] = Int16(clamped * 32767.0)
        }

        // 写入 stdout
        int16Samples.withUnsafeBytes { rawBuf in
            FileHandle.standardOutput.write(Data(rawBuf))
        }
    }

    // MARK: - SCStreamDelegate

    func stream(_ stream: SCStream, didStopWithError error: any Error) {
        fputs("system-audio-capture: stream error: \(error.localizedDescription)\n", stderr)
        exit(1)
    }
}

// MARK: - Error

enum CaptureError: Error, CustomStringConvertible {
    case noDisplay
    var description: String {
        switch self {
        case .noDisplay: return "No display found for audio capture"
        }
    }
}

// MARK: - Main

let capture = SystemAudioCapture()

// 信号处理：优雅退出
func setupSignalHandler(_ sig: Int32) {
    let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
    source.setEventHandler {
        capture.stop()
        exit(0)
    }
    source.resume()
    signal(sig, SIG_IGN)
}
setupSignalHandler(SIGINT)
setupSignalHandler(SIGTERM)

// 检测 stdout 管道断开（父进程退出）
let pipeSource = DispatchSource.makeSignalSource(signal: SIGPIPE, queue: .main)
pipeSource.setEventHandler {
    capture.stop()
    exit(0)
}
pipeSource.resume()
signal(SIGPIPE, SIG_IGN)

// 启动采集
Task {
    do {
        try await capture.start()
    } catch {
        fputs("system-audio-capture: failed to start: \(error)\n", stderr)
        exit(1)
    }
}

RunLoop.main.run()
