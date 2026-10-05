// ============================================================================
// Platform: Native Shell - 替代 Electron shell 模块
// ============================================================================

import * as path from 'node:path';
import {
  safeExecDetached,
  assertSafeUrl,
  assertExistingAbsolutePath,
} from '../utils/safeShell';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('NativeShell');

/**
 * 在默认浏览器中打开 URL（仅允许 http/https/mailto scheme）
 */
export async function openExternal(url: string): Promise<void> {
  const parsedUrl = assertSafeUrl(url);
  if (process.env.NEO_VERIFY_NO_FOREGROUND === '1') {
    logger.info(`[openExternal] verification mode: suppressed external link (${parsedUrl.origin})`);
    return;
  }
  if (process.platform === 'darwin') {
    safeExecDetached('open', [url]);
  } else if (process.platform === 'win32') {
    safeExecDetached('rundll32', ['url.dll,FileProtocolHandler', url]);
  } else {
    safeExecDetached('xdg-open', [url]);
  }
}

/**
 * 打开文件或目录（必须为存在的绝对路径）
 */
export async function openPath(filePath: string): Promise<string> {
  assertExistingAbsolutePath(filePath);
  if (process.platform === 'darwin') {
    safeExecDetached('open', [filePath]);
  } else if (process.platform === 'win32') {
    safeExecDetached('explorer.exe', [filePath]);
  } else {
    safeExecDetached('xdg-open', [filePath]);
  }
  return '';
}

/**
 * 在文件管理器中显示文件（必须为存在的绝对路径）
 */
export function showItemInFolder(filePath: string): void {
  assertExistingAbsolutePath(filePath);
  if (process.platform === 'darwin') {
    safeExecDetached('open', ['-R', filePath]);
  } else if (process.platform === 'win32') {
    safeExecDetached('explorer.exe', [`/select,${filePath}`]);
  } else {
    safeExecDetached('xdg-open', [path.dirname(filePath)]);
  }
}

/**
 * shell 兼容对象 — 与 Electron shell API 接口一致
 */
export const shell = {
  openExternal,
  openPath,
  showItemInFolder,
  beep: () => {},
  moveItemToTrash: (..._args: unknown[]) => false,
  readShortcutLink: (..._args: unknown[]) => ({}),
  writeShortcutLink: (..._args: unknown[]) => false,
};
