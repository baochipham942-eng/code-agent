import type { PlatformPorts } from './ports';

type ListenerHandle = { remove: () => Promise<void> };

export interface KeyboardBridge {
  addListener(event: 'keyboardWillShow' | 'keyboardDidShow', cb: (info: { keyboardHeight: number }) => void): Promise<ListenerHandle>;
  addListener(event: 'keyboardWillHide' | 'keyboardDidHide', cb: () => void): Promise<ListenerHandle>;
  hide(): Promise<void>;
}

/**
 * DidShow/DidHide → 键盘在不在（返回键）。WillShow/WillHide → 输入区跟手（仅 iOS）。
 * Android 的 will/did 几乎同时到，且系统已经在缩 WebView，再抬一次会叠一次。
 */
export function createKeyboardPort(bridge: KeyboardBridge, platform: string): PlatformPorts['keyboard'] {
  const native = platform === 'ios' || platform === 'android';
  return {
    subscribe: async onVisible => {
      if (!native) return () => {};
      const show = await bridge.addListener('keyboardDidShow', () => onVisible(true));
      try {
        const hide = await bridge.addListener('keyboardDidHide', () => onVisible(false));
        return () => { void show.remove(); void hide.remove(); };
      } catch (error) { await show.remove(); throw error; }
    },
    subscribeFrame: async onFrame => {
      if (platform !== 'ios') return () => {};
      const show = await bridge.addListener('keyboardWillShow', info => {
        onFrame({ height: info.keyboardHeight, phase: 'will-show' });
      });
      try {
        const hide = await bridge.addListener('keyboardWillHide', () => {
          onFrame({ height: 0, phase: 'will-hide' });
        });
        return () => { void show.remove(); void hide.remove(); };
      } catch (error) { await show.remove(); throw error; }
    },
    hide: async () => { if (native) await bridge.hide(); },
  };
}
