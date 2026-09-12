import { readFileSync, writeFileSync } from 'node:fs';

/**
 * Pin the Android recorder's release behavior, including native stop failures.
 *
 * iOS 侧不再打补丁：那两处（CustomMediaRecorder.stopRecording / VoiceRecorder 的 neoBackgroundObserver）
 * 补的是厂商插件的 iOS 源码，而这份源码在 SPM 工程里**从未被编译过**——插件没有 Package.swift，
 * cap sync 只 warn 就把它排除了（FB-140 真机实测：运行时 "plugin is not implemented on ios"）。
 * iOS 录音现在由 ios-native/NeoVoiceRecorder.swift 自己实现，切后台停录与会话释放在那里。
 */
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
