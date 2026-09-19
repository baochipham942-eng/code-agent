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
  recoverCalls: 0,
  /** sync 轮询抛什么；null = 正常回执。「宿主挂了」的模拟口（phoneReconnect harness 同款）。 */
  syncError: null as string | null,
  hangRecover: false,
  releaseHang: null as null | (() => void),
  /** read.library 回的会话行（O1 标题记忆链用）。 */
  librarySessions: [] as { id: string; title: string; projectId: string | null; updatedAt: number; archived: boolean; provider: string; model: string }[],
}));

vi.mock('../../../packages/mobile/src/platform/lanCompanionClient', () => ({
  LanCompanionClient: class {
    async pair() {
      harness.pairCalls += 1;
      return { version: 1 as const, endpoint: 'http://192.168.1.2:8182', hostKey: 'aa'.repeat(32), deviceId: 'phone-2', scopeEpoch: 1, scope: ['project:one'] };
    }
    async recover() {
      harness.recoverCalls += 1;
      if (harness.hangRecover) await new Promise<void>(resolve => { harness.releaseHang = resolve; });
      if (harness.recoverError) throw new Error(harness.recoverError);
      return { version: 1 as const, endpoint: 'http://192.168.1.2:8182', hostKey: 'aa'.repeat(32), deviceId: 'phone-1', scopeEpoch: 1, scope: ['s1'] };
    }
    async request(payload: unknown) {
      const action = (payload as { action?: string }).action;
      if (action === 'status') { harness.statusCalls += 1; return null; }
      if (action === 'sync' && harness.syncError) throw new Error(harness.syncError);
      if (action === 'command') { harness.commandCalls += 1; return { kind: 'rejected', reason: 'device_unknown' }; }
      if (action === 'read') {
        const query = (payload as { query?: { kind?: string; sessionId?: string } }).query;
        if (query?.kind === 'history') return { sessionId: query.sessionId, messages: [], nextOffset: null };
        if (query?.kind === 'artifacts') return { sessionId: query.sessionId, artifacts: [] };
        // models 给一条可用的：#1918 合入后「电脑上还没有能用的模型」是 rank 3，会按 §13 压住
        // 本文件要钉的「上一条操作没送到」（rank 5）。这里钉的是扫码逃生口，不是模型档——
        // 夹具补一个模型让 rank 3 不出场，abandonedPending 才照旧可见。
        return { nextOffset: null, projects: [{ id: 'one', name: 'One', canCreate: true, workspacePath: '/w' }], sessions: harness.librarySessions, models: [{ provider: 'moonshot', model: 'kimi-k2.5', label: 'Kimi' }] };
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
    // 已过首次离网提醒周期（不是这个文件要测的场景）：不让 S8 薄面板抢走扫码/重连契约。
    loginReminded: true,
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
  harness.recoverCalls = 0; harness.syncError = null; harness.hangRecover = false; harness.releaseHang = null; harness.librarySessions = [];
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
        // 已过首次离网提醒周期（不是这个文件要测的场景）：不让 S8 薄面板抢走扫码/重连契约。
        loginReminded: true,
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
          // 已过首次离网提醒周期（不是这个文件要测的场景）：不让 S8 薄面板抢走扫码/重连契约。
          loginReminded: true,
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

  it('欢迎页输入框已有字：丢弃旧操作的草稿换行接在后面，不整段覆盖（ai-review Nit）', async () => {
    const written: string[] = [];
    const identity = createIdentity();
    const hostKey = toHex(identity.publicKey);
    const draftPorts: PlatformPorts = {
      ...ports(written),
      preferences: {
        get: async () => JSON.stringify({
          schema: 1, drafts: { new: '欢迎页刚打的字', fixture: '', [`${hostKey}:s1`]: '帮我查天气' },
          appearance: 'system', nickname: '', notifyEnabled: false,
        }),
        set: async () => {},
      },
      companion: {
        read: async () => JSON.stringify({
          version: 1, publicKey: toHex(identity.publicKey), secretKey: toHex(identity.secretKey),
          // 已过首次离网提醒周期（不是这个文件要测的场景）：不让 S8 薄面板抢走扫码/重连契约。
          loginReminded: true,
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
    // 扫码前欢迎页输入框里已经打着的字不能被旧会话草稿盖掉：两段都在，换行分隔。
    await waitFor(() => {
      expect((document.querySelector('[data-testid="draft"]') as HTMLTextAreaElement).value).toBe('欢迎页刚打的字\n帮我查天气');
    });
  });

  it('草稿搬到欢迎页后旧会话键清空：回旧会话不看到同一段字两次（ai-review Nit）', async () => {
    const written: string[] = [];
    const prefsWritten: string[] = [];
    const identity = createIdentity();
    const hostKey = toHex(identity.publicKey);
    const draftPorts: PlatformPorts = {
      ...ports(written),
      preferences: {
        get: async () => JSON.stringify({
          schema: 1, drafts: { new: '', fixture: '', [`${hostKey}:s1`]: '帮我查天气' },
          appearance: 'system', nickname: '', notifyEnabled: false,
        }),
        set: async value => { prefsWritten.push(value); },
      },
      companion: {
        read: async () => JSON.stringify({
          version: 1, publicKey: toHex(identity.publicKey), secretKey: toHex(identity.secretKey),
          // 已过首次离网提醒周期（不是这个文件要测的场景）：不让 S8 薄面板抢走扫码/重连契约。
          loginReminded: true,
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
    // 搬走之后旧会话键必须清空：不清的话回到旧会话，同一段字出现两次。
    await waitFor(() => {
      const prefs = JSON.parse(prefsWritten.at(-1) ?? '{}');
      expect(prefs.drafts?.new).toBe('帮我查天气');
      expect(prefs.drafts?.[`${hostKey}:s1`]).toBe('');
    });
  });
});

describe('自动重试在途：连接弹层两个键不置灰（D3）', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('自动尝试在途两键 enabled，点「重新连接」立即开新尝试并回锁防重复', async () => {
    harness.recoverError = 'COMPANION_NO_RESPONSE';   // 「电脑没回应」：在途 hello 约 10s 才超时
    await act(async () => { render(<MobileRoot ports={ports()} fixtures={false} />); });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });   // 冷启动首连失败 → offline + autoRetrying
    expect(document.querySelector('.app')).toBeTruthy();
    harness.hangRecover = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); }); // 退避第一拍：自动尝试在途（占 busy）
    await act(async () => { fireEvent.click(document.querySelector('[data-testid="open-drawer"]') as HTMLElement); });
    await act(async () => { fireEvent.click([...document.querySelectorAll('.drawer-functions button')].find(b => b.textContent === text.remote) as HTMLElement); });
    const scan = document.querySelector('[data-testid="remote-action-scan"]') as HTMLButtonElement;
    const reconnect = document.querySelector('[data-testid="remote-action-reconnect"]') as HTMLButtonElement;
    // 自动尝试在途不得锁这两个逃生口（D3）；此前约 80% 时间两键 disabled:true。
    expect(scan?.disabled).toBe(false);
    expect(reconnect?.disabled).toBe(false);
    const before = harness.recoverCalls;
    await act(async () => { fireEvent.click(reconnect); });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(harness.recoverCalls).toBe(before + 1);   // 点击立即生效，没被 busy 静默丢掉
    // 换成手动尝试占 busy：回锁，防重复点击。
    expect((document.querySelector('[data-testid="remote-action-scan"]') as HTMLButtonElement).disabled).toBe(true);
    harness.hangRecover = false;
    harness.releaseHang?.();
  });

  it('自动尝试在途「忘记这台电脑」可点且真能执行：抢占旧尝试，未配对态不被迟到失败打回（ai-review Nit）', async () => {
    harness.recoverError = 'COMPANION_NO_RESPONSE';
    const written: string[] = [];
    await act(async () => { render(<MobileRoot ports={ports(written)} fixtures={false} />); });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });   // 冷启动首连失败 → offline + autoRetrying
    expect(document.querySelector('.app')).toBeTruthy();
    harness.hangRecover = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); }); // 自动尝试在途（占 busy，任意抖动档 ≤3s 都已出发）
    await act(async () => { fireEvent.click(document.querySelector('[data-testid="open-drawer"]') as HTMLElement); });
    await act(async () => { fireEvent.click([...document.querySelectorAll('.drawer-functions button')].find(b => b.textContent === text.remote) as HTMLElement); });
    // 置灰判据与另两个键一致（busy && !autoAttempt）：自动尝试在途不灰这个兜底键。
    const forget = document.querySelector('[data-testid="remote-action-forget"]') as HTMLButtonElement;
    expect(forget.disabled).toBe(false);
    await act(async () => { fireEvent.click(forget); });
    // 点了就要真执行（不是亮着的死键）：配对被丢掉、页面回「尚未连接电脑」。
    // （fake timers 下不用 waitFor——它的轮询定时器也被假时钟冻住。）
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(document.querySelector('[data-testid="remote-unpaired"]')).toBeTruthy();
    expect(JSON.parse(written.at(-1)!).binding).toBeUndefined();
    // 在途尝试迟到的失败按代号丢弃：不得把刚清干净的未配对态打回 offline。
    harness.hangRecover = false;
    harness.releaseHang?.();
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(document.querySelector('[data-testid="remote-unpaired"]')).toBeTruthy();
  });
});

describe('扫码取消走 UI 真实路径：MobileRoot 的 scan catch（ai-review Important / Nit）', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  /** 原生扫码器「打开中」的端口：scan 一直未决，拿到 cancel 才以失败收场；盘上只放绑定（无 pending）。 */
  function openScannerPorts(): { ports: PlatformPorts; cancel: () => void } {
    const identity = createIdentity();
    let cancel: ((error: Error) => void) | null = null;
    const scanner: PlatformPorts = {
      ...ports(),
      companion: {
        read: async () => JSON.stringify({
          version: 1, publicKey: toHex(identity.publicKey), secretKey: toHex(identity.secretKey),
          // 已过首次离网提醒周期（不是这个文件要测的场景）：不让 S8 薄面板抢走扫码/重连契约。
          loginReminded: true,
          binding: { version: 1, endpoint: 'http://192.168.1.2:8182', hostKey: 'aa'.repeat(32), deviceId: 'phone-1', scopeEpoch: 1, scope: ['s1'] },
        }),
        write: async () => {},
        scan: () => new Promise<string>((_resolve, reject) => { cancel = error => reject(error); }),
        post: async () => ({}),
      },
    };
    return { ports: scanner, cancel: () => cancel!(new Error('cancelled')) };
  }

  async function openRemoteSheet(target: PlatformPorts) {
    await act(async () => { render(<MobileRoot ports={target} fixtures={false} />); });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });   // 冷启动首连失败 → offline + autoRetrying
    await act(async () => { fireEvent.click(document.querySelector('[data-testid="open-drawer"]') as HTMLElement); });
    await act(async () => { fireEvent.click([...document.querySelectorAll('.drawer-functions button')].find(b => b.textContent === text.remote) as HTMLElement); });
  }

  it('扫码器开着时自动重连连上：取消后仍连着，宿主再挂自动重试照常挂上', async () => {
    harness.recoverError = 'COMPANION_NO_RESPONSE';
    const { ports: scanner, cancel } = openScannerPorts();
    await openRemoteSheet(scanner);
    await act(async () => { fireEvent.click(document.querySelector('[data-testid="remote-action-scan"]') as HTMLElement); });
    // 扫码器开着（scan 未决）期间宿主醒来：退避那一拍（2s±50% 抖动，3s 内必发）把通道连上，
    // 定时器随之收口是正常行为。
    harness.recoverError = null;
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(document.querySelector('.connection-success')).toBeTruthy();
    // 用户取消扫码：不得把这条活连接覆盖成「扫码失败/离线」——否则发送/审批/语音全置灰且不自愈。
    await act(async () => { cancel(); await vi.advanceTimersByTimeAsync(0); });
    expect(document.querySelector('.connection-success')).toBeTruthy();
    expect(document.querySelector('[data-testid="remote-unreachable"]')).toBeNull();
    expect((document.querySelector('[data-testid="draft"]') as HTMLTextAreaElement).placeholder).not.toBe(text.offlinePlaceholder);
    // 宿主随后挂了（sync 轮询先失败、0 延迟重试的 recover 也失败）：落 offline 且自动重试
    // 重新挂上——取消没留下任何卡死态。
    harness.syncError = 'COMPANION_NO_RESPONSE';
    harness.recoverError = 'COMPANION_NO_RESPONSE';
    await act(async () => { await vi.advanceTimersByTimeAsync(1100); });
    expect(document.querySelector('[data-testid="remote-unreachable"]')).toBeTruthy();
    expect(document.querySelector('[data-testid="status-slot"] .status-text')?.textContent).toBe(text.autoRetrying);
  });

  it('没有连接时取消扫码：仍落扫码失败态，且不杀死已挂的自动重试', async () => {
    harness.recoverError = 'COMPANION_NO_RESPONSE';
    const { ports: scanner, cancel } = openScannerPorts();
    await openRemoteSheet(scanner);
    await act(async () => { fireEvent.click(document.querySelector('[data-testid="remote-action-scan"]') as HTMLElement); });
    await act(async () => { cancel(); await vi.advanceTimersByTimeAsync(0); });
    expect(document.querySelector('[data-testid="remote-unreachable"]')).toBeTruthy();
    expect(document.querySelector('[data-testid="remote-unreachable"] p')?.textContent).toBe(text.connectionScanFailed);
    // 提示是「这次扫码没成」，不是「这台电脑不能重试」：下一拍（≤3s）宿主回来即连上。
    harness.recoverError = null;
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(document.querySelector('.connection-success')).toBeTruthy();
  });
});

