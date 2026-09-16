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
        CAPPluginMethod(name: "getCurrentStatus", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "watchMicrophoneRelease", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "unwatchMicrophoneRelease", returnType: CAPPluginReturnPromise)
    ]

    /// 前五个与厂商插件逐字一致。JS 侧靠这些字符串分辨失败原因，**不再显示给用户**（build 45 真机
    /// 「录音失败 · FAILED_TO_RECORD」）；MICROPHONE_BUSY 是第一方独有的一档：通话/会议占着麦克风，
    /// 用户能自己解决（挂断后再录），不能和「设备出错」混成同一个码。
    private enum Failure {
        static let microphoneBusy = "MICROPHONE_BUSY"
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
    private var releaseObservers: [NSObjectProtocol] = []
    private var releaseTimer: DispatchSourceTimer?

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
                // 先判因再收尾：收尾会停用本进程的音频会话，判据要读的是失败那一刻别人占没占着。
                let failure = Self.startFailure(error)
                // 起录失败也要把会话和半截文件收干净，否则下一次 start 会撞上 ALREADY_RECORDING
                // 或者读到上一次的残留音频。
                self.recorder = nil
                self.fileURL = url
                self.teardown(deleteRecording: true)
                call.reject(failure)
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
                let failure = Self.startFailure(error)
                self.teardownPcm()
                call.reject(failure)
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

    /// 起录失败之后 JS 侧来问：麦克风现在空着吗？空着直接回 true；还被占着就布防，放手时发一次
    /// `microphoneAvailable`（爸 2026-09-16 拍板：真去检测释放，不做「点了就重试」的简单版）。
    @objc func watchMicrophoneRelease(_ call: CAPPluginCall) {
        queue.async { [weak self] in
            guard let self else { return }
            if Self.microphoneFree() { call.resolve(["available": true]); return }
            self.armReleaseWatch()
            call.resolve(["available": false])
        }
    }

    @objc func unwatchMicrophoneRelease(_ call: CAPPluginCall) {
        queue.async { [weak self] in
            self?.disarmReleaseWatch()
            call.resolve()
        }
    }

    private func armReleaseWatch() {
        guard releaseObservers.isEmpty else { return }
        let center = NotificationCenter.default
        for name in [AVAudioSession.interruptionNotification, AVAudioSession.silenceSecondaryAudioHintNotification,
                     AVAudioSession.routeChangeNotification, UIApplication.didBecomeActiveNotification] {
            releaseObservers.append(center.addObserver(forName: name, object: nil, queue: nil) { [weak self] _ in
                self?.queue.async { self?.checkRelease() }
            })
        }
        // ponytail: 中断/恢复通知只发给「自己的音频会话被打断过」的进程；起录失败时我们的会话根本没激活，
        // 会议 App（国内无 CallKit）挂断不保证通知到这里。所以布防期间再每 2 秒读一次会话状态兜底——
        // 只读两个属性、只在「被占用」提示挂着时跑，收到放手或 JS 取消就停。
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now() + 2, repeating: 2)
        timer.setEventHandler { [weak self] in self?.checkRelease() }
        timer.resume()
        releaseTimer = timer
    }

    private func checkRelease() {
        guard !releaseObservers.isEmpty, Self.microphoneFree() else { return }
        disarmReleaseWatch()
        notifyListeners("microphoneAvailable", data: [:])
    }

    private func disarmReleaseWatch() {
        releaseObservers.forEach { NotificationCenter.default.removeObserver($0) }
        releaseObservers = []
        releaseTimer?.cancel()
        releaseTimer = nil
    }

    /// 别的 App 正以独占方式占着音频（通话、会议、语音消息）时这两个都为真。
    private static func microphoneFree() -> Bool {
        let session = AVAudioSession.sharedInstance()
        return !session.isOtherAudioPlaying && !session.secondaryAudioShouldBeSilencedHint
    }

    /// 起录失败的原因：音频会话被更高优先级的占用方拒绝（通话/会议/Siri），或失败那一刻别人正独占音频，
    /// 算「被占用」——用户能自己解决；其余才是说不清的 FAILED_TO_RECORD。
    private static func startFailure(_ error: Error) -> String {
        let busyCodes: Set<Int> = [
            AVAudioSession.ErrorCode.insufficientPriority.rawValue,
            AVAudioSession.ErrorCode.cannotInterruptOthers.rawValue,
            AVAudioSession.ErrorCode.cannotStartRecording.rawValue,
            AVAudioSession.ErrorCode.isBusy.rawValue,
            AVAudioSession.ErrorCode.siriIsRecording.rawValue
        ]
        return busyCodes.contains((error as NSError).code) || !microphoneFree() ? Failure.microphoneBusy : Failure.failedToRecord
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
