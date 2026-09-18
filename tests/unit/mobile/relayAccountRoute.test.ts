import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createIdentity } from '../../../src/shared/companion/noiseChannel';
import { toHex } from '../../../src/shared/companion/lanProtocol';
import { createCompanionStore } from '../../../packages/mobile/src/stores/companionStore';
import type { PlatformPorts } from '../../../packages/mobile/src/platform/ports';
import type { RelayDialRoute } from '../../../packages/mobile/src/platform/relayCompanionClient';

/**
 * N-COMPANION-RELAY-ACCOUNT-ROUTE-PHONE 双路由回落与账号落盘的 store 形态（照 relayPath.test.ts
 * 的替身法）：账号路由+票据优先、失败当次回落旧路由、老记录逐字节照旧、票据被拒置失效报
 * 「需要登录」、登录成功只落票据/邮箱/用户 id。传输两侧与登录模块全部 mock，只测 store 的选择。
 */
const harness = vi.hoisted(() => ({
  lanError: null as string | null,
  /** relay.routes 探针的返回（真服务器形状：routes 里带 v:1）：两条都有 / 都没有。 */
  routesResult: null as null | { v: 1; account?: { v: 1; url: string; routeToken: string }; legacy?: { v: 1; url: string; routeToken: string; credential: string } },
  /** relay.routes 探针是否被旧 Host 拒杀（关 channel）；拒杀后回落问 relay.route。 */
  routesKilled: false,
  /** 账号路由拨号的失败码：置了就在带票据的那次 connect 上抛。 */
  accountRouteError: null as string | null,
  relayConstructed: 0,
  relayDials: [] as { url: string; authorization: string }[],
  /** 每个构造出来的客户端拿到的路由（含凭据形态），按构造顺序。 */
  relayRoutes: [] as RelayDialRoute[],
  onTicket: null as null | ((ticket: string) => void),
  loginResult: null as null | { ok: true; ticket: string; userId: string; email: string } | { ok: false; kind: 'invalidCredentials' } | { ok: false; kind: 'unreachable' },
  loginCalls: [] as { email: string; password: string; hostAccountEmail: string | null; relayUrl: string | null }[],
  lanRequests: [] as Record<string, unknown>[],
  /** LAN recover 的 welcome 是否带电脑账号邮箱（真实 Host 登录时随 welcome 下发）。 */
  hostEmail: null as string | null,
}));

vi.mock('../../../packages/mobile/src/platform/lanCompanionClient', () => ({
  LanCompanionClient: class {
    private readonly alive = { value: true };
    async pair() { throw new Error('unused'); }
    async recover() {
      if (harness.lanError) throw new Error(harness.lanError);
      return { version: 1 as const, endpoint: 'http://192.168.1.2:8182', hostKey: 'aa'.repeat(32),
        deviceId: 'phone-1', scopeEpoch: 1, scope: ['shared'],
        ...(harness.hostEmail ? { hostAccountEmail: harness.hostEmail } : {}) };
    }
    async request(payload: Record<string, unknown>) {
      if (!this.alive.value) throw new Error('COMPANION_NOT_CONNECTED');
      harness.lanRequests.push(payload);
      if (payload.action === 'relay.routes') {
        if (harness.routesKilled) { this.alive.value = false; throw new Error('HTTP_403'); }
        return harness.routesResult ? { kind: 'ok', routes: harness.routesResult } : { kind: 'unavailable' };
      }
      if (payload.action === 'relay.route') return { kind: 'ok', v: 1, url: 'ws://127.0.0.1:8791/', routeToken: 'route-token-aaaaaa', credential: 'relay-shared-credential' };
      if (payload.action === 'command') {
        return { kind: 'accepted', command: { ...(payload.command as Record<string, unknown>), state: 'accepted', result: {} } };
      }
      return { kind: 'events', epoch: 1, nextSeq: 0, events: [] };
    }
    close() { this.alive.value = false; }
  },
}));

