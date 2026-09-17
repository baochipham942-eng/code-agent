import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import { networkInterfaces } from 'node:os';
import { CompanionGateway } from '../../src/host/services/companion/CompanionGateway';
import { CompanionRelayClient } from '../../src/host/services/companion/CompanionRelayClient';
import { LanCompanionServer } from '../../src/host/services/companion/LanCompanionServer';
import { createIdentity } from '../../src/shared/companion/noiseChannel';
import { isPrivateIPv4, toHex } from '../../src/shared/companion/lanProtocol';
import { CompanionRelayServer } from '../../packages/relay/src/server';
import { createCompanionStore } from '../../packages/mobile/src/stores/companionStore';
import { browserRelayDial } from '../../packages/mobile/src/platform/relayCompanionClient';

/**
 * N-COMPANION-RELAY-PHONE-AUTH 手机侧的真实形态：生产 CompanionRelayServer（不是 fake）+
 * 产品里的 browserRelayDial——node 的全局 WebSocket 与 WebView 是同一套事件面（子协议、
 * onopen/onmessage），所以这里跑的就是真机上「凭据走子协议」的那条拨号路径。Host 侧
 * routeToken 确定性派生的重启稳定性也钉在这条链路上。
 */
const SECRET = 'relay-shared-credential';

describe('companion relay phone: subprotocol credential dial + stable route token', () => {
  let db: Database.Database;
  let gateway: CompanionGateway;
  let lanServer: LanCompanionServer;
  let relay: CompanionRelayServer;
  let hostRelay: CompanionRelayClient;
  let executions: number;
  let storage: string | null;
  let lanUp: boolean;
  const hostIdentity = createIdentity();
  const address = Object.values(networkInterfaces()).flat().find(n => n?.family === 'IPv4' && isPrivateIPv4(n.address))?.address;

  const post = async (url: string, body: unknown) => {
    if (!lanUp) throw new Error('COMPANION_NETWORK_UNAVAILABLE');
    const res = await fetch(url, { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const raw = await res.text();
    if (!res.ok) throw new Error(`HTTP_${res.status}`);
    return JSON.parse(raw) as unknown;
  };
  const phone = () => createCompanionStore({
    read: async () => storage,
    write: async value => { storage = value; },
    scan: async () => JSON.stringify(lanServer.invite(['shared'])),
    post,
    dialRelay: browserRelayDial,
  }, () => {});

  beforeEach(async () => {
    if (!address) throw new Error('LAN_TEST_REQUIRES_PRIVATE_IPV4_ON_FLEET');
    executions = 0; storage = null; lanUp = true;
    db = new Database(':memory:');
    gateway = new CompanionGateway(db, {
      dispatch: () => { executions += 1; return { state: 'accepted', result: { runId: 'test-run' } }; },
      read: async () => ({ sessions: [], projects: [], models: [], nextOffset: null }),
    });
    relay = new CompanionRelayServer({ credential: SECRET });
    const url = `ws://127.0.0.1:${(await relay.listen()).port}`;
    hostRelay = new CompanionRelayClient({
      gateway,
      identity: hostIdentity,
      config: { url, credentialRef: 'companion-relay', reconnectBackoffMs: [30, 60, 120] },
      credential: SECRET,
      jitter: () => 0.5,
    });
    await hostRelay.start();
    lanServer = new LanCompanionServer(gateway, hostIdentity, Date.now, undefined, deviceId => hostRelay.routeFor(deviceId));
    await lanServer.start(address, 0);
  });

  afterEach(async () => {
    await hostRelay?.stop();
    await lanServer?.stop();
    await relay?.stop();
    db?.close();
  });

  const saved = () => JSON.parse(storage ?? '{}') as { relay?: { url: string; routeToken: string; credential: string }; publicKey?: string };

  const restartHostRelay = async (identity = hostIdentity): Promise<void> => {
    await hostRelay.stop();
    hostRelay = new CompanionRelayClient({
      gateway,
      identity,
      config: { url: `ws://127.0.0.1:${relay.address.port}`, credentialRef: 'companion-relay', reconnectBackoffMs: [30, 60, 120] },
      credential: SECRET,
      jitter: () => 0.5,
    });
    await hostRelay.start();
    await hostRelay.whenConnected();
  };

  it('dials with the credential in the subprotocol and relays traffic', async () => {
    const store = phone();
    await store.getState().pair();
    const rejectedBefore = relay.currentStats.rejectedAuth;
    lanUp = false;
    await store.getState().reconnect();
    // 子协议拨号过了生产 relay 的凭据闸：不是「被拒后掉线」，是真正连上干活。
    expect(store.getState()).toMatchObject({ status: 'connected', transport: 'relay' });
    await store.getState().send('subprotocol-正文');
    expect(store.getState()).toMatchObject({ status: 'connected', pending: false });
    expect(executions).toBe(1);
    expect(relay.currentStats.rejectedAuth).toBe(rejectedBefore);
    store.getState().pause();
  });

  it('keeps the route token across a host restart: the phone resumes on the cached route without a refresh', async () => {
    const store = phone();
    await store.getState().pair();
    const deviceId = store.getState().binding!.deviceId;
    lanUp = false;
    await store.getState().reconnect();
    expect(store.getState().transport).toBe('relay');
    const tokenBefore = saved().relay?.routeToken;

    // Host 重启 = 新 CompanionRelayClient + 同一身份密钥 + 同一 gateway DB。派生确定 ⇒ token 不变。
    await restartHostRelay();
    expect(hostRelay.routeTokenFor(deviceId)).toBe(tokenBefore);

    // LAN 仍断：手机 reconnect 只能落 relay，用的就是配对盘里那份没刷新过的缓存路由。
    await store.getState().reconnect();
    expect(store.getState()).toMatchObject({ status: 'connected', transport: 'relay' });
    await store.getState().send('after-host-restart-正文');
    expect(executions).toBe(1);
    store.getState().pause();
  });

  it('changes the token when the epoch moves and never re-registers a revoked device', async () => {
    const store = phone();
    await store.getState().pair();
    const deviceBefore = store.getState().binding!.deviceId;
    const tokenBefore = saved().relay?.routeToken;
    // 同一手机公钥重新配对：pairIdentity 先 revoke 旧设备行（scope_epoch 进位）再发新行。
    const rePaired = gateway.pairIdentity(saved().publicKey ?? '', ['shared']);
    expect(rePaired.deviceId).not.toBe(deviceBefore);

    // Host 重启后只为仍在配对表里的设备派生 token：撤销设备的旧 token 不复活。
    await restartHostRelay();
    expect(hostRelay.routeTokenFor(deviceBefore)).toBeNull();
    const tokenAfter = hostRelay.routeTokenFor(rePaired.deviceId);
    expect(tokenAfter).toBeTruthy();
    expect(tokenAfter).not.toBe(tokenBefore);
    store.getState().pause();
  });
});
