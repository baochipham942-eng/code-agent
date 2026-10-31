// ============================================================================
// Event automation action-mode transitions (N-TRIGGER-OBSERVE-MODE)
// ----------------------------------------------------------------------------
// 执行档只收窄、不放宽：
//   - createJob：新建 event 任务一律 'observe'（入参里的 actionMode 被忽略）；
//   - updateJob：入参里的 actionMode 被忽略；保持原档，但调度离开 event 时摘掉、
//     从非 event 改成 event 或改绑事件源（source/账号/群/邮箱）时回落 'observe'；
//   - 唯一能到 'auto' 的路径是 changeEventActionMode（显式的用户确认动作），
//     它同时写一条自动化变更事件（SessionAutomationEventKind 'action_mode_changed'）。
// ============================================================================

import type {
  CronEventActionMode,
  CronJobDefinition,
  CronScheduleConfig,
} from '../../shared/contract/cron';
import { resolveCronEventActionMode } from '../../shared/cronEventActionMode';
import { recordCronAutomationActionModeChanged } from './cronAutomationBridge';

function eventBindingKey(schedule: CronScheduleConfig | undefined): string | null {
  if (schedule?.type !== 'event') return null;
  switch (schedule.source) {
    case 'channel':
      return `channel|${schedule.accountId}|${schedule.chatId ?? ''}`;
    case 'connector':
      return `connector|${schedule.connector}|${schedule.accountId}|${schedule.mailbox ?? ''}`;
    case 'webhook':
      return 'webhook';
  }
}

/** createJob：event 任务恒 'observe'，非 event 任务不带该字段。 */
export function actionModeForNewJob(schedule: CronScheduleConfig | undefined): CronEventActionMode | undefined {
  return schedule?.type === 'event' ? 'observe' : undefined;
}

/** updateJob：沿用原档，改绑/改成 event 时回落 observe；离开 event 时摘掉。 */
export function carryEventActionMode(
  previous: CronJobDefinition,
  next: Pick<CronJobDefinition, 'schedule'>,
): CronEventActionMode | undefined {
  const nextKey = eventBindingKey(next.schedule);
  if (nextKey === null) return undefined;
  if (eventBindingKey(previous.schedule) !== nextKey) return 'observe';
  return resolveCronEventActionMode(previous) ?? 'observe';
}

export interface EventActionModeChangeDeps {
  persistJob: (definition: CronJobDefinition) => Promise<void>;
  /** 落库成功后把新定义放回内存 job 表。 */
  applyDefinition: (definition: CronJobDefinition) => void;
  notifyJobsChanged: () => void;
  now?: () => number;
}

/**
 * 显式切换执行档（用户在确认弹窗里点了「切到自动执行」，或切回仅观察）。
 * 非 event 任务抛错；档位没变时原样返回、不写变更事件。
 */
export async function changeEventActionMode(
  definition: CronJobDefinition,
  mode: CronEventActionMode,
  deps: EventActionModeChangeDeps,
): Promise<CronJobDefinition> {
  const previousMode = resolveCronEventActionMode(definition);
  if (previousMode === null) {
    throw new Error('Action mode applies to event-triggered automations only.');
  }
  if (previousMode === mode) return definition;
  const next: CronJobDefinition = { ...definition, actionMode: mode, updatedAt: (deps.now ?? Date.now)() };
  // 先记变更事件再落库：记不下来就抛错、档位不变（切到 auto 必须留在变更历史里）。
  await recordCronAutomationActionModeChanged(next, previousMode, mode);
  await deps.persistJob(next);
  deps.applyDefinition(next);
  deps.notifyJobsChanged();
  return next;
}
