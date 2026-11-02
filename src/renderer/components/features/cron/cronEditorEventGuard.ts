// ============================================================================
// cronEditorEventGuard —— 编辑器 event 系调度的本地护栏判据（纯函数）。
// 从 CronJobEditor.tsx 抽出（N-CRON-MORNING-TRIAGE-REST1：编辑器逼近 1000 行
// 上限，新代码进新文件）；判据与 buildCronJobInput / host createJob 同一份
// shared 校验器，只是把 draft 形状拼回校验器口径。
// ============================================================================

import { validateEventScheduleConstraints, type EventScheduleViolation } from '@shared/cronEventValidation';
import type { CronJobDraft } from './types';

/** draft 形状 → shared 校验器口径（与 buildCronJobInput 提交前兜底用同一份判据）。 */
export function eventViolationFromDraft(draft: CronJobDraft): EventScheduleViolation | null {
  const budgetText = draft.maxRunBudget.trim();
  // 'event-mail'（connector:mail）：账号来自下拉（可改绑），直接校验 mail 形状；
  // 'event'（通道）：照旧拼 channel 形状（与 buildCronJobInput 的回建路径同一份输入）。
  const schedule = draft.scheduleType === 'event-mail'
    ? {
      type: 'event' as const,
      source: 'connector' as const,
      connector: 'mail' as const,
      eventName: 'message' as const,
      accountId: draft.eventMailAccountId,
    }
    : draft.scheduleType === 'event-webhook'
      ? {
        type: 'event' as const,
        source: 'webhook' as const,
        eventName: 'message' as const,
      }
      : {
        type: 'event' as const,
        source: 'channel' as const,
        eventName: 'message' as const,
        accountId: draft.eventAccountId,
      };
  return validateEventScheduleConstraints({
    schedule,
    runsOn: draft.runsOn,
    action: { type: draft.actionType },
    maxRunBudget: budgetText === '' ? null : Number(budgetText),
  });
}

/** event 系调度（通道消息 / 新邮件 / 已落库 webhook）：共用的创建期护栏与本地化提示走同一条路。 */
export function isEventScheduleKind(scheduleType: CronJobDraft['scheduleType']): boolean {
  return scheduleType === 'event' || scheduleType === 'event-mail' || scheduleType === 'event-webhook';
}
