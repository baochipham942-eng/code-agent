// ============================================================================
// Atomic Write Utility - 原子写入，确保进程崩溃时文件不会损坏
// ============================================================================

import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { createLogger } from '../../services/infra/logger';

const logger = createLogger('AtomicWrite');

/**
 * 原子写入文件
 *
 * 使用 temp + rename 模式，确保：
 * 1. 写入过程中进程崩溃不会损坏原文件
 * 2. 写入要么完全成功，要么完全失败（原子性）
 *
 * @param filePath - 目标文件路径
 * @param content - 要写入的内容
 * @param encoding - 文件编码，默认 utf-8
 */
export async function atomicWriteFile(
  filePath: string,
  content: string,
  encoding: BufferEncoding = 'utf-8'
): Promise<void> {
  // 确保目录存在
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });

  // 生成唯一的临时文件名
  // 放在同一目录下，确保 rename 是原子操作（同一文件系统）
  const randomSuffix = crypto.randomBytes(8).toString('hex');
  const tempPath = path.join(dir, `.${path.basename(filePath)}.${randomSuffix}.tmp`);

  try {
    // 1. 写入临时文件
    await fs.writeFile(tempPath, content, encoding);

    // 2. 同步到磁盘（确保数据持久化）
    // 注意：Node.js 的 fs.writeFile 默认不会 fsync
    // 在关键场景下可以使用 fd.sync()，但会影响性能
    // 这里我们依赖文件系统的写入保证

    // 3. 原子重命名
    await fs.rename(tempPath, filePath);

    logger.debug(`Atomic write completed: ${filePath}`);
  } catch (error) {
    // 清理临时文件
    try {
      await fs.unlink(tempPath);
    } catch {
      // 忽略清理失败（文件可能不存在）
    }

    logger.error(`Atomic write failed: ${filePath}`, error);
    throw error;
  }
}

/**
 * 原子写入二进制文件
 *
 * @param filePath - 目标文件路径
 * @param data - 要写入的二进制数据
 */
export async function atomicWriteBuffer(
  filePath: string,
  data: Buffer
): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });

  const randomSuffix = crypto.randomBytes(8).toString('hex');
  const tempPath = path.join(dir, `.${path.basename(filePath)}.${randomSuffix}.tmp`);

  try {
    await fs.writeFile(tempPath, data);
    await fs.rename(tempPath, filePath);
    logger.debug(`Atomic buffer write completed: ${filePath}`);
  } catch (error) {
    try {
      await fs.unlink(tempPath);
    } catch {
      // 忽略
    }
    logger.error(`Atomic buffer write failed: ${filePath}`, error);
    throw error;
  }
}

/**
 * 带 fsync 的原子写入（更安全但更慢）
 *
 * 适用于关键数据，确保数据在 rename 前已持久化到磁盘
 *
 * @param filePath - 目标文件路径
 * @param content - 要写入的内容
 * @param encoding - 文件编码，默认 utf-8
 */
export async function atomicWriteFileSync(
  filePath: string,
  content: string,
  encoding: BufferEncoding = 'utf-8'
): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });

  const randomSuffix = crypto.randomBytes(8).toString('hex');
  const tempPath = path.join(dir, `.${path.basename(filePath)}.${randomSuffix}.tmp`);

  let fd: fs.FileHandle | null = null;

  try {
    // 使用 FileHandle 以便调用 sync()
    fd = await fs.open(tempPath, 'w');
    await fd.writeFile(content, { encoding });
    await fd.sync(); // 强制刷盘
    await fd.close();
    fd = null;

    await fs.rename(tempPath, filePath);
    logger.debug(`Atomic write with sync completed: ${filePath}`);
  } catch (error) {
    if (fd) {
      try {
        await fd.close();
      } catch {
        // 忽略
      }
    }
    try {
      await fs.unlink(tempPath);
    } catch {
      // 忽略
    }
    logger.error(`Atomic write with sync failed: ${filePath}`, error);
    throw error;
  }
}
