// ============================================================================
// MasterTaskRepository — MasterTask CRUD（master_tasks + master_task_plan_events）
// ============================================================================
//
// 用户级工作单元的持久化层（P1-c1）。schema 见
// `src/main/services/core/database/schema.ts` 的 master_tasks 段落以及
// `src/cli/database.ts` 同名段落（两侧对齐，共享同一个 ~/.code-agent/code-agent.db）。
//
// 双 DB 选源：见文件底部 getMasterTaskDb()，跟随
// `tools/modules/lightMemory/episodicRecall.ts` 的 pattern。后续 P1-c2
// MasterTaskManager 直接 `new MasterTaskRepository(getMasterTaskDb())`。
//
// 状态枚举 SSOT：`src/shared/contract/task.ts` 的 MasterTaskStatus +
// MASTER_TASK_TERMINAL_STATUSES。in-progress 判定走 Set，不硬列字面量。
// ============================================================================

import type BetterSqlite3 from 'better-sqlite3';
import type { MasterTaskStatus } from '../../../../shared/contract/task';
import { MASTER_TASK_TERMINAL_STATUSES } from '../../../../shared/contract/task';

// SQLite 行类型
type SQLiteRow = Record<string, unknown>;

/**
 * `in-progress` 派生自 SSOT 终态集合：所有 status 减去终态。
 * 文件加载时计算一次，避免每次 list 都遍历。
 */
const MASTER_TASK_IN_PROGRESS_STATUSES: readonly MasterTaskStatus[] = (
  [
    'created',
    'pending',
    'queued',
    'waiting',
    'running',
    'paused',
    'review',
    'completed',
    'done',
    'cancelled',
    'failed',
    'error',
  ] as MasterTaskStatus[]
).filter((s) => !MASTER_TASK_TERMINAL_STATUSES.has(s));

// ----------------------------------------------------------------------------
// 公共类型
// ----------------------------------------------------------------------------

export interface MasterTaskRow {
  id: string;
  title: string;
  status: MasterTaskStatus;
  workspaceUri: string;
  planProgress: string;
  sandboxId: string | null;
  parentTaskId: string | null;
  ownerUserId: string;
  blocks: string[];
  blockedBy: string[];
  metadata: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
  finishedAt: number | null;
  isDeleted: boolean;
}

export interface MasterTaskCreateInput {
  id: string;
  title: string;
  status: MasterTaskStatus;
  workspaceUri: string;
  planProgress?: string;
  sandboxId?: string | null;
  parentTaskId?: string | null;
  ownerUserId?: string;
  blocks?: string[];
  blockedBy?: string[];
  metadata?: Record<string, unknown>;
  createdAt?: number;
  updatedAt?: number;
  finishedAt?: number | null;
}

export interface MasterTaskListFilter {
  workspaceUri?: string;
  status?: MasterTaskStatus | MasterTaskStatus[];
  ownerUserId?: string;
  /**
   * true 时只返回非终态（用 MASTER_TASK_TERMINAL_STATUSES 派生）；
   * 与 status 同时存在时 status 优先。
   */
  inProgress?: boolean;
  /** 默认 false：list / getById 默认过滤 is_deleted = 1 */
  includeDeleted?: boolean;
  limit?: number;
  offset?: number;
}

export interface MasterTaskUpdateStatusOptions {
  updatedAt?: number;
  finishedAt?: number;
}

export interface MasterTaskPlanEvent {
  id: number;
  chunk: string;
  createdAt: number;
}

// ----------------------------------------------------------------------------
// JSON 序列化辅助 — 空 array/object 写 '[]' / '{}'，禁止写 'null'
// ----------------------------------------------------------------------------

function stringifyArray(value: string[] | undefined): string {
  if (!value || value.length === 0) return '[]';
  try {
    return JSON.stringify(value);
  } catch {
    return '[]';
  }
}

function stringifyObject(value: Record<string, unknown> | undefined): string {
  if (!value) return '{}';
  try {
    return JSON.stringify(value);
  } catch {
    return '{}';
  }
}

