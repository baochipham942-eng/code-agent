// ============================================================================
// ProjectRepository Tests — P0-2 项目空间容器
// ============================================================================
//
// 用真实 applySchema + applySessionsMigrations 建表，验证迁移路径与归桶逻辑。
// 设计：docs/designs/project-space.md
// ============================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';

import { applySchema } from '../../../src/main/services/core/database/schema';
import { applySessionsMigrations } from '../../../src/main/services/core/database/migrations';
import { applyIndexes } from '../../../src/main/services/core/database/indexes';
import { ProjectRepository } from '../../../src/main/services/core/repositories/ProjectRepository';
import { getProjectKey } from '../../../src/main/services/roleAssets/roleAssetPaths';
import { UNSORTED_PROJECT_ID, type Project } from '../../../src/shared/contract/project';

const noopLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Parameters<typeof applySchema>[1];

function seedSession(db: BetterSqlite3.Database, id: string, workingDir: string | null, now: number): void {
  db.prepare(`
    INSERT INTO sessions (id, title, model_provider, model_name, working_directory, created_at, updated_at)
    VALUES (?, ?, 'p', 'm', ?, ?, ?)
  `).run(id, `t_${id}`, workingDir, now, now);
}

function makeRow(workspacePath: string, key: string, now: number): Project {
  return {
    id: `proj_${key.slice(0, 8)}`,
    name: workspacePath.split('/').pop() || workspacePath,
    workspacePath,
    workspaceKey: key,
    status: 'active',
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
  };
}

describe('ProjectRepository', () => {
  let db: BetterSqlite3.Database;
  let repo: ProjectRepository;
  const NOW = 1_700_000_000_000;

  beforeEach(() => {
    db = new Database(':memory:');
    applySchema(db, noopLogger);
    applySessionsMigrations(db, noopLogger); // 加 project_id 列（真实迁移路径）
    applyIndexes(db);
    repo = new ProjectRepository(db);
  });

  afterEach(() => db.close());

  it('迁移后 sessions 表有 project_id 列', () => {
    const cols = (db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toContain('project_id');
  });

  it('upsert + 按 workspace_key 查回', () => {
    const p = makeRow('/work/alpha', getProjectKey('/work/alpha'), NOW);
    repo.upsertProject(p);
    expect(repo.getProjectByWorkspaceKey(p.workspaceKey!)?.id).toBe(p.id);
    expect(repo.getProject(p.id)?.name).toBe('alpha');
  });

  it('多 goal 并行：一个项目可挂多条 active goal', () => {
    const p = makeRow('/work/alpha', getProjectKey('/work/alpha'), NOW);
    repo.upsertProject(p);
    repo.insertGoal({ id: 'g1', projectId: p.id, goal: '目标一', verify: null, review: null, status: 'active', lastRunSessionId: null, createdAt: NOW, updatedAt: NOW });
    repo.insertGoal({ id: 'g2', projectId: p.id, goal: '目标二', verify: 'exit 0', review: null, status: 'active', lastRunSessionId: null, createdAt: NOW + 1, updatedAt: NOW + 1 });
    const goals = repo.listGoals(p.id);
    expect(goals).toHaveLength(2);
    expect(goals.filter((g) => g.status === 'active')).toHaveLength(2);
    repo.updateGoalStatus('g1', 'met', NOW + 2, 'sess_x');
    expect(repo.getGoal('g1')?.status).toBe('met');
    expect(repo.getGoal('g1')?.lastRunSessionId).toBe('sess_x');
    expect(repo.getGoal('g2')?.status).toBe('active'); // 不互相影响
  });

  it('角色入驻 / 退出（D6）', () => {
    const p = makeRow('/work/alpha', getProjectKey('/work/alpha'), NOW);
    repo.upsertProject(p);
    repo.addRole({ projectId: p.id, roleId: '数据分析师', joinedAt: NOW });
    repo.addRole({ projectId: p.id, roleId: '研究员', joinedAt: NOW + 1 });
    expect(repo.listRoles(p.id).map((r) => r.roleId)).toEqual(['数据分析师', '研究员']);
    expect(repo.removeRole(p.id, '研究员', )).toBe(true);
    expect(repo.listRoles(p.id).map((r) => r.roleId)).toEqual(['数据分析师']);
  });

  it('backfill 归桶：同目录归同项目（1:1 绑定），异目录归不同项目', () => {
    seedSession(db, 's1', '/work/alpha', NOW);
    seedSession(db, 's2', '/work/alpha', NOW); // 同目录
    seedSession(db, 's3', '/work/beta', NOW); // 异目录
    const migrated = repo.backfillSessions(NOW, (wp, key) => makeRow(wp, key, NOW));
    expect(migrated).toBe(3);

    const alpha = repo.getProjectByWorkspaceKey(getProjectKey('/work/alpha'))!;
    const beta = repo.getProjectByWorkspaceKey(getProjectKey('/work/beta'))!;
    expect(alpha.id).not.toBe(beta.id);
    expect(repo.listSessionIds(alpha.id).sort()).toEqual(['s1', 's2']);
    expect(repo.listSessionIds(beta.id)).toEqual(['s3']);
  });

  it('backfill 归桶：无 working_directory 的存量 session 归入 UNSORTED', () => {
    seedSession(db, 's_orphan', null, NOW);
    const migrated = repo.backfillSessions(NOW, (wp, key) => makeRow(wp, key, NOW));
    expect(migrated).toBe(1);
    expect(repo.getProject(UNSORTED_PROJECT_ID)).toBeDefined();
    expect(repo.listSessionIds(UNSORTED_PROJECT_ID)).toEqual(['s_orphan']);
  });

  it('backfill 幂等：再次运行不重复归桶（已归桶 session 不再 NULL）', () => {
    seedSession(db, 's1', '/work/alpha', NOW);
    expect(repo.backfillSessions(NOW, (wp, key) => makeRow(wp, key, NOW))).toBe(1);
    expect(repo.backfillSessions(NOW, (wp, key) => makeRow(wp, key, NOW))).toBe(0); // 第二次没有 NULL project_id 的 session
  });

  it('backfill 不破坏存量：session 其它字段不变', () => {
    seedSession(db, 's1', '/work/alpha', NOW);
    repo.backfillSessions(NOW, (wp, key) => makeRow(wp, key, NOW));
    const row = db.prepare('SELECT title, working_directory FROM sessions WHERE id = ?').get('s1') as { title: string; working_directory: string };
    expect(row.title).toBe('t_s1');
    expect(row.working_directory).toBe('/work/alpha');
  });

  it('归档项目：listProjects 默认不含 archived，includeArchived 才含', () => {
    const p = makeRow('/work/alpha', getProjectKey('/work/alpha'), NOW);
    repo.upsertProject(p);
    repo.setProjectStatus(p.id, 'archived', NOW + 1, NOW + 1);
    expect(repo.listProjects(false).find((x) => x.id === p.id)).toBeUndefined();
    expect(repo.listProjects(true).find((x) => x.id === p.id)).toBeDefined();
  });
});
