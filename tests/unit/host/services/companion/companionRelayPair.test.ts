import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import type WebSocket from 'ws';
import { CompanionGateway } from '../../../../../src/host/services/companion/CompanionGateway';
import { CompanionRelayClient, type CompanionRelayPairRequest } from '../../../../../src/host/services/companion/CompanionRelayClient';
import { createIdentity } from '../../../../../src/shared/companion/noiseChannel';
import { createRelayPairHandshake, deriveRelayPairVerify } from '../../../../../src/shared/companion/relayPair';
import { NoiseChannel } from '../../../../../src/shared/companion/noiseChannel';
import { fromHex, toHex } from '../../../../../src/shared/companion/lanProtocol';
import { COMPANION_LIMITS as L } from '../../../../../src/shared/constants/companion';
import { parseCompanionRelayFrame, type CompanionRelayFrame } from '../../../../../src/shared/contract/companionRelay';

/**
 * Host 侧 relay 找回配对（N-COMPANION-RELAY-ACCOUNT-RECOVER）：register 自报 hostName/指纹、
 * pair-request 起 XX responder 挂起、**同意守卫**（不点同意绝不登记设备；纯 XX 的手机静态公钥
 * 在第三条消息才交给 Host，登记与载荷同拍落定）、同意/拒绝/超时三态、载荷与手机发起端真实互解。
 */

class FakeWebSocket extends EventEmitter {
  static last: FakeWebSocket | null = null;
  readonly sent: string[] = [];
  readyState = 0;
  constructor(_url: string, _options?: unknown) {
    super();
    FakeWebSocket.last = this;
  }
  send(data: string): void { this.sent.push(data); }
  /** 自动回 pong：模拟活着的 relay 链路——探活看门狗（30s 一拍）不该在本测里拆连接。 */
  ping(): void { this.emit('pong'); }
  close(): void { this.readyState = 3; this.emit('close', 1000, Buffer.alloc(0)); }
  terminate(): void { this.readyState = 3; this.emit('close', 1006, Buffer.alloc(0)); }
  /** 注入一条「relay 转发来的」帧。 */
  deliver(frame: CompanionRelayFrame): void { this.emit('message', JSON.stringify(frame)); }
  frames(): CompanionRelayFrame[] { return this.sent.map(raw => parseCompanionRelayFrame(JSON.parse(raw) as unknown)); }
  lastOf(kind: CompanionRelayFrame['kind']): CompanionRelayFrame | undefined {
    return [...this.frames()].reverse().find(frame => frame.kind === kind);
  }
}

const ROUTE = 'route-token-aaaaaa';
const SCOPE = ['project:main', 'shared-session'];

function pairEnvelope() {
  return { routeToken: 'neo-relay-pair-request', deviceRef: 'relay', seq: 0, ttlMs: L.relayRouteTokenTtlMs, issuedAt: Date.now() };
}

