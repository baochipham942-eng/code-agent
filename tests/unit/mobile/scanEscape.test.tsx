// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { MobileRoot } from '../../../packages/mobile/src/app/MobileRoot';
import type { PlatformPorts } from '../../../packages/mobile/src/platform/ports';
import { createIdentity } from '../../../src/shared/companion/noiseChannel';
import { toHex } from '../../../src/shared/companion/lanProtocol';
import { messages } from '../../../packages/mobile/src/i18n';
import { createCompanionStore } from '../../../packages/mobile/src/stores/companionStore';

/**
 * N-MOBILE-SCAN-ESCAPE（FB-184）：连不上时扫码始终可点，不受 pending 限制；
 * 重新配对成功丢掉旧 pending 不重放，草稿保留，状态位一次性说明。
 */
const text = messages('zh');
const harness = vi.hoisted(() => ({
  recoverError: 'COMPANION_NETWORK_UNAVAILABLE' as string | null,
  pairCalls: 0,
  statusCalls: 0,
  commandCalls: 0,
}));

vi.mock('../../../packages/mobile/src/platform/lanCompanionClient', () => ({
  LanCompanionClient: class {
    async pair() {
      harness.pairCalls += 1;
      return { version: 1 as const, endpoint: 'http://192.168.1.2:8182', hostKey: 'aa'.repeat(32), deviceId: 'phone-2', scopeEpoch: 1, scope: ['project:one'] };
    }
    async recover() {
      if (harness.recoverError) throw new Error(harness.recoverError);
      return { version: 1 as const, endpoint: 'http://192.168.1.2:8182', hostKey: 'aa'.repeat(32), deviceId: 'phone-1', scopeEpoch: 1, scope: ['s1'] };
    }
    async request(payload: unknown) {
      const action = (payload as { action?: string }).action;
      if (action === 'status') { harness.statusCalls += 1; return null; }
      if (action === 'command') { harness.commandCalls += 1; return { kind: 'rejected', reason: 'device_unknown' }; }
      if (action === 'read') {
        const query = (payload as { query?: { kind?: string; sessionId?: string } }).query;
        if (query?.kind === 'history') return { sessionId: query.sessionId, messages: [], nextOffset: null };
        if (query?.kind === 'artifacts') return { sessionId: query.sessionId, artifacts: [] };
        return { nextOffset: null, projects: [{ id: 'one', name: 'One', canCreate: true, workspacePath: '/w' }], sessions: [], models: [] };
      }
      return { kind: 'events', epoch: 1, nextSeq: 0, events: [] };
    }
    close() {}
  },
}));

const pendingCommand = {
  version: 1 as const, deviceId: 'phone-1', scopeEpoch: 1, commandId: 'cmd-old', sessionId: 's1',
  action: 'message.send' as const, payload: { text: '上次没发完的' },
};

function invitation(): string {
  return JSON.stringify({
    version: 1, endpoint: 'http://192.168.1.2:8182', inviteId: '123e4567-e89b-12d3-a456-426614174000',
    psk: 'aa'.repeat(32), hostKey: 'aa'.repeat(32), expiresAt: Date.now() + 60_000,
  });
}

function savedWithPending(): string {
  const identity = createIdentity();
  return JSON.stringify({
    version: 1, publicKey: toHex(identity.publicKey), secretKey: toHex(identity.secretKey),
    binding: { version: 1, endpoint: 'http://192.168.1.2:8182', hostKey: toHex(identity.publicKey), deviceId: 'phone-1', scopeEpoch: 1, scope: ['s1'] },
    pending: pendingCommand,
  });
}

const ports = (written: string[] = []): PlatformPorts => ({
  preferences: { get: async () => JSON.stringify({ schema: 1, drafts: { new: '', fixture: '', [`${'bb'.repeat(32)}:s1`]: '草稿还在输入框' }, appearance: 'system', nickname: '', notifyEnabled: false }), set: async () => {} },
  appInfo: { read: async () => ({ version: '0.1.0', build: '51' }) },
  lifecycle: { subscribe: async () => () => {}, leave: async () => {} },
  keyboard: { subscribe: async () => () => {}, subscribeFrame: async () => () => {}, hide: async () => {} },
  companion: { read: async () => savedWithPending(), write: async value => { written.push(value); }, scan: async () => invitation(), post: async () => ({}) },
});

beforeEach(() => {
  harness.recoverError = 'COMPANION_NETWORK_UNAVAILABLE';
  harness.pairCalls = 0; harness.statusCalls = 0; harness.commandCalls = 0;
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false, media: query, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  }));
  Object.defineProperty(window.navigator, 'language', { value: 'zh-CN', configurable: true });
});
afterEach(() => { vi.unstubAllGlobals(); cleanup(); });

