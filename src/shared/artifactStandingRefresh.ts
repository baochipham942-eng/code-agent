// ============================================================================
// Artifact Standing Refresh - 文件产物的常设刷新指令（纯层）
// ============================================================================
// 一份文件产物上挂一条常设指令 + 节奏，物化为一个普通 cron 任务（tag
// artifact-refresh，metadata.artifactRefresh 承载目标与指令）；到点由 agent 重写
// 同一份文件并由 host 侧留版本（N-ARTIFACT-STANDING-REFRESH）。本文件只放
// renderer/host 共用的纯逻辑：任务 payload 构建、metadata 判读、job 匹配。
// 目标键是绝对文件路径——artifactId 由内容派生、每次重写都变，不能当稳定键。
// ============================================================================

import type { AgentAction, CreateCronJobDefinition, CronScheduleConfig } from './contract/cron';

export type StandingRefreshCadence = 'hourly' | 'daily' | 'weekly';

/** 用户在产物头部设置的常设指令；path 必须是绝对路径。 */
export interface StandingRefreshRef {
  path: string;
  instruction: string;
  cadence: StandingRefreshCadence;
}

/**
 * cron job metadata.artifactRefresh 的载荷。lastRefreshFailed 是失败标注
 * （UI 侧键名 last_refresh_failed），成功后的下一趟刷新会清掉它。
 */
export interface ArtifactRefreshMetadata extends StandingRefreshRef {
  lastRefreshFailed?: { at: number; reason: string };
}

/** getPublishInfo 挂出的常设刷新视图（DeliverablePublishInfo.standingRefresh）。 */
export interface StandingRefreshJobView {
  jobId: string;
  enabled: boolean;
  cadence: string;
  /** 当前生效的指令原文（编辑弹窗回填用）。 */
  instruction: string;
  lastRunAt?: number;
  lastRefreshFailed?: { at: number; reason: string };
}

const CADENCE_PRESETS: Record<StandingRefreshCadence, {
  scheduleType: 'every' | 'cron';
  schedule: CronScheduleConfig;
}> = {
  hourly: { scheduleType: 'every', schedule: { type: 'every', interval: 1, unit: 'hours' } },
  daily: { scheduleType: 'cron', schedule: { type: 'cron', expression: '0 9 * * *' } },
  weekly: { scheduleType: 'cron', schedule: { type: 'cron', expression: '0 9 * * 1' } },
};

function fileNameOf(filePath: string): string {
  const parts = filePath.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || filePath;
}

function buildStandingRefreshPrompt(ref: StandingRefreshRef, workingDirectory: string): string {
  return [
    `You are maintaining the file artifact at "${ref.path}" (working directory: ${workingDirectory}).`,
    `1. Read the current content of that exact file.`,
    `2. Apply this standing instruction: ${ref.instruction}`,
    `3. Write the updated result back to the SAME file at "${ref.path}", overwriting it in place.`,
    `Never create a new file and never write the result to any other path; the artifact must stay at this exact path.`,
  ].join('\n');
}

/**
 * 由常设指令构建 cron create payload。同名文件已有任务时由调用方改走 updateJob
 * （一个文件只挂一条常设指令）；本函数只负责「这条指令长什么样」。
 */
export function buildStandingRefreshJobInput(
  ref: StandingRefreshRef,
  workingDirectory: string,
): CreateCronJobDefinition {
  const preset = CADENCE_PRESETS[ref.cadence];
  return {
    name: `Refresh ${fileNameOf(ref.path)}`,
    scheduleType: preset.scheduleType,
    schedule: preset.schedule,
    action: {
      type: 'agent',
      agentType: 'default',
      prompt: buildStandingRefreshPrompt(ref, workingDirectory),
    } satisfies AgentAction,
    runsOn: 'local',
    enabled: true,
    tags: ['artifact-refresh'],
    metadata: {
      artifactRefresh: {
        path: ref.path,
        instruction: ref.instruction,
        cadence: ref.cadence,
      },
    },
  };
}

/** 判读 job metadata 里的 artifactRefresh；形状不对（含手建任务的自定义 metadata）一律 undefined。 */
export function getArtifactRefreshMetadata(
  metadata: Record<string, unknown> | undefined,
): ArtifactRefreshMetadata | undefined {
  const raw = metadata?.artifactRefresh;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const candidate = raw as Record<string, unknown>;
  if (typeof candidate.path !== 'string' || !candidate.path.trim()) return undefined;
  if (typeof candidate.instruction !== 'string') return undefined;
  if (candidate.cadence !== 'hourly' && candidate.cadence !== 'daily' && candidate.cadence !== 'weekly') {
    return undefined;
  }
  const failure = candidate.lastRefreshFailed;
  const lastRefreshFailed = failure && typeof failure === 'object' && !Array.isArray(failure)
    && typeof (failure as Record<string, unknown>).at === 'number'
    && typeof (failure as Record<string, unknown>).reason === 'string'
    ? {
      at: (failure as Record<string, unknown>).at as number,
      reason: (failure as Record<string, unknown>).reason as string,
    }
    : undefined;
  return {
    path: candidate.path,
    instruction: candidate.instruction,
    cadence: candidate.cadence,
    ...(lastRefreshFailed ? { lastRefreshFailed } : {}),
  };
}

/** 路径比对键：只归一收尾分隔符，够覆盖本仓自建任务的写入/读取路径。 */
function artifactPathKey(filePath: string): string {
  const trimmed = filePath.replace(/[\\/]+$/, '');
  return trimmed === '' ? filePath : trimmed;
}

export interface StandingRefreshJobLike {
  id: string;
  enabled: boolean;
  updatedAt: number;
  metadata?: Record<string, unknown>;
}

/** 在 job 列表里找同一文件路径的常设刷新任务；多条时取 updatedAt 最新的那条。 */
export function findStandingRefreshJob<T extends StandingRefreshJobLike>(
  jobs: readonly T[],
  filePath: string,
): { job: T; refresh: ArtifactRefreshMetadata } | undefined {
  const key = artifactPathKey(filePath);
  const matches: Array<{ job: T; refresh: ArtifactRefreshMetadata }> = [];
  for (const job of jobs) {
    const refresh = getArtifactRefreshMetadata(job.metadata);
    if (refresh && artifactPathKey(refresh.path) === key) matches.push({ job, refresh });
  }
  return matches.sort((left, right) => right.job.updatedAt - left.job.updatedAt)[0];
}
