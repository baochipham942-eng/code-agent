// ============================================================================
// 停车审批重启收口（D0 host 根因修复，2026-07-27）
// 判据：① 启动 hydrate 后 tool_approval / directory_access 残留 pending 必须
// fail-closed 拒绝；② 宿主已死的权限响应同样收尾，且只认停车类 kind、不碰 plan 行。
// ============================================================================

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';

import { PendingApprovalRepository } from '../../../src/host/services/core/repositories/PendingApprovalRepository';

const planAttach = vi.fn(() => 0);
const launchAttach = vi.fn(() => 0);
vi.mock('../../../src/host/agent/planApproval', () => ({
  getPlanApprovalGate: () => ({ attachPersistence: planAttach }),
}));
vi.mock('../../../src/host/agent/swarmLaunchApproval', () => ({
  getSwarmLaunchApprovalGate: () => ({ attachPersistence: launchAttach }),
}));

let repoRef: PendingApprovalRepository | null = null;
vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({
    getPendingApprovalRepo: () => {
      if (!repoRef) throw new Error('repo not ready');
      return repoRef;
    },
  }),
}));

import {
  hydrateApprovalGatesAtBoot,
  closeDeadParkedApproval,
} from '../../../src/host/agent/parkedApprovalHydration';

function createSchema(db: BetterSqlite3.Database): void {
  db.exec(`
    CREATE TABLE pending_approvals (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      agent_id TEXT,
      agent_name TEXT,
      coordinator_id TEXT,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL,
      submitted_at INTEGER NOT NULL,
      resolved_at INTEGER,
      feedback TEXT
    );
  `);
}

function seed(repo: PendingApprovalRepository, id: string, kind: string): void {
  repo.insert({
    id,
    kind: kind as never,
    agentId: null,
    agentName: null,
    coordinatorId: 'session-1',
    payload: { sessionId: 'session-1', tool: 'Bash' },
    submittedAt: 1_000,
  });
}

describe('parkedApprovalHydration', () => {
  let repo: PendingApprovalRepository;

  beforeEach(() => {
    const db = new Database(':memory:');
    createSchema(db);
    repo = new PendingApprovalRepository(db);
    repoRef = repo;
    vi.clearAllMocks();
  });

  it('启动 hydrate 把 tool_approval / directory_access 残留 pending 自动拒绝', () => {
    seed(repo, 'tool-1', 'tool_approval');
    seed(repo, 'dir-1', 'directory_access');
    seed(repo, 'plan-1', 'plan');

    const counts = hydrateApprovalGatesAtBoot(repo, 2_000);

    expect(counts.parked).toBe(2);
    expect(repo.getById('tool-1')).toMatchObject({
      status: 'rejected',
      resolvedAt: 2_000,
      feedback: expect.stringContaining('Auto-rejected'),
    });
    expect(repo.getById('dir-1')?.status).toBe('rejected');
    // plan 行归 plan gate 管（此处 gate 被 mock 成 no-op），本函数不得越权碰它
    expect(repo.getById('plan-1')?.status).toBe('pending');
    expect(planAttach).toHaveBeenCalledWith(repo, 2_000);
    expect(launchAttach).toHaveBeenCalledWith(repo, 2_000);
  });

  it('宿主已死的响应：closeDeadParkedApproval 收掉停车行并只成功一次', () => {
    seed(repo, 'tool-2', 'tool_approval');

    expect(closeDeadParkedApproval('tool-2', 3_000)).toBe(true);
    expect(repo.getById('tool-2')?.status).toBe('rejected');
    // 已收掉的行第二次响应（抢答/重复点击）不得再宣称成功
    expect(closeDeadParkedApproval('tool-2', 3_100)).toBe(false);
  });

  it('kind 守卫：plan 行与未知 id 一律不碰', () => {
    seed(repo, 'plan-2', 'plan');

    expect(closeDeadParkedApproval('plan-2', 3_000)).toBe(false);
    expect(repo.getById('plan-2')?.status).toBe('pending');
    expect(closeDeadParkedApproval('nonexistent', 3_000)).toBe(false);
  });

  it('启动时清理旧版本遗留的 orphaned 停车审批', () => {
    seed(repo, 'tool-old-orphan', 'tool_approval');
    repo.markPendingAsOrphaned('tool_approval', 1_500);

    const counts = hydrateApprovalGatesAtBoot(repo, 2_000);

    expect(counts.parked).toBe(1);
    expect(repo.getById('tool-old-orphan')?.status).toBe('rejected');
  });
});
