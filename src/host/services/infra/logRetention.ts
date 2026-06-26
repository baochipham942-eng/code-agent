// ============================================================================
// Log Retention - 启动期日志保留清理
// ----------------------------------------------------------------------------
// 把原本是死代码的 AuditLogger.cleanup 接上，并清理 agent 引擎逐次运行日志
// （每次运行落一个 .log / .last.md，原本无任何清理，无限堆积）。
// 主日志（logger.ts）已自带每日轮转 + 7 天清理，这里不重复处理。
// ============================================================================

import * as fs from 'fs';
import * as path from 'path';
import { getAuditLogger } from '../../security/auditLogger';
import { getLogsPath } from '../../platform/appPaths';
import { createLogger } from './logger';

const logger = createLogger('LogRetention');

/** 默认保留天数：与 AuditLogger.cleanup 默认一致 */
export const DEFAULT_LOG_RETENTION_DAYS = 30;

/** agent 引擎逐次运行日志的子目录（每次运行落一个 .log / .last.md） */
const ENGINE_LOG_SUBDIRS = ['claude-code', 'codex-cli'];

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 删除目录内 mtime 超过 maxAgeMs 的文件（仅当前层，不递归）。
 * best-effort：单文件失败不影响其余；目录不存在返回 0。
 *
 * @returns 删除的文件数
 */
export async function cleanupDirByMtime(dir: string, maxAgeMs: number, now: number): Promise<number> {
  let deleted = 0;
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return 0; // 目录不存在或不可读：无需清理
  }

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const filePath = path.join(dir, entry.name);
    try {
      const stat = await fs.promises.stat(filePath);
      if (now - stat.mtimeMs > maxAgeMs) {
        await fs.promises.unlink(filePath);
        deleted += 1;
      }
    } catch {
      // 跳过无法 stat/删除的文件
    }
  }

  return deleted;
}

export interface LogRetentionOptions {
  retentionDays?: number;
  /** 覆盖 agent 引擎日志根目录（测试用） */
  engineLogRoot?: string;
  /** 当前时间（测试用） */
  now?: number;
  /** 覆盖审计日志清理实现（测试用，避免触碰真实审计目录） */
  auditCleanup?: (retentionDays: number) => Promise<number>;
}

export interface LogRetentionResult {
  auditDeleted: number;
  engineDeleted: number;
}

/**
 * 启动期日志保留：清理过期审计日志 + agent 引擎运行日志。best-effort，
 * 任一环节失败都不抛出，仅记 warn。
 */
export async function runLogRetention(options: LogRetentionOptions = {}): Promise<LogRetentionResult> {
  const retentionDays = options.retentionDays ?? DEFAULT_LOG_RETENTION_DAYS;
  const now = options.now ?? Date.now();
  const maxAgeMs = retentionDays * DAY_MS;
  const auditCleanup = options.auditCleanup ?? ((days: number) => getAuditLogger().cleanup(days));

  let auditDeleted = 0;
  try {
    auditDeleted = await auditCleanup(retentionDays);
  } catch (error) {
    logger.warn('Audit log cleanup failed', error as Error);
  }

  const engineRoot = options.engineLogRoot ?? path.join(getLogsPath(), 'agent-engines');
  let engineDeleted = 0;
  for (const subdir of ENGINE_LOG_SUBDIRS) {
    try {
      engineDeleted += await cleanupDirByMtime(path.join(engineRoot, subdir), maxAgeMs, now);
    } catch (error) {
      logger.warn('Engine log cleanup failed', error as Error);
    }
  }

  if (auditDeleted > 0 || engineDeleted > 0) {
    logger.info('Log retention complete', { auditDeleted, engineDeleted, retentionDays });
  }

  return { auditDeleted, engineDeleted };
}
