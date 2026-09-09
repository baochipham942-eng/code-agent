import { App } from '@capacitor/app';
import { Capacitor, SystemBars, SystemBarsStyle } from '@capacitor/core';
import { Keyboard } from '@capacitor/keyboard';
import { Preferences } from '@capacitor/preferences';
import type { PlatformPorts } from './ports';
import { nativeCompanionPort } from './nativeCompanion';

const PREFERENCES_KEY = 'neo.mobile.preferences.v1';

export const capacitorPorts: PlatformPorts = {
  companion: Capacitor.isNativePlatform() ? nativeCompanionPort : undefined,
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
