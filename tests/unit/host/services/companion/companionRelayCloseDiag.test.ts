import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type WebSocket from 'ws';
import { CompanionRelayClient } from '../../../../../src/host/services/companion/CompanionRelayClient';
import { createHandshake, createIdentity } from '../../../../../src/shared/companion/noiseChannel';
import { toHex } from '../../../../../src/shared/companion/lanProtocol';
import { COMPANION_LIMITS as L } from '../../../../../src/shared/constants/companion';
import type { CompanionGateway } from '../../../../../src/host/services/companion/CompanionGateway';

/**
 * 中继断开留痕（N-COMPANION-RELAY-CLOSE-DIAG）：已连上的 socket 被关时，1005（对端无状态码的
 * 关闭帧）、1006（无关闭帧、TCP 层断）与带明确码的关闭各自产出可区分的 dial code；原始 close
 * code、reason、实测存活时长进 disconnected 日志行。1005 的生产形状要求撑过稳定期（5s），
 * 真实等待太慢，用注入的 FakeWebSocket + fake timers 精确驱动。
 */

class FakeWebSocket extends EventEmitter {
  static last: FakeWebSocket | null = null;
  readyState = 0;
  constructor(_url: string, _options?: unknown) {
    super();
    FakeWebSocket.last = this;
  }
  send(): void { /* 心跳/注册帧不需要真回包 */ }
  close(): void {
    this.readyState = 3;
    this.emit('close', 1000, Buffer.alloc(0));
  }
  terminate(): void { this.readyState = 3; }
}

const gateway = { pairedDevices: () => [] } as unknown as CompanionGateway;

describe('companion relay disconnected diagnostics', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeWebSocket.last = null;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function startAndStabilize(clock: { now: number }): { client: CompanionRelayClient; socket: FakeWebSocket; warn: string[] } {
    const warn: string[] = [];
    const client = new CompanionRelayClient({
      gateway,
      identity: createIdentity(),
      config: { url: 'ws://relay.test', credentialRef: 'companion-relay', reconnectBackoffMs: [50, 50, 50] },
      credential: 'shared-secret',
      now: () => clock.now,
      jitter: () => 0.5,
      WebSocket: FakeWebSocket as unknown as typeof WebSocket,
      logger: { warn: message => warn.push(message), info: () => {} },
    });
    void client.start();
    const socket = FakeWebSocket.last;
    if (!socket) throw new Error('fake socket not constructed');
    socket.readyState = 1;
    socket.emit('open');
    // 撑过稳定期（relayStableConnectionMs=5s），close 才会走 disconnected 分支而不是 CLOSED_AFTER_OPEN
    clock.now += L.relayStableConnectionMs;
    void vi.advanceTimersByTime(L.relayStableConnectionMs);
    clock.now += 2_000;
    void vi.advanceTimersByTime(2_000);
    return { client, socket, warn };
  }

  it.each([
    { code: 1005, reason: Buffer.alloc(0), reasonText: '""', line: 'close 1005' },
    { code: 1006, reason: Buffer.alloc(0), reasonText: '""', line: 'close 1006' },
  ] as const)('reports $code as a distinguishable code, not the fallback', async ({ code, reason, reasonText, line }) => {
    const clock = { now: 0 };
    const { client, socket, warn } = startAndStabilize(clock);
    socket.emit('close', code, reason);
    expect(warn).toEqual([
      `Companion relay disconnected: ${line}; closeCode=${code} reason=${reasonText} uptimeMs=7000; reconnect in 50ms`,
    ]);
    expect(warn.join('\n')).not.toContain('COMPANION_RELAY_CONNECT_FAILED');
    await client.stop();
  });

  it('keeps an explicit close code distinct and surfaces a non-empty close reason in the log', async () => {
    const clock = { now: 0 };
    const { client, socket, warn } = startAndStabilize(clock);
    socket.emit('close', 1011, Buffer.from('relay internal error', 'utf8'));
    expect(warn).toEqual([
      'Companion relay disconnected: close 1011; closeCode=1011 reason="relay internal error" uptimeMs=7000; reconnect in 50ms',
    ]);
    expect(warn.join('\n')).not.toContain('COMPANION_RELAY_CONNECT_FAILED');
    await client.stop();
  });
});

/**
 * 中继重连丢会话留痕（N-COMPANION-RELAY-RECONNECT-DROPSESSIONS）：close/open 都会把 Noise
 * 会话全清，重连后手机若还握着旧实例的会话密钥，forward 到了 Host 只能被吞——无会话分支
 * 必须 warn 一行（deviceRef 只给前缀），清会话本身要 info 记条数（stop 关停除外）。
 */
