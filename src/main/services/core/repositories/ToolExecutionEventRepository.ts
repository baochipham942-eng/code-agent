// ============================================================================
// ToolExecutionEventRepository — 工具执行生命周期事件账本（ADR-022 第二期 · 崩溃重放）
// ============================================================================
//
// append-only：给账本记录工具执行的两个不可变生命周期事件——
//   - begin：一个工具通过全部权限闸、即将真正执行时追加一条。
//   - complete：执行返回 / 抛错 / 被恢复确认时追加一条（同一 executionId）。
// "崩溃那一刻正在执行的工具" = 有 begin 无 complete 的 executionId。
// 不变量：只 INSERT / SELECT，不提供任何 UPDATE / DELETE 方法（账本不可篡改）。
// 时间戳：recordedAt 由调用方传入（仓储层禁止裸 Date.now()）。

import type BetterSqlite3 from 'better-sqlite3';

type SQLiteRow = Record<string, unknown>;

/** 一个工具开始执行（放行后、resolver.execute 前）所需的输入 */
export interface ToolExecutionBeginInput {
  /** 关联键：同一次执行的 begin / complete 共享 */
  executionId: string;
  sessionId?: string;
  toolName: string;
  summary: string;
  /** 工具参数，用于崩溃后重放/重建现场 */
  params: Record<string, unknown>;
  /** begin 时间戳（毫秒），由调用方传入 */
  recordedAt: number;
}

/** 一个工具执行结束（成功 / 出错 / 被恢复确认）所需的输入 */
export interface ToolExecutionCompleteInput {
  executionId: string;
  toolName: string;
  /** success | error | recovered */
  status: string;
  /** 出错时的错误信息（可选） */
  error?: string;
  sessionId?: string;
  recordedAt: number;
}

/** 从库里读回的一条生命周期事件 */
export interface ToolExecutionEventRecord {
  id: number;
  executionId: string;
  sessionId: string | null;
  toolName: string;
  summary: string | null;
  params: Record<string, unknown> | null;
  phase: string;
  status: string | null;
  error: string | null;
  recordedAt: number;
}

/** 一条"在飞执行"（崩溃现场的一个工序）：有 begin 无 complete */
export interface OpenToolExecution {
  executionId: string;
  sessionId: string | null;
  toolName: string;
  summary: string | null;
  params: Record<string, unknown> | null;
  startedAt: number;
}

function parseParams(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function rowToRecord(row: SQLiteRow): ToolExecutionEventRecord {
  return {
    id: Number(row.id),
    executionId: String(row.execution_id),
    sessionId: (row.session_id as string | null) ?? null,
    toolName: String(row.tool_name),
    summary: (row.summary as string | null) ?? null,
    params: parseParams(row.params_json),
    phase: String(row.phase),
    status: (row.status as string | null) ?? null,
    error: (row.error as string | null) ?? null,
    recordedAt: Number(row.recorded_at),
  };
}

export class ToolExecutionEventRepository {
  constructor(private db: BetterSqlite3.Database) {}

  /** 追加一条 begin 事件（append-only） */
  appendBegin(input: ToolExecutionBeginInput): void {
    this.db.prepare(`
      INSERT INTO tool_execution_events
        (execution_id, session_id, tool_name, summary, params_json, phase, status, error, recorded_at)
      VALUES (?, ?, ?, ?, ?, 'begin', NULL, NULL, ?)
    `).run(
      input.executionId,
      input.sessionId ?? null,
      input.toolName,
      input.summary ?? null,
      JSON.stringify(input.params ?? {}),
      input.recordedAt,
    );
  }

  /** 追加一条 complete 事件（append-only；status: success | error | recovered） */
  appendComplete(input: ToolExecutionCompleteInput): void {
    this.db.prepare(`
      INSERT INTO tool_execution_events
        (execution_id, session_id, tool_name, summary, params_json, phase, status, error, recorded_at)
      VALUES (?, ?, ?, NULL, NULL, 'complete', ?, ?, ?)
    `).run(
      input.executionId,
      input.sessionId ?? null,
      input.toolName,
      input.status,
      input.error ?? null,
      input.recordedAt,
    );
  }

  /**
   * 未闭合执行 = 有 begin 无 complete 的 executionId。
   * 这正是"崩溃那一刻正在执行的工具"集合，用于重启后重建现场。
   */
  getOpenExecutions(): OpenToolExecution[] {
    const rows = this.db.prepare(`
      SELECT b.execution_id, b.session_id, b.tool_name, b.summary, b.params_json, b.recorded_at
      FROM tool_execution_events b
      WHERE b.phase = 'begin'
        AND NOT EXISTS (
          SELECT 1 FROM tool_execution_events c
          WHERE c.execution_id = b.execution_id AND c.phase = 'complete'
        )
      ORDER BY b.recorded_at ASC, b.id ASC
    `).all() as SQLiteRow[];
    return rows.map((row) => ({
      executionId: String(row.execution_id),
      sessionId: (row.session_id as string | null) ?? null,
      toolName: String(row.tool_name),
      summary: (row.summary as string | null) ?? null,
      params: parseParams(row.params_json),
      startedAt: Number(row.recorded_at),
    }));
  }

  /** 最近 N 条事件（按时间倒序） */
  getRecent(limit = 50): ToolExecutionEventRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM tool_execution_events ORDER BY recorded_at DESC, id DESC LIMIT ?
    `).all(limit) as SQLiteRow[];
    return rows.map(rowToRecord);
  }

  /** 账本总条数 */
  count(): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS c FROM tool_execution_events`).get() as { c?: number };
    return Number(row?.c ?? 0);
  }
}
