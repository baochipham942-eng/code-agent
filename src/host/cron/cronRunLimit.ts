// ============================================================================
// CronRunLimit —— 定时任务次数上限（N-CRON-BUDGET-EXPOSE）
//
// maxRuns（整数 >= 1，仅本地任务）到达后自动停用，停用原因 metadata.disabledReason
// 为 'max_runs_reached'，并向待过目收件箱记一条 max_runs:<jobId> 事件。
// 计数规则、重新启用重置与通知出口全部集中在这里——cronService.ts 已贴 max-lines
// 红线，那里只留 finally / updateJob 里的各一两行接线。
// ============================================================================

import type { CronJobDefinition, CronJobExecution } from '../../shared/contract/cron';
import { getSessionAutomationService } from '../services/sessionAutomation';
import { getCronAutomationType } from './cronAutomationBridge';
import { notifyCronJobDisabled } from './cronFailurePolicy';
import { updateCronJobRunCount } from './cronPersistence';

interface CronRunLimitOutcome {
  /** 本次执行结算后的已计数运行数。 */
  runCount: number;
  /** 本次执行是否触达 maxRuns 上限。 */
  limitReached: boolean;
}

/**
 * 把一趟结束的执行结算进运行计数（纯函数；窄写落账见 writeCronRunCountNarrow）。
 * 计数口径：终态 completed / failed 即计 1——finally 每趟只结算一次，退避重试在同一
 * 个 execution 对象上原地累加 retryAttempt（retryExecution，PR#2208 ai-review R3：
 * 旧口径要求 retryAttempt === 0，导致任何进过重试链的趟永远不计数，maxRuns 形同虚设）；
 * cancelled（排队等容量被中断）/ interrupted 不计；手动 triggerJob 照常计；
 * 一次性（at）任务本就只跑一趟、云端运行不在本地计数，两者跳过。
 */
function applyRunToLimit(
  definition: Pick<CronJobDefinition, 'scheduleType' | 'runsOn' | 'maxRuns' | 'runCount'>,
  execution: Pick<CronJobExecution, 'status'>,
): CronRunLimitOutcome {
  const runCount = definition.runCount ?? 0;
  if (definition.scheduleType === 'at' || definition.runsOn === 'cloud') {
    return { runCount, limitReached: false };
  }
  const counted = execution.status === 'completed' || execution.status === 'failed';
  if (!counted) return { runCount, limitReached: false };
  const next = runCount + 1;
  return {
    runCount: next,
    limitReached: definition.maxRuns != null && next >= definition.maxRuns,
  };
}

/**
 * 重新启用一个已停用的任务：运行计数清零、摘掉停用原因——重新武装 = 给一整个
 * 新额度。只编辑 maxRuns 不走这里，计数保持不变（updateJob 里的单行调用）。
 */
export function rearmCronRunLimit(job: CronJobDefinition): void {
  job.runCount = 0;
  if (job.metadata && 'disabledReason' in job.metadata) {
    const { disabledReason: _dropped, ...restMetadata } = job.metadata;
    job.metadata = restMetadata;
  }
}

/** settleCronRunLimit 需要的两件 cronService 能力（闭包注入，避免反向依赖）。 */
export interface CronRunLimitHooks {
  getDefinition: (jobId: string) => CronJobDefinition | undefined;
  updateJob: CronServiceUpdateJob;
}

type CronServiceUpdateJob = (
  jobId: string,
  updates: Partial<Omit<CronJobDefinition, 'id' | 'createdAt'>>,
) => Promise<CronJobDefinition | null>;

/**
 * executeJob finally 里的次数上限结算：排在失败停用分档之后——同一趟已按
 * permanent/consecutive 停用的（disableNotified）或已不在启用态的，不再按
 * max_runs 重复停用/通知。返回更新后的 disableNotified。
 *
 * 整体兜底 try/catch（PR#2208 ai-review Important）：任何一步抛错（如遗留任务过不了
 * 现行调度校验、落库失败）都不许逃出 executeJob 的 finally——那里后面还有执行通知与
 * inFlightJobIds 释放，逃了任务会被 "previous run still in progress" 永久卡死。
 */
export async function settleCronRunLimit(
  jobId: string,
  execution: CronJobExecution,
  disableNotified: boolean,
  hooks: CronRunLimitHooks,
): Promise<boolean> {
  try {
    const base = hooks.getDefinition(jobId);
    if (!base) return disableNotified;
    const outcome = applyRunToLimit(base, execution);
    if (outcome.runCount !== (base.runCount ?? 0)) {
      // 记数走窄写：不走 updateJob——它会先停定时器、重跑调度校验再整行重写，
      // 无 maxRuns 的任务每趟都被这么来一遍；旧任务过不了现行校验或落库抛错时
      // 定时器已停且不再注册（PR#2208 ai-review Important）。
      await writeCronRunCountNarrow(base, outcome.runCount);
    }
    const latest = hooks.getDefinition(jobId);
    if (!outcome.limitReached || disableNotified || !latest?.enabled) return disableNotified;
    await hooks.updateJob(jobId, {
      enabled: false,
      metadata: { ...latest.metadata, disabledReason: 'max_runs_reached' },
    });
    notifyCronJobDisabled(latest, execution, 'max_runs');
    await recordMaxRunsReachedEvent(latest);
    return true;
  } catch (error) {
    console.error(`[CronService] Job ${jobId} run-limit settle failed (job keeps running):`, error);
    return disableNotified;
  }
}

/**
 * 运行计数的窄写：内存定义原地改计数 + DB run_count 单列更新——不走 updateJob 的
 * 停定时器/重校验/整行重写，updatedAt 不 churn（PR#2208 ai-review Important）。
 */
export async function writeCronRunCountNarrow(
  definition: CronJobDefinition | undefined,
  runCount: number,
): Promise<void> {
  if (!definition) return;
  definition.runCount = runCount;
  await updateCronJobRunCount(definition.id, runCount);
}

/**
 * 到数停用后往「待过目」收件箱记一条事件（复用既有自动化通道，不开新通道）。
 * recordStatus 钉住 paused：updateJob 的 sync 已把记录置 paused，这里不能
 * 让事件落库把它又抬回 active/completed。
 */
async function recordMaxRunsReachedEvent(definition: CronJobDefinition): Promise<void> {
  try {
    await getSessionAutomationService().recordEvent({
      type: getCronAutomationType(definition),
      sourceRefId: definition.id,
      event: 'completed',
      status: 'completed',
      recordStatus: 'paused',
      summary: `已达运行次数上限（${definition.maxRuns ?? '?'} 次），任务已自动停用。`
        + '可在「自动化中心 → 定时任务」重新启用，重新启用后计数清零。',
      eventId: `max_runs:${definition.id}`,
    });
  } catch (error) {
    console.error('[CronService] Failed to record max-runs automation event:', error);
  }
}