describe('companion relay reconnect session diagnostics', () => {
  const DEVICE_REF = 'device-ref-12345678';
  const TOKEN = 'route-token-aaaaaa';

  beforeEach(() => {
    vi.useFakeTimers();
    FakeWebSocket.last = null;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function buildClient(gateway: CompanionGateway) {
    const clock = { now: 0 };
    const warn: string[] = [];
    const info: string[] = [];
    const identity = createIdentity();
    const client = new CompanionRelayClient({
      gateway,
      identity,
      config: { url: 'ws://relay.test', credentialRef: 'companion-relay', reconnectBackoffMs: [50, 50, 50] },
      credential: 'shared-secret',
      now: () => clock.now,
      jitter: () => 0.5,
      WebSocket: FakeWebSocket as unknown as typeof WebSocket,
      logger: { warn: message => warn.push(message), info: message => info.push(message) },
    });
    // open 时还有一条 connected 行属于既有留痕，这里只断言本单新增的 sessions dropped 行。
    const drops = () => info.filter(line => line.includes('sessions dropped'));
    return { client, identity, clock, warn, drops };
  }

  function openFreshSocket(): FakeWebSocket {
    const socket = FakeWebSocket.last;
    if (!socket) throw new Error('fake socket not constructed');
    socket.readyState = 1;
    socket.emit('open');
    return socket;
  }

  /** 手机侧 IK 握手帧打进 client：会话表里落一条 DEVICE_REF 会话（Host 身份即 client 的 identity）。 */
  function performHandshake(hostKey: string, clock: { now: number }, socket: FakeWebSocket): void {
    const noise = createHandshake(true, createIdentity(), undefined, undefined, hostKey);
    socket.emit('message', JSON.stringify({
      v: 1, kind: 'handshake',
      envelope: { routeToken: TOKEN, deviceRef: DEVICE_REF, seq: 0, ttlMs: L.relayRouteTokenTtlMs, issuedAt: clock.now },
      ciphertext: toHex(noise.send()),
    }));
  }

  it('warns instead of silently swallowing a forward that has no session for the device', async () => {
    const gateway = { pairedDevices: () => [], identityDevice: () => null } as unknown as CompanionGateway;
    const { client, clock, warn } = buildClient(gateway);
    client.advertise({ deviceRef: DEVICE_REF, routeToken: TOKEN });
    void client.start();
    const socket = openFreshSocket();
    clock.now = 10_000;
    // 手机还握着旧实例的会话密钥发来的 forward：本连接会话表已清，只能落 warn（deviceRef 前缀）。
    socket.emit('message', JSON.stringify({
      v: 1, kind: 'forward',
      envelope: { routeToken: TOKEN, deviceRef: DEVICE_REF, seq: 0, ttlMs: L.relayRouteTokenTtlMs, issuedAt: clock.now },
      ciphertext: 'stale-session-payload',
    }));
    expect(warn.join('\n')).toContain(`forward dropped: no session for deviceRef ${DEVICE_REF.slice(0, 8)}`);
    expect(warn.join('\n')).not.toContain(DEVICE_REF);
    await client.stop();
  });

  it('info-logs how many sessions drop on disconnect and reconnect, and stays quiet on stop', async () => {
    const gateway = { pairedDevices: () => [], identityDevice: () => ({ deviceId: DEVICE_REF }) } as unknown as CompanionGateway;
    const { client, identity, clock, drops } = buildClient(gateway);
    const hostKey = toHex(identity.publicKey);
    client.advertise({ deviceRef: DEVICE_REF, routeToken: TOKEN });
    void client.start();
    const socket1 = openFreshSocket();
    clock.now = 10_000; // issuedAt 契约是正整数，时钟从 0 起会把握手帧当非法帧丢掉
    performHandshake(hostKey, clock, socket1);
    expect(drops()).toEqual([]); // 建会话本身不打扰日志
    socket1.emit('close', 1006, Buffer.alloc(0));
    expect(drops()).toEqual(['Companion relay sessions dropped on disconnect: 1']);
    // 断线重连（退避 50ms）拨出新 socket：会话已在 close 清空，open 不再记。
    clock.now += 50;
    void vi.advanceTimersByTime(50);
    const socket2 = openFreshSocket();
    expect(drops()).toEqual(['Companion relay sessions dropped on disconnect: 1']);
    // 上一条连接还带着会话时又拨出新连接（open 路径清残留）：open 也要记清了几条。
    performHandshake(hostKey, clock, socket2);
    void client.start();
    const socket3 = openFreshSocket();
    expect(socket3).not.toBe(socket2);
    expect(drops()).toEqual([
      'Companion relay sessions dropped on disconnect: 1',
      'Companion relay sessions dropped on reconnect: 1',
    ]);
    // stop 关停是主动行为，清空也不记。
    await client.stop();
    expect(drops()).toEqual([
      'Companion relay sessions dropped on disconnect: 1',
      'Companion relay sessions dropped on reconnect: 1',
    ]);
  });
});
