// ============================================================================
// Disk Space Check - Prevent writes when disk is full
// ============================================================================

import * as fs from 'fs/promises';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { createLogger } from './logger';

const execAsync = promisify(exec);
const logger = createLogger('DiskSpace');

// ============================================================================
// Constants
// ============================================================================

/** 磁盘空间阈值配置 */
export const DISK_THRESHOLDS = {
  /** 警告阈值：1GB */
  WARNING_BYTES: 1024 * 1024 * 1024,
  /** 临界阈值：100MB */
  CRITICAL_BYTES: 100 * 1024 * 1024,
} as const;

// ============================================================================
// Types
// ============================================================================

export interface DiskSpaceCheckResult {
  /** 是否有足够空间 */
  hasSpace: boolean;
  /** 可用空间（字节） */
  available: number;
  /** 总空间（字节） */
  total: number;
  /** 已用空间（字节） */
  used: number;
  /** 使用百分比 */
  usedPercent: number;
  /** 检查的路径 */
  path: string;
  /** 状态：ok / warning / critical */
  status: 'ok' | 'warning' | 'critical';
  /** 错误信息（如果检查失败） */
  error?: string;
}

// ============================================================================
// Implementation
// ============================================================================

/**
 * 检查磁盘空间
 *
 * @param targetPath 要检查的路径（默认为用户主目录）
 * @returns 磁盘空间检查结果
 *
 * @example
 * ```typescript
 * const result = await checkDiskSpace('/var/log');
 * if (!result.hasSpace) {
 *   console.warn('Low disk space:', result.available);
 * }
 * ```
 */
export async function checkDiskSpace(targetPath?: string): Promise<DiskSpaceCheckResult> {
  const checkPath = targetPath || process.env.HOME || '/';

  try {
    // 确保路径存在
    let resolvedPath = checkPath;
    try {
      await fs.access(checkPath);
    } catch {
      // 如果路径不存在，使用父目录
      resolvedPath = path.dirname(checkPath);
    }

    if (process.platform === 'darwin' || process.platform === 'linux') {
      return await checkDiskSpaceUnix(resolvedPath);
    } else if (process.platform === 'win32') {
      return await checkDiskSpaceWindows(resolvedPath);
    } else {
      // 不支持的平台，返回乐观结果
      return {
        hasSpace: true,
        available: Number.MAX_SAFE_INTEGER,
        total: Number.MAX_SAFE_INTEGER,
        used: 0,
        usedPercent: 0,
        path: resolvedPath,
        status: 'ok',
      };
    }
  } catch (error) {
    logger.error('Failed to check disk space', error as Error);
    // 检查失败时返回乐观结果，避免阻塞正常操作
    return {
      hasSpace: true,
      available: 0,
      total: 0,
      used: 0,
      usedPercent: 0,
      path: checkPath,
      status: 'ok',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Unix/macOS 磁盘空间检查
 */
async function checkDiskSpaceUnix(targetPath: string): Promise<DiskSpaceCheckResult> {
  // 使用 df 命令获取磁盘信息
  // -k: 以 KB 为单位
  // -P: POSIX 格式（确保输出格式一致）
  const { stdout } = await execAsync(`df -kP "${targetPath}"`);

  const lines = stdout.trim().split('\n');
  if (lines.length < 2) {
    throw new Error('Unexpected df output format');
  }

  // 解析第二行（第一行是表头）
  // 格式: Filesystem 1024-blocks Used Available Capacity Mounted-on
  const parts = lines[1].split(/\s+/);
  if (parts.length < 6) {
    throw new Error('Unexpected df output format');
  }

  const total = parseInt(parts[1], 10) * 1024; // KB to bytes
  const used = parseInt(parts[2], 10) * 1024;
  const available = parseInt(parts[3], 10) * 1024;
  const usedPercent = (used / total) * 100;

  let status: 'ok' | 'warning' | 'critical' = 'ok';
  if (available < DISK_THRESHOLDS.CRITICAL_BYTES) {
    status = 'critical';
  } else if (available < DISK_THRESHOLDS.WARNING_BYTES) {
    status = 'warning';
  }

  return {
    hasSpace: available >= DISK_THRESHOLDS.CRITICAL_BYTES,
    available,
    total,
    used,
    usedPercent,
    path: targetPath,
    status,
  };
}

/**
 * Windows 磁盘空间检查
 */
async function checkDiskSpaceWindows(targetPath: string): Promise<DiskSpaceCheckResult> {
  // 获取驱动器盘符
  const drive = path.parse(targetPath).root || 'C:\\';

  // 使用 wmic 命令获取磁盘信息
  const { stdout } = await execAsync(
    `wmic logicaldisk where "DeviceID='${drive.replace('\\', '')}'" get Size,FreeSpace /format:csv`
  );

  const lines = stdout.trim().split('\n').filter(line => line.trim());
  if (lines.length < 2) {
    throw new Error('Unexpected wmic output format');
  }

  // 解析 CSV 输出
  const parts = lines[1].split(',');
  if (parts.length < 3) {
    throw new Error('Unexpected wmic output format');
  }

  const available = parseInt(parts[1], 10);
  const total = parseInt(parts[2], 10);
  const used = total - available;
  const usedPercent = (used / total) * 100;

  let status: 'ok' | 'warning' | 'critical' = 'ok';
  if (available < DISK_THRESHOLDS.CRITICAL_BYTES) {
    status = 'critical';
  } else if (available < DISK_THRESHOLDS.WARNING_BYTES) {
    status = 'warning';
  }

  return {
    hasSpace: available >= DISK_THRESHOLDS.CRITICAL_BYTES,
    available,
    total,
    used,
    usedPercent,
    path: targetPath,
    status,
  };
}

/**
 * 断言磁盘有足够空间
 *
 * 如果磁盘空间不足，抛出错误
 *
 * @param targetPath 要检查的路径
 * @param requiredBytes 需要的最小空间（默认使用临界阈值）
 * @throws Error 当磁盘空间不足时
 *
 * @example
 * ```typescript
 * // 在写入文件前检查
 * await assertDiskSpaceAvailable('/var/log');
 * await fs.writeFile('/var/log/app.log', content);
 * ```
 */
export async function assertDiskSpaceAvailable(
  targetPath?: string,
  requiredBytes: number = DISK_THRESHOLDS.CRITICAL_BYTES
): Promise<void> {
  const result = await checkDiskSpace(targetPath);

  if (result.error) {
    // 检查失败时仅记录警告，不阻塞操作
    logger.warn('Disk space check failed, continuing anyway', { error: result.error });
    return;
  }

  if (result.available < requiredBytes) {
    const availableMB = Math.round(result.available / (1024 * 1024));
    const requiredMB = Math.round(requiredBytes / (1024 * 1024));
    throw new Error(
      `Insufficient disk space: ${availableMB}MB available, ${requiredMB}MB required. ` +
      `Free up disk space before continuing.`
    );
  }

  if (result.status === 'warning') {
    const availableGB = (result.available / (1024 * 1024 * 1024)).toFixed(2);
    logger.warn(`Low disk space warning: ${availableGB}GB available`);
  }
}

