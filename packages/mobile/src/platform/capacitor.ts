import { VoiceRecorder } from 'capacitor-voice-recorder';
import { App } from '@capacitor/app';
import { Capacitor, SystemBars, SystemBarsStyle } from '@capacitor/core';
import { Directory, Filesystem } from '@capacitor/filesystem';
import { Keyboard } from '@capacitor/keyboard';
import { Preferences } from '@capacitor/preferences';
import { companionFileMime, COMPANION_LIMITS } from '../../../../src/shared/constants/companion';
import type { FilePorts, PlatformPorts } from './ports';
import { bytesToArrayBuffer, bytesToBase64, FileCache } from './fileCache';
import { FILE_ACCEPT, IMAGE_ACCEPT } from './fileAccept';
import { nativeCompanionPort } from './nativeCompanion';
import { createNotificationPort } from './notifications';

const PREFERENCES_KEY = 'neo.mobile.preferences.v1';

function webFilePorts(cache: FileCache): FilePorts {
  return {
    pick: kind => new Promise((resolve, reject) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = kind === 'image' ? IMAGE_ACCEPT : FILE_ACCEPT;
      input.addEventListener('change', async () => {
        const file = input.files?.[0];
        if (!file) { resolve(null); return; }
        // 先卡大小再读字节：arrayBuffer() 会把整段录像一次性读进 WebView 内存，
        // 100MB+ 直接 OOM，超限提示根本轮不到（claude 复审修正轮 7）。
        if (file.size > COMPANION_LIMITS.fileMaxBytes) { reject(new Error('UPLOAD_TOO_LARGE')); return; }
        const bytes = new Uint8Array(await file.arrayBuffer());
        // OS/浏览器上报的 MIME 不可靠（.m4a 常见 audio/x-m4a、.md 报 octet-stream），扩展名才是权威；
        // 不把上报值带给上层，避免与扩展名矛盾被 companionFileMime 一致性校验拒掉。
        const mime = companionFileMime(file.name, '') ?? '';
        resolve({ name: file.name, mimeType: mime, size: file.size, bytes });
      }, { once: true });
      input.addEventListener('cancel', () => resolve(null), { once: true });
      input.click();
    }),
    save: async file => {
      try {
        if (Capacitor.isNativePlatform()) {
          // 同名成果不静默覆盖：photo.png 已存在则写 photo (1).png、photo (2).png…
          const dot = file.name.lastIndexOf('.');
          const stem = dot > 0 ? file.name.slice(0, dot) : file.name;
          const ext = dot > 0 ? file.name.slice(dot) : '';
          let candidate = file.name;
          for (let n = 1; ; n++) {
            try { await Filesystem.stat({ path: candidate, directory: Directory.Documents }); candidate = `${stem} (${n})${ext}`; }
            catch { break; }
          }
          await Filesystem.writeFile({
            path: candidate, data: bytesToBase64(file.bytes), directory: Directory.Documents,
          });
          return { status: 'saved', name: candidate };
        }
        const href = URL.createObjectURL(new Blob([bytesToArrayBuffer(file.bytes)], { type: file.mimeType }));
        const link = document.createElement('a');
        link.href = href; link.download = file.name; link.click();
        URL.revokeObjectURL(href);
        return { status: 'saved' };
      } catch (error) {
        const code = error && typeof error === 'object' && 'code' in error ? String((error as { code: unknown }).code) : '';
        const message = error instanceof Error ? error.message : '';
        if (code === 'ENOSPC' || code === 'EDQUOT' || /quota|space|disk full/i.test(message)) {
          return { status: 'error', code: 'STORAGE_FULL' };
        }
        return { status: 'error', code: 'COMPANION_EXPORT_FAILED' };
      }
    },
    cache,
  };
}

export const capacitorPorts: PlatformPorts = {
  recorder: Capacitor.isNativePlatform() ? {
    start: async () => {
      if (!(await VoiceRecorder.requestAudioRecordingPermission()).value) throw new Error('MICROPHONE_DENIED');
      await VoiceRecorder.startRecording();
    },
    stop: async () => {
      const { value } = await VoiceRecorder.stopRecording();
      if (!value.recordDataBase64) throw new Error('EMPTY_RECORDING');
      return { audioData: value.recordDataBase64, mimeType: value.mimeType.split(';')[0], durationMs: value.msDuration };
    },
  } : undefined,
  companion: Capacitor.isNativePlatform() ? nativeCompanionPort : undefined,
  notifications: createNotificationPort(Capacitor.getPlatform(), async () => {
    const open = (App as { openUrl?: (opts: { url: string }) => Promise<void> }).openUrl;
    if (!open) return;
    try { await open({ url: 'app-settings:' }); } catch { /* user opens Settings by hand */ }
  }),
  files: webFilePorts(new FileCache()),
  preferences: {
    get: async () => (await Preferences.get({ key: PREFERENCES_KEY })).value,
    set: async value => { await Preferences.set({ key: PREFERENCES_KEY, value }); },
  },
  appInfo: { read: () => App.getInfo() },
  lifecycle: {
    subscribe: async (onActive, onBack) => {
      const active = await App.addListener('appStateChange', ({ isActive }) => onActive(isActive));
      try {
        const back = Capacitor.getPlatform() === 'android' ? await App.addListener('backButton', onBack) : null;
        return () => { void active.remove(); void back?.remove(); };
      } catch (error) { await active.remove(); throw error; }
    },
    leave: () => App.minimizeApp(),
  },
  keyboard: {
    subscribe: async onVisible => {
      if (!Capacitor.isNativePlatform()) return () => {};
      const show = await Keyboard.addListener('keyboardDidShow', () => onVisible(true));
      try {
        const hide = await Keyboard.addListener('keyboardDidHide', () => onVisible(false));
        return () => { void show.remove(); void hide.remove(); };
      } catch (error) { await show.remove(); throw error; }
    },
    hide: async () => { if (Capacitor.isNativePlatform()) await Keyboard.hide(); },
  },
  // Icon shade follows the resolved theme; on web there are no system bars, so degrade silently like appInfo.
  systemBars: {
    setStyle: async appearance => {
      if (!Capacitor.isNativePlatform()) return;
      await SystemBars.setStyle({ style: appearance === 'dark' ? SystemBarsStyle.Dark : SystemBarsStyle.Light });
    },
  },
};
