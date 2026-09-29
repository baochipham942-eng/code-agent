// ============================================================================
// 启动期 FTS 投影核对闸门（N-BOOT-DB-CHECKS）
// ============================================================================
// session_messages_fts / transcript_fts 平时由 messages 上的触发器同步维护，触发器与源写入
// 同一事务、原子生效。启动时的全表计数核对（冷缓存 1~3s）只为兜住「触发器不在或被改」
// 期间漏掉的行。所以指纹锚在「触发器与表定义」上，而不是源表行数：源表每次使用都会变，
// 锚在行数上等于每次开机都全量核对。
//
// 指纹 = messages 与投影表在 sqlite_master 里的全部定义（表、索引、触发器）+ user_version。
// 跳过条件（全部满足才跳）：
//   1. 上次完整核对通过（或重建完成）后记下的指纹 === 本次开库 applySchema 之前的指纹
//      （外部工具删过触发器、旧版本改过触发器、运行期 FTS 修复重建过表，都会让它变）；
//   2. applySchema 之后的指纹也没变（升级改了触发器/表定义 → 变）；
//   3. 调用方没要求强制（启动 FTS 损坏修复过、库经过恢复/完整性降级）；
//   4. 投影表不处于 empty/disabled 降级态，且廉价计数（_docsize，一行一文档）没有明显异常；
//   5. 距上次完整核对不足 FULL_CHECK_EVERY_N_OPENS 次开库（兜底触发器语义漏洞，
//      例如 REPLACE 删除不触发 delete 触发器、改 role 不触发 transcript 重索引）。
// 任何一步自身出错都退回完整核对，且完整核对开始前先删记录：核对失败/中途崩溃不会留下
// 「已核对」的假记录。
// ============================================================================

import { createHash } from 'node:crypto';
import type BetterSqlite3 from 'better-sqlite3';
import { createLogger } from '../../infra/logger';
import { isFtsSearchDegraded } from './ftsRepair';

const logger = createLogger('ProjectionCheckGate');

export type GatedProjection = 'session_messages_fts' | 'transcript_fts';

/** 每 N 次开库强制完整核对一次：兜底指纹覆盖不到的漂移路径 */
const FULL_CHECK_EVERY_N_OPENS = 20;

const GATED_PROJECTIONS: readonly GatedProjection[] = ['session_messages_fts', 'transcript_fts'];

/** 读 messages 与两张投影表的 DDL 签名。表还不存在（全新库）时照样返回签名。 */
function readProjectionSchemaSignature(db: BetterSqlite3.Database): string {
  const rows = db.prepare(`
    SELECT type, name, tbl_name, sql
    FROM sqlite_master
    WHERE tbl_name IN ('messages', ${GATED_PROJECTIONS.map(() => '?').join(', ')})
    ORDER BY type, name
  `).all(...GATED_PROJECTIONS);
  const userVersion = db.pragma('user_version', { simple: true });
  return createHash('sha256').update(JSON.stringify({ rows, userVersion })).digest('hex');
}

/** 开库后、applySchema 之前调用；读失败返回 null（闸门按「签名变了」完整核对），不阻塞启动 */
export function readProjectionSchemaBeforeBoot(db: BetterSqlite3.Database): string | null {
  try {
    return readProjectionSchemaSignature(db);
  } catch {
    return null;
  }
}

function ensureTable(db: BetterSqlite3.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS startup_projection_checks (
      projection TEXT PRIMARY KEY,
      schema_signature TEXT NOT NULL,
      opens_since_full_check INTEGER NOT NULL,
      verified_at INTEGER NOT NULL
    )
  `);
}

function countOrNull(db: BetterSqlite3.Database, sql: string): number | null {
  try {
    return Number((db.prepare(sql).get() as { count: number | bigint }).count);
  } catch {
    return null;
  }
}

/** 廉价异常信号：_docsize 与 FTS 行一一对应；messages 走最小索引计数。 */
function projectionLooksBroken(db: BetterSqlite3.Database, projection: GatedProjection): boolean {
  const projectionRows = countOrNull(db, `SELECT COUNT(*) AS count FROM ${projection}_docsize`);
  const messageRows = countOrNull(db, 'SELECT COUNT(*) AS count FROM messages');
  if (projectionRows === null || messageRows === null) return true;
  if (projectionRows === 0 && messageRows > 0) return true;
  // session_messages_fts 每条消息至多一行，超出即有重复/残留
  return projection === 'session_messages_fts' && projectionRows > messageRows;
}

function fullCheckReason(
  db: BetterSqlite3.Database,
  projection: GatedProjection,
  input: { force: boolean; signatureBeforeSchema: string | null; signatureNow: string },
): string | null {
  if (input.force) return 'forced';
  const record = db.prepare(`
    SELECT schema_signature, opens_since_full_check
    FROM startup_projection_checks
    WHERE projection = ?
  `).get(projection) as { schema_signature: string; opens_since_full_check: number } | undefined;
  if (!record) return 'no-record';
  if (input.signatureBeforeSchema === null || record.schema_signature !== input.signatureBeforeSchema) {
    return 'schema-changed-outside';
  }
  if (record.schema_signature !== input.signatureNow) return 'schema-upgraded';
  if (isFtsSearchDegraded(projection)) return 'degraded';
  if (projectionLooksBroken(db, projection)) return 'cheap-count-anomaly';
  if (record.opens_since_full_check + 1 >= FULL_CHECK_EVERY_N_OPENS) return 'periodic';
  return null;
}

/**
 * 需要时才跑 check（现行完整核对 + 按需重建）。check 在核对通过或重建完成时调 onVerified，
 * 闸门据此记下指纹；check 走降级/失败分支不调 onVerified，下次开机继续完整核对。
 */
export function runGatedProjectionCheck(
  db: BetterSqlite3.Database,
  projection: GatedProjection,
  input: { force: boolean; signatureBeforeSchema: string | null; now: number },
  check: (onVerified: () => void) => void,
): 'skipped' | 'checked' {
  let reason: string | null;
  try {
    ensureTable(db);
    reason = fullCheckReason(db, projection, { ...input, signatureNow: readProjectionSchemaSignature(db) });
    if (reason === null) {
      db.prepare(`
        UPDATE startup_projection_checks
        SET opens_since_full_check = opens_since_full_check + 1
        WHERE projection = ?
      `).run(projection);
      return 'skipped';
    }
    db.prepare('DELETE FROM startup_projection_checks WHERE projection = ?').run(projection);
  } catch (err) {
    logger.warn('projection check gate failed; running full check', { projection, error: err });
    check(() => undefined);
    return 'checked';
  }

  logger.info(`full check ${projection}: reason=${reason}`);
  check(() => {
    try {
      // 重建会改表定义（RENAME），所以在通过的这一刻重读签名
      db.prepare(`
        INSERT OR REPLACE INTO startup_projection_checks
          (projection, schema_signature, opens_since_full_check, verified_at)
        VALUES (?, ?, 0, ?)
      `).run(projection, readProjectionSchemaSignature(db), input.now);
    } catch (err) {
      logger.warn('recording projection check failed (next boot re-checks)', { projection, error: err });
    }
  });
  return 'checked';
}
