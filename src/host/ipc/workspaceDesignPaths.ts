// 设计目录路径守卫——从 workspace.ipc.ts 拆出（控制 godfile 行数 + 跨模块复用）。
import path from 'path';
import { getUserConfigDir } from '../config/configPaths';
import { isPathWithinRoot } from '../runtime/workspaceScope';

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
