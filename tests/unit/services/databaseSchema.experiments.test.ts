import { describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';

import { applySchema } from '../../../src/host/services/core/database/schema';

function createLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe('database experiment schema', () => {
  it('creates session memory quality columns with safe defaults', () => {
    const db = new Database(':memory:');
    const logger = createLogger();

    try {
      applySchema(db, logger as never);
      expect(logger.warn).not.toHaveBeenCalled();

      const sessionColumns = db
        .prepare('PRAGMA table_info(sessions)')
        .all()
        .map((row) => (row as { name: string }).name);

      expect(sessionColumns).toContain('memory_mode');
      expect(sessionColumns).toContain('suppressed_memory_entry_ids');
      db.prepare(`
        INSERT INTO sessions (
          id, title, model_provider, model_name, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run('session-memory-defaults', 'Memory Defaults', 'openai', 'gpt-4.1', 100, 100);
      const row = db
        .prepare('SELECT memory_mode, suppressed_memory_entry_ids FROM sessions WHERE id = ?')
        .get('session-memory-defaults') as { memory_mode: string; suppressed_memory_entry_ids: string };

      expect(row.memory_mode).toBe('auto');
      expect(row.suppressed_memory_entry_ids).toBe('[]');
    } finally {
      db.close();
    }
  });

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

  it('creates artifact issue and quality report tables for product closure', () => {
    const db = new Database(':memory:');
    const logger = createLogger();

    try {
      applySchema(db, logger as never);
      expect(logger.warn).not.toHaveBeenCalled();

      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all()
        .map((row) => (row as { name: string }).name);

      expect(tables).toContain('artifact_issues');
      expect(tables).toContain('artifact_issue_evidence');
      expect(tables).toContain('eval_replay_quality_reports');
      expect(() => {
        db.prepare(`
          INSERT INTO artifact_issues (
            issue_id, artifact_id, artifact_kind,
            trace_id, trace_source, session_id, replay_key,
            source, code, severity, status, title, message,
            anchors_json, related_issue_ids_json, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          'issue-1',
          'artifact-1',
          'dashboard',
          'session:session-1',
          'session_replay',
          'session-1',
          'session-1',
          'artifact_verifier',
          'console_error',
          'high',
          'open',
          'Console error',
          'Generated artifact has a console error.',
          '[]',
          '[]',
          100,
          100,
        );
      }).not.toThrow();
    } finally {
      db.close();
    }
  });
});
