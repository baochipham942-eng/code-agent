// ============================================================================
// UsageLedgerRepository — per-request 用量账本（A7，append-only）
// ============================================================================
//
// 逐条落 budgetService 归一化后的 TokenUsage：budgetService.usageHistory 是内存
// 数组，进程重启即丢；DB 侧此前只有 sessions.last_token_usage 单列（覆盖式）。
// 只 INSERT/SELECT，不提供 UPDATE/DELETE（账本不可篡改）。只做基建，不做展示页。

import type BetterSqlite3 from 'better-sqlite3';

type SQLiteRow = Record<string, unknown>;

/** 一条 per-request 用量记录（字段口径见 usageNormalization.ts） */
export interface UsageLedgerEntryInput {
  sessionId?: string;
  model: string;
  provider: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  /** 记录时间戳（毫秒），由调用方传入 */
  recordedAt: number;
}

export interface UsageLedgerEntry extends UsageLedgerEntryInput {
  id: number;
}

function rowToEntry(row: SQLiteRow): UsageLedgerEntry {
  return {
    id: Number(row.id),
    sessionId: (row.session_id as string | null) ?? undefined,
    model: String(row.model),
    provider: String(row.provider),
    inputTokens: Number(row.input_tokens),
    outputTokens: Number(row.output_tokens),
    cacheReadTokens: row.cache_read_tokens == null ? undefined : Number(row.cache_read_tokens),
    cacheCreationTokens: row.cache_creation_tokens == null ? undefined : Number(row.cache_creation_tokens),
    recordedAt: Number(row.recorded_at),
  };
}

export class UsageLedgerRepository {
  constructor(private db: BetterSqlite3.Database) {}

  /** 追加一条用量记录（append-only） */
  append(input: UsageLedgerEntryInput): void {
    this.db.prepare(`
      INSERT INTO usage_ledger
        (session_id, model, provider, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, recorded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.sessionId ?? null,
      input.model,
      input.provider,
      input.inputTokens,
      input.outputTokens,
      input.cacheReadTokens ?? null,
      input.cacheCreationTokens ?? null,
      input.recordedAt,
    );
  }

  /** 某会话的用量记录（按时间升序） */
  getBySession(sessionId: string, limit = 500): UsageLedgerEntry[] {
    const rows = this.db.prepare(`
      SELECT * FROM usage_ledger WHERE session_id = ? ORDER BY recorded_at ASC, id ASC LIMIT ?
    `).all(sessionId, limit) as SQLiteRow[];
    return rows.map(rowToEntry);
  }

  /** 账本总条数 */
  count(): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS c FROM usage_ledger`).get() as { c?: number };
    return Number(row?.c ?? 0);
  }
}
