import { describe, expect, it } from 'vitest';
import { CompanionGateway } from '../../src/host/services/companion/gateway';

describe('CompanionGateway', () => {
  const scope = { projectId: 'p1', sessionId: 's1', deviceId: 'd1' };
  it('deduplicates command ids and rejects revoked devices', () => {
    const gateway = new CompanionGateway();
    expect(gateway.receive({ ...scope, commandId: 'c1', kind: 'send', payload: 'x' }).status).toBe('accepted');
    expect(gateway.receive({ ...scope, commandId: 'c1', kind: 'send', payload: 'x' }).status).toBe('duplicate');
    gateway.revoke('d1');
    expect(gateway.receive({ ...scope, commandId: 'c2', kind: 'send' }).reason).toBe('REVOKED');
  });
  it('allows one approval decision and rejects stale or competing decisions', () => {
    const gateway = new CompanionGateway();
    gateway.beginApproval({ ...scope, approvalId: 'a1', revision: 1 });
    expect(gateway.decide({ ...scope, approvalId: 'a1', revision: 1 }, 'approved').decision).toBe('approved');
    expect(() => gateway.decide({ ...scope, approvalId: 'a1', revision: 1 }, 'rejected')).toThrow('ALREADY_DECIDED');
    expect(() => gateway.beginApproval({ ...scope, approvalId: 'a2', revision: 1 })).toThrow('STALE_REVISION');
  });
});
