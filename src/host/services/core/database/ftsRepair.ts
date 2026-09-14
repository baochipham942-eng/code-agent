/**
 * FTS 损坏自愈阶梯：重建 → 空表（DROP 失败则隔离改名）→ 禁用写触发器。
 * 每步失败降下一级，全程不抛。
 */

import type BetterSqlite3 from 'better-sqlite3';
import { SQLITE_FTS } from '../../../../shared/constants';
import { MEMORIES_FTS_TABLE_SQL, rebuildMemoriesFts } from '../../../../shared/memoriesFts.sql';
import { TRANSCRIPT_FTS_TABLE_SQL, rebuildTranscriptFts } from '../../../../shared/transcriptFts.sql';
import { createLogger } from '../../infra/logger';
import {
  SESSION_MESSAGES_FTS_TABLE_SQL,
  rebuildSessionMessagesFts,
} from './sessionMessagesFts';
import { isSqliteCorruptionError } from './sqliteErrors';

const logger = createLogger('FtsRepair');

const FTS_TABLES = ['session_messages_fts', 'transcript_fts', 'memories_fts'] as const;
export type FtsTableName = (typeof FTS_TABLES)[number];
export type FtsRepairOutcome = 'rebuilt' | 'empty-recreated' | 'disabled';
type FtsAvailability = 'ok' | 'empty' | 'disabled';

export interface FtsRepairHooks {
  rebuild: (db: BetterSqlite3.Database) => number;
  recreateEmpty: (db: BetterSqlite3.Database) => void;
}

type TriggerDefinition = { name: string; sql: string };

const availability = new Map<FtsTableName, FtsAvailability>();

const CREATE_SQL: Record<FtsTableName, string> = {
  session_messages_fts: SESSION_MESSAGES_FTS_TABLE_SQL,
  transcript_fts: TRANSCRIPT_FTS_TABLE_SQL,
  memories_fts: MEMORIES_FTS_TABLE_SQL,
};

function quoteSqlIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function rollbackIfNeeded(db: BetterSqlite3.Database): void {
  if (!db.inTransaction) return;
  try {
    db.exec('ROLLBACK');
  } catch {
    // SQLite may already have rolled back the transaction.
  }
}

function withImmediateTransaction(db: BetterSqlite3.Database, fn: () => void): void {
  rollbackIfNeeded(db);
  db.exec('BEGIN IMMEDIATE');
  try {
    fn();
    db.exec('COMMIT');
  } catch (err) {
    rollbackIfNeeded(db);
    throw err;
  }
}

function ftsTriggerDefinitions(db: BetterSqlite3.Database, table: FtsTableName): TriggerDefinition[] {
  return db.prepare(`
    SELECT name, sql
    FROM sqlite_master
    WHERE type = 'trigger'
      AND instr(sql, ?) > 0
      AND sql IS NOT NULL
  `).all(table) as TriggerDefinition[];
}

function dropTriggers(db: BetterSqlite3.Database, triggers: TriggerDefinition[]): void {
  for (const trigger of triggers) {
    db.exec(`DROP TRIGGER IF EXISTS ${quoteSqlIdentifier(trigger.name)}`);
  }
}

function recreateTriggers(db: BetterSqlite3.Database, triggers: TriggerDefinition[]): void {
  for (const trigger of triggers) {
    db.exec(trigger.sql);
  }
}

function defaultRebuild(db: BetterSqlite3.Database, table: FtsTableName): number {
  if (table === 'session_messages_fts') return rebuildSessionMessagesFts(db);
  if (table === 'transcript_fts') return rebuildTranscriptFts(db);
  return rebuildMemoriesFts(db);
}

function recreateEmptyFtsTable(db: BetterSqlite3.Database, table: FtsTableName): void {
  const createSql = CREATE_SQL[table];
  const triggers = ftsTriggerDefinitions(db, table);
  try {
    withImmediateTransaction(db, () => {
      dropTriggers(db, triggers);
      db.exec(`DROP TABLE ${quoteSqlIdentifier(table)}`);
      db.exec(createSql);
      recreateTriggers(db, triggers);
    });
    return;
  } catch (err) {
    logger.warn('DROP+recreate failed; isolating corrupt table', {
      table,
      error: err,
    });
  }

  withImmediateTransaction(db, () => {
    dropTriggers(db, triggers);
    const isolated = `${table}_corrupt_${Date.now()}`;
    db.exec(`ALTER TABLE ${quoteSqlIdentifier(table)} RENAME TO ${quoteSqlIdentifier(isolated)}`);
    db.exec(createSql);
    recreateTriggers(db, triggers);
  });
}

function disableFtsWrites(db: BetterSqlite3.Database, table: FtsTableName): void {
  rollbackIfNeeded(db);
  try {
    const triggers = ftsTriggerDefinitions(db, table);
    dropTriggers(db, triggers);
  } catch (err) {
    logger.warn('dropping FTS triggers failed', { table, error: err });
  }
}

