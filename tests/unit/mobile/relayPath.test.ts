import { describe, expect, it, vi } from 'vitest';
import { createIdentity } from '../../../src/shared/companion/noiseChannel';
import { toHex } from '../../../src/shared/companion/lanProtocol';
import { createCompanionStore } from '../../../packages/mobile/src/stores/companionStore';
import type { PlatformPorts } from '../../../packages/mobile/src/platform/ports';

/**
 * N-MOBILE-RELAY-PHONE 双径策略的 store 形态（照 mdnsReconnect.test.ts 的替身法）：
 * LAN 直连优先，失败且有缓存路由才落 relay；LAN 恢复时收敛回直连，不双跑；
 * relay 面上听写/推送按「主机不支持」降级。传输两侧全部 mock，这里只测 store 的选择。
 */
const harness = vi.hoisted(() => ({
  lanError: null as string | null,
  /** 旧 Host 形态：exchange 不认识 relay.route ⇒ 关 channel（真机首验 2026-09-15 的现场）。 */
  oldHost: false,
  relayError: null as string | null,
  relayClosed: 0,
  relayConstructed: 0,
  onRevoked: null as null | (() => void),
  relayRequests: [] as Record<string, unknown>[],
  lanRequests: [] as Record<string, unknown>[],
  relayDials: [] as { url: string; authorization: string }[],
  /** 每个 mock LAN 客户端实例的存活标记——断言「会话通道没陪葬」用。 */
  lanClients: [] as { alive: boolean }[],
}));

vi.mock('../../../packages/mobile/src/platform/lanCompanionClient', () => ({
  LanCompanionClient: class {
    private readonly ref = { alive: true };
    constructor() { harness.lanClients.push(this.ref); }
    async pair() { throw new Error('unused'); }
    async recover() {
      if (harness.lanError) throw new Error(harness.lanError);
      return { version: 1 as const, endpoint: 'http://192.168.1.2:8182', hostKey: 'aa'.repeat(32),
        deviceId: 'phone-1', scopeEpoch: 1, scope: ['shared'] };
    }
    async request(payload: Record<string, unknown>) {
      if (!this.ref.alive) throw new Error('COMPANION_NOT_CONNECTED');
      harness.lanRequests.push(payload);
      if (payload.action === 'relay.route') {
        if (harness.oldHost) {
          // 旧 Host：未知动作 ⇒ 服务端关 channel，客户端 self-close——这条通道从此死透。
          this.ref.alive = false;
          throw new Error('COMPANION_NETWORK_UNAVAILABLE');
        }
        return { kind: 'ok', v: 1, url: 'ws://127.0.0.1:8791/', routeToken: 'route-token-aaaaaa', credential: 'relay-shared-credential' };
      }
      if (payload.action === 'command') {
        // 结算回执：原样回带命令身份（companionAckMatches 按 commandId/deviceId/sessionId/action 认人）。
        return { kind: 'accepted', command: { ...(payload.command as Record<string, unknown>), state: 'accepted', result: {} } };
      }
      return { kind: 'events', epoch: 1, nextSeq: 0, events: [] };
    }
    close() { this.ref.alive = false; }
  },
}));

vi.mock('../../../packages/mobile/src/platform/relayCompanionClient', () => ({
  browserRelayDial: () => { throw new Error('test must inject dialRelay'); },
  RelayCompanionClient: class {
    constructor(deps: { onRevoked?: () => void; dial: (url: string, headers: { authorization: string }) => unknown }) {
      harness.relayConstructed += 1;
      harness.onRevoked = deps.onRevoked ?? null;
      // store 会把 port.dialRelay 传进来；借构造把拨号参数记下来。
      deps.dial('capture://dial', { authorization: '' });
    }
    async connect() {
      harness.relayDials.push({ url: 'captured-in-store-test', authorization: 'n/a' });
      if (harness.relayError) throw new Error(harness.relayError);
    }
    async resume() { if (harness.relayError) throw new Error(harness.relayError); }
    async request(payload: Record<string, unknown>) {
      harness.relayRequests.push(payload);
      if (payload.action === 'sync') return { kind: 'events', epoch: 1, nextSeq: 0, events: [] };
      return { kind: 'accepted', command: { commandId: 'x', state: 'accepted', result: {} } };
    }
    close() { harness.relayClosed += 1; }
  },
}));

