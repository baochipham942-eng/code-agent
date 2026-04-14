// ============================================================================
// PendingApprovalRepository — ADR-010 #2
// ============================================================================
//
// 一张 `pending_approvals` 表统一持久化两类 gate 的待决请求。
// kind 列区分 plan / launch；payload_json 存完整序列化的 PlanSubmission /
// SwarmLaunchRequest 用于 hydrate 时回填 gate 的内存 Map。
//
// 写入路径要求 fire-and-forget 不阻塞主流程，外层 gate 在自身的 try/catch
// 里调用本 repo 的方法。本 repo 内部不做异步调度，只做同步 SQLite 操作。
// ============================================================================

import type BetterSqlite3 from 'better-sqlite3';
import type {
  PendingApprovalKind,
  PendingApprovalRecord,
  PendingApprovalStatus,
} from '../../../../shared/contract/pendingApproval';

type SQLiteRow = Record<string, unknown>;

function rowToRecord(row: SQLiteRow): PendingApprovalRecord {
  return {
    id: String(row.id),
    kind: row.kind as PendingApprovalKind,
    agentId: row.agent_id == null ? null : String(row.agent_id),
    agentName: row.agent_name == null ? null : String(row.agent_name),
    coordinatorId: row.coordinator_id == null ? null : String(row.coordinator_id),
    payloadJson: String(row.payload_json ?? ''),
    status: row.status as PendingApprovalStatus,
    submittedAt: Number(row.submitted_at) || 0,
    resolvedAt: row.resolved_at == null ? null : Number(row.resolved_at),
    feedback: row.feedback == null ? null : String(row.feedback),
  };
}

export interface InsertPendingApprovalInput {
  id: string;
  kind: PendingApprovalKind;
  agentId: string | null;
  agentName: string | null;
  coordinatorId: string | null;
  payload: unknown;
  submittedAt: number;
}

export interface ResolvePendingApprovalInput {
  id: string;
  status: Exclude<PendingApprovalStatus, 'pending'>;
  feedback: string | null;
  resolvedAt: number;
}

export class PendingApprovalRepository {
  constructor(private db: BetterSqlite3.Database) {}

  /**
   * 插入一条新的 pending 记录。
   * 同 id 已存在时（极少数 race / 同 process 内重启）覆盖旧行——上层不应
   * 依赖此行为做幂等，但需要保证 schema 的最终一致。
   */
  insert(input: InsertPendingApprovalInput): void {
    let payloadJson: string;
    try {
      payloadJson = JSON.stringify(input.payload ?? null);
    } catch {
      payloadJson = 'null';
    }

    this.db
      .prepare(
        `INSERT OR REPLACE INTO pending_approvals (
          id, kind, agent_id, agent_name, coordinator_id,
          payload_json, status, submitted_at, resolved_at, feedback
        ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, NULL, NULL)`,
      )
      .run(
        input.id,
        input.kind,
        input.agentId,
        input.agentName,
        input.coordinatorId,
        payloadJson,
        input.submittedAt,
      );
  }

  /**
   * 把 pending 行收尾为 approved / rejected / orphaned。
   * 不存在或已 resolved 的 id 静默忽略，保持调用方的 fire-and-forget 语义。
   */
  resolve(input: ResolvePendingApprovalInput): void {
    this.db
      .prepare(
        `UPDATE pending_approvals
           SET status = ?, feedback = ?, resolved_at = ?
         WHERE id = ? AND status = 'pending'`,
      )
      .run(input.status, input.feedback, input.resolvedAt, input.id);
  }

  /**
   * 上次进程崩溃后还卡在 pending 的行：启动 hydrate 时一次性标 orphaned
   * 并返回，让 gate 回填到内存 Map 但不重新挂 resolver。
   */
  markAllPendingAsOrphaned(now: number): PendingApprovalRecord[] {
    const before = this.db
      .prepare(`SELECT * FROM pending_approvals WHERE status = 'pending'`)
      .all() as SQLiteRow[];

    if (before.length === 0) return [];

    this.db
      .prepare(
        `UPDATE pending_approvals
           SET status = 'orphaned', resolved_at = ?, feedback = 'Orphaned by process restart'
         WHERE status = 'pending'`,
      )
      .run(now);

    return before.map((row) =>
      rowToRecord({
        ...row,
        status: 'orphaned',
        resolved_at: now,
        feedback: 'Orphaned by process restart',
      }),
    );
  }

  listByKindAndStatus(
    kind: PendingApprovalKind,
    status: PendingApprovalStatus,
  ): PendingApprovalRecord[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM pending_approvals
             WHERE kind = ? AND status = ?
             ORDER BY submitted_at DESC`,
        )
        .all(kind, status) as SQLiteRow[]
    ).map(rowToRecord);
  }

  getById(id: string): PendingApprovalRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM pending_approvals WHERE id = ?`)
      .get(id) as SQLiteRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  /**
   * 仅用于测试 / 维护工具，业务路径不应使用。
   */
  clearAll(): void {
    this.db.exec(`DELETE FROM pending_approvals`);
  }
}
