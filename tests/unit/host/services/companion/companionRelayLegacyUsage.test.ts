import { describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import type WebSocket from 'ws';
import { createCompanionRelayLegacyUsage } from '../../../../../src/host/services/companion/companionRelayLegacyUsage';
import type { CompanionRelayLogger } from '../../../../../src/host/services/companion/companionRelayConfig';
import { CompanionRelayClient } from '../../../../../src/host/services/companion/CompanionRelayClient';
import { createHandshake, createIdentity } from '../../../../../src/shared/companion/noiseChannel';
import { toHex } from '../../../../../src/shared/companion/lanProtocol';
import { COMPANION_LIMITS as L } from '../../../../../src/shared/constants/companion';
import type { CompanionGateway } from '../../../../../src/host/services/companion/CompanionGateway';

/**
 * 共享凭据通道的存量清点（N-COMPANION-RELAY-LEGACY-COUNT）：按 deviceId 去重记 lastSeenAt、
 * 原子写 0600 落盘、脏文件容错（空表起步 + 可区分 warn，绝不抛）。真实文件系统（tmpdir） +
 * FakeWebSocket 驱动握手，钉住「只有共享凭据通道的握手才记账」。
 */

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'companion-relay-legacy-usage-'));
}

function usageFile(dir: string): string {
  return join(dir, L.relayLegacyUsageFile);
}

function collectLogger(): { logger: CompanionRelayLogger; warn: string[]; info: string[] } {
  const warn: string[] = [];
  const info: string[] = [];
  return {
    warn,
    info,
    logger: {
      warn: (message: string) => { warn.push(message); },
      info: (message: string) => { info.push(message); },
    },
  };
}

