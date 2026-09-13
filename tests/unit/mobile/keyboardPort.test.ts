import { describe, expect, it, vi } from 'vitest';
import { createKeyboardPort } from '../../../packages/mobile/src/platform/keyboardPort';
import fs from 'node:fs';
import path from 'node:path';

function fakeBridge() {
  const listeners = new Map<string, ((info?: { keyboardHeight: number }) => void)[]>();
  return {
    addListener: vi.fn(async (event: string, cb: (info?: { keyboardHeight: number }) => void) => {
      const bucket = listeners.get(event) ?? [];
      bucket.push(cb);
      listeners.set(event, bucket);
      return { remove: async () => { listeners.set(event, (listeners.get(event) ?? []).filter(item => item !== cb)); } };
    }),
    hide: vi.fn(async () => {}),
    emit(event: string, info?: { keyboardHeight: number }) {
      for (const cb of listeners.get(event) ?? []) cb(info);
    },
  };
}

describe('createKeyboardPort', () => {
  it('iOS：subscribeFrame 订 willShow/willHide，subscribe 订 DidShow/DidHide', async () => {
    const bridge = fakeBridge();
    const port = createKeyboardPort(bridge, 'ios');
    const onVisible = vi.fn();
    const onFrame = vi.fn();
    await port.subscribe(onVisible);
    await port.subscribeFrame(onFrame);

    expect(bridge.addListener.mock.calls.map(call => call[0])).toEqual([
      'keyboardDidShow', 'keyboardDidHide', 'keyboardWillShow', 'keyboardWillHide',
    ]);

    bridge.emit('keyboardWillShow', { keyboardHeight: 336 });
    expect(onFrame).toHaveBeenCalledWith({ height: 336, phase: 'will-show' });
    expect(onVisible).not.toHaveBeenCalled();

    bridge.emit('keyboardDidShow', { keyboardHeight: 336 });
    expect(onVisible).toHaveBeenCalledWith(true);
    expect(onFrame).toHaveBeenCalledTimes(1);

    bridge.emit('keyboardWillHide');
    expect(onFrame).toHaveBeenLastCalledWith({ height: 0, phase: 'will-hide' });
    expect(onVisible).toHaveBeenCalledTimes(1);

    bridge.emit('keyboardDidHide');
    expect(onVisible).toHaveBeenLastCalledWith(false);
  });

  it('Android：subscribeFrame 是空操作，不订 willShow，避免叠在系统缩 WebView 上再抬一次', async () => {
    const bridge = fakeBridge();
    const port = createKeyboardPort(bridge, 'android');
    const onFrame = vi.fn();
    await port.subscribeFrame(onFrame);
    expect(bridge.addListener).not.toHaveBeenCalled();
    await port.subscribe(vi.fn());
    expect(bridge.addListener.mock.calls.map(call => call[0])).toEqual(['keyboardDidShow', 'keyboardDidHide']);
  });
});

describe('电容配置与接线', () => {
  it('iOS resize 是 None，不是 Native（Native 会在动画结束后 +0.2s 硬切）', () => {
    const source = fs.readFileSync(path.resolve('packages/mobile/capacitor.config.ts'), 'utf8');
    expect(source).toContain('KeyboardResize.None');
    expect(source).not.toMatch(/KeyboardResize\.Native/);
  });

  it('capacitor.ts 把插件和平台交给 createKeyboardPort，不许绕开再订 DidShow 当跟手', () => {
    const source = fs.readFileSync(path.resolve('packages/mobile/src/platform/capacitor.ts'), 'utf8');
    expect(source).toContain('createKeyboardPort(Keyboard, Capacitor.getPlatform())');
    expect(source).not.toMatch(/addListener\('keyboardDidShow'/);
  });

  it('浏览器验收桩也接 subscribeFrame——MobileRoot 必调，缺了会在 effect 里炸', () => {
    for (const file of ['verify-library.mjs', 'verify-host.mjs', 'verify-lan.mjs']) {
      const source = fs.readFileSync(path.resolve('packages/mobile/scripts', file), 'utf8');
      expect(source, file).toContain('subscribeFrame');
    }
  });

  it('会话底部让位含 --keyboard-h，否则输入区抬上去之后最后几条会被键盘盖住', () => {
    const css = fs.readFileSync(path.resolve('packages/mobile/src/styles.css'), 'utf8');
    expect(css).toContain('.lan-messages { overscroll-behavior: contain; padding: 8px 20px calc(20px + var(--composer-h, 132px) + var(--keyboard-h, 0px)); }');
    expect(css).toContain('.jump-latest { position: absolute; bottom: calc(10px + var(--composer-h, 132px) + var(--keyboard-h, 0px));');
    expect(css).toContain('.composer-area[data-keyboard-inset] { padding-bottom: 6px; }');
  });
});
