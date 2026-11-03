// ============================================================================
// 工具默认截图目录（N-RETENTION-SHOTS-APPDIR）
// ============================================================================
// 不给显式输出路径的截图不再写进用户工作目录（会攒一堆 Neo 从不清理的文件），
// 改落应用数据目录下按会话隔离的子目录。目录名常量在 shared/constants（单一真源）。

import * as path from 'path';
import { promises as fsp } from 'fs';
import { getUserConfigDir } from '../../config/configPaths';
import { createLogger } from '../../services/infra/logger';
import { TOOL_SCREENSHOTS } from '../../../shared/constants';

const logger = createLogger('ToolScreenshotDir');

/** 会话 id 只保留文件系统安全的字符；清洗后为空（含未提供）用兜底名，杜绝 `../` 逃逸。 */
function sanitizeSessionDirName(sessionId: string | undefined): string {
  if (!sessionId) return TOOL_SCREENSHOTS.NO_SESSION_DIR_NAME;
  const sanitized = sessionId.replace(/[^A-Za-z0-9_-]/g, '');
  return sanitized || TOOL_SCREENSHOTS.NO_SESSION_DIR_NAME;
}

/** 截图根目录：<getUserConfigDir()>/tool-screenshots/ */
export function getToolScreenshotsRoot(): string {
  return path.join(getUserConfigDir(), TOOL_SCREENSHOTS.DIR_NAME);
}

/** 某个会话的默认截图目录：<root>/<sanitizedSessionId>/ */
export function getToolScreenshotDir(sessionId: string | undefined): string {
  return path.join(getToolScreenshotsRoot(), sanitizeSessionDirName(sessionId));
}

/**
 * 会话删除后回收该会话的工具截图目录（N-RETENTION-APP-CACHES-REST1）。
 * - 目标 = getToolScreenshotDir(sessionId)，同一套清洗；dirName 只含 [A-Za-z0-9_-]，
 *   必然是 root 的严格子目录，根本身/`../` 逃逸都到不了。
 * - no-session 是无会话调用的共享桶：空/清洗为空的 id 一律拒绝，只有显式点名
 *   该 id 才动，避免一次会话删除误清别的调用的截图。
 * - ENOENT 由 force 吞掉；其他失败 warn 后吞掉——会话删除绝不因截图清理失败而失败。
 */
export async function removeToolScreenshotDir(sessionId: string | undefined): Promise<void> {
  if (!sessionId) return;
  const dirName = sanitizeSessionDirName(sessionId);
  if (dirName === TOOL_SCREENSHOTS.NO_SESSION_DIR_NAME && sessionId !== TOOL_SCREENSHOTS.NO_SESSION_DIR_NAME) return;
  const target = path.join(getToolScreenshotsRoot(), dirName);
  try {
    await fsp.rm(target, { recursive: true, force: true });
  } catch (error) {
    logger.warn('[工具截图] 会话截图目录清理失败（不影响会话删除）', {
      target,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}
