// ============================================================================
// commandFileOwnership — prompt command 副本的归属校验（ai-review R4 Important 2）
// commands 目录是多插件共享目录，自动禁用/卸载按命令名删文件前，先确认副本内容
// 仍与插件源文件一致；用户改写过的同名文件不归插件所有，不删并 warn 留痕。
// ============================================================================

import fs from 'fs/promises';
import { createLogger } from '../../services/infra/logger';
import { resolveInside } from './pathUtils';

const logger = createLogger('PluginCommandOwnership');

export interface CommandOwnershipSource {
  sourceRootDir: string;
  /** 与 commandNames 按下标一一对应的插件内相对路径 */
  commandPaths: string[];
}

/** 副本内容仍与插件源文件逐字节一致才算归该插件所有；读不出/不一致/缺源路径都不算。 */
export async function commandFileOwnedByPlugin(
  destination: string,
  source: CommandOwnershipSource,
  index: number,
  commandName: string,
): Promise<boolean> {
  const relativeSourcePath = source.commandPaths[index];
  if (relativeSourcePath) {
    try {
      const [destContent, sourceContent] = await Promise.all([
        fs.readFile(destination, 'utf8'),
        fs.readFile(resolveInside(source.sourceRootDir, relativeSourcePath), 'utf8'),
      ]);
      if (destContent === sourceContent) return true;
    } catch {
      // 读不出 = 无法证明归属，按不归插件所有处理
    }
  }
  logger.warn('Skipped removing command file not owned by plugin', {
    command: commandName,
    file: destination,
  });
  return false;
}
