import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type WebSocket from 'ws';
import { CompanionRelayClient } from '../../../../../src/host/services/companion/CompanionRelayClient';
import { createIdentity } from '../../../../../src/shared/companion/noiseChannel';
import { COMPANION_LIMITS as L } from '../../../../../src/shared/constants/companion';
import type { CompanionGateway } from '../../../../../src/host/services/companion/CompanionGateway';

/**
 * 连接级 pong 看门狗（N-COMPANION-RELAY-KEEPALIVE）：Host 每 relayPingMs 发 WS 协议层 ping，
 * pong 清待答标记；下一周期标记还在就 terminate，走既有 close(1006) → scheduleReconnect——
 * 把「内核超时（relayIdleMs 量级）才发现死链路」压到一个 ping 周期。真实等待太慢，用注入的
 * FakeWebSocket + fake timers 精确驱动（照 companionRelayCloseDiag.test.ts 的写法）。
 */

class FakeWebSocket extends EventEmitter {
  static last: FakeWebSocket | null = null;
  pings = 0;
  terminated = 0;
  readyState = 0;
  constructor(_url: string, _options?: unknown) {
    super();
    FakeWebSocket.last = this;
  }
  send(): void { /* 心跳/注册帧不需要真回包 */ }
  ping(): void { this.pings += 1; }
  close(): void {
    this.readyState = 3;
    this.emit('close', 1000, Buffer.alloc(0));
  }
  terminate(): void {
    this.terminated += 1;
    this.readyState = 3;
    // ws 的 terminate 没有关闭帧握手，客户端看到的就是 1006
    this.emit('close', 1006, Buffer.alloc(0));
  }
}

const gateway = { pairedDevices: () => [] } as unknown as CompanionGateway;

describe('companion relay connection keepalive watchdog', () => {
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
    expect(socket.pings).toBe(0); // 探活按 relayPingMs 节拍来，不会一上来就发
    return { client, socket, warn };
  }

  it('terminates and reconnects within one probe cycle after the relay stops answering pongs', async () => {
    const clock = { now: 0 };
    const { client, socket, warn } = startAndStabilize(clock);
    // 第一个探活周期：发出 ping、标记待答；周期内不判死。
    clock.now += L.relayPingMs;
    void vi.advanceTimersByTime(L.relayPingMs);
    expect(socket.pings).toBe(1);
    expect(socket.terminated).toBe(0);
    // relay 回了 pong：待答标记清除，下一周期重新起算。
    socket.emit('pong');
    clock.now += L.relayPingMs;
    void vi.advanceTimersByTime(L.relayPingMs);
    expect(socket.pings).toBe(2);
    expect(socket.terminated).toBe(0);
    // 这次 relay 不回 pong（relay→Host 方向已死）：到下一个周期标记仍在 → terminate，
    // 走既有 close(1006) → disconnected 日志 → scheduleReconnect，不再等 relayIdleMs 量级。
    clock.now += L.relayPingMs;
    void vi.advanceTimersByTime(L.relayPingMs);
    expect(socket.terminated).toBe(1);
    expect(warn.join('\n')).toContain('Companion relay disconnected: close 1006');
    // 重连已被调度：退避 50ms 后拨出新 socket。
    clock.now += 50;
    void vi.advanceTimersByTime(50);
    expect(FakeWebSocket.last).not.toBe(socket);
    await client.stop();
  });

  it('keeps the connection when every ping is answered by a pong', async () => {
    const clock = { now: 0 };
    const { client, socket } = startAndStabilize(clock);
    // 连续若干个周期，每个 ping 都有 pong 回来：连接一直活着，一次 terminate 都不该发生。
    for (let cycle = 0; cycle < 4; cycle += 1) {
      clock.now += L.relayPingMs;
      void vi.advanceTimersByTime(L.relayPingMs);
      socket.emit('pong');
    }
    expect(socket.pings).toBe(4);
    expect(socket.terminated).toBe(0);
    expect(socket.readyState).toBe(1);
    await client.stop();
  });
});
