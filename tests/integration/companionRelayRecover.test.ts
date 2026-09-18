import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { createServer } from 'node:http';
import WebSocket from 'ws';
import { CompanionGateway } from '../../src/host/services/companion/CompanionGateway';
import { CompanionRelayClient, type CompanionRelayPairRequest } from '../../src/host/services/companion/CompanionRelayClient';
import { createIdentity } from '../../src/shared/companion/noiseChannel';
import { createRelayPairHandshake, deriveRelayPairVerify } from '../../src/shared/companion/relayPair';
import { NoiseChannel } from '../../src/shared/companion/noiseChannel';
import { fromHex, toHex } from '../../src/shared/companion/lanProtocol';
import { COMPANION_LIMITS as L } from '../../src/shared/constants/companion';
import { CompanionRelayServer } from '../../packages/relay/src/server';
import { SupabaseJwtVerifier } from '../../packages/relay/src/accountAuth';
import {
  parseCompanionRelayFrame,
  parseCompanionRelayHostList,
  type CompanionRelayFrame,
} from '../../src/shared/contract/companionRelay';

/**
 * relay 找回（N-COMPANION-RELAY-ACCOUNT-RECOVER）在真 CompanionRelayServer 上的行为：
 * list-hosts 的账号主人限定与按实例去重、pair-request 的限流/目标不在秒级失败/挂起超时代答、
 * 全链路配对（手机发起端 ↔ 账号通道 Host ↔ relay）互解。只脚本化 Supabase JWKS 端点。
 */

const SECRET = 'test-relay-credential';
const SUPABASE = 'https://proj.supabase.co';
const SUB = 'user-1';
const PAIR_TTL_MS = 400;
const MIN_INTERVAL_MS = 5_000;

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

