// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { MobileRoot } from '../../../packages/mobile/src/app/MobileRoot';
import type { NotificationPort, PlatformPorts } from '../../../packages/mobile/src/platform/ports';
import { createIdentity } from '../../../src/shared/companion/noiseChannel';
import { toHex } from '../../../src/shared/companion/lanProtocol';
import { COMPANION_LIMITS } from '../../../src/shared/constants/companion';

/**
 * N-MOBILE-FOREGROUND-PUSH-R2 渲染层（之前单测只到 store）：前台轻提示的落点/自隐/点按/未读点
 * 都长在 MobileRoot 上，ai-review 抓的 Important——「提示渲染在 inert 的 <main> 里，抽屉/弹层开着时
 * 不可点不可读」——只有把组件挂起来才能抓到。LanCompanionClient 整个 mock 掉（drawerSession.test.tsx
 * 的形态），push.open 按 harness 可切：ok=能判归属，throw=判不出（relay 同形）。
 */
const harness = vi.hoisted(() => ({
  pushOpen: 'ok' as 'ok' | 'throw',
  pushOpenSession: 's2',
}));

vi.mock('../../../packages/mobile/src/platform/lanCompanionClient', () => ({
  LanCompanionClient: class {
    async recover() {
      return { version: 1 as const, endpoint: 'http://192.168.1.2:8182', altEndpoint: 'http://imac.local:8182', hostKey: 'aa'.repeat(32), deviceId: 'phone-1', scopeEpoch: 1, scope: ['project:one'] };
    }
    async request(payload: unknown) {
      const action = (payload as { action?: string }).action;
      if (action === 'push.open') {
        if (harness.pushOpen === 'throw') throw new Error('relay: push.open unavailable');
        return { kind: 'open' as const, sessionId: harness.pushOpenSession };
      }
      if (action === 'read') {
        const query = (payload as { query?: { kind?: string; sessionId?: string } }).query;
        if (query?.kind === 'history') return { sessionId: query.sessionId, messages: [], nextOffset: null };
        if (query?.kind === 'artifacts') return { sessionId: query.sessionId, artifacts: [] };
        return {
          sessions: [
            { id: 's1', title: '会话一', projectId: 'one', updatedAt: 2, archived: false, provider: 'deepseek', model: 'deepseek-chat' },
            { id: 's2', title: '会话二', projectId: 'one', updatedAt: 1, archived: false, provider: 'deepseek', model: 'deepseek-chat' },
          ],
          projects: [{ id: 'one', name: 'One', canCreate: true }],
          models: [],
        };
      }
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

/** MobileRoot 把 decideForeground 注册进 foreground.subscribe；测试从这把「前台来推送」灌进去。 */
let firePush: ((routeToken: string | null) => Promise<boolean>) | null = null;

const notifications: NotificationPort = {
  permission: { read: async () => 'granted', request: async () => 'granted' },
  token: { current: async () => ({ kind: 'error', code: 'REGISTRATION_FAILED' }), subscribe: () => () => {} },
  tap: { subscribe: async () => () => {} },
  openSettings: async () => {},
  network: { read: () => 'online' },
  foreground: {
    subscribe: async handler => {
      firePush = handler;
      return () => { firePush = null; };
    },
  },
};

const ports = (): PlatformPorts => ({
  preferences: { get: async () => null, set: async () => {} },
  appInfo: { read: async () => ({ version: '0.1.0', build: '52' }) },
  lifecycle: { subscribe: async () => () => {}, leave: async () => {} },
  keyboard: { subscribe: async () => () => {}, subscribeFrame: async () => () => {}, hide: async () => {} },
  companion: { read: async () => savedWithBinding(), write: async () => {}, scan: async () => { throw new Error('unused'); }, post: async () => ({}) },
  notifications,
});

beforeEach(() => {
  harness.pushOpen = 'ok';
  harness.pushOpenSession = 's2';
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false, media: query, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  }));
  Object.defineProperty(window.navigator, 'language', { value: 'zh-CN', configurable: true });
});

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); cleanup(); });

/** 挂到「连着、库读到、没选会话」的欢迎页（只授权项目的配对）。 */
async function mountApp() {
  await act(async () => { render(<MobileRoot ports={ports()} fixtures={false} />); });
  await waitFor(() => { expect(document.querySelector('[data-testid="project-pick"]')).toBeTruthy(); });
  await waitFor(() => { expect(firePush).toBeTruthy(); });
}

const fireForeground = async (token: string | null) => {
  await act(async () => { await firePush?.(token); });
};

const alertEl = () => document.querySelector('[data-testid="foreground-alert"]') as HTMLElement | null;
const topbarTitle = () => (document.querySelector('.topbar strong') as HTMLElement).textContent;

