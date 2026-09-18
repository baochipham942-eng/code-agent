// 跨网连接状态块装配（N-COMPANION-RELAY-ACCOUNT-DESKTOP-STATUS）：LanCompanionManager 把
// relayStatus 回调的返回拼进 { kind: 'status' }；回调缺省时字段整个不出现（旧装配零影响）。
import { describe, expect, it, vi } from 'vitest';
import type { CompanionRelayStatus } from '../../../../../src/shared/contract/companionManagement';
import { LanCompanionManager } from '../../../../../src/host/services/companion/LanCompanionManager';
import type { CompanionGateway } from '../../../../../src/host/services/companion/CompanionGateway';

const gateway = { pairedDevices: () => [] } as unknown as CompanionGateway;
const loadIdentity = vi.fn(async () => ({ publicKey: Buffer.alloc(32), secretKey: Buffer.alloc(32) }));
const listSessions = vi.fn(async () => [{ id: 's1', title: 'Talk' }]);

describe('LanCompanionManager status relay block', () => {
  it('merges the injected relay status into the status result', async () => {
    const relay: CompanionRelayStatus = { configured: true, legacy: 'disconnected', account: 'signedOut', accountError: 'COMPANION_RELAY_CLOSED_AFTER_OPEN' };
    const lan = new LanCompanionManager(gateway, loadIdentity, listSessions, () => [], undefined, undefined, () => relay);
    expect(await lan.manage({ action: 'status' })).toEqual({
      kind: 'status',
      sessions: [{ id: 's1', title: 'Talk' }],
      projects: [],
      devices: [],
      relay,
    });
  });

  it('omits the relay field when no status callback is wired (legacy assembly)', async () => {
    const lan = new LanCompanionManager(gateway, loadIdentity, listSessions);
    const result = await lan.manage({ action: 'status' });
    expect(result).toMatchObject({ kind: 'status' });
    expect('relay' in result).toBe(false);
  });
});
