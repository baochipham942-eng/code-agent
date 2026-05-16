import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import { getDatabase } from '../../../src/main/services/core/databaseService';
import { EvaluationService } from '../../../src/main/evaluation/EvaluationService';
import type { EvaluationResult } from '../../../src/shared/contract/evaluation';

vi.mock('../../../src/main/services/infra/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  }),
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    dispose: vi.fn()
  }
}));

const dbState = vi.hoisted(() => ({
  sqlite: null as import('better-sqlite3').Database | null
}));

function makeEvaluation(id: string, sessionId: string, timestamp: number): EvaluationResult {
  return {
    id,
    sessionId,
    timestamp,
    overallScore: 80,
    grade: 'B',
    metrics: [],
    statistics: {
      duration: 0,
      turnCount: 0,
      toolCallCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalCost: 0
    },
    topSuggestions: []
  };
}

describe('EvaluationService user filtering', () => {
  let database: ReturnType<typeof getDatabase>;
  let originalGetDb: typeof database.getDb;
  let isReadySpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dbState.sqlite = new Database(':memory:');
    dbState.sqlite.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT
      );
      CREATE TABLE evaluations (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        user_id TEXT,
        timestamp INTEGER NOT NULL,
        score INTEGER NOT NULL,
        grade TEXT NOT NULL,
        data TEXT NOT NULL
      );
    `);
    database = getDatabase();
    originalGetDb = database.getDb.bind(database);
    isReadySpy = vi.spyOn(database, 'isReady', 'get').mockReturnValue(true);
    database.getDb = () => dbState.sqlite;
  });

  afterEach(() => {
    database.getDb = originalGetDb;
    isReadySpy.mockRestore();
    dbState.sqlite?.close();
    dbState.sqlite = null;
  });

  it('lists evaluation history by direct or session-inherited user owner', async () => {
    dbState.sqlite!.prepare('INSERT INTO sessions (id, user_id) VALUES (?, ?)').run('session-inherited', 'user-1');

    const rows = [
      ['eval-owned', 'session-owned', 'user-1', 100],
      ['eval-other', 'session-other', 'user-2', 200],
      ['eval-inherited', 'session-inherited', null, 300],
      ['eval-unassigned', 'session-unassigned', null, 400]
    ] as const;

    for (const [id, sessionId, userId, timestamp] of rows) {
      dbState
        .sqlite!.prepare(
          `
        INSERT INTO evaluations (id, session_id, user_id, timestamp, score, grade, data)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `
        )
        .run(id, sessionId, userId, timestamp, 80, 'B', JSON.stringify(makeEvaluation(id, sessionId, timestamp)));
    }

    const service = EvaluationService.getInstance();

    await expect(service.listHistory(undefined, 10, { userId: 'user-1' })).resolves.toMatchObject([{ id: 'eval-inherited' }, { id: 'eval-owned' }]);
    await expect(service.listHistory(undefined, 10, { unassignedOnly: true })).resolves.toMatchObject([{ id: 'eval-unassigned' }]);
  });
});
