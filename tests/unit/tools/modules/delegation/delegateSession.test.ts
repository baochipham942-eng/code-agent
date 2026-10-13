import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.unmock('better-sqlite3');
import { applySchema } from '../../../../../src/host/services/core/database/schema';
import { SessionDelegationRepository } from '../../../../../src/host/services/core/repositories/SessionDelegationRepository';
import { QueuedInputRepository } from '../../../../../src/host/services/core/repositories/QueuedInputRepository';
import { commitDelegation } from '../../../../../src/host/services/delegation/delegationDelivery';
import { deriveActionFingerprint, deriveSubmissionKey } from '../../../../../src/host/services/delegation/delegationKeys';
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

  it('rework r2：同轮并行不同正文撞提交键，第二个不得回 status:active 成功回执（正文不静默丢弃）', async () => {
    process.env.CODE_AGENT_CROSS_SESSION_DELEGATION = '1';
    // 竞态形态：admission（前两次 getDb：幂等键查旧 + buildSnapshot）看到的是
    // 还没落委托行的 pre 库；提交（第三次 getDb）撞上并行赢家已落行的 post 库 ——
    // 同 submission_key、不同 actionFingerprint → commitDelegation 返回
    // idempotency_conflict，新正文没有入队。
    const open = () => {
      const handle = new Database(':memory:');
      applySchema(handle, { info() {}, warn() {}, error() {}, debug() {} } as never);
      return handle;
    };
    const pre = open();
    const post = open();
    const targetIdentity = 'session:target';
    const submissionKey = deriveSubmissionKey({ originSessionId: 'origin', originTurnId: 'turn-1', action: 'delegate_existing', targetIdentity });
    commitDelegation(post, {
      delegationId: 'winner', originSessionId: 'origin', originTurnId: 'turn-1', disposition: 'delegate_existing',
      targetSessionId: 'target', submissionKey,
      actionFingerprint: deriveActionFingerprint({ action: 'delegate_existing', targetIdentity, content: 'first body', attachmentRefs: [] }),
      envelope: { content: 'first body', sessionId: 'target' }, now: 1,
    });
    const now = 100;
    const sessions = [{ id: 'target', title: 'Target', workingDirectory: '/workspace/origin', updatedAt: now, sessionType: 'chat' as const, engineKind: 'native' }];
    const projection = projectSessionCandidates(sessions, { originSessionId: 'origin', now, secret: getDelegationCandidateSecret() });
    const notify = vi.fn();
    let dbCalls = 0;
    setRuntime({
      getDb: () => { dbCalls += 1; return dbCalls <= 2 ? pre : post; },
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
    const result = await executeDelegateSession({ action: 'delegate_existing', candidateSetId: projection.candidateSetId, candidateRef: projection.candidates[0].candidateRef, text: 'second body' }, ctx, async () => ({ allow: true }));
    if (result.ok !== false) throw new Error('idempotency_conflict must not be reported as a success receipt');
    expect(result.error).toContain('idempotency_conflict');
    // 冲突路径不得带成功副作用（赢家已通知过 drain，输家没入队任何东西）
    expect(notify).not.toHaveBeenCalled();
    // 赢家的正文没被顶掉，第二正文没有入队
    const stored = new QueuedInputRepository(post).getById('delegation:' + submissionKey);
    expect(JSON.parse(stored?.envelopeJson ?? '{}').content).toBe('first body');
    expect(post.prepare('SELECT count(*) AS count FROM queued_inputs').get()).toMatchObject({ count: 1 });
    pre.close();
    post.close();
  });

  // rework r3：G4 同指纹重放 ≠ 还能投。行已 stopped/aborted/superseded 时
  // 载荷永久暂停（INV-6 撤回不复活），回执必须照实报状态，不得硬编码 active。
  const commitFirstDelegation = (db: InstanceType<typeof Database>) => {
    const targetIdentity = 'session:target';
    const submissionKey = deriveSubmissionKey({ originSessionId: 'origin', originTurnId: 'turn-1', action: 'delegate_existing', targetIdentity });
    commitDelegation(db, {
      delegationId: 'd-1', originSessionId: 'origin', originTurnId: 'turn-1', disposition: 'delegate_existing',
      targetSessionId: 'target', submissionKey,
      actionFingerprint: deriveActionFingerprint({ action: 'delegate_existing', targetIdentity, content: 'do it', attachmentRefs: [] }),
      envelope: { content: 'do it', sessionId: 'target' }, now: 1,
    });
    return { targetIdentity, submissionKey };
  };

  it('rework r3：同指纹重放遇 active 委托 → 重用回执照实报 active，不重复入队', async () => {
    process.env.CODE_AGENT_CROSS_SESSION_DELEGATION = '1';
    const db = new Database(':memory:');
    applySchema(db, { info() {}, warn() {}, error() {}, debug() {} } as never);
    const now = 100;
    commitFirstDelegation(db);
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
    if (result.ok !== true) throw new Error('active reuse must stay a success receipt');
    expect(result.meta).toMatchObject({ delegationId: 'd-1', status: 'active' });
    expect(JSON.parse(result.output)).toMatchObject({ delegationId: 'd-1', status: 'active' });
    expect(db.prepare('SELECT count(*) AS count FROM queued_inputs').get()).toMatchObject({ count: 1 });
    expect(notify).not.toHaveBeenCalled();
    db.close();
  });

  it.each([
    ['stopped', (repo: SessionDelegationRepository, at: number) => repo.markStopped('d-1', { reason: 'user' }, at)],
    ['aborted', (repo: SessionDelegationRepository, at: number) => repo.markAborted('d-1', 'retracted_by_user', at)],
    ['superseded', (repo: SessionDelegationRepository, at: number) => repo.markSuperseded('d-1', at)],
  ] as const)('rework r3：同指纹重放遇已停委托 %s → 非成功回执照实报状态、不入新队', async (status, stop) => {
    process.env.CODE_AGENT_CROSS_SESSION_DELEGATION = '1';
    const db = new Database(':memory:');
    applySchema(db, { info() {}, warn() {}, error() {}, debug() {} } as never);
    const now = 100;
    commitFirstDelegation(db);
    stop(new SessionDelegationRepository(db), now + 1);
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
    if (result.ok !== false) throw new Error(`${status} reuse must not be reported as a success receipt`);
    expect(result.code).toBe('DELEGATION_REJECTED');
    expect(result.error).toContain('delegation_not_active');
    expect(result.error).toContain(status);
    // 不复活、不补投：队列与委托行都只有原来那一行，零成功副作用
    expect(db.prepare('SELECT count(*) AS count FROM queued_inputs').get()).toMatchObject({ count: 1 });
    expect(new SessionDelegationRepository(db).listByTargetSession('target')).toHaveLength(1);
    expect(new SessionDelegationRepository(db).get('d-1')?.status).toBe(status);
    expect(notify).not.toHaveBeenCalled();
    db.close();
  });
});
