// ============================================================================
// 工具默认截图目录（N-RETENTION-SHOTS-APPDIR）
// ============================================================================
// 不给显式输出路径的截图不再写进用户工作目录（会攒一堆 Neo 从不清理的文件），
// 改落应用数据目录下按会话隔离的子目录。目录名常量在 shared/constants（单一真源）。

import * as path from 'path';
import { promises as fsp } from 'fs';
import { getUserConfigDir } from '../../config/configPaths';
import { createLogger } from '../../services/infra/logger';
import { collectReferenceText } from '../../services/infra/retentionReferenceScan';
import { TOOL_SCREENSHOTS } from '../../../shared/constants';

const logger = createLogger('ToolScreenshotDir');

/**
 * 工具截图的候选/产物扩展名（三个写入方的形状：screenshot、screenshot_page 的
 * *.png / *.jpg，visualReview 逐页 *.jpg）。sweep（appCacheRetention）与
 * 会话删除回收（removeToolScreenshotDir）共用这一份单一真源。
 */
export const TOOL_SCREENSHOT_EXTENSIONS: readonly string[] = ['.png', '.jpg'];

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
 * 会话删除后回收该会话的工具截图（N-RETENTION-APP-CACHES-REST1，rework r1 引用收口）。
 * - 目标 = getToolScreenshotDir(sessionId)，同一套清洗；dirName 只含 [A-Za-z0-9_-]，
 *   必然是 root 的严格子目录，根本身/`../` 逃逸都到不了。
 * - no-session 是无会话调用的共享桶：空/清洗为空的 id 一律拒绝，只有显式点名
 *   该 id 才动，避免一次会话删除误清别的调用的截图。
 * - 与定期清理同一条规矩「只删无引用文件」：删前扫全库引用并剔除死者自己的行
 *   （db.deleteSession 只写 tombstone，消息/工具执行行仍在库）。分叉子会话把父会话
 *   消息整行复制到自己名下（含截图绝对路径），父删后仍存活——被它们引用的文件保留，
 *   交给定期清理在引用消失后按同一判定回收；扫描失败同样整体保守保留。
 * - 全程绝不抛错：ENOENT 静默；其他失败 warn 后吞掉——会话删除绝不因截图清理失败而失败。
 */
export async function removeToolScreenshotDir(sessionId: string | undefined): Promise<void> {
  if (!sessionId) return;
  const dirName = sanitizeSessionDirName(sessionId);
  if (dirName === TOOL_SCREENSHOTS.NO_SESSION_DIR_NAME && sessionId !== TOOL_SCREENSHOTS.NO_SESSION_DIR_NAME) return;
  const root = getToolScreenshotsRoot();
  const target = path.join(root, dirName);
  if (!(await pathExists(target))) return;
  let referenceText: string;
  try {
    referenceText = await collectReferenceText(
      path.join(getUserConfigDir(), 'code-agent.db'),
      TOOL_SCREENSHOT_EXTENSIONS,
      { excludeSessionId: sessionId },
    );
  } catch (error) {
    logger.warn('[工具截图] 引用扫描失败，会话截图目录保守保留（不影响会话删除）', {
      target,
      reason: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  try {
    await deleteUnreferencedFiles(target, referenceText);
  } catch (error) {
    logger.warn('[工具截图] 会话截图目录清理失败（不影响会话删除）', {
      target,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fsp.stat(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * 递归删掉目录下未被引用的候选图片（symlink/目录跳过，非图片扩展名不动），
 * 然后自底向上回收空目录；仍被引用的文件留下（目录因而不空也留下）。
 */
async function deleteUnreferencedFiles(dir: string, referenceText: string): Promise<void> {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const child = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await deleteUnreferencedFiles(child, referenceText);
      continue;
    }
    if (!entry.isFile()) continue; // symlink 等非常规文件不动
    if (TOOL_SCREENSHOT_EXTENSIONS.some((ext) => entry.name.endsWith(ext)) && !referenceText.includes(entry.name)) {
      await fsp.rm(child, { force: true });
    }
  }
  try {
    await fsp.rmdir(dir);
  } catch (error) {
    // ENOTEMPTY（还有被引用/非候选文件）、ENOENT（并发已被清）都不算事
    if (!isNodeError(error, 'ENOTEMPTY') && !isNodeError(error, 'ENOENT')) throw error;
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error as { code?: unknown }).code === code;
}
