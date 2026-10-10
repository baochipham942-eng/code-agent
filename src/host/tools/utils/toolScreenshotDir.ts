// ============================================================================
// 工具默认截图目录（N-RETENTION-SHOTS-APPDIR）
// ============================================================================
// 不给显式输出路径的截图不再写进用户工作目录（会攒一堆 Neo 从不清理的文件），
// 改落应用数据目录下按会话隔离的子目录。目录名常量在 shared/constants（单一真源）。

import * as path from 'path';
import { getUserConfigDir } from '../../config/configPaths';
import { TOOL_SCREENSHOTS } from '../../../shared/constants';

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
