// ============================================================================
// CloudRunRepository — 云端 run 账本持久行（ADR-086 S1）
// ============================================================================
// 同步 SQLite only（SessionDelegationRepository 形状）。时间戳一律是参数，
// 本层禁裸取当前时间（repositories grep 门）；真钟默认在 CloudRunLedger。
// 迁移合法性不在这一层：账本服务先按合同迁移表判，再用 from_state 做 CAS
// 落库，行更新与迁移记录写进同一个事务。
// ============================================================================

import type BetterSqlite3 from 'better-sqlite3';
import type { CloudRunState, CloudRunTrigger } from '../../../../shared/contract/cloudRun';

type SQLiteRow = Record<string, unknown>;

export interface CloudRunRecord {
  runId: string;
  accountId: string;
  sessionId: string;
  trigger: CloudRunTrigger;
  state: CloudRunState;
  workspaceId: string;
  workspaceStatus: string;
  retentionNoticeAt: number | null;
  exportAvailable: boolean | null;
  createdAt: number;
  updatedAt: number;
}

export interface CloudRunTransitionRecord {
  seq: number;
  runId: string;
  fromState: CloudRunState;
  toState: CloudRunState;
  at: number;
}

interface InsertCloudRunInput {
  runId: string;
  accountId: string;
  sessionId: string;
  trigger: CloudRunTrigger;
  workspaceId: string;
  now: number;
}

interface ApplyCloudRunTransitionInput {
  runId: string;
  fromState: CloudRunState;
  toState: CloudRunState;
  now: number;
}

function rowToRecord(row: SQLiteRow): CloudRunRecord {
  return {
    runId: String(row.run_id),
    accountId: String(row.account_id),
    sessionId: String(row.session_id),
    trigger: row.trigger as CloudRunTrigger,
    state: row.state as CloudRunState,
    workspaceId: String(row.workspace_id),
    workspaceStatus: String(row.workspace_status ?? 'active'),
    retentionNoticeAt: row.retention_notice_at == null ? null : Number(row.retention_notice_at),
    exportAvailable: row.export_available == null ? null : Boolean(row.export_available),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function rowToTransition(row: SQLiteRow): CloudRunTransitionRecord {
  return {
    seq: Number(row.seq),
    runId: String(row.run_id),
    fromState: row.from_state as CloudRunState,
    toState: row.to_state as CloudRunState,
    at: Number(row.at),
  };
}

export class CloudRunRepository {
  constructor(private db: BetterSqlite3.Database) {}

  /** 新行落库即 queued（S2 的 admit 才决定何时升 running）。 */
  insertRun(input: InsertCloudRunInput): CloudRunRecord {
    this.db.prepare(
      `INSERT INTO cloud_runs (
        run_id, account_id, session_id, "trigger", state, workspace_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'queued', ?, ?, ?)`,
    ).run(
      input.runId,
      input.accountId,
      input.sessionId,
      input.trigger,
      input.workspaceId,
      input.now,
      input.now,
    );
    const created = this.getRun(input.runId);
    if (!created) throw new Error('cloud run insert did not persist');
    return created;
  }

  getRun(runId: string): CloudRunRecord | null {
    const row = this.db.prepare('SELECT * FROM cloud_runs WHERE run_id = ?').get(runId) as SQLiteRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  countRuns(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS total FROM cloud_runs').get() as SQLiteRow;
    return Number(row.total ?? 0);
  }

  /** 行更新 + 迁移记录同事务；from_state 不匹配（并发改写）即抛错回滚。 */
  applyTransition(input: ApplyCloudRunTransitionInput): CloudRunTransitionRecord {
    const apply = this.db.transaction((): CloudRunTransitionRecord => {
      const result = this.db
        .prepare('UPDATE cloud_runs SET state = ?, updated_at = ? WHERE run_id = ? AND state = ?')
        .run(input.toState, input.now, input.runId, input.fromState);
      if (result.changes !== 1) {
        throw new Error(
          `Cloud run ${input.runId} transition ${input.fromState} -> ${input.toState} did not apply; state moved concurrently`,
        );
      }
      const inserted = this.db
        .prepare('INSERT INTO cloud_run_transitions (run_id, from_state, to_state, at) VALUES (?, ?, ?, ?)')
        .run(input.runId, input.fromState, input.toState, input.now);
      return {
        seq: Number(inserted.lastInsertRowid),
        runId: input.runId,
        fromState: input.fromState,
        toState: input.toState,
        at: input.now,
      };
    });
    return apply();
  }

  /** seq 全序；afterSeq 供重启后补读增量（ADR-086 失败模式：重启续听）。 */
  listTransitions(afterSeq = 0): CloudRunTransitionRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM cloud_run_transitions WHERE seq > ? ORDER BY seq ASC')
      .all(afterSeq) as SQLiteRow[];
    return rows.map(rowToTransition);
  }
}
