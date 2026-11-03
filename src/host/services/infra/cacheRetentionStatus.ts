// ============================================================================
// Cache Retention Status - 两家 app 缓存保留清理的状态聚合出口
// ----------------------------------------------------------------------------
// appCacheRetention（channel-media / 托管浏览器截图 / appshots）与
// presentationPreviewRetention（pptx 逐页预览旧 revision）各自持有模块级账本，
// 此前只有写入方没有读取方——清理失败只 warn + 计数，用户侧永远看不到
// （错题本 2026-08-14：降级必须留痕，且痕要能被人看见）。
// 本文件把两份账本合成一份给 Settings > Data 的缓存清理失败行：
//   - lastSweepAt 取两家最新一轮；deletedTotal / failedTotal / failedCurrent 求和；
//   - lastError 取「最近一轮带失败」的模块——零失败的一轮会 resetFailures 抹掉
//     lastError，所以仍带 lastError 的模块 = 它最近一轮真的失败了；两家都带时
//     取 lastSweepAt 更新的那个（最近发生的错误对排障最有信息量）。
// retry 立即跑两家 sweep 并返回新状态——用户修好权限后点重试即复检。
// ============================================================================

import { getUserConfigDir } from '../../config/configPaths';
import { getAppCacheRetentionStatus, sweepAppCacheRetention } from './appCacheRetention';
import { createLogger } from './logger';
import {
  getPresentationPreviewRetentionStatus,
  sweepPresentationPreviewRetention,
} from './presentationPreviewRetention';
import type { RetentionLedgerStatus } from './retentionLedger';

const logger = createLogger('CacheRetentionStatus');

export interface CacheRetentionStatus extends RetentionLedgerStatus {
  /** 此刻仍删不掉的失败数（两家求和；零失败清账后归零，失败行只看这份） */
  failedCurrent: number;
  /** 数据目录根：失败行「打开数据文件夹」出口用，四类缓存目录都在它下面 */
  dataDir: string;
}

function mergeLatestError(
  app: RetentionLedgerStatus,
  preview: RetentionLedgerStatus,
): string | undefined {
  if (app.lastError && preview.lastError) {
    return (preview.lastSweepAt ?? Number.NEGATIVE_INFINITY)
      > (app.lastSweepAt ?? Number.NEGATIVE_INFINITY)
      ? preview.lastError
      : app.lastError;
  }
  return app.lastError ?? preview.lastError;
}

export function getCacheRetentionStatus(): CacheRetentionStatus {
  const app = getAppCacheRetentionStatus();
  const preview = getPresentationPreviewRetentionStatus();
  const sweepAt = [app.lastSweepAt, preview.lastSweepAt].filter(
    (value): value is number => typeof value === 'number',
  );
  return {
    lastSweepAt: sweepAt.length > 0 ? Math.max(...sweepAt) : null,
    deletedTotal: app.deletedTotal + preview.deletedTotal,
    failedTotal: app.failedTotal + preview.failedTotal,
    failedCurrent: app.failedCurrent + preview.failedCurrent,
    lastError: mergeLatestError(app, preview),
    dataDir: getUserConfigDir(),
  };
}

/**
 * 立即重跑两家 sweep 并返回新状态。sweep 按契约不抛错（失败全在内部记账）；
 * 这里再兜一层 allSettled + warn：意外抛错不该让重试整单失败、把失败行留在
 * 无解释的旧账上（错题本 2026-08-14：fail-open 不等于失败不留痕）。
 */
export async function retryCacheRetentionSweeps(): Promise<CacheRetentionStatus> {
  const settled = await Promise.allSettled([
    sweepAppCacheRetention(),
    sweepPresentationPreviewRetention(),
  ]);
  for (const result of settled) {
    if (result.status === 'rejected') {
      logger.warn('[缓存保留] 重试清理时意外抛错（账本未推进，失败行保持原样）', {
        reason: result.reason instanceof Error ? result.reason.message : String(result.reason),
      });
    }
  }
  return getCacheRetentionStatus();
}
