import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import { createServer } from 'node:http';
import WebSocket from 'ws';
import { CompanionGateway } from '../../src/host/services/companion/CompanionGateway';
import { CompanionRelayClient } from '../../src/host/services/companion/CompanionRelayClient';
import { createIdentity } from '../../src/shared/companion/noiseChannel';
import { toHex } from '../../src/shared/companion/lanProtocol';
import { COMPANION_LIMITS as L } from '../../src/shared/constants/companion';
import { CompanionRelayServer } from '../../packages/relay/src/server';
import {
  COMPANION_RELAY_WS_PROTOCOL,
  companionRelayCredentialSubprotocol,
} from '../../src/shared/contract/companionRelay';
import { RelayPhoneStub } from './companion/relayPhoneStub';
import { RelayCompanionClient, type RelayDial } from '../../packages/mobile/src/platform/relayCompanionClient';

const SECRET = 'test-relay-credential';
const TOKEN = 'route-token-aaaaaa';

function freePort(): Promise<number> {
  return new Promise(resolve => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1', () => {
      const port = (probe.address() as { port: number }).port;
      probe.close(() => resolve(port));
    });
  });
}

const nodeDial: RelayDial = (dialUrl, headers) => {
  const socket = new WebSocket(dialUrl, { headers });
  return {
    send: data => socket.send(data),
    close: () => socket.close(),
    onOpen: handler => socket.once('open', handler),
    onMessage: handler => socket.on('message', data => handler(String(data))),
    onClose: handler => socket.once('close', handler),
    onError: handler => socket.once('error', handler),
  };
};

// 前缀只在 shared 契约里定义（不导出）：空凭据编码即前缀。
const AUTH_PREFIX = companionRelayCredentialSubprotocol('');

