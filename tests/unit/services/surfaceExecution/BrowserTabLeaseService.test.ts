import { describe, expect, it } from 'vitest';
import type { SurfaceTargetRefV1 } from '../../../../src/shared/contract/surfaceExecution';
import {
  BrowserTabLeaseService,
  type BrowserTabLeaseSubjectV1,
} from '../../../../src/host/services/surfaceExecution/BrowserTabLeaseService';
import { SurfaceCapabilityRegistry } from '../../../../src/host/services/surfaceExecution/SurfaceCapabilityRegistry';
import { SurfaceExecutionRuntimeError } from '../../../../src/host/services/surfaceExecution/SurfaceExecutionRuntimeError';
import { SurfaceSessionManager } from '../../../../src/host/services/surfaceExecution/SurfaceSessionManager';

const target: SurfaceTargetRefV1 = {
  kind: 'browser',
  browserInstanceId: 'browser:relay-profile',
  windowRef: 'window:agent-1',
  tabRef: 'tab:opaque-1',
  origin: 'https://example.test',
  documentRevision: 'document:1',
};

function createHarness() {
  let now = 1_000;
  let id = 0;
  const sessions = new SurfaceSessionManager({
    now: () => now,
    createId: () => `surface-${++id}`,
  });
  const capabilities = new SurfaceCapabilityRegistry();
  const createSubject = (
    agentId: string,
    conversationId = 'conversation-1',
    provider = 'browser-relay',
  ): BrowserTabLeaseSubjectV1 => {
    const session = sessions.create({
      conversationId,
      runId: `run-${agentId}`,
      agentId,
      surface: 'browser',
      provider,
      capabilities: capabilities.buildManifest({
        surface: 'browser',
        provider,
        operations: ['dom', 'screenshot', 'click', 'type'],
        supports: { cancel: true, cleanup: true, successorObservation: true },
      }),
    });
    return {
      conversationId,
      sessionId: session.sessionId,
      runId: session.runId,
      agentId,
    };
  };
  const subject = createSubject('agent-a');
  const leases = new BrowserTabLeaseService(sessions, {
    now: () => now,
    createId: () => `lease-${++id}`,
    maxConsentTtlMs: 500,
    maxLeaseTtlMs: 1_000,
  });
  const register = (owner = subject) => leases.registerAvailable({
    subject: owner,
    browserInstanceId: 'browser:relay-profile',
    tabRef: 'tab:opaque-1',
    agentWindowRef: 'window:agent-1',
    originalPlacement: {
      windowRef: 'window:user-original',
      index: 3,
      pinned: true,
    },
  });
  const approve = (leaseId: string, owner = subject, overrides: Partial<{
    approvalRef: string;
    domainScopes: string[];
    actionScopes: string[];
    ttlMs: number;
  }> = {}) => leases.approve({
    leaseId,
    subject: owner,
    approvalRef: overrides.approvalRef || 'approval-initial',
    domainScopes: overrides.domainScopes || ['https://example.test/path-is-reduced'],
    actionScopes: overrides.actionScopes || ['observe:dom', 'input:click'],
    ttlMs: overrides.ttlMs || 400,
  });
  return {
    sessions,
    leases,
    subject,
    createSubject,
    register,
    approve,
    tick(ms: number) { now += ms; },
  };
}

function errorCode(run: () => unknown): string | undefined {
  try {
    run();
    return undefined;
  } catch (error) {
    return error instanceof SurfaceExecutionRuntimeError ? error.surfaceError.code : undefined;
  }
}