vi.mock('../../../packages/mobile/src/platform/relayCompanionClient', () => ({
  browserRelayDial: () => { throw new Error('test must inject dialRelay'); },
  RelayCompanionClient: class {
    /** 这次拨号是不是账号路由（带票据）：置了 accountRouteError 就在 connect/resume 上抛。 */
    private readonly viaTicket: boolean;
    constructor(deps: { route: RelayDialRoute; dial: (url: string, headers: { authorization: string }) => unknown; onTicket?: (ticket: string) => void }) {
      harness.relayConstructed += 1;
      harness.relayRoutes.push(deps.route);
      harness.onTicket = deps.onTicket ?? null;
      this.viaTicket = Boolean(deps.route.ticket);
      const credential = deps.route.ticket ?? deps.route.credential ?? '';
      deps.dial(deps.route.url, { authorization: `Bearer ${credential}` });
    }
    async connect() { if (this.viaTicket && harness.accountRouteError) throw new Error(harness.accountRouteError); }
    async resume() { if (this.viaTicket && harness.accountRouteError) throw new Error(harness.accountRouteError); }
    async request(payload: Record<string, unknown>) {
      if (payload.action === 'command') return { kind: 'accepted', command: { ...(payload.command as Record<string, unknown>), state: 'accepted', result: {} } };
      return { kind: 'events', epoch: 1, nextSeq: 0, events: [] };
    }
    close() {}
  },
}));

vi.mock('../../../packages/mobile/src/platform/accountLogin', () => ({
  loginNeoAccount: async (input: { email: string; password: string; hostAccountEmail: string | null; relayUrl: string | null }) => {
    harness.loginCalls.push({ email: input.email, password: input.password, hostAccountEmail: input.hostAccountEmail, relayUrl: input.relayUrl });
    return harness.loginResult ?? { ok: false, kind: 'unreachable' };
  },
}));

const identity = createIdentity();
const RELAY_ROUTE = { v: 1 as const, url: 'ws://127.0.0.1:8791/', routeToken: 'route-token-aaaaaa', credential: 'relay-shared-credential' };
const ACCOUNT_ROUTE = { v: 1 as const, url: 'ws://127.0.0.1:8791/', routeToken: 'account-token-bbbbbb' };
const ACCOUNT = { ticket: 'neo1.payload.mac', email: 'lin@example.com', userId: 'user-1' };

function storageWith(options: { relay?: unknown; relayAccount?: unknown; account?: unknown; loginReminded?: true; hostAccountEmail?: string } = {}) {
  return JSON.stringify({
    version: 1, publicKey: toHex(identity.publicKey), secretKey: toHex(identity.secretKey),
    binding: { version: 1, endpoint: 'http://192.168.1.2:8182', hostKey: 'aa'.repeat(32), deviceId: 'phone-1', scopeEpoch: 1, scope: ['shared'],
      ...(options.hostAccountEmail ? { hostAccountEmail: options.hostAccountEmail } : {}) },
    ...(options.relay === undefined ? {} : { relay: options.relay }),
    ...(options.relayAccount === undefined ? {} : { relayAccount: options.relayAccount }),
    ...(options.account === undefined ? {} : { account: options.account }),
    ...(options.loginReminded === undefined ? {} : { loginReminded: options.loginReminded }),
  });
}

function storeWith(raw: string) {
  const writes: string[] = [];
  const companion: NonNullable<PlatformPorts['companion']> = {
    read: async () => raw,
    write: async value => { writes.push(value); },
    scan: async () => { throw new Error('unused'); },
    post: async () => ({}),
    dialRelay: () => ({ send: () => {}, close: () => {}, onOpen: () => {}, onClose: () => {}, onError: () => {}, onMessage: () => {} }),
  };
  return { store: createCompanionStore(companion, () => {}), writes };
}

beforeEach(() => {
  harness.lanError = null;
  harness.routesResult = null;
  harness.routesKilled = false;
  harness.accountRouteError = null;
  harness.relayConstructed = 0;
  harness.relayDials = [];
  harness.relayRoutes = [];
  harness.onTicket = null;
  harness.loginResult = null;
  harness.loginCalls = [];
  harness.lanRequests = [];
  harness.hostEmail = null;
});

