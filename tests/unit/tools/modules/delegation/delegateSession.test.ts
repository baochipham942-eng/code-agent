import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.unmock('better-sqlite3');
import { applySchema } from '../../../../../src/host/services/core/database/schema';
import { SessionDelegationRepository } from '../../../../../src/host/services/core/repositories/SessionDelegationRepository';
import { getDelegationCandidateSecret } from '../../../../../src/host/services/delegation/delegationToolRuntime';
import { projectSessionCandidates } from '../../../../../src/host/services/delegation/delegationCandidates';
import { executeDelegateSession } from '../../../../../src/host/tools/modules/delegation/delegateSession';

const ctx = {
  sessionId: 'origin', turnId: 'turn-1', workingDir: '/workspace/origin',
  workspace: '/workspace/origin', modelConfig: { provider: 'local', model: 'test' },
  workspaceScope: { projectId: 'p', primaryRoot: '/workspace/origin', roots: [{ sourceId: 's', path: '/workspace/origin', access: 'read_write', role: 'primary' }], version: '1' },
  abortSignal: new AbortController().signal,
} as never;

const setRuntime = (value: unknown) => {
  (ctx as unknown as { delegationRuntime?: unknown }).delegationRuntime = value;
};

afterEach(() => {
  delete process.env.CODE_AGENT_CROSS_SESSION_DELEGATION;
  setRuntime(undefined);
});

describe('delegate_session', () => {
  it('passes admission and commits one delegation plus one queued row', async () => {
    process.env.CODE_AGENT_CROSS_SESSION_DELEGATION = '1';
    const db = new Database(':memory:');
    applySchema(db, { info() {}, warn() {}, error() {}, debug() {} } as never);
    const now = 100;
    const sessions = [{ id: 'target', title: 'Target', workingDirectory: '/workspace/origin', updatedAt: now, sessionType: 'chat' as const, engineKind: 'native' }];
    const projection = projectSessionCandidates(sessions, { originSessionId: 'origin', now, secret: getDelegationCandidateSecret() });
    const notify = vi.fn();
    setRuntime({
      getDb: () => db,
      listSessions: () => sessions,
      getSessionRow: (id: string) => id === 'target' ? { id, title: 'Target', workingDirectory: '/workspace/origin', sessionType: 'chat', engineKind: 'native', modelConfig: { provider: 'local', model: 'test' } } : null,
      getWorkspaceRoots: () => ['/workspace'],
      getRuns: () => [],
      getRun: () => undefined,
      getPermissionMode: () => 'default',
      evaluateFolderTrust: async () => ({ state: 'trusted', blockedItems: 0 }),
      notifyEnqueued: notify,
      now: () => now,
    });
    const result = await executeDelegateSession({ action: 'delegate_existing', candidateSetId: projection.candidateSetId, candidateRef: projection.candidates[0].candidateRef, text: 'do it' }, ctx, async () => ({ allow: true }));
    expect(result.ok).toBe(true);
    expect(new SessionDelegationRepository(db).listByTargetSession('target')).toHaveLength(1);
    expect(db.prepare('SELECT count(*) AS count FROM queued_inputs').get()).toMatchObject({ count: 1 });
    expect(notify).toHaveBeenCalledWith('target');
    db.close();
  });

  it('candidate set stale is a structured rejection with no write', async () => {
    process.env.CODE_AGENT_CROSS_SESSION_DELEGATION = '1';
    setRuntime({ listSessions: () => [], now: () => 1 });
    const result = await executeDelegateSession({ action: 'delegate_existing', candidateSetId: 'stale', candidateRef: 'ref', text: 'do it' }, ctx, async () => ({ allow: true }));
    expect(result).toMatchObject({ ok: false, code: 'DELEGATION_REJECTED' });
    expect((result as { error: string }).error).toContain('candidate_set_stale');
  });
});
