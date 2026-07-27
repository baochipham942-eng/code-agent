import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';
import { applySchema } from '../../../../src/host/services/core/database/schema';
import { TurnCostRepository } from '../../../../src/host/services/core/repositories/TurnCostRepository';

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function localTime(
  year: number,
  month: number,
  day: number,
  hour = 12,
): number {
  return new Date(year, month - 1, day, hour).getTime();
}

describe('TurnCostRepository', () => {
  let db: BetterSqlite3.Database;
  let repo: TurnCostRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    applySchema(db, logger);
    repo = new TurnCostRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  it('creates the expected table and round-trips nullable usd with an injected timestamp', () => {
    const id = repo.insert({
      sessionId: 'session-1',
      provider: 'custom',
      modelId: 'private-model',
      inputTokens: 120,
      outputTokens: 30,
      usd: null,
      source: 'unknown',
      createdAt: 1_234,
    });

    expect(repo.getById(id)).toEqual({
      id,
      sessionId: 'session-1',
      provider: 'custom',
      modelId: 'private-model',
      inputTokens: 120,
      outputTokens: 30,
      usd: null,
      source: 'unknown',
      createdAt: 1_234,
    });
    expect(repo.listBySession('session-1')).toHaveLength(1);
  });

  it('uses local calendar-day boundaries and excludes null usd from the sum', () => {
    const today = localTime(2026, 7, 27);
    repo.insert({
      sessionId: 's1',
      provider: 'deepseek',
      modelId: 'deepseek-v4-pro',
      inputTokens: 1,
      outputTokens: 1,
      usd: 0.25,
      source: 'catalog',
      createdAt: localTime(2026, 7, 27, 0),
    });
    repo.insert({
      sessionId: 's2',
      provider: 'custom',
      modelId: 'unknown-model',
      inputTokens: 1,
      outputTokens: 1,
      usd: null,
      source: 'unknown',
      createdAt: localTime(2026, 7, 27, 23),
    });
    repo.insert({
      sessionId: 'old',
      provider: 'deepseek',
      modelId: 'deepseek-v4-pro',
      inputTokens: 1,
      outputTokens: 1,
      usd: 99,
      source: 'catalog',
      createdAt: localTime(2026, 7, 26, 23),
    });

    expect(repo.getTodayCost(today)).toEqual({ usd: 0.25, unknownTurns: 1 });
  });

  it('aggregates the last N local calendar days by model_id', () => {
    const now = localTime(2026, 7, 27);
    const insert = (
      modelId: string,
      usd: number | null,
      createdAt: number,
    ) => repo.insert({
      sessionId: 's1',
      provider: 'test-provider',
      modelId,
      inputTokens: 10,
      outputTokens: 5,
      usd,
      source: usd == null ? 'unknown' : 'catalog',
      createdAt,
    });

    insert('model-a', 0.1, localTime(2026, 7, 25));
    insert('model-a', null, localTime(2026, 7, 26));
    insert('model-a', 0.2, localTime(2026, 7, 27));
    insert('model-b', null, localTime(2026, 7, 27));
    insert('outside-window', 8, localTime(2026, 7, 24));

    expect(repo.getCostStats(3, now)).toEqual([
      { modelId: 'model-a', turns: 3, usd: 0.30000000000000004, unknownTurns: 1 },
      { modelId: 'model-b', turns: 1, usd: 0, unknownTurns: 1 },
    ]);
  });

  it('rejects invalid stats windows', () => {
    expect(() => repo.getCostStats(0)).toThrow('days must be a positive integer');
    expect(() => repo.getCostStats(1.5)).toThrow('days must be a positive integer');
  });
});
