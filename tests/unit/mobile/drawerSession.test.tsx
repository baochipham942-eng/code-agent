// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { MobileRoot } from '../../../packages/mobile/src/app/MobileRoot';
import type { PlatformPorts } from '../../../packages/mobile/src/platform/ports';
import { createIdentity } from '../../../src/shared/companion/noiseChannel';
import { toHex } from '../../../src/shared/companion/lanProtocol';
import { DRAWER_SETTLE_MS, drawerWidthPx } from '../../../packages/mobile/src/app/drawerGesture';

/**
 * fix5-①②（2026-09-15 build 36 反馈⑦）：点历史会话收边栏；抽屉开着时从会话行（button）上
 * 起手左拖关闭，且拖拽成立后的合成 click 必须吞掉（拖一半松手不能变成点中会话）。
 * LanCompanionClient 整个 mock 掉（sheetLibraryWait.test.tsx 的形态），绑定带两条会话。
 */
vi.mock('../../../packages/mobile/src/platform/lanCompanionClient', () => ({
  LanCompanionClient: class {
    async recover() {
      return { version: 1 as const, endpoint: 'http://192.168.1.2:8182', altEndpoint: 'http://imac.local:8182', hostKey: 'aa'.repeat(32), deviceId: 'phone-1', scopeEpoch: 1, scope: ['project:one'] };
    }
    async request(payload: unknown) {
      const action = (payload as { action?: string }).action;
      if (action === 'read') return {
        sessions: [
          { id: 's1', title: '会话一', projectId: 'one', updatedAt: 2, archived: false, provider: 'deepseek', model: 'deepseek-chat' },
          { id: 's2', title: '会话二', projectId: 'one', updatedAt: 1, archived: false, provider: 'deepseek', model: 'deepseek-chat' },
        ],
        projects: [{ id: 'one', name: 'One', canCreate: true }],
        models: [],
      };
      return { kind: 'events', epoch: 1, nextSeq: 0, events: [] };
    }
    close() {}
  },
}));

function savedWithBinding(): string {
  const identity = createIdentity();
  return JSON.stringify({
    version: 1, publicKey: toHex(identity.publicKey), secretKey: toHex(identity.secretKey),
    binding: { version: 1, endpoint: 'http://192.168.1.2:8182', altEndpoint: 'http://imac.local:8182', hostKey: toHex(identity.publicKey), deviceId: 'phone-1', scopeEpoch: 1, scope: ['project:one'] },
  });
}

const ports = (): PlatformPorts => ({
  preferences: { get: async () => null, set: async () => {} },
  appInfo: { read: async () => ({ version: '0.1.0', build: '36' }) },
  lifecycle: { subscribe: async () => () => {}, leave: async () => {} },
  keyboard: { subscribe: async () => () => {}, subscribeFrame: async () => () => {}, hide: async () => {} },
  companion: { read: async () => savedWithBinding(), write: async () => {}, scan: async () => { throw new Error('unused'); }, post: async () => ({}) },
});

beforeEach(() => {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false, media: query, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  }));
  Object.defineProperty(window.navigator, 'language', { value: 'zh-CN', configurable: true });
});

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); cleanup(); });

// jsdom 视口 1024px ⇒ 抽屉宽 min(86vw, 360) = 360，过半线 180。
const HALF = drawerWidthPx(window.innerWidth) / 2;

async function mountWithDrawerOpen() {
  await act(async () => { render(<MobileRoot ports={ports()} fixtures={false} />); });
  await waitFor(() => { expect(document.querySelector('.app')).toBeTruthy(); });
  // 只授权项目 ⇒ 连上后自动弹项目 sheet（needsLibraryPick）；sheet 挂着时抽屉开不了，先关掉
  await waitFor(() => { expect(document.querySelector('[data-testid="sheet-host"]')).toBeTruthy(); });
  fireEvent.click(document.querySelector('.sheet-header button[aria-label="关闭弹层"]') as HTMLElement);
  await waitFor(() => { expect(document.querySelector('[data-testid="sheet-host"]')).toBeNull(); });
  fireEvent.click(document.querySelector('[data-testid="open-drawer"]') as HTMLElement);
  const row = await waitFor(() => {
    const el = document.querySelector('[data-testid="session-s2"]') as HTMLElement;
    expect(el).toBeTruthy();
    return el;
  }, { timeout: 3000 });
  await waitFor(() => { expect(document.querySelector('.drawer')).toBeTruthy(); });
  return { app: document.querySelector('.app') as HTMLElement, row };
}

/** 顶栏标题 = 当前会话名（未选会话时是「Neo」）——用它在拖拽用例里证明会话没被换。 */
const topbarTitle = () => (document.querySelector('.topbar strong') as HTMLElement).textContent;

