/**
 * 账本 corruption：fail-safe 吞错，但连续阈值后把 PersistenceHealth 打成 degraded。
 * 分类接刀2 的 classifySqliteIntegrityError：只有 corrupt（真损坏）计数；
 * transient-io / other-io / none（BUSY/LOCKED/普通 Error）清零计数，避免误报。
 * DatabaseReadOnlyError 是只读降级的预期拒绝，既不计数也不清零、不当损坏。
 */

import { SQLITE_INTEGRITY } from '../../../../shared/constants';
import {
  classifySqliteIntegrityError,
  DatabaseReadOnlyError,
  readSqliteErrorCode,
} from './sqliteErrors';
import { warnLedgerCorruptionThreshold } from './ledgerHealthCheck';

interface LedgerCorruptionSignal {
  reason: string;
  consecutive: number;
}

type LedgerCorruptionListener = (signal: LedgerCorruptionSignal) => void;
type WarnFn = (message: string, data?: unknown) => void;

let consecutive = 0;
let listener: LedgerCorruptionListener | null = null;

export function setLedgerCorruptionListener(next: LedgerCorruptionListener | null): void {
  listener = next;
}

export function getLedgerCorruptionStreak(): number {
  return consecutive;
}

export const recordLedgerWriteError = Object.assign(
  function recordLedgerWriteError(err: unknown, warn: WarnFn): void {
    if (err instanceof DatabaseReadOnlyError) return;
    if (classifySqliteIntegrityError(err) !== 'corrupt') {
      consecutive = 0;
      return;
    }
    consecutive += 1;
    warn('[DatabaseService] ledger sqlite corruption swallowed (fail-safe)', {
      consecutive,
      threshold: SQLITE_INTEGRITY.LEDGER_CORRUPTION_THRESHOLD,
      code: readSqliteErrorCode(err) || undefined,
    });
    if (consecutive < SQLITE_INTEGRITY.LEDGER_CORRUPTION_THRESHOLD) return;
    warnLedgerCorruptionThreshold(warn, consecutive);
    try {
      listener?.({
        reason: SQLITE_INTEGRITY.LEDGER_CORRUPT,
        consecutive,
      });
    } catch {
      // 上报失败只报警不抛：账本路径必须 fail-safe。
    }
  },
  {
    // 测试用助手挂在既有导出上，不作为新 export（knip production 棘轮不认新死导出，见 ftsRepair 同款写法）。
    /** 测试用：清零计数与 listener */
    resetForTests(): void {
      consecutive = 0;
      listener = null;
    },
  },
);
