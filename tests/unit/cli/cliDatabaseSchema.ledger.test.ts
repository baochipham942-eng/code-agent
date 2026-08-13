import { describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import { createCliIndexes, createCliTables, migrateCliSessionsTable } from '../../../src/cli/cliDatabaseSchema';

describe('CLI 账本 schema', () => {
  it('建表与迁移可幂等重跑，并补齐 origin/wait_ms', () => {
    const db = new Database(':memory:');
    try {
      db.exec(`
        CREATE TABLE permission_decisions (
          id INTEGER PRIMARY KEY, session_id TEXT, tool_name TEXT, summary TEXT, final_outcome TEXT,
          history_outcome TEXT, reason TEXT, duration_ms INTEGER, recorded_at INTEGER, trace_json TEXT
        );
        CREATE TABLE tool_execution_events (
          id INTEGER PRIMARY KEY, execution_id TEXT, session_id TEXT, tool_name TEXT, summary TEXT,
          params_json TEXT, phase TEXT, status TEXT, error TEXT, recorded_at INTEGER
        );
      `);
      // 与 CLIDatabaseService.initialize 同序（tables → migrate → indexes），并重跑一遍验幂等
      createCliTables(db);
      migrateCliSessionsTable(db);
      createCliIndexes(db);
      createCliTables(db);
      migrateCliSessionsTable(db);
      createCliIndexes(db);
      const decisionColumns = db.prepare('PRAGMA table_info(permission_decisions)').all().map((row) => (row as { name: string }).name);
      const executionColumns = db.prepare('PRAGMA table_info(tool_execution_events)').all().map((row) => (row as { name: string }).name);
      expect(decisionColumns).toEqual(expect.arrayContaining(['origin', 'wait_ms']));
      expect(executionColumns).toContain('origin');
    } finally {
      db.close();
    }
  });
});
