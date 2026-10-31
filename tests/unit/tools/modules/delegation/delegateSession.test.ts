import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.unmock('better-sqlite3');

// ADR-072 E6 打点：捕获 PostHog 与 host log 的结局记录（两处都 mock，测试不写真日志）。
const loggerInfo = vi.hoisted(() => vi.fn());
const trackNodeCalls: Array<{ event: string; properties?: Record<string, unknown> }> = [];
vi.mock('../../../../../src/host/observability/posthogNode', () => ({
  trackNode: vi.fn((event: string, properties?: Record<string, unknown>) => {
    trackNodeCalls.push({ event, properties });
  }),
}));
vi.mock('../../../../../src/host/services/infra/logger', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../../../../src/host/services/infra/logger')>();
  return {
    ...mod,
    createLogger: () => ({ info: loggerInfo, warn: () => {}, error: () => {}, debug: () => {} }),
  };
});

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
  trackNodeCalls.length = 0;
  loggerInfo.mockClear();
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

// ============================================================================
// 逐码拒绝表（④）：每个拒绝码都走完整 executeDelegateSession 管线，断言
// 结构化拒绝 + AskUserQuestion 追问话术 + 零落行（不产出 create_new、不绑定会话）。
// 纯门（K1B admitDelegation）已有逐码单测；这里钉的是工具边界把它们全部翻成
// 同一个结构化拒绝形状，任何一条路径都不静默转成 create_new。
// ============================================================================
describe('delegate_session rejection codes (per-code, full pipeline)', () => {
  const bareCtx = {
    sessionId: 'origin', turnId: 'turn-1', workingDir: '/workspace/origin',
    modelConfig: { provider: 'local', model: 'test' },
    abortSignal: new AbortController().signal,
  } as never;
  const setBareRuntime = (value: unknown) => {
    (bareCtx as unknown as { delegationRuntime?: unknown }).delegationRuntime = value;
  };

  function fixture(overrides: Record<string, unknown> = {}) {
    const db = new Database(':memory:');
    applySchema(db, { info() {}, warn() {}, error() {}, debug() {} } as never);
    const now = 100;
    const sessions = [{ id: 'target', title: 'Target', workingDirectory: '/workspace/origin', updatedAt: now, sessionType: 'chat' as const, engineKind: 'native' }];
    const runtime = {
      getDb: () => db,
      listSessions: () => sessions,
      getSessionRow: (id: string) => (id === 'target' || id === 'origin')
        ? { id, title: id === 'target' ? 'Target' : 'Origin', workingDirectory: '/workspace/origin', sessionType: 'chat', engineKind: 'native' }
        : null,
      getWorkspaceRoots: () => ['/workspace'],
      getRuns: () => [] as Array<{ context: { sessionId: string; workspace?: string } }>,
      getRun: () => undefined,
      getPermissionMode: () => 'default',
      evaluateFolderTrust: async () => ({ state: 'trusted', blockedItems: 0 }),
      notifyEnqueued: () => {},
      now: () => now,
      ...overrides,
    };
    const projection = projectSessionCandidates(sessions, { originSessionId: 'origin', now, secret: getDelegationCandidateSecret() });
    return { db, now, runtime, projection };
  }

  type Case = {
    code: string;
    /** 在哪个 ctx 上调（bareCtx 无 workspaceScope，供 G8 用）。 */
    useBareCtx?: boolean;
    /** 预置的委托行数（self_route 的 correct 需要一行 active 目标=origin 的链）。 */
    presetRows?: number;
    build: (fixed: ReturnType<typeof fixture>) => { args: Record<string, unknown>; runtime: Record<string, unknown> };
  };

  const cases: Case[] = [
    {
      code: 'ambiguous',
      build: (fixed) => ({ args: { action: 'delegate_existing', candidateRef: 'no-such-ref', text: 'do it' }, runtime: fixed.runtime }),
    },
    {
      code: 'candidate_set_stale',
      build: (fixed) => ({ args: { action: 'delegate_existing', candidateSetId: 'stale-set', candidateRef: 'whatever', text: 'do it' }, runtime: fixed.runtime }),
    },
    {
      code: 'invalid_call',
      build: (fixed) => ({ args: { action: 'restart', delegationId: 'd-1' }, runtime: fixed.runtime }),
    },
    {
      code: 'invalid_call',
      build: (fixed) => ({ args: { action: 'delegate_existing', sessionId: 'target', candidateRef: 'r', text: 'do it' }, runtime: fixed.runtime }),
    },
    {
      code: 'invalid_call',
      build: (fixed) => ({ args: { action: 'create_new', workspace: '/etc', text: 'do it' }, runtime: fixed.runtime }),
    },
    {
      code: 'invalid_call',
      build: (fixed) => ({ args: { action: 'stop' }, runtime: fixed.runtime }),
    },
    {
      code: 'target_unavailable',
      build: (fixed) => ({
        args: { action: 'delegate_existing', candidateRef: fixed.projection.candidates[0].candidateRef, text: 'do it' },
        runtime: { ...fixed.runtime, getSessionRow: (id: string) => (id === 'target' ? { id, workingDirectory: '/workspace/origin', sessionType: 'chat', engineKind: 'native', isArchived: true } : null) },
      }),
    },
    {
      code: 'not_delegatable',
      build: (fixed) => ({
        args: { action: 'delegate_existing', candidateRef: fixed.projection.candidates[0].candidateRef, text: 'do it' },
        runtime: { ...fixed.runtime, getSessionRow: (id: string) => (id === 'target' ? { id, workingDirectory: '/workspace/origin', sessionType: 'chat', engineKind: 'codex_cli' } : null) },
      }),
    },
    {
      code: 'workspace_boundary',
      build: (fixed) => ({
        args: { action: 'delegate_existing', candidateRef: fixed.projection.candidates[0].candidateRef, text: 'do it' },
        runtime: {
          ...fixed.runtime,
          listSessions: () => [{ id: 'target', title: 'Target', workingDirectory: '/outside/target', updatedAt: fixed.now, sessionType: 'chat' as const, engineKind: 'native' }],
          getSessionRow: (id: string) => (id === 'target' ? { id, workingDirectory: '/outside/target', sessionType: 'chat', engineKind: 'native' } : null),
        },
      }),
    },
    {
      code: 'write_conflict',
      build: (fixed) => ({
        args: { action: 'delegate_existing', candidateRef: fixed.projection.candidates[0].candidateRef, text: 'do it' },
        runtime: { ...fixed.runtime, getRuns: () => [{ context: { sessionId: 'bystander', workspace: '/workspace/origin' } }] },
      }),
    },
    {
      // create_new 缺 host 受信工作区根：G5（根不可解析）排在 G8 前面先红，
      // 工具边界上这个形态落到 workspace_boundary；G8 的 unauthorized_workspace
      // 码由 K1B admitDelegation 逐码单测直接覆盖（见 delegationAdmission.test.ts）。
      code: 'workspace_boundary',
      useBareCtx: true,
      build: (fixed) => ({ args: { action: 'create_new', text: 'fresh work' }, runtime: fixed.runtime }),
    },
    {
      code: 'target_busy',
      build: (fixed) => ({
        args: { action: 'delegate_existing', candidateRef: fixed.projection.candidates[0].candidateRef, text: 'do it' },
        runtime: { ...fixed.runtime, getRun: (id: string) => (id === 'target' ? { context: { sessionId: 'target', runId: 'user-run' } } : undefined) },
      }),
    },
    {
      code: 'target_permission_mode',
      build: (fixed) => ({
        args: { action: 'delegate_existing', candidateRef: fixed.projection.candidates[0].candidateRef, text: 'do it' },
        runtime: { ...fixed.runtime, getPermissionMode: () => 'bypassPermissions' },
      }),
    },
    {
      code: 'untrusted_workspace',
      build: (fixed) => ({
        args: { action: 'delegate_existing', candidateRef: fixed.projection.candidates[0].candidateRef, text: 'do it' },
        runtime: { ...fixed.runtime, evaluateFolderTrust: async () => ({ state: 'quarantined', blockedItems: 3 }) },
      }),
    },
    {
      code: 'self_route',
      presetRows: 1,
      build: (fixed) => ({ args: { action: 'correct', delegationId: 'd-self', text: 'again' }, runtime: fixed.runtime }),
    },
    {
      code: 'invalid_call',
      build: (fixed) => ({ args: { action: 'delegate_existing', candidateRef: 'r', text: 'do it' }, runtime: { ...fixed.runtime, listSessions: () => { throw new Error('sessions table is unavailable'); } } }),
    },
  ];

  it.each(cases)('$code → 结构化拒绝 + AskUserQuestion 话术 + 零落行', async (testCase) => {
    process.env.CODE_AGENT_CROSS_SESSION_DELEGATION = '1';
    const fixed = fixture();
    const { args, runtime } = testCase.build(fixed);
    const target = testCase.useBareCtx ? bareCtx : ctx;
    const setTargetRuntime = testCase.useBareCtx ? setBareRuntime : setRuntime;
    setTargetRuntime(runtime);
    if (testCase.presetRows) {
      const identity = 'session:origin';
      commitDelegation(fixed.db, {
        delegationId: 'd-self', originSessionId: 'origin', originTurnId: 'turn-1', disposition: 'delegate_existing',
        targetSessionId: 'origin', submissionKey: deriveSubmissionKey({ originSessionId: 'origin', originTurnId: 'turn-1', action: 'delegate_existing', targetIdentity: identity }),
        actionFingerprint: deriveActionFingerprint({ action: 'delegate_existing', targetIdentity: identity, content: 'do it', attachmentRefs: [] }),
        envelope: { content: 'do it', sessionId: 'origin' }, now: 1,
      });
    }
    try {
      const result = await executeDelegateSession(args, target, async () => ({ allow: true }));
      expect(result.ok, `${testCase.code} must be a rejection`).toBe(false);
      expect((result as { code?: string }).code).toBe('DELEGATION_REJECTED');
      const error = (result as { error: string }).error;
      expect(error.startsWith(`${testCase.code}:`)).toBe(true);
      expect(error).toContain('AskUserQuestion');
      expect(error).toContain('do not retry with create_new');
      // 零落行：委托行与排队行都只有预置的存量（预置提交各带一行排队），本调用不新增任何行
      const expectedRows = testCase.presetRows ?? 0;
      expect(fixed.db.prepare('SELECT count(*) AS count FROM session_delegations').get()).toMatchObject({ count: expectedRows });
      expect(fixed.db.prepare('SELECT count(*) AS count FROM queued_inputs').get()).toMatchObject({ count: expectedRows });
      expect(fixed.db.prepare('SELECT count(*) AS count FROM sessions').get()).toMatchObject({ count: 0 });
    } finally {
      setTargetRuntime(undefined);
      fixed.db.close();
    }
  });

  afterEach(() => {
    delete process.env.CODE_AGENT_CROSS_SESSION_DELEGATION;
    setBareRuntime(undefined);
  });
});