describe('BrowserTabLeaseService', () => {
  it('moves an explicitly selected tab through consent into an owner-scoped lease', () => {
    const { leases, subject, register, approve } = createHarness();
    const available = register();
    expect(available).toMatchObject({
      state: 'available',
      subject,
      domainScopes: [],
      actionScopes: [],
    });
    expect(leases.requestConsent({
      leaseId: available.leaseId,
      subject,
      ttlMs: 200,
    }).state).toBe('consent_pending');
    const leased = approve(available.leaseId);
    expect(leased).toMatchObject({
      state: 'leased',
      domainScopes: ['origin:https://example.test'],
      actionScopes: ['observe:dom', 'input:click'],
      approvedAt: 1_000,
      expiresAt: 1_400,
    });
    expect(leases.authorize({
      leaseId: available.leaseId,
      subject,
      target,
      action: 'input:click',
    }).state).toBe('leased');
  });

  it('drops unapproved tab metadata and rejects native numeric references', () => {
    const { leases, subject } = createHarness();
    const lease = leases.registerAvailable({
      subject,
      browserInstanceId: 'browser:relay-profile',
      tabRef: 'tab:opaque-with-extra-input',
      agentWindowRef: 'window:agent-1',
      originalPlacement: { windowRef: 'window:user-original', index: 0 },
      ...({ title: 'Private inbox', url: 'https://mail.example.test/private' } as Record<string, unknown>),
    });
    expect(JSON.stringify(lease)).not.toMatch(/private inbox|mail\.example|url|title|favicon|cookie|debugger/i);
    expect(() => leases.registerAvailable({
      subject,
      browserInstanceId: 'browser:relay-profile',
      tabRef: '42',
      agentWindowRef: 'window:agent-2',
      originalPlacement: { windowRef: 'window:user-original', index: 0 },
      ...({ title: 'Private inbox', url: 'https://mail.example.test/private' } as Record<string, unknown>),
    })).toThrow(/opaque Host-issued reference/);
    expect(JSON.stringify(leases.listOwned(subject))).not.toContain('Private inbox');
  });

  it('fences conversation, session, run, and agent and prevents a second owner borrowing the tab', () => {
    const { leases, subject, createSubject, register } = createHarness();
    const lease = register();
    const other = createSubject('agent-b');
    expect(errorCode(() => leases.getOwned(lease.leaseId, other))).toBe('SURFACE_TARGET_NOT_OWNED');
    expect(errorCode(() => leases.getOwned(lease.leaseId, {
      ...subject,
      conversationId: 'conversation-guessed',
    }))).toBe('SURFACE_TARGET_NOT_OWNED');
    expect(errorCode(() => register(other))).toBe('SURFACE_SESSION_BUSY');
    expect(errorCode(() => leases.registerAvailable({
      subject: other,
      browserInstanceId: 'browser:relay-profile',
      tabRef: 'tab:opaque-other',
      agentWindowRef: 'window:agent-1',
      originalPlacement: { windowRef: 'window:user-original', index: 4 },
    }))).toBe('SURFACE_SESSION_BUSY');
    expect(errorCode(() => leases.registerAvailable({
      subject,
      browserInstanceId: 'browser:relay-profile',
      tabRef: 'tab:opaque-second',
      agentWindowRef: 'window:agent-wrong',
      originalPlacement: { windowRef: 'window:user-original', index: 4 },
    }))).toBe('SURFACE_POLICY_BLOCKED');
    expect(leases.listOwned(other)).toEqual([]);
  });

  it('requires exact tab, Agent Window, domain, and action on every authorization', () => {
    const { leases, subject, register, approve } = createHarness();
    const lease = register();
    leases.requestConsent({ leaseId: lease.leaseId, subject });
    approve(lease.leaseId, subject, { domainScopes: ['example.test'] });

    expect(errorCode(() => leases.authorize({
      leaseId: lease.leaseId,
      subject,
      target: { ...target, origin: 'https://example.test.evil.invalid' },
      action: 'input:click',
    }))).toBe('SURFACE_APPROVAL_INVALID');
    expect(errorCode(() => leases.authorize({
      leaseId: lease.leaseId,
      subject,
      target: { ...target, tabRef: 'tab:opaque-other' },
      action: 'input:click',
    }))).toBe('SURFACE_TARGET_NOT_OWNED');
    expect(errorCode(() => leases.authorize({
      leaseId: lease.leaseId,
      subject,
      target: { ...target, windowRef: 'window:user-original' },
      action: 'input:click',
    }))).toBe('SURFACE_TARGET_NOT_OWNED');
    expect(errorCode(() => leases.authorize({
      leaseId: lease.leaseId,
      subject,
      target,
      action: 'network:read',
    }))).toBe('SURFACE_APPROVAL_INVALID');
  });

  it('rejects wildcard scopes and approvals without a bounded TTL', () => {
    const { leases, subject, register, approve } = createHarness();
    const first = register();
    leases.requestConsent({ leaseId: first.leaseId, subject });
    expect(errorCode(() => approve(first.leaseId, subject, { domainScopes: ['*'] })))
      .toBe('SURFACE_APPROVAL_INVALID');
    expect(errorCode(() => approve(first.leaseId, subject, { actionScopes: ['*'] })))
      .toBe('SURFACE_APPROVAL_INVALID');
    expect(errorCode(() => approve(first.leaseId, subject, { ttlMs: 1_001 })))
      .toBe('SURFACE_APPROVAL_INVALID');
  });

  it('expires pending consent and records an explicit denial without granting access', () => {
    const pending = createHarness();
    const pendingLease = pending.register();
    pending.leases.requestConsent({ leaseId: pendingLease.leaseId, subject: pending.subject, ttlMs: 100 });
    pending.tick(100);
    expect(pending.leases.getOwned(pendingLease.leaseId, pending.subject)?.state).toBe('expired');
    expect(pending.leases.listReturnRequired(pending.subject)).toEqual([]);
    expect(errorCode(() => pending.approve(pendingLease.leaseId))).toBe('SURFACE_POLICY_BLOCKED');
    expect(() => pending.register()).not.toThrow();

    const denied = createHarness();
    const deniedLease = denied.register();
    denied.leases.requestConsent({ leaseId: deniedLease.leaseId, subject: denied.subject });
    expect(denied.leases.deny({ leaseId: deniedLease.leaseId, subject: denied.subject }).state).toBe('denied');
    expect(errorCode(() => denied.leases.authorize({
      leaseId: deniedLease.leaseId,
      subject: denied.subject,
      target,
      action: 'observe:dom',
    }))).toBe('BROWSER_TAB_BORROW_DENIED');
  });

  it('requires fresh approval proof for renewal and fails closed at expiry', () => {
    const { leases, subject, register, approve, tick } = createHarness();
    const lease = register();
    leases.requestConsent({ leaseId: lease.leaseId, subject });
    approve(lease.leaseId);
    expect(errorCode(() => leases.renew({
      leaseId: lease.leaseId,
      subject,
      approvalRef: 'approval-initial',
      domainScopes: ['example.test'],
      actionScopes: ['observe:dom'],
      ttlMs: 500,
    }))).toBe('SURFACE_APPROVAL_INVALID');
    expect(leases.renew({
      leaseId: lease.leaseId,
      subject,
      approvalRef: 'approval-renewed',
      domainScopes: ['example.test'],
      actionScopes: ['observe:dom'],
      ttlMs: 500,
    })).toMatchObject({ state: 'leased', expiresAt: 1_500 });
    tick(500);
    expect(errorCode(() => leases.authorize({
      leaseId: lease.leaseId,
      subject,
      target,
      action: 'observe:dom',
    }))).toBe('BROWSER_TAB_BORROW_REQUIRED');
    expect(leases.listReturnRequired(subject).map((item) => item.state)).toEqual(['expired']);
  });

  it('returns a borrowed tab to its original placement and releases the active tab fence', async () => {
    const { leases, subject, register, approve, createSubject } = createHarness();
    const lease = register();
    leases.requestConsent({ leaseId: lease.leaseId, subject });
    approve(lease.leaseId);
    let restore!: () => void;
    let restoredPlacement: unknown;
    const returnRun = leases.returnLease({
      leaseId: lease.leaseId,
      subject,
      restore(placement) {
        restoredPlacement = placement;
        return new Promise<void>((resolve) => { restore = resolve; });
      },
    });
    expect(leases.getOwned(lease.leaseId, subject)?.state).toBe('returning');
    expect(leases.listReturnRequired(subject).map((item) => item.state)).toEqual(['returning']);
    restore();
    const returned = await returnRun;
    expect(returned.state).toBe('returned');
    expect(restoredPlacement).toEqual({ windowRef: 'window:user-original', index: 3, pinned: true });
    expect(leases.listReturnRequired(subject)).toEqual([]);
    expect(() => Object.assign(restoredPlacement as object, { index: 99 })).toThrow();

    const other = createSubject('agent-b');
    expect(() => leases.registerAvailable({
      subject: other,
      browserInstanceId: 'browser:relay-profile',
      tabRef: 'tab:opaque-1',
      agentWindowRef: 'window:agent-2',
      originalPlacement: { windowRef: 'window:user-original', index: 3 },
    })).not.toThrow();
  });

  it('preserves browser state and enters recovery_required when tab return fails', async () => {
    const { leases, subject, register, approve } = createHarness();
    const lease = register();
    leases.requestConsent({ leaseId: lease.leaseId, subject });
    approve(lease.leaseId);
    await expect(leases.returnLease({
      leaseId: lease.leaseId,
      subject,
      restore() {
        throw new Error('secret full URL from provider');
      },
    })).rejects.toMatchObject({
      surfaceError: {
        code: 'SURFACE_CLEANUP_FAILED',
        phase: 'cleanup',
        retryable: true,
      },
    });
    const recovery = leases.getOwned(lease.leaseId, subject);
    expect(recovery).toMatchObject({ state: 'recovery_required', recoveryCode: 'return_failed' });
    expect(JSON.stringify(recovery)).not.toContain('secret full URL from provider');

    await expect(leases.returnLease({
      leaseId: lease.leaseId,
      subject,
      restore: async () => Promise.resolve(),
    })).resolves.toMatchObject({ state: 'returned' });
  });

  it('keeps orphaned tabs unavailable until an owner-scoped recovery succeeds', async () => {
    const { leases, subject, register, approve } = createHarness();
    const lease = register();
    leases.requestConsent({ leaseId: lease.leaseId, subject });
    approve(lease.leaseId);
    expect(leases.markOrphaned({
      leaseId: lease.leaseId,
      subject,
      code: 'extension_restarted',
    })).toMatchObject({ state: 'orphaned', recoveryCode: 'extension_restarted' });
    expect(errorCode(() => leases.authorize({
      leaseId: lease.leaseId,
      subject,
      target,
      action: 'observe:dom',
    }))).toBe('BROWSER_TAB_BORROW_REQUIRED');
    await expect(leases.returnLease({
      leaseId: lease.leaseId,
      subject,
      restore: async () => Promise.resolve(),
    })).resolves.toMatchObject({ state: 'returned' });
  });

  it('accepts trusted provider return confirmation only for the exact lease owner', () => {
    const { leases, subject, register, approve } = createHarness();
    const lease = register();
    leases.requestConsent({ leaseId: lease.leaseId, subject });
    approve(lease.leaseId);
    leases.markOrphaned({
      leaseId: lease.leaseId,
      subject,
      code: 'provider_disconnected',
    });
    leases.markRecoveryRequired({ leaseId: lease.leaseId, subject });

    expect(() => leases.confirmReturned({
      leaseId: lease.leaseId,
      subject: { ...subject, agentId: 'agent-attacker' },
    })).toThrowError(SurfaceExecutionRuntimeError);
    expect(leases.getOwned(lease.leaseId, subject)).toMatchObject({ state: 'recovery_required' });
    expect(leases.confirmReturned({ leaseId: lease.leaseId, subject }))
      .toMatchObject({ state: 'returned', returnedAt: expect.any(Number) });
    expect(leases.confirmReturned({ leaseId: lease.leaseId, subject }))
      .toMatchObject({ state: 'returned' });
  });
});
