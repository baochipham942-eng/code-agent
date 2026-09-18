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
  /** 连上后核对待确认命令（action:'status'）抛什么；null = 不抛。 */
  statusError: null as string | null,
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
      if (action === 'status' && harness.statusError) throw new Error(harness.statusError);
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
    library: s.library,
  }, { flush() {}, reconnect() {}, scan() {}, openRemote() {}, retryCreate() {}, switchModel() {}, openModelSetup() {} });
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
    harness.statusError = null;
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

  it('从后台恢复健康连接（宽限已到期）：重连握手期间是 connecting，不是自动重试', async () => {
    harness.recoverError = null;
    const store = storeOf();
    await store.getState().hydrate();
    expect(store.getState().status).toBe('connected');
    const closedBeforePause = harness.closeCalls;
    store.getState().pause();
    // 新语义（N-MOBILE-BG-KEEPALIVE-GRACE）：退后台不立即拆连接——宽限内 status 保持
    // connected、paused 保持 false（应用切换器快照拍到的就是真相），通道一次都不关。
    expect(store.getState()).toMatchObject({ status: 'connected', paused: false, autoRetrying: false });
    expect(harness.closeCalls).toBe(closedBeforePause);
    // 宽限到期仍在后台：才执行关闭收尾，打回 offline + paused。
    await vi.advanceTimersByTimeAsync(COMPANION_LIMITS.backgroundKeepaliveGraceMs);
    expect(store.getState()).toMatchObject({ status: 'offline', paused: true, autoRetrying: false });
    expect(harness.closeCalls).toBe(closedBeforePause + 1);
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

  it('宽限内回前台：取消延迟关闭 + 探活，不重拨（N-MOBILE-BG-KEEPALIVE-GRACE ①）', async () => {
    harness.recoverError = null;
    const store = storeOf();
    await store.getState().hydrate();
    expect(store.getState().status).toBe('connected');
    const closed = harness.closeCalls;
    const recoveries = harness.recoverCalls;
    store.getState().pause();
    await store.getState().reconnect();
    await vi.advanceTimersByTimeAsync(0);
    // 没有握手、没有关闭：连接压根没拆过——「看一眼微信就回来」不该再走一遍 recover。
    expect(harness.closeCalls).toBe(closed);
    expect(harness.recoverCalls).toBe(recoveries);
    expect(store.getState()).toMatchObject({ status: 'connected', paused: false });
    // 探活补拉照常走通，通道还能发命令。
    await store.getState().sync();
    expect(store.getState().status).toBe('connected');
    await store.getState().send('宽限内回前台-正文');
    expect(store.getState().pending).toBe(false);
    store.getState().pause();
  });

  it('宽限到期仍在后台：只关一次、打回 offline+paused；回前台走全量 recover（②）', async () => {
    harness.recoverError = null;
    const store = storeOf();
    await store.getState().hydrate();
    const closed = harness.closeCalls;
    store.getState().pause();
    await vi.advanceTimersByTimeAsync(COMPANION_LIMITS.backgroundKeepaliveGraceMs);
    expect(harness.closeCalls).toBe(closed + 1);
    expect(store.getState()).toMatchObject({ status: 'offline', paused: true, autoRetrying: false });
    const recoveries = harness.recoverCalls;
    await store.getState().reconnect();
    // 全量 recover 回得来（+2 是常态：主握手 + relay 路由探针）。
    expect(harness.recoverCalls).toBeGreaterThan(recoveries);
    expect(store.getState()).toMatchObject({ status: 'connected', paused: false });
    store.getState().pause();
  });

  it('iOS 连发两次退后台回调：宽限不重挂，到期只关一次、paused 保持 true（③）', async () => {
    harness.recoverError = null;
    const store = storeOf();
    await store.getState().hydrate();
    const closed = harness.closeCalls;
    store.getState().pause(); store.getState().pause();
    await vi.advanceTimersByTimeAsync(COMPANION_LIMITS.backgroundKeepaliveGraceMs);
    expect(harness.closeCalls).toBe(closed + 1);
    expect(store.getState()).toMatchObject({ status: 'offline', paused: true });
  });

  it('宽限期内扫码换通道：旧通道立即关，迟到的宽限回调不碰新通道（④）', async () => {
    harness.recoverError = null;
    const store = storeOf();
    await store.getState().hydrate();            // 通道 A
    const closed = harness.closeCalls;
    store.getState().pause();                    // 宽限挂上，A 还活着
    await store.getState().pair(invitation());   // 换到通道 B：A 立即被关
    expect(store.getState().status).toBe('connected');
    const closedAfterPair = harness.closeCalls;
    expect(closedAfterPair).toBeGreaterThan(closed);
    await vi.advanceTimersByTimeAsync(COMPANION_LIMITS.backgroundKeepaliveGraceMs + 1_000);
    // 迟到的回调（若逃过 clearTimeout 与身份守卫）不许关掉扫码刚建立的新通道。
    expect(harness.closeCalls).toBe(closedAfterPair);
    await store.getState().sync();
    expect(store.getState().status).toBe('connected');
    store.getState().pause();
  });

  it('宽限期内忘记这台电脑：旧通道立即关，宽限定时器随之撤销（④）', async () => {
    harness.recoverError = null;
    const store = storeOf();
    await store.getState().hydrate();
    const closed = harness.closeCalls;
    store.getState().pause();
    await store.getState().forget();
    const closedAfterForget = harness.closeCalls;
    expect(store.getState()).toMatchObject({ status: 'unpaired', paused: false });
    expect(closedAfterForget).toBeGreaterThan(closed);
    await vi.advanceTimersByTimeAsync(COMPANION_LIMITS.backgroundKeepaliveGraceMs + 1_000);
    expect(harness.closeCalls).toBe(closedAfterForget);
  });

  it('宽限内回前台但连接已死：探活失败打回 offline 并挂自动重试，不带着死通道假装连着（⑤）', async () => {
    harness.recoverError = null;
    harness.syncError = 'COMPANION_NO_RESPONSE';   // 后台期间 relay socket 已被系统挂死
    const store = storeOf();
    await store.getState().hydrate();
    const closed = harness.closeCalls;
    store.getState().pause();
    await store.getState().reconnect();            // 宽限分支：取消关闭 + sync 探活
    await vi.advanceTimersByTimeAsync(0);          // 探活失败结算（sync 的 catch 老路）
    expect(store.getState()).toMatchObject({ status: 'offline', autoRetrying: true, connectionError: 'connectionUnavailable' });
    expect(harness.closeCalls).toBe(closed + 1);
    // 僵尸自愈接着走：下一拍自动重试全量 recover 回得来。
    harness.syncError = null;
    await vi.advanceTimersByTimeAsync(2000);
    expect(store.getState().status).toBe('connected');
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
    await vi.advanceTimersByTimeAsync(2000);
    // 恢复原绑定那一拍挂的是退避首档（2s ±50%，random 钉 0.5 → 整 2s）；握手成功还会
    // probe.recover 刷 relay 路由，+2 是常态。
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
    await vi.advanceTimersByTimeAsync(2000);   // 重挂的是退避首档（2s）：宿主仍停机 → 失败后继续按退避走
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
    await vi.advanceTimersByTimeAsync(2000);
    expect(harness.recoverCalls).toBeGreaterThan(callsAfterHydrate);
    store.getState().pause();
  });

  it('有原绑定时扫到无效二维码：提示跨重试保留（0ms/1s/在途都仍是二维码无效），新错误码才接管、连上才清（ai-review Important）', async () => {
    const store = storeOf();
    await store.getState().hydrate();
    const callsAfterHydrate = harness.recoverCalls;
    await store.getState().pair('not-an-invitation');
    expect(store.getState()).toMatchObject({ status: 'offline', connectionError: 'connectionQrInvalid', binding: expect.anything() });
    // 恢复原绑定后按退避首档挂重试（2s ±50%，random 钉 0.5 → 整 2s），不再是 0 延迟。
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.recoverCalls).toBe(callsAfterHydrate);
    await vi.advanceTimersByTimeAsync(1000);
    expect(harness.recoverCalls).toBe(callsAfterHydrate);
    expect(connectionDiagnosis(text, store.getState())).toEqual({ sentence: text.connectionQrInvalid, action: 'scan' });
    // 首拍重试出发并挂起：在途期间静默重试不得清「二维码无效」，诊断句与主动作不变。
    harness.hangRecover = true;
    await vi.advanceTimersByTimeAsync(1000);
    await flushUntilHung();
    expect(harness.recoverCalls).toBe(callsAfterHydrate + 1);
    expect(store.getState().connectionError).toBe('connectionQrInvalid');
    expect(connectionDiagnosis(text, store.getState())).toEqual({ sentence: text.connectionQrInvalid, action: 'scan' });
    // 这次重试自己失败（宿主仍停机）→ 新错误码接管诊断，不再提扫码。
    harness.hangRecover = false;
    harness.releaseHang?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState().connectionError).toBe('connectionUnavailable');
    expect(connectionDiagnosis(text, store.getState())).toEqual({ sentence: text.connectionUnavailable, action: 'reconnect' });
    // 下一拍连上 → 提示清掉。
    harness.recoverError = null;
    await vi.advanceTimersByTimeAsync(4000);
    expect(store.getState().status).toBe('connected');
    expect(store.getState().connectionError).toBeNull();
    store.getState().pause();
  });

  it('重连在途时再调 reconnect() 早退：不把「重连失败」记账抹掉，失败仍升档（ai-review Nit）', async () => {
    const store = storeOf();
    await store.getState().hydrate();          // 首连失败 → offline + autoRetrying（下一拍 2s）
    harness.hangRecover = true;
    vi.advanceTimersByTime(2000);
    await flushUntilHung();                    // 自动重试在途（挂起）
    const calls = harness.recoverCalls;
    await store.getState().reconnect();        // 回前台等场景：busy 早退，不得清掉在途记账
    expect(harness.recoverCalls).toBe(calls);
    // 放行在途尝试 → 失败：必须按「重连失败」升档（下一拍 4s），而不是 0 延迟再空跑一次。
    harness.hangRecover = false;
    harness.releaseHang?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState()).toMatchObject({ status: 'offline', connectionError: 'connectionUnavailable', autoRetrying: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.recoverCalls).toBe(calls);   // 0 延迟处没有新尝试
    await vi.advanceTimersByTimeAsync(3999);
    expect(harness.recoverCalls).toBe(calls);
    await vi.advanceTimersByTimeAsync(1);
    expect(harness.recoverCalls).toBe(calls + 1);   // 升档后的 4s 拍
    store.getState().pause();
  });

  it('重连连上后核对待确认命令失败：关连接回 offline 挂自动重试，不带着死通道假装连着（ai-review Nit）', async () => {
    harness.recoverError = null;
    harness.statusError = 'COMPANION_NO_RESPONSE';
    const identity = createIdentity();
    const store = createCompanionStore({
      read: async () => JSON.stringify({
        version: 1, publicKey: toHex(identity.publicKey), secretKey: toHex(identity.secretKey),
        binding: { version: 1, endpoint: 'http://192.168.1.2:8182', hostKey: 'aa'.repeat(32), deviceId: 'phone-1', scopeEpoch: 1, scope: ['s1'] },
        pending: { version: 1, deviceId: 'phone-1', scopeEpoch: 1, commandId: 'cmd-stuck', sessionId: 's1', action: 'message.send', payload: { text: '卡住的' } },
      }),
      write: async () => {},
      scan: async () => { throw new Error('unused'); },
      post: async () => ({}),
    }, () => {});
    await store.getState().hydrate();
    // 「连上」只是过场：reconcilePending 的 status 查询失败不得被吞——死通道停在 connected
    // 比回 offline 更糟（用户以为连着，其实什么也发不出去）。
    expect(store.getState()).toMatchObject({ status: 'offline', connectionError: 'connectionUnavailable', autoRetrying: true });
    expect(harness.closeCalls).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(2000);   // 挂上的自动重试照常走拍
    expect(harness.recoverCalls).toBeGreaterThan(1);
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

  it('手动重连只锁一个周期：一周期内置灰防重复点击，越过 requestTimeoutMs 解锁且点按真能抢占', async () => {
    const store = storeOf();
    await store.getState().hydrate();          // 首连失败 → offline + autoRetrying
    harness.hangRecover = true;
    const first = store.getState().reconnect({ resetBackoff: true });
    await flushUntilHung();
    expect(store.getState()).toMatchObject({ status: 'offline', busy: true, autoAttempt: false });
    // 第一周期内：手动尝试占 busy → 逃生口置灰（防重复点击照旧，D3 钉的那半不变）。
    expect(slotFrom(store).find(item => item?.rank === 2)?.action?.disabled).toBe(true);
    await vi.advanceTimersByTimeAsync(COMPANION_LIMITS.requestTimeoutMs - 1);
    expect(slotFrom(store).find(item => item?.rank === 2)?.action?.disabled).toBe(true);
    // 越过一个周期即解锁：一次手动尝试最长烧两个 LAN 地址各一拍再落 relay（约 20s+），
    // 整段锁死等于长时间没有逃生口（爸实测约 20s，设计只锁一个周期）。
    await vi.advanceTimersByTimeAsync(1);
    expect(store.getState().autoAttempt).toBe(true);
    expect(slotFrom(store).find(item => item?.rank === 2)?.action?.disabled).toBe(false);
    // 解锁后点「重新连接」真能抢占：新尝试进场（recoverCalls 增加）、重新锁一个周期；
    // 旧尝试迟到结果按代号丢弃（D3 不变式不回归）。
    const calls = harness.recoverCalls;
    const second = store.getState().reconnect({ resetBackoff: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.recoverCalls).toBe(calls + 1);
    expect(store.getState().autoAttempt).toBe(false);
    expect(slotFrom(store).find(item => item?.rank === 2)?.action?.disabled).toBe(true);
    // 宿主回来了：放行第二个（在途的）尝试 → 连上；第一个的迟到失败不得把新连接打回 offline。
    harness.recoverError = null;
    harness.hangRecover = false;
    harness.releaseHangs.at(-1)!();
    await second;
    expect(store.getState()).toMatchObject({ status: 'connected', busy: false });
    expect(harness.recoverCalls).toBe(calls + 2);   // 连上后的 relay 路由探针也走了一拍 recover
    // 两个尝试都收尾：解锁定时器清干净，不残留（此刻无退避拍在挂）。
    expect(vi.getTimerCount()).toBe(0);
    void first;   // 第一个尝试的 recover 还挂着（测试代管），pause 会顺带放行
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

  it('forget 与在途重连的落盘并发：清理写后落，盘上无绑定、冷启动不复活（ai-review Nit）', async () => {
    harness.recoverError = null;
    /** 只按完成序记录：断言的是「最后落在盘上的那份」，不是调用序。 */
    const settled: string[] = [];
    let releaseFirstWrite: (() => void) | null = null;
    let writeCalls = 0;
    const store = createCompanionStore({
      read: async () => savedBinding(),
      write: value => {
        writeCalls += 1;
        return new Promise<void>(resolve => {
          // 第一笔写（在途尝试的绑定写）挂起不放行，制造「已过代号校验、正在 persist」的窄窗口。
          if (writeCalls === 1) releaseFirstWrite = () => { settled.push(value); resolve(); };
          else { settled.push(value); resolve(); }
        });
      },
      scan: async () => { throw new Error('unused'); },
      post: async () => ({}),
    }, () => {});
    const hydrating = store.getState().hydrate();
    for (let i = 0; i < 30 && !releaseFirstWrite; i += 1) await Promise.resolve();
    expect(releaseFirstWrite, '在途尝试的绑定写应已挂起未决').toBeTruthy();
    expect(store.getState().busy).toBe(true);   // 自动尝试在途（占 busy）→ forget 走抢占
    const callsBeforeForget = harness.recoverCalls;
    const forgetting = store.getState().forget();   // 清理写排进链上，等链头（旧绑定写）先落
    // 冲几拍微任务：无串行链时 forget 的清理写此刻已抢跑落盘（旧绑定写还挂着、会后落）；
    // 有链时它仍被链头挡住，谁的写都没落盘。
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
    expect(settled.length).toBe(0);
    releaseFirstWrite!();
    await hydrating;
    await forgetting;
    expect(settled.length).toBe(2);
    expect(JSON.parse(settled[0]!).binding).toBeTruthy();   // 先落的是旧尝试的绑定写
    expect(JSON.parse(settled.at(-1)!).binding).toBeUndefined();   // 最后在盘上的必须是清理写
    // 冷启动读这块盘：不复活配对，也不起重连。
    const cold = createCompanionStore({
      read: async () => settled.at(-1)!,
      write: async () => {},
      scan: async () => { throw new Error('unused'); },
      post: async () => ({}),
    }, () => {});
    await cold.getState().hydrate();
    expect(cold.getState()).toMatchObject({ status: 'unpaired', binding: null });
    expect(harness.recoverCalls).toBe(callsBeforeForget);
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
