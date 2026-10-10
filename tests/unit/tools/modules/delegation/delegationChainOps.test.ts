import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.unmock('better-sqlite3');
import { applySchema } from '../../../../../src/host/services/core/database/schema';
import { commitDelegation } from '../../../../../src/host/services/delegation/delegationDelivery';
import { SessionDelegationRepository } from '../../../../../src/host/services/core/repositories/SessionDelegationRepository';
import { QueuedInputRepository } from '../../../../../src/host/services/core/repositories/QueuedInputRepository';
import { deriveActionFingerprint, deriveSubmissionKey } from '../../../../../src/host/services/delegation/delegationKeys';
import { executeDelegateSession } from '../../../../../src/host/tools/modules/delegation/delegateSession';

const ctx = { sessionId: 'origin', turnId: 'turn', workspace: '/workspace', workingDir: '/workspace', modelConfig: { provider: 'local', model: 'test' }, abortSignal: new AbortController().signal } as never;
const setRuntime = (value: unknown) => {
  (ctx as unknown as { delegationRuntime?: unknown }).delegationRuntime = value;
};

afterEach(() => { delete process.env.CODE_AGENT_CROSS_SESSION_DELEGATION; setRuntime(undefined); });

describe('delegate_session chain operations', () => {
  it('stop pauses a queued row and resume rechecks before unpausing', async () => {
    process.env.CODE_AGENT_CROSS_SESSION_DELEGATION = '1';
    const db = new Database(':memory:');
    applySchema(db, { info() {}, warn() {}, error() {}, debug() {} } as never);
    const fingerprint = deriveActionFingerprint({ action: 'delegate_existing', targetIdentity: 'session:target', content: 'work', attachmentRefs: [] });
    const key = deriveSubmissionKey({ originSessionId: 'origin', originTurnId: 'turn', action: 'delegate_existing', targetIdentity: 'session:target' });
    commitDelegation(db, { delegationId: 'd-1', originSessionId: 'origin', originTurnId: 'turn', disposition: 'delegate_existing', targetSessionId: 'target', submissionKey: key, actionFingerprint: fingerprint, envelope: { content: 'work', sessionId: 'target' }, now: 1 });
    setRuntime({
      getDb: () => db,
      getSessionRow: () => ({ id: 'target', title: 'Target', workingDirectory: '/workspace', sessionType: 'chat', engineKind: 'native' }),
      getWorkspaceRoots: () => ['/workspace'], getRuns: () => [], getRun: () => undefined,
      getPermissionMode: () => 'default', evaluateFolderTrust: async () => ({ state: 'trusted', blockedItems: 0 }),
      now: () => 2, notifyEnqueued: () => {},
    });
    const allow = async () => ({ allow: true as const });
    expect((await executeDelegateSession({ action: 'stop', delegationId: 'd-1' }, ctx, allow)).ok).toBe(true);
    expect(new SessionDelegationRepository(db).get('d-1')?.status).toBe('stopped');
    expect(new QueuedInputRepository(db).getById('delegation:' + key)?.pausedReason).toBe('delegation_stopped');
    expect((await executeDelegateSession({ action: 'resume', delegationId: 'd-1' }, ctx, allow)).ok).toBe(true);
    expect(new SessionDelegationRepository(db).get('d-1')?.status).toBe('active');
    db.close();
  });
});
