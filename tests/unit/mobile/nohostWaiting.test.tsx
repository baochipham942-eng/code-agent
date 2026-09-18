// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { MobileRoot } from '../../../packages/mobile/src/app/MobileRoot';
import type { PlatformPorts } from '../../../packages/mobile/src/platform/ports';
import { createIdentity } from '../../../src/shared/companion/noiseChannel';
import { toHex } from '../../../src/shared/companion/lanProtocol';
import { messages } from '../../../packages/mobile/src/i18n';

const text = messages('zh');

/**
 * N-MOBILE-NOHOST-WAKING-STATE 的接线层：经中继拨到 no-host 后，连接电脑 sheet 与输入区
 * 状态位都显示「等电脑上线…」过渡态（不渲染失败页），15s 到点才落回 remote-unreachable。
 * store 节拍（3s/15s/点按重置/抢占）在 relayPath.test.ts；这里钉 UI 两个面与文案契约。
 */
const harness = vi.hoisted(() => ({
  lanError: null as string | null,
  relayError: null as string | null,
  relayConstructed: 0,
}));

vi.mock('../../../packages/mobile/src/platform/lanCompanionClient', () => ({
  LanCompanionClient: class {
    async pair() { throw new Error('unused'); }
    async recover() {
      if (harness.lanError) throw new Error(harness.lanError);
      return { version: 1 as const, endpoint: 'http://192.168.1.2:8182', hostKey: 'aa'.repeat(32), deviceId: 'phone-1', scopeEpoch: 1, scope: ['shared'] };
    }
    async request() { return { kind: 'events', epoch: 1, nextSeq: 0, events: [] }; }
    close() {}
  },
}));

vi.mock('../../../packages/mobile/src/platform/relayCompanionClient', () => ({
  browserRelayDial: () => { throw new Error('test must inject dialRelay'); },
  RelayCompanionClient: class {
    constructor() { harness.relayConstructed += 1; }
    async connect() { if (harness.relayError) throw new Error(harness.relayError); }
    async resume() { if (harness.relayError) throw new Error(harness.relayError); }
    async request() { return { kind: 'events', epoch: 1, nextSeq: 0, events: [] }; }
    close() {}
  },
}));

const identity = createIdentity();

function savedWithRelayRoute(): string {
  return JSON.stringify({
    version: 1, publicKey: toHex(identity.publicKey), secretKey: toHex(identity.secretKey),
    binding: { version: 1, endpoint: 'http://192.168.1.2:8182', hostKey: toHex(identity.publicKey), deviceId: 'phone-1', scopeEpoch: 1, scope: ['shared'] },
    relay: { v: 1, url: 'ws://127.0.0.1:8791/', routeToken: 'route-token-aaaaaa', credential: 'relay-shared-credential' },
  });
}

const ports = (): PlatformPorts => ({
  preferences: { get: async () => null, set: async () => {} },
  appInfo: { read: async () => ({ version: '0.1.0', build: '50' }) },
  lifecycle: { subscribe: async () => () => {}, leave: async () => {} },
  keyboard: { subscribe: async () => () => {}, subscribeFrame: async () => () => {}, hide: async () => {} },
  companion: {
    read: async () => savedWithRelayRoute(), write: async () => {}, scan: async () => { throw new Error('unused'); }, post: async () => ({}),
    dialRelay: () => ({ send: () => {}, close: () => {}, onOpen: () => {}, onClose: () => {}, onError: () => {}, onMessage: () => {} }),
  },
});

/** fake timers 下没有 waitFor 可用：用 advanceTimersByTimeAsync(0) 一轮轮排空微任务链直到谓词成立。 */
async function flushUntil(predicate: () => boolean, what: string, rounds = 25) {
  for (let i = 0; i < rounds && !predicate(); i++) await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(predicate(), what).toBe(true);
}

async function mountInNoHostWait() {
  await act(async () => { render(<MobileRoot ports={ports()} fixtures={false} />); });
  // hydrate → reconnect → LAN 失败 → relay no-host → 过渡态：状态位翻出等待句
  await flushUntil(() => document.querySelector('[data-testid="status-slot"]')?.textContent?.includes(text.connectionWaitingForHost) === true, '状态位显示等待句');
}