describe('companion relay: production server + host dial-out', () => {
  let db: Database.Database;
  let gateway: CompanionGateway;
  let relay: CompanionRelayServer;
  let host: CompanionRelayClient;
  let phone: RelayPhoneStub;
  let executions: number;
  let port: number;
  let url: string;
  const hostIdentity = createIdentity();
  const phoneIdentity = createIdentity();

  beforeEach(async () => {
    executions = 0;
    db = new Database(':memory:');
    gateway = new CompanionGateway(db, {
      dispatch: () => { executions += 1; return { state: 'accepted', result: { runId: 'test-run' } }; },
    });
    const device = gateway.pairIdentity(toHex(phoneIdentity.publicKey), ['shared']);
    port = await freePort();
    relay = new CompanionRelayServer({ credential: SECRET, port });
    const address = await relay.listen();
    expect(address.host).toBe('127.0.0.1');
    url = `ws://127.0.0.1:${address.port}`;
    host = new CompanionRelayClient({
      gateway,
      identity: hostIdentity,
      config: { url, credentialRef: 'companion-relay', reconnectBackoffMs: [30, 60, 120] },
      credential: SECRET,
      jitter: () => 0.5,
    });
    host.advertise({ deviceRef: device.deviceId, routeToken: TOKEN });
    await host.start();
    await host.whenConnected();
    phone = new RelayPhoneStub(phoneIdentity, TOKEN, device.deviceId);
    await phone.connect(url, SECRET);
  });

  afterEach(async () => {
    phone?.close();
    await host?.stop();
    await relay?.stop();
    db?.close();
  });

  function command(deviceId: string, commandId: string, text: string) {
    return {
      version: 1, deviceId, commandId, scopeEpoch: 1, sessionId: 'shared',
      action: 'message.send' as const, payload: { text },
    };
  }

  async function pair() {
    return phone.resume(toHex(hostIdentity.publicKey), url);
  }

  it('delivers an encrypted command round-trip through the production relay', async () => {
    const binding = await pair();
    expect(await phone.request({ action: 'command', command: command(binding.deviceId, 'once', 'round-trip') }))
      .toMatchObject({ kind: 'accepted', command: { state: 'accepted' } });
    expect(executions).toBe(1);
    await vi.waitFor(() => expect(relay.currentStats.forwarded).toBeGreaterThanOrEqual(3));
    expect(relay.currentStats.revoked).toBe(0);
    expect(relay.currentStats.rejectedAuth).toBe(0);
  });

  it('answers healthz with stats and 404s everything else', async () => {
    const health = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(health.status).toBe(200);
    const stats = await health.json() as Record<string, unknown>;
    expect(Object.keys(stats).sort()).toEqual([
      'connections', 'droppedBacklog', 'droppedBackpressure', 'droppedExpired', 'droppedNoRoute',
      'forwarded', 'notifiedNoHost', 'queuedFrames', 'rejectedAuth', 'revoked', 'routes',
      'accountConnections', 'rejectedOwner', 'ticketsIssued', 'ticketConnections', 'terminatedNoPong',
    ].sort());
    const missing = await fetch(`http://127.0.0.1:${port}/nope`);
    expect(missing.status).toBe(404);
  });

  it('rejects sockets without the shared credential and counts no connection for them', async () => {
    const statsBefore = relay.currentStats;
    await new Promise<void>(resolve => {
      const socket = new WebSocket(url, { headers: { authorization: 'Bearer wrong-credential-x' } });
      socket.once('close', () => resolve());
    });
    expect(relay.currentStats.rejectedAuth).toBeGreaterThan(statsBefore.rejectedAuth);
    expect(relay.currentStats.connections).toBe(statsBefore.connections);
    expect(relay.currentStats.routes).toBe(statsBefore.routes);
  });

  // 手机 WebView 设不了 Authorization 头，凭据走 WebSocket 子协议
  // （N-COMPANION-RELAY-PHONE-AUTH）。以下四例覆盖浏览器形态的过闸矩阵。
  it('accepts a subprotocol credential dial, selects the fixed protocol, and completes registration', async () => {
    const statsBefore = relay.currentStats;
    const socket = new WebSocket(url, [COMPANION_RELAY_WS_PROTOCOL, companionRelayCredentialSubprotocol(SECRET)]);
    // close 也放行：客户端在「发了子协议、服务端没选」时会直接断开，别让等待挂到测试超时。
    await new Promise<void>(resolve => { socket.once('open', resolve); socket.once('close', () => resolve()); });
    // 服务端只回选固定协议名——凭据项绝不回选或回显（回显等于把凭据发回给所有人）。
    expect(socket.protocol).toBe(COMPANION_RELAY_WS_PROTOCOL);
    socket.send(JSON.stringify({
      v: 1, kind: 'register', role: 'device',
      envelope: { routeToken: 'route-token-subauth', deviceRef: 'phone-1', seq: 0, ttlMs: L.relayRouteTokenTtlMs, issuedAt: Date.now() },
      ciphertext: '',
    }));
    await vi.waitFor(() => expect(relay.currentStats.routes).toBe(statsBefore.routes + 1));
    expect(relay.currentStats.rejectedAuth).toBe(statsBefore.rejectedAuth);
    socket.close();
  });

  it('rejects a subprotocol dial with the wrong credential', async () => {
    const statsBefore = relay.currentStats;
    await new Promise<void>(resolve => {
      const socket = new WebSocket(url, [COMPANION_RELAY_WS_PROTOCOL, companionRelayCredentialSubprotocol('wrong-credential-x')]);
      socket.once('close', () => resolve());
    });
    expect(relay.currentStats.rejectedAuth).toBeGreaterThan(statsBefore.rejectedAuth);
    expect(relay.currentStats.connections).toBe(statsBefore.connections);
    expect(relay.currentStats.routes).toBe(statsBefore.routes);
  });

  it('rejects a dial carrying neither a credential header nor a credential subprotocol', async () => {
    const statsBefore = relay.currentStats;
    await new Promise<void>(resolve => {
      const socket = new WebSocket(url, [COMPANION_RELAY_WS_PROTOCOL]);
      socket.once('close', () => resolve());
    });
    expect(relay.currentStats.rejectedAuth).toBeGreaterThan(statsBefore.rejectedAuth);
    expect(relay.currentStats.connections).toBe(statsBefore.connections);
  });

  it('rejects a credential subprotocol whose encoding is invalid base64url', async () => {
    const statsBefore = relay.currentStats;
    const dials = ['neo-relay-auth.!!!not-base64!!!', `${AUTH_PREFIX}abcde`].map(encoded =>
      new Promise<void>(resolve => {
        const socket = new WebSocket(url, [COMPANION_RELAY_WS_PROTOCOL, encoded]);
        socket.once('close', () => resolve());
      }));
    await Promise.all(dials);
    expect(relay.currentStats.rejectedAuth).toBeGreaterThanOrEqual(statsBefore.rejectedAuth + 2);
    expect(relay.currentStats.connections).toBe(statsBefore.connections);
  });

  it('never writes the credential or its subprotocol encoding into logs or stats', async () => {
    const events: string[] = [];
    const logging = new CompanionRelayServer({
      credential: SECRET,
      port: await freePort(),
      logger: {
        info: (event, fields) => events.push(`${event} ${JSON.stringify(fields ?? {})}`),
        warn: (event, fields) => events.push(`${event} ${JSON.stringify(fields ?? {})}`),
      },
    });
    const loggingUrl = `ws://127.0.0.1:${(await logging.listen()).port}`;
    const encoded = companionRelayCredentialSubprotocol(SECRET);
    // 对：子协议拨通 + 注册一条 route；错/无：各拒一发，让 rejectedAuth 路径也过一遍日志。
    const good = new WebSocket(loggingUrl, [COMPANION_RELAY_WS_PROTOCOL, encoded]);
    await new Promise<void>(resolve => { good.once('open', resolve); good.once('close', () => resolve()); });
    good.send(JSON.stringify({
      v: 1, kind: 'register', role: 'device',
      envelope: { routeToken: 'route-token-sublog', deviceRef: 'phone-1', seq: 0, ttlMs: L.relayRouteTokenTtlMs, issuedAt: Date.now() },
      ciphertext: '',
    }));
    await vi.waitFor(() => expect(logging.currentStats.routes).toBe(1));
    await new Promise<void>(resolve => {
      const bad = new WebSocket(loggingUrl, [COMPANION_RELAY_WS_PROTOCOL, companionRelayCredentialSubprotocol('wrong-credential-x')]);
      bad.once('close', () => resolve());
    });
    await new Promise<void>(resolve => {
      const bare = new WebSocket(loggingUrl, [COMPANION_RELAY_WS_PROTOCOL]);
      bare.once('close', () => resolve());
    });
    await vi.waitFor(() => expect(logging.currentStats.rejectedAuth).toBe(2));
    const wire = [...events, JSON.stringify(logging.currentStats)].join('\n');
    expect(wire).not.toContain(SECRET);
    expect(wire).not.toContain(encoded);
    expect(wire).not.toContain(encoded.slice(AUTH_PREFIX.length));
    good.close();
    await logging.stop();
  });

  it('does not buffer without bound while the peer is absent', async () => {
    const intruder = new WebSocket(url, { headers: { authorization: `Bearer ${SECRET}` } });
    await new Promise<void>(resolve => intruder.once('open', () => resolve()));
    const queueToken = 'route-token-bbbbbb';
    intruder.send(JSON.stringify({
      v: 1, kind: 'register', role: 'device',
      envelope: { routeToken: queueToken, deviceRef: 'phone-1', seq: 0, ttlMs: L.relayRouteTokenTtlMs, issuedAt: Date.now() },
      ciphertext: '',
    }));
    const ciphertext = 'x'.repeat(6_000);
    const total = L.relayMaxBufferedFrames + 4;
    for (let index = 0; index < total; index += 1) {
      intruder.send(JSON.stringify({
        v: 1, kind: 'forward',
        envelope: { routeToken: queueToken, deviceRef: 'phone-1', seq: index, ttlMs: L.relayRouteTokenTtlMs, issuedAt: Date.now() },
        ciphertext,
      }));
    }
    await vi.waitFor(() => {
      const stats = relay.currentStats;
      expect(stats.queuedFrames).toBe(L.relayMaxBufferedFrames);
      expect(stats.droppedBacklog).toBe(4);
    });
    intruder.close();
  });

  // N-COMPANION-RELAY-NOHOST-FASTFAIL（FB-194）：手机连到没有 host 的 route，relay 宽限期后回
  // no-host 帧，产品里的手机客户端据此秒级失败，而不是排着队干等自己的握手超时。
  it('tells a device on a hostless route to give up after the grace window, well before the handshake timeout', async () => {
    const graced = new CompanionRelayServer({ credential: SECRET, port: await freePort(), noHostGraceMs: 150 });
    const gracedUrl = `ws://127.0.0.1:${(await graced.listen()).port}`;
    const lonely = new RelayCompanionClient({
      identity: createIdentity(),
      route: { url: gracedUrl, routeToken: 'route-token-nohost1', credential: SECRET },
      deviceRef: 'phone-1',
      dial: nodeDial,
    });
    const started = Date.now();
    await lonely.connect();
    await expect(lonely.resume({ hostKey: toHex(hostIdentity.publicKey), deviceId: 'phone-1', scopeEpoch: 1, scope: ['shared'] }))
      .rejects.toThrow('COMPANION_RELAY_NO_HOST');
    expect(Date.now() - started).toBeLessThan(L.requestTimeoutMs / 2);
    expect(graced.currentStats).toMatchObject({ notifiedNoHost: 1, queuedFrames: 0 });
    await graced.stop();
  });

  it('does not report no-host when the host re-registers inside the grace window', async () => {
    const graced = new CompanionRelayServer({ credential: SECRET, port: await freePort(), noHostGraceMs: 400 });
    const gracedUrl = `ws://127.0.0.1:${(await graced.listen()).port}`;
    const identity = createIdentity();
    const device = gateway.pairIdentity(toHex(identity.publicKey), ['shared']);
    const lateHost = new CompanionRelayClient({
      gateway,
      identity: hostIdentity,
      config: { url: gracedUrl, credentialRef: 'companion-relay', reconnectBackoffMs: [30, 60, 120] },
      credential: SECRET,
      jitter: () => 0.5,
    });
    lateHost.advertise({ deviceRef: device.deviceId, routeToken: 'route-token-nohost2' });
    const client = new RelayCompanionClient({
      identity,
      route: { url: gracedUrl, routeToken: 'route-token-nohost2', credential: SECRET },
      deviceRef: device.deviceId,
      dial: nodeDial,
    });
    await client.connect();
    // 手机先到、握手排队；host 在宽限期内（模拟 Host 重连退避第一档）才注册上来。
    const resumed = client.resume({ hostKey: toHex(hostIdentity.publicKey), deviceId: device.deviceId, scopeEpoch: device.scopeEpoch, scope: device.scope });
    await new Promise(resolve => setTimeout(resolve, 100));
    await lateHost.start();
    await resumed;
    // 等过宽限期：定时器到点看到 host 在，什么都不发。
    await new Promise(resolve => setTimeout(resolve, 500));
    expect(client.connected).toBe(true);
    expect(graced.currentStats.notifiedNoHost).toBe(0);
    client.close();
    await lateHost.stop();
    await graced.stop();
  });

  // N-COMPANION-RELAY-RECONNECT-DROPSESSIONS：Host 换实例重连后本连接的会话表已清，手机还握着
  // 旧实例谈好的会话密钥——host 腿断开时 route 与设备腿都还活着，relay 必须给设备腿一个重拨
  // 重握手的推力，而不是让它干等自己的请求超时。宽限模式与 notifyNoHostAfterGrace 同款。
  it('tells a live device leg to re-dial after the host leg drops and the grace window lapses', async () => {
    const events: string[] = [];
    const graced = new CompanionRelayServer({
      credential: SECRET,
      port: await freePort(),
      noHostGraceMs: 150,
      logger: {
        info: (event, fields) => events.push(`${event} ${JSON.stringify(fields ?? {})}`),
        warn: (event, fields) => events.push(`${event} ${JSON.stringify(fields ?? {})}`),
      },
    });
    const gracedUrl = `ws://127.0.0.1:${(await graced.listen()).port}`;
    const identity = createIdentity();
    const device = gateway.pairIdentity(toHex(identity.publicKey), ['shared']);
    const flakyHost = new CompanionRelayClient({
      gateway,
      identity: hostIdentity,
      config: { url: gracedUrl, credentialRef: 'companion-relay', reconnectBackoffMs: [30, 60, 120] },
      credential: SECRET,
      jitter: () => 0.5,
    });
    flakyHost.advertise({ deviceRef: device.deviceId, routeToken: 'route-token-dropd1' });
    const client = new RelayCompanionClient({
      identity,
      route: { url: gracedUrl, routeToken: 'route-token-dropd1', credential: SECRET },
      deviceRef: device.deviceId,
      dial: nodeDial,
    });
    await flakyHost.start();
    await flakyHost.whenConnected();
    await client.connect();
    await client.resume({ hostKey: toHex(hostIdentity.publicKey), deviceId: device.deviceId, scopeEpoch: device.scopeEpoch, scope: device.scope });
    // Host 实例掉线：relay 处理 close → host 槽清空，route 与设备腿都还在（事故现场形状）。
    await flakyHost.stop();
    // 手机的请求在无 host 的 route 上排队；宽限到点 relay 回 no-host 并清掉排队帧，手机据此断开。
    const pending = client.request({ action: 'read' });
    await vi.waitFor(() => expect(graced.currentStats.queuedFrames).toBe(1));
    await expect(pending).rejects.toThrow('COMPANION_RELAY_NO_HOST');
    expect(client.connected).toBe(false);
    expect(graced.currentStats).toMatchObject({ notifiedNoHost: 1, queuedFrames: 0 });
    expect(events).toContain(`host_leg_detached_notify ${JSON.stringify({ token: 'route-to' })}`);
    client.close();
    await graced.stop();
  });

  it('does not disturb the device leg when the host re-registers inside the grace window after dropping', async () => {
    const events: string[] = [];
    const graced = new CompanionRelayServer({
      credential: SECRET,
      port: await freePort(),
      noHostGraceMs: 400,
      logger: {
        info: (event, fields) => events.push(`${event} ${JSON.stringify(fields ?? {})}`),
        warn: (event, fields) => events.push(`${event} ${JSON.stringify(fields ?? {})}`),
      },
    });
    const gracedUrl = `ws://127.0.0.1:${(await graced.listen()).port}`;
    const token = 'route-token-dropd2';
    const opened = (socket: WebSocket) => new Promise<void>(resolve => socket.once('open', () => resolve()));
    const register = (socket: WebSocket, role: 'host' | 'device') => socket.send(JSON.stringify({
      v: 1, kind: 'register', role,
      envelope: { routeToken: token, deviceRef: 'phone-1', seq: 0, ttlMs: L.relayRouteTokenTtlMs, issuedAt: Date.now() },
      ciphertext: '',
    }));
    const forward = (socket: WebSocket, seq: number) => socket.send(JSON.stringify({
      v: 1, kind: 'forward',
      envelope: { routeToken: token, deviceRef: 'phone-1', seq, ttlMs: L.relayRouteTokenTtlMs, issuedAt: Date.now() },
      ciphertext: 'x'.repeat(64),
    }));
    const hostLeg1 = new WebSocket(gracedUrl, { headers: { authorization: `Bearer ${SECRET}` } });
    await opened(hostLeg1);
    register(hostLeg1, 'host');
    const deviceLeg = new WebSocket(gracedUrl, { headers: { authorization: `Bearer ${SECRET}` } });
    await opened(deviceLeg);
    register(deviceLeg, 'device');
    forward(deviceLeg, 0);
    await vi.waitFor(() => expect(graced.currentStats.forwarded).toBe(1));
    // host 腿断开 → 宽限起算；设备腿随后发的帧在无 host 期间排队。
    hostLeg1.close();
    await new Promise<void>(resolve => hostLeg1.once('close', () => resolve()));
    forward(deviceLeg, 1);
    await vi.waitFor(() => expect(graced.currentStats.queuedFrames).toBe(1));
    // 新 host 实例在宽限期内重注册：排队帧经 flushWaiting 照常倒给新 socket。
    const hostLeg2 = new WebSocket(gracedUrl, { headers: { authorization: `Bearer ${SECRET}` } });
    const flushed = new Promise<void>(resolve => hostLeg2.once('message', data => {
      expect(JSON.parse(String(data)).envelope.seq).toBe(1);
      resolve();
    }));
    await opened(hostLeg2);
    register(hostLeg2, 'host');
    await flushed;
    // 等过宽限期：host 在位，定时器到点什么都不发，设备腿不受惊。
    await new Promise(resolve => setTimeout(resolve, 500));
    expect(deviceLeg.readyState).toBe(WebSocket.OPEN);
    expect(graced.currentStats).toMatchObject({ notifiedNoHost: 0, queuedFrames: 0 });
    expect(events.join('\n')).not.toContain('host_leg_detached_notify');
    deviceLeg.close();
    hostLeg2.close();
    await graced.stop();
  });

  it('breaks the device side when the host revokes', async () => {
    const binding = await pair();
    gateway.revokeDevice(binding.deviceId);
    host.revoke(binding.deviceId);
    await vi.waitFor(() => {
      expect(phone.connected).toBe(false);
      expect(relay.currentStats.revoked).toBeGreaterThanOrEqual(1);
    });
    await expect(phone.request({ action: 'command', command: command(binding.deviceId, 'after-revoke', 'nope') }))
      .rejects.toThrow();
    expect(executions).toBe(0);
  });

  it('sweeps expired routes and closes connections idle past the route TTL', async () => {
    let fakeNow = Date.now();
    const sweeping = new CompanionRelayServer({ credential: SECRET, port: await freePort(), now: () => fakeNow });
    const sweptPort = (await sweeping.listen()).port;
    const sweptHost = new CompanionRelayClient({
      gateway,
      identity: hostIdentity,
      config: { url: `ws://127.0.0.1:${sweptPort}`, credentialRef: 'companion-relay', reconnectBackoffMs: [60_000] },
      credential: SECRET,
      jitter: () => 0.5,
    });
    const sweptDevice = gateway.pairedDevices()[0];
    if (!sweptDevice) throw new Error('expected a paired device');
    sweptHost.advertise({ deviceRef: sweptDevice.deviceId, routeToken: TOKEN });
    await sweptHost.start();
    await sweptHost.whenConnected();
    const sweptPhone = new RelayPhoneStub(phoneIdentity, TOKEN, sweptDevice.deviceId);
    await sweptPhone.connect(`ws://127.0.0.1:${sweptPort}`, SECRET);

    const sweptHealth = async (): Promise<{ routes: number }> =>
      await (await fetch(`http://127.0.0.1:${sweptPort}/healthz`)).json() as { routes: number };
    expect((await sweptHealth()).routes).toBe(1);
    fakeNow += L.relayRouteTokenTtlMs + 1;
    sweeping.sweep();
    expect((await sweptHealth()).routes).toBe(0);
    fakeNow += L.relayIdleMs + 1;
    sweeping.sweep();
    await vi.waitFor(() => expect(sweptPhone.connected).toBe(false));
    await sweptHost.stop();
    sweptPhone.close();
    await sweeping.stop();
  });

  // N-COMPANION-RELAY-KEEPALIVE：连接活性由 WS 协议层 ping/pong 把关，不绑 route 生命周期。
  // 下面两例用注入时钟 + 手动 ping()/sweep() 驱动：真实 ping 定时器（relayPingMs=30s）在测试的
  // 真实时长内不会自燃。
  it('keeps a routeless pong-answering connection alive across idle sweeps', async () => {
    let fakeNow = Date.now();
    const events: string[] = [];
    const probing = new CompanionRelayServer({
      credential: SECRET,
      port: await freePort(),
      now: () => fakeNow,
      logger: { info: event => events.push(event), warn: () => {} },
    });
    const probingUrl = `ws://127.0.0.1:${(await probing.listen()).port}`;
    // 零 route 连接（不 register 任何 token），只有 ws 自动回 pong。
    const loner = new WebSocket(probingUrl, { headers: { authorization: `Bearer ${SECRET}` } });
    const received: string[] = [];
    loner.on('message', data => received.push(String(data)));
    await new Promise<void>(resolve => loner.once('open', () => resolve()));
    const connectionsAtOpen = probing.currentStats.connections;
    // 三个完整周期：每轮先把注入时钟推远超 relayIdleMs，靠 ping→pong 刷新 lastSeen，idle 清扫
    // 永远够不到这条连接（旧代码里 pong 不刷 lastSeen，这里第一轮就会被 connection_idle_closed 杀）。
    for (let cycle = 0; cycle < 3; cycle += 1) {
      fakeNow += L.relayIdleMs + 1_000;
      probing.ping();
      await new Promise(resolve => setTimeout(resolve, 100)); // loopback 上 ping→pong 毫秒级
      probing.sweep();
      probing.sweep();
      expect(loner.readyState).toBe(WebSocket.OPEN);
    }
    expect(received).toEqual([]); // 只答控制帧，不吃任何应用帧
    expect(probing.currentStats.connections).toBe(connectionsAtOpen);
    expect(probing.currentStats.terminatedNoPong).toBe(0);
    expect(events).not.toContain('connection_idle_closed');
    loner.close();
    await probing.stop();
  });

  it('terminates a connection that never answers pings, counted separately from idle sweeps', async () => {
    const events: string[] = [];
    const probing = new CompanionRelayServer({
      credential: SECRET,
      port: await freePort(),
      logger: {
        info: (event, fields) => events.push(`${event} ${JSON.stringify(fields ?? {})}`),
        warn: () => {},
      },
    });
    const probingUrl = `ws://127.0.0.1:${(await probing.listen()).port}`;
    // autoPong: false —— 模拟链路半开/TCP 已死：ping 发得出去，pong 永远回不来。
    const silent = new WebSocket(probingUrl, { headers: { authorization: `Bearer ${SECRET}` }, autoPong: false });
    await new Promise<void>(resolve => silent.once('open', () => resolve()));
    probing.ping(); // 第一轮：发探活，不判死——给 pong 留满一个完整周期
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(silent.readyState).toBe(WebSocket.OPEN);
    expect(probing.currentStats.terminatedNoPong).toBe(0);
    probing.ping(); // 一个完整周期仍无 pong → terminate（不是 close：半开连接等不到关闭帧握手）
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(silent.readyState).toBe(WebSocket.CLOSED);
    expect(probing.currentStats.terminatedNoPong).toBe(1);
    expect(events).toContain('connection_pong_timeout {}');
    expect(events).not.toContain('connection_idle_closed');
    await probing.stop();
  });

  it('drops frames whose envelope TTL has expired', async () => {
    const expired = new WebSocket(url, { headers: { authorization: `Bearer ${SECRET}` } });
    await new Promise<void>(resolve => expired.once('open', () => resolve()));
    expired.send(JSON.stringify({
      v: 1, kind: 'forward',
      envelope: {
        routeToken: TOKEN, deviceRef: 'phone-1', seq: 0,
        ttlMs: L.relayRouteTokenTtlMs, issuedAt: Date.now() - L.relayRouteTokenTtlMs - 5_000,
      },
      ciphertext: 'expired-payload',
    }));
    await vi.waitFor(() => expect(relay.currentStats.droppedExpired).toBeGreaterThanOrEqual(1));
    expired.close();
  });

  it('ignores revoke sent by the device side or for a route the sender never registered', async () => {
    const binding = await pair();
    const statsBefore = relay.currentStats;
    const intruder = new WebSocket(url, { headers: { authorization: `Bearer ${SECRET}` } });
    await new Promise<void>(resolve => intruder.once('open', () => resolve()));
    const control = (kind: 'revoke' | 'heartbeat', routeToken: string) => intruder.send(JSON.stringify({
      v: 1, kind,
      envelope: { routeToken, deviceRef: binding.deviceId, seq: 0, ttlMs: L.relayRouteTokenTtlMs, issuedAt: Date.now() },
      ciphertext: '',
    }));
    control('revoke', TOKEN);
    control('revoke', 'route-token-cccccc');
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(phone.connected).toBe(true);
    expect(relay.currentStats.revoked).toBe(statsBefore.revoked);
    expect(relay.currentStats.droppedNoRoute).toBeGreaterThanOrEqual(2);
    intruder.close();
    gateway.revokeDevice(binding.deviceId);
    host.revoke(binding.deviceId);
    await vi.waitFor(() => expect(phone.connected).toBe(false));
  });

  it('keeps one host connection serving many tokens and refreshes only heartbeated routes', async () => {
    let fakeNow = Date.now();
    const server2 = new CompanionRelayServer({ credential: SECRET, port: await freePort(), now: () => fakeNow });
    const port2 = (await server2.listen()).port;
    const multiHost = new WebSocket(`ws://127.0.0.1:${port2}`, { headers: { authorization: `Bearer ${SECRET}` } });
    await new Promise<void>(resolve => multiHost.once('open', () => resolve()));
    const tokenA = 'route-token-aaaaaa';
    const tokenB = 'route-token-bbbbbb';
    const register = (token: string) => multiHost.send(JSON.stringify({
      v: 1, kind: 'register', role: 'host',
      envelope: { routeToken: token, deviceRef: 'phone-1', seq: 0, ttlMs: L.relayRouteTokenTtlMs, issuedAt: fakeNow },
      ciphertext: '',
    }));
    register(tokenA);
    register(tokenB);
    await vi.waitFor(() => expect(server2.currentStats.routes).toBe(2));

    fakeNow += 10_000;
    multiHost.send(JSON.stringify({
      v: 1, kind: 'heartbeat',
      envelope: { routeToken: tokenA, deviceRef: 'phone-1', seq: 1, ttlMs: L.relayRouteTokenTtlMs, issuedAt: fakeNow },
      ciphertext: '',
    }));
    await new Promise(resolve => setTimeout(resolve, 100));
    // A 刷新到 +70s，B 仍是注册时的 +60s：推进到 +65s，只扫掉 B。
    fakeNow += 55_000;
    server2.sweep();
    expect(server2.currentStats.routes).toBe(1);
    multiHost.close();
    await server2.stop();
  });

  it('pins the connection role at first register: a device cannot flip to host to earn revoke', async () => {
    const binding = await pair();
    const statsBefore = relay.currentStats;
    const intruder = new WebSocket(url, { headers: { authorization: `Bearer ${SECRET}` } });
    await new Promise<void>(resolve => intruder.once('open', () => resolve()));
    const own = 'route-token-dddddd';
    intruder.send(JSON.stringify({
      v: 1, kind: 'register', role: 'device',
      envelope: { routeToken: own, deviceRef: binding.deviceId, seq: 0, ttlMs: L.relayRouteTokenTtlMs, issuedAt: Date.now() },
      ciphertext: '',
    }));
    await new Promise(resolve => setTimeout(resolve, 100));
    intruder.send(JSON.stringify({
      v: 1, kind: 'register', role: 'host',
      envelope: { routeToken: TOKEN, deviceRef: binding.deviceId, seq: 1, ttlMs: L.relayRouteTokenTtlMs, issuedAt: Date.now() },
      ciphertext: '',
    }));
    await new Promise(resolve => setTimeout(resolve, 100));
    intruder.send(JSON.stringify({
      v: 1, kind: 'revoke',
      envelope: { routeToken: TOKEN, deviceRef: binding.deviceId, seq: 2, ttlMs: L.relayRouteTokenTtlMs, issuedAt: Date.now() },
      ciphertext: '',
    }));
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(phone.connected).toBe(true);
    expect(relay.currentStats.revoked).toBe(statsBefore.revoked);
    expect(relay.currentStats.droppedNoRoute).toBeGreaterThanOrEqual(2);
    intruder.close();
  });

  it('drops queued frames that expired while waiting for the peer', async () => {
    let fakeNow = Date.now();
    const server2 = new CompanionRelayServer({ credential: SECRET, port: await freePort(), now: () => fakeNow });
    const port2 = (await server2.listen()).port;
    const queueToken = 'route-token-eeeeee';
    const deviceSide = new WebSocket(`ws://127.0.0.1:${port2}`, { headers: { authorization: `Bearer ${SECRET}` } });
    await new Promise<void>(resolve => deviceSide.once('open', () => resolve()));
    deviceSide.send(JSON.stringify({
      v: 1, kind: 'register', role: 'device',
      envelope: { routeToken: queueToken, deviceRef: 'phone-1', seq: 0, ttlMs: L.relayRouteTokenTtlMs, issuedAt: fakeNow },
      ciphertext: '',
    }));
    for (let seq = 1; seq <= 2; seq += 1) {
      deviceSide.send(JSON.stringify({
        v: 1, kind: 'forward',
        envelope: { routeToken: queueToken, deviceRef: 'phone-1', seq, ttlMs: 5_000, issuedAt: fakeNow },
        ciphertext: 'x'.repeat(64),
      }));
    }
    await vi.waitFor(() => expect(server2.currentStats.queuedFrames).toBe(2));
    fakeNow += 6_000;
    const hostSide = new WebSocket(`ws://127.0.0.1:${port2}`, { headers: { authorization: `Bearer ${SECRET}` } });
    await new Promise<void>(resolve => hostSide.once('open', () => resolve()));
    hostSide.send(JSON.stringify({
      v: 1, kind: 'register', role: 'host',
      envelope: { routeToken: queueToken, deviceRef: 'phone-1', seq: 0, ttlMs: L.relayRouteTokenTtlMs, issuedAt: fakeNow },
      ciphertext: '',
    }));
    await vi.waitFor(() => {
      const stats = server2.currentStats;
      expect(stats.queuedFrames).toBe(0);
      expect(stats.droppedExpired).toBe(2);
      expect(stats.forwarded).toBe(0);
    });
    deviceSide.close();
    hostSide.close();
    await server2.stop();
  });

  it('does not re-execute after a relay restart when the commandId survives the hop', async () => {
    const binding = await pair();
    const cmd = command(binding.deviceId, 'once', 'restart-replay');
    expect(await phone.request({ action: 'command', command: cmd })).toMatchObject({ kind: 'accepted' });
    phone.close();
    await relay.stop();
    await relay.listen();
    await host.whenConnected();
    phone = new RelayPhoneStub(phoneIdentity, TOKEN, binding.deviceId);
    await phone.connect(url, SECRET);
    await phone.resume(toHex(hostIdentity.publicKey), url);
    expect(await phone.request({ action: 'command', command: cmd })).toMatchObject({ kind: 'replayed' });
    expect(executions).toBe(1);
  });
});
