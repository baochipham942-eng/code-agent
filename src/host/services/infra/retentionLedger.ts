// ============================================================================
// Retention Ledger - 保留清理共用的计数/发布账本
// ----------------------------------------------------------------------------
// audioRetention 原本内联一份模块级账本（lastSweepAt / deletedTotal / failedTotal /
// lastError + publish + countFailed）。多个保留清理（音频、pptx 逐页预览缓存…）
// 需要同一套记账：sweep 只记日志不抛错，失败累计进账本供状态出口读取。
// 这里只抽两家都需要的部分，行为与原内联实现一致。
// ============================================================================

export interface RetentionLedgerStatus {
  lastSweepAt: number | null;
  deletedTotal: number;
  failedTotal: number;
  lastError?: string;
}

/** 单次 sweep 的失败累计形状（failed 计数 + 最后一个原因） */
export interface RetentionFailureCounter {
  failed: number;
  lastError?: string;
}

export interface RetentionLedger {
  /** 账本快照（拷贝，外部改不动内部状态） */
  read(): RetentionLedgerStatus;
  /** 累计一次 sweep 的结果并推进 lastSweepAt */
  publish(deleted: number, failed: number, lastError: string | undefined, at: number): void;
}

export function createRetentionLedger(): RetentionLedger {
  const status: RetentionLedgerStatus = {
    lastSweepAt: null,
    deletedTotal: 0,
    failedTotal: 0,
  };
  return {
    read(): RetentionLedgerStatus {
      const snapshot: RetentionLedgerStatus = {
        lastSweepAt: status.lastSweepAt,
        deletedTotal: status.deletedTotal,
        failedTotal: status.failedTotal,
      };
      if (status.lastError) snapshot.lastError = status.lastError;
      return snapshot;
    },
    publish(deleted, failed, lastError, at): void {
      status.lastSweepAt = at;
      status.deletedTotal += deleted;
      status.failedTotal += failed;
      if (lastError) status.lastError = lastError;
    },
  };
}

/** 记一次失败：计数 +1 并留原因（不覆盖为 undefined） */
export function countRetentionFailed(summary: RetentionFailureCounter, reason: string): void {
  summary.failed += 1;
  summary.lastError = reason;
}
