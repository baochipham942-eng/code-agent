// ============================================================================
// ProjectService.backfillSessions — 不可变边界冲突 WARN 聚合
// ============================================================================
//
// 启动归桶对同一批不可变边界冲突会话逐条打 warn，而这些会话会一直保持
// project_id 为空、每次开机被重新选出来，于是同一批告警反复刷屏。这里钉住
// 服务层聚合不变量：
//   - 整次调用只打一条聚合 WARN（skipped 数、至多 5 个示例 sessionId、去重原因）
//   - 逐会话明细降到 debug；N=0 时连聚合行也不打
//   - 归桶语义不变：健康会话照常归桶，冲突会话保持 project_id 为空
// 仓储层 onSkipped 回调契约见 tests/unit/services/ProjectRepository.test.ts。
// ============================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const logger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => logger,
}));

const databaseState = vi.hoisted(() => ({
  projectRepo: undefined as unknown,
}));

vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({
    getProjectRepo: () => databaseState.projectRepo,
  }),
}));

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';

import { applySchema } from '../../../src/host/services/core/database/schema';
import { applySessionsMigrations } from '../../../src/host/services/core/database/migrations';
import { applyIndexes } from '../../../src/host/services/core/database/indexes';
import { ProjectRepository } from '../../../src/host/services/core/repositories/ProjectRepository';
import { ProjectService } from '../../../src/host/services/project/projectService';

const NOW = 1_700_000_000_000;

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

function seedImmutableConflict(db: BetterSqlite3.Database, sessionId: string, immutableProjectId: string): void {
  db.prepare('INSERT INTO conversation_branches (session_id, project_id) VALUES (?, ?)')
    .run(sessionId, immutableProjectId);
}

function sessionProjectId(db: BetterSqlite3.Database, sessionId: string): string | null {
  const row = db.prepare('SELECT project_id FROM sessions WHERE id = ?').get(sessionId) as
    | { project_id: string | null }
    | undefined;
  return row?.project_id ?? null;
}

interface WarnEntry {
  message: string;
  payload: Record<string, unknown> | undefined;
}

function warnEntries(): WarnEntry[] {
  return logger.warn.mock.calls.map((call) => {
    const [message, payload] = call as [string, Record<string, unknown> | undefined];
    return { message, payload };
  });
}

describe('ProjectService.backfillSessions 冲突 WARN 聚合', () => {
  let db: BetterSqlite3.Database;
  let workspace: string;

  beforeEach(() => {
    vi.clearAllMocks();
    db = new Database(':memory:');
    applySchema(db, noopLogger);
    applySessionsMigrations(db, noopLogger); // 加 project_id 列（真实迁移路径）
    applyIndexes(db);
    db.exec('CREATE TABLE conversation_branches (session_id TEXT, project_id TEXT)');
    databaseState.projectRepo = new ProjectRepository(db);
    workspace = mkdtempSync(join(tmpdir(), 'proj-backfill-warn-agg-'));
  });

  afterEach(() => {
    db.close();
    rmSync(workspace, { recursive: true, force: true });
  });

  it('两次开机各打恰一条聚合 WARN，逐会话 warn 为 0，健康会话只在第一次归桶', () => {
    seedSession(db, 's_conflict_1', workspace, NOW);
    seedSession(db, 's_conflict_2', workspace, NOW);
    seedSession(db, 's_conflict_3', workspace, NOW);
    seedSession(db, 's_healthy', workspace, NOW);
    seedImmutableConflict(db, 's_conflict_1', 'proj_immutable_a');
    seedImmutableConflict(db, 's_conflict_2', 'proj_immutable_b');
    seedImmutableConflict(db, 's_conflict_3', 'proj_immutable_c');
    const service = new ProjectService();

    // ---- 第一次开机 ----
    const first = service.backfillSessions(NOW);
    const firstWarns = warnEntries();
    expect(first).toBe(1);
    expect(firstWarns).toHaveLength(1);
    expect(firstWarns[0].payload).toMatchObject({ skipped: 3 });
    expect(((firstWarns[0].payload?.sampleSessionIds as string[]) ?? []).sort()).toEqual([
      's_conflict_1',
      's_conflict_2',
      's_conflict_3',
    ]);
    const reasons = (firstWarns[0].payload?.reasons as string[]) ?? [];
    expect(reasons.length).toBeGreaterThan(0);
    expect(new Set(reasons).size).toBe(reasons.length); // 原因已去重
    for (const reason of reasons) {
      expect(reason).toContain('PROJECT_BOUNDARY_IMMUTABLE');
    }
    // 逐会话 warn 为 0：没有任何 warn 载荷携带单个 sessionId
    expect(firstWarns.filter((entry) => entry.payload && 'sessionId' in entry.payload)).toHaveLength(0);
    // 逐会话明细降到 debug
    expect(logger.debug.mock.calls).toHaveLength(3);
    // 冲突会话保持 project_id 为空，健康会话已归桶
    expect(sessionProjectId(db, 's_conflict_1')).toBeNull();
    expect(sessionProjectId(db, 's_conflict_2')).toBeNull();
    expect(sessionProjectId(db, 's_conflict_3')).toBeNull();
    const healthyProject = sessionProjectId(db, 's_healthy');
    expect(healthyProject).toBeTruthy();

    // ---- 第二次开机：冲突会话依旧空 project_id，会再次被选中并聚合 ----
    logger.warn.mockClear();
    const second = service.backfillSessions(NOW + 1);
    const secondWarns = warnEntries();
    expect(second).toBe(0);
    expect(secondWarns).toHaveLength(1);
    expect(secondWarns[0].payload).toMatchObject({ skipped: 3 });
    expect(secondWarns.filter((entry) => entry.payload && 'sessionId' in entry.payload)).toHaveLength(0);
    expect(sessionProjectId(db, 's_healthy')).toBe(healthyProject); // 只在第一次归桶
  });

  it('N=0（没有冲突会话）时不打任何 warn', () => {
    seedSession(db, 's_only_healthy', workspace, NOW);
    const service = new ProjectService();

    expect(service.backfillSessions(NOW)).toBe(1);
    expect(warnEntries()).toHaveLength(0);
  });
});
