import type BetterSqlite3 from 'better-sqlite3';
import type {
  ModelCostStats,
  TodayCost,
  TurnCostEstimate,
  TurnCostEstimateInput,
} from '../../../../shared/contract/turnCost';
import type { PriceSource } from '../../../../shared/pricing/resolveModelPrice';

type SQLiteRow = Record<string, unknown>;

function rowToEstimate(row: SQLiteRow): TurnCostEstimate {
  return {
    id: Number(row.id),
    sessionId: String(row.session_id),
    provider: String(row.provider),
    modelId: String(row.model_id),
    inputTokens: Number(row.input_tokens),
    outputTokens: Number(row.output_tokens),
    usd: row.usd == null ? null : Number(row.usd),
    source: row.source as PriceSource,
    createdAt: Number(row.created_at),
  };
}

function getLocalDayRange(now: number): { start: number; end: number } {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start: start.getTime(), end: end.getTime() };
}

export class TurnCostRepository {
  constructor(private db: BetterSqlite3.Database) {}

  insert(input: TurnCostEstimateInput): number {
    const createdAt = input.createdAt ?? Date.now();
    const result = this.db.prepare(`
      INSERT INTO turn_cost_estimates (
        session_id, provider, model_id, input_tokens, output_tokens, usd, source, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.sessionId,
      input.provider,
      input.modelId,
      input.inputTokens,
      input.outputTokens,
      input.usd,
      input.source,
      createdAt,
    );
    return Number(result.lastInsertRowid);
  }

  getById(id: number): TurnCostEstimate | null {
    const row = this.db.prepare(
      `SELECT * FROM turn_cost_estimates WHERE id = ?`,
    ).get(id) as SQLiteRow | undefined;
    return row ? rowToEstimate(row) : null;
  }

  listBySession(sessionId: string): TurnCostEstimate[] {
    const rows = this.db.prepare(`
      SELECT * FROM turn_cost_estimates
      WHERE session_id = ?
      ORDER BY created_at ASC, id ASC
    `).all(sessionId) as SQLiteRow[];
    return rows.map(rowToEstimate);
  }

  getTodayCost(now: number = Date.now()): TodayCost {
    const { start, end } = getLocalDayRange(now);
    const row = this.db.prepare(`
      SELECT
        COALESCE(SUM(usd), 0) AS usd,
        COALESCE(SUM(CASE WHEN usd IS NULL THEN 1 ELSE 0 END), 0) AS unknown_turns
      FROM turn_cost_estimates
      WHERE created_at >= ? AND created_at < ?
    `).get(start, end) as SQLiteRow;
    return {
      usd: Number(row.usd ?? 0),
      unknownTurns: Number(row.unknown_turns ?? 0),
    };
  }

  getCostStats(days: number, now: number = Date.now()): ModelCostStats[] {
    if (!Number.isInteger(days) || days < 1) {
      throw new RangeError('days must be a positive integer');
    }

    const { start: todayStart, end } = getLocalDayRange(now);
    const startDate = new Date(todayStart);
    startDate.setDate(startDate.getDate() - (days - 1));

    const rows = this.db.prepare(`
      SELECT
        provider,
        model_id,
        COUNT(*) AS turns,
        COALESCE(SUM(usd), 0) AS usd,
        COALESCE(SUM(CASE WHEN usd IS NULL THEN 1 ELSE 0 END), 0) AS unknown_turns
      FROM turn_cost_estimates
      WHERE created_at >= ? AND created_at < ?
      GROUP BY provider, model_id
      ORDER BY provider ASC, model_id ASC
    `).all(startDate.getTime(), end) as SQLiteRow[];

    return rows.map((row) => ({
      provider: String(row.provider),
      modelId: String(row.model_id),
      turns: Number(row.turns),
      usd: Number(row.usd),
      unknownTurns: Number(row.unknown_turns),
    }));
  }
}
