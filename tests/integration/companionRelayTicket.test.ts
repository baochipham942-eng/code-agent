import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import { createHash, createHmac, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
import {
  loadCompanionRelayTicket,
  storeCompanionRelayTicket,
} from '../../src/host/services/companion/companionRelayTicketStore';
import { createIdentity } from '../../src/shared/companion/noiseChannel';
import { toHex } from '../../src/shared/companion/lanProtocol';
import { COMPANION_LIMITS as L } from '../../src/shared/constants/companion';
import { CompanionRelayServer } from '../../packages/relay/src/server';
import { SupabaseJwtVerifier } from '../../packages/relay/src/accountAuth';
import { RelayTicketAuth } from '../../packages/relay/src/ticketAuth';
import { RelayPhoneStub } from './companion/relayPhoneStub';

/**
 * 中继绑账号第 3A 刀（N-COMPANION-RELAY-DEVICE-TICKET）：账号令牌只在换票时用一次，日常连接
 * 用 relay 自签的 30 天设备票据——「能不能跨网」不再绑在「此刻连不连得上 supabase.co」上。
 * 覆盖任务书 ①-⑧（票据签发/重连/篡改/过期/续签阈值/owner 闸/共享凭据照旧/伪造不出票据）
 * 加 Host 三例（有未过期票据优先票据拨号、过期回落令牌、收到 ticket 帧写盘覆盖）。
 * 时钟全走注入的 clock（过期/续签都不真等），手机 build 53 的共享凭据行为不在本刀改动面内。
 */

const SECRET = 'test-relay-credential';
const SUPABASE = 'https://proj.supabase.co';
const DAY = 24 * 60 * 60 * 1000;

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
  const body = enc({ iss: `${SUPABASE}/auth/v1`, aud: 'authenticated', role: 'authenticated', sub, exp: Math.floor(clock / 1000) + 3600 });
  return `${head}.${body}.${sign('sha256', Buffer.from(`${head}.${body}`), { key: key.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
}

function jwks(state: { online: boolean }): typeof fetch {
  return (async () => {
    if (!state.online) throw new Error('ECONNRESET');
    return new Response(JSON.stringify({ keys: [signingKey.jwk] }), { status: 200 });
  }) as typeof fetch;
}

function fakeAuth(initial: string | null, opts?: { tokenFails?: boolean }) {
  const user = initial;
  let tokenCalls = 0;
  const listeners: Array<(user: { id: string } | null) => void> = [];
  return {
    getCurrentUser: () => user ? { id: user } : null,
    getAccessToken: async () => {
      tokenCalls += 1;
      if (opts?.tokenFails) return null;
      return user ? accessToken(user) : null;
    },
    addAuthChangeCallback: (callback: (user: { id: string } | null) => void) => {
      listeners.push(callback);
      return () => { listeners.splice(listeners.indexOf(callback), 1); };
    },
    tokenCallCount: () => tokenCalls,
  };
}

/** 攻击者视角的签票：与 relay 同形态，但密钥换成自己猜的。 */
function forgeTicket(key: Buffer, sub: string): string {
  const payload = Buffer.from(JSON.stringify({ sub, exp: clock + 3_600_000 })).toString('base64url');
  const mac = createHmac('sha256', key).update(`neo-relay-ticket.v1|${payload}`).digest('base64url');
  return `neo1.${payload}.${mac}`;
}

// 共享注入时钟：过期/续签路径全靠它推进，不真等。
let clock = Date.now();
const now = () => clock;

describe('companion relay device ticket (slice 3A)', () => {
  let db: Database.Database;
  let gateway: CompanionGateway;
  let relay: CompanionRelayServer;
  let verifier: SupabaseJwtVerifier;
  let ticketAuth: RelayTicketAuth;
  let dataDir: string;
  let ticketKeyPath: string;
  let ticketFilePath: string;
  let url: string;
  let port: number;
  let deviceId: string;
  let scopeEpoch: number;
  const jwksState = { online: true };
  const hostIdentity = createIdentity();
  const phoneIdentity = createIdentity();
  const phones: RelayPhoneStub[] = [];
  const sockets: WebSocket[] = [];
  const channels: Array<{ stop(): Promise<void> }> = [];
  const logLines: string[] = [];
  const logger = {
    info: (event: string, fields?: Record<string, unknown>) => { logLines.push(JSON.stringify({ event, ...fields })); },
    warn: (event: string, fields?: Record<string, unknown>) => { logLines.push(JSON.stringify({ event, ...fields })); },
  };

  async function startRelay(): Promise<void> {
    ticketAuth = new RelayTicketAuth({ keyFile: ticketKeyPath, now, logger });
    relay = new CompanionRelayServer({ credential: SECRET, port, accountVerifier: verifier, ticketAuth, now, logger });
    await relay.listen();
  }

  beforeEach(async () => {
    clock = Date.now();
    logLines.length = 0;
    jwksState.online = true;
    dataDir = mkdtempSync(join(tmpdir(), 'relay-ticket-'));
    ticketKeyPath = join(dataDir, 'ticket-key');
    ticketFilePath = join(dataDir, L.relayTicketFile);
    db = new Database(':memory:');
    gateway = new CompanionGateway(db, { dispatch: () => ({ state: 'accepted', result: { runId: 'test-run' } }) });
    const device = gateway.pairIdentity(toHex(phoneIdentity.publicKey), ['shared']);
    deviceId = device.deviceId;
    scopeEpoch = gateway.pairedDevices()[0].scopeEpoch;
    port = await freePort();
    url = `ws://127.0.0.1:${port}`;
    verifier = new SupabaseJwtVerifier({ supabaseUrl: SUPABASE, cacheFile: join(dataDir, 'jwks.json'), fetch: jwks(jwksState), now });
    verifier.start();
    await verifier.refresh();
    await startRelay();
    writeFileSync(join(dataDir, L.relayConfigFile), JSON.stringify({ v: 1, enabled: true, url, credentialRef: 'companion-relay', reconnectBackoffMs: [30, 60, 120] }));
  });

  afterEach(async () => {
    for (const channel of channels.splice(0)) await channel.stop();
    for (const phone of phones.splice(0)) phone.close();
    for (const socket of sockets.splice(0)) socket.close();
    await relay?.stop();
    verifier?.stop();
    db?.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  function token(namespace: string): string {
    return deriveCompanionRelayRouteToken(hostIdentity.secretKey, deviceId, scopeEpoch, namespace);
  }

  function dial(credential: string): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url, { headers: { authorization: `Bearer ${credential}` } });
      socket.once('error', () => { /* close follows */ });
      socket.once('open', () => resolve(socket));
      socket.once('close', () => reject(new Error('closed before open')));
    });
  }

  /**
   * 拨号并在建 socket 的同一刻就挂上 ticket 帧监听：relay 在 accept() 里同步发票据帧，常与 101
   * 握手同 TCP 段到达，等 open 之后再挂监听会把帧丢掉（挂晚 = 假「没收到票」，负向断言会假绿）。
   */
  function trackedDial(credential: string): {
    opened: Promise<WebSocket>;
    nextTicket(timeoutMs?: number): Promise<string>;
    ticketCount(): number;
  } {
    const tickets: string[] = [];
    const waiters: Array<(ticket: string) => void> = [];
    let count = 0;
    const socket = new WebSocket(url, { headers: { authorization: `Bearer ${credential}` } });
    sockets.push(socket);
    socket.on('message', data => {
      try {
        const frame = JSON.parse(String(data)) as { kind?: string; ciphertext?: string };
        if (frame.kind === 'ticket' && typeof frame.ciphertext === 'string') {
          count += 1;
          const waiter = waiters.shift();
          if (waiter) waiter(frame.ciphertext);
          else tickets.push(frame.ciphertext);
        }
      } catch { /* 非 JSON 忽略 */ }
    });
    socket.once('error', () => { /* close follows */ });
    return {
      opened: new Promise<WebSocket>((resolve, reject) => {
        socket.once('open', () => resolve(socket));
        socket.once('close', () => reject(new Error('closed before open')));
      }),
      nextTicket: (timeoutMs = 3_000) => {
        const buffered = tickets.shift();
        if (buffered) return Promise.resolve(buffered);
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('ticket frame timeout')), timeoutMs);
          waiters.push(ticket => { clearTimeout(timer); resolve(ticket); });
        });
      },
      ticketCount: () => count,
    };
  }

  /** relay 拒鉴权的形状：upgrade 完成（open 也会触发）后立刻被关。 */
  function expectRejected(credential: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url, { headers: { authorization: `Bearer ${credential}` } });
      socket.once('error', () => { /* close follows */ });
      const timer = setTimeout(() => reject(new Error('not rejected within timeout')), 5_000);
      socket.once('close', () => { clearTimeout(timer); resolve(); });
    });
  }

  function registerFrame(routeToken: string, role: 'host' | 'device', seq = 0): string {
    return JSON.stringify({
      v: 1, kind: 'register', role,
      envelope: { routeToken, deviceRef: 'probe', seq, ttlMs: L.relayRouteTokenTtlMs, issuedAt: clock },
      ciphertext: '',
    });
  }

  function forwardFrame(routeToken: string, seq: number, ciphertext: string): string {
    return JSON.stringify({
      v: 1, kind: 'forward',
      envelope: { routeToken, deviceRef: 'probe', seq, ttlMs: L.relayRouteTokenTtlMs, issuedAt: clock },
      ciphertext,
    });
  }

  function nextForward(socket: WebSocket, timeoutMs = 3_000): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('forward frame timeout')), timeoutMs);
      socket.on('message', data => {
        try {
          const frame = JSON.parse(String(data)) as { kind?: string; ciphertext?: string };
          if (frame.kind === 'forward' && typeof frame.ciphertext === 'string') {
            clearTimeout(timer);
            resolve(frame.ciphertext);
          }
        } catch { /* 非 JSON 忽略 */ }
      });
    });
  }

  /** 在窗口期内等真实时间流逝（ticketCount 由 trackedDial 持续累计，不会漏帧）。 */
  async function quiet(ms: number): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, ms));
  }

  async function roundTrip(routeToken: string, credential: string): Promise<void> {
    const phone = new RelayPhoneStub(phoneIdentity, routeToken, deviceId);
    phones.push(phone);
    await phone.connect(url, credential);
    const binding = await phone.resume(toHex(hostIdentity.publicKey), url);
    expect(binding.deviceId).toBe(deviceId);
    expect(await phone.request({
      action: 'command',
      command: { version: 1, deviceId, commandId: `c-${routeToken.slice(0, 6)}-${Math.random()}`, scopeEpoch, sessionId: 'shared', action: 'message.send', payload: { text: 'hi' } },
    })).toMatchObject({ kind: 'accepted' });
  }

  function startChannel(auth: ReturnType<typeof fakeAuth>): { stop(): Promise<void>; status: () => { account: string } } {
    const handle = startCompanionRelayAccountIfConfigured({
      dataDirectory: dataDir, gateway, loadIdentity: async () => hostIdentity, auth, now, jitter: () => 0.5,
      logger: { warn: message => logLines.push(message), info: message => logLines.push(message) },
    });
    channels.push(handle);
    return handle;
  }

  it('① access token begets a ticket; the ticket re-auths as the same owner and carries traffic', async () => {
    const first = trackedDial(accessToken('user-1'));
    const firstSocket = await first.opened;
    const ticket = await first.nextTicket();
    expect(ticket.startsWith('neo1.')).toBe(true);
    expect(ticket.split('.')).toHaveLength(3);
    expect(relay.currentStats.ticketsIssued).toBe(1);
    expect(ticketAuth.verify(ticket)).toMatchObject({ sub: 'user-1' });
    firstSocket.close();
    await vi.waitFor(() => expect(relay.currentStats.ticketConnections).toBe(0));

    // 用票据重连：鉴权通过、走票据那本在线账；剩余 30 天 > 续签阈值，不再连环发票
    const second = trackedDial(ticket);
    const secondSocket = await second.opened;
    await vi.waitFor(() => expect(relay.currentStats.ticketConnections).toBe(1));
    await quiet(300);
    expect(second.ticketCount()).toBe(0);

    // 主人仍是 acct:user-1：票据连接登记 host，user-1 令牌连接登记同一路由的 device（同主人放行）
    const route = 'ticket-route-token-1';
    secondSocket.send(registerFrame(route, 'host'));
    const peer = await dial(accessToken('user-1'));
    sockets.push(peer);
    peer.send(registerFrame(route, 'device'));
    // relay 级收发：host → device 原样转发（也证明双方的登记都生效了）
    const payload = 'Zm9yd2FyZC1wYXlsb2Fk';
    const got = nextForward(peer);
    secondSocket.send(forwardFrame(route, 0, payload));
    expect(await got).toBe(payload);
    await vi.waitFor(() => expect(relay.currentStats.forwarded).toBe(1));
    expect(relay.currentStats.rejectedOwner).toBe(0);
    expect(relay.currentStats.rejectedAuth).toBe(0);
  });

  it('①b host: dials with the stored ticket while Supabase is unreachable, and phone traffic rides the ticket', async () => {
    const first = startChannel(fakeAuth('user-1'));
    await vi.waitFor(() => expect(first.status().account).toBe('connected'));
    const stored = loadCompanionRelayTicket(dataDir, 'user-1', now);
    expect(stored).toMatch(/^neo1\./);
    await first.stop();

    // supabase「挂了」：令牌取不到、JWKS 网络断。Host 重启后凭盘上票据立刻接上。
    jwksState.online = false;
    const offline = fakeAuth('user-1', { tokenFails: true });
    const second = startChannel(offline);
    await vi.waitFor(() => expect(second.status().account).toBe('connected'));
    expect(offline.tokenCallCount()).toBe(0); // 票据优先，根本没去取令牌
    await vi.waitFor(() => expect(relay.currentStats.ticketConnections).toBe(1));
    // 手机凭票据（不是令牌）走账号路由完整收发
    await roundTrip(token('acct:user-1'), stored as string);
    await second.stop();
  });

  it('② rejects a ticket with any single character flipped', async () => {
    const { ticket } = ticketAuth.issue('user-1');
    const parts = ticket.split('.');
    // 按 base64url 字母表 +4 翻转：mac 末字符（43 字符编 32 字节）只有高 4 位有效，+1 常落在被
    // 忽略的低 2 位上、解出相同字节验签照过——+4 必改 v>>2（已在 200 个随机 mac 上验证）。
    const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const flip = (text: string, at: number): string => text.slice(0, at) + B64URL[(B64URL.indexOf(text[at]) + 4) % 64] + text.slice(at + 1);
    const variants = [
      `${parts[0]}.${parts[1]}.${flip(parts[2], parts[2].length - 1)}`,
      `${parts[0]}.${flip(parts[1], Math.floor(parts[1].length / 2))}.${parts[2]}`,
      ticket.slice(0, -1),
      'neo1.eyJzdWIiOiJ4In0.AAAA',
    ];
    const statsBefore = relay.currentStats;
    for (const bad of variants) await expectRejected(bad);
    expect(relay.currentStats.rejectedAuth).toBe(statsBefore.rejectedAuth + variants.length);
    expect(relay.currentStats.connections).toBe(statsBefore.connections);
  });

  it('③ rejects an expired ticket (clock injected, no real waiting)', async () => {
    const backdated = new RelayTicketAuth({ keyFile: ticketKeyPath, now: () => clock - L.relayTicketTtlMs - 1_000 });
    const expired = backdated.issue('user-1').ticket;
    const before = relay.currentStats.rejectedAuth;
    await expectRejected(expired);
    expect(relay.currentStats.rejectedAuth).toBe(before + 1);
  });

  it('④ renews only inside the renewal window', async () => {
    const base = clock;
    const t1 = ticketAuth.issue('user-1').ticket; // exp = base + 30d
    // 剩余 8 天 > 7 天阈值：不续签
    clock = base + 22 * DAY;
    const fresh = trackedDial(t1);
    const freshSocket = await fresh.opened;
    await vi.waitFor(() => expect(relay.currentStats.ticketConnections).toBe(1));
    await quiet(400);
    expect(fresh.ticketCount()).toBe(0);
    expect(relay.currentStats.ticketsIssued).toBe(0);
    freshSocket.close();
    await vi.waitFor(() => expect(relay.currentStats.ticketConnections).toBe(0));

    // 剩余 6 天 23 小时 < 7 天阈值：续签
    clock = base + 23 * DAY + 3_600_000;
    const aging = trackedDial(t1);
    const agingSocket = await aging.opened;
    const t2 = await aging.nextTicket();
    expect(relay.currentStats.ticketsIssued).toBe(1);
    expect(t2).not.toBe(t1);
    expect(ticketAuth.verify(t2)).toMatchObject({ sub: 'user-1' });
    expect(logLines.some(line => line.includes('ticket_renewed'))).toBe(true);

    // 新票可用且不再连环续
    agingSocket.close();
    await vi.waitFor(() => expect(relay.currentStats.ticketConnections).toBe(0));
    const reconnected = trackedDial(t2);
    await reconnected.opened;
    await vi.waitFor(() => expect(relay.currentStats.ticketConnections).toBe(1));
    await quiet(300);
    expect(reconnected.ticketCount()).toBe(0);
  });

  it('⑤ a ticket whose sub is not the route owner is rejected by the owner gate', async () => {
    const route = 'owner-gate-route-token';
    const owner = await dial(accessToken('user-1'));
    sockets.push(owner);
    owner.send(registerFrame(route, 'host'));
    await vi.waitFor(() => expect(relay.currentStats.routes).toBe(1));

    const before = relay.currentStats.rejectedOwner;
    const intruder = await dial(ticketAuth.issue('user-2').ticket);
    sockets.push(intruder);
    intruder.send(registerFrame(route, 'device'));
    await vi.waitFor(() => expect(relay.currentStats.rejectedOwner).toBe(before + 1));

    // user-1 自己的票据照常登记（第一次登记的主人没被顶掉）
    const sameOwner = await dial(ticketAuth.issue('user-1').ticket);
    sockets.push(sameOwner);
    sameOwner.send(registerFrame(route, 'device'));
    const payload = 'b3duZXItb2stcGF5bG9hZA';
    const got = nextForward(sameOwner);
    owner.send(forwardFrame(route, 0, payload));
    expect(await got).toBe(payload);
    expect(relay.currentStats.rejectedOwner).toBe(before + 1);
  });

  it('⑥ legacy shared-credential connections see no ticket frame and behave exactly as before', async () => {
    const legacyHost = new CompanionRelayClient({
      gateway, identity: hostIdentity, jitter: () => 0.5, credential: SECRET,
      config: { url, credentialRef: 'companion-relay', reconnectBackoffMs: [30, 60, 120] },
    });
    await legacyHost.start();
    await legacyHost.whenConnected();
    const probe = trackedDial(SECRET);
    const probeSocket = await probe.opened;
    probeSocket.send(registerFrame('legacy-route-token-1', 'host'));
    await vi.waitFor(() => expect(relay.currentStats.routes).toBe(2));
    // 共享凭据连接在窗口期内收不到任何 ticket 帧
    await quiet(400);
    expect(probe.ticketCount()).toBe(0);
    expect(relay.currentStats.ticketsIssued).toBe(0);
    // 手机走共享凭据照旧完整收发（local 旧路由）
    await roundTrip(token('local'), SECRET);
    expect(relay.currentStats.ticketsIssued).toBe(0);
    expect(relay.currentStats.ticketConnections).toBe(0);
    expect(relay.currentStats.rejectedAuth).toBe(0);
    await legacyHost.stop();
  });

  it('⑦ no ticket, credential or access token material appears in logs or healthz', async () => {
    const accountToken = accessToken('user-7');
    const socket = trackedDial(accountToken);
    const socketHandle = await socket.opened;
    const ticket = await socket.nextTicket();
    socketHandle.send(registerFrame('leak-probe-route-tok', 'host'));
    const viaTicket = await dial(ticketAuth.issue('user-7').ticket);
    sockets.push(viaTicket);
    await dial(SECRET).then(s => sockets.push(s));
    await vi.waitFor(() => expect(relay.currentStats.routes).toBe(1));

    const healthText = await (await fetch(`http://127.0.0.1:${port}/healthz`)).text();
    const all = `${logLines.join('\n')}\n${healthText}`;
    expect(all).not.toContain(ticket);
    expect(all).not.toContain(ticket.split('.')[1]); // payload 段
    expect(all).not.toContain(ticket.split('.')[2]); // mac 段
    expect(all).not.toContain(SECRET);
    expect(all).not.toContain(accountToken);
    // 事件名只写 ticket_issued / ticket_renewed，不带 sub、不带票据片段
    const ticketEvents = logLines.filter(line => line.includes('ticket_'));
    expect(ticketEvents.length).toBeGreaterThan(0);
    expect(ticketEvents.join('\n')).not.toContain('user-7');
  });

  it('⑧ a shared-credential holder cannot forge tickets; the key is not derived from the credential', async () => {
    const before = relay.currentStats.rejectedAuth;
    const rawKey = Buffer.from(SECRET, 'utf8');
    const shaPlain = createHash('sha256').update(SECRET, 'utf8').digest();
    const shaDomain = createHash('sha256').update(`neo-relay-ticket-key.v1${SECRET}`, 'utf8').digest();
    for (const key of [rawKey, shaPlain, shaDomain]) {
      await expectRejected(forgeTicket(key, 'attacker-sub'));
    }
    expect(relay.currentStats.rejectedAuth).toBe(before + 3);

    // 进程内密钥与落盘密钥都既不等于共享凭据、也不等于它的任何 sha256 派生
    const onDisk = () => Buffer.from(readFileSync(ticketKeyPath, 'utf8').trim(), 'base64url');
    for (const forbidden of [rawKey, shaPlain, shaDomain]) {
      expect(ticketAuth.keyBytes.equals(forbidden)).toBe(false);
      expect(onDisk().equals(forbidden)).toBe(false);
    }
    expect(onDisk()).toHaveLength(32);
    // 真票据仍能进（密钥没被动过）
    const socket = await dial(ticketAuth.issue('user-1').ticket);
    sockets.push(socket);
    await vi.waitFor(() => expect(relay.currentStats.ticketConnections).toBe(1));
  });

  it('⑧b key file: 0600 and 32 random bytes; without a state directory the fallback warns about invalidation', async () => {
    expect(statSync(ticketKeyPath).mode & 0o777).toBe(0o600);
    const warns: string[] = [];
    const ephemeral = new RelayTicketAuth({ now, logger: { warn: (event, fields) => warns.push(`${event} ${JSON.stringify(fields ?? {})}`) } });
    const issued = ephemeral.issue('user-1').ticket;
    // 另一个进程（新的进程内随机密钥）验不了它——warn 必须写清这个后果，不能只说「用了回落」
    const other = new RelayTicketAuth({ now, logger: { warn: () => {} } });
    expect(other.verify(issued)).toBeNull();
    expect(warns.join(' ')).toContain('ticket_key_ephemeral');
    expect(warns.join(' ')).toContain('invalid once this process restarts');
  });

  it('host: an expired stored ticket falls back to the access token', async () => {
    const backdated = new RelayTicketAuth({ keyFile: ticketKeyPath, now: () => clock - L.relayTicketTtlMs - 1_000 });
    expect(storeCompanionRelayTicket(dataDir, backdated.issue('user-1').ticket, 'user-1')).toBe(true);
    const auth = fakeAuth('user-1');
    const channel = startChannel(auth);
    await vi.waitFor(() => expect(channel.status().account).toBe('connected'));
    expect(auth.tokenCallCount()).toBeGreaterThan(0); // 票据过期，回落令牌拨号
    await vi.waitFor(() => expect(relay.currentStats.accountConnections).toBe(1));
    expect(relay.currentStats.ticketConnections).toBe(0);
    await channel.stop();
  });

  it('host: a ticket frame from the relay overwrites the stored file', async () => {
    const backdated = new RelayTicketAuth({ keyFile: ticketKeyPath, now: () => clock - L.relayTicketTtlMs - 1_000 });
    const stale = backdated.issue('user-1').ticket;
    expect(storeCompanionRelayTicket(dataDir, stale, 'user-1')).toBe(true);
    const before = readFileSync(ticketFilePath, 'utf8');
    expect(loadCompanionRelayTicket(dataDir, 'user-1', now)).toBeNull(); // 旧票已过期，不会拿去拨

    const channel = startChannel(fakeAuth('user-1'));
    await vi.waitFor(() => {
      expect(readFileSync(ticketFilePath, 'utf8')).not.toBe(before); // 收到 ticket 帧后覆盖落盘
    });
    const fresh = loadCompanionRelayTicket(dataDir, 'user-1', now);
    expect(fresh).toMatch(/^neo1\./);
    expect(ticketAuth.verify(fresh as string)).toMatchObject({ sub: 'user-1' });
    await channel.stop();
  });

  it('host: a ticket the relay no longer trusts is dropped and the channel falls back to the token', async () => {
    const first = startChannel(fakeAuth('user-1'));
    await vi.waitFor(() => expect(first.status().account).toBe('connected'));
    await vi.waitFor(() => expect(loadCompanionRelayTicket(dataDir, 'user-1', now)).not.toBeNull());
    await first.stop();

    // relay 换了票据密钥（删掉密钥文件重启 = 作废全部票据）
    await relay.stop();
    rmSync(ticketKeyPath);
    await startRelay();
    expect(relay.currentStats.ticketsIssued).toBe(0);

    // Host 重连：票据被拒 → 作废本地票据 → 回落令牌 → 连上并换到新票
    const second = startChannel(fakeAuth('user-1'));
    await vi.waitFor(() => expect(second.status().account).toBe('connected'), { timeout: 5_000 });
    await vi.waitFor(() => expect(relay.currentStats.accountConnections).toBe(1));
    expect(relay.currentStats.ticketConnections).toBe(0);
    expect(relay.currentStats.rejectedAuth).toBeGreaterThanOrEqual(1);
    await vi.waitFor(() => expect(loadCompanionRelayTicket(dataDir, 'user-1', now)).not.toBeNull());
    await second.stop();
  });
});
