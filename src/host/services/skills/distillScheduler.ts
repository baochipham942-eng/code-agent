// ============================================================================
// DistillScheduler — 每 30 天自动 distill 的 cron 注册（roadmap 3.2）
//
// ⚠️ 有意未接线（2026-07-25 产品判断，不是遗漏）。理由与 dreamScheduler 同：
// 当前没有任何启动注册点；原先位于已删除的 Electron main 死入口，也没有迁入
// src/web/webStartupServices.ts。它会无人值守自动发起 LLM 调用产生真实费用，属产品
// + 成本判断。详见 src/host/services/memory/dreamScheduler.ts 头注释。
// ============================================================================
// 照 dreamScheduler 模式：scheduleType 'every' + interval days 是日历 cron 的
// 近似（cron service 按 startAt + N*interval 推算下次触发，不是自实现计时器），
// 注册按 tag 幂等。'/distill --auto' 进 cron agent 会话后，由
// buildSkillInvocationContext 的 executor 桥执行六阶段 service run（C4）；
// --auto 模式产出一律走草稿，不自激活。
// ============================================================================

import type { CronJobDefinition } from '../../../shared/contract/cron';
import { DISTILL } from '../../../shared/constants';

export const DISTILL_CRON_JOB_TAG = 'distill-workflow-packaging';
export const DISTILL_AUTO_PROMPT = '/distill --auto';

type DistillCronDefinition = Omit<CronJobDefinition, 'id' | 'createdAt' | 'updatedAt'>;

export interface DistillCronBuildOptions {
  now?: number;
  workingDirectory?: string;
}

export interface DistillCronService {
  listJobs(filter?: { tags?: string[] }): Array<CronJobDefinition | Record<string, unknown>>;
  createJob(definition: DistillCronDefinition): Promise<CronJobDefinition | Record<string, unknown>>;
}

export function buildDistillCronJobDefinition(options: DistillCronBuildOptions = {}): DistillCronDefinition {
  const now = options.now ?? Date.now();
  return {
    name: '[Maintenance] Distill workflow packaging',
    description: 'Review recent sessions and package repeated workflows into command/skill drafts.',
    scheduleType: 'every',
    schedule: {
      type: 'every',
      interval: DISTILL.INTERVAL_DAYS,
      unit: 'days',
      startAt: now,
    },
    action: {
      type: 'agent',
      agentType: 'distill',
      prompt: DISTILL_AUTO_PROMPT,
      context: {
        distillAuto: true,
        ...(options.workingDirectory ? { workingDirectory: options.workingDirectory } : {}),
      },
    },
    enabled: true,
    tags: [DISTILL_CRON_JOB_TAG],
    metadata: {
      source: 'mimocode-distill',
      intervalDays: DISTILL.INTERVAL_DAYS,
    },
  };
}

export async function syncDistillCronJob(
  cron: DistillCronService,
  options: DistillCronBuildOptions = {},
): Promise<{ created: boolean; job: CronJobDefinition | Record<string, unknown> }> {
  const existing = cron.listJobs({ tags: [DISTILL_CRON_JOB_TAG] });
  if (existing.length > 0) {
    return { created: false, job: existing[0] };
  }
  const job = await cron.createJob(buildDistillCronJobDefinition(options));
  return { created: true, job };
}
