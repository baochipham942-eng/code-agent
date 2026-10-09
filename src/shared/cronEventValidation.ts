// ============================================================================
// 'event' 调度创建期校验（N-CRON-EVENT-CREATE-UI）—— host 与 renderer 共用的唯一文案源。
// host 的 assertEventScheduleConstraints 用它抛出与历史逐字节相同的错误；
// renderer 表单用它在校验同一份配置时显示同一条提示，两边永远不再各说各话。
// ============================================================================

/**
 * 校验对象的最小形状（结构化收窄，不依赖 CronJobDefinition 全量类型）：
 * renderer 的 draft 在 buildCronJobInput 之前也能拼出这份形状做前置校验。
 */
export interface EventScheduleValidationSubject {
  schedule: {
    type?: unknown;
    source?: unknown;
    eventName?: unknown;
    accountId?: unknown;
  };
  runsOn?: unknown;
  action?: { type?: unknown };
  maxRunBudget?: unknown;
}

/** 违规类别（稳定标识）：renderer 用它查本地化文案，不动 message 本身。 */
export type EventScheduleValidationReason =
  | 'invalid-schedule'
  | 'requires-local'
  | 'agent-only'
  | 'requires-budget';

export interface EventScheduleViolation {
  reason: EventScheduleValidationReason;
  /** 与 host createJob/updateJob 抛出的错误逐字节相同，勿单独改写一侧。 */
  message: string;
}

/**
 * event 任务的创建期护栏（纯函数）：返回第一条违规（reason + 英文文案），合规返回 null。
 * message 与 host createJob/updateJob 抛出的错误逐字节相同；renderer 不直接展示
 * message，而是按 reason 映射本地化提示（同一份判据，两套呈现）。
 */
export function validateEventScheduleConstraints(subject: EventScheduleValidationSubject): EventScheduleViolation | null {
  if (subject.schedule?.type !== 'event') return null;
  if (
    subject.schedule.source !== 'channel'
    || subject.schedule.eventName !== 'message'
    || typeof subject.schedule.accountId !== 'string'
    || !subject.schedule.accountId.trim()
  ) {
    return {
      reason: 'invalid-schedule',
      message: "Invalid event schedule: source must be 'channel', eventName must be 'message', and accountId must be a non-empty string.",
    };
  }
  if (subject.runsOn !== 'local') {
    return {
      reason: 'requires-local',
      message: "Event-triggered jobs require runsOn 'local'; cloud execution is not supported.",
    };
  }
  if (subject.action?.type !== 'agent') {
    return {
      reason: 'agent-only',
      message: 'Event-triggered jobs only support agent actions; channel payloads are never routed into other action types.',
    };
  }
  const budget = subject.maxRunBudget;
  if (budget == null || !Number.isFinite(budget) || (budget as number) <= 0) {
    return {
      reason: 'requires-budget',
      message: 'Event-triggered jobs require maxRunBudget > 0 so every run is cost-bounded.',
    };
  }
  return null;
}