describe('companion relay client：找回配对（同意守卫 + XX 三消息）', () => {
  let db: Database.Database;
  let gateway: CompanionGateway;
  const hostIdentity = createIdentity();
  const phoneIdentity = createIdentity();
  let pairRequests: CompanionRelayPairRequest[] = [];
  let settled: string[] = [];
  let socket: FakeWebSocket;
  let client: CompanionRelayClient;

  beforeEach(() => {
    vi.useFakeTimers();
    db = new Database(':memory:');
    gateway = new CompanionGateway(db, {});
    pairRequests = [];
    settled = [];
    FakeWebSocket.last = null;
    client = new CompanionRelayClient({
      gateway,
      identity: hostIdentity,
      config: { url: 'ws://relay.test', credentialRef: 'companion-relay', reconnectBackoffMs: [50, 50, 50] },
      credential: 'shared-secret',
      hostName: "Lin's MacBook Pro",
      onPairRequest: request => { pairRequests.push(request); },
      onPairSettled: requestId => { settled.push(requestId); },
      pairScope: () => SCOPE,
      pairLegacyRoute: deviceId => ({ v: 1, url: 'wss://relay.example.invalid/companion', routeToken: `legacy-${deviceId}`, credential: 'shared-secret' }),
      pairLanAdvertisement: () => ({ endpoint: 'http://192.168.1.4:8182', altEndpoint: 'http://mac.local:8182', candidates: ['http://192.168.1.4:8182'] }),
      hostAccountEmail: () => 'lin@example.com',
      now: () => Date.now(),
      jitter: () => 0.5,
      WebSocket: FakeWebSocket as unknown as typeof WebSocket,
      logger: { warn: () => {}, info: () => {} },
    });
    client.advertise({ deviceRef: 'phone-old', routeToken: ROUTE });
    void client.start();
    socket = FakeWebSocket.last!;
    socket.readyState = 1;
    socket.emit('open');
    void vi.advanceTimersByTime(L.relayStableConnectionMs);
  });

  afterEach(async () => {
    await client.stop();
    db.close();
    vi.useRealTimers();
  });

  /** 手机发起端跑完第一条消息并投递 pair-request。 */
  function sendInitialPairRequest(): { requestId: string; initiator: ReturnType<typeof createRelayPairHandshake>; expectedCode: string } {
    const initiator = createRelayPairHandshake(true, phoneIdentity);
    const msg1 = toHex(initiator.send());
    const expectedCode = deriveRelayPairVerify(initiator.e!.publicKey);
    const requestId = `req-${Math.random().toString(36).slice(2, 12)}${Date.now()}`;
    socket.deliver({
      v: 1, kind: 'pair-request', requestId, instanceId: 'instance-id-1234567890',
      envelope: pairEnvelope(), ciphertext: msg1,
    });
    return { requestId, initiator, expectedCode };
  }

  it('register 自报 hostName 与主机公钥指纹（sha256 hex）', () => {
    const register = socket.frames().find(frame => frame.kind === 'register');
    expect(register).toBeDefined();
    expect(register).toMatchObject({
      kind: 'register', role: 'host',
      hostName: "Lin's MacBook Pro",
      hostKeyFingerprint: createHash('sha256').update(Buffer.from(hostIdentity.publicKey)).digest('hex'),
    });
  });

  it('pair-request 到达 ⇒ 桌面卡片拿到握手材料派生的 4 位码；同意之前不登记设备（同意守卫）', () => {
    const { expectedCode } = sendInitialPairRequest();
    expect(pairRequests).toHaveLength(1);
    expect(pairRequests[0].code).toBe(expectedCode);
    expect(pairRequests[0].code).toMatch(/^\d{4}$/);
    expect(gateway.pairedDevices()).toHaveLength(0);
    // 没点同意就把「续帧」怼过来（真发起端拿不到 msg2，只能伪造乱码）：不登记、不下发载荷。
    socket.deliver({ v: 1, kind: 'pair-request', requestId: pairRequests[0].requestId, envelope: pairEnvelope(), ciphertext: 'ab'.repeat(48) });
    expect(gateway.pairedDevices()).toHaveLength(0);
    expect(socket.lastOf('pair-result')).toBeUndefined();
  });

  it('同意 ⇒ 回 XX 第二条消息；续帧落地 ⇒ 登记设备并下发加密配对载荷（手机发起端可解）', () => {
    const { requestId, initiator } = sendInitialPairRequest();
    expect(client.respondPair(requestId, true)).toBe(true);
    const reply = socket.lastOf('pair-result');
    expect(reply).toMatchObject({ kind: 'pair-result', requestId, accepted: true, stage: 'reply' });
    expect(initiator.recv(fromHex((reply as Extract<CompanionRelayFrame, { kind: 'pair-result' }>).ciphertext)).length).toBe(0);
    // 手机身份核对：发起端此刻认得的 Host 静态公钥
    expect(toHex(initiator.rs!)).toBe(toHex(hostIdentity.publicKey));
    socket.deliver({ v: 1, kind: 'pair-request', requestId, envelope: pairEnvelope(), ciphertext: toHex(initiator.send()) });
    const devices = gateway.pairedDevices();
    expect(devices).toHaveLength(1);
    expect(devices[0].scope).toEqual(SCOPE);
    const complete = socket.lastOf('pair-result');
    expect(complete).toMatchObject({ kind: 'pair-result', requestId, accepted: true, stage: 'complete' });
    const channel = new NoiseChannel(initiator);
    const payload = channel.open(JSON.parse((complete as Extract<CompanionRelayFrame, { kind: 'pair-result' }>).ciphertext) as unknown) as Record<string, unknown>;
    expect(payload.deviceId).toBe(devices[0].deviceId);
    expect(payload.scopeEpoch).toBe(devices[0].scopeEpoch);
    expect(payload.hostAccountEmail).toBe('lin@example.com');
    expect(payload.lan).toMatchObject({ endpoint: 'http://192.168.1.4:8182', altEndpoint: 'http://mac.local:8182' });
    expect(payload.routes).toMatchObject({
      v: 1,
      account: { url: 'ws://relay.test', routeToken: expect.any(String) },
      legacy: { url: 'wss://relay.example.invalid/companion', routeToken: `legacy-${devices[0].deviceId}`, credential: 'shared-secret' },
    });
    expect(settled).toContain(requestId);
  });

  it('拒绝 ⇒ pair-result 具名 declined，销账后再表态回 false', () => {
    const { requestId } = sendInitialPairRequest();
    expect(client.respondPair(requestId, false)).toBe(true);
    expect(socket.lastOf('pair-result')).toMatchObject({ kind: 'pair-result', requestId, accepted: false, reason: 'declined' });
    expect(settled).toContain(requestId);
    expect(client.respondPair(requestId, true)).toBe(false);
    // 拒绝后续帧不再受理（挂起态已清）：伪造乱码续帧也不登记。
    socket.deliver({ v: 1, kind: 'pair-request', requestId, envelope: pairEnvelope(), ciphertext: 'ab'.repeat(48) });
    expect(gateway.pairedDevices()).toHaveLength(0);
  });

  it('卡片超时 ⇒ Host 侧挂起自清并回具名 timeout（同意守卫：从头到尾没登记过设备）', () => {
    const { requestId } = sendInitialPairRequest();
    void vi.advanceTimersByTime(L.relayPairTtlMs);
    expect(socket.lastOf('pair-result')).toMatchObject({ kind: 'pair-result', requestId, accepted: false, reason: 'timeout' });
    expect(settled).toContain(requestId);
    expect(gateway.pairedDevices()).toHaveLength(0);
    expect(client.respondPair(requestId, true)).toBe(false);
  });

  it('伪造信封（非 sentinel routeToken）的 pair-request 不进配对路径', () => {
    const initiator = createRelayPairHandshake(true, phoneIdentity);
    const msg1 = toHex(initiator.send());
    socket.deliver({
      v: 1, kind: 'pair-request', requestId: 'req-foreign-envelopex', instanceId: 'instance-id-1234567890',
      envelope: { routeToken: ROUTE, deviceRef: 'phone-old', seq: 0, ttlMs: L.relayRouteTokenTtlMs, issuedAt: Date.now() },
      ciphertext: msg1,
    });
    expect(pairRequests).toHaveLength(0);
    expect(gateway.pairedDevices()).toHaveLength(0);
  });
});
