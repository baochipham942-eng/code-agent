// ============================================================================
// Data Dir Permission Sweep (FB-238)
// ============================================================================
// 数据目录里躺着明文凭据（.env*、secure-storage*、.secure-key、.dev-token）和整份
// 会话库（code-agent.db*）。历史写入方大多不传 mode，新文件按 umask 落成 0644，
// 存量文件更从没人收紧过（真机上见过 7 个 0644 的 .env.bak*）。启动时做一次
// 非递归扫层把权限收拢：
//   - 顶层敏感文件 → 0600（仅当 group/other 位还有值，已收紧的跳过）
//   - backup-*/backups/bak-archive-*/logs 与数据目录本身 → 0700（仅当不是 0700）
//   - 上述目录内一层的文件 → 0600（不递归进更深的子目录）
// 幂等：先 lstat 再 chmod，第二跑零 chmod 调用；单项失败只 warn 不抛，绝不拖死启动。
// 不跟软链：目录里的 symlink 一律跳过，chmod 永远打不到链外目标。
// ============================================================================

import { chmod, lstat, readdir } from 'fs/promises';
import * as path from 'path';
import { getUserConfigDir } from './configPaths';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('DataDirPermissions');

/** 顶层敏感文件名：明文凭据、库文件及其各种备份变体 */
function isSensitiveFileName(name: string): boolean {
  return (
    name.startsWith('.env') || // .env / .env.local / .env.bak-x
    name.includes('.bak') || // *.bak / *.bak2 / config.json.bak-y
    name.startsWith('config.json') ||
    name.startsWith('secure-storage') ||
    name === '.secure-key' ||
    name === '.dev-token' ||
    name.startsWith('code-agent.db') // 含 -wal / -shm / .backup-N / .corrupt-<ts>
  );
}

/** 收紧一层的敏感目录（其内的子目录不再递归） */
function isSensitiveDirName(name: string): boolean {
  return (
    name.startsWith('backup-') ||
    name === 'backups' ||
    name.startsWith('bak-archive-') ||
    name === 'logs'
  );
}

/** 单个文件收 0600。已无 group/other 位就跳过（幂等的关键：lstat 先行）。 */
async function tightenFile(filePath: string): Promise<void> {
  try {
    const stat = await lstat(filePath);
    if (!stat.isFile()) return; // 软链/目录/其他类型一律不碰
    if ((stat.mode & 0o077) === 0) return;
    await chmod(filePath, 0o600);
  } catch (error) {
    logger.warn(`Failed to tighten data dir file permissions: ${filePath}`, error as Error);
  }
}

/** 目录收 0700。已经是 0700 就跳过。 */
async function tightenDir(dirPath: string): Promise<void> {
  try {
    const stat = await lstat(dirPath);
    if (!stat.isDirectory()) return; // 软链指向的目录不跟
    if ((stat.mode & 0o777) === 0o700) return;
    await chmod(dirPath, 0o700);
  } catch (error) {
    logger.warn(`Failed to tighten data dir directory permissions: ${dirPath}`, error as Error);
  }
}

/** 敏感目录内一层的文件收 0600；子目录与软链不碰（不递归）。 */
async function tightenFilesOneLevel(dirPath: string): Promise<void> {
  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      await tightenFile(path.join(dirPath, entry.name));
    }
  } catch (error) {
    logger.warn(`Failed to sweep data dir subdirectory: ${dirPath}`, error as Error);
  }
}

/**
 * 启动期数据目录权限扫层（非递归）。永不抛出；win32 直接返回（NTFS ACL 与
 * POSIX mode 位无关，chmod 在那里没有意义）。
 */
export async function ensureDataDirPermissions(dir: string = getUserConfigDir()): Promise<void> {
  if (process.platform === 'win32') return;
  try {
    await tightenDir(dir); // 数据目录本身 → 0700
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory() && isSensitiveDirName(entry.name)) {
        await tightenDir(entryPath);
        await tightenFilesOneLevel(entryPath);
      } else if (entry.isFile() && isSensitiveFileName(entry.name)) {
        await tightenFile(entryPath);
      }
    }
  } catch (error) {
    logger.warn(`Data dir permission sweep failed: ${dir}`, error as Error);
  }
}
