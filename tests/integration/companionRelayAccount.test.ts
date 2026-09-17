import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { CompanionGateway } from '../../src/host/services/companion/CompanionGateway';
import {
  CompanionRelayClient,
  startCompanionRelayAccountIfConfigured,
} from '../../src/host/services/companion/CompanionRelayClient';
import { deriveCompanionRelayRouteToken } from '../../src/host/services/companion/companionRelayRouteToken';
import { createIdentity } from '../../src/shared/companion/noiseChannel';
import { toHex } from '../../src/shared/companion/lanProtocol';
import { COMPANION_LIMITS as L } from '../../src/shared/constants/companion';
import { CompanionRelayServer } from '../../packages/relay/src/server';
import { SupabaseJwtVerifier } from '../../packages/relay/src/accountAuth';
import { RelayPhoneStub } from './companion/relayPhoneStub';

/**
 * 中继绑账号第一刀（N-COMPANION-RELAY-ACCOUNT-BIND）：生产 relay 同时认共享凭据与 Supabase ES256
 * access token，路由按「第一次登记它的主人」隔离；Host 已登录时并行开账号通道。
 * 旧组合（共享凭据的 Host 与手机，即 9f2e53d + build 52）必须逐字节不受影响。
 */

const SECRET = 'test-relay-credential';
const SUPABASE = 'https://proj.supabase.co';

function freePort(): Promise<number> {
  return new Promise(resolve => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1', () => {
      const port = (probe.address() as { port: number }).port;
      probe.close(() => resolve(port));
    });
  });
}

const signingKey = (() => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return { kid: 'kid-1', privateKey, jwk: { ...publicKey.export({ format: 'jwk' }), kid: 'kid-1', alg: 'ES256', use: 'sig' } };
})();

