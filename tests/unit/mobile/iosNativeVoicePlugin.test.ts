import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

import { mergeVoiceBackgroundMode } from '../../../packages/mobile/scripts/configure-lan.mjs';
import { COMPANION_LIMITS } from '../../../src/shared/constants/companion';

// Swift 不在任何测试框架里，但 JS↔原生之间那几个字符串是真合同：名字错一个字，
// 桥就找不到实现（FB-140 就是这个形状：原生根本没进包，JS 侧照常调）。
const swift = readFileSync('packages/mobile/ios-native/NeoVoiceRecorder.swift', 'utf8');
const capacitorPort = readFileSync('packages/mobile/src/platform/capacitor.ts', 'utf8');
const buildScript = readFileSync('packages/mobile/scripts/build-ios.mjs', 'utf8');
const companionContract = readFileSync('src/shared/contract/companion.ts', 'utf8');

describe('first-party ios voice recorder contract', () => {
  it('registers under the js name the app actually calls', () => {
    expect(swift).toContain('public let jsName = "VoiceRecorder"');
    expect(capacitorPort).toContain("import { VoiceRecorder } from 'capacitor-voice-recorder'");
  });

  it('exposes the objc class name the build script puts in packageClassList', () => {
    // Capacitor 8 按 packageClassList 里的类名找类，找不到就静默跳过——两边写的名字必须是同一个。
    const objcName = swift.match(/@objc\((\w+)\)/)?.[1];
    expect(objcName).toBeTruthy();
    expect(buildScript).toContain(`nativeClass: '${objcName}'`);
    expect(swift).toContain(`public let identifier = "${objcName}"`);
  });

  it('declares every bridge method the port calls', () => {
    for (const method of ['requestAudioRecordingPermission', 'startRecording', 'stopRecording']) {
      expect(capacitorPort).toContain(`VoiceRecorder.${method}()`);
      expect(swift).toContain(`CAPPluginMethod(name: "${method}"`);
      expect(swift).toContain(`@objc func ${method}(`);
    }
    for (const method of ['startPcmRecording', 'stopPcmRecording']) {
      expect(capacitorPort).toContain(`${method}()`);
      expect(swift).toContain(`CAPPluginMethod(name: "${method}"`);
      expect(swift).toContain(`@objc func ${method}(`);
    }
    expect(swift).toContain('pcmFormatInt16');
    expect(swift).toContain('16_000');
    expect(swift).toContain('pcmFrame');
    expect(capacitorPort).toContain("'pcmFrame'");
  });

  it('returns the fields the port reads back off a recording', () => {
    for (const field of ['recordDataBase64', 'mimeType', 'msDuration']) {
      expect(swift).toContain(`"${field}"`);
      expect(capacitorPort).toContain(field);
    }
    // Host 侧 mimeType 是 enum、durationMs 是 .positive()：值写错整条 voice.transcribe 被拒
    expect(swift).toContain('"mimeType": "audio/aac"');
    expect(companionContract).toContain("'audio/aac'");
    expect(swift).toContain('max(1, Int(recorder.currentTime * 1000))');
  });

  it('keeps the vendor error codes, which the JS side branches on (never shown to the user)', () => {
    for (const code of ['ALREADY_RECORDING', 'MISSING_PERMISSION', 'FAILED_TO_RECORD',
      'RECORDING_HAS_NOT_STARTED', 'EMPTY_RECORDING']) {
      expect(swift).toContain(`"${code}"`);
    }
  });

  // N-MOBILE-VOICE-ERRCODE-LEAK（build 45 真机：开会占着麦克风，报成 FAILED_TO_RECORD）
  it('起录失败先判「被占用」再收尾，两条起录路径都走同一个判因', () => {
    const voiceCapture = readFileSync('packages/mobile/src/features/sessions/VoiceCapture.tsx', 'utf8');
    const composer = readFileSync('packages/mobile/src/features/sessions/Composer.tsx', 'utf8');
    expect(swift).toContain('static let microphoneBusy = "MICROPHONE_BUSY"');
    expect(voiceCapture).toContain("'MICROPHONE_BUSY'");
    expect(composer).toContain("'MICROPHONE_BUSY'");
    // 判因必须在 teardown 之前：收尾会停用本进程的会话
    expect(swift.match(/let failure = Self\.startFailure\(error\)\n[\s\S]*?teardown/g)).toHaveLength(2);
    expect(swift).not.toContain('call.reject(Failure.failedToRecord)');
    expect(swift).toContain('.contains((error as NSError).code) || !microphoneFree() ? Failure.microphoneBusy : Failure.failedToRecord');
    for (const code of ['insufficientPriority', 'cannotInterruptOthers', 'isBusy']) {
      expect(swift).toContain(`AVAudioSession.ErrorCode.${code}.rawValue`);
    }
    // 泛化起录失败不算占用：否则无他 App 音频时提示先说「被占用」又立刻翻成「空出来了」
    expect(swift).not.toContain('AVAudioSession.ErrorCode.cannotStartRecording.rawValue');
  });

  it('开录前校验输入格式：0 通道或 0Hz 报 MICROPHONE_UNAVAILABLE，两条路径都不降级到分段', () => {
    const voiceCapture = readFileSync('packages/mobile/src/features/sessions/VoiceCapture.tsx', 'utf8');
    expect(swift).toContain('static let microphoneUnavailable = "MICROPHONE_UNAVAILABLE"');
    expect(swift).toContain('func inputUnavailable');
    expect(swift).toContain('format.channelCount == 0 || format.sampleRate == 0');
    expect(swift).toContain('session.inputNumberOfChannels == 0 || session.sampleRate == 0');
    expect(swift.match(/call\.reject\(Failure\.microphoneUnavailable\)/g)).toHaveLength(2);
    expect(voiceCapture).toContain("'MICROPHONE_UNAVAILABLE'");
    expect(voiceCapture).toMatch(/MICROPHONE_BUSY[\s\S]*MICROPHONE_UNAVAILABLE/);
  });

  it('真检测麦克风释放：桥方法、事件名两边一致，盯守监听中断/恢复通知', () => {
    for (const method of ['watchMicrophoneRelease', 'unwatchMicrophoneRelease']) {
      expect(swift).toContain(`CAPPluginMethod(name: "${method}"`);
      expect(swift).toContain(`@objc func ${method}(`);
      expect(capacitorPort).toContain(`pcmBridge.${method}()`);
    }
    // 撤防必须排在布防回包之后，否则先撤后布，原生定时器空转
    expect(capacitorPort).toContain('void armed.then(() => pcmBridge.unwatchMicrophoneRelease())');
    expect(swift).toContain('notifyListeners("microphoneAvailable"');
    expect(capacitorPort).toContain("addListener('microphoneAvailable'");
    expect(swift).toContain('AVAudioSession.interruptionNotification');
    expect(swift).toContain('isOtherAudioPlaying');
  });

  // build 46 远端验收：@capacitor/app 在 iOS 上没有 openUrl，原来的「去设置」是空操作（原生回 UNIMPLEMENTED 被吞）
  it('iOS 的「去设置」走第一方插件打开本 App 设置页，不再调不存在的 App.openUrl', () => {
    expect(swift).toContain('CAPPluginMethod(name: "openAppSettings"');
    expect(swift).toContain('@objc func openAppSettings(');
    expect(swift).toContain('UIApplication.openSettingsURLString');
    expect(capacitorPort).toContain("if (Capacitor.getPlatform() === 'ios') { await pcmBridge.openAppSettings()");
  });

  // N-MOBILE-BG-RECORDING（爸 2026-09-18 拍板，翻掉「麦克风不该在用户看不见的时候开着」旧拍板）。
  // 旧契约（曾靠 configure-voice 给厂商源码打补丁、后又挂在第一方 load() 里）：
  // didEnterBackground → teardown(deleteRecording: true)。新契约：切后台继续录。
  it('切后台继续录：不再挂 didEnterBackground 停录，进程保活交给 Info.plist 的 audio 模式', () => {
    expect(swift).not.toContain('didEnterBackgroundNotification');
    expect(swift).not.toContain('backgroundObserver');
    // teardown 本体保留：stop/起录失败路径还在用
    expect(swift.match(/teardown\(deleteRecording: true\)/g)).toBeTruthy();
    // configure-lan 幂等合入 audio 模式（不顶掉 remote-notification），且真接到 plist 写出
    expect(mergeVoiceBackgroundMode([])).toEqual(['remote-notification', 'audio']);
    expect(mergeVoiceBackgroundMode(['remote-notification'])).toEqual(['remote-notification', 'audio']);
    expect(mergeVoiceBackgroundMode(['audio'])).toEqual(['audio', 'remote-notification']);
    expect(mergeVoiceBackgroundMode(['audio', 'remote-notification'])).toEqual(['audio', 'remote-notification']);
    const configureLan = readFileSync('packages/mobile/scripts/configure-lan.mjs', 'utf8');
    expect(configureLan).toContain('mergeVoiceBackgroundMode(readBackgroundModes(plist))');
  });

  // N-VOICE-AMBIENT-GATE：远场环境人声（5 米外短视频）不该进草稿。
  it('录音会话走 voiceChat，停录还原 mode，两条起录路径共用同一套', () => {
    expect(swift).toContain('mode: .voiceChat');
    expect(swift).not.toMatch(/setCategory\(\.playAndRecord, mode: \.default/);
    expect(swift).toContain('previousMode = session.mode');
    expect(swift).toContain('setCategory(category, mode: previousMode ?? .default');
    expect(swift.match(/try self\.activateSession\(\)/g)).toHaveLength(2);
  });

  it('近场能量门阈值与 COMPANION_LIMITS 钉齐，低能量段报 NO_SPEECH', () => {
    const voiceCapture = readFileSync('packages/mobile/src/features/sessions/VoiceCapture.tsx', 'utf8');
    expect(swift).toContain(`energyDb: Float = ${COMPANION_LIMITS.voiceEnergyDb}`);
    expect(swift).toContain(`minSpeechMs = ${COMPANION_LIMITS.voiceMinSpeechMs}`);
    expect(swift).toContain(`meterIntervalMs = ${COMPANION_LIMITS.voiceMeterIntervalMs}`);
    expect(swift).toContain(`pcmEnergyRms: Double = ${COMPANION_LIMITS.voiceEnergyRms}`);
    expect(swift).toContain('static let noSpeech = "NO_SPEECH"');
    expect(swift).toContain('speechMs >= Self.minSpeechMs');
    expect(swift).toContain('call.reject(Failure.noSpeech)');
    expect(swift).toContain('pcmRms(data) >= Self.pcmEnergyRms ? data : Data(count: data.count)');
    expect(voiceCapture).toContain("code === 'NO_SPEECH'");
    expect(voiceCapture).toContain("code === 'EMPTY_RECORDING'");
  });
});
