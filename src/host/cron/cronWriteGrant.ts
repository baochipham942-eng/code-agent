// ============================================================================
// Cron Write Grant — 定时任务「预授权写入文件夹」host 侧（N-RESIDENT-SCHEDULE-KEEPALIVE-DAEMON-FU1）
// ============================================================================
// 用户在任务详情面板一键授权（专用 IPC，updateJob/createJob 都写不进这个字段），
// 授权文件夹 = 运行会话的工作目录同源判定（shared/cronWriteScope.cronWriteScopeFolder，
// 常设刷新取产物所在目录，其余取来源会话工作目录）。运行时无人值守（壳已退出，
// ADR-083 background）的 cron/heartbeat 会话写这个文件夹内的 file_write/file_edit
// 自动放行；出界、forceConfirm、Bash、其余工具一律照旧停车等人。
//
// 授权语义对照 loginPassThroughOrigin 先例：显式同意才落库、普通编辑不可夹带、
// 会话 origin.metadata 随 run 带走、消费侧只认 host 侧解析结果。
// ============================================================================

import * as fs from 'fs';
import path from 'path';
import type { PermissionAskResult } from '../../shared/contract';
import type { CronJobDefinition } from '../../shared/contract/cron';
import {
  CRON_WRITE_GRANT_METADATA_KEY,
  CRON_WRITE_SCOPE_NO_FOLDER,
  cronSourceSessionIdFromDefinition,
  cronWriteScopeFolder,
  writeGrantRootFromMetadata,
} from '../../shared/cronWriteScope';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('CronWriteGrant');

/** CronService 暴露给本模块的最小宿主面（同 rememberCronLoginPassThroughOrigin 的注入形态）。 */
export interface CronWriteGrantHost {
  /** 内存 job 表取活跃条目（definition 可变引用，授权写回后内存立即生效）。 */
  loadActiveJob: (jobId: string) => { definition: CronJobDefinition } | undefined;
  /** 即 CronService.persistJob：落库。 */
  persistJob: (definition: CronJobDefinition) => Promise<void>;
}

function realpathOrNull(value: string): string | undefined {
  try {
    return fs.realpathSync(value);
  } catch {
    return undefined;
  }
}

/**
 * 目标文件可能还不存在（新写入）：沿目录链向上找第一个存在的祖先做 realpath，
 * 再把缺失尾段接回去。全链都不存在（连根都解析不出）返回 undefined。
 */
function realpathWithMissingTail(resolved: string): string | undefined {
  let current = resolved;
  const tail: string[] = [];
  for (;;) {
    const real = realpathOrNull(current);
    if (real) return tail.length === 0 ? real : path.join(real, ...[...tail].reverse());
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    tail.push(path.basename(current));
    current = parent;
  }
}

/**
 * 判定目标是否落在授权文件夹内。两边都做 realpath 归一：
 * `..` 由 path.resolve 归一，symlink 逃逸由 realpath 归一（授权目录内的软链指向
 * 外部 → 解析后落在界外 → 不放行）。相对路径 / 授权根不存在一律 fail-closed 拒。
 * 模块私有：外部统一走 approveByScheduleWriteGrant（生产消费方只有它）。
 */
function isPathWithinWriteGrantRoot(target: string, grantRoot: string): boolean {
  if (!path.isAbsolute(target)) return false;
  const realRoot = realpathOrNull(grantRoot);
  if (!realRoot) return false;
  const realTarget = realpathWithMissingTail(path.resolve(target));
  if (!realTarget) return false;
  return realTarget === realRoot || realTarget.startsWith(realRoot + path.sep);
}

/** 来源会话的工作目录（授权解析只用来源会话，不取「当前焦点会话」兜底——授权范围必须稳定可预期）。 */
async function sourceSessionWorkingDirectory(definition: CronJobDefinition): Promise<string | undefined> {
  const sourceSessionId = cronSourceSessionIdFromDefinition(definition);
  if (!sourceSessionId) return undefined;
  try {
    const { getSessionManager } = await import('../services/infra/sessionManager');
    const session = await getSessionManager().getSession(sourceSessionId).catch(() => null);
    return session?.workingDirectory;
  } catch (error) {
    logger.warn('Failed to read the cron source session, resolving without its working directory', { error });
    return undefined;
  }
}