function openRemoteSheet() {
  fireEvent.click(document.querySelector('[data-testid="status-open"]')!);
}

describe('no-host 过渡态 UI（连接电脑 sheet + 输入区状态位）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    harness.lanError = 'COMPANION_NETWORK_UNAVAILABLE';
    harness.relayError = 'COMPANION_RELAY_NO_HOST';
    harness.relayConstructed = 0;
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: false, media: query, onchange: null,
      addEventListener: () => {}, removeEventListener: () => {},
      addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
    }));
    Object.defineProperty(window.navigator, 'language', { value: 'zh-CN', configurable: true });
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    harness.lanError = null;
    harness.relayError = null;
  });

  it('① 状态位与连接电脑 sheet 都显示等待句，不渲染失败页；「重新连接」保留可用', async () => {
    await mountInNoHostWait();
    const slot = document.querySelector('[data-testid="status-slot"]') as HTMLElement;
    expect(slot.dataset.rank).toBe('2');
    expect(slot.dataset.reason).toBe('relay-no-host-wait');
    expect(slot.querySelector('.status-text')?.textContent).toBe(text.connectionWaitingForHost);
    expect(slot.querySelector('[data-testid="status-action"]')?.textContent).toBe(text.reconnect);
    openRemoteSheet();
    await flushUntil(() => Boolean(document.querySelector('[data-testid="remote-waiting-host"]')), 'sheet 显示等待视图');
    expect(document.querySelector('[data-testid="remote-unreachable"]')).toBeNull();
    const waiting = document.querySelector('[data-testid="remote-waiting-host"]') as HTMLElement;
    expect(waiting.getAttribute('role')).toBe('status');
    expect(waiting.textContent).toContain(text.connectionWaitingForHost);
    const button = document.querySelector('[data-testid="remote-waiting-reconnect"]') as HTMLButtonElement;
    expect(button.textContent).toBe(text.reconnect);
    expect(button.disabled).toBe(false);
  });

  it('③ 15s 到点：sheet 落回现有失败页（remote-unreachable + 重新连接在），失败文案一字不改', async () => {
    await mountInNoHostWait();
    openRemoteSheet();
    await flushUntil(() => Boolean(document.querySelector('[data-testid="remote-waiting-host"]')), 'sheet 显示等待视图');
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    await flushUntil(() => Boolean(document.querySelector('[data-testid="remote-unreachable"]')), '到点渲染失败页');
    expect(document.querySelector('[data-testid="remote-waiting-host"]')).toBeNull();
    const failed = document.querySelector('[data-testid="remote-unreachable"]') as HTMLElement;
    expect(failed.textContent).toContain(text.cannotReachComputer);
    expect(failed.textContent).toContain(text.connectionRelayNoHost);
    expect(document.querySelector('[data-testid="remote-action-reconnect"]')?.textContent).toBe(text.reconnect);
  });

  it('④ 过渡态点「重新连接」：立即多一次拨号，仍停留等待视图（不落失败页）', async () => {
    await mountInNoHostWait();
    openRemoteSheet();
    await flushUntil(() => Boolean(document.querySelector('[data-testid="remote-waiting-reconnect"]')), '等待视图的重新连接按钮在');
    const before = harness.relayConstructed;
    fireEvent.click(document.querySelector('[data-testid="remote-waiting-reconnect"]')!);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(harness.relayConstructed).toBe(before + 1); // 立即重拨，不等下一个 3s 拍
    expect(document.querySelector('[data-testid="remote-waiting-host"]')).toBeTruthy();
    expect(document.querySelector('[data-testid="remote-unreachable"]')).toBeNull();
  });
});

describe('no-host 过渡态文案契约', () => {
  it.each(['zh', 'en'])('%s：等待句不含「唤醒」/wake，到点落回的失败句也不含', language => {
    const copy = messages(language);
    expect(copy.connectionWaitingForHost).toBeTruthy();
    expect(copy.connectionWaitingForHost).not.toMatch(/唤醒|wake/i);
    expect(copy.connectionRelayNoHost).not.toMatch(/唤醒|wake/i);
  });
});