export function isFtsDisabled(table: FtsTableName): boolean {
  return availability.get(table) === 'disabled';
}

export function isFtsSearchDegraded(table: FtsTableName): boolean {
  const state = availability.get(table);
  return state === 'disabled' || state === 'empty';
}

export function getDisabledFtsTables(): FtsTableName[] {
  return FTS_TABLES.filter((table) => availability.get(table) === 'disabled');
}

export function getEmptyRecreatedFtsTables(): FtsTableName[] {
  return FTS_TABLES.filter((table) => availability.get(table) === 'empty');
}

/** backfill 重建成功后消除 empty 降级态（disabled 态由 backfill 前置跳过，不会走到这里） */
export function markFtsTableAvailable(table: FtsTableName): void {
  availability.set(table, 'ok');
}

/**
 * backfill 路径的修复门（与写/搜索路径同一不变式）：探针确认 FTS 表没坏——
 * 坏在源表（messages/memories）——就不动它：重建修不好还白 DROP 完好索引，
 * 且每次启动 backfill 会重复删建。只报警不抛（启动维护纪律）。
 * 探针 corrupt/unknown 才进修复阶梯。
 */
export function repairFtsTableIfCorrupt(db: BetterSqlite3.Database, table: FtsTableName): void {
  try {
    if (probeFtsTable(db, table) === 'ok') {
      logger.warn('corruption is not in the FTS table; leaving it untouched', { table });
      return;
    }
    repairFtsTable(db, table);
  } catch (err) {
    logger.warn('backfill repair failed (ignored)', { table, error: err });
  }
}

/**
 * 修复阶梯自身抛错（如 DB 只读、隔离改名也失败）时落降级态：
 * 后续搜索直接走 LIKE 兜底，不再每次搜索都重复撞一遍修复阶梯。
 */
export function markFtsTableRepairFailed(table: FtsTableName): void {
  availability.set(table, 'disabled');
}

/**
 * 逐表损坏探针：'corrupt' = 确认损坏（可进修复阶梯）；'ok' = 确认完好（不许动）；
 * 'unknown' = 探针自身查不了（非损坏类错误，如表不存在/IO）——保守路径才用。
 */
export function probeFtsTable(
  db: BetterSqlite3.Database,
  table: FtsTableName,
): 'corrupt' | 'ok' | 'unknown' {
  const quoted = quoteSqlIdentifier(table);
  try {
    db.prepare(`SELECT 1 FROM ${quoted} LIMIT 1`).get();
  } catch (err) {
    return isSqliteCorruptionError(err) ? 'corrupt' : 'unknown';
  }
  try {
    db.prepare(`SELECT 1 FROM ${quoted} WHERE ${quoted} MATCH ? LIMIT 1`).get(SQLITE_FTS.HEALTH_PROBE_MATCH);
  } catch (err) {
    return isSqliteCorruptionError(err) ? 'corrupt' : 'unknown';
  }
  return 'ok';
}

function isFtsTableCorrupt(db: BetterSqlite3.Database, table: FtsTableName): boolean {
  return probeFtsTable(db, table) === 'corrupt';
}

export const repairFtsTable = Object.assign(
  function repairFtsTable(
    db: BetterSqlite3.Database,
    table: FtsTableName,
    hooks: Partial<FtsRepairHooks> = {},
  ): FtsRepairOutcome {
    const rebuild = hooks.rebuild ?? ((database) => defaultRebuild(database, table));
    const recreateEmpty = hooks.recreateEmpty ?? ((database) => recreateEmptyFtsTable(database, table));

    try {
      rebuild(db);
      availability.set(table, 'ok');
      logger.info('FTS rebuilt', { table, outcome: 'rebuilt' });
      return 'rebuilt';
    } catch (err) {
      logger.warn('rebuild failed; trying empty recreate', { table, error: err });
    }

    try {
      recreateEmpty(db);
    } catch (err) {
      logger.warn('empty recreate failed; disabling FTS writes', { table, error: err });
      disableFtsWrites(db, table);
      availability.set(table, 'disabled');
      logger.warn('FTS disabled; search will use LIKE fallback', {
        table,
        outcome: 'disabled',
        reason: SQLITE_FTS.DISABLED_REASON,
      });
      return 'disabled';
    }

    // 空表重建成功后立刻回填：损坏页已随 DROP/隔离消失，源表完好时重建应当成功。
    // 成功则降级态当场消除（健康面不报警）；仍失败（如源表也坏）保持 empty 降级态，
    // 由 PersistenceHealth 报 FTS_EMPTY_RECREATED，启动 backfill 兜底。
    try {
      const refilled = rebuild(db);
      availability.set(table, 'ok');
      logger.info('FTS refilled after empty recreate', { table, outcome: 'rebuilt', rows: refilled });
      return 'rebuilt';
    } catch (err) {
      logger.warn('refill after empty recreate failed; staying degraded', { table, error: err });
    }

    availability.set(table, 'empty');
    logger.warn('FTS recreated empty', {
      table,
      outcome: 'empty-recreated',
      reason: SQLITE_FTS.EMPTY_RECREATED_REASON,
    });
    return 'empty-recreated';
  },
  {
    // 测试用助手挂在既有导出上，不作为新 export（knip production 棘轮不认新死导出，见 #1727 同款写法）。
    /** 测试用：清空降级状态机 */
    resetStateForTests(): void {
      availability.clear();
    },
    /** 测试用：直接落 disabled 降级态 */
    markDisabledForTests(table: FtsTableName): void {
      availability.set(table, 'disabled');
    },
    /** 测试用：直接落 empty 降级态 */
    markEmptyForTests(table: FtsTableName): void {
      availability.set(table, 'empty');
    },
  },
);

