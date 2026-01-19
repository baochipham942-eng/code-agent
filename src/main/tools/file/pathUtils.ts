// ============================================================================
// Path Utilities - 路径处理工具函数
// ============================================================================

import path from 'path';
import os from 'os';

/**
 * 展开波浪号路径 (~/xxx -> /Users/xxx/xxx)
 * Node.js 原生不支持 ~ 路径展开，需要手动处理
 */
export function expandTilde(filePath: string): string {
  if (!filePath) return filePath;

  if (filePath.startsWith('~/')) {
    return path.join(os.homedir(), filePath.slice(2));
  }

  if (filePath === '~') {
    return os.homedir();
  }

  return filePath;
}

/**
 * 解析路径为绝对路径
 * 1. 展开波浪号
 * 2. 将相对路径转换为绝对路径
 *
 * @param inputPath 输入路径
 * @param workingDirectory 当前工作目录（用于解析相对路径）
 */
export function resolvePath(inputPath: string, workingDirectory: string): string {
  // 先展开波浪号
  let resolvedPath = expandTilde(inputPath);

  // 如果不是绝对路径，则相对于工作目录解析
  if (!path.isAbsolute(resolvedPath)) {
    resolvedPath = path.join(workingDirectory, resolvedPath);
  }

  return resolvedPath;
}
