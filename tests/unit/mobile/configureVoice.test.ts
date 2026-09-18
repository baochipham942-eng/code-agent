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
    // N-MOBILE-BG-RECORDING（爸 2026-09-18）：切后台不再杀录音（保活交给 microphone 前台服务），
    // 只留 handleOnDestroy 清场——进程死了录音文件不该留着等下次 stop 当本次结果。
    expect(javaPlugin).not.toContain('handleOnPause');
    expect(javaPlugin).toContain('handleOnDestroy');
    expect(read(root, `${JAVA_DIR}/CustomMediaRecorder.java`)).toContain('finally { currentRecordingStatus = CurrentRecordingStatus.NONE; }');
    expect(() => configureVoiceRelease(root)).not.toThrow();
    expect(read(root, `${JAVA_DIR}/VoiceRecorder.java`)).toBe(javaPlugin);
  });

  // PR#1944 ai-review 二轮 Important：已被**旧版**脚本（PR#1944 之前）打过的 node_modules 上，
  // 旧的 handleOnPause → neoReleaseRecording 注入必须被撤掉——否则老机器/老工作树复用
  // node_modules 产出的 APK 里切后台还是即停即删，与前台服务的「正在录音」通知自相矛盾。
  // 夹具照抄旧版脚本（a212f0658…166f74a57 的上一版）的产物形状：带 handleOnPause 那一行。
  const OLD_SCRIPT_INJECTED = `    private CustomMediaRecorder mediaRecorder;
    private synchronized void neoReleaseRecording() {
        if (mediaRecorder == null) return;
        try { mediaRecorder.stopRecording(); } catch (Exception ignored) {}
        finally {
            File file = mediaRecorder.getOutputFile();
            if (file != null) file.delete();
            mediaRecorder = null;
        }
    }
    @Override protected void handleOnPause() { neoReleaseRecording(); }
    @Override protected void handleOnDestroy() { neoReleaseRecording(); }`;

  it('removes the stale handleOnPause left by the pre-PR#1944 script on an already-patched node_modules', () => {
    const oldPatched = JAVA_PLUGIN
      .replace('public void startRecording(', 'public synchronized void startRecording(')
      .replace('public void stopRecording(', 'public synchronized void stopRecording(')
      .replace('    private CustomMediaRecorder mediaRecorder;', OLD_SCRIPT_INJECTED);
    const root = plant({ [`${JAVA_DIR}/VoiceRecorder.java`]: oldPatched });
    configureVoiceRelease(root);
    const javaPlugin = read(root, `${JAVA_DIR}/VoiceRecorder.java`);
    expect(javaPlugin).not.toContain('handleOnPause');
    expect(javaPlugin).toContain('handleOnDestroy');
    // 撤旧之后剩下的必须就是新终态：与「新脚本打全新夹具」的产物逐字一致
    const fresh = plant();
    configureVoiceRelease(fresh);
    expect(javaPlugin).toBe(read(fresh, `${JAVA_DIR}/VoiceRecorder.java`));
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
