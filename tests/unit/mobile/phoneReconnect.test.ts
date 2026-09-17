// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { createIdentity } from '../../../src/shared/companion/noiseChannel';
import { toHex } from '../../../src/shared/companion/lanProtocol';
import { COMPANION_LIMITS } from '../../../src/shared/constants/companion';
import { connectionBlocksAutoRetry, handshakeNeedsRescan, phoneReconnectDelayMs, phoneReconnectJitterMs } from '../../../packages/mobile/src/app/phoneReconnect';
import { connectionDiagnosis } from '../../../packages/mobile/src/app/connectionDiagnosis';
import { StatusSlot, composerStatusItems } from '../../../packages/mobile/src/app/StatusSlot';
import { createCompanionStore } from '../../../packages/mobile/src/stores/companionStore';
import { messages } from '../../../packages/mobile/src/i18n';
import type { PlatformPorts } from '../../../packages/mobile/src/platform/ports';

const text = messages('zh');

/**
 * N-MOBILE-AUTO-RECONNECT（design.md §13）：前台退避自动重连。
 * 节奏、10 分钟降频、后台停、回前台立即试、点重新连接重置、需重扫/存储出错不试。
 */
const harness = vi.hoisted(() => ({
  recoverError: 'COMPANION_NETWORK_UNAVAILABLE' as string | null,
  recoverCalls: 0,
  revoked: false,
  hangRecover: false,
  releaseHang: null as null | (() => void),
  /** 每个挂起的 recover 的放行闸，按挂起顺序排（D3 抢占测试用）。 */
  releaseHangs: [] as (() => void)[],
  pairError: null as string | null,
  syncError: null as string | null,
  closeCalls: 0,
}));

vi.mock('../../../packages/mobile/src/platform/lanCompanionClient', () => ({
  LanCompanionClient: class {
    async pair() {
      if (harness.pairError) throw new Error(harness.pairError);
      return { version: 1 as const, endpoint: 'http://192.168.1.2:8182', hostKey: 'aa'.repeat(32), deviceId: 'phone-2', scopeEpoch: 1, scope: ['project:one'] };
    }
    async recover() {
      harness.recoverCalls += 1;
      if (harness.hangRecover) await new Promise<void>(resolve => { harness.releaseHang = resolve; harness.releaseHangs.push(resolve); });
      if (harness.recoverError) throw new Error(harness.recoverError);
      return { version: 1 as const, endpoint: 'http://192.168.1.2:8182', hostKey: 'aa'.repeat(32), deviceId: 'phone-1', scopeEpoch: 1, scope: ['s1'] };
    }
    async request(payload: unknown) {
      const action = (payload as { action?: string }).action;
      if (action === 'sync' && harness.syncError) throw new Error(harness.syncError);
      if (action === 'sync' && harness.revoked) {
        return { kind: 'revoked', epoch: 1, nextSeq: 0, events: [] };
      }
      // 命令直发回执：原样带回这条命令（ack 校验要四元组全等），session.delete 的清理链靠它走通。
      if (action === 'command') {
        return { kind: 'accepted', command: { ...(payload as { command: object }).command, state: 'resolved', result: {} } };
      }
      return { kind: 'events', epoch: 1, nextSeq: 0, events: [] };
    }
    close() { harness.closeCalls += 1; harness.releaseHang?.(); }
  },
}));

function invitation(): string {
  return JSON.stringify({
    version: 1, endpoint: 'http://192.168.1.2:8182', inviteId: '123e4567-e89b-12d3-a456-426614174000',
    psk: 'aa'.repeat(32), hostKey: 'aa'.repeat(32), expiresAt: Date.now() + 60_000,
  });
}

function savedBinding(): string {
  const identity = createIdentity();
  return JSON.stringify({
    version: 1, publicKey: toHex(identity.publicKey), secretKey: toHex(identity.secretKey),
    binding: { version: 1, endpoint: 'http://192.168.1.2:8182', hostKey: toHex(identity.publicKey), deviceId: 'phone-1', scopeEpoch: 1, scope: ['s1'] },
  });
}

function storeOf() {
  const companion: NonNullable<PlatformPorts['companion']> = {
    read: async () => savedBinding(),
    write: async () => {},
    scan: async () => { throw new Error('unused'); },
    post: async () => ({}),
  };
  return createCompanionStore(companion, () => {});
}

