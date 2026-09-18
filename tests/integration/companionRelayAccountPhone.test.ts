import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import WebSocket from 'ws';
import { networkInterfaces } from 'node:os';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompanionGateway } from '../../src/host/services/companion/CompanionGateway';
import { CompanionRelayClient, startCompanionRelayAccountIfConfigured } from '../../src/host/services/companion/CompanionRelayClient';
import { LanCompanionServer } from '../../src/host/services/companion/LanCompanionServer';
import { RelayTicketAuth } from '../../packages/relay/src/ticketAuth';
import { CompanionRelayServer } from '../../packages/relay/src/server';
import { SupabaseJwtVerifier } from '../../packages/relay/src/accountAuth';
import { createIdentity } from '../../src/shared/companion/noiseChannel';
import { isPrivateIPv4 } from '../../src/shared/companion/lanProtocol';
import { COMPANION_LIMITS as L } from '../../src/shared/constants/companion';
import { DEFAULT_SUPABASE_URL } from '../../src/shared/constants/network';
import { createCompanionStore } from '../../packages/mobile/src/stores/companionStore';
import type { RelayDial as RelayDialType } from '../../packages/mobile/src/platform/relayCompanionClient';

/**
 * N-COMPANION-RELAY-ACCOUNT-ROUTE-PHONE 端到端：真 relay 服务端（账号验签 + 票据签发）+
 * 真 Host 双通道 + 真 LanCompanionServer + 真手机 store。只替两样——WebView 的 WebSocket
 * （node ws dial）与 Supabase 密码端点（stub fetch，令牌是本地签的 ES256 JWT）。
 * 覆盖：登录换票落盘（票据/邮箱/用户 id，无 token 无密码）、账号路由票据拨号、
 * 账号通道缺席回落旧路由、死票置失效报「需要登录」。
 */

const SECRET = 'relay-shared-credential';
const SUPABASE = 'https://proj.supabase.co';
const HOST_EMAIL = 'lin@example.com';
const USER_ID = 'user-1';

const nodeDial: RelayDialType = (url, headers) => {
  const socket = new WebSocket(url, { headers });
  return {
    send: data => socket.send(data),
    close: () => socket.close(),
    onOpen: handler => socket.once('open', handler),
    onMessage: handler => socket.on('message', data => handler(String(data))),
    onClose: handler => socket.once('close', handler),
    onError: handler => socket.once('error', handler),
  };
};

const signingKey = (() => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return { kid: 'kid-1', privateKey, jwk: { ...publicKey.export({ format: 'jwk' }), kid: 'kid-1', alg: 'ES256', use: 'sig' } };
})();

