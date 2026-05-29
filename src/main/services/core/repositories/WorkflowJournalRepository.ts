// ============================================================================
// WorkflowJournalRepository — dynamic-workflow resumable 重放的持久化（P4-B）
// ============================================================================
//
// 表关系：
//   workflow_runs (1) ──< workflow_run_calls (N)
//
// 为什么新建专表而非复用 SwarmTraceRepository / FileCheckpointService：
//   - SwarmTrace 是 observability，单 run 事件容量封顶（超限丢尾），缓存被丢 = 重放结果错。
//   - FileCheckpoint 是文件内容回滚，语义不对。
// resumable 语义（对齐 Claude Code Workflow）：新 run 重跑确定性脚本，逐 agent() 调用按
// 「位置序 call_index + prompt/opts 内容 hash」查被 resume 的旧 run 的 journal；内容 hash 一致
// → 命中返缓存（不再发起 inference）；否则 live 跑并写入新 journal。
//
// 只缓存【成功】的 agent() 结果：失败/抛错的调用不写 journal，resume 时自然 miss → 重新 live 跑
// （可能这次成功），这是更安全的语义。
//
// 本 repo 只做同步 SQLite 操作（与 SwarmTraceRepository 同款）；DB 未就绪时的优雅降级由
// getWorkflowJournalRepository() 访问器在外层处理（返回 null → 调用方 no-op 成全 live 跑）。
// ============================================================================

import type BetterSqlite3 from 'better-sqlite3';
import { getDatabase } from '../index';
import type { RunStatus } from '../../../../shared/contract/scriptRun';

type SQLiteRow = Record<string, unknown>;

/** agent() 可缓存的结果：string（full-agent 文本）| object（forced 结构化）。 */
export type JournalResult = string | Record<string, unknown>;

export interface StartRunInput {
  runId: string;
  scriptHash: string;
  goal?: string;
  sessionId?: string;
  startedAt: number;
}

export interface FinishRunInput {
  runId: string;
  status: RunStatus;
  finishedAt: number;
  tokensSpent: number;
  result?: unknown;
  error?: string;
}

export interface RecordCallInput {
  runId: string;
  callIndex: number;
  contentHash: string;
  result: JournalResult;
  tokensUsed: number;
  label?: string;
  ts: number;
}

export interface WorkflowRunRecord {
  runId: string;
  scriptHash: string;
  goal: string | null;
  sessionId: string | null;
  status: RunStatus;
  startedAt: number;
  finishedAt: number | null;
  tokensSpent: number;
  result: unknown;
  error: string | null;
}

export interface WorkflowCallRecord {
  runId: string;
  callIndex: number;
  contentHash: string;
  status: string;
  label: string | null;
  result: JournalResult;
  tokensUsed: number;
  ts: number;
}

/** 一次 run 的完整 journal：run 元数据 + 按 call_index 索引的调用结果缓存。 */
export interface WorkflowRunJournal {
  run: WorkflowRunRecord;
  calls: Map<number, WorkflowCallRecord>;
}

/** result 序列化：JSON round-trip 天然保真（string→`"x"`、object→`{...}`），解析回原类型。 */
function serializeResult(result: unknown): string {
  try {
    const json = JSON.stringify(result);
    return json === undefined ? 'null' : json;
  } catch {
    return 'null';
  }
}

/**
 * 反序列化【忠实】还原任意 JSON 值（Codex round1 HIGH#2：原实现把 array/number/boolean/null
 * 压成字符串，损坏脚本 return 的 run result）。run.result 是 unknown（脚本 return 任意值）；
 * call.result 由构造恒为 string|object，故 mapCallRow 处 cast 安全。空串/非串 → undefined。
 */
function deserialize(json: unknown): unknown {
  if (typeof json !== 'string' || json.length === 0) return undefined;
  try {
    return JSON.parse(json);
  } catch {
    return json;
  }
}

export class WorkflowJournalRepository {
  constructor(private db: BetterSqlite3.Database) {}

  // ── 写入 ─────────────────────────────────────────────────────────────────

  /** run 开始：写 running 占位行（INSERT OR REPLACE 允许同 runId 重启覆盖）。 */
  startRun(input: StartRunInput): void {
    this.db
      .prepare(`
        INSERT OR REPLACE INTO workflow_runs (
          run_id, script_hash, goal, session_id, status, started_at, finished_at, tokens_spent, result_json, error
        ) VALUES (?, ?, ?, ?, 'running', ?, NULL, 0, NULL, NULL)
      `)
      .run(input.runId, input.scriptHash, input.goal ?? null, input.sessionId ?? null, input.startedAt);
  }

