// ============================================================================
// ProjectRepository - 项目空间数据（projects + project_goals + project_roles 表）
// ============================================================================
//
// 纯 SQL CRUD（照 ExperimentRepository 模式）。ID 与时间戳由 ProjectService 生成
// 传入，repository 内禁止 Date.now()（遵守项目硬编码红线）。
// 设计：内部文档 §5.1
// ============================================================================

import type BetterSqlite3 from 'better-sqlite3';
import { getProjectKey } from '../../roleAssets/roleAssetPaths';
import {
  UNSORTED_PROJECT_ID,
  type Project,
  type ProjectGoal,
  type ProjectGoalStatus,
  type ProjectRoleLink,
  type ProjectSource,
  type ProjectSourceAccess,
  type ProjectSourceRole,
  type ProjectSourceTrustState,
  type ProjectStatus,
} from '../../../../shared/contract/project';
import {
  canonicalizeWorkspacePath,
  workspacePathIdentity,
} from '../../../runtime/workspaceScope';

type SQLiteRow = Record<string, unknown>;

function rowToProject(row: SQLiteRow): Project {
  return {
    id: row.id as string,
    name: row.name as string,
    workspacePath: (row.workspace_path as string) ?? null,
    workspaceKey: (row.workspace_key as string) ?? null,
    status: (row.status as ProjectStatus) || 'active',
    description: (row.description as string) || undefined,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
    archivedAt: (row.archived_at as number) ?? null,
    sourceRevision: Number(row.source_revision ?? 0),
  };
}

