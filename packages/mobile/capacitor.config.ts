import type { CapacitorConfig } from '@capacitor/cli';
import { KeyboardResize } from '@capacitor/keyboard';

const config: CapacitorConfig = {
  appId: 'dev.neo.companion.preview', appName: 'Neo Preview', webDir: 'dist',
  plugins: { Keyboard: { resize: KeyboardResize.Native, resizeOnFullScreen: true } },
};
export default config;
