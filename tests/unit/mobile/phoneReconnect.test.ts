import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createIdentity } from '../../../src/shared/companion/noiseChannel';
import { toHex } from '../../../src/shared/companion/lanProtocol';
import { COMPANION_LIMITS } from '../../../src/shared/constants/companion';
import { connectionBlocksAutoRetry, handshakeNeedsRescan, phoneReconnectDelayMs, phoneReconnectJitterMs } from '../../../packages/mobile/src/app/phoneReconnect';
import { createCompanionStore } from '../../../packages/mobile/src/stores/companionStore';
import type { PlatformPorts } from '../../../packages/mobile/src/platform/ports';

/**
 * N-MOBILE-AUTO-RECONNECT（design.md §13）：前台退避自动重连。
 * 节奏、10 分钟降频、后台停、回前台立即试、点重新连接重置、需重扫/存储出错不试。
 */
const harness = vi.hoisted(() => ({
  recoverError: 'COMPANION_NETWORK_UNAVAILABLE' as string | null,
  recoverCalls: 0,
  revoked: false,
}));

vi.mock('../../../packages/mobile/src/platform/lanCompanionClient', () => ({
  LanCompanionClient: class {
    async recover() {
      harness.recoverCalls += 1;
      if (harness.recoverError) throw new Error(harness.recoverError);
      return { version: 1 as const, endpoint: 'http://192.168.1.2:8182', hostKey: 'aa'.repeat(32), deviceId: 'phone-1', scopeEpoch: 1, scope: ['s1'] };
    }
    async request(payload: unknown) {
      if ((payload as { action?: string }).action === 'sync' && harness.revoked) {
        return { kind: 'revoked', epoch: 1, nextSeq: 0, events: [] };
      }
      return { kind: 'events', epoch: 1, nextSeq: 0, events: [] };
    }
    close() {}
  },
}));

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
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    vi.useFakeTimers();
  });
  afterEach(() => {
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
