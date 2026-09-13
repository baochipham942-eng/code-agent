import type { CapacitorConfig } from '@capacitor/cli';
import { KeyboardResize } from '@capacitor/keyboard';

const config: CapacitorConfig = {
  appId: 'dev.neo.companion.preview', appName: 'Neo Preview', webDir: 'dist',
  // Native 是动画结束后 +0.2s 再 setFrame 硬切（@capacitor/keyboard 8.0.5 Keyboard.m），
  // 输入区会落后整段键盘动画。iOS 改 None，由 willShow transform 跟手。resizeOnFullScreen 只对 Android 有效。
  plugins: { Keyboard: { resize: KeyboardResize.None, resizeOnFullScreen: true } },
};
export default config;
