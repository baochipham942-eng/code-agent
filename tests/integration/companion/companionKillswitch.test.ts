import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import path from 'node:path';
import type WebSocket from 'ws';
import WebSocketImpl from 'ws';
import { CompanionGateway } from '../../../src/host/services/companion/CompanionGateway';
import { CompanionRelayClient } from '../../../src/host/services/companion/CompanionRelayClient';
import { startCompanionRelayAccountIfConfigured } from '../../../src/host/services/companion/companionRelayAccount';
import { LanCompanionManager } from '../../../src/host/services/companion/LanCompanionManager';
import { LanCompanionServer } from '../../../src/host/services/companion/LanCompanionServer';
import { createIdentity } from '../../../src/shared/companion/noiseChannel';
import { isPrivateIPv4, toHex, type LanBinding } from '../../../src/shared/companion/lanProtocol';
import { COMPANION_LIMITS as L } from '../../../src/shared/constants/companion';
import { LanCompanionClient, type LanPost } from '../../../packages/mobile/src/platform/lanCompanionClient';
import { FakeCompanionRelay } from './fakeCompanionRelay';

/**
 * 总闸是暂停：关掉之后旧手机拿不到能力，打开之后同一对配对原样回来。
 * 监听还在时看线上的拒绝码；manage 关掉时端口要真的拒绝连接。
 */

const address = Object.values(networkInterfaces()).flat().find(item => item?.family === 'IPv4' && isPrivateIPv4(item.address))?.address;
const quietLog = { warn(): void {}, info(): void {} };

function requireAddress(): string {
  if (!address) throw new Error('LAN_TEST_REQUIRES_PRIVATE_IPV4_ON_FLEET');
  return address;
}

function connectCode(host: string, port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host, port });
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('TCP_TIMEOUT')); }, 1000);
    socket.once('connect', () => { clearTimeout(timer); socket.end(); resolve('open'); });
    socket.once('error', (error: NodeJS.ErrnoException) => { clearTimeout(timer); resolve(error.code ?? error.message); });
  });
}

function command(binding: LanBinding, commandId = 'once') {
  return {
    version: 1 as const,
    deviceId: binding.deviceId,
    commandId,
    scopeEpoch: binding.scopeEpoch,
    sessionId: 'shared',
    action: 'message.send' as const,
    payload: { text: 'pause-switch' },
  };
}

function rows(db: Database.Database | undefined) {
  if (!db) throw new Error('db missing');
  return {
    devices: db.prepare('SELECT device_id, scope_epoch, revoked_at FROM companion_devices ORDER BY device_id').all(),
    keys: db.prepare('SELECT public_key, device_id FROM companion_identity_keys ORDER BY public_key').all(),
  };
}