function accessToken(sub: string): string {
  const enc = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const head = enc({ alg: 'ES256', typ: 'JWT', kid: signingKey.kid });
  const body = enc({ iss: `${SUPABASE}/auth/v1`, aud: 'authenticated', role: 'authenticated', sub, exp: Math.floor(Date.now() / 1000) + 3600 });
  return `${head}.${body}.${sign('sha256', Buffer.from(`${head}.${body}`), { key: signingKey.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
}

function fakeAuth(initial: string | null) {
  let user = initial;
  const listeners: Array<(user: { id: string } | null) => void> = [];
  return {
    getCurrentUser: () => user ? { id: user } : null,
    getAccessToken: async () => user ? accessToken(user) : null,
    addAuthChangeCallback: (callback: (user: { id: string } | null) => void) => {
      listeners.push(callback);
      return () => { listeners.splice(listeners.indexOf(callback), 1); };
    },
    switchTo(next: string | null) {
      user = next;
      for (const listener of [...listeners]) listener(next ? { id: next } : null);
    },
  };
}

describe('companion relay account route phone: login, dual routes, fallback (e2e)', () => {
  let db: Database.Database;
  let gateway: CompanionGateway;
  let lanServer: LanCompanionServer;
  let relay: CompanionRelayServer;
  let verifier: SupabaseJwtVerifier;
  let ticketAuth: RelayTicketAuth;
  let legacyHost: CompanionRelayClient;
  let account: ReturnType<typeof startCompanionRelayAccountIfConfigured>;
  let auth: ReturnType<typeof fakeAuth>;
  let dataDir: string;
  let url: string;
  let storage: string | null;
  let lanUp: boolean;
  const executions: number[] = [0];
  const hostIdentity = createIdentity();
  const address = Object.values(networkInterfaces()).flat().find(n => n?.family === 'IPv4' && isPrivateIPv4(n.address))?.address;

  const post = async (target: string, body: unknown) => {
    if (!lanUp) throw new Error('COMPANION_NETWORK_UNAVAILABLE');
    const res = await fetch(target, { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const raw = await res.text();
    if (!res.ok) throw new Error(`HTTP_${res.status}`);
    return JSON.parse(raw) as unknown;
  };

  beforeEach(async () => {
    if (!address) throw new Error('LAN_TEST_REQUIRES_PRIVATE_IPV4_ON_FLEET');
    executions[0] = 0; storage = null; lanUp = true;
    db = new Database(':memory:');
    gateway = new CompanionGateway(db, {
      dispatch: () => { executions[0] += 1; return { state: 'accepted', result: { runId: 'test-run' } }; },
      read: async () => ({ sessions: [], projects: [], models: [], nextOffset: null }),
    });
    dataDir = mkdtempSync(join(tmpdir(), 'relay-account-phone-'));
    // relay：真服务端，认共享凭据 + Supabase 令牌（本地签的 ES256）+ 设备票据签发。
    verifier = new SupabaseJwtVerifier({ supabaseUrl: SUPABASE, cacheFile: join(dataDir, 'jwks.json'), fetch: (async () =>
      new Response(JSON.stringify({ keys: [signingKey.jwk] }), { status: 200 })) as typeof fetch });
    verifier.start();
    await verifier.refresh();
    ticketAuth = new RelayTicketAuth({ keyFile: join(dataDir, 'ticket.key') });
    relay = new CompanionRelayServer({ credential: SECRET, accountVerifier: verifier, ticketAuth, noHostGraceMs: 100 });
    const bound = await relay.listen();
    url = `ws://127.0.0.1:${bound.port}`;
    // Host 双通道：共享凭据（旧路由）+ 账号通道（acct:user-1 路由 + welcome 里的电脑账号邮箱）。
    const config = { url, credentialRef: 'companion-relay', reconnectBackoffMs: [30, 60, 120] };
    writeFileSync(join(dataDir, L.relayConfigFile), JSON.stringify({ v: 1, enabled: true, ...config }));
    legacyHost = new CompanionRelayClient({ gateway, identity: hostIdentity, config, credential: SECRET, jitter: () => 0.5 });
    await legacyHost.start();
    await legacyHost.whenConnected();
    auth = fakeAuth(USER_ID);
    account = startCompanionRelayAccountIfConfigured({
      dataDirectory: dataDir, gateway, loadIdentity: async () => hostIdentity, auth, jitter: () => 0.5,
    });
    // 账号通道 status 的 'connected' 要撑过 5s 稳定期才翻；拨号就绪以 relay 的账号在线账为准。
    await vi.waitFor(() => expect(relay.currentStats.accountConnections).toBeGreaterThan(0));
    lanServer = new LanCompanionServer(gateway, hostIdentity, Date.now, undefined,
      deviceId => legacyHost.routeFor(deviceId),
      deviceId => account.relayRoute(deviceId),
      () => HOST_EMAIL);
    await lanServer.start(address, 0);
    // 手机：真 store；Supabase 密码端点用 stub fetch 换成上面验签过的令牌。
    // LAN post 也走全局 fetch——非 Supabase 的请求原样放行给真 fetch。
    const realFetch = globalThis.fetch.bind(globalThis);
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).startsWith(DEFAULT_SUPABASE_URL)) {
        return new Response(JSON.stringify({ access_token: accessToken(USER_ID), user: { id: USER_ID, email: HOST_EMAIL } }), { status: 200 });
      }
      return realFetch(input, init);
    }));
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await account?.stop();
    await legacyHost?.stop();
    await lanServer?.stop();
    await relay?.stop();
    verifier?.stop();
    db?.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  const phone = () => createCompanionStore({
    read: async () => storage,
    write: async value => { storage = value; },
    scan: async () => JSON.stringify(lanServer.invite(['shared'])),
    post,
    dialRelay: nodeDial,
  }, () => {});

  const saved = () => JSON.parse(storage ?? '{}') as {
    relay?: { url: string; routeToken: string; credential: string };
    relayAccount?: { url: string; routeToken: string };
    account?: { ticket: string; email: string; userId: string };
    binding?: { hostAccountEmail?: string };
  };

  it('pair caches both routes + host email; login begets a ticket and nothing else lands on disk', async () => {
    const store = phone();
    await store.getState().pair();
    expect(store.getState()).toMatchObject({ status: 'connected', transport: 'lan' });
    // 配对信息带电脑账号邮箱；两条路由都缓存，账号路由不带凭据。
    expect(store.getState().binding?.hostAccountEmail).toBe(HOST_EMAIL);
    expect(saved().relay).toMatchObject({ credential: SECRET });
    expect(saved().relayAccount).toMatchObject({ url: `${url}/` });
    expect(saved().account).toBeUndefined();
    // 登录（邮箱预填同一账号）：换到 relay 自签票据，票据/邮箱/用户 id 落盘。
    const outcome = await store.getState().login(HOST_EMAIL, 'user-password--not-logged');
    expect(outcome).toEqual({ ok: true });
    expect(saved().account).toMatchObject({ email: HOST_EMAIL, userId: USER_ID });
    expect(saved().account?.ticket.startsWith('neo1.')).toBe(true);
    expect(ticketAuth.verify(saved().account?.ticket ?? '')).toMatchObject({ sub: USER_ID });
    // 密码与 access token 不落盘（M4 的端到端面）。
    expect(storage ?? '').not.toContain('user-password-not-logged');
    expect(storage ?? '').not.toContain(accessToken(USER_ID).slice(0, 24));
    expect(store.getState().account).toEqual({ email: HOST_EMAIL, userId: USER_ID });
    store.getState().pause();
  });

  it('off Wi-Fi dials the account route with the ticket and works there', async () => {
    const store = phone();
    await store.getState().pair();
    expect(await store.getState().login(HOST_EMAIL, 'pw')).toEqual({ ok: true });
    store.getState().selectSession('shared');
    lanUp = false;
    await store.getState().reconnect();
    expect(store.getState()).toMatchObject({ status: 'connected', transport: 'relay' });
    // 票据鉴权的那本在线账翻起来了：账号路由真的被手机用票据拨过（子协议带票、relay 验签通过）。
    await vi.waitFor(() => expect(relay.currentStats.ticketConnections).toBeGreaterThan(0));
    await store.getState().send('account-route-正文');
    expect(executions[0]).toBe(1);
    store.getState().pause();
  });

  it('no-host on the account route falls back to the legacy route in the same connect attempt', async () => {
    const store = phone();
    await store.getState().pair();
    expect(await store.getState().login(HOST_EMAIL, 'pw')).toEqual({ ok: true });
    store.getState().selectSession('shared');
    // 账号通道停了：账号路由没有 host（宽限 100ms 后 no-host），旧路由仍在线。
    await account.stop();
    lanUp = false;
    await store.getState().reconnect();
    expect(store.getState()).toMatchObject({ status: 'connected', transport: 'relay' });
    await store.getState().send('fallback-legacy-正文');
    expect(executions[0]).toBe(1);
    // no-host 不是拒绝：账号信息保留，下次账号通道回来还能用。
    expect(store.getState().account).toEqual({ email: HOST_EMAIL, userId: USER_ID });
    store.getState().pause();
  });

  it('a rejected ticket is invalidated (S8 needs-login) and the legacy route still carries the session', async () => {
    // 先配对+登录攒出一份带票据的配对盘，再把盘上的票换成另一把密钥签的死票（relay 侧作废
    // 形状——升级即被关、零收帧 ⇒ AUTH_REJECTED），用一份**新起**的 store 冷启动读盘重连。
    const first = phone();
    await first.getState().pair();
    expect(await first.getState().login(HOST_EMAIL, 'pw')).toEqual({ ok: true });
    first.getState().pause();
    const rogue = new RelayTicketAuth({ keyFile: join(dataDir, 'rogue.key') });
    const record = JSON.parse(storage!) as { account: { ticket: string } };
    record.account.ticket = rogue.issue(USER_ID).ticket;
    storage = JSON.stringify(record);
    const store = phone();
    await store.getState().hydrate();
    store.getState().selectSession('shared');
    lanUp = false;
    await store.getState().reconnect();
    expect(store.getState()).toMatchObject({ status: 'connected', transport: 'relay' });
    // 票据置失效：盘上账号删掉、UI 翻回「需要登录」（S8），不静默重试登录。
    expect(store.getState().account).toBeNull();
    expect(store.getState().loginPrompt).toBe(true);
    expect(saved().account).toBeUndefined();
    await store.getState().send('dead-ticket-正文');
    expect(executions[0]).toBe(1);
    store.getState().pause();
  });
});