function slotFrom(store: ReturnType<typeof storeOf>) {
  const s = store.getState();
  return composerStatusItems(text, {
    saveError: false, nativeError: false, sendAttempted: false,
    binding: Boolean(s.binding), status: s.status, paused: s.paused, connectionError: s.connectionError, busy: s.busy,
    commandError: s.commandError, commandErrorAction: s.commandErrorAction, voiceFailureShown: false, sessionId: s.sessionId,
    libraryError: s.libraryError, pending: s.pending, pendingAction: s.pendingAction, pendingSlow: false,
    autoRetrying: s.autoRetrying, autoAttempt: s.autoAttempt, abandonedPending: s.abandonedPending,
  }, { flush() {}, reconnect() {}, scan() {}, openRemote() {}, retryCreate() {}, switchModel() {} });
}

async function flushUntilHung(ticks = 30) {
  for (let i = 0; i < ticks && !harness.releaseHang; i += 1) await Promise.resolve();
  expect(harness.releaseHang, 'recover 应已挂起未决').toBeTruthy();
}

describe('phoneReconnectDelayMs 节奏', () => {
  it('立即、2/4/8/16/30s，之后每 30s，10 分钟后每 60s', () => {
    expect(phoneReconnectDelayMs(0, 0)).toBe(0);
    expect([1, 2, 3, 4, 5].map(n => phoneReconnectDelayMs(n, 0))).toEqual([...COMPANION_LIMITS.phoneReconnectBackoffMs]);
    expect(phoneReconnectDelayMs(6, 0)).toBe(COMPANION_LIMITS.phoneReconnectSteadyMs);
    expect(phoneReconnectDelayMs(20, COMPANION_LIMITS.phoneReconnectSlowAfterMs - 1)).toBe(COMPANION_LIMITS.phoneReconnectSteadyMs);
    expect(phoneReconnectDelayMs(1, COMPANION_LIMITS.phoneReconnectSlowAfterMs)).toBe(COMPANION_LIMITS.phoneReconnectSlowMs);
  });
  it('±50% 抖动；0 延迟不加抖', () => {
    expect(phoneReconnectJitterMs(0, () => 0.5)).toBe(0);
    expect(phoneReconnectJitterMs(2000, () => 0.5)).toBe(2000);
    expect(phoneReconnectJitterMs(2000, () => 0)).toBe(1000);
    expect(phoneReconnectJitterMs(2000, () => 1)).toBe(3000);
  });
  it('需重扫 / 存储出错 / 已拒绝 不自动重试', () => {
    expect(connectionBlocksAutoRetry('rejected', 'connectionRejected')).toBe(true);
    expect(connectionBlocksAutoRetry('storageError', null)).toBe(true);
    expect(connectionBlocksAutoRetry('offline', 'connectionRejected')).toBe(true);
    expect(connectionBlocksAutoRetry('offline', 'connectionQrInvalid')).toBe(true);
    expect(connectionBlocksAutoRetry('offline', 'connectionUnavailable')).toBe(false);
    expect(handshakeNeedsRescan('COMPANION_HOST_KEY_MISMATCH')).toBe(true);
    expect(handshakeNeedsRescan('COMPANION_BINDING_CHANGED')).toBe(true);
    expect(handshakeNeedsRescan('COMPANION_NO_RESPONSE')).toBe(false);
  });
});