async function settle() {
  await act(async () => { vi.advanceTimersByTime(DRAWER_SETTLE_MS + 10); });
}

describe('fix5-①：点历史会话收边栏', () => {
  it('轻点会话行（touchstart+touchend+click 真机形态）后抽屉关闭、进入所选会话', async () => {
    const { app, row } = await mountWithDrawerOpen();
    fireEvent.touchStart(row, { touches: [{ clientX: 200, clientY: 300, identifier: 1 }] });
    fireEvent.touchEnd(row, { changedTouches: [{ clientX: 200, clientY: 300, identifier: 1 }] });
    fireEvent.click(row);
    await waitFor(() => { expect(document.querySelector('.drawer-layer')).toBeNull(); });
    expect(topbarTitle()).toBe('会话二');
    expect(app).toBeTruthy();
  });
});

describe('fix5-②：button 起点拖关 + 拖拽成立后吞 click', () => {
  it('从会话行按钮上左拖过半松手 → 抽屉关、会话没被换（合成 click 被吞）', async () => {
    const { app, row } = await mountWithDrawerOpen();
    vi.useFakeTimers();
    fireEvent.touchStart(row, { touches: [{ clientX: 300, clientY: 300, identifier: 1 }] });
    fireEvent.touchMove(app, { touches: [{ clientX: 300 - HALF - 60, clientY: 304, identifier: 1 }] });
    fireEvent.touchEnd(app, { changedTouches: [{ clientX: 300 - HALF - 60, clientY: 304, identifier: 1 }] });
    // 真机在这里合成 click：起手与落点同在宽会话行上，click 落在会话按钮上——必须被吞掉
    fireEvent.click(row);
    expect(topbarTitle()).toBe('Neo');
    await settle();
    expect(document.querySelector('.drawer-layer')).toBeNull();
    expect(topbarTitle()).toBe('Neo');
  });

  it('拖不过半松手 → 回弹保持开，同样不吞成点中会话', async () => {
    const { app, row } = await mountWithDrawerOpen();
    vi.useFakeTimers();
    fireEvent.touchStart(row, { touches: [{ clientX: 300, clientY: 300, identifier: 1 }] });
    fireEvent.touchMove(app, { touches: [{ clientX: 300 - 60, clientY: 304, identifier: 1 }] });
    fireEvent.touchEnd(app, { changedTouches: [{ clientX: 300 - 60, clientY: 304, identifier: 1 }] });
    fireEvent.click(row);
    await settle();
    expect(document.querySelector('.drawer')).toBeTruthy();
    expect(topbarTitle()).toBe('Neo');
  });

  it('拖拽吞 click 只吞一次：窗口内跟来的第二个真实点按照常生效', async () => {
    const { app, row } = await mountWithDrawerOpen();
    vi.useFakeTimers();
    fireEvent.touchStart(row, { touches: [{ clientX: 300, clientY: 300, identifier: 1 }] });
    fireEvent.touchMove(app, { touches: [{ clientX: 300 - HALF - 60, clientY: 304, identifier: 1 }] });
    fireEvent.touchEnd(app, { changedTouches: [{ clientX: 300 - HALF - 60, clientY: 304, identifier: 1 }] });
    fireEvent.click(row);   // 拖拽副产品：吞
    fireEvent.click(row);   // 用户紧跟着的真实点按：放行（fireEvent 自带 act 同步 flush）
    expect(topbarTitle()).toBe('会话二');
    await settle();
    expect(document.querySelector('.drawer-layer')).toBeNull();
    expect(app).toBeTruthy();
  });

  it('吞 click 窗口过了自动复位：下一个点按不受上一个拖拽影响', async () => {
    const { app, row } = await mountWithDrawerOpen();
    vi.useFakeTimers();
    // 先拖一下又推回原位（反悔），抽屉保持开
    fireEvent.touchStart(row, { touches: [{ clientX: 300, clientY: 300, identifier: 1 }] });
    fireEvent.touchMove(app, { touches: [{ clientX: 260, clientY: 304, identifier: 1 }] });
    fireEvent.touchEnd(app, { changedTouches: [{ clientX: 300, clientY: 304, identifier: 1 }] });
    fireEvent.click(row);   // 被吞
    expect(topbarTitle()).toBe('Neo');
    await act(async () => { vi.advanceTimersByTime(400); });   // 吞 click 窗口（300ms）过了
    fireEvent.click(row);
    expect(topbarTitle()).toBe('会话二');
    expect(document.querySelector('.drawer-layer')).toBeNull();
  });
});
