import { readFileSync, writeFileSync } from 'node:fs';

/** Pin the recorder's release behavior, including native stop failures. */
export function configureVoiceRelease(root = 'node_modules/capacitor-voice-recorder') {
  const android = `${root}/android/src/main/java/com/tchvu3/capacitorvoicerecorder/CustomMediaRecorder.java`;
  const java = readFileSync(android, 'utf8');
  const before = `        mediaRecorder.stop();
        mediaRecorder.release();
        currentRecordingStatus = CurrentRecordingStatus.NONE;`;
  const after = `        try { mediaRecorder.stop(); }
        finally {
            try { mediaRecorder.release(); }
            finally { currentRecordingStatus = CurrentRecordingStatus.NONE; }
        }`;
  if (!java.includes(before) && !java.includes(after)) throw new Error('VOICE_ANDROID_RELEASE_SOURCE_CHANGED');
  writeFileSync(android, java.replace(before, after));
  const ios = `${root}/ios/Plugin/CustomMediaRecorder.swift`;
  const swift = readFileSync(ios, 'utf8');
  const old = `    func stopRecording() {
        do {
            audioRecorder.stop()
            try recordingSession.setActive(false)
            try recordingSession.setCategory(originalRecordingSessionCategory)
            originalRecordingSessionCategory = nil
            audioRecorder = nil
            recordingSession = nil
            status = CurrentRecordingStatus.NONE
        } catch {}
    }`;
  const fixed = `    func stopRecording() {
        audioRecorder?.stop()
        try? recordingSession?.setActive(false)
        if let category = originalRecordingSessionCategory {
            try? recordingSession?.setCategory(category)
        }
        originalRecordingSessionCategory = nil
        audioRecorder = nil
        recordingSession = nil
        status = CurrentRecordingStatus.NONE
    }`;
  if (!swift.includes(old) && !swift.includes(fixed)) throw new Error('VOICE_IOS_RELEASE_SOURCE_CHANGED');
  writeFileSync(ios, swift.replace(old, fixed).replace('        } catch {\n            return false\n        }', '        } catch {\n            stopRecording()\n            return false\n        }'));
  const iosPlugin = `${root}/ios/Plugin/VoiceRecorder.swift`;
  let plugin = readFileSync(iosPlugin, 'utf8');
  if (!plugin.includes('neoBackgroundObserver')) {
    // fail-closed：锚点不在就是上游漂移，宁可构建报错也不许静默发出没打补丁的包
    // （String.replace 未命中会原样写回，构建全绿但「切后台停录音+删音频」整个消失）。
    const importAnchor = 'import Foundation';
    const fieldAnchor = '    private var customMediaRecorder: CustomMediaRecorder?';
    if (!plugin.includes(importAnchor) || !plugin.includes(fieldAnchor)) throw new Error('VOICE_IOS_PLUGIN_SOURCE_CHANGED');
    plugin = plugin.replace(importAnchor, 'import Foundation\nimport UIKit').replace(fieldAnchor, `    private var customMediaRecorder: CustomMediaRecorder?
    private var neoBackgroundObserver: NSObjectProtocol?
    override public func load() {
        neoBackgroundObserver = NotificationCenter.default.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
            guard let recorder = self?.customMediaRecorder else { return }
            recorder.stopRecording()
            try? FileManager.default.removeItem(at: recorder.getOutputFile())
            self?.customMediaRecorder = nil
        }
    }
    deinit { if let observer = neoBackgroundObserver { NotificationCenter.default.removeObserver(observer) } }`);
    writeFileSync(iosPlugin, plugin);
  }
  const androidPlugin = `${root}/android/src/main/java/com/tchvu3/capacitorvoicerecorder/VoiceRecorder.java`;
  let native = readFileSync(androidPlugin, 'utf8');
  if (!native.includes('neoReleaseRecording')) {
    const fieldAnchor = '    private CustomMediaRecorder mediaRecorder;';
    if (!native.includes(fieldAnchor)) throw new Error('VOICE_ANDROID_PLUGIN_SOURCE_CHANGED');
    for (const [before, after] of [
      ['public void startRecording(', 'public synchronized void startRecording('],
      ['public void stopRecording(', 'public synchronized void stopRecording('],
    ]) {
      if (!native.includes(before) && !native.includes(after)) throw new Error('VOICE_ANDROID_PLUGIN_SOURCE_CHANGED');
      native = native.replace(before, after);
    }
    native = native.replace(fieldAnchor, `    private CustomMediaRecorder mediaRecorder;
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
    @Override protected void handleOnDestroy() { neoReleaseRecording(); }`);
    writeFileSync(androidPlugin, native);
  }

}