describe('companionStore 前台退避自动重连', () => {
  beforeEach(() => {
    harness.recoverError = 'COMPANION_NETWORK_UNAVAILABLE';
    harness.recoverCalls = 0;
    harness.revoked = false;
    harness.hangRecover = false;
    harness.releaseHang = null;
    harness.releaseHangs = [];
    harness.pairError = null;
    harness.syncError = null;
    harness.closeCalls = 0;
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    vi.useFakeTimers();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('hydrate 失败后按 2/4/8/16/30s 再试，状态保持 autoRetrying 不进 connecting', async () => {
    const store = storeOf();
    await store.getState().hydrate();
    expect(store.getState()).toMatchObject({ status: 'offline', autoRetrying: true, connectionError: 'connectionUnavailable' });
    expect(harness.recoverCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(1999);
    expect(harness.recoverCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(harness.recoverCalls).toBe(2);
    expect(store.getState().status).toBe('offline');
    await vi.advanceTimersByTimeAsync(4000);
    expect(harness.recoverCalls).toBe(3);
    await vi.advanceTimersByTimeAsync(8000);
    expect(harness.recoverCalls).toBe(4);
    await vi.advanceTimersByTimeAsync(16000);
    expect(harness.recoverCalls).toBe(5);
    await vi.advanceTimersByTimeAsync(30000);
    expect(harness.recoverCalls).toBe(6);
    store.getState().pause();
  });

  it('满 10 分钟后下一档是 60s', async () => {
    const start = 1_700_000_000_000;
    vi.setSystemTime(start);
    const store = storeOf();
    await store.getState().hydrate();
    expect(harness.recoverCalls).toBe(1);
    vi.setSystemTime(start + COMPANION_LIMITS.phoneReconnectSlowAfterMs);
    await vi.advanceTimersByTimeAsync(2000);
    expect(harness.recoverCalls).toBe(2);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(harness.recoverCalls).toBe(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(harness.recoverCalls).toBe(3);
    store.getState().pause();
  });

  it('后台停定时器，回前台立即再试', async () => {
    const store = storeOf();
    await store.getState().hydrate();
    expect(harness.recoverCalls).toBe(1);
    store.getState().pause();
    expect(store.getState().autoRetrying).toBe(false);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(harness.recoverCalls).toBe(1);
    await store.getState().reconnect();
    expect(harness.recoverCalls).toBe(2);
    store.getState().pause();
  });

  it('点重新连接立即试并重置节奏：下一次仍等 2s 而不是已经走到的 30s', async () => {
    const store = storeOf();
    await store.getState().hydrate();
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(4000);
    await vi.advanceTimersByTimeAsync(8000);
    const afterRamp = harness.recoverCalls;
    await store.getState().reconnect({ resetBackoff: true });
    expect(harness.recoverCalls).toBe(afterRamp + 1);
    await vi.advanceTimersByTimeAsync(1999);
    expect(harness.recoverCalls).toBe(afterRamp + 1);
    await vi.advanceTimersByTimeAsync(1);
    expect(harness.recoverCalls).toBe(afterRamp + 2);
    store.getState().pause();
  });

  it('HOST_KEY_MISMATCH / BINDING_CHANGED 归需重扫，不自动再试', async () => {
    for (const code of ['COMPANION_HOST_KEY_MISMATCH', 'COMPANION_BINDING_CHANGED'] as const) {
      harness.recoverError = code;
      harness.recoverCalls = 0;
      const store = storeOf();
      await store.getState().hydrate();
      expect(store.getState()).toMatchObject({ status: 'offline', connectionError: 'connectionRejected', autoRetrying: false });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(harness.recoverCalls).toBe(1);
      store.getState().pause();
    }
  });

  it('status=rejected 不自动重试', async () => {
    harness.recoverError = null;
    const store = storeOf();
    await store.getState().hydrate();
    expect(store.getState().status).toBe('connected');
    harness.revoked = true;
    await store.getState().sync();
    expect(store.getState().status).toBe('rejected');
    const calls = harness.recoverCalls;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(harness.recoverCalls).toBe(calls);
    store.getState().pause();
  });

  it('定时器触发的自动重连进行中：status 保持 offline，状态位不闪正在连接', async () => {
    const store = storeOf();
    await store.getState().hydrate();
    expect(store.getState()).toMatchObject({ status: 'offline', autoRetrying: true, connectionError: 'connectionUnavailable' });
    expect(harness.recoverCalls).toBe(1);
    harness.hangRecover = true;
    // 同步推进：async 版会等挂起的 recover Promise，测的就是未决那一拍。
    vi.advanceTimersByTime(2000);
    await flushUntilHung();
    expect(harness.recoverCalls).toBe(2);
    expect(store.getState()).toMatchObject({ status: 'offline', autoRetrying: true, paused: false });
    const { container } = render(React.createElement(StatusSlot, { items: slotFrom(store) }));
    expect(container.querySelector('.status-text')?.textContent).toBe(text.autoRetrying);
    expect(container.querySelector('[data-testid="status-action"]')?.textContent).toBe(text.reconnect);
    expect(container.querySelector('[data-testid="status-slot"]')?.getAttribute('data-reason')).toBe('auto-retry');
    expect(container.textContent).not.toContain(text.connecting);
    harness.hangRecover = false;
    harness.releaseHang?.();
    await Promise.resolve();
    await Promise.resolve();
    store.getState().pause();
  });

  it('从后台恢复健康连接：握手期间是 connecting，不是自动重试', async () => {
    vi.useRealTimers();
    harness.recoverError = null;
    const store = storeOf();
    await store.getState().hydrate();
    expect(store.getState().status).toBe('connected');
    store.getState().pause();
    expect(store.getState()).toMatchObject({ status: 'offline', paused: true, autoRetrying: false });
    harness.hangRecover = true;
    const pending = store.getState().reconnect();
    await flushUntilHung();
    expect(store.getState()).toMatchObject({ status: 'connecting', autoRetrying: false, paused: false });
    const { container } = render(React.createElement(StatusSlot, { items: slotFrom(store) }));
    expect(container.querySelector('.status-text')?.textContent).toBe(text.connecting);
    expect(container.textContent).not.toContain(text.autoRetrying);
    harness.hangRecover = false;
    harness.releaseHang?.();
    await pending;
    expect(store.getState()).toMatchObject({ status: 'connected', autoRetrying: false });
    store.getState().pause();
  });

  it('自动重连进行中扫码：pair 不被 busy 丢掉', async () => {
    const store = storeOf();
    await store.getState().hydrate();
    expect(store.getState().autoRetrying).toBe(true);
    harness.hangRecover = true;
    vi.advanceTimersByTime(2000);
    await flushUntilHung();
    expect(store.getState().busy).toBe(true);
    harness.hangRecover = false;
    await store.getState().pair(invitation());
    expect(store.getState()).toMatchObject({ status: 'connected', autoRetrying: false, busy: false });
    store.getState().pause();
  });

  it('扫码配对失败（宿主停机）：恢复原绑定，宿主恢复后自动重连成功（D1）', async () => {
    harness.pairError = 'COMPANION_NO_RESPONSE';
    const written: string[] = [];
    const store = createCompanionStore({
      read: async () => savedBinding(),
      write: async value => { written.push(value); },
      scan: async () => { throw new Error('unused'); },
      post: async () => ({}),
    }, () => {});
    await store.getState().hydrate();
    expect(store.getState()).toMatchObject({ status: 'offline', autoRetrying: true });
    const callsAfterHydrate = harness.recoverCalls;
    await store.getState().pair(invitation());
    // 配对没成，但原绑定恢复进了盘上，前台退避自动重试接着跑——不是卡死在失败态。
    expect(store.getState().binding).toBeTruthy();
    expect(JSON.parse(written.at(-1)!).binding).toBeTruthy();
    expect(store.getState().autoRetrying).toBe(true);
    expect(store.getState().status).toBe('offline');
    harness.pairError = null;
    harness.recoverError = null;   // 宿主回来了
    await vi.advanceTimersByTimeAsync(0);
    // 恢复原绑定那一拍挂的是 0 延迟重试（握手成功还会 probe.recover 刷 relay 路由，+2 是常态）。
    expect(harness.recoverCalls).toBeGreaterThan(callsAfterHydrate);
    expect(store.getState().status).toBe('connected');
    store.getState().pause();
  });

  it('有原绑定时扫到无效二维码：提示照常显示，自动重试不停、宿主回来即连上（ai-review Nit）', async () => {
    // pair 在第一次 persist 之前就抛（二维码解不开），原绑定没被清掉。
    const store = storeOf();
    await store.getState().hydrate();
    const callsAfterHydrate = harness.recoverCalls;
    await store.getState().pair('not-an-invitation');
    expect(store.getState()).toMatchObject({ status: 'offline', connectionError: 'connectionQrInvalid', binding: expect.anything() });
    // 无效二维码的提示照常显示（诊断句 + 主动作仍是重新扫码），但不得把前台自动重连永久停掉。
    expect(connectionDiagnosis(text, store.getState())).toEqual({ sentence: text.connectionQrInvalid, action: 'scan' });
    expect(store.getState().autoRetrying).toBe(true);
    await vi.advanceTimersByTimeAsync(0);   // 重挂的是 0 延迟那拍：宿主仍停机 → 继续按退避走
    expect(harness.recoverCalls).toBeGreaterThan(callsAfterHydrate);
    expect(store.getState().autoRetrying).toBe(true);
    harness.recoverError = null;   // 宿主回来了
    await vi.advanceTimersByTimeAsync(30_000);
    expect(store.getState().status).toBe('connected');
    store.getState().pause();
  });

  it('有原绑定时扫码取消：同样重挂自动重试，不停在失败态（ai-review Nit）', async () => {
    const store = storeOf();   // scan 口直接抛：模拟用户取消原生扫码
    await store.getState().hydrate();
    const callsAfterHydrate = harness.recoverCalls;
    await store.getState().pair();
    expect(store.getState()).toMatchObject({ status: 'offline', connectionError: 'connectionScanFailed', binding: expect.anything() });
    expect(store.getState().autoRetrying).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.recoverCalls).toBeGreaterThan(callsAfterHydrate);
    store.getState().pause();
  });

  it('没有原绑定的扫码失败：停在失败态不空转（D1）', async () => {
    harness.pairError = 'COMPANION_NO_RESPONSE';
    const identity = createIdentity();
    const raw = JSON.stringify({ version: 1, publicKey: toHex(identity.publicKey), secretKey: toHex(identity.secretKey) });
    const store = createCompanionStore({
      read: async () => raw,
      write: async () => {},
      scan: async () => { throw new Error('unused'); },
      post: async () => ({}),
    }, () => {});
    await store.getState().hydrate();
    expect(store.getState().status).toBe('unpaired');
    await store.getState().pair(invitation());
    expect(store.getState()).toMatchObject({ status: 'offline', autoRetrying: false });
    expect(store.getState().binding).toBeNull();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(harness.recoverCalls).toBe(0);
  });

  it('自动重试在途点「重新连接」：立即开新尝试，旧尝试迟到的失败不作废新连接（D3）', async () => {
    const store = storeOf();
    await store.getState().hydrate();                     // 首次尝试失败 → offline + autoRetrying
    harness.hangRecover = true;
    vi.advanceTimersByTime(2000);
    await flushUntilHung();                               // 自动尝试挂起：占 busy 但 autoAttempt
    expect(store.getState()).toMatchObject({ status: 'offline', busy: true, autoAttempt: true, autoRetrying: true });
    // 状态位的「重新连接」动作此刻必须可点（D3：自动尝试不锁逃生口）。
    expect(slotFrom(store).find(item => item?.rank === 2)?.action?.disabled).toBe(false);
    const calls = harness.recoverCalls;
    const manual = store.getState().reconnect({ resetBackoff: true });
    await vi.advanceTimersByTimeAsync(0);                 // 冲微任务：新（手动）尝试也已挂起
    expect(harness.recoverCalls).toBe(calls + 1);         // 没被 busy 丢掉
    expect(store.getState().autoAttempt).toBe(false);     // 手动尝试占 busy → 防重复点击
    expect(slotFrom(store).find(item => item?.rank === 2)?.action?.disabled).toBe(true);
    // 宿主其实回来了：放行手动尝试 → 连上。旧自动尝试的迟到失败（客户端被抢占者关闭）不得把新连接打回 offline。
    harness.recoverError = null;
    harness.hangRecover = false;   // 连上后的 relay 路由探针也要能走完
    harness.releaseHangs[1]();
    await manual;
    expect(store.getState()).toMatchObject({ status: 'connected', busy: false });
    store.getState().pause();
  });

  it('自动尝试卡在 mDNS 解析时扫码：迟到的旧尝试不得关掉扫码建立的连接（ai-review Important）', async () => {
    harness.recoverError = null;
    let releaseResolve: (() => void) | null = null;
    const identity = createIdentity();
    const store = createCompanionStore({
      read: async () => JSON.stringify({
        version: 1, publicKey: toHex(identity.publicKey), secretKey: toHex(identity.secretKey),
        binding: { version: 1, endpoint: 'http://192.168.1.2:8182', altEndpoint: 'http://imac.local:8182', hostKey: toHex(identity.publicKey), deviceId: 'phone-1', scopeEpoch: 1, scope: ['s1'] },
      }),
      write: async () => {},
      scan: async () => { throw new Error('unused'); },
      post: async () => ({}),
      // mDNS 重解析挂起不放行（真机最长 3s 超时），自动尝试悬在 mdnsRefreshedEndpoint 上。
      resolveHost: () => new Promise<string | null>(resolve => { releaseResolve = () => resolve(null); }),
    }, () => {});
    const hydrating = store.getState().hydrate();
    for (let i = 0; i < 30 && !releaseResolve; i += 1) await Promise.resolve();
    expect(releaseResolve, 'resolveHost 应已挂起未决').toBeTruthy();
    expect(store.getState().busy).toBe(true);   // 自动尝试在途占着 busy
    await store.getState().pair(invitation());  // 扫码抢占并配对成功
    expect(store.getState().status).toBe('connected');
    const closedAtPair = harness.closeCalls;
    releaseResolve!();   // 放行 mDNS：被抢占的旧自动尝试此刻迟到的续跑
    await hydrating;
    await vi.advanceTimersByTimeAsync(0);
    // 旧尝试既没关掉扫码刚建立的客户端（配对通道完好），也没把状态打回 connecting/正在自动重试。
    expect(harness.closeCalls).toBe(closedAtPair);
    expect(store.getState()).toMatchObject({ status: 'connected', autoRetrying: false, busy: false });
    store.getState().pause();
  });

  it('被撤销后扫到非 Neo 二维码：connectionError 补回 connectionRejected，诊断仍是重新扫码（ai-review Nit）', async () => {
    harness.recoverError = null;
    const store = storeOf();
    await store.getState().hydrate();
    expect(store.getState().status).toBe('connected');
    harness.revoked = true;
    await store.getState().sync();
    expect(store.getState()).toMatchObject({ status: 'rejected', connectionError: 'connectionRejected' });
    await store.getState().pair('not-an-invitation');
    // safely 进场已把 connectionError 清成 null：撤销态的早退必须补回，否则诊断落「电脑没回应」。
    expect(store.getState()).toMatchObject({ status: 'rejected', connectionError: 'connectionRejected' });
    expect(connectionDiagnosis(text, store.getState()).action).toBe('scan');
    store.getState().pause();
  });

  it('会话删除清单条标题记忆、配对撤销清整台（ai-review Nit：sessionTitles 只增不删）', async () => {
    harness.recoverError = null;
    // 盘上绑定与 mock recover 回的罐头绑定同 hostKey：连上后 saved.binding 才还是这个键。
    const hostKey = 'aa'.repeat(32);
    const identity = createIdentity();
    const forgotten: Array<[string, string | undefined]> = [];
    const store = createCompanionStore({
      read: async () => JSON.stringify({
        version: 1, publicKey: toHex(identity.publicKey), secretKey: toHex(identity.secretKey),
        binding: { version: 1, endpoint: 'http://192.168.1.2:8182', hostKey, deviceId: 'phone-1', scopeEpoch: 1, scope: ['s1'] },
      }),
      write: async () => {},
      scan: async () => { throw new Error('unused'); },
      post: async () => ({}),
    }, () => {}, undefined, undefined, undefined, {
      forgetSessionTitles: (host, sessionId) => { forgotten.push([host, sessionId]); },
    });
    await store.getState().hydrate();
    expect(store.getState().status).toBe('connected');
    await store.getState().manage('session.delete', {}, 's1');
    expect(forgotten).toEqual([[hostKey, 's1']]);
    harness.revoked = true;
    await store.getState().sync();
    expect(forgotten.at(-1)).toEqual([hostKey, undefined]);
    store.getState().pause();
  });

  it('握手成功但 sync 恒失败：退避升档，不 0 延迟原地打转', async () => {
    harness.recoverError = null;
    harness.syncError = 'COMPANION_INVALID_SYNC';
    const store = storeOf();
    await store.getState().hydrate();
    expect(store.getState().status).toBe('connected');
    // 每次握手成功还会 probe.recover 刷 relay 路由，所以一次重连 +2。
    const afterHydrate = harness.recoverCalls;
    await store.getState().sync();
    expect(store.getState()).toMatchObject({ status: 'offline', autoRetrying: true });
    expect(harness.recoverCalls).toBe(afterHydrate);
    await vi.advanceTimersByTimeAsync(1999);
    expect(harness.recoverCalls).toBe(afterHydrate);
    await vi.advanceTimersByTimeAsync(1);
    expect(harness.recoverCalls).toBe(afterHydrate + 2);
    expect(store.getState().status).toBe('connected');
    await store.getState().sync();
    expect(store.getState().status).toBe('offline');
    expect(harness.recoverCalls).toBe(afterHydrate + 2);
    await vi.advanceTimersByTimeAsync(3999);
    expect(harness.recoverCalls).toBe(afterHydrate + 2);
    await vi.advanceTimersByTimeAsync(1);
    expect(harness.recoverCalls).toBe(afterHydrate + 4);
    store.getState().pause();
  });

  it('storageError 不自动重试', async () => {
    const store = createCompanionStore({
      read: async () => { throw new Error('keychain'); },
      write: async () => {},
      scan: async () => '',
      post: async () => ({}),
    }, () => {});
    await store.getState().hydrate();
    expect(store.getState().status).toBe('storageError');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(harness.recoverCalls).toBe(0);
    store.getState().pause();
  });
});
