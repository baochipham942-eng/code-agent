import type BetterSqlite3 from 'better-sqlite3';

type TableInfoRow = {
  name: string;
  notnull: number;
};

/**
 * 面板/API 创建的自动化没有源会话。旧表把 source_session_id 声明为 NOT NULL，
 * 调用方只能写入空串，开启 foreign_keys 后会违反 sessions 外键。
 */
export function applySessionAutomationsNullableSourceMigration(db: BetterSqlite3.Database): void {
  const columns = db.pragma('table_info(session_automations)') as TableInfoRow[];
  const sourceColumn = columns.find((column) => column.name === 'source_session_id');
  if (!sourceColumn || sourceColumn.notnull === 0) return;

  db.transaction(() => {
    db.exec(`
      DROP TABLE IF EXISTS session_automations_new;
      CREATE TABLE session_automations_new (
        id TEXT PRIMARY KEY,
        source_session_id TEXT,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        title TEXT NOT NULL,
        cadence_label TEXT,
        next_run_at INTEGER,
        last_run_at INTEGER,
        source_ref_id TEXT,
        result_session_id TEXT,
        config_json TEXT DEFAULT '{}',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (source_session_id) REFERENCES sessions(id) ON DELETE CASCADE,
        FOREIGN KEY (result_session_id) REFERENCES sessions(id) ON DELETE SET NULL
      );
      INSERT INTO session_automations_new (
        id, source_session_id, type, status, title, cadence_label, next_run_at,
        last_run_at, source_ref_id, result_session_id, config_json, created_at, updated_at
      )
      SELECT
        id, NULLIF(source_session_id, ''), type, status, title, cadence_label, next_run_at,
        last_run_at, source_ref_id, result_session_id, config_json, created_at, updated_at
      FROM session_automations;
      DROP TABLE session_automations;
      ALTER TABLE session_automations_new RENAME TO session_automations;
      CREATE INDEX idx_session_automations_source
        ON session_automations(source_session_id, status, next_run_at);
      CREATE INDEX idx_session_automations_ref
        ON session_automations(type, source_ref_id);
    `);
  })();
}