// ============================================================================
// ADR-072 E6 结局打点：每个到达工具体的调用记录恰好一次（PostHog
// DELEGATE_SESSION_OUTCOME + host log '[DelegateSession] outcome'），属性恰好
// outcome/code/gate/action 四个；FEATURE_DISABLED / PERMISSION_DENIED 不记录；
// 任何记录都不携带用户内容。
// ============================================================================
describe('delegate_session outcome telemetry (ADR-072 E6)', () => {
  it('a) admission rejection records exactly one outcome with the real gate (meta carries code+gate)', async () => {
    process.env.CODE_AGENT_CROSS_SESSION_DELEGATION = '1';
    setRuntime({ listSessions: () => [], now: () => 1 });
    const result = await executeDelegateSession({ action: 'delegate_existing', candidateSetId: 'stale', candidateRef: 'ref', text: 'do it' }, ctx, async () => ({ allow: true }));
    expect(result.ok).toBe(false);
    expect(result.meta).toEqual({ code: 'candidate_set_stale', gate: 'G3' });
    expect(trackNodeCalls).toHaveLength(1);
    expect(trackNodeCalls[0].event).toBe('delegate_session_outcome');
    expect(trackNodeCalls[0].properties).toEqual({ outcome: 'rejected', code: 'candidate_set_stale', gate: 'G3', action: 'delegate_existing' });
    expect(loggerInfo).toHaveBeenCalledTimes(1);
    expect(loggerInfo).toHaveBeenCalledWith('[DelegateSession] outcome', { outcome: 'rejected', code: 'candidate_set_stale', gate: 'G3', action: 'delegate_existing' });
  });

  it('b) parse failure records invalid_call with gate none and action unknown', async () => {
    process.env.CODE_AGENT_CROSS_SESSION_DELEGATION = '1';
    setRuntime({ listSessions: () => [], now: () => 1 });
    const result = await executeDelegateSession({ action: 'bogus-action' }, ctx, async () => ({ allow: true }));
    expect(result).toMatchObject({ ok: false, code: 'DELEGATION_REJECTED' });
    expect(result.meta).toEqual({ code: 'invalid_call', gate: 'none' });
    expect(trackNodeCalls).toHaveLength(1);
    expect(trackNodeCalls[0].properties).toEqual({ outcome: 'rejected', code: 'invalid_call', gate: 'none', action: 'unknown' });
  });

  it('c) successful create_new records outcome ok', async () => {
    process.env.CODE_AGENT_CROSS_SESSION_DELEGATION = '1';
    const db = new Database(':memory:');
    applySchema(db, { info() {}, warn() {}, error() {}, debug() {} } as never);
    const createSession = vi.fn(async (input: { commit?: (write: () => void) => void }) => {
      input.commit?.(() => {});
      return { id: 'session_new' };
    });
    setRuntime({
      getDb: () => db,
      getSessionRow: () => null,
      getWorkspaceRoots: () => ['/workspace'],
      getRuns: () => [],
      getRun: () => undefined,
      getPermissionMode: () => 'default',
      evaluateFolderTrust: async () => ({ state: 'trusted', blockedItems: 0 }),
      notifyEnqueued: () => {},
      randomId: (prefix: string) => `${prefix}new1`,
      now: () => 100,
      getSessionManager: () => ({ createSession }),
    });
    try {
      const result = await executeDelegateSession({ action: 'create_new', content: 'fresh work' }, ctx, async () => ({ allow: true }));
      expect(result.ok).toBe(true);
      expect(trackNodeCalls).toHaveLength(1);
      expect(trackNodeCalls[0].event).toBe('delegate_session_outcome');
      expect(trackNodeCalls[0].properties).toEqual({ outcome: 'ok', code: 'ok', gate: 'none', action: 'create_new' });
    } finally {
      db.close();
    }
  });

  it('d) FEATURE_DISABLED records nothing', async () => {
    setRuntime({ listSessions: () => [], now: () => 1 });
    const result = await executeDelegateSession({ action: 'create_new', content: 'x' }, ctx, async () => ({ allow: true }));
    expect(result).toMatchObject({ ok: false, code: 'FEATURE_DISABLED' });
    expect(trackNodeCalls).toHaveLength(0);
    expect(loggerInfo).not.toHaveBeenCalled();
  });

  it('d2) PERMISSION_DENIED records nothing', async () => {
    process.env.CODE_AGENT_CROSS_SESSION_DELEGATION = '1';
    setRuntime({ listSessions: () => [], now: () => 1 });
    const result = await executeDelegateSession({ action: 'create_new', content: 'x' }, ctx, async () => ({ allow: false, reason: 'denied' }));
    expect(result).toMatchObject({ ok: false, code: 'PERMISSION_DENIED' });
    expect(trackNodeCalls).toHaveLength(0);
    expect(loggerInfo).not.toHaveBeenCalled();
  });

  it('e) recorded properties never contain the user content string', async () => {
    process.env.CODE_AGENT_CROSS_SESSION_DELEGATION = '1';
    const marker = 'E6-LEAK-MARKER-7f3a9c';
    setRuntime({ listSessions: () => [], now: () => 1 });
    const result = await executeDelegateSession({ action: 'delegate_existing', candidateSetId: 'stale', candidateRef: 'ref', text: `secret body ${marker}` }, ctx, async () => ({ allow: true }));
    expect(result.ok).toBe(false);
    expect(trackNodeCalls).toHaveLength(1);
    const serialized = JSON.stringify({ track: trackNodeCalls, log: loggerInfo.mock.calls });
    expect(serialized).not.toContain(marker);
    expect(serialized).not.toContain('secret body');
    expect((result as { error: string }).error).toContain('candidate_set_stale');
  });
});
