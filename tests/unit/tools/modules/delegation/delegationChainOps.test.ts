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
  function setupCommittedDelegation() {
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
    return { db, key };
  }

  it('stop pauses a queued row and resume rechecks before unpausing', async () => {
    process.env.CODE_AGENT_CROSS_SESSION_DELEGATION = '1';
    const { db, key } = setupCommittedDelegation();
    const allow = async () => ({ allow: true as const });
    expect((await executeDelegateSession({ action: 'stop', delegationId: 'd-1' }, ctx, allow)).ok).toBe(true);
    expect(new SessionDelegationRepository(db).get('d-1')?.status).toBe('stopped');
    expect(new QueuedInputRepository(db).getById('delegation:' + key)?.pausedReason).toBe('delegation_stopped');
    expect((await executeDelegateSession({ action: 'resume', delegationId: 'd-1' }, ctx, allow)).ok).toBe(true);
    expect(new SessionDelegationRepository(db).get('d-1')?.status).toBe('active');
    db.close();
  });

  it('rework r1：stopped 委托的排队行被用户撤回后，resume 拒绝而不是报成功（任务不静默丢失）', async () => {
    process.env.CODE_AGENT_CROSS_SESSION_DELEGATION = '1';
    const { db, key } = setupCommittedDelegation();
    const queued = new QueuedInputRepository(db);
    const allow = async () => ({ allow: true as const });
    expect((await executeDelegateSession({ action: 'stop', delegationId: 'd-1' }, ctx, allow)).ok).toBe(true);
    // 用户把 paused 的委托排队行撤回：retract 生效，markAborted 对 stopped 源 no-op
    expect(queued.retract('delegation:' + key, 3)).toBe(true);
    const resumed = await executeDelegateSession({ action: 'resume', delegationId: 'd-1' }, ctx, allow);
    if (resumed.ok !== false) throw new Error('resume on a retracted row must not report success');
    expect(resumed.error).toContain('retracted');
    // 账本不静默翻 active：行不可投的事实对模型可见
    expect(new SessionDelegationRepository(db).get('d-1')?.status).toBe('stopped');
    db.close();
  });

  it('rework r1：排队行 failed 时 resume 同样早拒（只复活 queued 行）', async () => {
    process.env.CODE_AGENT_CROSS_SESSION_DELEGATION = '1';
    const { db, key } = setupCommittedDelegation();
    const queued = new QueuedInputRepository(db);
    const allow = async () => ({ allow: true as const });
    // 行在 sending 期间 stop（pauseQueued 够不着）→ 重试耗尽 markFailed
    expect(queued.markSending('delegation:' + key, 2)).toBe(true);
    expect((await executeDelegateSession({ action: 'stop', delegationId: 'd-1' }, ctx, allow)).ok).toBe(true);
    expect(queued.markFailed('delegation:' + key, 3)).toBe(true);
    expect(queued.getById('delegation:' + key)?.status).toBe('failed');
    const resumed = await executeDelegateSession({ action: 'resume', delegationId: 'd-1' }, ctx, allow);
    if (resumed.ok !== false) throw new Error('resume on a failed row must not report success');
    expect(resumed.error).toContain('failed');
    db.close();
  });

  it('correct supersede rollback：撤回/置 superseded 任一步失败都不留下半条链', async () => {
    process.env.CODE_AGENT_CROSS_SESSION_DELEGATION = '1';
    const { db, key } = setupCommittedDelegation();
    const allow = async () => ({ allow: true as const });
    const supersede = vi.spyOn(SessionDelegationRepository.prototype, 'markSuperseded')
      .mockImplementation(() => { throw new Error('injected supersede failure'); });

    try {
      await expect(executeDelegateSession({ action: 'correct', delegationId: 'd-1', text: 'corrected work' }, ctx, allow))
        .rejects.toThrow('injected supersede failure');
    } finally {
      supersede.mockRestore();
    }

    const delegationRows = new SessionDelegationRepository(db).listByTargetSession('target');
    const queuedRows = new QueuedInputRepository(db).listBySession('target');
    expect(delegationRows.filter((row) => row.status === 'active')).toHaveLength(1);
    expect(delegationRows).toHaveLength(1);
    expect(delegationRows[0]).toMatchObject({ delegationId: 'd-1', status: 'active' });
    expect(queuedRows.filter((row) => row.status === 'queued' && row.pausedReason === null)).toHaveLength(1);
    expect(new QueuedInputRepository(db).getById('delegation:' + key)).toMatchObject({ status: 'queued', pausedReason: null });
    db.close();
  });

  it('rework r2：同轮并行两个 correct 不同正文，第二个撞提交键必须拒（修正文本不静默丢失）', async () => {
    process.env.CODE_AGENT_CROSS_SESSION_DELEGATION = '1';
    const open = () => {
      const handle = new Database(':memory:');
      applySchema(handle, { info() {}, warn() {}, error() {}, debug() {} } as never);
      return handle;
    };
    const commitD1 = (handle: Database.Database) => {
      const fingerprint = deriveActionFingerprint({ action: 'delegate_existing', targetIdentity: 'session:target', content: 'work', attachmentRefs: [] });
      const key = deriveSubmissionKey({ originSessionId: 'origin', originTurnId: 'turn', action: 'delegate_existing', targetIdentity: 'session:target' });
      commitDelegation(handle, { delegationId: 'd-1', originSessionId: 'origin', originTurnId: 'turn', disposition: 'delegate_existing', targetSessionId: 'target', submissionKey: key, actionFingerprint: fingerprint, envelope: { content: 'work', sessionId: 'target' }, now: 1 });
      return key;
    };
    const base = {
      getSessionRow: () => ({ id: 'target', title: 'Target', workingDirectory: '/workspace', sessionType: 'chat', engineKind: 'native' }),
      getWorkspaceRoots: () => ['/workspace'], getRuns: () => [], getRun: () => undefined,
      getPermissionMode: () => 'default', evaluateFolderTrust: async () => ({ state: 'trusted', blockedItems: 0 }),
      now: () => 2,
    };
    const allow = async () => ({ allow: true as const });
    // 赢家先完整跑完 correct（correction A）：correct 委托行落 post 库、d-1 superseded
    const post = open();
    const originalKey = commitD1(post);
    setRuntime({ ...base, getDb: () => post, notifyEnqueued: () => {} });
    expect((await executeDelegateSession({ action: 'correct', delegationId: 'd-1', text: 'correction A' }, ctx, allow)).ok).toBe(true);
    const winnerDelegations = new SessionDelegationRepository(post).listByTargetSession('target');
    const winnerQueuedRows = new QueuedInputRepository(post).listBySession('target');
    // 输家竞态形态：admission（前两次 getDb）看到 d-1 还 active 的 pre 库，
    // 提交（第三次 getDb）撞上 post 库里赢家不同正文的 correct 委托行
    const pre = open();
    commitD1(pre);
    const notify = vi.fn();
    let dbCalls = 0;
    setRuntime({ ...base, getDb: () => { dbCalls += 1; return dbCalls <= 2 ? pre : post; }, notifyEnqueued: notify });
    const loser = await executeDelegateSession({ action: 'correct', delegationId: 'd-1', text: 'correction B' }, ctx, allow);
    if (loser.ok !== false) throw new Error('idempotency_conflict on correct must not be reported as a success receipt');
    expect(loser.error).toContain('idempotency_conflict');
    expect(notify).not.toHaveBeenCalled();
    // 赢家的修正正文仍是唯一入队内容；输家不能把已被赢家撤回的原始行再动一遍
    const correctKey = deriveSubmissionKey({ originSessionId: 'origin', originTurnId: 'turn', action: 'correct', targetIdentity: 'delegation:d-1' });
    const stored = new QueuedInputRepository(post).getById('delegation:' + correctKey);
    expect(JSON.parse(stored?.envelopeJson ?? '{}').content).toBe('correction A');
    expect(new QueuedInputRepository(post).getById('delegation:' + originalKey)?.status).toBe('retracted');
    expect(new SessionDelegationRepository(post).listByTargetSession('target')).toEqual(winnerDelegations);
    expect(new QueuedInputRepository(post).listBySession('target')).toEqual(winnerQueuedRows);
    pre.close();
    post.close();
  });

  // ---------------------------------------------------------------------------
  // ⑤ 的归属/状态口径：非本发起会话的 delegationId、状态不符 → 一律 invalid_call
  // ---------------------------------------------------------------------------
  it('delegationId from another origin session is invalid_call and writes nothing', async () => {
    process.env.CODE_AGENT_CROSS_SESSION_DELEGATION = '1';
    const { db } = setupCommittedDelegation();
    // 重签 d-1 的归属：直接落一行 origin=other-origin 的 active 委托
    const other = deriveSubmissionKey({ originSessionId: 'other-origin', originTurnId: 'turn', action: 'delegate_existing', targetIdentity: 'session:target' });
    commitDelegation(db, {
      delegationId: 'd-other', originSessionId: 'other-origin', originTurnId: 'turn', disposition: 'delegate_existing',
      targetSessionId: 'target', submissionKey: other,
      actionFingerprint: deriveActionFingerprint({ action: 'delegate_existing', targetIdentity: 'session:target', content: 'work', attachmentRefs: [] }),
      envelope: { content: 'work', sessionId: 'target' }, now: 1,
    });
    const allow = async () => ({ allow: true as const });
    for (const args of [
      { action: 'stop', delegationId: 'd-other' },
      { action: 'resume', delegationId: 'd-other' },
      { action: 'correct', delegationId: 'd-other', text: 'nope' },
    ]) {
      const result = await executeDelegateSession(args, ctx, allow);
      expect(result.ok, JSON.stringify(args)).toBe(false);
      expect((result as { code?: string }).code).toBe('DELEGATION_REJECTED');
      expect((result as { error: string }).error).toContain('invalid_call');
    }
    expect(new SessionDelegationRepository(db).get('d-other')?.status).toBe('active');
    expect(new SessionDelegationRepository(db).get('d-1')?.status).toBe('active');
    // 队列里只有两行预置（d-1 与 d-other 的提交各一行）：三次被拒的链上操作零新增
    expect(new QueuedInputRepository(db).listBySession('target')).toHaveLength(2);
    db.close();
  });

  it.each([
    { action: 'resume', delegationId: 'd-1', from: 'active', expectedNeed: 'stopped' },
    { action: 'stop', delegationId: 'd-1', from: 'stopped', expectedNeed: 'active' },
  ] as const)('status mismatch ($action on $from) is invalid_call', async ({ action, delegationId, from }) => {
    process.env.CODE_AGENT_CROSS_SESSION_DELEGATION = '1';
    const { db } = setupCommittedDelegation();
    if (from === 'stopped') new SessionDelegationRepository(db).markStopped('d-1', { reason: 'user' }, 2);
    const result = await executeDelegateSession({ action, delegationId }, ctx, async () => ({ allow: true as const }));
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toContain('invalid_call');
    expect(new SessionDelegationRepository(db).get('d-1')?.status).toBe(from);
    db.close();
  });

  it('stop cancels the active run by target_run_id and keeps foreign runs alone', async () => {
    process.env.CODE_AGENT_CROSS_SESSION_DELEGATION = '1';
    const { db } = setupCommittedDelegation();
    const delegations = new SessionDelegationRepository(db);
    delegations.backfillTargetRunId('d-1', 'run-d1');
    const cancel = vi.fn(async () => {});
    setRuntime({
      getDb: () => db,
      getSessionRow: () => ({ id: 'target', title: 'Target', workingDirectory: '/workspace', sessionType: 'chat', engineKind: 'native' }),
      getWorkspaceRoots: () => ['/workspace'], getRuns: () => [],
      getRun: (sessionId: string) => (sessionId === 'target'
        ? { context: { sessionId: 'target', runId: 'run-d1' }, cancel }
        : { context: { sessionId, runId: 'run-foreign' }, cancel }),
      getPermissionMode: () => 'default', evaluateFolderTrust: async () => ({ state: 'trusted', blockedItems: 0 }),
      now: () => 2, notifyEnqueued: () => {},
    });
    expect((await executeDelegateSession({ action: 'stop', delegationId: 'd-1' }, ctx, async () => ({ allow: true as const }))).ok).toBe(true);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledWith('user');
    expect(delegations.get('d-1')?.status).toBe('stopped');
    db.close();
  });

  it('resume with a busy target fails the delivery re-check and leaves the row stopped and paused', async () => {
    process.env.CODE_AGENT_CROSS_SESSION_DELEGATION = '1';
    const { db, key } = setupCommittedDelegation();
    const queued = new QueuedInputRepository(db);
    const allow = async () => ({ allow: true as const });
    expect((await executeDelegateSession({ action: 'stop', delegationId: 'd-1' }, ctx, allow)).ok).toBe(true);
    // 目标被用户自己的活跃 run 占着（对不上任何委托行的 target_run_id）
    setRuntime({
      getDb: () => db,
      getSessionRow: () => ({ id: 'target', title: 'Target', workingDirectory: '/workspace', sessionType: 'chat', engineKind: 'native' }),
      getWorkspaceRoots: () => ['/workspace'], getRuns: () => [],
      getRun: (sessionId: string) => ({ context: { sessionId, runId: 'user-run' } }),
      getPermissionMode: () => 'default', evaluateFolderTrust: async () => ({ state: 'trusted', blockedItems: 0 }),
      now: () => 3, notifyEnqueued: () => {},
    });
    const resumed = await executeDelegateSession({ action: 'resume', delegationId: 'd-1' }, ctx, allow);
    expect(resumed.ok).toBe(false);
    expect((resumed as { error: string }).error).toContain('target_busy');
    expect(new SessionDelegationRepository(db).get('d-1')?.status).toBe('stopped');
    expect(queued.getById('delegation:' + key)?.pausedReason).toBe('delegation_stopped');
    db.close();
  });
});
