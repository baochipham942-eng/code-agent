// ============================================================================
// Cron Write Scope — 定时任务「预授权写入文件夹」的共享解析（N-RESIDENT-SCHEDULE-KEEPALIVE-DAEMON-FU1）
// ============================================================================
// 用户在任务详情面板一键授权后，任务在无人值守（壳已退出）运行时允许写这个文件夹
// 里的文件（file_write / file_edit 自动放行；出界照旧停车等人）。
//
// 「授权哪个文件夹」必须与运行会话的工作目录同源：常设刷新任务取产物所在目录，
// 其余取来源会话的工作目录（ADR-083 留守场景下用户不在场，授权范围必须可预期）。
// host（授权落库、会话创建）与 renderer（面板展示候选文件夹）共用本模块，
// 不许各自再抄一份判定，防止两侧展示与实际授权漂移。
// ============================================================================

import { dirname, isAbsolute } from 'path';
import type { CronJobAction, CronJobDefinition } from './contract/cron';
import { getArtifactRefreshMetadata } from './artifactStandingRefresh';

/** 授权目标文件夹在任务 metadata 上的键；只有专用授权 IPC 能写（updateJob 会剥掉）。 */
export const CRON_WRITE_GRANT_METADATA_KEY = 'writeGrantRoot';

/** 授权失败（解析不出工作文件夹）的稳定错误码；面板据此切「先去对话里选工作文件夹」态。 */
export const CRON_WRITE_SCOPE_NO_FOLDER = 'CRON_WRITE_SCOPE_NO_FOLDER';

/**
 * 授权候选文件夹：与运行会话的工作目录同一判定（artifactStandingRefresh.
 * cronAgentWorkingDirectory 委托到这里）。产物路径是绝对路径时用其所在目录，
 * 否则沿用 fallback（来源会话的工作目录，两者都没有时为 undefined）。
 */
export function cronWriteScopeFolder(
  definition: Pick<CronJobDefinition, 'metadata'>,
  sourceSessionWorkingDirectory: string | undefined,
): string | undefined {
  const refresh = getArtifactRefreshMetadata(definition.metadata);
  if (!refresh || !isAbsolute(refresh.path)) return sourceSessionWorkingDirectory;
  const parent = dirname(refresh.path);
  if (!parent || parent === refresh.path) return sourceSessionWorkingDirectory;
  return parent;
}

/**
 * 任务来源会话 id：metadata.sourceSessionId 优先，否则 agent 动作的 context。
 * 与 host 侧 cronAutomationBridge.readCronSourceSessionId 同一判定（该函数委托到这里）。
 */
export function cronSourceSessionIdFromDefinition(
  definition: Pick<CronJobDefinition, 'metadata' | 'action'>,
  action: CronJobAction = definition.action,
): string | undefined {
  const metadataSource = definition.metadata?.sourceSessionId;
  if (typeof metadataSource === 'string' && metadataSource.trim()) return metadataSource;
  if (action.type === 'agent') {
    const contextSource = action.context?.sourceSessionId;
    if (typeof contextSource === 'string' && contextSource.trim()) return contextSource;
  }
  return undefined;
}

/** 读出已授权的文件夹（绝对路径字符串才算数，其余形态一律视为未授权）。 */
export function writeGrantRootFromMetadata(
  metadata: Record<string, unknown> | undefined,
): string | undefined {
  const candidate = metadata?.[CRON_WRITE_GRANT_METADATA_KEY];
  return typeof candidate === 'string' && isAbsolute(candidate) ? candidate : undefined;
}