function parseArray(value: unknown): string[] {
  if (typeof value !== 'string' || value.length === 0) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function parseObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string' || value.length === 0) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function rowToMasterTask(row: SQLiteRow): MasterTaskRow {
  return {
    id: String(row.id),
    title: String(row.title ?? ''),
    status: row.status as MasterTaskStatus,
    workspaceUri: String(row.workspace_uri ?? ''),
    planProgress: String(row.plan_progress ?? ''),
    sandboxId: row.sandbox_id == null ? null : String(row.sandbox_id),
    parentTaskId: row.parent_task_id == null ? null : String(row.parent_task_id),
    ownerUserId: String(row.owner_user_id ?? 'local'),
    blocks: parseArray(row.blocks_json),
    blockedBy: parseArray(row.blocked_by_json),
    metadata: parseObject(row.metadata_json),
    createdAt: Number(row.created_at) || 0,
    updatedAt: Number(row.updated_at) || 0,
    finishedAt: row.finished_at == null ? null : Number(row.finished_at),
    isDeleted: Number(row.is_deleted) === 1,
  };
}

// ----------------------------------------------------------------------------
// MasterTaskRepository
// ----------------------------------------------------------------------------

export class MasterTaskRepository {
  constructor(private db: BetterSqlite3.Database) {}

  // --------------------------------------------------------------------------
  // CRUD
  // --------------------------------------------------------------------------