describe('companionStore 双路由：账号优先、当次回落、老记录零差异', () => {
  it('① 有账号路由+票据 ⇒ 拨的是账号路由，凭据子协议里带的是票据', async () => {
    harness.lanError = 'COMPANION_NETWORK_UNAVAILABLE';
    const { store } = storeWith(storageWith({ relay: RELAY_ROUTE, relayAccount: ACCOUNT_ROUTE, account: ACCOUNT }));
    await store.getState().hydrate();
    expect(store.getState()).toMatchObject({ status: 'connected', transport: 'relay' });
    expect(harness.relayConstructed).toBe(1);
    // 传给 RelayCompanionClient 的路由 = 账号路由 + 票据；credential 不掺和。
    expect(harness.relayRoutes[0]).toEqual({ ...ACCOUNT_ROUTE, ticket: ACCOUNT.ticket });
    store.getState().pause();
  });

  it('② 账号路由收 no-host ⇒ 同一次连接动作里改拨旧路由并连上', async () => {
    harness.lanError = 'COMPANION_NETWORK_UNAVAILABLE';
    harness.accountRouteError = 'COMPANION_RELAY_NO_HOST';
    const { store } = storeWith(storageWith({ relay: RELAY_ROUTE, relayAccount: ACCOUNT_ROUTE, account: ACCOUNT }));
    await store.getState().hydrate();
    expect(store.getState()).toMatchObject({ status: 'connected', transport: 'relay' });
    expect(harness.relayRoutes).toEqual([
      { ...ACCOUNT_ROUTE, ticket: ACCOUNT.ticket },
      RELAY_ROUTE,
    ]);
    // 票据没被拒（no-host 不是拒绝）：账号信息保留。
    expect(store.getState().account).toEqual({ email: ACCOUNT.email, userId: ACCOUNT.userId });
    store.getState().pause();
  });

  it('③ 只有旧路由的老配对记录 ⇒ 拨号路由与凭据形态逐字节照旧，落盘不添新键', async () => {
    harness.lanError = 'COMPANION_NETWORK_UNAVAILABLE';
    const { store, writes } = storeWith(storageWith({ relay: RELAY_ROUTE }));
    await store.getState().hydrate();
    expect(store.getState()).toMatchObject({ status: 'connected', transport: 'relay' });
    expect(harness.relayConstructed).toBe(1);
    // 旧路由整份原样下发（含 credential，无 ticket 键）。
    expect(harness.relayRoutes[0]).toEqual(RELAY_ROUTE);
    expect('ticket' in harness.relayRoutes[0]).toBe(false);
    // 没有谁写盘就不会多出 relayAccount/account（本用例 hydrate 后无新写）。
    for (const write of writes) {
      expect(JSON.parse(write).relayAccount).toBeUndefined();
      expect(JSON.parse(write).account).toBeUndefined();
    }
    store.getState().pause();
  });

  it('④ 票据被拒 ⇒ 置失效（落盘删账号）并报「需要登录」，当次仍回落旧路由连上', async () => {
    harness.lanError = 'COMPANION_NETWORK_UNAVAILABLE';
    harness.accountRouteError = 'COMPANION_RELAY_AUTH_REJECTED';
    const { store, writes } = storeWith(storageWith({ relay: RELAY_ROUTE, relayAccount: ACCOUNT_ROUTE, account: ACCOUNT }));
    await store.getState().hydrate();
    expect(store.getState()).toMatchObject({ status: 'connected', transport: 'relay' });
    // 两条都拨了：先账号（被拒）再旧路由。
    expect(harness.relayRoutes).toHaveLength(2);
    // 票据被拒的结算：账号信息从盘上删掉、S8 置起、React 态里没有票据。
    expect(store.getState().account).toBeNull();
    expect(store.getState().loginPrompt).toBe(true);
    const last = JSON.parse(writes.at(-1) ?? '{}');
    expect(last.account).toBeUndefined();
    expect(JSON.stringify(writes)).not.toContain(ACCOUNT.ticket);
    store.getState().pause();
  });

  it('⑤ 登录成功 ⇒ 票据/邮箱/用户 id 落进配对盘，access token 与密码绝不落盘（M4 守卫）', async () => {
    harness.loginResult = { ok: true, ticket: 'neo1.fresh-ticket', userId: 'user-1', email: 'lin@example.com' };
    harness.hostEmail = 'lin@example.com';
    const { store, writes } = storeWith(storageWith({ relay: RELAY_ROUTE, hostAccountEmail: 'lin@example.com' }));
    await store.getState().hydrate();
    harness.loginCalls.length = 0;
    const outcome = await store.getState().login('lin@example.com', 'super-secret-password');
    expect(outcome).toEqual({ ok: true });
    // 登录入参把电脑账号邮箱与 relay 地址都带对了。
    expect(harness.loginCalls[0]).toMatchObject({ hostAccountEmail: 'lin@example.com', relayUrl: 'ws://127.0.0.1:8791/' });
    const record = JSON.parse(writes.at(-1) ?? '{}');
    expect(record.account).toEqual({ ticket: 'neo1.fresh-ticket', email: 'lin@example.com', userId: 'user-1' });
    expect(store.getState().account).toEqual({ email: 'lin@example.com', userId: 'user-1' });
    // 密码与令牌不进任何一次落盘（token 没进 store，这里能搜的只有密码与票据之外的一切）。
    expect(JSON.stringify(writes)).not.toContain('super-secret-password');
    store.getState().pause();
  });

  it('S8（D-1）：配对着、没登录、第一次 LAN 连不上 ⇒ 提醒一次并落 loginReminded；之后不再弹', async () => {
    harness.lanError = 'COMPANION_NETWORK_UNAVAILABLE';
    const { store, writes } = storeWith(storageWith());   // 没路由、没账号：offline 落定
    await store.getState().hydrate();
    expect(store.getState().loginPrompt).toBe(true);
    expect(JSON.parse(writes.at(-1) ?? '{}').loginReminded).toBe(true);
    // 第二次失败（手动重连）：不再置提醒。
    store.getState().dismissLoginPrompt();
    await store.getState().reconnect({ resetBackoff: true });
    expect(store.getState().loginPrompt).toBe(false);
    // 已登录的落 offline 不弹 S8（登录本身已是答案）。
    harness.relayConstructed = 0;
    const loggedIn = storeWith(storageWith({ account: ACCOUNT }));
    await loggedIn.store.getState().hydrate();
    expect(loggedIn.store.getState().loginPrompt).toBe(false);
    loggedIn.store.getState().pause();
  });

  it('路由探针改问 relay.routes：两条都缓存；旧 Host 拒杀探针时回落问 relay.route', async () => {
    harness.lanError = null;
    // 先跑一次「两条都有」：LAN 直连成功后探针问 relay.routes。
    harness.routesResult = { v: 1 as const, account: ACCOUNT_ROUTE, legacy: RELAY_ROUTE };
    const both = storeWith(storageWith());
    await both.store.getState().hydrate();
    expect(harness.lanRequests.map(payload => payload.action)).toContain('relay.routes');
    expect(JSON.parse(both.writes.at(-1) ?? '{}')).toMatchObject({
      relay: { routeToken: 'route-token-aaaaaa' },
      relayAccount: { routeToken: 'account-token-bbbbbb' },
    });
    both.store.getState().pause();
    // 旧 Host：relay.routes 被当未知动作拒杀（探针通道被关）⇒ 回落 relay.route，缓存旧路由（今天的行为）。
    harness.lanRequests = [];
    harness.routesKilled = true;
    harness.routesResult = null;
    const legacyHost = storeWith(storageWith());
    await legacyHost.store.getState().hydrate();
    const actions = harness.lanRequests.map(payload => payload.action);
    expect(actions).toContain('relay.routes');
    expect(actions).toContain('relay.route');
    expect(JSON.parse(legacyHost.writes.at(-1) ?? '{}').relay).toMatchObject({ routeToken: 'route-token-aaaaaa' });
    expect(JSON.parse(legacyHost.writes.at(-1) ?? '{}').relayAccount).toBeUndefined();
    legacyHost.store.getState().pause();
  });

  it('旧记录缺 relayAccount/account（字段级）⇒ 配对照常可用，不判无效（M5 守卫）', async () => {
    harness.lanError = 'COMPANION_NETWORK_UNAVAILABLE';
    const { store } = storeWith(storageWith({ relay: RELAY_ROUTE }));
    await store.getState().hydrate();
    expect(store.getState()).toMatchObject({ status: 'connected', transport: 'relay', account: null });
    // 坏的账号路由/账号记录按条丢弃，身份不受连累。
    harness.relayConstructed = 0;
    const damaged = storeWith(storageWith({
      relay: RELAY_ROUTE,
      relayAccount: { v: 1, url: 'not a url', routeToken: 'x' },
      account: { ticket: '', email: 'lin@example.com', userId: 'user-1' },
    }));
    await damaged.store.getState().hydrate();
    expect(damaged.store.getState()).toMatchObject({ status: 'connected', transport: 'relay' });
    damaged.store.getState().pause();
  });

  it('退出登录 ⇒ 删票据与账号信息，配对与 LAN 使用不受影响', async () => {
    harness.lanError = null;
    const { store, writes } = storeWith(storageWith({ relay: RELAY_ROUTE, account: ACCOUNT }));
    await store.getState().hydrate();
    expect(store.getState().account).toEqual({ email: ACCOUNT.email, userId: ACCOUNT.userId });
    await store.getState().logout();
    expect(store.getState().account).toBeNull();
    expect(JSON.parse(writes.at(-1) ?? '{}').account).toBeUndefined();
    // 配对还在、连接还在（LAN）。
    expect(store.getState()).toMatchObject({ status: 'connected', transport: 'lan', binding: { deviceId: 'phone-1' } });
    store.getState().pause();
  });
});
