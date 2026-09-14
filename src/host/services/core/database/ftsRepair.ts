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

export const FTS_TABLES = ['session_messages_fts', 'transcript_fts', 'memories_fts'] as const;
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

export function resetFtsRepairStateForTests(): void {
  availability.clear();
}

export function markFtsTableDisabledForTests(table: FtsTableName): void {
  availability.set(table, 'disabled');
}

export function markFtsTableEmptyForTests(table: FtsTableName): void {
  availability.set(table, 'empty');
}

export function isFtsTableCorrupt(db: BetterSqlite3.Database, table: FtsTableName): boolean {
  const quoted = quoteSqlIdentifier(table);
  try {
    db.prepare(`SELECT 1 FROM ${quoted} LIMIT 1`).get();
  } catch (err) {
    return isSqliteCorruptionError(err);
  }
  try {
    db.prepare(`SELECT 1 FROM ${quoted} WHERE ${quoted} MATCH ? LIMIT 1`).get(SQLITE_FTS.HEALTH_PROBE_MATCH);
  } catch (err) {
    return isSqliteCorruptionError(err);
  }
  return false;
}

export function repairFtsTable(
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
}

const MESSAGE_FTS_TABLES: FtsTableName[] = ['session_messages_fts', 'transcript_fts'];

export function repairMessageProjectionFts(db: BetterSqlite3.Database): void {
  const targets = MESSAGE_FTS_TABLES.filter((table) => {
    if (isFtsDisabled(table)) return true;
    return isFtsTableCorrupt(db, table);
  });
  const toRepair = targets.length > 0 ? targets : MESSAGE_FTS_TABLES;
  for (const table of toRepair) {
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
      repairMessageProjectionFts(db);
    }
  }
}

/**
 * 事务写路径的修复包装。事务函数抛损坏错误时，better-sqlite3 通常已回滚
 * （inTransaction=false），但损坏库上 ROLLBACK 本身可能失败、事务仍挂着——
 * 两种情况下都必须先在事务外跑修复阶梯，再整体重试一次事务。
 * 事务已整体回滚，重跑幂等；重试仍坏则把错误抛给调用方。
 */
export function runTransactionWithFtsRepair(db: BetterSqlite3.Database, tx: () => void): void {
  try {
    tx();
    return;
  } catch (err) {
    if (!isSqliteCorruptionError(err)) throw err;
    rollbackIfNeeded(db);
    repairMessageProjectionFts(db);
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
