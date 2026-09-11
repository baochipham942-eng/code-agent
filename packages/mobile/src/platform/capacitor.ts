import { VoiceRecorder } from 'capacitor-voice-recorder';
import { App } from '@capacitor/app';
import { Capacitor, SystemBars, SystemBarsStyle } from '@capacitor/core';
import { Directory, Filesystem } from '@capacitor/filesystem';
import { Keyboard } from '@capacitor/keyboard';
import { Preferences } from '@capacitor/preferences';
import { companionFileMime, COMPANION_FILE_MIME_TYPES } from '../../../../src/shared/constants/companion';
import type { FilePorts, PlatformPorts } from './ports';
import { bytesToArrayBuffer, bytesToBase64, FileCache } from './fileCache';
import { nativeCompanionPort } from './nativeCompanion';

const PREFERENCES_KEY = 'neo.mobile.preferences.v1';

const IMAGE_ACCEPT = COMPANION_FILE_MIME_TYPES.filter(type => type.startsWith('image/')).join(',');
const FILE_ACCEPT = COMPANION_FILE_MIME_TYPES.join(',');

function webFilePorts(cache: FileCache): FilePorts {
  return {
    pick: kind => new Promise(resolve => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = kind === 'image' ? IMAGE_ACCEPT : FILE_ACCEPT;
      input.addEventListener('change', async () => {
        const file = input.files?.[0];
        if (!file) { resolve(null); return; }
        const bytes = new Uint8Array(await file.arrayBuffer());
        const mime = companionFileMime(file.name, file.type) ?? file.type;
        resolve({ name: file.name, mimeType: mime, size: file.size, bytes });
      }, { once: true });
      input.addEventListener('cancel', () => resolve(null), { once: true });
      input.click();
    }),
    save: async file => {
      try {
        if (Capacitor.isNativePlatform()) {
          await Filesystem.writeFile({
            path: file.name, data: bytesToBase64(file.bytes), directory: Directory.Documents,
          });
          return { status: 'saved' };
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
