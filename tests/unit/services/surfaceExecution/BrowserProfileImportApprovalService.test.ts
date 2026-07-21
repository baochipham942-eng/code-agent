import { describe, expect, it } from 'vitest';
import { BrowserProfileImportApprovalService } from '../../../../src/host/services/surfaceExecution/BrowserProfileImportApprovalService';

const subject = { conversationId: 'conversation-a', runId: 'run-a', agentId: 'agent-a' };
const scope = {
  source: 'chrome',
  profileId: 'Default',
  domainAllowlist: ['Example.test', 'accounts.example.test'],
};

describe('BrowserProfileImportApprovalService', () => {
  it('issues an exact owner/scope/time-bound approval and consumes it once', () => {
    const service = new BrowserProfileImportApprovalService();
    const approval = service.issue({ subject, scope, now: 1_000, ttlMs: 5_000 });
    expect(approval.token).not.toContain('Default');
    expect(service.consume({ token: approval.token, subject, scope, now: 2_000 })).toBe(true);
    expect(service.consume({ token: approval.token, subject, scope, now: 2_001 })).toBe(false);
  });

  it('rejects tampering, owner/scope expansion, and expiry', () => {
    const service = new BrowserProfileImportApprovalService();
    const approval = service.issue({ subject, scope, now: 1_000, ttlMs: 2_000 });
    expect(service.consume({
      token: `${approval.token.slice(0, -1)}x`,
      subject,
      scope,
      now: 1_500,
    })).toBe(false);
    expect(service.consume({
      token: approval.token,
      subject: { ...subject, agentId: 'agent-b' },
      scope,
      now: 1_500,
    })).toBe(false);
    expect(service.consume({
      token: approval.token,
      subject,
      scope: { ...scope, domainAllowlist: [...scope.domainAllowlist, 'other.test'] },
      now: 1_500,
    })).toBe(false);
    expect(service.consume({ token: approval.token, subject, scope, now: 3_001 })).toBe(false);
  });
});
