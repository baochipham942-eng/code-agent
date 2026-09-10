import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ verified: false, user: { id: 'host-owner' }, recover: vi.fn(), db: {} }));
vi.mock('../../../src/host/services/auth/authService', () => ({ getAuthService: () => ({
  hasVerifiedSession: () => mocks.verified, getCurrentUser: () => mocks.user,
}) }));
vi.mock('../../../src/host/services/core/databaseService', () => ({ getDatabase: () => ({ getDb: () => mocks.db }) }));
vi.mock('../../../src/host/services/core/repositories/HistoricalSessionRecoveryRepository', () => ({
  HistoricalSessionRecoveryRepository: class { recover = mocks.recover; },
}));
import { recoverHistoricalSession } from '../../../src/host/ipc/historicalSessionRecovery';
describe('historical recovery authenticated host boundary', () => {
  beforeEach(() => { mocks.verified = false; mocks.recover.mockReset(); });
  it('rejects cached-only identity without invoking import', () => {
    expect(recoverHistoricalSession({ sessionId: 'source', projectId: null, action: 'import', expectedDigest: 'digest' }).code).toBe('AUTH_REQUIRED');
    expect(mocks.recover).not.toHaveBeenCalled();
  });
  it('uses the verified host actor even when a payload attempts to choose another user', () => {
    mocks.verified = true;
    const payload = { sessionId: 'source', projectId: null, action: 'inspect' as const, actorUserId: 'intruder' };
    recoverHistoricalSession(payload);
    expect(mocks.recover).toHaveBeenCalledWith('host-owner', payload);
  });
});