  create(input: MasterTaskCreateInput): MasterTaskRow {
    const createdAt = input.createdAt ?? Date.now();
    const updatedAt = input.updatedAt ?? createdAt;
    const finishedAt = input.finishedAt ?? null;

    this.db
      .prepare(
        `INSERT INTO master_tasks (
          id, title, status, workspace_uri, plan_progress,
          sandbox_id, parent_task_id, owner_user_id,
          blocks_json, blocked_by_json, metadata_json,
          created_at, updated_at, finished_at, is_deleted
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      )
      .run(
        input.id,
        input.title,
        input.status,
        input.workspaceUri,
        input.planProgress ?? '',
        input.sandboxId ?? null,
        input.parentTaskId ?? null,
        input.ownerUserId ?? 'local',
        stringifyArray(input.blocks),
        stringifyArray(input.blockedBy),
        stringifyObject(input.metadata),
        createdAt,
        updatedAt,
        finishedAt,
      );

    const row = this.getByIdInternal(input.id, { includeDeleted: true });
    if (!row) {
      throw new Error(`MasterTaskRepository.create: failed to read back row for id=${input.id}`);
    }
    return row;
  }

  getById(id: string, options?: { includeDeleted?: boolean }): MasterTaskRow | null {
    return this.getByIdInternal(id, options);
  }

  private getByIdInternal(id: string, options?: { includeDeleted?: boolean }): MasterTaskRow | null {
    const includeDeleted = options?.includeDeleted === true;
    const row = this.db
      .prepare(
        `SELECT * FROM master_tasks
          WHERE id = ?
            AND (? = 1 OR is_deleted = 0)`,
      )
      .get(id, includeDeleted ? 1 : 0) as SQLiteRow | undefined;
    return row ? rowToMasterTask(row) : null;
  }

  list(filter: MasterTaskListFilter = {}): MasterTaskRow[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (!filter.includeDeleted) {
      conditions.push('is_deleted = 0');
    }
    if (filter.workspaceUri) {
      conditions.push('workspace_uri = ?');
      params.push(filter.workspaceUri);
    }
    if (filter.ownerUserId) {
      conditions.push('owner_user_id = ?');
      params.push(filter.ownerUserId);
    }

    // status 优先；未指定但 inProgress=true 时按 in-progress 集合过滤
    if (filter.status !== undefined) {
      const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
      if (statuses.length > 0) {
        const placeholders = statuses.map(() => '?').join(',');
        conditions.push(`status IN (${placeholders})`);
        params.push(...statuses);
      }
    } else if (filter.inProgress === true) {
      const placeholders = MASTER_TASK_IN_PROGRESS_STATUSES.map(() => '?').join(',');
      conditions.push(`status IN (${placeholders})`);
      params.push(...MASTER_TASK_IN_PROGRESS_STATUSES);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    let sql = `SELECT * FROM master_tasks ${whereClause} ORDER BY updated_at DESC, id ASC`;

    if (filter.limit !== undefined) {
      sql += ` LIMIT ${Math.max(0, Math.floor(filter.limit))}`;
      if (filter.offset !== undefined) {
        sql += ` OFFSET ${Math.max(0, Math.floor(filter.offset))}`;
      }
    }

    const rows = this.db.prepare(sql).all(...params) as SQLiteRow[];
    return rows.map(rowToMasterTask);
  }

  /**
   * 跨 workspace 列出用户级所有 in-progress MasterTask。
   * 不传 ownerUserId 时默认 'local'（CLI 单用户场景）。
   */
  listInProgress(ownerUserId?: string): MasterTaskRow[] {
    return this.list({
      ownerUserId: ownerUserId ?? 'local',
      inProgress: true,
    });
  }

  updateStatus(id: string, status: MasterTaskStatus, opts: MasterTaskUpdateStatusOptions = {}): void {
    const updatedAt = opts.updatedAt ?? Date.now();
    // finishedAt：调用方显式传入时写入；未传则用 SQL COALESCE 保留旧值
    const finishedAt = opts.finishedAt;

    this.db
      .prepare(
        `UPDATE master_tasks
            SET status = ?,
                updated_at = ?,
                finished_at = COALESCE(?, finished_at)
          WHERE id = ?`,
      )
      .run(status, updatedAt, finishedAt ?? null, id);
  }

  updatePlanProgress(id: string, planProgress: string, updatedAt?: number): void {
    this.db
      .prepare(
        `UPDATE master_tasks
            SET plan_progress = ?, updated_at = ?
          WHERE id = ?`,
      )
      .run(planProgress, updatedAt ?? Date.now(), id);
  }

  softDelete(id: string, updatedAt?: number): void {
    this.db
      .prepare(
        `UPDATE master_tasks
            SET is_deleted = 1, updated_at = ?
          WHERE id = ?`,
      )
      .run(updatedAt ?? Date.now(), id);
  }

  // --------------------------------------------------------------------------
  // Plan events（append-only）
  // --------------------------------------------------------------------------

  appendPlanEvent(masterTaskId: string, chunk: string, createdAt?: number): void {
    this.db
      .prepare(
        `INSERT INTO master_task_plan_events (master_task_id, chunk, created_at)
         VALUES (?, ?, ?)`,
      )
      .run(masterTaskId, chunk, createdAt ?? Date.now());
  }

  listPlanEvents(masterTaskId: string): MasterTaskPlanEvent[] {
    const rows = this.db
      .prepare(
        `SELECT id, chunk, created_at
           FROM master_task_plan_events
          WHERE master_task_id = ?
          ORDER BY created_at ASC, id ASC`,
      )
      .all(masterTaskId) as SQLiteRow[];

    return rows.map((row) => ({
      id: Number(row.id) || 0,
      chunk: String(row.chunk ?? ''),
      createdAt: Number(row.created_at) || 0,
    }));
  }
}

// ----------------------------------------------------------------------------
// 双 DB 选源 helper
// ----------------------------------------------------------------------------

/**
 * duck-typed 最小接口 — Electron DatabaseService 与 CLIDatabaseService 都
 * 暴露 getDb(): better-sqlite3 Database | null
 */
interface RawDbProvider {
  getDb(): BetterSqlite3.Database | null;
}

/**
 * 运行时选 DB 源：CLI 模式走 CLIDatabaseService，主进程走 Electron DatabaseService。
 * 与 `src/main/tools/modules/lightMemory/episodicRecall.ts:getSearchableDatabase` 同 pattern。
 *
 * 返回的是底层 better-sqlite3 Database，repository 用 `new MasterTaskRepository(db)` 注入。
 * CLI bundle 不可用或 db 尚未初始化时返回 null，调用方负责回退/重试。
 */
export function getMasterTaskDb(): BetterSqlite3.Database | null {
  if (process.env.CODE_AGENT_CLI_MODE === 'true') {
    try {
      // 动态 require 避免 main → cli 的反向静态依赖
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const cliDbMod = require('../../../../cli/database') as {
        getCLIDatabase?: () => RawDbProvider & { isInitialized: boolean };
      };
      const cliDb = cliDbMod.getCLIDatabase?.();
      if (cliDb?.isInitialized) {
        return cliDb.getDb();
      }
    } catch {
      // CLI bundle 不可用时 fall through
    }
    return null;
  }

  // 主进程：动态 require 服务单例，避免循环依赖
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const services = require('../../../services') as {
      getDatabase?: () => RawDbProvider & { isReady: boolean };
    };
    const db = services.getDatabase?.();
    if (db?.isReady) {
      return db.getDb();
    }
  } catch {
    // ignore
  }
  return null;
}
