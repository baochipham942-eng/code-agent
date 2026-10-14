// ============================================================================
// 懒开目录的落盘收口（N-DELIVERABLE-WORKDIR-LAZY）
// ============================================================================
// 无文件夹会话的工作目录首轮只规划不落盘（sessionWorkDirectory.planSessionWorkDirectory），
// 纯问答会话不产生任何目录。真正要写的那一刻在这里补 mkdir：工具引擎在派发首个
// 非 readOnly 工具前调用；外部引擎（codex/claude 等要把目录当子进程 cwd，缺失会被
// assertWorkspaceCwd 硬拒）在 web 路由 preflight 调用。
//
// 边界：只对 getDefaultWorkDirectory() 之内且当前不存在的路径出手——默认根之外的
// 目录不属于懒开机制的承诺，绝不自动创建。每路径每进程只尝试一次（并发共享同一次
// 尝试）；失败留 warn 不向调用方抛错，让工具自己带出真实错误（降级必须留痕）。
// ============================================================================
import * as fs from 'fs/promises';
import * as path from 'path';
import { getDefaultWorkDirectory } from '../../config/configPaths';
import { materializeSessionWorkDirectory } from '../../config/sessionWorkDirectory';
import { isPathWithinRoot } from '../../runtime/workspaceScope';
import { createLogger } from '../../services/infra/logger';

const logger = createLogger('WorkDirectoryMaterializer');

const attempts = new Map<string, Promise<void>>();

async function attemptMaterialization(dir: string): Promise<void> {
  if (!isPathWithinRoot(dir, getDefaultWorkDirectory())) return;
  try {
    const stats = await fs.stat(dir);
    // 已存在：不重复建。存在但不是目录更不能动——让后续写入自己撞出真实错误。
    if (!stats.isDirectory()) {
      logger.warn(`[WorkDirectoryMaterializer] Planned session work dir exists but is not a directory: ${dir}`);
    }
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.warn(`[WorkDirectoryMaterializer] Cannot inspect planned session work dir ${dir}:`, error);
      return;
    }
  }
  try {
    await materializeSessionWorkDirectory(dir);
    logger.info(`[WorkDirectoryMaterializer] Materialized planned session work dir: ${dir}`);
  } catch (error) {
    logger.warn(`[WorkDirectoryMaterializer] Failed to materialize session work dir ${dir}:`, error);
  }
}

/**
 * 工作目录不存在且在默认工作根之内时把它建出来；幂等（每路径每进程一次），绝不抛错。
 */
export function materializeRunWorkDirectoryOnce(workingDirectory: string | undefined): Promise<void> {
  const trimmed = workingDirectory?.trim();
  if (!trimmed) return Promise.resolve();
  const dir = path.resolve(trimmed);
  const existing = attempts.get(dir);
  if (existing) return existing;
  const attempt = attemptMaterialization(dir);
  attempts.set(dir, attempt);
  return attempt;
}
