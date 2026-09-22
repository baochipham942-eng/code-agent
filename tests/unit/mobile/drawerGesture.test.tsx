// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { MobileRoot } from '../../../packages/mobile/src/app/MobileRoot';
import type { PlatformPorts } from '../../../packages/mobile/src/platform/ports';
import {
  DRAWER_SETTLE_MS, drawerPanOffset, drawerPanState, drawerWidthPx, gestureAxis, shouldSwallowClick,
} from '../../../packages/mobile/src/app/drawerGesture';

// 抽屉手势（fix4-①，2026-09-15 build 35 反馈⑥）：左缘起滑从 touchend 死手势改成
// 交互式拖拽——touchmove 1:1 跟手、松手按速度+过半双判据。照 viewportHeightThrottle.test.tsx
// 的最小端口形态。
const ports: PlatformPorts = {
  preferences: { get: async () => null, set: async () => {} },
  appInfo: { read: async () => ({ version: '0.1.0', build: '35' }) },
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

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); cleanup(); });

async function mount() {
  await act(async () => { render(<MobileRoot ports={ports} fixtures={false} />); });
  await waitFor(() => { expect(document.querySelector('.app')).toBeTruthy(); });
  return document.querySelector('.app') as HTMLElement;
}

// jsdom 视口 1024px ⇒ 抽屉宽 min(86vw, 360) = 360，过半线 180。
const WIDTH = drawerWidthPx(window.innerWidth);
const HALF = WIDTH / 2;

function start(app: HTMLElement, x: number, y: number) {
  fireEvent.touchStart(app, { touches: [{ clientX: x, clientY: y, identifier: 1 }] });
}
function move(app: HTMLElement, x: number, y: number) {
  fireEvent.touchMove(app, { touches: [{ clientX: x, clientY: y, identifier: 1 }] });
}
function end(app: HTMLElement, x: number, y: number) {
  fireEvent.touchEnd(app, { changedTouches: [{ clientX: x, clientY: y, identifier: 1 }] });
}
/** 拖到 to 松手。中途给一帧 move，模拟真实拖拽（也保证 velocity 采样有末帧）。 */
function drag(app: HTMLElement, from: { x: number; y: number }, to: { x: number; y: number }) {
  start(app, from.x, from.y);
  move(app, Math.round((from.x + to.x) / 2), Math.round((from.y + to.y) / 2));
  end(app, to.x, to.y);
}
/** 松手后等回弹动画 commit（settle 定时器）。 */
async function settle() {
  await act(async () => { vi.advanceTimersByTime(DRAWER_SETTLE_MS + 10); });
}
function layer(): HTMLElement | null {
  return document.querySelector('[data-testid="drawer-layer"]');
}

describe('纯判定：gestureAxis（起手 ≈10px 内判横竖）', () => {
  it('位移没到锁轴门槛不认手势', () => {
    expect(gestureAxis(5, 3)).toBeNull();
    expect(gestureAxis(4, 9)).toBeNull();
  });
  it('横竖分明认横向；竖滑让位滚动', () => {
    expect(gestureAxis(30, 5)).toBe('horizontal');
    expect(gestureAxis(5, 30)).toBe('vertical');
  });
  it('缘区起滑横滑门槛降到 2px——边缘起滑优先认抽屉', () => {
    expect(gestureAxis(3, 1, true)).toBe('horizontal');
    expect(gestureAxis(3, 1, false)).toBeNull();
  });
  it('缘区也不抢竖滑：|dy|>|dx| 照样让位（竖向滚动不被边缘手势吃掉）', () => {
    expect(gestureAxis(8, 30, true)).toBe('vertical');
  });
});

describe('纯判定：drawerPanState（松手速度+过半双判据）', () => {
  it('快 flick 不过半也开（|v|>0.5px/ms 按方向直接落态）', () => {
    expect(drawerPanState(40, 1, false, WIDTH)).toBe('open');
    expect(drawerPanState(-40, -1, true, WIDTH)).toBe('close');
  });
  it('flick 方向与拖拽方向相反时以速度为准（回甩也认）', () => {
    expect(drawerPanState(-120, 1, false, WIDTH)).toBe('open');
  });
  it('慢拖看过半：过半开、不过半回弹', () => {
    expect(drawerPanState(HALF + 20, 0, false, WIDTH)).toBe('open');
    expect(drawerPanState(HALF - 20, 0, false, WIDTH)).toBe('close');
  });
  it('开着时左拖过半关、小位移推回（反悔）保持开', () => {
    expect(drawerPanState(-(HALF + 20), 0, true, WIDTH)).toBe('close');
    expect(drawerPanState(-(HALF - 20), 0, true, WIDTH)).toBe('open');
    expect(drawerPanState(0, 0, true, WIDTH)).toBe('open');
  });
});

describe('纯判定：drawerPanOffset（1:1 跟手的 clamp）', () => {
  it('关→开从 -width 拖进可视区，clamp 在 [-width,0]', () => {
    expect(drawerPanOffset(0, WIDTH, false)).toBe(-WIDTH);
    expect(drawerPanOffset(120, WIDTH, false)).toBe(-WIDTH + 120);
    expect(drawerPanOffset(WIDTH + 80, WIDTH, false)).toBe(0);
    expect(drawerPanOffset(-40, WIDTH, false)).toBe(-WIDTH);
  });
  it('开→关向左拖为负，右拖不越界', () => {
    expect(drawerPanOffset(-100, WIDTH, true)).toBe(-100);
    expect(drawerPanOffset(50, WIDTH, true)).toBe(0);
    expect(drawerPanOffset(-WIDTH - 50, WIDTH, true)).toBe(-WIDTH);
  });
});