const MESSAGE_FTS_TABLES: FtsTableName[] = ['session_messages_fts', 'transcript_fts'];

/**
 * 写路径损坏后的 FTS 修复编排。返回 true = 探针确认（或无法排除）FTS 表损坏、
 * 已送修复阶梯，调用方可重试写；false = 探针确认两张消息 FTS 表都完好——
 * 坏在源表/别处，不动 FTS 表（重建修不好还白 DROP 完好索引），调用方应把
 * 原错误原样上抛：主库损坏归启动恢复编排（刀2）管，不是本阶梯的事。
 */
function repairMessageProjectionFts(db: BetterSqlite3.Database): boolean {
  const probes = MESSAGE_FTS_TABLES.map((table) => ({
    table,
    probe: isFtsDisabled(table) ? ('corrupt' as const) : probeFtsTable(db, table),
  }));
  let targets = probes.filter((entry) => entry.probe === 'corrupt').map((entry) => entry.table);
  if (targets.length === 0) {
    if (probes.every((entry) => entry.probe === 'ok')) return false;
    // 探针不确定/查不了：保守路径，两表都送阶梯（对齐阶梯落地时的旧行为）
    targets = MESSAGE_FTS_TABLES;
  }
  for (const table of targets) {
    try {
      if (isFtsDisabled(table)) {
        disableFtsWrites(db, table);
        continue;
      }
      repairFtsTable(db, table);
    } catch (err) {
      logger.warn('message-projection repair failed (ignored)', { table, error: err });
    }
  }
  return true;
}

export function runWithFtsWriteRepair(db: BetterSqlite3.Database, fn: () => void): void {
  const attempts = 1 + SQLITE_FTS.WRITE_RETRY_LIMIT;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      fn();
      return;
    } catch (err) {
      if (db.inTransaction || !isSqliteCorruptionError(err) || attempt + 1 >= attempts) {
        throw err;
      }
      // 探针确认坏的不是 FTS 表 → 不动完好索引，原样上抛
      if (!repairMessageProjectionFts(db)) throw err;
    }
  }
}

/**
 * 事务写路径的修复包装。事务函数抛损坏错误时，better-sqlite3 通常已回滚
 * （inTransaction=false），但损坏库上 ROLLBACK 本身可能失败、事务仍挂着——
 * 两种情况下都必须先在事务外跑修复阶梯，再整体重试一次事务。
 * 事务已整体回滚，重跑幂等；重试仍坏则把错误抛给调用方。
 * 探针确认 FTS 没坏（坏在源表/别处）时不动 FTS 表、原样上抛。
 *
 * 事务归属：进入时已在调用方的外层事务里（inTransaction===true）则不做
 * rollback/修复/重试，原样上抛——ROLLBACK 会把外层事务一起回滚，随后的重试
 * 和后续写入会逐条裸提交，外层 COMMIT 报 no active transaction（半提交）。
 * 嵌套场景下外层会整体回滚，重试语义归最外层调用方（见
 * evidenceInvalidationService 的 immediate 事务里套 updateMessage 的情形）。
 */
export function runTransactionWithFtsRepair(db: BetterSqlite3.Database, tx: () => void): void {
  const ownsTransaction = !db.inTransaction;
  try {
    tx();
    return;
  } catch (err) {
    if (!ownsTransaction || !isSqliteCorruptionError(err)) throw err;
    rollbackIfNeeded(db);
    if (!repairMessageProjectionFts(db)) throw err;
  }
  tx();
}

export function repairCorruptFtsOnStartup(db: BetterSqlite3.Database): void {
  for (const table of FTS_TABLES) {
    try {
      if (!isFtsTableCorrupt(db, table)) continue;
      const outcome = repairFtsTable(db, table);
      logger.warn('startup repair', { table, outcome });
    } catch (err) {
      logger.warn('startup repair failed (ignored)', { table, error: err });
    }
  }
}