const openDrawer = async () => {
  fireEvent.click(document.querySelector('[data-testid="open-drawer"]') as HTMLElement);
  await waitFor(() => { expect(document.querySelector('.drawer')).toBeTruthy(); });
};

const selectFromDrawer = async (id: string, title: string) => {
  await openDrawer();
  fireEvent.click(document.querySelector(`[data-testid="session-${id}"]`) as HTMLElement);
  await waitFor(() => { expect(topbarTitle()).toBe(title); });
};

const closeDrawer = async () => {
  fireEvent.click(document.querySelector('.drawer-layer .scrim') as HTMLElement);
  await waitFor(() => { expect(document.querySelector('.drawer-layer')).toBeNull(); });
};

describe('前台轻提示渲染层（N-MOBILE-FOREGROUND-PUSH-R2）', () => {
  it('抽屉开着时收到有归属推送：提示浮在 inert 的 main 之外、可点，点按收提示并跳到那条会话', async () => {
    await mountApp();
    await openDrawer();
    await fireForeground('rt-1');
    const alert = await waitFor(() => {
      const el = alertEl();
      expect(el).toBeTruthy();
      return el as HTMLElement;
    });
    // Important 的形状断言：抽屉开着 ⇒ main 确实 inert，而提示不在它的子树里（挪回 main 内这里就红）。
    expect(document.querySelector('main.conversation')!.hasAttribute('inert')).toBe(true);
    expect(alert.closest('main')).toBeNull();
    expect(alert.closest('[data-testid="foreground-alert-layer"]')).toBeTruthy();
    expect(alert.textContent).toContain('点按查看');
    fireEvent.click(alert);
    await waitFor(() => { expect(alertEl()).toBeNull(); });
    await waitFor(() => { expect(topbarTitle()).toBe('会话二'); });
  });

  it('有归属的提示到点自隐；未读点留下，进了那条会话才算清', async () => {
    await mountApp();
    vi.useFakeTimers();
    await fireForeground('rt-1');
    expect(alertEl()).toBeTruthy();
    // 自隐计时器必须在 fake clock 上注册：先切 fake timers 再灌推送。
    await act(async () => { vi.advanceTimersByTime(COMPANION_LIMITS.foregroundAlertAutoHideMs + 100); });
    expect(alertEl()).toBeNull();
    vi.useRealTimers();
    // 未读点是持久信号：提示闪没了它还在。
    await openDrawer();
    expect(document.querySelector('[data-testid="unread-s2"]')).toBeTruthy();
    await selectFromDrawer('s2', '会话二');
    await selectFromDrawer('s1', '会话一');
    await openDrawer();
    expect(document.querySelector('[data-testid="unread-s2"]')).toBeNull();
  });

  it('判不出归属（查询失败，relay 同形）⇒ 不自隐：提示是唯一痕迹；归属恢复后点按照常跳会话', async () => {
    harness.pushOpen = 'throw';
    await mountApp();
    vi.useFakeTimers();
    await fireForeground('rt-1');
    expect(alertEl()).toBeTruthy();
    await act(async () => { vi.advanceTimersByTime(COMPANION_LIMITS.foregroundAlertAutoHideMs * 2 + 100); });
    expect(alertEl()).toBeTruthy();
    vi.useRealTimers();
    harness.pushOpen = 'ok';
    fireEvent.click(alertEl() as HTMLElement);
    await waitFor(() => { expect(alertEl()).toBeNull(); });
    await waitFor(() => { expect(topbarTitle()).toBe('会话二'); });
  });

  it('没 routeToken 的通用提示同样不自隐；点按只收掉提示，不跳会话不崩', async () => {
    await mountApp();
    vi.useFakeTimers();
    await fireForeground(null);
    expect(alertEl()).toBeTruthy();
    await act(async () => { vi.advanceTimersByTime(COMPANION_LIMITS.foregroundAlertAutoHideMs * 2 + 100); });
    expect(alertEl()).toBeTruthy();
    vi.useRealTimers();
    fireEvent.click(alertEl() as HTMLElement);
    await waitFor(() => { expect(alertEl()).toBeNull(); });
    expect(topbarTitle()).toBe('Neo');
  });

  it('开着抽屉收到本会话推送：关抽屉即视为已读，切走后不留假未读点（Nit①）', async () => {
    await mountApp();
    await selectFromDrawer('s1', '会话一');
    await openDrawer();
    harness.pushOpenSession = 's1';
    await fireForeground('rt-1');
    expect(alertEl()).toBeTruthy();
    await closeDrawer();
    await selectFromDrawer('s2', '会话二');
    await openDrawer();
    expect(document.querySelector('[data-testid="unread-s1"]')).toBeNull();
  });
});
