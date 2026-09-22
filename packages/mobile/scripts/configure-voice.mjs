import { readFileSync, writeFileSync } from 'node:fs';

/**
 * Pin the Android recorder's release behavior, including native stop failures.
 *
 * iOS 侧不再打补丁：那两处（CustomMediaRecorder.stopRecording / VoiceRecorder 的 neoBackgroundObserver）
 * 补的是厂商插件的 iOS 源码，而这份源码在 SPM 工程里**从未被编译过**——插件没有 Package.swift，
 * cap sync 只 warn 就把它排除了（FB-140 真机实测：运行时 "plugin is not implemented on ios"）。
 * iOS 录音现在由 ios-native/NeoVoiceRecorder.swift 自己实现。
 *
 * N-MOBILE-BG-RECORDING（爸 2026-09-18 拍板）：切后台不再杀录音（保活交给 microphone 前台服务），
 * 只保留 handleOnDestroy 清场——进程死了录音文件不该留着等下次 stop 当本次结果。
 *
 * N-VOICE-AMBIENT-GATE：MIC → VOICE_COMMUNICATION（近场 + 系统降噪），停录时峰值低于
 * COMPANION_LIMITS.voiceEnergyPeak 抛 NO_SPEECH，JS 当没发生。
 */
export function configureVoiceRelease(root = 'node_modules/capacitor-voice-recorder') {
  const android = `${root}/android/src/main/java/com/tchvu3/capacitorvoicerecorder/CustomMediaRecorder.java`;
  let java = readFileSync(android, 'utf8');
  const micSource = 'mediaRecorder.setAudioSource(MediaRecorder.AudioSource.MIC);';
  const voiceSource = 'mediaRecorder.setAudioSource(MediaRecorder.AudioSource.VOICE_COMMUNICATION);';
  if (!java.includes(micSource) && !java.includes(voiceSource)) throw new Error('VOICE_ANDROID_SOURCE_CHANGED');
  java = java.replace(micSource, voiceSource);
  const before = `        mediaRecorder.stop();
        mediaRecorder.release();
        currentRecordingStatus = CurrentRecordingStatus.NONE;`;
  const releaseAfter = `        try { mediaRecorder.stop(); }
        finally {
            try { mediaRecorder.release(); }
            finally { currentRecordingStatus = CurrentRecordingStatus.NONE; }
        }`;
  const ambientAfter = `        int peak = 0;
        try { peak = mediaRecorder.getMaxAmplitude(); } catch (RuntimeException ignored) {}
        try { mediaRecorder.stop(); }
        finally {
            try { mediaRecorder.release(); }
            finally { currentRecordingStatus = CurrentRecordingStatus.NONE; }
        }
        if (peak < 500) {
            if (outputFile != null) outputFile.delete();
            throw new RuntimeException("NO_SPEECH");
        }`;
  if (java.includes(ambientAfter)) { /* already gated */ }
  else if (java.includes(before)) java = java.replace(before, ambientAfter);
  else if (java.includes(releaseAfter)) java = java.replace(releaseAfter, ambientAfter);
  else throw new Error('VOICE_ANDROID_RELEASE_SOURCE_CHANGED');
  writeFileSync(android, java);
  const androidPlugin = `${root}/android/src/main/java/com/tchvu3/capacitorvoicerecorder/VoiceRecorder.java`;
  let native = readFileSync(androidPlugin, 'utf8');
  // 内容判据，不是标记位：旧版脚本（PR#1944 之前）注入过 handleOnPause——切后台即 stop+delete
  // 录音文件，与本链「后台继续录音」相反。node_modules 是复用的，已被旧版打过的树上
  // neoReleaseRecording 一直在，拿它当「打没打过」的标记会把撤旧动作整个跳过，旧钩子
  // 留进 APK（PR#1944 ai-review Important）。先幂等撤掉旧行，再按新终态判要不要重打。
  const stalePauseHook = '    @Override protected void handleOnPause() { neoReleaseRecording(); }\n';
  native = native.replace(stalePauseHook, '');
  if (!native.includes('handleOnDestroy() { neoReleaseRecording(); }')) {
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
    @Override protected void handleOnDestroy() { neoReleaseRecording(); }`);
  }
  const fetchReject = '            call.reject(Messages.FAILED_TO_FETCH_RECORDING, exp);';
  const noSpeechReject = `            if ("NO_SPEECH".equals(exp.getMessage())) call.reject("NO_SPEECH");
            else call.reject(Messages.FAILED_TO_FETCH_RECORDING, exp);`;
  if (!native.includes(fetchReject) && !native.includes(noSpeechReject)) {
    throw new Error('VOICE_ANDROID_PLUGIN_SOURCE_CHANGED');
  }
  native = native.replace(fetchReject, noSpeechReject);
  writeFileSync(androidPlugin, native);

}
