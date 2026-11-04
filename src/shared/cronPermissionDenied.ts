// ============================================================================
// Cron Permission-Denied Marker — 「有命令没获批准且无产出」标记的形状守卫
// ----------------------------------------------------------------------------
// N-CRON-RUN-COMPLETED-BUT-DENIED：标记由 host 从工具结果推导（host/cron/
// cronPermissionDenied.ts），挂在执行结果与待过目记录上。消费端（通知门、
// 运行列表/详情、收件箱）读的都是 unknown / DB JSON 回读值，必须过形状守卫——
// 坏形状按「没有标记」处理（回落绿色成功态），不让旧数据或脏数据炸渲染。
// ============================================================================

import type {
  CronPermissionDeniedMarker,
  CronPermissionDeniedReason,
} from './contract/sessionAutomation';

const REASONS: readonly CronPermissionDeniedReason[] = ['user', 'timeout', 'cancelled', 'other'];

export function isCronPermissionDeniedMarker(value: unknown): value is CronPermissionDeniedMarker {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.count !== 'number' || !Number.isFinite(record.count) || record.count < 1) return false;
  if (!Array.isArray(record.steps) || record.steps.length === 0) return false;
  return record.steps.every((step) => {
    if (typeof step !== 'object' || step === null || Array.isArray(step)) return false;
    const stepRecord = step as Record<string, unknown>;
    return typeof stepRecord.tool === 'string'
      && typeof stepRecord.summary === 'string'
      && (REASONS as readonly string[]).includes(stepRecord.reason as string);
  });
}