describe('companion remote pause: gateway entry points', () => {
  let db: Database.Database;
  let gateway: CompanionGateway;
  let publicKey: string;
  let deviceId: string;
  let scopeEpoch: number;

  beforeEach(() => {
    db = new Database(':memory:');
    gateway = new CompanionGateway(db, {
      now: () => 1_700_000_000_000,
      dispatch: () => ({ state: 'accepted', result: { runId: 'run' } }),
      read: async () => ({ sessions: [] }),
    });
    publicKey = toHex(createIdentity().publicKey);
    const device = gateway.pairIdentity(publicKey, ['shared']);
    deviceId = device.deviceId;
    scopeEpoch = device.scopeEpoch;
  });
  afterEach(() => { db?.close(); });

  it('leaves an install with no settings row reachable', () => {
    expect(gateway.remoteEnabled()).toBe(true);
    expect(gateway.identityDevice(publicKey)).toMatchObject({ deviceId, scopeEpoch });
  });

  it('treats any stored value other than 1 as off', () => {
    db.prepare(`INSERT INTO companion_settings (key, value) VALUES ('remoteEnabled', 'yes')`).run();
    expect(gateway.remoteEnabled()).toBe(false);
    gateway.setRemoteEnabled(true);
    expect(db.prepare(`SELECT value FROM companion_settings WHERE key = 'remoteEnabled'`).get()).toEqual({ value: '1' });
  });

  it('submit returns remote_off and does not touch paired rows', async () => {
    const before = rows(db);
    const epoch = gateway.epoch;
    gateway.setRemoteEnabled(false);
    await expect(gateway.submit({
      version: 1, deviceId, commandId: 'c1', scopeEpoch, sessionId: 'shared', action: 'message.send', payload: { text: 'hi' },
    })).resolves.toEqual({ kind: 'rejected', reason: 'remote_off' });
    await expect(gateway.submit({ nope: true })).resolves.toEqual({ kind: 'rejected', reason: 'remote_off' });
    expect(gateway.epoch).toBe(epoch);
    expect(rows(db)).toEqual(before);
    expect(gateway.identityDevice(publicKey)).toMatchObject({ deviceId, scopeEpoch });
  });

  it('read throws COMPANION_REMOTE_OFF', async () => {
    gateway.setRemoteEnabled(false);
    await expect(gateway.read(deviceId, { kind: 'library' })).rejects.toThrow('COMPANION_REMOTE_OFF');
  });

  it('syncForDevice throws COMPANION_REMOTE_OFF', () => {
    gateway.setRemoteEnabled(false);
    expect(() => gateway.syncForDevice(deviceId, scopeEpoch, 0)).toThrow('COMPANION_REMOTE_OFF');
  });

  it('commandStatus throws COMPANION_REMOTE_OFF', () => {
    gateway.setRemoteEnabled(false);
    expect(() => gateway.commandStatus(deviceId, 'c1')).toThrow('COMPANION_REMOTE_OFF');
  });

  it('pairIdentity throws COMPANION_REMOTE_OFF and keeps the existing phone', () => {
    const before = rows(db);
    gateway.setRemoteEnabled(false);
    expect(() => gateway.pairIdentity(toHex(createIdentity().publicKey), ['shared'])).toThrow('COMPANION_REMOTE_OFF');
    expect(rows(db)).toEqual(before);
    expect(gateway.identityDevice(publicKey)?.deviceId).toBe(deviceId);
  });
});

