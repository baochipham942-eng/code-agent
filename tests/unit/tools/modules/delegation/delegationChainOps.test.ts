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
});