function accessToken(sub: string, key: { kid: string; privateKey: KeyObject } = signingKey): string {
  const enc = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const head = enc({ alg: 'ES256', typ: 'JWT', kid: key.kid });
  const body = enc({ iss: `${SUPABASE}/auth/v1`, aud: 'authenticated', role: 'authenticated', sub, exp: Math.floor(Date.now() / 1000) + 3600 });
  return `${head}.${body}.${sign('sha256', Buffer.from(`${head}.${body}`), { key: key.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
}

function jwks(state: { online: boolean }): typeof fetch {
  return (async () => {
    if (!state.online) throw new Error('ECONNRESET');
    return new Response(JSON.stringify({ keys: [signingKey.jwk] }), { status: 200 });
  }) as typeof fetch;
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

async function rawRegister(url: string, credential: string, routeToken: string, role: 'host' | 'device'): Promise<WebSocket> {
  const socket = new WebSocket(url, { headers: { authorization: `Bearer ${credential}` } });
  await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('close', () => reject(new Error('closed'))); });
  socket.send(JSON.stringify({
    v: 1, kind: 'register', role,
    envelope: { routeToken, deviceRef: 'probe', seq: 0, ttlMs: L.relayRouteTokenTtlMs, issuedAt: Date.now() },
    ciphertext: '',
  }));
  return socket;
}

describe('companion relay account binding (slice 1)', () => {
  let db: Database.Database;
  let gateway: CompanionGateway;
  let relay: CompanionRelayServer;
  let verifier: SupabaseJwtVerifier;
  let legacyHost: CompanionRelayClient;
  let account: ReturnType<typeof startCompanionRelayAccountIfConfigured>;
  let auth: ReturnType<typeof fakeAuth>;
  let dataDir: string;
  let url: string;
  let port: number;
  let deviceId: string;
  let scopeEpoch: number;
  const jwksState = { online: true };
  const hostIdentity = createIdentity();
  const phoneIdentity = createIdentity();
  const phones: RelayPhoneStub[] = [];
  const sockets: WebSocket[] = [];

  async function startRelay(fetchImpl: typeof fetch): Promise<void> {
    verifier = new SupabaseJwtVerifier({ supabaseUrl: SUPABASE, cacheFile: join(dataDir, 'jwks.json'), fetch: fetchImpl });
    verifier.start();
    await verifier.refresh();
    relay = new CompanionRelayServer({ credential: SECRET, port, accountVerifier: verifier });
    await relay.listen();
  }

  beforeEach(async () => {
    jwksState.online = true;
    dataDir = mkdtempSync(join(tmpdir(), 'relay-account-'));
    db = new Database(':memory:');
    gateway = new CompanionGateway(db, { dispatch: () => ({ state: 'accepted', result: { runId: 'test-run' } }) });
    const device = gateway.pairIdentity(toHex(phoneIdentity.publicKey), ['shared']);
    deviceId = device.deviceId;
    scopeEpoch = gateway.pairedDevices()[0].scopeEpoch;
    port = await freePort();
    url = `ws://127.0.0.1:${port}`;
    await startRelay(jwks(jwksState));
    const config = { url, credentialRef: 'companion-relay', reconnectBackoffMs: [30, 60, 120] };
    writeFileSync(join(dataDir, L.relayConfigFile), JSON.stringify({ v: 1, enabled: true, ...config }));
    legacyHost = new CompanionRelayClient({ gateway, identity: hostIdentity, config, credential: SECRET, jitter: () => 0.5 });
    await legacyHost.start();
    await legacyHost.whenConnected();
    auth = fakeAuth('user-1');
    account = startCompanionRelayAccountIfConfigured({
      dataDirectory: dataDir, gateway, loadIdentity: async () => hostIdentity, auth, jitter: () => 0.5,
    });
  });

  afterEach(async () => {
    for (const phone of phones.splice(0)) phone.close();
    for (const socket of sockets.splice(0)) socket.close();
    await account?.stop();
    await legacyHost?.stop();
    await relay?.stop();
    verifier?.stop();
    db?.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  function token(namespace: string): string {
    return deriveCompanionRelayRouteToken(hostIdentity.secretKey, deviceId, scopeEpoch, namespace);
  }

  async function roundTrip(routeToken: string, credential: string): Promise<void> {
    const phone = new RelayPhoneStub(phoneIdentity, routeToken, deviceId);
    phones.push(phone);
    await phone.connect(url, credential);
    const binding = await phone.resume(toHex(hostIdentity.publicKey), url);
    expect(binding.deviceId).toBe(deviceId);
    expect(await phone.request({
      action: 'command',
      command: { version: 1, deviceId, commandId: `c-${routeToken.slice(0, 6)}-${Date.now()}`, scopeEpoch, sessionId: 'shared', action: 'message.send', payload: { text: 'hi' } },
    })).toMatchObject({ kind: 'accepted' });
  }

  it('runs the account channel beside the untouched shared-credential channel', async () => {
    await vi.waitFor(() => expect(relay.currentStats.accountConnections).toBe(1));
    await vi.waitFor(() => expect(relay.currentStats.routes).toBe(2));
    // 老组合：共享凭据手机走 local 旧路由，照旧收发
    await roundTrip(token('local'), SECRET);
    // 账号通道：同一 Host 以 acct:<sub> 派生的新路由也能完整收发（第三刀手机才会用它）
    await roundTrip(token('acct:user-1'), accessToken('user-1'));
    expect(relay.currentStats.rejectedAuth).toBe(0);
    const health = await (await fetch(`http://127.0.0.1:${port}/healthz`)).json() as Record<string, unknown>;
    expect(health).toMatchObject({ accountConnections: 2, jwks: { keys: 1, source: 'network' } });
  });

  it('rejects forged, expired-signature and unknown-key tokens without touching the legacy channel', async () => {
    await vi.waitFor(() => expect(relay.currentStats.routes).toBe(2));
    const before = relay.currentStats;
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const forged = [accessToken('user-1', { kid: 'kid-1', privateKey }), accessToken('user-1', { kid: 'kid-other', privateKey }), 'x.y.z'];
    await Promise.all(forged.map(bad => new Promise<void>(resolve => {
      const socket = new WebSocket(url, { headers: { authorization: `Bearer ${bad}` } });
      socket.once('close', () => resolve());
    })));
    expect(relay.currentStats.rejectedAuth).toBe(before.rejectedAuth + 3);
    expect(relay.currentStats.connections).toBe(before.connections);
    await roundTrip(token('local'), SECRET);
  });

  it('isolates routes by owner: no other principal can register on a route, in either role', async () => {
    await vi.waitFor(() => expect(relay.currentStats.routes).toBe(2));
    const accountRoute = token('acct:user-1');
    const legacyRoute = token('local');
    const before = relay.currentStats.rejectedOwner;
    sockets.push(await rawRegister(url, SECRET, accountRoute, 'device'));
    sockets.push(await rawRegister(url, accessToken('user-2'), accountRoute, 'host'));
    sockets.push(await rawRegister(url, accessToken('user-2'), legacyRoute, 'device'));
    sockets.push(await rawRegister(url, accessToken('user-1'), legacyRoute, 'device'));
    await vi.waitFor(() => expect(relay.currentStats.rejectedOwner).toBe(before + 4));
    expect(relay.currentStats.routes).toBe(2);
    // 被拒的登记没有顶掉真主人：两条路由照常收发
    await roundTrip(accountRoute, accessToken('user-1'));
    await roundTrip(legacyRoute, SECRET);
  });

  it('follows sign-in state: switching user re-registers under the new namespace, signing out drops the channel', async () => {
    await vi.waitFor(() => expect(relay.currentStats.accountConnections).toBe(1));
    auth.switchTo('user-2');
    await roundTrip(token('acct:user-2'), accessToken('user-2'));
    await vi.waitFor(() => expect(relay.currentStats.routes).toBe(2));
    // 旧账号路由已随旧连接关闭而摘除：user-1 的设备登记上去等不到 host
    sockets.push(await rawRegister(url, accessToken('user-1'), token('acct:user-1'), 'device'));
    await vi.waitFor(() => expect(relay.currentStats.routes).toBe(3));
    auth.switchTo(null);
    // 账号 Host 连接关闭；剩下的是 user-2 手机与 user-1 探针两条设备连接
    await vi.waitFor(() => expect(relay.currentStats.accountConnections).toBe(2));
    await roundTrip(token('local'), SECRET);
  });

  it('after a relay restart with Supabase unreachable, verifies from the disk cache and the host reconnects', async () => {
    await vi.waitFor(() => expect(relay.currentStats.accountConnections).toBe(1));
    await relay.stop();
    verifier.stop();
    jwksState.online = false;
    await startRelay(jwks(jwksState));
    expect(verifier.stats.source).toBe('disk');
    await vi.waitFor(() => expect(relay.currentStats.accountConnections).toBe(1), { timeout: 5_000 });
    await legacyHost.whenConnected();
    await roundTrip(token('acct:user-1'), accessToken('user-1'));
    await roundTrip(token('local'), SECRET);
  });

  it('a relay that turns the account token away gets backed-off, deduplicated retries, not a reconnect storm', async () => {
    // 部署顺序反了（Dev 先于 relay）或 relay 没开账号鉴权：upgrade 完成后才被关（ai-review PR#1926 Important）。
    await account?.stop();
    const bare = new CompanionRelayServer({ credential: SECRET, port: await freePort() });
    const bareUrl = `ws://127.0.0.1:${(await bare.listen()).port}`;
    const bareDir = mkdtempSync(join(tmpdir(), 'relay-account-bare-'));
    writeFileSync(join(bareDir, L.relayConfigFile), JSON.stringify({ v: 1, enabled: true, url: bareUrl, credentialRef: 'companion-relay', reconnectBackoffMs: [30, 60, 120] }));
    const warns: string[] = [];
    const rejected = startCompanionRelayAccountIfConfigured({
      dataDirectory: bareDir, gateway, loadIdentity: async () => hostIdentity, auth: fakeAuth('user-1'), jitter: () => 0.5,
      logger: { warn: message => warns.push(message), info: () => {} },
    });
    await vi.waitFor(() => expect(bare.currentStats.rejectedAuth).toBeGreaterThanOrEqual(4), { timeout: 5_000 });
    const before = bare.currentStats.rejectedAuth;
    await new Promise(resolve => setTimeout(resolve, 600));
    // 退避封顶 120ms×0.5：600ms 内至多约 10 次；秒级回到首档 15ms 的风暴会是 40 次上下
    expect(bare.currentStats.rejectedAuth - before).toBeLessThanOrEqual(12);
    expect(warns.filter(line => line.includes('disconnected'))).toEqual([]);
    expect(warns.filter(line => line.includes('dial failed'))).toEqual([
      expect.stringContaining('Companion relay (account) dial failed: COMPANION_RELAY_CLOSED_AFTER_OPEN'),
    ]);
    await rejected?.stop();
    await bare.stop();
    rmSync(bareDir, { recursive: true, force: true });
  });

  it('without an account verifier the relay stays shared-credential only', async () => {
    const bare = new CompanionRelayServer({ credential: SECRET, port: await freePort() });
    const bareUrl = `ws://127.0.0.1:${(await bare.listen()).port}`;
    await new Promise<void>(resolve => {
      const socket = new WebSocket(bareUrl, { headers: { authorization: `Bearer ${accessToken('user-1')}` } });
      socket.once('close', () => resolve());
    });
    expect(bare.currentStats.rejectedAuth).toBe(1);
    const health = await (await fetch(bareUrl.replace('ws', 'http') + '/healthz')).json() as Record<string, unknown>;
    expect(health).not.toHaveProperty('jwks');
    await bare.stop();
  });
});
