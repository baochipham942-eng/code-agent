import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import WebSocket from 'ws';
import { networkInterfaces } from 'node:os';
import { CompanionGateway } from '../../src/host/services/companion/CompanionGateway';
import { CompanionRelayClient } from '../../src/host/services/companion/CompanionRelayClient';
import { LanCompanionServer } from '../../src/host/services/companion/LanCompanionServer';
import { FakeCompanionRelay } from './companion/fakeCompanionRelay';
import { createIdentity } from '../../src/shared/companion/noiseChannel';
import { isPrivateIPv4 } from '../../src/shared/companion/lanProtocol';
import { createCompanionStore } from '../../packages/mobile/src/stores/companionStore';
import type { RelayDial } from '../../packages/mobile/src/platform/relayCompanionClient';

/**
 * N-MOBILE-RELAY-PHONE 手机侧 relay 客户端的端到端形态：真 CompanionGateway + 真
 * LanCompanionServer（回环）+ fake relay + 真 Host 侧 CompanionRelayClient + 真
 * companionStore。手机侧 relay 通道用的是产品里的 RelayCompanionClient（node ws dial
 * 只替 WebView 的 WebSocket——能设 Authorization 头的那一半）。
 */
const SECRET = 'relay-shared-credential';

const nodeDial: RelayDial = (url, headers) => {
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

describe('companion relay phone: dual-path over real gateway + LAN server + fake relay', () => {
  let db: Database.Database;
  let gateway: CompanionGateway;
  let lanServer: LanCompanionServer;
  let legacyServer: LanCompanionServer | null;
  let relay: FakeCompanionRelay;
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
  const phone = (inviter: LanCompanionServer = lanServer) => createCompanionStore({
    read: async () => storage,
    write: async value => { storage = value; },
    scan: async () => JSON.stringify(inviter.invite(['shared'])),
    post,
    dialRelay: nodeDial,
  }, () => {});

  beforeEach(async () => {
    if (!address) throw new Error('LAN_TEST_REQUIRES_PRIVATE_IPV4_ON_FLEET');
    executions = 0; storage = null; lanUp = true; legacyServer = null;
    db = new Database(':memory:');
    gateway = new CompanionGateway(db, {
      dispatch: () => { executions += 1; return { state: 'accepted', result: { runId: 'test-run' } }; },
      read: async () => ({ sessions: [], projects: [], models: [], nextOffset: null }),
    });
    relay = new FakeCompanionRelay(SECRET);
    const url = await relay.listen();
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
    await legacyServer?.stop();
    await lanServer?.stop();
    await relay?.stop();
    db?.close();
  });

  const saved = () => JSON.parse(storage ?? '{}') as { relay?: { url: string; routeToken: string; credential: string } };

  it('pairs over LAN and caches the relay route the host hands out', async () => {
    const store = phone();
    await store.getState().pair();
    expect(store.getState()).toMatchObject({ status: 'connected', transport: 'lan' });
    const route = saved().relay;
    expect(route).toBeTruthy();
    expect(route?.credential).toBe(SECRET);
    // parseCompanionRelayUrl 归一化会补尾斜杠。
    expect(route?.url).toBe(`${relay.url}/`);
    const deviceId = store.getState().binding?.deviceId;
    expect(deviceId).toBeTruthy();
    expect(route?.routeToken).toBe(hostRelay.routeTokenFor(deviceId!));
    // 手机不该等下一次 heartbeat：配对完就能拿到（routeFor 按需铸造）。
    expect(route?.routeToken).toMatch(/^[A-Za-z0-9_-]{16,}$/);
    store.getState().pause();
  });

  it('falls to the relay when LAN dies, works there, and the wire stays ciphertext', async () => {
    const store = phone();
    await store.getState().pair();
    lanUp = false;
    await store.getState().reconnect();
    expect(store.getState()).toMatchObject({ status: 'connected', transport: 'relay' });
    const wireBefore = relay.captures.length;
    await store.getState().send('relay-message-正文');
    expect(store.getState()).toMatchObject({ status: 'connected', pending: false });
    expect(executions).toBe(1);
    // 幂等键穿透 relay 层：请求 forward 的信封带 commandId，Host 回执信封原样回带同一个
    // （明文信封可见，密文负载里则一个字都看不见）。
    const forwards = relay.captures.slice(wireBefore).map(raw => JSON.parse(raw) as { kind: string; envelope?: { idempotencyKey?: string } });
    const withKey = forwards.filter(frame => frame.kind === 'forward' && frame.envelope?.idempotencyKey);
    expect(withKey.length).toBe(2);
    expect(new Set(withKey.map(frame => frame.envelope?.idempotencyKey)).size).toBe(1);
    expect(withKey[0]?.envelope?.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    const wire = relay.captures.join('\n');
    expect(wire).not.toContain('relay-message-正文');
    expect(wire).not.toContain('message.send');
    expect(wire).not.toContain(SECRET);
    store.getState().pause();
  });

  it('reads the library through the relay channel', async () => {
    const store = phone();
    await store.getState().pair();
    lanUp = false;
    await store.getState().reconnect();
    expect(store.getState().transport).toBe('relay');
    await store.getState().refreshLibrary();
    expect(store.getState().libraryError).toBe(false);
    expect(store.getState().library).toMatchObject({ sessions: [], projects: [], models: [] });
    store.getState().pause();
  });

  it('converges back to LAN on the next reconnect without running both paths', async () => {
    const store = phone();
    await store.getState().pair();
    lanUp = false;
    await store.getState().reconnect();
    expect(store.getState().transport).toBe('relay');
    const route = saved().relay;
    expect(relay.deviceOpen(route!.routeToken)).toBe(true);
    // LAN 恢复：下一次重连先试 LAN，成功即撤 relay——同一时刻只有一条活通道。
    lanUp = true;
    await store.getState().reconnect();
    expect(store.getState()).toMatchObject({ status: 'connected', transport: 'lan' });
    expect(relay.deviceOpen(route!.routeToken)).toBe(false);
    await store.getState().send('after-lan-recovery-正文');
    expect(executions).toBe(1);
    store.getState().pause();
  });

  it('classifies a wrong relay credential as rejected and a dead relay as unavailable', async () => {
    const store = phone();
    await store.getState().pair();
    const deviceId = store.getState().binding!.deviceId;
    store.getState().pause();
    // 凭据错：relay 可达（upgrade 完成）但 auth 闸立刻关——不是「连不上中继」。
    const badCred = JSON.parse(storage!) as { relay?: { credential: string } };
    badCred.relay!.credential = 'wrong-credential-value';
    storage = JSON.stringify(badCred);
    lanUp = false;
    const rejected = phone();
    await rejected.getState().hydrate();
    expect(rejected.getState()).toMatchObject({ status: 'offline', connectionError: 'connectionRelayRejected' });
    // relay 不可达：直连失败 + 中继端口没人听。
    const deadRelay = JSON.parse(storage!) as { relay?: { url: string } };
    deadRelay.relay!.url = 'ws://127.0.0.1:1';
    storage = JSON.stringify(deadRelay);
    const unreachable = phone();
    await unreachable.getState().hydrate();
    expect(unreachable.getState()).toMatchObject({ status: 'offline', connectionError: 'connectionRelayUnavailable' });
    expect(deviceId).toBeTruthy();
  });

  it('refreshes a stale route token over LAN (host restart heals while LAN is up)', async () => {
    const store = phone();
    await store.getState().pair();
    const deviceId = store.getState().binding!.deviceId;
    const before = saved().relay?.routeToken;
    // Host 进程重启 = 新 relay 客户端 + 新铸造的 routeToken（routes 不落盘，这是已知边界）。
    await hostRelay.stop();
    hostRelay = new CompanionRelayClient({
      gateway,
      identity: hostIdentity,
      config: { url: relay.url, credentialRef: 'companion-relay', reconnectBackoffMs: [30, 60, 120] },
      credential: SECRET,
      jitter: () => 0.5,
    });
    await hostRelay.start();
    await store.getState().reconnect();
    const after = saved().relay?.routeToken;
    expect(after).toBeTruthy();
    expect(after).not.toBe(before);
    expect(after).toBe(hostRelay.routeTokenFor(deviceId));
    store.getState().pause();
  });

  it('a revoked phone degrades to offline over the relay instead of hanging on it', async () => {
    const store = phone();
    await store.getState().pair();
    lanUp = false;
    await store.getState().reconnect();
    expect(store.getState().transport).toBe('relay');
    await store.getState().send('before-revoke-正文');
    expect(executions).toBe(1);
    gateway.revokeDevice(store.getState().binding!.deviceId);
    hostRelay.revoke(store.getState().binding!.deviceId);
    // relay 断路之后：下一次请求失败落 offline（revoke 帧不转发给 device——fake 与生产
    // relay 都是断路语义）。真机上有 1 秒 sync 轮询当这个「下一次」，测试里由 send 来戳。
    await expect(store.getState().send('after-revoke-正文')).resolves.toBeUndefined();
    // 命令已进待确认槽（重连后照常结算）——pending 留 true 是设计，不是卡死；
    // 关键是它没有被执行、状态落 offline 而不是挂死。
    expect(store.getState()).toMatchObject({ status: 'offline', pending: true });
    expect(executions).toBe(1);
    store.getState().pause();
  });

  it('a host without relay wiring answers unavailable: no route cached, session untouched', async () => {
    // 部署形态：当前分支代码但没配 relay（relayRoute 回调缺席）⇒ {kind:'unavailable'}，
    // 不关 channel。手机不缓存路由，会话照常——relay 回落对这个 Host 就是不可用，不假死。
    legacyServer = new LanCompanionServer(gateway, hostIdentity, Date.now);
    await legacyServer.start(address, 0);
    const store = phone(legacyServer);
    await store.getState().pair();
    expect(store.getState()).toMatchObject({ status: 'connected', transport: 'lan' });
    expect(saved().relay).toBeUndefined();
    await store.getState().sync();
    expect(store.getState()).toMatchObject({ status: 'connected' });
    await store.getState().send('no-relay-host-正文');
    expect(store.getState()).toMatchObject({ status: 'connected', pending: false });
    expect(executions).toBe(1);
    store.getState().pause();
  });

  it('survives a legacy host that closes the channel on relay.route: the probe dies, not the session (真机首验回归 2026-09-15)', async () => {
    // 首验现场：部署 bundle 早于 e0d38280b，exchange 没有 relay.route 分支——未知动作的
    // 处置是 403 + 关 channel。在传输层精确复刻那一发：配对后的第一个 exchange（= 路由
    // 探针的那发）按旧 Host 语义回 403。修复前这一问在会话通道上发出，配对后首次 sync 即
    // 403 掉线报「电脑没回应」，重连再陪葬，死循环；修复后死的只是探针。
    let probeKilled = false;
    const legacyPost = async (url: string, body: unknown) => {
      const res = await fetch(url, { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const raw = await res.text();
      if (!res.ok) throw new Error(`HTTP_${res.status}`);
      if (url.endsWith('/exchange') && !probeKilled) { probeKilled = true; throw new Error('HTTP_403'); }
      return JSON.parse(raw) as unknown;
    };
    let storage: string | null = null;
    const store = createCompanionStore({
      read: async () => storage,
      write: async value => { storage = value; },
      scan: async () => JSON.stringify(lanServer.invite(['shared'])),
      post: legacyPost,
      dialRelay: nodeDial,
    }, () => {});
    await store.getState().pair();
    expect(store.getState()).toMatchObject({ status: 'connected', transport: 'lan' });
    expect(probeKilled).toBe(true); // 探针那一发确实挨了旧 Host 的 403
    expect(JSON.parse(storage ?? '{}').relay).toBeUndefined();
    // 会话通道必须活着：sync 与命令照常（修复前这里正是掉线点）。
    await store.getState().sync();
    expect(store.getState()).toMatchObject({ status: 'connected' });
    await store.getState().send('legacy-host-正文');
    expect(store.getState()).toMatchObject({ status: 'connected', pending: false });
    expect(executions).toBe(1);
    store.getState().pause();
  });
});
