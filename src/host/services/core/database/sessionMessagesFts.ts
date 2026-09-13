import type BetterSqlite3 from 'better-sqlite3';

type TriggerDefinition = { name: string; sql: string };

export const SESSION_FTS_SOURCE_WHERE = `
  COALESCE(is_meta, 0) = 0
  AND COALESCE(content, '') NOT LIKE '%【循环模式 · 第%轮】%'
  AND COALESCE(content, '') NOT LIKE '%[[LOOP_WAIT]]%'
`;

export const SESSION_MESSAGES_FTS_TABLE_SQL = `
  CREATE VIRTUAL TABLE IF NOT EXISTS session_messages_fts USING fts5(
    message_id UNINDEXED,
    session_id UNINDEXED,
    role UNINDEXED,
    content,
    timestamp UNINDEXED,
    tokenize = 'trigram'
  )
`;

const SESSION_FTS_STAGING_TABLE_SQL = `
  CREATE VIRTUAL TABLE session_messages_fts_rebuild USING fts5(
    message_id UNINDEXED,
    session_id UNINDEXED,
    role UNINDEXED,
    content,
    timestamp UNINDEXED,
    tokenize = 'trigram'
  )
`;

function quoteSqlIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function sessionMessagesFtsTriggerDefinitions(
  db: BetterSqlite3.Database,
): TriggerDefinition[] {
  return db.prepare(`
    SELECT name, sql
    FROM sqlite_master
    WHERE type = 'trigger'
      AND instr(sql, 'session_messages_fts') > 0
      AND sql IS NOT NULL
  `).all() as TriggerDefinition[];
}

function countSessionMessagesFtsSourceRows(db: BetterSqlite3.Database): number {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM messages WHERE ${SESSION_FTS_SOURCE_WHERE}`).get() as {
    count: number | bigint;
  };
  return Number(row.count);
}

/**
 * 在独立 staging FTS 中全量重建，校验后于同一事务内替换正式表。
 * 任何建表、填充、校验或替换失败都会回滚，旧投影保持可用。
 */
export function rebuildSessionMessagesFts(db: BetterSqlite3.Database): number {
  db.exec('BEGIN IMMEDIATE');
  try {
    const triggers = sessionMessagesFtsTriggerDefinitions(db);
    db.exec('DROP TABLE IF EXISTS session_messages_fts_rebuild');
    db.exec(SESSION_FTS_STAGING_TABLE_SQL);
    db.prepare(
      `
        INSERT INTO session_messages_fts_rebuild (message_id, session_id, role, content, timestamp)
        SELECT id, session_id, role, COALESCE(content, ''), timestamp
        FROM messages
        WHERE ${SESSION_FTS_SOURCE_WHERE}
      `,
    ).run();

    const sourceRows = countSessionMessagesFtsSourceRows(db);
    const stagingRows = Number(
      (db.prepare('SELECT COUNT(*) AS count FROM session_messages_fts_rebuild').get() as {
        count: number | bigint;
      }).count,
    );
    if (stagingRows !== sourceRows) {
      throw new Error(`Session FTS rebuild row count mismatch: source=${sourceRows}, staging=${stagingRows}`);
    }

    for (const trigger of triggers) {
      db.exec(`DROP TRIGGER ${quoteSqlIdentifier(trigger.name)}`);
    }
    db.exec('DROP TABLE session_messages_fts');
    db.exec('ALTER TABLE session_messages_fts_rebuild RENAME TO session_messages_fts');
    for (const trigger of triggers) {
      db.exec(trigger.sql);
    }
    db.exec('COMMIT');
    return stagingRows;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // SQLite may already have rolled back the transaction.
    }
    throw err;
  }
}