function rowToSource(row: SQLiteRow): ProjectSource {
  return {
    id: row.id as string,
    projectId: row.project_id as string,
    path: row.path as string,
    canonicalPath: row.canonical_path as string,
    role: row.role as ProjectSourceRole,
    access: row.access as ProjectSourceAccess,
    trustState: row.trust_state as ProjectSourceTrustState,
    identityDev: (row.identity_dev as string | null) ?? null,
    identityIno: (row.identity_ino as string | null) ?? null,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}

function rowToGoal(row: SQLiteRow): ProjectGoal {
  return {
    id: row.id as string,
    projectId: row.project_id as string,
    goal: row.goal as string,
    verify: (row.verify as string) ?? null,
    review: (row.review as string) ?? null,
    status: (row.status as ProjectGoalStatus) || 'active',
    lastRunSessionId: (row.last_run_session_id as string) ?? null,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}

export class ProjectRepository {
  constructor(private db: BetterSqlite3.Database) {}

  // --- projects ---

  upsertProject(p: Project): void {
    this.db.prepare(`
      INSERT INTO projects (id, name, workspace_path, workspace_key, status, description, is_deleted, created_at, updated_at, archived_at, source_revision)
      VALUES (@id, @name, @workspace_path, @workspace_key, @status, @description, 0, @created_at, @updated_at, @archived_at, @source_revision)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        workspace_path = excluded.workspace_path,
        workspace_key = excluded.workspace_key,
        status = excluded.status,
        description = excluded.description,
        updated_at = excluded.updated_at,
        archived_at = excluded.archived_at,
        source_revision = excluded.source_revision
    `).run({
      id: p.id,
      name: p.name,
      workspace_path: p.workspacePath ?? null,
      workspace_key: p.workspaceKey ?? null,
      status: p.status,
      description: p.description ?? null,
      created_at: p.createdAt,
      updated_at: p.updatedAt,
      archived_at: p.archivedAt ?? null,
      source_revision: p.sourceRevision ?? 0,
    });
  }

  // --- project_sources ---

  upsertSource(source: ProjectSource): void {
    this.db.prepare(`
      INSERT INTO project_sources (
        id, project_id, path, canonical_path, role, access, trust_state,
        identity_dev, identity_ino, created_at, updated_at
      ) VALUES (
        @id, @project_id, @path, @canonical_path, @role, @access, @trust_state,
        @identity_dev, @identity_ino, @created_at, @updated_at
      )
      ON CONFLICT(id) DO UPDATE SET
        path = excluded.path,
        canonical_path = excluded.canonical_path,
        role = excluded.role,
        access = excluded.access,
        trust_state = excluded.trust_state,
        identity_dev = excluded.identity_dev,
        identity_ino = excluded.identity_ino,
        updated_at = excluded.updated_at
    `).run({
      id: source.id,
      project_id: source.projectId,
      path: source.path,
      canonical_path: source.canonicalPath,
      role: source.role,
      access: source.access,
      trust_state: source.trustState,
      identity_dev: source.identityDev ?? null,
      identity_ino: source.identityIno ?? null,
      created_at: source.createdAt,
      updated_at: source.updatedAt,
    });
  }

  listSources(projectId: string): ProjectSource[] {
    return (this.db.prepare(`
      SELECT * FROM project_sources
      WHERE project_id = ?
      ORDER BY CASE role WHEN 'primary' THEN 0 ELSE 1 END, created_at ASC
    `).all(projectId) as SQLiteRow[]).map(rowToSource);
  }

  getSource(sourceId: string): ProjectSource | undefined {
    const row = this.db.prepare('SELECT * FROM project_sources WHERE id = ?').get(sourceId) as SQLiteRow | undefined;
    return row ? rowToSource(row) : undefined;
  }

  deleteSources(projectId: string): void {
    this.db.prepare('DELETE FROM project_sources WHERE project_id = ?').run(projectId);
  }

  replaceProjectSources(
    project: Project,
    sources: readonly ProjectSource[],
    expectedRevision: number,
  ): Project {
    const run = this.db.transaction(() => {
      const current = this.getProject(project.id);
      if (!current) throw new Error('Project not found.');
      if ((current.sourceRevision ?? 0) !== expectedRevision) {
        throw new Error(`Project Sources changed; expected revision ${expectedRevision}.`);
      }
      this.db.prepare('DELETE FROM project_sources WHERE project_id = ?').run(project.id);
      for (const source of sources) this.upsertSource(source);
      this.db.prepare(`
        UPDATE projects
        SET name = ?, description = ?, workspace_path = ?, workspace_key = ?,
            source_revision = source_revision + 1, updated_at = ?
        WHERE id = ?
      `).run(
        project.name,
        project.description ?? null,
        project.workspacePath ?? null,
        project.workspaceKey ?? null,
        project.updatedAt,
        project.id,
      );
      return this.getProject(project.id)!;
    });
    return run();
  }

  backfillProjectSources(now: number): number {
    const rows = this.db.prepare(`
      SELECT p.id, p.workspace_path, p.created_at
      FROM projects p
      WHERE p.id != ? AND COALESCE(TRIM(p.workspace_path), '') != ''
        AND NOT EXISTS (
          SELECT 1 FROM project_sources s
          WHERE s.project_id = p.id AND s.role = 'primary'
        )
    `).all(UNSORTED_PROJECT_ID) as SQLiteRow[];
    if (rows.length === 0) return 0;
    const run = this.db.transaction(() => {
      for (const row of rows) {
        const originalPath = String(row.workspace_path);
        const canonicalPath = canonicalizeWorkspacePath(originalPath);
        const identity = workspacePathIdentity(canonicalPath);
        this.upsertSource({
          id: `psrc_${String(row.id).replace(/^proj_/, '').slice(0, 12)}_primary`,
          projectId: String(row.id),
          path: originalPath,
          canonicalPath,
          role: 'primary',
          access: 'read_write',
          trustState: 'trusted',
          identityDev: identity.dev,
          identityIno: identity.ino,
          createdAt: Number(row.created_at ?? now),
          updatedAt: now,
        });
      }
      return rows.length;
    });
    return run();
  }

  getProject(id: string): Project | undefined {
    const row = this.db.prepare('SELECT * FROM projects WHERE id = ? AND is_deleted = 0').get(id) as SQLiteRow | undefined;
    return row ? rowToProject(row) : undefined;
  }

  getProjectByWorkspaceKey(key: string): Project | undefined {
    const row = this.db
      .prepare('SELECT * FROM projects WHERE workspace_key = ? AND is_deleted = 0')
      .get(key) as SQLiteRow | undefined;
    return row ? rowToProject(row) : undefined;
  }

  listProjects(includeArchived = false): Project[] {
    const sql = includeArchived
      ? 'SELECT * FROM projects WHERE is_deleted = 0 ORDER BY updated_at DESC'
      : "SELECT * FROM projects WHERE is_deleted = 0 AND status != 'archived' ORDER BY updated_at DESC";
    return (this.db.prepare(sql).all() as SQLiteRow[]).map(rowToProject);
  }

  setProjectStatus(id: string, status: ProjectStatus, updatedAt: number, archivedAt?: number | null): void {
    this.db
      .prepare('UPDATE projects SET status = ?, archived_at = ?, updated_at = ? WHERE id = ?')
      .run(status, status === 'archived' ? archivedAt ?? updatedAt : null, updatedAt, id);
  }

  renameProject(id: string, name: string, updatedAt: number): void {
    this.db.prepare('UPDATE projects SET name = ?, updated_at = ? WHERE id = ?').run(name, updatedAt, id);
  }

  setProjectDescription(id: string, description: string | null, updatedAt: number): void {
    this.db
      .prepare('UPDATE projects SET description = ?, updated_at = ? WHERE id = ?')
      .run(description, updatedAt, id);
  }

  touchProject(id: string, updatedAt: number): void {
    this.db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(updatedAt, id);
  }

  softDeleteProject(id: string, updatedAt: number): boolean {
    const r = this.db
      .prepare('UPDATE projects SET is_deleted = 1, updated_at = ? WHERE id = ?')
      .run(updatedAt, id);
    return r.changes > 0;
  }

  // --- project_goals ---

  insertGoal(goal: ProjectGoal): void {
    this.db.prepare(`
      INSERT INTO project_goals (id, project_id, goal, verify, review, status, last_run_session_id, created_at, updated_at)
      VALUES (@id, @project_id, @goal, @verify, @review, @status, @last_run_session_id, @created_at, @updated_at)
    `).run({
      id: goal.id,
      project_id: goal.projectId,
      goal: goal.goal,
      verify: goal.verify ?? null,
      review: goal.review ?? null,
      status: goal.status,
      last_run_session_id: goal.lastRunSessionId ?? null,
      created_at: goal.createdAt,
      updated_at: goal.updatedAt,
    });
  }

  listGoals(projectId: string): ProjectGoal[] {
    const rows = this.db
      .prepare('SELECT * FROM project_goals WHERE project_id = ? ORDER BY created_at ASC')
      .all(projectId) as SQLiteRow[];
    return rows.map(rowToGoal);
  }

  getGoal(goalId: string): ProjectGoal | undefined {
    const row = this.db.prepare('SELECT * FROM project_goals WHERE id = ?').get(goalId) as SQLiteRow | undefined;
    return row ? rowToGoal(row) : undefined;
  }

  updateGoalStatus(goalId: string, status: ProjectGoalStatus, updatedAt: number, lastRunSessionId?: string | null): void {
    if (lastRunSessionId !== undefined) {
      this.db
        .prepare('UPDATE project_goals SET status = ?, last_run_session_id = ?, updated_at = ? WHERE id = ?')
        .run(status, lastRunSessionId, updatedAt, goalId);
    } else {
      this.db
        .prepare('UPDATE project_goals SET status = ?, updated_at = ? WHERE id = ?')
        .run(status, updatedAt, goalId);
    }
  }

  // --- project_roles ---

  addRole(link: ProjectRoleLink): void {
    this.db
      .prepare('INSERT OR REPLACE INTO project_roles (project_id, role_id, joined_at) VALUES (?, ?, ?)')
      .run(link.projectId, link.roleId, link.joinedAt);
  }

  removeRole(projectId: string, roleId: string): boolean {
    const r = this.db
      .prepare('DELETE FROM project_roles WHERE project_id = ? AND role_id = ?')
      .run(projectId, roleId);
    return r.changes > 0;
  }

  listRoles(projectId: string): ProjectRoleLink[] {
    const rows = this.db
      .prepare('SELECT * FROM project_roles WHERE project_id = ? ORDER BY joined_at ASC')
      .all(projectId) as SQLiteRow[];
    return rows.map((row) => ({
      projectId: row.project_id as string,
      roleId: row.role_id as string,
      joinedAt: row.joined_at as number,
    }));
  }

  // --- sessions ↔ project ---

  assignSessionProject(sessionId: string, projectId: string): void {
    this.db.prepare('UPDATE sessions SET project_id = ? WHERE id = ?').run(projectId, sessionId);
  }

  listSessionIds(projectId: string): string[] {
    const rows = this.db
      .prepare('SELECT id FROM sessions WHERE project_id = ? AND is_deleted = 0 ORDER BY updated_at DESC')
      .all(projectId) as SQLiteRow[];
    return rows.map((r) => r.id as string);
  }

  /** 项目下的 session（含标题，用于产物列表标注来源），按更新时间倒序 */
  listProjectSessions(projectId: string): Array<{ id: string; title: string; updatedAt: number; workingDirectory?: string | null }> {
    const rows = this.db
      .prepare('SELECT id, title, updated_at, working_directory FROM sessions WHERE project_id = ? AND is_deleted = 0 ORDER BY updated_at DESC')
      .all(projectId) as SQLiteRow[];
    return rows.map((r) => ({
      id: r.id as string,
      title: (r.title as string) || '',
      updatedAt: r.updated_at as number,
      workingDirectory: (r.working_directory as string | null) || undefined,
    }));
  }

  /**
   * 回填归桶（D4）：把 project_id IS NULL 的存量 session 按 working_directory(缺则 workspace)
   * 算 hash 归入对应 project；无目录的归 UNSORTED_PROJECT_ID。幂等、单事务、不改 session 其它字段。
   * 返回归桶的 session 数。makeProjectRow 由 service 注入（带 id/时间戳生成）。
   *
   * 另修复归因只算一次的历史残留（#560 配套）：已冻在 UNSORTED 但其实有 working_directory
   * 的会话，若该目录**已存在**真实项目，则重新归桶。ponytail: 只绑已存在的真实项目，不为
   * 陈旧/一次性目录新建项目——启动期批量迁移保守优先，新会话侧 updateSession 已负责建桶。
   */
  backfillSessions(
    now: number,
    makeProjectRow: (workspacePath: string, key: string) => Project,
  ): number {
    const orphans = this.db
      .prepare(
        "SELECT id, working_directory, workspace FROM sessions WHERE project_id IS NULL AND is_deleted = 0",
      )
      .all() as SQLiteRow[];
    const strandedUnsorted = this.db
      .prepare(
        "SELECT id, working_directory, workspace FROM sessions WHERE project_id = ? AND is_deleted = 0 AND COALESCE(TRIM(working_directory), '') != ''",
      )
      .all(UNSORTED_PROJECT_ID) as SQLiteRow[];
    if (orphans.length === 0 && strandedUnsorted.length === 0) return 0;

    const ensureUnsorted = (): void => {
      const exists = this.db.prepare('SELECT id FROM projects WHERE id = ?').get(UNSORTED_PROJECT_ID);
      if (!exists) {
        this.upsertProject({
          id: UNSORTED_PROJECT_ID,
          name: '未分类',
          workspacePath: null,
          workspaceKey: null,
          status: 'idle',
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
        });
      }
    };

    const run = this.db.transaction(() => {
      let count = 0;
      const keyCache = new Map<string, string>(); // workspacePath → projectId
      for (const row of orphans) {
        const dir = ((row.working_directory as string) || (row.workspace as string) || '').trim();
        let projectId: string;
        if (!dir) {
          ensureUnsorted();
          projectId = UNSORTED_PROJECT_ID;
        } else if (keyCache.has(dir)) {
          projectId = keyCache.get(dir)!;
        } else {
          const key = getProjectKey(dir);
          const existing = this.getProjectByWorkspaceKey(key);
          if (existing) {
            projectId = existing.id;
          } else {
            const proj = makeProjectRow(dir, key);
            this.upsertProject(proj);
            projectId = proj.id;
          }
          keyCache.set(dir, projectId);
        }
        this.assignSessionProject(row.id as string, projectId);
        count++;
      }
      // 第二趟：把有 wd 但冻在 UNSORTED 的会话重归到**已存在**的真实项目
      for (const row of strandedUnsorted) {
        const dir = ((row.working_directory as string) || (row.workspace as string) || '').trim();
        if (!dir) continue;
        // 同事务内能查到 orphans 趟刚 upsert 的项目，无需借 keyCache
        const existing = this.getProjectByWorkspaceKey(getProjectKey(dir));
        if (existing && existing.id !== UNSORTED_PROJECT_ID) {
          this.assignSessionProject(row.id as string, existing.id);
          count++;
        }
      }
      return count;
    });

    return run();
  }
}
