// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { MobileRoot } from '../../../packages/mobile/src/app/MobileRoot';
import type { PlatformPorts } from '../../../packages/mobile/src/platform/ports';

// 最小可渲染端口：只填 MobileRoot 必需的四个，其余可选口一概不给
// （不给就是「这台宿主没有这个能力」，正是本判据不关心的那些）。
const ports: PlatformPorts = {
  preferences: { get: async () => null, set: async () => {} },
  appInfo: { read: async () => ({ version: '0.1.0', build: '30' }) },
  lifecycle: { subscribe: async () => () => {}, leave: async () => {} },
  keyboard: { subscribe: async () => () => {}, subscribeFrame: async () => () => {}, hide: async () => {} },
};

// jsdom 没有 matchMedia / visualViewport；前者 MobileRoot 挂载时就要用，后者缺席时代码
// 自己退回 innerHeight——本判据量的是「写几次」，不是写了什么值，退回路径同样成立。
beforeEach(() => {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false, media: query, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  }));
});

describe('--viewport-height 每帧最多写一次（爸 2026-09-13：焦点+键盘等了一会儿）', () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); cleanup(); });

  it('一帧内几十次 resize 只落地一次样式写入', async () => {
    vi.useFakeTimers();
    const writes: string[] = [];
    const real = document.documentElement.style.setProperty.bind(document.documentElement.style);
    vi.spyOn(document.documentElement.style, 'setProperty').mockImplementation((name, value) => {
      if (name === '--viewport-height') writes.push(String(value));
      return real(name, value as string);
    });

    await act(async () => { render(<MobileRoot ports={ports} fixtures={false} />); });
    // 首帧要直接落地，别等下一帧才有高度
    expect(writes.length).toBe(1);
    writes.length = 0;

    // iOS 键盘那 ~300ms 动画里 visualViewport 会连着触发几十次
    act(() => { for (let i = 0; i < 40; i += 1) window.dispatchEvent(new Event('resize')); });
    expect(writes.length).toBe(0);   // 还没到帧边界，一次都不许写

    await act(async () => { await vi.advanceTimersByTimeAsync(20); });
    expect(writes.length).toBe(1);   // 整整 40 次只落地一次
  });

  it('下一帧的 resize 照常落地——节流不是丢事件', async () => {
    vi.useFakeTimers();
    const writes: string[] = [];
    const real = document.documentElement.style.setProperty.bind(document.documentElement.style);
    vi.spyOn(document.documentElement.style, 'setProperty').mockImplementation((name, value) => {
      if (name === '--viewport-height') writes.push(String(value));
      return real(name, value as string);
    });
    await act(async () => { render(<MobileRoot ports={ports} fixtures={false} />); });
    writes.length = 0;

    for (const _ of [1, 2, 3]) {
      act(() => { window.dispatchEvent(new Event('resize')); });
      await act(async () => { await vi.advanceTimersByTimeAsync(20); });
    }
    expect(writes.length).toBe(3);
  });
});