describe('冷启动宿主停机：缓存会话标题取上次记下的那份（O1）', () => {
  // mock recover 回的罐头绑定 hostKey 是 'aa'.repeat(32)：盘上的 binding.hostKey 与它一致，
  // 离线（用盘上绑定）与在线（用 recover 回的绑定）两条路才落在同一个记忆键上。
  const HOST = 'aa'.repeat(32);
  function coldStartPorts(prefs: { sessionTitles?: Record<string, string> }): PlatformPorts {
    const identity = createIdentity();
    return {
      preferences: {
        get: async () => JSON.stringify({
          schema: 1, drafts: { new: '', fixture: '' }, appearance: 'system', nickname: '', notifyEnabled: false,
          lastSessions: { [HOST]: 's-live' }, ...(prefs.sessionTitles ? { sessionTitles: prefs.sessionTitles } : {}),
        }),
        set: async () => {},
      },
      appInfo: { read: async () => ({ version: '0.1.0', build: '51' }) },
      lifecycle: { subscribe: async () => () => {}, leave: async () => {} },
      keyboard: { subscribe: async () => () => {}, subscribeFrame: async () => () => {}, hide: async () => {} },
      companion: {
        read: async () => JSON.stringify({
          version: 1, publicKey: toHex(identity.publicKey), secretKey: toHex(identity.secretKey),
          // 已过首次离网提醒周期（不是这个文件要测的场景）：不让 S8 薄面板抢走扫码/重连契约。
          loginReminded: true,
          binding: { version: 1, endpoint: 'http://192.168.1.2:8182', hostKey: HOST, deviceId: 'phone-1', scopeEpoch: 1, scope: ['s1'] },
        }),
        write: async () => {}, scan: async () => { throw new Error('unused'); }, post: async () => ({}),
      },
    };
  }

  it('有记忆标题：顶栏显示真名，不落「共享会话 0」', async () => {
    await act(async () => { render(<MobileRoot ports={coldStartPorts({ sessionTitles: { [`${HOST}:s-live`]: '真名叫这个' } })} fixtures={false} />); });
    await waitFor(() => { expect(document.querySelector('.topbar strong')?.textContent).toBe('真名叫这个'); });
  });

  it('没记过标题：占位「共享会话」仍在（会话不在 scope 里序号从 0 起）', async () => {
    await act(async () => { render(<MobileRoot ports={coldStartPorts({})} fixtures={false} />); });
    await waitFor(() => { expect(document.querySelector('.topbar strong')?.textContent).toBe(`${text.sharedSession} 0`); });
  });

  it('连着时标题随 library 记进偏好盘，重启后宿主停机可读（O1 记忆链）', async () => {
    const identity = createIdentity();
    let prefs = JSON.stringify({
      schema: 1, drafts: { new: '', fixture: '' }, appearance: 'system', nickname: '', notifyEnabled: false,
      lastSessions: { [HOST]: 's-live' },
    });
    const companionDisk = JSON.stringify({
      version: 1, publicKey: toHex(identity.publicKey), secretKey: toHex(identity.secretKey),
      // 已过首次离网提醒周期（不是这个文件要测的场景）：不让 S8 薄面板抢走扫码/重连契约。
      loginReminded: true,
      binding: { version: 1, endpoint: 'http://192.168.1.2:8182', hostKey: HOST, deviceId: 'phone-1', scopeEpoch: 1, scope: ['s1'] },
    });
    const mount = async () => {
      const instance: PlatformPorts = {
        preferences: { get: async () => prefs, set: async value => { prefs = value; } },
        appInfo: { read: async () => ({ version: '0.1.0', build: '51' }) },
        lifecycle: { subscribe: async () => () => {}, leave: async () => {} },
        keyboard: { subscribe: async () => () => {}, subscribeFrame: async () => () => {}, hide: async () => {} },
        companion: { read: async () => companionDisk, write: async () => {}, scan: async () => { throw new Error('unused'); }, post: async () => ({}) },
      };
      await act(async () => { render(<MobileRoot ports={instance} fixtures={false} />); });
    };
    // 第一段：宿主在线，库里带真名 → 记忆落盘。
    harness.recoverError = null;
    harness.librarySessions = [{ id: 's-live', title: '真名叫这个', projectId: 'one', updatedAt: 9, archived: false, provider: 'deepseek', model: 'deepseek-chat' }];
    await mount();
    await waitFor(() => { expect(JSON.parse(prefs).sessionTitles?.[`${HOST}:s-live`]).toBe('真名叫这个'); });
    cleanup();
    // 第二段：宿主停机冷启动，同一块偏好盘 → 标题还是真名。
    harness.recoverError = 'COMPANION_NO_RESPONSE';
    await mount();
    await waitFor(() => { expect(document.querySelector('.topbar strong')?.textContent).toBe('真名叫这个'); });
  });
});
