import { App } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { Keyboard } from '@capacitor/keyboard';
import { Preferences } from '@capacitor/preferences';
import type { PlatformPorts } from './ports';

const PREFERENCES_KEY = 'neo.mobile.preferences.v1';

export const capacitorPorts: PlatformPorts = {
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
};
