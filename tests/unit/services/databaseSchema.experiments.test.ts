import { describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';

import { applySchema } from '../../../src/main/services/core/database/schema';

function createLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe('database experiment schema', () => {
  it('creates a fresh experiments table that matches ExperimentRepository inserts', () => {
    const db = new Database(':memory:');
    const logger = createLogger();

    try {
      applySchema(db, logger as never);
      expect(logger.warn).not.toHaveBeenCalled();

      const experimentColumns = db
        .prepare('PRAGMA table_info(experiments)')
        .all()
        .map((row) => (row as { name: string }).name);
      const caseColumns = db
        .prepare('PRAGMA table_info(experiment_cases)')
        .all()
        .map((row) => (row as { name: string }).name);

      expect(experimentColumns).toContain('git_commit');
      expect(caseColumns).toContain('session_id');
      expect(() => {
        db.prepare(`
          INSERT INTO experiments (id, name, timestamp, model, provider, scope, config_json, summary_json, source, git_commit)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          'run-1',
          'eval-smoke',
          Date.now(),
          'mimo-v2.5-pro',
          'xiaomi',
          'smoke',
          '{}',
          '{}',
          'test-runner',
          'abc123',
        );
      }).not.toThrow();
    } finally {
      db.close();
    }
  });
});
