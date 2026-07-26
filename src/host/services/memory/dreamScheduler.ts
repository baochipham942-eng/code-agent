// ============================================================================
// DreamScheduler — dream 记忆整理的 cron 注册
//
// ⚠️ 有意未接线（2026-07-25 产品判断，不是遗漏）。
//
// 当前没有任何启动注册点，所以发行版里这个 job 不会被创建。原先唯一的“注册点”
// 位于已删除的 app/initBackgroundServices.ts 死入口；删除死入口后仍刻意不把 cron
// 迁入 src/web/webStartupServices.ts。同批的 dbRetention / logRetention /
// Light Memory consolidation 都已接到 src/web/，唯独 dream 与 distill 刻意留着不接：
//
//   它们会无人值守地自动发起 LLM 调用产生真实费用，属产品 + 成本判断而非接线判断。
//   而"记忆整理"的核心诉求已由 Light Memory consolidation 覆盖（webStartupMemoryJobs.ts，
//   带健康门：记忆规模小就跳过、不烧 token），dream 的增量价值尚未验证。
//
// 要接线请先拿到成本口径的明确许可，别当成"补一处遗漏"顺手接上。
// ============================================================================
import type { CronJobDefinition } from '../../../shared/contract/cron';

export const DREAM_INTERVAL_DAYS = 7;
export const DREAM_CRON_JOB_TAG = 'dream-memory-consolidation';
export const DREAM_AUTO_PROMPT = '/dream --auto';

type DreamCronDefinition = Omit<CronJobDefinition, 'id' | 'createdAt' | 'updatedAt'>;

export interface DreamCronBuildOptions {
  now?: number;
  workingDirectory?: string;
}

export interface DreamCronService {
  listJobs(filter?: { tags?: string[] }): Array<CronJobDefinition | Record<string, unknown>>;
  createJob(definition: DreamCronDefinition): Promise<CronJobDefinition | Record<string, unknown>>;
}

export function buildDreamCronJobDefinition(options: DreamCronBuildOptions = {}): DreamCronDefinition {
  const now = options.now ?? Date.now();
  return {
    name: '[Maintenance] Dream memory consolidation',
    description: 'Review recent sessions and write History-verified durable memory.',
    scheduleType: 'every',
    schedule: {
      type: 'every',
      interval: DREAM_INTERVAL_DAYS,
      unit: 'days',
      startAt: now,
    },
    action: {
      type: 'agent',
      agentType: 'dream',
      prompt: DREAM_AUTO_PROMPT,
      context: {
        dreamAuto: true,
        ...(options.workingDirectory ? { workingDirectory: options.workingDirectory } : {}),
      },
    },
    enabled: true,
    tags: [DREAM_CRON_JOB_TAG],
    metadata: {
      source: 'mimocode-dream',
      intervalDays: DREAM_INTERVAL_DAYS,
    },
  };
}

export async function syncDreamCronJob(
  cron: DreamCronService,
  options: DreamCronBuildOptions = {},
): Promise<{ created: boolean; job: CronJobDefinition | Record<string, unknown> }> {
  const existing = cron.listJobs({ tags: [DREAM_CRON_JOB_TAG] });
  if (existing.length > 0) {
    return { created: false, job: existing[0] };
  }
  const job = await cron.createJob(buildDreamCronJobDefinition(options));
  return { created: true, job };
}
