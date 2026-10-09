import { afterEach, describe, expect, it, vi } from 'vitest';
vi.unmock('better-sqlite3');
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, networkInterfaces: vi.fn(actual.networkInterfaces) };
});
import Database from 'better-sqlite3';
import { networkInterfaces } from 'node:os';
import { CompanionGateway } from '../../../src/host/services/companion/CompanionGateway';
import { LanCompanionManager } from '../../../src/host/services/companion/LanCompanionManager';
import { createIdentity } from '../../../src/shared/companion/noiseChannel';
import { toHex } from '../../../src/shared/companion/lanProtocol';

/**
 * r2 回归（ai-review Important）：仅热点/VPN 的机器没有私网 IPv4，restore() 会抛
 * COMPANION_LAN_UNAVAILABLE。总闸打开时这条失败必须按 best-effort 吞掉（与 app.ts
 * 开机路径同形），否则两条 relay 的重新拨起被挡住——开关已持久化为开、status 报
 * remoteEnabled:true，但跨网手机直到重启 app 都连不上。
 */

describe('companion remote switch on without a private IPv4', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.mocked(networkInterfaces).mockReset(); });

  it('still redials relay transports and reports status when the LAN surface cannot come back', async () => {
    // 203.0.113.0/24 是 TEST-NET-3：isPrivateIPv4 为 false，privateLanAddresses() 返回空。
    vi.mocked(networkInterfaces).mockReturnValue({ en0: [{ address: '203.0.113.4', family: 'IPv4', internal: false, netmask: '255.255.255.0', mac: '00:00:00:00:00:00', cidr: '203.0.113.4/24' }] });
    const db = new Database(':memory:');
    const gateway = new CompanionGateway(db, { dispatch: () => ({ state: 'accepted' }) });
    // 有配对设备，restore() 才会越过「无配对设备」的早退、真去起 LAN 并抛 LAN_UNAVAILABLE。
    gateway.pairIdentity(toHex(createIdentity().publicKey), ['shared']);
    const transports = { start: vi.fn(async () => {}), stop: vi.fn(async () => {}) };
    const manager = new LanCompanionManager(
      gateway,
      async () => createIdentity(),
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
    try {
      await manager.manage({ action: 'setRemote', enabled: false });
      expect(transports.stop).toHaveBeenCalledTimes(1);
      const status = await manager.manage({ action: 'setRemote', enabled: true });
      expect(status).toMatchObject({ kind: 'status', remoteEnabled: true });
      expect(transports.start).toHaveBeenCalledTimes(1);
      expect(manager.lanAdvertisement()).toBeNull();
    } finally {
      await manager.stop();
      db.close();
    }
  });
});
