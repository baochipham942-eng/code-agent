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

import type { CronJobAction, CronJobDefinition } from './contract/cron';
import { getArtifactRefreshMetadata } from './artifactStandingRefresh';

// 本模块同时进 renderer bundle（任务详情写授权面板），node:path 会被打成裸 'path'
// 说明符，真浏览器加载 chunk 即 TypeError（node/jsdom 运行时测不出；Rework r1 真跑
// 实证 automation center 整块 ErrorBoundary）。照 cronArtifactPath 的先例用可移植
// 判定：POSIX 绝对路径、UNC 与 Windows 盘符绝对路径都认，dirname 对齐 node 语义
// （盘符根 'C:\x' → 'C:\'；根路径原样返回触发调用方的 fallback 护栏）。
const IS_ABSOLUTE_PATH_RE = /^(?:\/|\\\\|[A-Za-z]:[\\/])/;

function isAbsolutePath(value: string): boolean {
  return IS_ABSOLUTE_PATH_RE.test(value);
}

function parentDirectoryOf(value: string): string {
  const trimmed = value.replace(/[/\\]+$/, '');
  const slash = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  if (slash < 0) return value;
  const head = trimmed.slice(0, Math.max(slash, 1));
  if (/^[A-Za-z]:$/.test(head)) return head + (trimmed[slash] || '\\');
  return head || value;
}

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
  if (!refresh || !isAbsolutePath(refresh.path)) return sourceSessionWorkingDirectory;
  const parent = parentDirectoryOf(refresh.path);
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
  return typeof candidate === 'string' && isAbsolutePath(candidate) ? candidate : undefined;
}
