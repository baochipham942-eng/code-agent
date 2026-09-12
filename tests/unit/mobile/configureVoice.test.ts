import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { configureVoiceRelease } from '../../../packages/mobile/scripts/configure-voice.mjs';

// 夹具内容照抄 configure-voice.mjs 里的 before/old 锚点块（写入点就是脚本本身），
// 上游 capacitor-voice-recorder 7.0.6 的真实文件包含这些块。
const JAVA_RECORDER = `package com.tchvu3.capacitorvoicerecorder;

public class CustomMediaRecorder {
        mediaRecorder.stop();
        mediaRecorder.release();
        currentRecordingStatus = CurrentRecordingStatus.NONE;
}
`;

const SWIFT_RECORDER = `import Foundation

public class CustomMediaRecorder {
    func stopRecording() {
        do {
            audioRecorder.stop()
            try recordingSession.setActive(false)
            try recordingSession.setCategory(originalRecordingSessionCategory)
            originalRecordingSessionCategory = nil
            audioRecorder = nil
            recordingSession = nil
            status = CurrentRecordingStatus.NONE
        } catch {}
    }
}
`;

const SWIFT_PLUGIN = `import Foundation
import Capacitor

public class VoiceRecorder: CAPPlugin {
    private var customMediaRecorder: CustomMediaRecorder?
}
`;

const JAVA_PLUGIN = `package com.tchvu3.capacitorvoicerecorder;

public class VoiceRecorder extends Plugin {
    private CustomMediaRecorder mediaRecorder;
    public void startRecording(PluginCall call) {}
    public void stopRecording(PluginCall call) {}
}
`;

const JAVA_DIR = 'android/src/main/java/com/tchvu3/capacitorvoicerecorder';

const fixtureRoot = path.join(os.tmpdir(), `configure-voice-${process.pid}-${Date.now()}`);

function plant(overrides: Record<string, string> = {}): string {
  const files: Record<string, string> = {
    [`${JAVA_DIR}/CustomMediaRecorder.java`]: JAVA_RECORDER,
    ['ios/Plugin/CustomMediaRecorder.swift']: SWIFT_RECORDER,
    ['ios/Plugin/VoiceRecorder.swift']: SWIFT_PLUGIN,
    [`${JAVA_DIR}/VoiceRecorder.java`]: JAVA_PLUGIN,
    ...overrides,
  };
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(fixtureRoot, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  return fixtureRoot;
}

const read = (root: string, relative: string) => readFileSync(path.join(root, relative), 'utf8');

describe('configureVoiceRelease', () => {
  afterEach(() => {
    if (existsSync(fixtureRoot)) rmSync(fixtureRoot, { recursive: true, force: true });
  });

  it('applies both android patches and stays idempotent on a second run', () => {
    const root = plant();
    configureVoiceRelease(root);
    const javaPlugin = read(root, `${JAVA_DIR}/VoiceRecorder.java`);
    expect(javaPlugin).toContain('neoReleaseRecording');
    expect(javaPlugin).toContain('public synchronized void startRecording(');
    expect(javaPlugin).toContain('public synchronized void stopRecording(');
    expect(read(root, `${JAVA_DIR}/CustomMediaRecorder.java`)).toContain('finally { currentRecordingStatus = CurrentRecordingStatus.NONE; }');
    expect(() => configureVoiceRelease(root)).not.toThrow();
    expect(read(root, `${JAVA_DIR}/VoiceRecorder.java`)).toBe(javaPlugin);
  });

  // iOS 侧的两处补丁打的是厂商插件的 iOS 源码，而它在 SPM 工程里从未被编译过
  // （没有 Package.swift，cap sync 只 warn 就排除，FB-140 真机实测）。iOS 录音已改第一方实现，
  // 这里钉住「幽灵补丁不许回来」：改了也白改，却会让人以为 iOS 行为被这个脚本管着。
  it('leaves the vendor ios sources untouched', () => {
    const root = plant();
    configureVoiceRelease(root);
    expect(read(root, 'ios/Plugin/VoiceRecorder.swift')).toBe(SWIFT_PLUGIN);
    expect(read(root, 'ios/Plugin/CustomMediaRecorder.swift')).toBe(SWIFT_RECORDER);
  });

  it('does not depend on the vendor ios sources existing at all', () => {
    const root = plant();
    rmSync(path.join(root, 'ios'), { recursive: true, force: true });
    expect(() => configureVoiceRelease(root)).not.toThrow();
  });

  // ai-review #1742 第 5 轮 Important（arbitrate 二审维持）：replace 未命中静默写回原文，
  // 上游漂移后构建全绿但补丁整个消失。锚点不在必须 throw。
  it('throws VOICE_ANDROID_PLUGIN_SOURCE_CHANGED when the java field anchor drifted', () => {
    const root = plant({ [`${JAVA_DIR}/VoiceRecorder.java`]: JAVA_PLUGIN.replace('    private CustomMediaRecorder mediaRecorder;', '    CustomMediaRecorder mediaRecorder;') });
    expect(() => configureVoiceRelease(root)).toThrow('VOICE_ANDROID_PLUGIN_SOURCE_CHANGED');
    expect(read(root, `${JAVA_DIR}/VoiceRecorder.java`)).not.toContain('neoReleaseRecording');
  });

  it('throws VOICE_ANDROID_PLUGIN_SOURCE_CHANGED when a method signature anchor drifted', () => {
    const root = plant({ [`${JAVA_DIR}/VoiceRecorder.java`]: JAVA_PLUGIN.replace('public void startRecording(', 'public void beginRecording(') });
    expect(() => configureVoiceRelease(root)).toThrow('VOICE_ANDROID_PLUGIN_SOURCE_CHANGED');
  });
});
