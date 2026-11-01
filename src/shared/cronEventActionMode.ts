import type { CronEventActionMode, CronJobDefinition } from './contract/cron';

/**
 * 事件自动化的有效执行档（N-TRIGGER-OBSERVE-MODE）。非 event 任务返回 null；
 * event 任务只有显式 'auto' 才会真动，缺失/非法一律按 'observe'（fail-closed）。
 * host 拦截判定与 renderer 档位徽标共用这一处。
 */
export function resolveCronEventActionMode(
  job: Pick<CronJobDefinition, 'schedule' | 'actionMode'>,
): CronEventActionMode | null {
  if (job.schedule?.type !== 'event') return null;
  return job.actionMode === 'auto' ? 'auto' : 'observe';
}
