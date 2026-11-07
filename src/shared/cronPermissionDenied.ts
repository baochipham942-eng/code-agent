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

// ----------------------------------------------------------------------------
// 被拒原因的大白话（zh/en 各四条，单一真源 · Rework r2）：host 完成通知
// （cron/cronFailurePolicy）与 renderer 详情句（i18n/cronCenter 的
// permissionDeniedReason* 四键）用同一组词——host 读不了 renderer i18n，故放
// shared。改措辞只改这里，两侧同步变。
// ----------------------------------------------------------------------------
const REASON_TEXT_ZH: Record<CronPermissionDeniedReason, string> = {
  user: '你当时拒绝了它',
  timeout: '等批准超时，没有人处理',
  cancelled: '运行被取消或重启，批准被作废',
  other: '审批链路出问题，按安全默认拒绝了',
};

const REASON_TEXT_EN: Record<CronPermissionDeniedReason, string> = {
  user: 'you declined it',
  timeout: 'nobody approved it in time',
  cancelled: 'the run was cancelled or restarted, voiding the approval',
  other: 'the approval chain failed and it was denied for safety',
};

export function cronPermissionDeniedReasonText(
  reason: CronPermissionDeniedReason,
  language: 'zh' | 'en',
): string {
  return (language === 'en' ? REASON_TEXT_EN : REASON_TEXT_ZH)[reason];
}