describe('companion relay legacy usage store', () => {
  it('counts a repeated device once and advances lastSeenAt', () => {
    const dir = tempDir();
    try {
      const { logger } = collectLogger();
      const store = createCompanionRelayLegacyUsage({ dataDirectory: dir, logger });
      expect(store.summary()).toEqual({ devices: 0, lastSeenAt: null });
      store.record('device-a', 1_000);
      store.record('device-a', 2_000);
      expect(store.summary()).toEqual({ devices: 1, lastSeenAt: 2_000 });
      // 落盘的也是去重后的形状：deviceId → 最新的 lastSeenAt。
      expect(JSON.parse(readFileSync(usageFile(dir), 'utf8'))).toEqual({ v: 1, devices: { 'device-a': 2_000 } });
      expect(statSync(usageFile(dir)).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('counts two devices separately and reports the newest lastSeenAt', () => {
    const dir = tempDir();
    try {
      const store = createCompanionRelayLegacyUsage({ dataDirectory: dir });
      store.record('device-a', 1_000);
      store.record('device-b', 3_000);
      expect(store.summary()).toEqual({ devices: 2, lastSeenAt: 3_000 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps data across a restart (reload from disk)', () => {
    const dir = tempDir();
    try {
      createCompanionRelayLegacyUsage({ dataDirectory: dir }).record('device-a', 1_000);
      createCompanionRelayLegacyUsage({ dataDirectory: dir }).record('device-b', 5_000);
      // 新实例＝Host 重启后的形状：从盘上把两台设备与最新时间都读回来。
      expect(createCompanionRelayLegacyUsage({ dataDirectory: dir }).summary()).toEqual({ devices: 2, lastSeenAt: 5_000 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not rewrite when the timestamp does not advance', () => {
    const dir = tempDir();
    try {
      const store = createCompanionRelayLegacyUsage({ dataDirectory: dir });
      store.record('device-a', 5_000);
      // 时钟回拨/重复握手：lastSeenAt 不得倒退，也没有落盘价值。
      store.record('device-a', 4_000);
      store.record('device-a', 5_000);
      const onDisk = readFileSync(usageFile(dir), 'utf8');
      expect(JSON.parse(onDisk)).toEqual({ v: 1, devices: { 'device-a': 5_000 } });
      expect(createCompanionRelayLegacyUsage({ dataDirectory: dir }).summary()).toEqual({ devices: 1, lastSeenAt: 5_000 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('starts empty without a warn when the file is simply missing', () => {
    const dir = tempDir();
    try {
      const { logger, warn } = collectLogger();
      const store = createCompanionRelayLegacyUsage({ dataDirectory: dir, logger });
      expect(store.summary()).toEqual({ devices: 0, lastSeenAt: null });
      expect(warn).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('tolerates a corrupt file: empty state, distinguishable warn, no throw', () => {
    const dir = tempDir();
    try {
      writeFileSync(usageFile(dir), '{not json', { mode: 0o600 });
      const { logger, warn } = collectLogger();
      const store = createCompanionRelayLegacyUsage({ dataDirectory: dir, logger });
      expect(store.summary()).toEqual({ devices: 0, lastSeenAt: null });
      // 坏形状同样按 corrupt 起步（v 不对 / lastSeenAt 非法）。
      writeFileSync(usageFile(dir), JSON.stringify({ v: 2, devices: { 'device-a': 1 } }), { mode: 0o600 });
      const storeV2 = createCompanionRelayLegacyUsage({ dataDirectory: dir, logger });
      expect(storeV2.summary()).toEqual({ devices: 0, lastSeenAt: null });
      // 之后照常记账（不因一次坏文件永久失效），也不抛。
      store.record('device-a', 1_000);
      expect(store.summary()).toEqual({ devices: 1, lastSeenAt: 1_000 });
      expect(warn).toEqual([
        'Companion relay legacy usage file corrupt; starting empty',
        'Companion relay legacy usage file corrupt; starting empty',
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('warns distinguishably when the file exists but cannot be read', () => {
    const dir = tempDir();
    try {
      writeFileSync(usageFile(dir), JSON.stringify({ v: 1, devices: { 'device-a': 1_000 } }), { mode: 0o600 });
      chmodSync(usageFile(dir), 0o000);
      const { logger, warn } = collectLogger();
      const store = createCompanionRelayLegacyUsage({ dataDirectory: dir, logger });
      expect(store.summary()).toEqual({ devices: 0, lastSeenAt: null });
      expect(warn.join('\n')).toMatch(/^Companion relay legacy usage file unreadable: /);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never throws when the data directory is read-only, and keeps the count in memory', () => {
    const dir = tempDir();
    const roDir = join(dir, 'ro');
    try {
      mkdirSync(roDir);
      chmodSync(roDir, 0o555);
      const { logger, warn } = collectLogger();
      const store = createCompanionRelayLegacyUsage({ dataDirectory: roDir, logger });
      store.record('device-a', 1_000);
      store.record('device-b', 2_000);
      expect(store.summary()).toEqual({ devices: 2, lastSeenAt: 2_000 });
      expect(warn.join('\n')).toMatch(/Companion relay legacy usage store write failed: /);
    } finally {
      chmodSync(roDir, 0o755);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('caps stored devices by evicting the stalest', () => {
    const dir = tempDir();
    try {
      const store = createCompanionRelayLegacyUsage({ dataDirectory: dir });
      store.record('device-old', 1_000);
      for (let i = 1; i < L.relayLegacyUsageMaxDevices; i += 1) store.record(`device-${i}`, 2_000 + i);
      store.record('device-new', 9_000);
      expect(store.summary().devices).toBe(L.relayLegacyUsageMaxDevices);
      // 最旧的被淘汰、新来的在册：summary 只报数与最新时间，细看盘上内容确认去留。
      const onDisk = JSON.parse(readFileSync(usageFile(dir), 'utf8')) as { devices: Record<string, number> };
      expect(onDisk.devices['device-old']).toBeUndefined();
      expect(onDisk.devices['device-new']).toBe(9_000);
      expect(Object.keys(onDisk.devices)).toHaveLength(L.relayLegacyUsageMaxDevices);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('info-logs the numbers once per new device and stays quiet for repeat handshakes', () => {
    const dir = tempDir();
    try {
      const { logger, info } = collectLogger();
      const store = createCompanionRelayLegacyUsage({ dataDirectory: dir, logger });
      store.record('device-a', 1_000);
      store.record('device-a', 2_000);
      store.record('device-b', 3_000);
      expect(info).toEqual([
        'Companion relay legacy usage: new device recorded; devices=1 lastSeenAt=1000',
        'Companion relay legacy usage: new device recorded; devices=2 lastSeenAt=3000',
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ignores malformed record input instead of throwing', () => {
    const dir = tempDir();
    try {
      const store = createCompanionRelayLegacyUsage({ dataDirectory: dir });
      store.record('', 1_000);
      store.record('device-a', Number.NaN);
      store.record('device-a', -1);
      expect(store.summary()).toEqual({ devices: 0, lastSeenAt: null });
      expect(existsSync(usageFile(dir))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('defaults the timestamp to the injected now', () => {
    const dir = tempDir();
    try {
      const store = createCompanionRelayLegacyUsage({ dataDirectory: dir, now: () => 7_000 });
      store.record('device-a');
      expect(store.summary()).toEqual({ devices: 1, lastSeenAt: 7_000 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

class FakeWebSocket extends EventEmitter {
  static last: FakeWebSocket | null = null;
  readyState = 0;
  readonly sent: string[] = [];
  constructor(_url: string, _options?: unknown) {
    super();
    FakeWebSocket.last = this;
  }
  send(data: unknown): void { this.sent.push(String(data)); }
  close(): void {
    this.readyState = 3;
    this.emit('close', 1000, Buffer.alloc(0));
  }
  terminate(): void {
    this.readyState = 3;
  }
}

const DEVICE_REF = 'device-ref-12345678';
const TOKEN = 'route-token-aaaaaa';
const gateway = { pairedDevices: () => [], identityDevice: () => ({ deviceId: DEVICE_REF }) } as unknown as CompanionGateway;

describe('companion relay client legacy usage hook', () => {
  /** 拨号到 open、打进一帧手机 IK 握手：返回被记账的 store 与状态块读到的 summary（目录随 finally 清掉，断言只看内存态）。 */
  async function handshakeAndStop(credential: string | (() => Promise<string | null>)): Promise<{ store: ReturnType<typeof createCompanionRelayLegacyUsage>; viaClient: ReturnType<CompanionRelayClient['legacyUsageSummary']> }> {
    const dir = tempDir();
    const clock = { now: 10_000 };
    const identity = createIdentity();
    const store = createCompanionRelayLegacyUsage({ dataDirectory: dir });
    const client = new CompanionRelayClient({
      gateway,
      identity,
      config: { url: 'ws://relay.test', credentialRef: 'companion-relay', reconnectBackoffMs: [50, 50, 50] },
      credential,
      legacyUsage: store,
      now: () => clock.now,
      jitter: () => 0.5,
      WebSocket: FakeWebSocket as unknown as typeof WebSocket,
    });
    try {
      // last 是静态残留：先清掉，确保后面等到的是本用例 client 的 socket（账号通道异步拨号，
      // 旧 socket 会让握手事件打进死连接、用例假绿）。经函数取值读回，避开对静态属性的收窄。
      FakeWebSocket.last = null;
      const currentSocket = (): FakeWebSocket | null => FakeWebSocket.last;
      client.advertise({ deviceRef: DEVICE_REF, routeToken: TOKEN });
      void client.start();
      // 账号通道的凭据是异步现取的：排空微任务让拨号走到 socket 构造，共享凭据通道则同步就有。
      for (let i = 0; i < 10 && !currentSocket(); i += 1) await Promise.resolve();
      const socket = currentSocket();
      if (!socket) throw new Error('fake socket not constructed');
      socket.readyState = 1;
      socket.emit('open');
      const noise = createHandshake(true, createIdentity(), undefined, undefined, toHex(identity.publicKey));
      socket.emit('message', JSON.stringify({
        v: 1, kind: 'handshake',
        envelope: { routeToken: TOKEN, deviceRef: DEVICE_REF, seq: 0, ttlMs: L.relayRouteTokenTtlMs, issuedAt: clock.now },
        ciphertext: toHex(noise.send()),
      }));
      return { store, viaClient: client.legacyUsageSummary() };
    } finally {
      await client.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('records the device when the legacy (shared-credential) channel accepts a handshake', async () => {
    const { store, viaClient } = await handshakeAndStop('shared-secret');
    expect(store.summary()).toEqual({ devices: 1, lastSeenAt: 10_000 });
    expect(viaClient).toEqual({ devices: 1, lastSeenAt: 10_000 });
  });

  it('does not record when the account channel accepts a handshake', async () => {
    const { store, viaClient } = await handshakeAndStop(() => Promise.resolve('account-token'));
    expect(store.summary()).toEqual({ devices: 0, lastSeenAt: null });
    // 接了记账器也不报：账号通道的手机不属于「还依赖旧凭据」的分母（状态块就不带 legacyUsage）。
    expect(viaClient).toBeNull();
  });
});