/**
 * 授权：解析候选文件夹并写入 metadata.writeGrantRoot。解析不出文件夹抛
 * CRON_WRITE_SCOPE_NO_FOLDER（面板据此切「先在对话里选工作文件夹」提示态）。
 * 已授权时幂等返回当前定义，不重复解析。
 */
export async function grantCronWriteScope(
  jobId: string,
  host: CronWriteGrantHost,
  updatedAt?: number,
): Promise<CronJobDefinition | null> {
  const active = host.loadActiveJob(jobId);
  if (!active) return null;
  if (writeGrantRootFromMetadata(active.definition.metadata)) return active.definition;
  const folder = cronWriteScopeFolder(active.definition, await sourceSessionWorkingDirectory(active.definition));
  const resolved = folder && path.isAbsolute(folder) ? folder : undefined;
  if (!resolved) throw new Error(CRON_WRITE_SCOPE_NO_FOLDER);
  const updated: CronJobDefinition = {
    ...active.definition,
    metadata: { ...(active.definition.metadata ?? {}), [CRON_WRITE_GRANT_METADATA_KEY]: resolved },
    updatedAt: updatedAt ?? Date.now(),
  };
  await host.persistJob(updated);
  active.definition = updated;
  logger.info('Write scope granted', { jobId, root: resolved });
  return updated;
}

/** 撤销：摘掉 metadata.writeGrantRoot。未授权时幂等返回当前定义。 */
export async function revokeCronWriteScope(
  jobId: string,
  host: CronWriteGrantHost,
  updatedAt?: number,
): Promise<CronJobDefinition | null> {
  const active = host.loadActiveJob(jobId);
  if (!active) return null;
  if (!writeGrantRootFromMetadata(active.definition.metadata)) return active.definition;
  const metadata = { ...(active.definition.metadata ?? {}) };
  delete metadata[CRON_WRITE_GRANT_METADATA_KEY];
  const updated: CronJobDefinition = {
    ...active.definition,
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    updatedAt: updatedAt ?? Date.now(),
  };
  await host.persistJob(updated);
  active.definition = updated;
  logger.info('Write scope revoked', { jobId });
  return updated;
}

/** createJob 元数据防线：外部载荷不许夹带授权字段（no-self-grant，updateJob 同理走 sanitize）。 */
export function stripWriteGrantRoot(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!metadata || !Object.prototype.hasOwnProperty.call(metadata, CRON_WRITE_GRANT_METADATA_KEY)) return metadata;
  const rest = { ...metadata };
  delete rest[CRON_WRITE_GRANT_METADATA_KEY];
  return Object.keys(rest).length > 0 ? rest : undefined;
}

/**
 * 无人值守审批的写授权放行判定（orchestratorPermissions 在停车分支之前调用）。
 * 返回 undefined = 不适用（非 cron/heartbeat 来源、非 file_write/file_edit、
 * forceConfirm、无授权、目标出界），调用方照旧走停车/询问。
 */
export async function approveByScheduleWriteGrant(request: {
  sessionId?: string;
  type: string;
  tool?: string;
  forceConfirm?: boolean;
  /** 宽收窄用：只消费 path/file_path；其余键（command/url 等）在场即说明不是文件写目标。 */
  details?: { path?: string; filePath?: string; [key: string]: unknown };
}): Promise<PermissionAskResult | undefined> {
  if (request.forceConfirm === true) return undefined;
  if (request.type !== 'file_write' && request.type !== 'file_edit') return undefined;
  const grantRoot = await scheduleWriteGrantRootForSession(request.sessionId);
  if (!grantRoot) return undefined;
  const target = request.details?.path ?? request.details?.filePath;
  if (!target || !isPathWithinWriteGrantRoot(target, grantRoot)) return undefined;
  return { approved: true, approvalSource: 'schedule-write-grant' };
}

/** 会话来源带授权才放行：origin.kind 只认 cron/heartbeat，字段只认绝对路径字符串。 */
async function scheduleWriteGrantRootForSession(sessionId: string | undefined): Promise<string | undefined> {
  if (!sessionId) return undefined;
  try {
    const { getSessionManager } = await import('../services/infra/sessionManager');
    const session = await getSessionManager().getSession(sessionId).catch(() => null);
    const origin = session?.origin;
    if (origin?.kind !== 'cron' && origin?.kind !== 'heartbeat') return undefined;
    return writeGrantRootFromMetadata(origin.metadata);
  } catch (error) {
    logger.warn('Failed to read the session origin, treating the write scope as ungranted', { error });
    return undefined;
  }
}
