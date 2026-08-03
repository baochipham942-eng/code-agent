// 设计目录路径守卫——从 workspace.ipc.ts 拆出（控制 godfile 行数 + 跨模块复用）。
import path from 'path';
import { getUserConfigDir } from '../config/configPaths';
import { canonicalizeWorkspacePath, isPathWithinRoot } from '../runtime/workspaceScope';

/**
 * 设计图 handler 路径越界守卫（audit M1）：renderer 传入的 baseImagePath/outputPath
 * 必须落在设计目录 <getUserConfigDir>/design 内。挡住读任意本地文件（base64 后外泄到
 * DashScope）/写覆盖任意文件。
 */
export function assertWithinDesignDir(p: string, label: string): void {
  const root = path.resolve(getUserConfigDir(), 'design');
  const resolved = path.resolve(p);
  if (!isPathWithinRoot(resolved, root)) {
    throw new Error(`${label} 路径越界：必须位于设计目录内`);
  }
}

/**
 * 按路径导入的源文件只允许来自当前 host 活跃工作目录或设计目录。返回解析过
 * symlink 的规范路径，调用方必须用返回值读取，避免校验路径与实际读取路径分叉。
 */
export function assertWithinDesignImportSource(
  p: string,
  activeWorkspaceRoot?: string | null,
): string {
  if (!path.isAbsolute(p)) {
    throw new Error('sourcePath 必须是绝对路径，且位于当前工作目录或设计目录内');
  }

  let canonicalSource: string;
  try {
    canonicalSource = canonicalizeWorkspacePath(p);
  } catch {
    throw new Error(`sourcePath 路径无效或不可解析：${p}`);
  }

  const designRoot = path.resolve(getUserConfigDir(), 'design');
  const allowedRoots = [
    activeWorkspaceRoot?.trim() && path.isAbsolute(activeWorkspaceRoot)
      ? activeWorkspaceRoot
      : undefined,
    designRoot,
  ].filter((root): root is string => Boolean(root));

  if (!allowedRoots.some((root) => isPathWithinRoot(canonicalSource, root))) {
    throw new Error('sourcePath 路径越界：必须位于当前工作目录或设计目录内');
  }
  return canonicalSource;
}