describe('pair() 不因 pending 退出', () => {
  it('有未确认命令时 pair 仍完成，pending 被丢掉且不重放', async () => {
    const written: string[] = [];
    const identity = createIdentity();
    const store = createCompanionStore({
      read: async () => JSON.stringify({
        version: 1, publicKey: toHex(identity.publicKey), secretKey: toHex(identity.secretKey),
        binding: { version: 1, endpoint: 'http://192.168.1.2:8182', hostKey: toHex(identity.publicKey), deviceId: 'phone-1', scopeEpoch: 1, scope: ['s1'] },
        pending: pendingCommand,
      }),
      write: async value => { written.push(value); },
      scan: async () => invitation(),
      post: async () => ({}),
    }, () => {});
    await store.getState().hydrate();
    expect(store.getState().pending).toBe(true);
    harness.recoverError = null;
    await store.getState().pair(invitation());
    expect(harness.pairCalls).toBe(1);
    expect(store.getState()).toMatchObject({ status: 'connected', pending: false, abandonedPending: true, sessionId: null });
    expect(JSON.parse(written.at(-1)!).pending).toBeUndefined();
    expect(harness.statusCalls).toBe(0);
    expect(harness.commandCalls).toBe(0);
    store.getState().dismissAbandonedPending();
    expect(store.getState().abandonedPending).toBe(false);
    store.getState().pause();
  });
});

describe('连接弹层扫码不受 pending 限制', () => {
  async function mountUnreachable() {
    await act(async () => { render(<MobileRoot ports={ports()} fixtures={false} />); });
    await waitFor(() => { expect(document.querySelector('.app')).toBeTruthy(); });
    fireEvent.click(document.querySelector('[data-testid="open-drawer"]') as HTMLElement);
    fireEvent.click([...document.querySelectorAll('.drawer-functions button')].find(b => b.textContent === text.remote) as HTMLElement);
    await waitFor(() => { expect(document.querySelector('[data-testid="remote-unreachable"]')).toBeTruthy(); });
  }

  it('有 pending 时扫码可点，并出现未确认操作提示', async () => {
    await mountUnreachable();
    const scan = document.querySelector('[data-testid="remote-action-scan"]') as HTMLButtonElement;
    expect(scan.disabled).toBe(false);
    expect(document.querySelector('[data-testid="remote-pending-hint"]')?.textContent).toBe(text.pendingScanHint);
  });

  it('配对失效时主按钮是扫码', async () => {
    harness.recoverError = 'COMPANION_HOST_KEY_MISMATCH';
    await mountUnreachable();
    expect(document.querySelector('[data-testid="remote-unreachable"] button.primary')?.textContent).toBe(text.scan);
  });

  it('扫码配对成功：提示可见、草稿在、不进 device_unknown', async () => {
    const written: string[] = [];
    const identity = createIdentity();
    const hostKey = toHex(identity.publicKey);
    const draftPorts: PlatformPorts = {
      ...ports(written),
      preferences: {
        get: async () => JSON.stringify({
          schema: 1, drafts: { new: '', fixture: '', [`${hostKey}:s1`]: '帮我查天气' },
          appearance: 'system', nickname: '', notifyEnabled: false,
        }),
        set: async () => {},
      },
      companion: {
        read: async () => JSON.stringify({
          version: 1, publicKey: toHex(identity.publicKey), secretKey: toHex(identity.secretKey),
          binding: { version: 1, endpoint: 'http://192.168.1.2:8182', hostKey, deviceId: 'phone-1', scopeEpoch: 1, scope: ['s1'] },
          pending: pendingCommand,
        }),
        write: async value => { written.push(value); },
        scan: async () => invitation(),
        post: async () => ({}),
      },
    };
    await act(async () => { render(<MobileRoot ports={draftPorts} fixtures={false} />); });
    await waitFor(() => { expect(document.querySelector('.app')).toBeTruthy(); });
    fireEvent.click(document.querySelector('[data-testid="open-drawer"]') as HTMLElement);
    fireEvent.click([...document.querySelectorAll('.drawer-functions button')].find(b => b.textContent === text.remote) as HTMLElement);
    await waitFor(() => { expect(document.querySelector('[data-testid="remote-action-scan"]')).toBeTruthy(); });
    await act(async () => { fireEvent.click(document.querySelector('[data-testid="remote-action-scan"]') as HTMLElement); });
    await waitFor(() => { expect(document.querySelector('[data-testid="status-slot"] .status-text')?.textContent).toBe(text.abandonedPending); });
    expect(document.querySelector('[data-testid="status-action"]')?.textContent).toBe(text.gotIt);
    expect((document.querySelector('[data-testid="draft"]') as HTMLTextAreaElement).value).toBe('帮我查天气');
    expect(harness.commandCalls).toBe(0);
    expect(JSON.parse(written.at(-1)!).pending).toBeUndefined();
  });
});
