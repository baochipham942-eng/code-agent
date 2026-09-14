// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { MobileRoot } from '../../../packages/mobile/src/app/MobileRoot';
import type { PlatformPorts } from '../../../packages/mobile/src/platform/ports';

// 抽屉手势判定（爸 2026-09-14 build 34 反馈①：右滑打不开抽屉——左缘起滑被 gestureStart
// 的 clientX < 24 一刀切丢弃）。照 viewportHeightThrottle.test.tsx 的最小端口形态。
const ports: PlatformPorts = {
  preferences: { get: async () => null, set: async () => {} },
  appInfo: { read: async () => ({ version: '0.1.0', build: '34' }) },
  lifecycle: { subscribe: async () => () => {}, leave: async () => {} },
  keyboard: { subscribe: async () => () => {}, subscribeFrame: async () => () => {}, hide: async () => {} },
};

beforeEach(() => {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false, media: query, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  }));
});

async function mount() {
  await act(async () => { render(<MobileRoot ports={ports} fixtures={false} />); });
  await waitFor(() => { expect(document.querySelector('.app')).toBeTruthy(); });
  return document.querySelector('.app') as HTMLElement;
}

function swipe(app: HTMLElement, from: { x: number; y: number }, to: { x: number; y: number }) {
  fireEvent.touchStart(app, { touches: [{ clientX: from.x, clientY: from.y, identifier: 1 }] });
  fireEvent.touchEnd(app, { changedTouches: [{ clientX: to.x, clientY: to.y, identifier: 1 }] });
}

afterEach(() => { vi.unstubAllGlobals(); cleanup(); });

describe('抽屉手势（2026-09-14 反馈①：左缘起滑要能开抽屉）', () => {
  it('左缘起滑、向右滑够位移即开抽屉——此前 clientX < 24 在 gestureStart 就被丢弃', async () => {
    const app = await mount();
    swipe(app, { x: 10, y: 400 }, { x: 90, y: 408 });
    expect(document.querySelector('.drawer')).toBeTruthy();
  });

  it('左缘起滑但位移不足不开——缘区门槛是 56px，不是碰一下就开', async () => {
    const app = await mount();
    swipe(app, { x: 10, y: 400 }, { x: 40, y: 404 });
    expect(document.querySelector('.drawer')).toBeNull();
  });

  it('左缘起滑但主要是竖向移动不开——缘区手势不与正文竖向滚动冲突', async () => {
    const app = await mount();
    swipe(app, { x: 10, y: 400 }, { x: 90, y: 520 });
    expect(document.querySelector('.drawer')).toBeNull();
  });

  it('正文区右滑开抽屉的既有行为保留（86px 门槛）', async () => {
    const app = await mount();
    swipe(app, { x: 200, y: 400 }, { x: 330, y: 406 });
    expect(document.querySelector('.drawer')).toBeTruthy();
  });

  it('正文区右滑位移不足仍不开；抽屉开着时左滑关上', async () => {
    const app = await mount();
    swipe(app, { x: 200, y: 400 }, { x: 270, y: 404 });
    expect(document.querySelector('.drawer')).toBeNull();
    swipe(app, { x: 200, y: 400 }, { x: 330, y: 406 });
    expect(document.querySelector('.drawer')).toBeTruthy();
    swipe(app, { x: 300, y: 400 }, { x: 180, y: 404 });
    expect(document.querySelector('.drawer')).toBeNull();
  });

  it('起滑点落在按钮上不跟踪手势（点按钮本身仍可开抽屉，滑动交给按钮语义）', async () => {
    await mount();
    const menu = document.querySelector('[data-testid="open-drawer"]') as HTMLElement;
    expect(menu).toBeTruthy();
    fireEvent.touchStart(menu, { touches: [{ clientX: 20, clientY: 40, identifier: 1 }] });
    fireEvent.touchEnd(menu, { changedTouches: [{ clientX: 120, clientY: 44, identifier: 1 }] });
    expect(document.querySelector('.drawer')).toBeNull();
  });
});