describe('纯判定：shouldSwallowClick（fix5-②：锁轴拖拽后吞合成 click）', () => {
  it('横向锁轴成立 → 吞（button 起点拖关后松手，click 不许变成点中会话）', () => {
    expect(shouldSwallowClick('horizontal')).toBe(true);
  });
  it('轻点没锁轴（axis=null）→ 不吞，click 就是用户本意', () => {
    expect(shouldSwallowClick(null)).toBe(false);
  });
  it('竖向锁轴不吞（值会位滚动让位，列全只为类型完整）', () => {
    expect(shouldSwallowClick('vertical')).toBe(false);
  });
});

describe('组件：边缘起滑跟手拖拽', () => {
  it('左缘起滑、touchmove 阶段抽屉 1:1 跟手（层挂载 + translateX 同步）', async () => {
    const app = await mount();
    start(app, 10, 400);
    move(app, 10 + 90, 405);
    const dragging = layer();
    expect(dragging).toBeTruthy();
    expect(dragging!.style.getPropertyValue('--drawer-x')).toBe(`${-WIDTH + 90}px`);
    move(app, 10 + 150, 405);
    expect(layer()!.style.getPropertyValue('--drawer-x')).toBe(`${-WIDTH + 150}px`);
  });

  it('竖滑不抢：左缘起滑但主要竖向移动，抽屉层不挂载', async () => {
    const app = await mount();
    start(app, 10, 400);
    move(app, 18, 460);
    expect(layer()).toBeNull();
    end(app, 20, 520);
    expect(layer()).toBeNull();
  });

  it('拖过半松手 → 回弹到开；commit 后抽屉常驻', async () => {
    const app = await mount();
    vi.useFakeTimers();
    drag(app, { x: 10, y: 400 }, { x: 10 + HALF + 20, y: 404 });
    // 回弹动画期间层还在（settling），动画时长后 commit 成开
    await settle();
    expect(layer()).toBeTruthy();
    expect(document.querySelector('.drawer')).toBeTruthy();
  });

  it('拖不过半松手 → 回弹到关，层卸载', async () => {
    const app = await mount();
    vi.useFakeTimers();
    drag(app, { x: 10, y: 400 }, { x: 10 + HALF - 80, y: 404 });
    await settle();
    expect(layer()).toBeNull();
    expect(document.querySelector('.drawer')).toBeNull();
  });

  it('正文区右滑跟手开抽屉（点按钮本身不受影响：无位移不锁轴）', async () => {
    const app = await mount();
    vi.useFakeTimers();
    drag(app, { x: 200, y: 400 }, { x: 200 + HALF + 40, y: 404 });
    await settle();
    expect(document.querySelector('.drawer')).toBeTruthy();
  });

  it('起滑点落在正文按钮上不跟踪手势（滑动交给按钮语义，点按仍开抽屉）', async () => {
    const app = await mount();
    const menu = document.querySelector('[data-testid="open-drawer"]') as HTMLElement;
    expect(menu).toBeTruthy();
    start(menu, 20, 40);
    move(app, 150, 44);
    expect(layer()).toBeNull();
    end(app, 150, 44);
    expect(document.querySelector('.drawer')).toBeNull();
    fireEvent.click(menu);
    await waitFor(() => { expect(document.querySelector('.drawer')).toBeTruthy(); });
  });
});

describe('组件：抽屉开着时左滑关闭同样跟手', () => {
  // mount 与 waitFor 都要真定时器；settle 断言前再切 fake（waitFor 的轮询吃真时钟）。
  async function openDrawer() {
    const app = await mount();
    fireEvent.click(document.querySelector('[data-testid="open-drawer"]') as HTMLElement);
    await waitFor(() => { expect(document.querySelector('.drawer')).toBeTruthy(); });
    vi.useFakeTimers();
    return app;
  }

  it('开着时从抽屉按钮上起手也能拖关（按钮没有横滑语义）', async () => {
    const app = await openDrawer();
    const drawerButton = document.querySelector('.drawer-functions button') as HTMLElement;
    start(drawerButton, 300, 60);
    move(app, 300 - 120, 64);
    expect(layer()).toBeTruthy();
    expect(layer()!.style.getPropertyValue('--drawer-x')).toBe('-120px');
  });

  it('左拖过半松手 → 回弹到关，层卸载', async () => {
    const app = await openDrawer();
    drag(app, { x: 300, y: 400 }, { x: 300 - HALF - 40, y: 404 });
    await settle();
    expect(layer()).toBeNull();
    expect(document.querySelector('.drawer')).toBeNull();
  });

  it('反悔推回：左拖一段又推回原位松手，抽屉保持开', async () => {
    const app = await openDrawer();
    start(app, 300, 400);
    move(app, 300 - 150, 404);
    move(app, 300, 404);
    end(app, 300, 404);
    await settle();
    expect(document.querySelector('.drawer')).toBeTruthy();
  });

  it('系统夺走手势（touchcancel）时按当前态回弹，不卡半开', async () => {
    const app = await openDrawer();
    start(app, 300, 400);
    move(app, 300 - 150, 404);
    expect(layer()).toBeTruthy();
    fireEvent.touchCancel(app, {});
    await settle();
    expect(document.querySelector('.drawer')).toBeTruthy();
  });
});
