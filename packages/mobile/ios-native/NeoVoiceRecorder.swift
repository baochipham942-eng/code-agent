import AVFoundation
import Capacitor
import Foundation
import UIKit

/// 第一方 iOS 录音实现，注册成 JS 侧同名的 `VoiceRecorder`。
///
/// 为什么不用厂商插件：`capacitor-voice-recorder` 只带 CocoaPods 的 podspec、没有 `Package.swift`，
/// 而本工程是 SPM 工程——`cap sync ios` 会把它从 `CapApp-SPM/Package.swift` 里排除掉（只 warn 不失败），
/// 原生类根本不进二进制，运行时是 `"VoiceRecorder" plugin is not implemented on ios`
/// （FB-140，2026-09-12 真机 build 22 实测）。Android 仍走厂商插件（gradle 不受 SPM 影响），
/// JS 侧接口与错误码保持不变。构建期由 `build-ios.mjs` 的 IOS_PLUGINS_NOT_LINKED 闸守着，
/// 不让同类问题再静默一次。
@objc(NeoVoiceRecorderPlugin)
public class NeoVoiceRecorderPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NeoVoiceRecorderPlugin"
    public let jsName = "VoiceRecorder"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "canDeviceVoiceRecord", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestAudioRecordingPermission", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "hasAudioRecordingPermission", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startRecording", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopRecording", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startPcmRecording", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopPcmRecording", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getCurrentStatus", returnType: CAPPluginReturnPromise)
    ]

    /// 与厂商插件逐字一致：JS 侧靠这些字符串分辨失败原因，UI 直接把它显示出来。
    private enum Failure {
        static let missingPermission = "MISSING_PERMISSION"
        static let failedToRecord = "FAILED_TO_RECORD"
        static let recordingHasNotStarted = "RECORDING_HAS_NOT_STARTED"
        static let emptyRecording = "EMPTY_RECORDING"
        static let alreadyRecording = "ALREADY_RECORDING"
    }

    private static let recordingSettings: [String: Any] = [
        AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
        AVSampleRateKey: 44_100,
        AVNumberOfChannelsKey: 1,
        AVEncoderAudioQualityKey: AVAudioQuality.medium.rawValue
    ]

    /// Must match `GUMMY_REALTIME_SAMPLE_RATE` in src/shared/constants/voice.ts.
    private static let pcmSampleRate: Double = 16_000

    private let queue = DispatchQueue(label: "ai.neo.companion.voice-recorder")
    private var recorder: AVAudioRecorder?
    private var fileURL: URL?
    private var engine: AVAudioEngine?
    private var converter: AVAudioConverter?
    private var pcmToken = UUID()
    private var previousCategory: AVAudioSession.Category?
    private var backgroundObserver: NSObjectProtocol?

    override public func load() {
        // 切后台就停录并删掉已录音频：麦克风不该在用户看不见的时候还开着，
        // 半截录音也不该留在磁盘上等下一次 stop 把它当成本次结果。
        backgroundObserver = NotificationCenter.default.addObserver(
            forName: UIApplication.didEnterBackgroundNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            self?.queue.async { self?.teardown(deleteRecording: true) }
        }
    }

    deinit {
        if let observer = backgroundObserver { NotificationCenter.default.removeObserver(observer) }
    }

    @objc func canDeviceVoiceRecord(_ call: CAPPluginCall) {
        call.resolve(["value": true])
    }

    @objc func hasAudioRecordingPermission(_ call: CAPPluginCall) {
        call.resolve(["value": Self.permissionGranted()])
    }

    @objc func requestAudioRecordingPermission(_ call: CAPPluginCall) {
        Self.requestPermission { granted in call.resolve(["value": granted]) }
    }

    @objc func getCurrentStatus(_ call: CAPPluginCall) {
        queue.async { [weak self] in
            call.resolve(["status": (self?.recorder == nil && self?.engine == nil) ? "NONE" : "RECORDING"])
        }
    }

    @objc func startRecording(_ call: CAPPluginCall) {
        queue.async { [weak self] in
            guard let self else { return }
            guard self.recorder == nil, self.engine == nil else { call.reject(Failure.alreadyRecording); return }
            guard Self.permissionGranted() else { call.reject(Failure.missingPermission); return }
            let url = FileManager.default.temporaryDirectory
                .appendingPathComponent("neo-voice-\(UUID().uuidString).m4a")
            do {
                let session = AVAudioSession.sharedInstance()
                // 录音会把共享会话切成 playAndRecord；停录后要还回去，否则这个进程后续播放
                // 一直停在录音用的路由上。
                self.previousCategory = session.category
                try session.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker])
                try session.setActive(true)
                let recorder = try AVAudioRecorder(url: url, settings: Self.recordingSettings)
                guard recorder.record() else { throw CocoaError(.fileWriteUnknown) }
                self.recorder = recorder
                self.fileURL = url
                call.resolve(["value": true])
            } catch {
                // 起录失败也要把会话和半截文件收干净，否则下一次 start 会撞上 ALREADY_RECORDING
                // 或者读到上一次的残留音频。
                self.recorder = nil
                self.fileURL = url
                self.teardown(deleteRecording: true)
                call.reject(Failure.failedToRecord)
            }
        }
    }

    @objc func startPcmRecording(_ call: CAPPluginCall) {
        queue.async { [weak self] in
            guard let self else { return }
            guard self.recorder == nil, self.engine == nil else { call.reject(Failure.alreadyRecording); return }
            guard Self.permissionGranted() else { call.reject(Failure.missingPermission); return }
            do {
                let session = AVAudioSession.sharedInstance()
                self.previousCategory = session.category
                try session.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker])
                try session.setActive(true)
                let engine = AVAudioEngine()
                let input = engine.inputNode
                let inputFormat = input.outputFormat(forBus: 0)
                guard let targetFormat = AVAudioFormat(
                    commonFormat: .pcmFormatInt16,
                    sampleRate: Self.pcmSampleRate,
                    channels: 1,
                    interleaved: true
                ), let converter = AVAudioConverter(from: inputFormat, to: targetFormat) else {
                    throw CocoaError(.fileWriteUnknown)
                }
                let token = UUID()
                self.pcmToken = token
                self.converter = converter
                let bufferSize = AVAudioFrameCount(max(512, inputFormat.sampleRate * 0.1))
                input.installTap(onBus: 0, bufferSize: bufferSize, format: inputFormat) { [weak self] buffer, _ in
                    // Convert on the audio thread: the tap buffer is reused after this callback returns.
                    self?.emitPcm(buffer: buffer, token: token, converter: converter, targetFormat: targetFormat)
                }
                try engine.start()
                self.engine = engine
                call.resolve(["value": true, "sampleRate": Int(Self.pcmSampleRate)])
            } catch {
                self.teardownPcm()
                call.reject(Failure.failedToRecord)
            }
        }
    }

    @objc func stopPcmRecording(_ call: CAPPluginCall) {
        queue.async { [weak self] in
            guard let self else { return }
            guard self.engine != nil else { call.reject(Failure.recordingHasNotStarted); return }
            self.teardownPcm()
            call.resolve(["value": true])
        }
    }

    @objc func stopRecording(_ call: CAPPluginCall) {
        queue.async { [weak self] in
            guard let self else { return }
            guard let recorder = self.recorder, let url = self.fileURL else {
                call.reject(Failure.recordingHasNotStarted)
                return
            }
            // currentTime 只在录音进行中有效，必须在 stop() 之前读；
            // Host 侧 schema 是 durationMs.positive()，截断出来的 0 会让整条 voice.transcribe 被拒。
            let durationMs = max(1, Int(recorder.currentTime * 1000))
            self.teardown(deleteRecording: false)
            defer { try? FileManager.default.removeItem(at: url) }
            guard let data = try? Data(contentsOf: url), !data.isEmpty else {
                call.reject(Failure.emptyRecording)
                return
            }
            call.resolve(["value": [
                "recordDataBase64": data.base64EncodedString(),
                "mimeType": "audio/aac",
                "msDuration": durationMs,
                "path": url.path
            ]])
        }
    }

    private func emitPcm(buffer: AVAudioPCMBuffer, token: UUID, converter: AVAudioConverter, targetFormat: AVAudioFormat) {
        let ratio = targetFormat.sampleRate / buffer.format.sampleRate
        let outFrames = AVAudioFrameCount((Double(buffer.frameLength) * ratio).rounded(.up))
        guard let out = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: max(outFrames, 1)) else { return }
        var error: NSError?
        var consumed = false
        let status = converter.convert(to: out, error: &error) { _, outStatus in
            if consumed {
                outStatus.pointee = .noDataNow
                return nil
            }
            consumed = true
            outStatus.pointee = .haveData
            return buffer
        }
        guard status != .error, let channels = out.int16ChannelData, out.frameLength > 0 else { return }
        let bytes = Int(out.frameLength) * MemoryLayout<Int16>.size
        let data = Data(bytes: channels[0], count: bytes)
        let durationMs = max(1, Int(Double(out.frameLength) / targetFormat.sampleRate * 1000))
        queue.async { [weak self] in
            guard let self, self.pcmToken == token, self.engine != nil else { return }
            self.notifyListeners("pcmFrame", data: [
                "pcm": data.base64EncodedString(),
                "durationMs": durationMs
            ])
        }
    }

    private func teardownPcm() {
        pcmToken = UUID()
        if let engine {
            engine.inputNode.removeTap(onBus: 0)
            engine.stop()
        }
        engine = nil
        converter = nil
        let session = AVAudioSession.sharedInstance()
        try? session.setActive(false, options: [.notifyOthersOnDeactivation])
        if let category = previousCategory { try? session.setCategory(category) }
        previousCategory = nil
    }

    private func teardown(deleteRecording: Bool) {
        recorder?.stop()
        recorder = nil
        teardownPcm()
        if deleteRecording, let url = fileURL { try? FileManager.default.removeItem(at: url) }
        fileURL = nil
    }

    private static func permissionGranted() -> Bool {
        if #available(iOS 17.0, *) { return AVAudioApplication.shared.recordPermission == .granted }
        return AVAudioSession.sharedInstance().recordPermission == .granted
    }

    private static func requestPermission(_ completion: @escaping (Bool) -> Void) {
        if #available(iOS 17.0, *) {
            AVAudioApplication.requestRecordPermission(completionHandler: completion)
        } else {
            AVAudioSession.sharedInstance().requestRecordPermission(completion)
        }
    }
}
