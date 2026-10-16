// ============================================================================
// 懒开目录的撞名占用集（N-DELIVERABLE-WORKDIR-LAZY rework r2）
// ============================================================================
// 懒开后无文件夹会话的产出目录首轮只规划不落盘，路径先记进会话行；纯问答会话的
// 目录永不出现。撞名判定因此不能只看磁盘：其它会话行已记下的 workingDirectory 与
// 磁盘条目一样是占用，否则两个同日同题会话会共享同一条路径、后写的把文件混进
// 先写的目录。本模块把会话行里的占用查出来交给规划器（sessionWorkDirectory）。
//
// 数据库按需动态 import：这里只在规划/重规划/撞名改道时被调用，不该把 better-sqlite3
// 拖进每个引用方的模块图（测试尤其）。查询失败不拦目录规划——按无占用降级并留 warn
//（降级必须留痕），宁可偶发撞名也不要会话开不了张。
// ============================================================================
import * as path from 'path';
import { getDefaultWorkDirectory } from './configPaths';
import { isPathWithinRoot } from '../runtime/workspaceScope';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('SessionWorkDirReservations');

export interface SessionWorkDirectoryReservationOptions {
  /** 排除某会话自己的占用（重规划/撞名改道时不想被自己挡） */
  exceptSessionId?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * 其它会话行已记下、落在默认工作根之内的绝对路径（去重）。根之外的路径永远撞不到
 * 规划候选名，直接滤掉。会话库读不了时返回空数组（降级留痕）。
 */
export async function listSessionWorkDirectoryReservations(
  options: SessionWorkDirectoryReservationOptions = {},
): Promise<string[]> {
  const root = getDefaultWorkDirectory(options.env);
  try {
    const { getDatabase } = await import('../services/core/databaseService');
    const recorded = getDatabase().listRecordedWorkingDirectories(options.exceptSessionId);
    const reserved = new Set<string>();
    for (const raw of recorded) {
      const trimmed = raw?.trim();
      if (!trimmed) continue;
      const resolved = path.resolve(trimmed);
      if (resolved === path.resolve(root) || !isPathWithinRoot(resolved, root)) continue;
      reserved.add(resolved);
    }
    return [...reserved];
  } catch (error) {
    logger.warn('[SessionWorkDirReservations] Failed to list recorded working directories, treating none as reserved:', error);
    return [];
  }
}
