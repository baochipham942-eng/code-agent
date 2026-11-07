// ============================================================================
// FB-772 真链验证：delegate_session 走真 resolver 路径
// （toolResolver.execute → buildProtocolContext → protocol handler → admission
// → commitDelegation），legacy ToolContext 携带真实 turnId。
//
// 钉的事实：持久化的 origin_turn_id 是真实轮 id，绝无 'unknown-turn'；同 origin
// session 同 target 跨两个轮的不同正文各自入队（旧行为：第二调用被 G4
// idempotency_conflict 误拒）。宿主服务（DB/运行登记表/信任评估等）指向内存
// SQLite 与桩，resolver 与工具注册表无 mock。
// ============================================================================

import Database from 'better-sqlite3';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.unmock('better-sqlite3');

// 注册期读一次开关（registerMigratedTools 默认参数），必须先于 protocolRegistry
// 的静态导入就位。
vi.hoisted(() => {
  process.env.CODE_AGENT_CROSS_SESSION_DELEGATION = '1';
});

const chainState = vi.hoisted(() => ({
  database: null as unknown,
}));

vi.mock('../../../../../src/host/observability/posthogNode', () => ({
  trackNode: vi.fn(),
}));
vi.mock('../../../../../src/host/services/infra/logger', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../../../../src/host/services/infra/logger')>();
  return {
    ...mod,
    createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
  };
});
// getDelegationToolRuntime 默认运行时的宿主服务缝：DB 指向内存 SQLite，
// 其余指向桩。resolver / shadowAdapter / registry / handler 全是真实现。
vi.mock('../../../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => chainState.database,
}));
vi.mock('../../../../../src/host/app/applicationRunRegistry', () => ({
  getApplicationRunRegistry: () => ({ list: () => [], getBySessionId: () => undefined }),
}));
vi.mock('../../../../../src/host/services/infra/sessionManager', () => ({
  getSessionManager: () => ({ createSession: vi.fn(async () => ({ id: 'unused' })) }),
}));
vi.mock('../../../../../src/host/services/project/projectService', () => ({
  getProjectService: () => ({ listProjects: () => [] }),
}));
vi.mock('../../../../../src/host/permissions/modes', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../../../../src/host/permissions/modes')>();
  return { ...mod, getPermissionModeManager: () => ({ getModeForSession: () => 'default' }) };
});
vi.mock('../../../../../src/host/security/folderTrustService', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../../../../src/host/security/folderTrustService')>();
  return { ...mod, evaluateFolderTrust: async () => ({ state: 'trusted', blockedItems: [] }) };
});
vi.mock('../../../../../src/host/services/delegation/delegationEnqueueSignal', () => ({
  notifyDelegationEnqueued: vi.fn(),
}));

// 真 protocol registry（registerMigratedTools 注册 delegate_session）
import '../../../../../src/host/tools/protocolRegistry';
import { applyTestSessionSchema } from '../../../../utils/applyTestSessionSchema';
import { SessionRepository } from '../../../../../src/host/services/core/repositories/SessionRepository';
import { getDelegationCandidateSecret } from '../../../../../src/host/services/delegation/delegationToolRuntime';
import { projectSessionCandidates } from '../../../../../src/host/services/delegation/delegationCandidates';
import { getToolResolver } from '../../../../../src/host/tools/dispatch/toolResolver';
import type { ToolContext } from '../../../../../src/host/tools/types';

function legacyCtxWithTurn(turnId: string): ToolContext {
  return {
    workingDirectory: '/workspace/origin',
    requestPermission: async () => true,
    sessionId: 'origin',
    runId: `run-for-${turnId}`,
    turnId,
    workspace: '/workspace/origin',
    workspaceScope: {
      projectId: 'p',
      primaryRoot: '/workspace/origin',
      roots: [{ sourceId: 's', path: '/workspace/origin', access: 'read_write', role: 'primary' }],
      version: '1',
    },
    abortSignal: new AbortController().signal,
  } as unknown as ToolContext;
}

describe('delegate_session 真链（resolver → protocol handler）origin_turn_id (FB-772)', () => {
  let db: InstanceType<typeof Database>;
  let repo: SessionRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    applyTestSessionSchema(db);
    db.prepare(`
      INSERT INTO sessions (id, title, model_provider, model_name, working_directory, session_type, created_at, updated_at)
      VALUES ('target', 'Target', 'local', 'test', '/workspace/origin', 'chat', 1, 100)
    `).run();
    repo = new SessionRepository(db);
    chainState.database = {
      getDb: () => db,
      getSession: (id: string, options?: { includeDeleted?: boolean }) => repo.getSession(id, options),
      listSessions: (limit: number, offset: number, includeArchived: boolean) => repo.listSessions(limit, offset, includeArchived),
    };
  });

  afterEach(() => {
    chainState.database = null;
    db.close();
  });

  afterAll(() => {
    delete process.env.CODE_AGENT_CROSS_SESSION_DELEGATION;
  });

  it('turn A 与 turn B 各委托一次（同 target 不同正文）→ 两行入队，origin_turn_id 为真实轮 id，绝无 unknown-turn', async () => {
    // 候选投影与运行时同源：真实 SessionRepository.listSessions 的行映射
    const candidateRows = repo.listSessions(10_000, 0, false).map((session) => ({
      id: session.id,
      title: session.title,
      workingDirectory: session.workingDirectory,
      updatedAt: session.updatedAt,
      sessionType: session.type,
      isArchived: session.status === 'archived',
      isDeleted: Boolean(session.isDeleted),
      engineKind: session.engine?.kind,
    }));
    const projection = projectSessionCandidates(candidateRows, { originSessionId: 'origin', now: 100, secret: getDelegationCandidateSecret() });
    const baseArgs = {
      action: 'delegate_existing',
      candidateSetId: projection.candidateSetId,
      candidateRef: projection.candidates[0].candidateRef,
    };

    const resolver = getToolResolver();
    const first = await resolver.execute('delegate_session', { ...baseArgs, text: 'first body' }, legacyCtxWithTurn('turn-AAAA'));
    const second = await resolver.execute('delegate_session', { ...baseArgs, text: 'second body' }, legacyCtxWithTurn('turn-BBBB'));

    expect(first.success).toBe(true);
    expect(first.metadata).toMatchObject({ status: 'active', target: 'Target' });
    expect(second.success).toBe(true);

    const rows = db.prepare('SELECT origin_turn_id, submission_key, target_session_id FROM session_delegations ORDER BY origin_turn_id').all() as Array<{
      origin_turn_id: string;
      submission_key: string;
      target_session_id: string;
    }>;
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.origin_turn_id)).toEqual(['turn-AAAA', 'turn-BBBB']);
    expect(rows.map((row) => row.origin_turn_id)).not.toContain('unknown-turn');
    expect(new Set(rows.map((row) => row.submission_key)).size).toBe(2);
    expect(rows.every((row) => row.target_session_id === 'target')).toBe(true);
    expect(db.prepare('SELECT count(*) AS count FROM queued_inputs').get()).toMatchObject({ count: 2 });
  });
});
