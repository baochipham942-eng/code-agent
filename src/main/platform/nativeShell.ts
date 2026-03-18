// ============================================================================
// Platform: Native Shell - 替代 Electron shell 模块
// ============================================================================

import { exec } from 'child_process';

/**
 * 在默认浏览器中打开 URL
 */
export async function openExternal(url: string): Promise<void> {
  const cmd = process.platform === 'darwin'
    ? `open "${url}"`
    : process.platform === 'win32'
      ? `start "" "${url}"`
      : `xdg-open "${url}"`;
  exec(cmd);
}

/**
 * 打开文件或目录
 */
export async function openPath(filePath: string): Promise<string> {
  const cmd = process.platform === 'darwin'
    ? `open "${filePath}"`
    : process.platform === 'win32'
      ? `start "" "${filePath}"`
      : `xdg-open "${filePath}"`;
  exec(cmd);
  return '';
}

/**
 * 在文件管理器中显示文件
 */
export function showItemInFolder(filePath: string): void {
  const cmd = process.platform === 'darwin'
    ? `open -R "${filePath}"`
    : process.platform === 'win32'
      ? `explorer /select,"${filePath}"`
      : `xdg-open "${filePath}"`;
  exec(cmd);
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
