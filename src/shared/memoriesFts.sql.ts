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

export const MEMORIES_FTS_TABLE_SQL = `
  CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
    memory_id UNINDEXED,
    type UNINDEXED,
    category UNINDEXED,
    content,
    summary,
    tokenize = 'trigram'
  )
`;

const INSERT_COLUMNS =
  'INSERT INTO memories_fts (memory_id, type, category, content, summary)';

function insertSelect(ref: string, fromMemories: boolean): string {
  return `
    ${INSERT_COLUMNS}
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
