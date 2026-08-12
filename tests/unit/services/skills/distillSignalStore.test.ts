import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';

const dbState = vi.hoisted(() => ({
  db: null as BetterSqlite3.Database | null,
}));

vi.mock('../../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({ getDb: () => dbState.db }),
}));

import { applyDistillSignalsMigration } from '../../../../src/host/services/core/database/migrations/distillSignals';
import {
  hasDistillSuggestionForSession,
  recordDistillSignal,
  recordDistillSuggestion,
} from '../../../../src/host/services/skills/distillSignalStore';

function createLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe('distill signal store', () => {
  beforeEach(() => {
    dbState.db = new Database(':memory:');
    applyDistillSignalsMigration(dbState.db, createLogger() as never);
  });

  afterEach(() => {
    dbState.db?.close();
    dbState.db = null;
  });

  it('counts only distinct sessions and records one delivered suggestion per session', () => {
    expect(recordDistillSignal({ patternKey: 'same-pattern', sessionId: 'session-1', createdAt: 1 }))
      .toEqual({ distinctSessionCount: 1, inserted: true });
    expect(recordDistillSignal({ patternKey: 'same-pattern', sessionId: 'session-1', createdAt: 2 }))
      .toEqual({ distinctSessionCount: 1, inserted: false });
    expect(recordDistillSignal({ patternKey: 'same-pattern', sessionId: 'session-2', createdAt: 3 }))
      .toEqual({ distinctSessionCount: 2, inserted: true });

    expect(hasDistillSuggestionForSession('session-1')).toBe(false);
    recordDistillSuggestion({ id: 'suggestion-1', patternKey: 'same-pattern', sessionId: 'session-1', createdAt: 4 });
    expect(hasDistillSuggestionForSession('session-1')).toBe(true);
    expect(hasDistillSuggestionForSession('session-2')).toBe(false);
  });
});
