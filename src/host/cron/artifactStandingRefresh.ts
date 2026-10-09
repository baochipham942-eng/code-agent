// ============================================================================
// Artifact Standing Refresh - host 执行段（跑前快照 / 跑后校验·留版·回滚·标注）
// ============================================================================
// cronService 的 agent 分支只做两行接线（begin 在模型跑之前、finish 在 runFailed
// 已知之后），全部逻辑在这里。非刷新任务 begin 返回 undefined，行为零变化。
// 版本原语复用 snapshotManager：createSnapshot 兜回滚，publishVersion 出用户可见版本。
// ============================================================================

import * as fs from 'fs';
import { createHash } from 'crypto';
import type { CronJobDefinition } from '../../shared/contract/cron';
import {
  findStandingRefreshJob,
  getArtifactRefreshMetadata,
  type ArtifactRefreshMetadata,
  type StandingRefreshJobView,
} from '../../shared/artifactStandingRefresh';
import {
  createSnapshot,
  publishVersion,
  restoreSnapshot,
} from '../tools/modules/document/publishedVersions';
import { loadCronLastRunAt } from './cronPersistence';

/** 一次刷新运行的基线：回滚快照 + 跑前内容指纹 + 标注用的 metadata 底稿。 */
export interface ArtifactRefreshRunState {
  jobId: string;
  path: string;
  snapshotId: string;
  preRunSha256: string;
  metadata: Record<string, unknown>;
}

type JobUpdater = (updates: Partial<Omit<CronJobDefinition, 'id' | 'createdAt'>>) => Promise<unknown>;

async function updateRefreshJob(
  state: ArtifactRefreshRunState,
  updateJob: JobUpdater | undefined,
  updates: Partial<Omit<CronJobDefinition, 'id' | 'createdAt'>>,
): Promise<void> {
  if (updateJob) {
    await updateJob(updates);
    return;
  }
  const { getCronService } = await import('./cronService');
  await getCronService().updateJob(state.jobId, updates);
}

function sha256OfFile(filePath: string): string {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error ?? 'unknown error');
}

/**
 * 跑前：metadata.artifactRefresh 缺席 → undefined（普通任务不受影响）；
 * 目标文件已不存在（用户删/移）也返回 undefined——没有基线可快照，这不是运行失败，
 * 不该把整趟 agent 跑挂掉，日志可区分原因。
 */
export function beginArtifactRefresh(definition: CronJobDefinition): ArtifactRefreshRunState | undefined {
  const refresh = getArtifactRefreshMetadata(definition.metadata);
  if (!refresh) return undefined;
  if (!fs.existsSync(refresh.path)) {
    console.warn(`[ArtifactStandingRefresh] target file missing, refresh not started: ${refresh.path}`);
    return undefined;
  }
  const snapshot = createSnapshot(refresh.path, 'standing-refresh');
  return {
    jobId: definition.id,
    path: refresh.path,
    snapshotId: snapshot.id,
    preRunSha256: sha256OfFile(refresh.path),
    metadata: definition.metadata ?? {},
  };
}

/**
 * 校验刷新后的文件：存在、非空、类型合法（.json 可解析；.docx/.xlsx/.pptx 以 zip
 * 魔数 PK 开头）。返回 undefined 表示通过，否则返回英文失败原因。
 */
function verifyRefreshedArtifact(filePath: string): string | undefined {
  if (!fs.existsSync(filePath)) return 'refreshed file is missing';
  if (fs.statSync(filePath).size === 0) return 'refreshed file is empty';
  const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
  if (ext === '.json') {
    try {
      JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch (error) {
      return `refreshed json does not parse: ${errorText(error)}`;
    }
  }
  if (ext === '.docx' || ext === '.xlsx' || ext === '.pptx') {
    const fd = fs.openSync(filePath, 'r');
    try {
      const magic = Buffer.alloc(2);
      const bytesRead = fs.readSync(fd, magic, 0, 2, 0);
      if (bytesRead < 2 || magic[0] !== 0x50 || magic[1] !== 0x4b) {
        return 'refreshed office file does not start with the zip magic bytes';
      }
    } finally {
      fs.closeSync(fd);
    }
  }
  return undefined;
}

/** 把 lastRefreshFailed 标注写回任务 metadata（浅合并：其他 metadata 键原样保留）。 */
async function markRefresh(
  state: ArtifactRefreshRunState,
  failure: { at: number; reason: string } | undefined,
  updateJob: JobUpdater | undefined,
): Promise<void> {
  const base = getArtifactRefreshMetadata(state.metadata);
  if (!base) return;
  const next: ArtifactRefreshMetadata = {
    path: base.path,
    instruction: base.instruction,
    cadence: base.cadence,
    ...(failure ? { lastRefreshFailed: failure } : {}),
  };
  try {
    await updateRefreshJob(state, updateJob, { metadata: { ...state.metadata, artifactRefresh: next } });
  } catch (error) {
    console.error('[ArtifactStandingRefresh] failed to write the refresh marker onto the job:', error);
  }
}

/**
 * 跑后结算。成功：校验通过且内容有变 → publishVersion 留版；内容没变不留版；
 * 之前有失败标注则清掉（只在确有标注时写回，避免每趟成功都重启 cron 实例）。
 * 失败（运行失败或校验不过）：restoreSnapshot 回滚到跑前字节，再标注 lastRefreshFailed。
 */
export async function finishArtifactRefresh(
  state: ArtifactRefreshRunState,
  outcome: { runFailed: boolean; error?: unknown; updateJob?: JobUpdater },
): Promise<void> {
  const failure = outcome.runFailed
    ? `agent run failed: ${errorText(outcome.error)}`
    : verifyRefreshedArtifact(state.path);
  if (!failure) {
    if (sha256OfFile(state.path) !== state.preRunSha256) {
      publishVersion(state.path, `standing refresh ${new Date().toISOString()}`);
    }
    const base = getArtifactRefreshMetadata(state.metadata);
    if (base?.lastRefreshFailed) await markRefresh(state, undefined, outcome.updateJob);
    return;
  }
  const restored = restoreSnapshot(state.snapshotId, state.path);
  if (!restored) {
    console.error(`[ArtifactStandingRefresh] pre-run snapshot unavailable, could not restore: ${state.path}`);
  }
  await markRefresh(state, {
    at: Date.now(),
    reason: restored ? failure : `${failure}; pre-run snapshot restore also failed`,
  }, outcome.updateJob);
}

/**
 * getPublishInfo 的 standingRefresh 视图：扫 cron 任务里 metadata.artifactRefresh.path
 * 与给定文件路径一致的那条。cronService 经动态 import 取用，避免静态环。
 */
export async function resolveArtifactStandingRefresh(filePath: string): Promise<StandingRefreshJobView | undefined> {
  if (!filePath) return undefined;
  const { getCronService } = await import('./cronService');
  const found = findStandingRefreshJob(getCronService().listJobs(), filePath);
  if (!found) return undefined;
  const lastRunAt = loadCronLastRunAt(found.job.id);
  return {
    jobId: found.job.id,
    enabled: found.job.enabled,
    cadence: found.refresh.cadence,
    instruction: found.refresh.instruction,
    ...(lastRunAt !== undefined ? { lastRunAt } : {}),
    ...(found.refresh.lastRefreshFailed ? { lastRefreshFailed: found.refresh.lastRefreshFailed } : {}),
  };
}
