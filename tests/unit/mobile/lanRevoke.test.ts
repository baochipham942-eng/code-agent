import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createIdentity } from '../../../src/shared/companion/noiseChannel';
import { toHex } from '../../../src/shared/companion/lanProtocol';
import { createCompanionStore } from '../../../packages/mobile/src/stores/companionStore';
import type { PlatformPorts } from '../../../packages/mobile/src/platform/ports';

/**
 * N-MOBILE-CONN-POLISH-R3 ①：LAN 路撤销的状态位序列。宿主 revoke 当场关掉 channel，
 * 手机下一次 sync 的 exchange 403 由新宿主点名 COMPANION_DEVICE_REVOKED——store 必须把它
 * 按 revoked 结算（直接 connected → rejected），不走「传输失败 + 0 延迟重试」那条路
 * （那条路会先闪一拍「正在自动重试」，爸真机所见的那一闪正是它）。
 * 记法对照 relayPath.test.ts 的 O2 用例：订阅采样 (status, autoRetrying)，
 * 序列里不许出现 autoRetrying=true。传输层 mock 掉，这里只测 store 的结算。
 */
const harness = vi.hoisted(() => ({
  /** sync 请求抛什么错误码（null = 正常回事件页）。 */
  syncError: null as string | null,
  /** sync 挂起待撤销（「撤销时有 sync 在飞」的时序），放行闸由 rejectSync 接管。 */
  hangSync: false,
  rejectSync: null as null | ((error: Error) => void),
}));

vi.mock('../../../packages/mobile/src/platform/lanCompanionClient', () => ({
  LanCompanionClient: class {
    async pair() { throw new Error('unused'); }
    async recover() {
      // hostKey 与盘上绑定一致：撤销结算里 forgetSessionTitles 按这个键清整台记忆。
      return { version: 1 as const, endpoint: 'http://192.168.1.2:8182', hostKey: 'aa'.repeat(32), deviceId: 'phone-1', scopeEpoch: 1, scope: ['s1'] };
    }
    async request(payload: Record<string, unknown>) {
      if (payload.action === 'sync') {
        if (harness.hangSync) return new Promise<unknown>((_, reject) => { harness.rejectSync = reject; });
        if (harness.syncError) throw new Error(harness.syncError);
        return { kind: 'events', epoch: 1, nextSeq: 0, events: [] };
      }
      return { kind: 'accepted', command: { ...(payload.command as Record<string, unknown>), state: 'accepted', result: {} } };
    }
    close() {}
  },
}));

const HOST_KEY = 'aa'.repeat(32);

function savedBinding(): string {
  const identity = createIdentity();
  return JSON.stringify({
    version: 1, publicKey: toHex(identity.publicKey), secretKey: toHex(identity.secretKey),
    binding: { version: 1, endpoint: 'http://192.168.1.2:8182', hostKey: HOST_KEY, deviceId: 'phone-1', scopeEpoch: 1, scope: ['s1'] },
  });
}

function storeOf(forgotten: Array<[string, string | undefined]> = []) {
  const companion: NonNullable<PlatformPorts['companion']> = {
    read: async () => savedBinding(),
    write: async () => {},
    scan: async () => { throw new Error('unused'); },
    post: async () => ({}),
  };
  return createCompanionStore(companion, () => {}, undefined, undefined, undefined, {
    forgetSessionTitles: (host, sessionId) => { forgotten.push([host, sessionId]); },
  });
}

function recorder(store: ReturnType<typeof storeOf>) {
  const seen: { status: string; autoRetrying: boolean }[] = [];
  const unsubscribe = store.subscribe(state => seen.push({ status: state.status, autoRetrying: state.autoRetrying }));
  return { seen, unsubscribe };
}

describe('LAN 撤销：sync 收到 COMPANION_DEVICE_REVOKED 直接落 rejected，不闪自动重试', () => {
  beforeEach(() => {
    harness.syncError = null;
    harness.hangSync = false;
    harness.rejectSync = null;
  });

  it('撤销时没有 sync 在飞：下一次 sync 直接 connected → rejected', async () => {
    const forgotten: Array<[string, string | undefined]> = [];
    const store = storeOf(forgotten);
    await store.getState().hydrate();
    expect(store.getState().status).toBe('connected');
    const { seen, unsubscribe } = recorder(store);
    harness.syncError = 'COMPANION_DEVICE_REVOKED';   // 宿主已撤销：exchange 403 点名
    await store.getState().sync();
    expect(store.getState()).toMatchObject({ status: 'rejected', connectionError: 'connectionRejected', transport: null, sessionId: null });
    // 序列里不许出现 autoRetrying=true——那一拍就是爸看到的那一闪。
    expect(seen.filter(state => state.autoRetrying)).toEqual([]);
    expect(store.getState().history).toEqual({});    // 会话缓存随撤销一并清掉
    expect(forgotten.at(-1)).toEqual([HOST_KEY, undefined]);   // 整台标题记忆清空
    unsubscribe();
  });

  it('撤销时有 sync 在飞（宿主在请求途中撤销）：同样直接 rejected，不打回 offline', async () => {
    const store = storeOf();
    await store.getState().hydrate();
    expect(store.getState().status).toBe('connected');
    const { seen, unsubscribe } = recorder(store);
    harness.hangSync = true;
    const syncing = store.getState().sync();
    for (let i = 0; i < 30 && !harness.rejectSync; i += 1) await Promise.resolve();
    const settleSync = harness.rejectSync;
    if (!settleSync) throw new Error('sync 应已挂起未决');
    settleSync(new Error('COMPANION_DEVICE_REVOKED'));
    await syncing;
    expect(store.getState()).toMatchObject({ status: 'rejected', connectionError: 'connectionRejected' });
    expect(seen.filter(state => state.autoRetrying)).toEqual([]);
    unsubscribe();
  });

  it('传输类失败照旧走 offline + 自动重试，不吞成 rejected（TTL 过期的 CHANNEL_CLOSED 仍是「电脑没回应」）', async () => {
    const store = storeOf();
    await store.getState().hydrate();
    harness.syncError = 'COMPANION_CHANNEL_CLOSED';
    await store.getState().sync();
    expect(store.getState()).toMatchObject({ status: 'offline', connectionError: 'connectionUnavailable', autoRetrying: true });
    store.getState().pause();
  });
});