function accessToken(sub = SUB, key: { kid: string; privateKey: KeyObject } = signingKey): string {
  const enc = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const head = enc({ alg: 'ES256', typ: 'JWT', kid: key.kid });
  const body = enc({ iss: `${SUPABASE}/auth/v1`, aud: 'authenticated', role: 'authenticated', sub, exp: Math.floor(Date.now() / 1000) + 3600 });
  return `${head}.${body}.${sign('sha256', Buffer.from(`${head}.${body}`), { key: key.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
}

const jwksFetch = (async () => new Response(JSON.stringify({ keys: [signingKey.jwk] }), { status: 200 })) as typeof fetch;

/** 脚本化的账号侧 WS：收帧按 kind 等待，发帧带 sentinel 信封。 */
class ScriptSocket {
  private socket: WebSocket | null = null;
  private readonly waiters: Array<{ test: (frame: CompanionRelayFrame) => boolean; resolve: (frame: CompanionRelayFrame) => void }> = [];
  readonly sent: string[] = [];
  static connect(url: string, credential: string): Promise<ScriptSocket> {
    return new Promise((resolve, reject) => {
      const self = new ScriptSocket();
      self.socket = new WebSocket(url, { headers: { authorization: `Bearer ${credential}` } });
      self.socket.once('open', () => resolve(self));
      self.socket.once('error', () => reject(new Error('connect failed')));
      self.socket.on('message', data => {
        try {
          const frame = parseCompanionRelayFrame(JSON.parse(String(data)) as unknown);
          const index = self.waiters.findIndex(waiter => waiter.test(frame));
          if (index >= 0) self.waiters.splice(index, 1)[0].resolve(frame);
        } catch { /* 非法帧：relay 侧已计账，这里不关心 */ }
      });
    });
  }
  send(frame: Record<string, unknown>): void {
    this.socket?.send(JSON.stringify(frame));
    this.sent.push(JSON.stringify(frame));
  }
  wait(test: (frame: CompanionRelayFrame) => boolean, timeoutMs = 2_000): Promise<CompanionRelayFrame> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('wait timeout')), timeoutMs);
      this.waiters.push({ test, resolve: frame => { clearTimeout(timer); resolve(frame); } });
    });
  }
  close(): void { this.socket?.close(); }
}

function listHostsEnvelope() {
  return { routeToken: 'neo-relay-list-hosts', deviceRef: 'relay', seq: 0, ttlMs: L.relayRouteTokenTtlMs, issuedAt: Date.now() };
}

function pairEnvelope() {
  return { routeToken: 'neo-relay-pair-request', deviceRef: 'relay', seq: 0, ttlMs: L.relayRouteTokenTtlMs, issuedAt: Date.now() };
}

describe('companion relay：找回（list-hosts / pair-request / pair-result）', () => {
  let db: Database.Database;
  let gateway: CompanionGateway;
  let relay: CompanionRelayServer;
  let host: CompanionRelayClient;
  let url: string;
  let token: string;
  const hostIdentity = createIdentity();
  const phoneIdentity = createIdentity();
  let pairRequests: CompanionRelayPairRequest[] = [];

  beforeEach(async () => {
    db = new Database(':memory:');
    gateway = new CompanionGateway(db, {});
    // 已有两台设备在册：账号通道据此各注册一条路由（同一 Host 实例）——list-hosts 按实例去重的素材。
    gateway.pairIdentity(toHex(createIdentity().publicKey), ['shared']);
    gateway.pairIdentity(toHex(createIdentity().publicKey), ['shared-2']);
    token = accessToken();
    const verifier = new SupabaseJwtVerifier({ supabaseUrl: SUPABASE, fetch: jwksFetch });
    verifier.start();
    await verifier.refresh();
    const port = await freePort();
    relay = new CompanionRelayServer({
      credential: SECRET, port, accountVerifier: verifier,
      pairTtlMs: PAIR_TTL_MS, pairRequestMinIntervalMs: MIN_INTERVAL_MS,
    });
    const address = await relay.listen();
    url = `ws://127.0.0.1:${address.port}`;
    pairRequests = [];
    host = new CompanionRelayClient({
      gateway,
      identity: hostIdentity,
      config: { url, credentialRef: 'companion-relay', reconnectBackoffMs: [30, 60, 120] },
      credential: () => Promise.resolve(token),
      namespace: `acct:${SUB}`,
      hostName: "Lin's MacBook Pro",
      onPairRequest: request => { pairRequests.push(request); },
      pairScope: () => ['project:main'],
      pairLegacyRoute: () => null,
      pairLanAdvertisement: () => null,
      hostAccountEmail: () => 'lin@example.com',
      jitter: () => 0.5,
    });
    await host.start();
    await host.whenConnected();
  });

  afterEach(async () => {
    await host?.stop();
    await relay?.stop();
    db?.close();
  });

  /** 从 relay 健康面拿不到路由内景：直接以账号连接 list-hosts 拿 instanceId（首测也用它验证列表）。 */
  async function acctListHosts(socket: ScriptSocket): Promise<ReturnType<typeof parseCompanionRelayHostList>> {
    socket.send({ v: 1, kind: 'list-hosts', envelope: listHostsEnvelope(), ciphertext: '' });
    const reply = await socket.wait(frame => frame.kind === 'list-hosts');
    return parseCompanionRelayHostList(JSON.parse((reply as Extract<CompanionRelayFrame, { kind: 'list-hosts' }>).ciphertext) as unknown);
  }

  it('① list-hosts：acct 主人可见自报名/指纹/实例且按实例去重；legacy 连接发起被拒并记账', async () => {
    const socket = await ScriptSocket.connect(url, token);
    const hosts = await acctListHosts(socket);
    expect(hosts).toHaveLength(1);
    expect(hosts[0].name).toBe("Lin's MacBook Pro");
    expect(hosts[0].fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(relay.currentStats.listHosts).toBe(1);

    // legacy（共享凭据）连接发起 list-hosts：没有「我的电脑」可言——拒、不回帧、记 stats。
    const legacy = await ScriptSocket.connect(url, SECRET);
    const rejectedListHosts = relay.currentStats.rejectedListHosts;
    legacy.send({ v: 1, kind: 'list-hosts', envelope: listHostsEnvelope(), ciphertext: '' });
    await new Promise(resolve => setTimeout(resolve, 150));
    await expect(legacy.wait(frame => frame.kind === 'list-hosts', 300)).rejects.toThrow('wait timeout');
    expect(relay.currentStats.rejectedListHosts).toBe(rejectedListHosts + 1);
    legacy.close();
    socket.close();
  });

  it('② pair-request 目标不在 ⇒ 秒级具名 host-offline（照 no-host 哲学）', async () => {
    const socket = await ScriptSocket.connect(url, token);
    const startedAt = Date.now();
    socket.send({
      v: 1, kind: 'pair-request', requestId: 'request-id-nonexistent1', instanceId: 'instance-id-not-there0',
      envelope: pairEnvelope(), ciphertext: 'ab'.repeat(96),
    });
    const reply = await socket.wait(frame => frame.kind === 'pair-result');
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(reply).toMatchObject({ kind: 'pair-result', requestId: 'request-id-nonexistent1', accepted: false, reason: 'host-offline' });
    // 合成回帧计数口径统一（R3 Nit1）：初次请求路径的 host-offline 也进 pairResults。
    expect(relay.currentStats.pairResults).toBe(1);
    socket.close();
  });

  it('② 拒单也计频（R2 Nit5）：指向不存在 instanceId 的 pair-request 挨个被拒，短窗内第二个 ⇒ rate-limited', async () => {
    const socket = await ScriptSocket.connect(url, token);
    socket.send({
      v: 1, kind: 'pair-request', requestId: 'request-id-ghosthost01', instanceId: 'instance-id-not-there0',
      envelope: pairEnvelope(), ciphertext: 'ab'.repeat(96),
    });
    const first = await socket.wait(frame => frame.kind === 'pair-result' && frame.requestId === 'request-id-ghosthost01');
    expect(first).toMatchObject({ accepted: false, reason: 'host-offline' });
    // 同一短窗内再来（探测/轰炸节奏）：拒单同样占频次——不能免限流地反复打不存在的 instanceId。
    socket.send({
      v: 1, kind: 'pair-request', requestId: 'request-id-ghosthost02', instanceId: 'instance-id-not-there0',
      envelope: pairEnvelope(), ciphertext: 'ab'.repeat(96),
    });
    const second = await socket.wait(frame => frame.kind === 'pair-result' && frame.requestId === 'request-id-ghosthost02');
    expect(second).toMatchObject({ accepted: false, reason: 'rate-limited' });
    // 两条合成回帧（host-offline + rate-limited）都计数（R3 Nit1）。
    expect(relay.currentStats.pairResults).toBe(2);
    socket.close();
  });

  it('② 同一交换：未经电脑同意 ⇒ 设备不登记；同意后续帧落地才登记（全链路）', async () => {
    const socket = await ScriptSocket.connect(url, token);
    const hosts = await acctListHosts(socket);
    expect(hosts).toHaveLength(1);
    const target = hosts[0];
    const initiator = createRelayPairHandshake(true, phoneIdentity);
    const requestId = 'request-id-fullchain-1';
    socket.send({
      v: 1, kind: 'pair-request', requestId, instanceId: target.instanceId,
      envelope: pairEnvelope(), ciphertext: toHex(initiator.send()),
    });
    await vi.waitFor(() => expect(pairRequests).toHaveLength(1));
    expect(pairRequests[0].code).toBe(deriveRelayPairVerify(initiator.e!.publicKey));
    // 转发到了 Host：pairRequests 计数进 relay stats。
    expect(relay.currentStats.pairRequests).toBe(1);
    // 未同意：没有新设备。
    expect(gateway.pairedDevices()).toHaveLength(2);
    // 电脑同意 ⇒ pair-result(reply) 回到手机。
    expect(host.respondPair(pairRequests[0].requestId, true)).toBe(true);
    const reply = await socket.wait(frame => frame.kind === 'pair-result' && frame.requestId === requestId);
    expect(reply).toMatchObject({ accepted: true, stage: 'reply' });
    expect(initiator.recv(fromHex((reply as Extract<CompanionRelayFrame, { kind: 'pair-result' }>).ciphertext)).length).toBe(0);
    expect(toHex(initiator.rs!)).toBe(toHex(hostIdentity.publicKey));
    // 手机补完第三条消息 ⇒ Host 登记新设备并回 complete。
    socket.send({ v: 1, kind: 'pair-request', requestId, envelope: pairEnvelope(), ciphertext: toHex(initiator.send()) });
    const complete = await socket.wait(frame => frame.kind === 'pair-result' && frame.requestId === requestId && frame.stage === 'complete');
    const devices = gateway.pairedDevices();
    expect(devices).toHaveLength(3);
    const channel = new NoiseChannel(initiator);
    const payload = channel.open(JSON.parse((complete as Extract<CompanionRelayFrame, { kind: 'pair-result' }>).ciphertext) as unknown) as Record<string, unknown>;
    expect(payload.deviceId).toBe(devices[2].deviceId);
    expect(payload.routes).toMatchObject({ v: 1, account: { url } });
    socket.close();
  });

  it('④ 限流：每账号短窗内第二个初次 pair-request ⇒ 具名 rate-limited（防卡片轰炸电脑）', async () => {
    const socket = await ScriptSocket.connect(url, token);
    const hosts = await acctListHosts(socket);
    const initiator = createRelayPairHandshake(true, phoneIdentity);
    socket.send({
      v: 1, kind: 'pair-request', requestId: 'request-id-ratefirst-1', instanceId: hosts[0].instanceId,
      envelope: pairEnvelope(), ciphertext: toHex(initiator.send()),
    });
    await vi.waitFor(() => expect(relay.currentStats.pairRequests).toBe(1));
    const second = createRelayPairHandshake(true, phoneIdentity);
    socket.send({
      v: 1, kind: 'pair-request', requestId: 'request-id-ratesecond2', instanceId: hosts[0].instanceId,
      envelope: pairEnvelope(), ciphertext: toHex(second.send()),
    });
    const reply = await socket.wait(frame => frame.kind === 'pair-result' && frame.requestId === 'request-id-ratesecond2');
    expect(reply).toMatchObject({ accepted: false, reason: 'rate-limited' });
    expect(relay.currentStats.rejectedPairRequests).toBeGreaterThanOrEqual(1);
    socket.close();
  });

  it('④ 挂起超时：Host 不表态 ⇒ relay 到点替它回具名 timeout', async () => {
    const socket = await ScriptSocket.connect(url, token);
    const hosts = await acctListHosts(socket);
    const initiator = createRelayPairHandshake(true, phoneIdentity);
    socket.send({
      v: 1, kind: 'pair-request', requestId: 'request-id-pendingtime1', instanceId: hosts[0].instanceId,
      envelope: pairEnvelope(), ciphertext: toHex(initiator.send()),
    });
    await vi.waitFor(() => expect(relay.currentStats.pairRequests).toBe(1));
    const reply = await socket.wait(frame => frame.kind === 'pair-result' && frame.requestId === 'request-id-pendingtime1', PAIR_TTL_MS + 2_000);
    expect(reply).toMatchObject({ accepted: false, reason: 'timeout' });
    // 计数搬家后挂起超时路径不双计（R3 Nit1）：一条 timeout 回帧只进一次 pairResults。
    expect(relay.currentStats.pairResults).toBe(1);
    socket.close();
  });

  it('④ host 腿断开 ⇒ 挂起中的手机拿到具名 host-offline，不干等自己的握手超时', async () => {
    const socket = await ScriptSocket.connect(url, token);
    const hosts = await acctListHosts(socket);
    const initiator = createRelayPairHandshake(true, phoneIdentity);
    socket.send({
      v: 1, kind: 'pair-request', requestId: 'request-id-hostlegcut1', instanceId: hosts[0].instanceId,
      envelope: pairEnvelope(), ciphertext: toHex(initiator.send()),
    });
    await vi.waitFor(() => expect(relay.currentStats.pairRequests).toBe(1));
    await host.stop();
    const reply = await socket.wait(frame => frame.kind === 'pair-result' && frame.requestId === 'request-id-hostlegcut1');
    expect(reply).toMatchObject({ accepted: false, reason: 'host-offline' });
    // 断腿路径的合成回帧照旧只计一次（R3 Nit1）。
    expect(relay.currentStats.pairResults).toBe(1);
    socket.close();
  });

  // R3 Important：register 改写 route.hostInstanceId 时必须先把 token 从旧 account×instance 索引键
  // 摘除——否则桌面 Neo 每重启一次（instanceId 每进程重生）就多一个永不回收的键，relay 内存随
  // 重启次数单调涨，dropRoute 只按当前 instanceId 摘不到旧键。
  it('⑥ register 换实例重注册：旧索引键当场摘除，键数不随重启次数涨；unregister 摘除对称', async () => {
    // 事故形状：路由要活过 host 腿断开（设备腿还挂着）才会走到「改写 instanceId」——设备腿先占住路由。
    const deviceLeg = await ScriptSocket.connect(url, token);
    const leakToken = 'route-token-r3leak0001';
    deviceLeg.send({ v: 1, kind: 'register', role: 'device', envelope: { routeToken: leakToken, deviceRef: 'phone-1', seq: 0, ttlMs: L.relayRouteTokenTtlMs, issuedAt: Date.now() }, ciphertext: '' });
    await vi.waitFor(() => expect(relay.currentStats.routes).toBe(3));
    expect(relay.currentStats.instanceIndexKeys).toBe(1); // beforeEach 的 Host 一个实例
    const restarts = 4;
    for (let boot = 0; boot < restarts; boot += 1) {
      const hostLeg = await ScriptSocket.connect(url, token);
      hostLeg.send({
        v: 1, kind: 'register', role: 'host', instanceId: `instance-id-boot000${boot}`, hostName: 'Restart Mac',
        envelope: { routeToken: leakToken, deviceRef: 'phone-1', seq: 0, ttlMs: L.relayRouteTokenTtlMs, issuedAt: Date.now() },
        ciphertext: '',
      });
      await new Promise(resolve => setTimeout(resolve, 100)); // loopback 上 register 先落地
      hostLeg.close();
      await new Promise(resolve => setTimeout(resolve, 100)); // detach：设备腿在，路由存活、host 槽空
    }
    // 4 次「重启」后只多 1 个键（当前实例）；旧实现 = 1+4 个键随重启次数单调涨，只能重启 relay 释放。
    expect(relay.currentStats.routes).toBe(3);
    expect(relay.currentStats.instanceIndexKeys).toBe(2);
    // 摘除对称：unregister 走 dropRoute 按当前实例键摘，键数随路由一起回落。
    deviceLeg.send({ v: 1, kind: 'unregister', envelope: { routeToken: leakToken, deviceRef: 'phone-1', seq: 1, ttlMs: L.relayRouteTokenTtlMs, issuedAt: Date.now() }, ciphertext: '' });
    await vi.waitFor(() => expect(relay.currentStats.routes).toBe(2));
    expect(relay.currentStats.instanceIndexKeys).toBe(1);
    deviceLeg.close();
  });
});
