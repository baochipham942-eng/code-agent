import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type WebSocket from 'ws';
import { CompanionRelayClient } from '../../../../../src/host/services/companion/CompanionRelayClient';
import { createIdentity } from '../../../../../src/shared/companion/noiseChannel';
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