describe('companion remote pause: LAN wire and the same phone', () => {
  let db: Database.Database | undefined;
  let gateway: CompanionGateway;
  let server: LanCompanionServer | undefined;
  let manager: LanCompanionManager | undefined;
  const hostIdentity = createIdentity();

  beforeEach(() => {
    requireAddress();
    db = new Database(':memory:');
    gateway = new CompanionGateway(db, {
      now: () => 1_700_000_000_000,
      dispatch: () => ({ state: 'accepted', result: { runId: 'run' } }),
      read: async () => ({ sessions: [] }),
    });
  });
  afterEach(async () => {
    await manager?.stop();
    await server?.stop();
    db?.close();
  });

  function recordingPost(bodies: unknown[]): LanPost {
    return async (url, body) => {
      const res = await fetch(url, {
        method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      const raw = await res.text();
      bodies.push(JSON.parse(raw) as unknown);
      if (!res.ok) throw new Error(`HTTP_${res.status}`);
      return JSON.parse(raw) as unknown;
    };
  }

  async function postRaw(url: string, body: unknown): Promise<{ status: number; body: unknown }> {
    const res = await fetch(url, {
      method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() as unknown };
  }

  it('hello, finish and exchange answer COMPANION_REMOTE_OFF before identity or decrypt', async () => {
    server = new LanCompanionServer(gateway, hostIdentity);
    await server.start(requireAddress(), 0);
    const phone = createIdentity();
    const bodies: unknown[] = [];
    const client = new LanCompanionClient(phone, recordingPost(bodies));
    const binding = await client.pair(JSON.stringify(server.invite(['shared'])));
    const base = server.endpoints().endpoint;
    gateway.setRemoteEnabled(false);
    const identity = vi.spyOn(gateway, 'identityDevice');
    const pair = vi.spyOn(gateway, 'pairIdentity');
    const submit = vi.spyOn(gateway, 'submit');
    const hello = await postRaw(`${base}/v1/hello`, { mode: 'resume', frame: '00' });
    const finish = await postRaw(`${base}/v1/finish`, { channelId: 'stale', frame: '00' });
    expect(hello).toEqual({ status: 403, body: { error: 'COMPANION_REMOTE_OFF' } });
    expect(finish).toEqual({ status: 403, body: { error: 'COMPANION_REMOTE_OFF' } });
    await expect(client.request({ action: 'sync', epoch: binding.scopeEpoch, afterSeq: 0 })).rejects.toThrow('HTTP_403');
    expect(bodies.at(-1)).toEqual({ error: 'COMPANION_REMOTE_OFF' });
    expect(identity).not.toHaveBeenCalled();
    expect(pair).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    gateway.revokeDevice(binding.deviceId);
    const revoked = await postRaw(`${base}/v1/hello`, { mode: 'resume', frame: '00' });
    expect(revoked).toEqual({ status: 403, body: { error: 'COMPANION_REMOTE_OFF' } });
    client.close();
  });

  function openManager(transports?: { start(): Promise<void>; stop(): Promise<void> }): LanCompanionManager {
    if (!gateway) throw new Error('gateway missing');
    return new LanCompanionManager(
      gateway,
      async () => hostIdentity,
      async () => [{ id: 'shared', title: 'Shared' }],
      () => [],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      transports,
    );
  }

  async function invite(client: LanCompanionClient): Promise<LanBinding> {
    if (!manager) throw new Error('manager missing');
    const result = await manager.manage({ action: 'invite', scope: ['shared'] });
    if (result.kind !== 'invitation') throw new Error(`expected invitation, got ${result.kind}`);
    return client.pair(JSON.stringify(result.invitation));
  }

  async function resumeSame(client: LanCompanionClient, binding: LanBinding): Promise<LanBinding> {
    if (!manager) throw new Error('manager missing');
    const ad = manager.lanAdvertisement();
    if (!ad) throw new Error('LAN listener did not return');
    return client.recover({
      endpoint: ad.endpoint,
      ...(ad.altEndpoint ? { altEndpoint: ad.altEndpoint } : {}),
      candidates: ad.candidates,
      hostKey: binding.hostKey,
    }, binding);
  }

  it('closes the LAN port while off and lets the same phone sync after on', async () => {
    const bodies: unknown[] = [];
    const phone = createIdentity();
    const client = new LanCompanionClient(phone, recordingPost(bodies));
    manager = openManager();
    const binding = await invite(client);
    const paired = gateway.pairedDevices();
    const epoch = gateway.epoch;
    const stored = rows(db);
    const endpoint = new URL(manager.lanAdvertisement()!.endpoint);
    expect(await connectCode(endpoint.hostname, Number(endpoint.port))).toBe('open');
    const pair = vi.spyOn(gateway, 'pairIdentity');
    const revoke = vi.spyOn(gateway, 'revokeDevice');
    await manager.manage({ action: 'setRemote', enabled: false });
    expect(await connectCode(endpoint.hostname, Number(endpoint.port))).toBe('ECONNREFUSED');
    expect(gateway.pairedDevices()).toEqual(paired);
    expect(gateway.epoch).toBe(epoch);
    expect(rows(db)).toEqual(stored);
    expect(pair).not.toHaveBeenCalled();
    expect(revoke).not.toHaveBeenCalled();
    await expect(manager.manage({ action: 'invite', scope: ['shared'] })).rejects.toThrow('COMPANION_REMOTE_OFF');
    const status = await manager.manage({ action: 'setRemote', enabled: true });
    expect(status).toMatchObject({ kind: 'status', remoteEnabled: true });
    expect(gateway.pairedDevices()).toEqual(paired);
    expect(gateway.epoch).toBe(epoch);
    expect(pair).not.toHaveBeenCalled();
    const back = await resumeSame(client, binding);
    expect(back.deviceId).toBe(binding.deviceId);
    expect(back.scopeEpoch).toBe(binding.scopeEpoch);
    expect(await client.request({ action: 'sync', epoch: binding.scopeEpoch, afterSeq: 0 })).toMatchObject({ kind: 'events' });
    expect(await client.request({ action: 'command', command: command(binding) })).toMatchObject({ kind: 'accepted' });
    expect(pair).not.toHaveBeenCalled();
    client.close();
  });

  it('keeps a phone revoked across off and on, and allows revoke while off', async () => {
    const phoneA = createIdentity();
    const phoneB = createIdentity();
    const clientA = new LanCompanionClient(phoneA, recordingPost([]));
    const clientB = new LanCompanionClient(phoneB, recordingPost([]));
    manager = openManager();
    const bindingA = await invite(clientA);
    const bindingB = await invite(clientB);
    const epochB = bindingB.scopeEpoch;
    await manager.manage({ action: 'revoke', deviceId: bindingA.deviceId });
    expect(gateway.identityDevice(toHex(phoneA.publicKey))).toBeNull();
    expect(gateway.pairedDevices().map(device => device.deviceId)).toEqual([bindingB.deviceId]);
    await manager.manage({ action: 'setRemote', enabled: false });
    await manager.manage({ action: 'setRemote', enabled: true });
    expect(gateway.identityDevice(toHex(phoneA.publicKey))).toBeNull();
    expect(gateway.pairedDevices().map(device => device.deviceId)).toEqual([bindingB.deviceId]);
    await expect(clientA.resume(bindingA)).rejects.toThrow();
    const backB = await resumeSame(clientB, bindingB);
    expect(backB.deviceId).toBe(bindingB.deviceId);
    expect(backB.scopeEpoch).toBe(epochB);
    const synced = await clientB.request({ action: 'sync', epoch: bindingB.scopeEpoch, afterSeq: 0 }) as { kind: string };
    expect(['events', 'snapshot_required']).toContain(synced.kind);
    expect(await clientB.request({ action: 'command', command: command(backB, 'still-here') })).toMatchObject({ kind: 'accepted' });

    await manager.manage({ action: 'setRemote', enabled: false });
    await manager.manage({ action: 'revoke', deviceId: bindingB.deviceId });
    expect(gateway.identityDevice(toHex(phoneB.publicKey))).toBeNull();
    await manager.manage({ action: 'setRemote', enabled: true });
    expect(gateway.identityDevice(toHex(phoneB.publicKey))).toBeNull();
    expect(gateway.pairedDevices()).toEqual([]);
    await expect(clientB.resume(bindingB)).rejects.toThrow();
    clientA.close();
    clientB.close();
  });

  it('starts LAN for a paired device by default and stays closed when the saved flag is off', async () => {
    const device = gateway.pairIdentity(toHex(createIdentity().publicKey), ['shared']);
    manager = openManager();
    await manager.restore();
    const ad = manager.lanAdvertisement();
    expect(ad).not.toBeNull();
    const endpoint = new URL(ad!.endpoint);
    expect(await connectCode(endpoint.hostname, Number(endpoint.port))).toBe('open');
    await manager.stop();
    gateway.setRemoteEnabled(false);
    if (!db) throw new Error('db missing');
    const restarted = new CompanionGateway(db, { now: () => 1_700_000_000_000 });
    const loadIdentity = vi.fn(async () => hostIdentity);
    const quiet = new LanCompanionManager(restarted, loadIdentity, async () => [{ id: 'shared', title: 'Shared' }]);
    await quiet.restore();
    expect(loadIdentity).not.toHaveBeenCalled();
    expect(quiet.lanAdvertisement()).toBeNull();
    expect(restarted.pairedDevices().map(item => item.deviceId)).toEqual([device.deviceId]);
    expect(restarted.remoteEnabled()).toBe(false);
  });
});

describe('companion remote pause: relay sockets', () => {
  const sockets = { n: 0 };
  class CountingWebSocket extends WebSocketImpl {
    constructor(url: string, options?: WebSocket.ClientOptions) {
      sockets.n += 1;
      super(url, options);
    }
  }

  let db: Database.Database | undefined;
  let gateway: CompanionGateway;
  let relay: FakeCompanionRelay | undefined;
  let dataDir = '';
  let legacy: CompanionRelayClient | undefined;
  let account: ReturnType<typeof startCompanionRelayAccountIfConfigured> | undefined;
  const secret = 'test-relay-credential';
  const hostIdentity = createIdentity();

  beforeEach(async () => {
    sockets.n = 0;
    db = new Database(':memory:');
    gateway = new CompanionGateway(db);
    relay = new FakeCompanionRelay(secret);
    await relay.listen();
    dataDir = mkdtempSync(path.join(tmpdir(), 'killswitch-relay-'));
    const config = { url: relay.url, credentialRef: 'companion-relay', reconnectBackoffMs: [40, 40, 40] };
    writeFileSync(path.join(dataDir, L.relayConfigFile), JSON.stringify({ v: 1, enabled: true, ...config }));
    legacy = new CompanionRelayClient({
      gateway,
      identity: hostIdentity,
      config,
      credential: secret,
      jitter: () => 0,
      WebSocket: CountingWebSocket as unknown as typeof WebSocket,
      logger: quietLog,
    });
    account = startCompanionRelayAccountIfConfigured({
      dataDirectory: dataDir,
      gateway,
      loadIdentity: async () => hostIdentity,
      auth: {
        getCurrentUser: () => ({ id: 'user-1' }),
        getAccessToken: async () => secret,
        addAuthChangeCallback: () => () => {},
      },
      jitter: () => 0,
      WebSocket: CountingWebSocket as unknown as typeof WebSocket,
      logger: quietLog,
    });
    await legacy.start();
  });

  afterEach(async () => {
    await account?.stop();
    await legacy?.stop();
    await relay?.stop();
    db?.close();
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  it('reports the legacy and account clients as not connected and not dialing while off', async () => {
    const legacyClient = legacy;
    const accountHandle = account;
    if (!legacyClient || !accountHandle) throw new Error('relay clients missing');
    await vi.waitFor(() => {
      expect(legacyClient.connected).toBe(true);
      expect(accountHandle.connected()).toBe(true);
    }, { timeout: 8_000 });
    expect(legacyClient.dialing).toBe(false);
    expect(accountHandle.dialing()).toBe(false);
    const manager = new LanCompanionManager(
      gateway,
      async () => hostIdentity,
      async () => [],
      () => [],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        start: async () => {
          accountHandle.resume();
          await legacyClient.start();
        },
        stop: async () => {
          await accountHandle.suspend();
          await legacyClient.stop();
        },
      },
    );
    const seen = sockets.n;
    await manager.manage({ action: 'setRemote', enabled: false });
    expect(legacyClient.connected).toBe(false);
    expect(legacyClient.dialing).toBe(false);
    expect(accountHandle.connected()).toBe(false);
    expect(accountHandle.dialing()).toBe(false);
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(sockets.n).toBe(seen);
    expect(legacyClient.dialing).toBe(false);
    expect(accountHandle.dialing()).toBe(false);
    await manager.manage({ action: 'setRemote', enabled: true });
    await vi.waitFor(() => expect(sockets.n).toBeGreaterThan(seen), { timeout: 2_000 });
    await vi.waitFor(() => {
      expect(legacyClient.connected).toBe(true);
      expect(accountHandle.connected()).toBe(true);
    }, { timeout: 8_000 });
    expect(legacyClient.dialing).toBe(false);
    expect(accountHandle.dialing()).toBe(false);
  });
});
