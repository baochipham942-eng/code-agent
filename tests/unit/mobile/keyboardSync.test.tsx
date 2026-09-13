// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { MobileRoot } from '../../../packages/mobile/src/app/MobileRoot';
import type { KeyboardFrame, PlatformPorts } from '../../../packages/mobile/src/platform/ports';

describe('输入区跟 iOS 键盘 willShow 同步（爸 2026-09-13：同一条曲线）', () => {
  let onVisible: ((visible: boolean) => void) | undefined;
  let onFrame: ((frame: KeyboardFrame) => void) | undefined;
  const ports: PlatformPorts = {
    preferences: { get: async () => null, set: async () => {} },
    appInfo: { read: async () => ({ version: '0.1.0', build: '31' }) },
    lifecycle: { subscribe: async () => () => {}, leave: async () => {} },
    keyboard: {
      subscribe: async cb => { onVisible = cb; return () => { onVisible = undefined; }; },
      subscribeFrame: async cb => { onFrame = cb; return () => { onFrame = undefined; }; },
      hide: async () => {},
    },
  };

  beforeEach(() => {
    onVisible = undefined;
    onFrame = undefined;
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: false, media: query, onchange: null,
      addEventListener: () => {}, removeEventListener: () => {},
      addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
    }));
    vi.stubGlobal('visualViewport', {
      height: 800,
      addEventListener: () => {},
      removeEventListener: () => {},
    });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
  });

  afterEach(() => {
    vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); cleanup();
    document.documentElement.style.removeProperty('--keyboard-h');
    document.documentElement.style.removeProperty('--keyboard-duration');
    document.documentElement.style.removeProperty('--keyboard-easing');
    document.documentElement.removeAttribute('data-keyboard-inset');
  });

  async function mount() {
    await act(async () => { render(<MobileRoot ports={ports} fixtures={false} />); });
    await waitFor(() => {
      expect(document.querySelector('.composer-area')).toBeTruthy();
      expect(onFrame).toEqual(expect.any(Function));
      expect(onVisible).toEqual(expect.any(Function));
    });
  }

  it('willShow 立刻抬输入区；DidShow 只改可见性，不再改 transform', async () => {
    await mount();
    const area = document.querySelector('.composer-area') as HTMLElement;
    act(() => { onFrame!({ height: 336, phase: 'will-show' }); });
    expect(area.style.transform).toBe('translate3d(0, -336px, 0)');
    expect(document.documentElement.style.getPropertyValue('--keyboard-h')).toBe('336px');

    const afterWill = area.style.transform;
    act(() => { onVisible!(true); });
    expect(area.style.transform).toBe(afterWill);
  });

  it('只有 DidShow、没有 willShow 时输入区不许动——订错事件就会在这里红', async () => {
    await mount();
    const area = document.querySelector('.composer-area') as HTMLElement;
    act(() => { onVisible!(true); });
    expect(area.style.transform).toBe('');
    expect(document.documentElement.style.getPropertyValue('--keyboard-h')).toBe('');
  });

  it('键盘升起后 visualViewport 缩小不许改 --viewport-height；willHide 仍冻结，DidHide 才解冻', async () => {
    await mount();
    const writes: string[] = [];
    const real = document.documentElement.style.setProperty.bind(document.documentElement.style);
    vi.spyOn(document.documentElement.style, 'setProperty').mockImplementation((name, value) => {
      if (name === '--viewport-height') writes.push(String(value));
      return real(name, value as string);
    });

    act(() => { onFrame!({ height: 336, phase: 'will-show' }); });
    expect(writes.at(-1)).toBe('800px');
    writes.length = 0;

    vi.useFakeTimers();
    (window.visualViewport as { height: number }).height = 464;
    act(() => { window.dispatchEvent(new Event('resize')); });
    expect(writes.length).toBe(0);
    await act(async () => { await vi.advanceTimersByTimeAsync(20); });
    expect(writes).toEqual(['800px']);
    writes.length = 0;

    const area = document.querySelector('.composer-area') as HTMLElement;
    act(() => { onFrame!({ height: 0, phase: 'will-hide' }); });
    expect(area.style.transform).toBe('none');

    act(() => { window.dispatchEvent(new Event('resize')); });
    await act(async () => { await vi.advanceTimersByTimeAsync(20); });
    expect(writes).toEqual(['800px']);
    writes.length = 0;

    act(() => { onVisible!(false); });
    expect(writes).toEqual(['464px']);
  });
});
