// ============================================================================
// commandFileOwnership — prompt command 副本的归属校验与归属内删除
// （N-SKILL-SCAN-VERSION-RESCAN，ai-review R4/R5 Important 2）
// commands 目录是多插件共享目录，自动禁用按命令名删文件前，先确认副本内容仍与
// 插件源文件一致；用户改写过的同名文件不归插件所有，不删并 warn 留痕。
// TOCTOU 收口（R5）：「读副本 → 校验 → 删除」之间用户可改写同一路径，这里照
// installService 的 rename-backup 仓内形态——先 rename 到隔离名（同目录原子
// 操作），对隔离文件二次校验，一致才 unlink；窗口内被改写则校验不过、rename
// 回原路径，用户的文件不丢。残留窗口收敛到 rename 单个 syscall。
// ============================================================================

import { readFile, rename, rm } from 'fs/promises';
import { randomUUID } from 'crypto';
import { createLogger } from '../../services/infra/logger';
import { resolveInside } from './pathUtils';

const logger = createLogger('PluginCommandOwnership');

export interface CommandOwnershipSource {
  sourceRootDir: string;
  /** 与 commandNames 按下标一一对应的插件内相对路径 */
  commandPaths: string[];
}

type CommandOwnershipRemoval = 'removed' | 'not-owned' | 'gone';

function warnNotOwned(destination: string, commandName: string): 'not-owned' {
  logger.warn('Skipped removing command file not owned by plugin', {
    command: commandName,
    file: destination,
  });
  return 'not-owned';
}

/**
 * 校验副本归属并删除：内容仍与插件源文件一致才删（先 rename 隔离再二次校验）。
 * 'removed' = 已删除；'not-owned' = 归属不明/窗口内被改写，未删（已 warn）；
 * 'gone' = 副本本来就不在，无需处理。
 */
export async function removeCommandFileIfOwnedByPlugin(
  destination: string,
  source: CommandOwnershipSource,
  index: number,
  commandName: string,
): Promise<CommandOwnershipRemoval> {
  const relativeSourcePath = source.commandPaths[index];
  if (!relativeSourcePath) return warnNotOwned(destination, commandName);

  let sourceContent: string;
  try {
    sourceContent = await readFile(resolveInside(source.sourceRootDir, relativeSourcePath), 'utf8');
  } catch {
    return warnNotOwned(destination, commandName); // 源读不出 = 无法证明归属
  }

  let destContent: string;
  try {
    destContent = await readFile(destination, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'gone';
    return warnNotOwned(destination, commandName);
  }
  if (destContent !== sourceContent) return warnNotOwned(destination, commandName);

  const quarantine = `${destination}.neo-owncheck-${randomUUID()}`;
  try {
    await rename(destination, quarantine);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'gone';
    throw error;
  }
  let verified: boolean;
  try {
    verified = await readFile(quarantine, 'utf8') === sourceContent;
  } catch {
    verified = false;
  }
  if (verified) {
    try {
      await rm(quarantine, { force: true });
      return 'removed';
    } catch (error) {
      // rm 失败不能把文件留在隔离名（ai-review R7）：rename 回原路径；
      // 恢复本身也失败则 error 留痕，原始错误照旧上抛（调用方 fail-loud）
      try {
        await rename(quarantine, destination);
      } catch (restoreError) {
        logger.error('Failed to restore quarantined command file after delete failure', {
          command: commandName,
          file: destination,
          error: restoreError instanceof Error ? restoreError.message : String(restoreError),
        });
      }
      throw error;
    }
  }
  // 窗口内被改写：rename 回原路径，用户的文件不丢
  await rename(quarantine, destination).catch(() => {});
  return warnNotOwned(destination, commandName);
}