  /** run 收尾：更新终态 + 结果/错误 + 累计 token。 */
  finishRun(input: FinishRunInput): void {
    this.db
      .prepare(`
        UPDATE workflow_runs SET
          status = ?, finished_at = ?, tokens_spent = ?, result_json = ?, error = ?
        WHERE run_id = ?
      `)
      .run(
        input.status,
        input.finishedAt,
        input.tokensSpent,
        input.result === undefined ? null : serializeResult(input.result),
        input.error ?? null,
        input.runId,
      );
  }

  /** 记录一次成功的 agent() 调用结果（INSERT OR REPLACE 幂等于 run_id + call_index）。 */
  recordCall(input: RecordCallInput): void {
    this.db
      .prepare(`
        INSERT OR REPLACE INTO workflow_run_calls (
          run_id, call_index, content_hash, status, label, result_json, tokens_used, ts
        ) VALUES (?, ?, ?, 'done', ?, ?, ?, ?)
      `)
      .run(
        input.runId,
        input.callIndex,
        input.contentHash,
        input.label ?? null,
        serializeResult(input.result),
        input.tokensUsed,
        input.ts,
      );
  }

  // ── 读取 ─────────────────────────────────────────────────────────────────

  getRun(runId: string): WorkflowRunRecord | null {
    const row = this.db.prepare('SELECT * FROM workflow_runs WHERE run_id = ?').get(runId) as
      | SQLiteRow
      | undefined;
    return row ? this.mapRunRow(row) : null;
  }

  /** 载入完整 journal（run + 按 call_index 索引的调用缓存）；用于 resume 重放命中。 */
  loadRun(runId: string): WorkflowRunJournal | null {
    const run = this.getRun(runId);
    if (!run) return null;
    const rows = this.db
      .prepare('SELECT * FROM workflow_run_calls WHERE run_id = ? ORDER BY call_index ASC')
      .all(runId) as SQLiteRow[];
    const calls = new Map<number, WorkflowCallRecord>();
    for (const row of rows) {
      const rec = this.mapCallRow(row);
      calls.set(rec.callIndex, rec);
    }
    return { run, calls };
  }

  deleteRun(runId: string): boolean {
    const result = this.db.prepare('DELETE FROM workflow_runs WHERE run_id = ?').run(runId);
    return result.changes > 0;
  }

  /** 仅供测试/维护：清空两表。 */
  clearAll(): void {
    this.db.exec('DELETE FROM workflow_run_calls');
    this.db.exec('DELETE FROM workflow_runs');
  }

  // ── 行映射 ─────────────────────────────────────────────────────────────────

  private mapRunRow(row: SQLiteRow): WorkflowRunRecord {
    const resultJson = row.result_json as string | null;
    return {
      runId: row.run_id as string,
      scriptHash: row.script_hash as string,
      goal: (row.goal as string | null) ?? null,
      sessionId: (row.session_id as string | null) ?? null,
      status: row.status as RunStatus,
      startedAt: row.started_at as number,
      finishedAt: (row.finished_at as number | null) ?? null,
      tokensSpent: (row.tokens_spent as number) ?? 0,
      result: resultJson != null ? deserialize(resultJson) : undefined,
      error: (row.error as string | null) ?? null,
    };
  }

  private mapCallRow(row: SQLiteRow): WorkflowCallRecord {
    return {
      runId: row.run_id as string,
      callIndex: row.call_index as number,
      contentHash: row.content_hash as string,
      status: (row.status as string) ?? 'done',
      label: (row.label as string | null) ?? null,
      result: deserialize(row.result_json) as JournalResult,
      tokensUsed: (row.tokens_used as number) ?? 0,
      ts: row.ts as number,
    };
  }
}

// ── 优雅降级访问器 ───────────────────────────────────────────────────────────
// DB 未就绪（standalone / headless 早期）时返回 null，调用方 no-op → resume 退化成全 live 跑，
// 不崩（与 FileCheckpointService.createCheckpoint 的 !isReady → return null 同款策略）。

let cached: { db: BetterSqlite3.Database; repo: WorkflowJournalRepository } | null = null;

export function getWorkflowJournalRepository(): WorkflowJournalRepository | null {
  const dbService = getDatabase();
  if (!dbService.isReady) return null;
  const db = dbService.getDb();
  if (!db) return null;
  // DB 实例可能在重启后变化：实例不同则重建 repo。
  if (!cached || cached.db !== db) {
    cached = { db, repo: new WorkflowJournalRepository(db) };
  }
  return cached.repo;
}
