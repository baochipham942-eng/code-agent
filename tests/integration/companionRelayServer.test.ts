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
import { RelayPhoneStub } from './companion/relayPhoneStub';

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
      'forwarded', 'queuedFrames', 'rejectedAuth', 'revoked', 'routes',
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