const identity = createIdentity();
const RELAY_ROUTE = { v: 1 as const, url: 'ws://127.0.0.1:8791/', routeToken: 'route-token-aaaaaa', credential: 'relay-shared-credential' };

function storageWith(options: { relay?: unknown } = {}) {
  return JSON.stringify({
    version: 1, publicKey: toHex(identity.publicKey), secretKey: toHex(identity.secretKey),
    binding: { version: 1, endpoint: 'http://192.168.1.2:8182', hostKey: 'aa'.repeat(32), deviceId: 'phone-1', scopeEpoch: 1, scope: ['shared'] },
    ...(options.relay === undefined ? {} : { relay: options.relay }),
  });
}

function storeWith(raw: string) {
  const companion: NonNullable<PlatformPorts['companion']> = {
    read: async () => raw,
    write: async () => {},
    scan: async () => { throw new Error('unused'); },
    post: async () => ({}),
    dialRelay: () => ({ send: () => {}, close: () => {}, onOpen: () => {}, onClose: () => {}, onError: () => {}, onMessage: () => {} }),
  };
  return createCompanionStore(companion, () => {});
}

describe('companionStore 双径：LAN 优先、relay 回落、恢复收敛', () => {
  it('LAN 失败 + 有缓存路由 ⇒ 落 relay：connected 且 transport=relay', async () => {
    harness.lanError = 'COMPANION_NETWORK_UNAVAILABLE';
    harness.relayError = null; harness.relayConstructed = 0; harness.relayClosed = 0;
    const store = storeWith(storageWith({ relay: RELAY_ROUTE }));
    await store.getState().hydrate();
    expect(store.getState()).toMatchObject({ status: 'connected', transport: 'relay' });
    expect(harness.relayConstructed).toBe(1);
    store.getState().pause();
  });

  it('LAN 失败 + relay 也失败 ⇒ offline，relay 失败码可分类', async () => {
    harness.lanError = 'COMPANION_NETWORK_UNAVAILABLE';
    harness.relayError = 'COMPANION_RELAY_UNAVAILABLE';
    const store = storeWith(storageWith({ relay: RELAY_ROUTE }));
    await store.getState().hydrate();
    expect(store.getState()).toMatchObject({ status: 'offline', connectionError: 'connectionRelayUnavailable', transport: null });
    harness.relayError = 'COMPANION_RELAY_AUTH_REJECTED';
    const other = storeWith(storageWith({ relay: RELAY_ROUTE }));
    await other.getState().hydrate();
    expect(other.getState()).toMatchObject({ status: 'offline', connectionError: 'connectionRelayRejected' });
    harness.relayError = 'COMPANION_RELAY_NO_HOST';
    const noHost = storeWith(storageWith({ relay: RELAY_ROUTE }));
    await noHost.getState().hydrate();
    expect(noHost.getState()).toMatchObject({ status: 'offline', connectionError: 'connectionRelayNoHost' });
  });

  it('LAN 失败 + 没有缓存路由 ⇒ 只报 LAN 的错误（行为不劣化）', async () => {
    harness.lanError = 'COMPANION_NETWORK_UNAVAILABLE';
    harness.relayError = null; harness.relayConstructed = 0;
    const store = storeWith(storageWith());
    await store.getState().hydrate();
    expect(store.getState()).toMatchObject({ status: 'offline', connectionError: 'connectionUnavailable' });
    expect(harness.relayConstructed).toBe(0);
  });

  it('LAN 恢复 ⇒ 收敛回直连，relay 客户端被关掉（不双跑）', async () => {
    harness.relayClosed = 0;
    harness.lanError = 'COMPANION_NETWORK_UNAVAILABLE';
    harness.relayError = null;
    const store = storeWith(storageWith({ relay: RELAY_ROUTE }));
    await store.getState().hydrate();
    expect(store.getState().transport).toBe('relay');
    harness.lanError = null;
    await store.getState().reconnect();
    expect(store.getState()).toMatchObject({ status: 'connected', transport: 'lan' });
    expect(harness.relayClosed).toBeGreaterThan(0);
    store.getState().pause();
  });

  it('relay 连接期间听写与推送按「主机不支持」降级，不把请求发出去', async () => {
    harness.lanError = 'COMPANION_NETWORK_UNAVAILABLE';
    harness.relayError = null; harness.relayRequests = [];
    const store = storeWith(storageWith({ relay: RELAY_ROUTE }));
    await store.getState().hydrate();
    expect(await store.getState().dictationOpen()).toMatchObject({ ok: false, code: 'COMPANION_DICTATION_UNAVAILABLE' });
    expect(await store.getState().registerPush({ provider: 'apns', token: 't', environment: 'production' }))
      .toMatchObject({ kind: 'rejected', reason: 'unsupported_action' });
    await store.getState().openRoute('route-token');
    expect(store.getState().routeError).toBe('unsupported_action');
    expect(harness.relayRequests.map(payload => payload.action)).not.toContain('dictation');
    expect(harness.relayRequests.map(payload => payload.action)).not.toContain('push.register');
    expect(harness.relayRequests.map(payload => payload.action)).not.toContain('push.open');
    store.getState().pause();
  });

  it('relay 面的 onRevoked 把设备翻成 rejected（revoke 帧路径的 store 接线）', async () => {
    harness.lanError = 'COMPANION_NETWORK_UNAVAILABLE';
    harness.relayError = null;
    const store = storeWith(storageWith({ relay: RELAY_ROUTE }));
    await store.getState().hydrate();
    expect(harness.onRevoked).toBeTruthy();
    harness.onRevoked?.();
    expect(store.getState()).toMatchObject({ status: 'rejected', connectionError: 'connectionRejected', transport: null });
  });

  it('配对盘里坏掉的 relay 路由被丢弃，配对身份不受连累', async () => {
    harness.lanError = 'COMPANION_NETWORK_UNAVAILABLE';
    harness.relayConstructed = 0;
    const store = storeWith(storageWith({ relay: { v: 2, url: 'not a url', routeToken: 'x', credential: 'short' } }));
    await store.getState().hydrate();
    // 路由被丢 ⇒ 没有 relay 可落，报的还是 LAN 的错误，且配对身份照常可恢复。
    expect(store.getState()).toMatchObject({ status: 'offline', connectionError: 'connectionUnavailable' });
    expect(harness.relayConstructed).toBe(0);
  });

  it('LAN 连着时刷新到新 routeToken 会写回配对盘', async () => {
    harness.lanError = null; harness.lanRequests = []; harness.oldHost = false;
    const writes: string[] = [];
    const companion: NonNullable<PlatformPorts['companion']> = {
      read: async () => storageWith({ relay: RELAY_ROUTE }),
      write: async value => { writes.push(value); },
      scan: async () => { throw new Error('unused'); },
      post: async () => ({}),
      dialRelay: () => ({ send: () => {}, close: () => {}, onOpen: () => {}, onClose: () => {}, onError: () => {}, onMessage: () => {} }),
    };
    const store = createCompanionStore(companion, () => {});
    await store.getState().hydrate();
    // mock 的 relay.route 永远回同一个 token ⇒ hydrate 重连走 LAN 时会请求一次路由。
    expect(harness.lanRequests.map(payload => payload.action)).toContain('relay.route');
    expect(writes.length).toBeGreaterThan(0);
    expect(JSON.parse(writes.at(-1) ?? '{}').relay).toMatchObject({ routeToken: 'route-token-aaaaaa' });
    store.getState().pause();
  });

  it('旧 Host 把 relay.route 当未知动作关 channel：会话通道不陪葬（真机首验回归）', async () => {
    harness.lanError = null; harness.oldHost = true; harness.lanClients = []; harness.lanRequests = [];
    const store = storeWith(storageWith());
    await store.getState().hydrate();
    // LAN 恢复成功、路由探针被旧 Host 拒杀——但状态仍是 connected、会话通道还活着。
    expect(store.getState()).toMatchObject({ status: 'connected', transport: 'lan' });
    expect(harness.lanClients.length).toBe(2); // 主通道 + 探针
    expect(harness.lanClients[0].alive).toBe(true); // 主通道没陪葬
    expect(harness.lanClients[1].alive).toBe(false); // 死的只是探针
    // 首验现场正是这里：路由一问把会话通道打死，首次 sync 即掉线报「电脑没回应」。
    await store.getState().sync();
    expect(store.getState()).toMatchObject({ status: 'connected' });
    await store.getState().send('old-host-正文');
    expect(store.getState()).toMatchObject({ status: 'connected', pending: false });
    store.getState().pause();
  });
});
