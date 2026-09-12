import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

// Swift 不在任何测试框架里，但 JS↔原生之间那几个字符串是真合同：名字错一个字，
// 桥就找不到实现（FB-140 就是这个形状：原生根本没进包，JS 侧照常调）。
const swift = readFileSync('packages/mobile/ios-native/NeoVoiceRecorder.swift', 'utf8');
const capacitorPort = readFileSync('packages/mobile/src/platform/capacitor.ts', 'utf8');
const buildScript = readFileSync('packages/mobile/scripts/build-ios.mjs', 'utf8');

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
  });

  it('returns the fields the port reads back off a recording', () => {
    for (const field of ['recordDataBase64', 'mimeType', 'msDuration']) {
      expect(swift).toContain(`"${field}"`);
      expect(capacitorPort).toContain(field);
    }
  });

  it('keeps the vendor error codes, which the UI now shows verbatim', () => {
    for (const code of ['ALREADY_RECORDING', 'MISSING_PERMISSION', 'FAILED_TO_RECORD',
      'RECORDING_HAS_NOT_STARTED', 'EMPTY_RECORDING']) {
      expect(swift).toContain(`"${code}"`);
    }
  });

  it('stops and discards the recording when the app goes to background', () => {
    // 这条行为原来靠 configure-voice 给厂商源码打补丁，而那段源码从未被编译过
    expect(swift).toContain('didEnterBackgroundNotification');
    expect(swift).toContain('teardown(deleteRecording: true)');
  });
});
