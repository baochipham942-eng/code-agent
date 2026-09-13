// ============================================================================
// Memories FTS5 — memories 表的 BM25 检索通道（roadmap 2.5）
// ============================================================================
// Adapted from MiMoCode (XiaomiMiMo/MiMo-Code, MIT license) — memory 模块的
// SQLite FTS5 + BM25 检索设计；实现按 Neo 的 memories 单表 + triggers 模式重写，
// 与 transcript_fts（roadmap 2.1）共用同一套基建风格。
//
// 用途：embedding 之外的零成本本地检索通道。MemoryRepository.searchMemories
// 升级为 BM25 召回优先（相关性排序），LIKE 兜底；packMemoryEntries 用它做
// 超出"最近 N 条"窗口的混合召回。
// ============================================================================

function memoriesFtsTableSql(tableName: string, ifNotExists: boolean): string {
  return `
  CREATE VIRTUAL TABLE ${ifNotExists ? 'IF NOT EXISTS ' : ''}${tableName} USING fts5(
    memory_id UNINDEXED,
    type UNINDEXED,
    category UNINDEXED,
    content,
    summary,
    tokenize = 'trigram'
  )
`;
}

export const MEMORIES_FTS_TABLE_SQL = memoriesFtsTableSql('memories_fts', true);

function insertColumns(tableName: string): string {
  return `INSERT INTO ${tableName} (memory_id, type, category, content, summary)`;
}

function insertSelect(ref: string, fromMemories: boolean, tableName = 'memories_fts'): string {
  return `
    ${insertColumns(tableName)}
    SELECT ${ref}.id, ${ref}.type, ${ref}.category,
           COALESCE(${ref}.content, ''), COALESCE(${ref}.summary, '')
    ${fromMemories ? `FROM memories ${ref}` : ''}`;
}

/** backfill 用的 INSERT…SELECT（扫全量 memories 表） */
export const MEMORIES_FTS_BACKFILL_SQL = insertSelect('m', true);

/**
 * 原子执行全量 backfill；失败回滚并抛错（防半截索引被幂等检查永久跳过）。
 * 调用方负责幂等前置检查（FTS 空 + memories 非空）与错误兜底。
 */
export function runMemoriesFtsBackfill(db: {
  exec(sql: string): unknown;
  prepare(sql: string): { run(): { changes?: number | bigint } };
}): number {
  db.exec('BEGIN');
  try {
    const inserted = Number(db.prepare(MEMORIES_FTS_BACKFILL_SQL).run().changes ?? 0);
    db.exec('COMMIT');
    return inserted;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // 事务已被 SQLite 自动回滚时 ROLLBACK 会报错，忽略
    }
    throw err;
  }
}

type MemoriesFtsDatabase = {
  exec(sql: string): unknown;
  prepare(sql: string): {
    all(): unknown[];
    get(): unknown;
    run(): { changes?: number | bigint };
  };
};

function quoteSqlIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function memoriesTriggerDefinitions(db: MemoriesFtsDatabase): Array<{ name: string; sql: string }> {
  return db.prepare(`
    SELECT name, sql
    FROM sqlite_master
    WHERE type = 'trigger'
      AND instr(sql, 'memories_fts') > 0
      AND sql IS NOT NULL
  `).all() as Array<{ name: string; sql: string }>;
}

/**
 * 在独立 staging FTS 中全量重建，校验后于同一事务内替换正式表。
 * 与 rebuildSessionMessagesFts / rebuildTranscriptFts 同阶梯。
 */
export function rebuildMemoriesFts(db: MemoriesFtsDatabase): number {
  const stagingTable = 'memories_fts_rebuild';
  db.exec('BEGIN IMMEDIATE');
  try {
    const triggers = memoriesTriggerDefinitions(db);
    db.exec(`DROP TABLE IF EXISTS ${stagingTable}`);
    db.exec(memoriesFtsTableSql(stagingTable, false));
    db.prepare(insertSelect('m', true, stagingTable)).run();

    const sourceRows = Number(
      (db.prepare('SELECT COUNT(*) AS count FROM memories').get() as { count: number | bigint }).count,
    );
    const stagingRows = Number(
      (db.prepare(`SELECT COUNT(*) AS count FROM ${stagingTable}`).get() as { count: number | bigint }).count,
    );
    if (stagingRows !== sourceRows) {
      throw new Error(`Memories FTS rebuild row count mismatch: source=${sourceRows}, staging=${stagingRows}`);
    }

    for (const trigger of triggers) {
      db.exec(`DROP TRIGGER ${quoteSqlIdentifier(trigger.name)}`);
    }
    db.exec('DROP TABLE memories_fts');
    db.exec(`ALTER TABLE ${stagingTable} RENAME TO memories_fts`);
    for (const trigger of triggers) {
      db.exec(trigger.sql);
    }
    db.exec('COMMIT');
    return stagingRows;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // 事务已被 SQLite 自动回滚时 ROLLBACK 会报错，忽略
    }
    throw err;
  }
}

/**
 * 把用户查询归一化成 FTS5 安全的 MATCH 表达式。
 * 以 `"` 开头视为 raw FTS5 语法原样透传；否则包成 phrase literal。
 * （与 SessionRepository.normalizeFtsQuery 同语义；调用方需 catch 语法错误。）
 */
export function normalizeFtsMatchQuery(raw: string): string {
  if (raw.startsWith('"')) {
    return raw;
  }
  return '"' + raw.replace(/"/g, '""') + '"';
}

/**
 * 应用 memories_fts 表 + 同步 triggers。幂等；insert/update trigger 走
 * drop + recreate，已有库升级时拿到最新规则。
 * 注：metadata / project_path 等列变化不触发重建——FTS 只索引 content/summary，
 * type/category 作为过滤列在内容更新时一并刷新即可。
 */
export function applyMemoriesFtsSchema(db: { exec(sql: string): unknown }): void {
  db.exec(MEMORIES_FTS_TABLE_SQL);

  db.exec(`
    DROP TRIGGER IF EXISTS memories_ai_fts;
    DROP TRIGGER IF EXISTS memories_au_fts;
  `);

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS memories_ai_fts AFTER INSERT ON memories BEGIN
      ${insertSelect('new', false)};
    END
  `);

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS memories_ad_fts AFTER DELETE ON memories BEGIN
      DELETE FROM memories_fts WHERE memory_id = old.id;
    END
  `);

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS memories_au_fts
    AFTER UPDATE OF content, summary, type, category ON memories BEGIN
      DELETE FROM memories_fts WHERE memory_id = old.id;
      ${insertSelect('new', false)};
    END
  `);
}
