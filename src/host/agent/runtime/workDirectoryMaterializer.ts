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
//
// 撞名残留（rework r2）：目录已存在且非空、又被其它会话行同时记下时，说明规划期
// 竞态已经让两个会话拿到了同一路径。此刻运行 cwd 已不可变（run-scoped
// ToolExecutor），本轮写入必然会混入对方产物——改道只能在运行开始前的 agent
// preflight 做（maybeDivertCollidingSessionWorkDirectory），这里至少留 warn 让混写
// 有迹可循，下一轮 preflight 会切走。
//
// 注意：这里只建目录，不做项目认领。会话的项目归属在首条消息落库后就不可变
//（PROJECT_BOUNDARY_IMMUTABLE），而懒开目录总在消息之后才落盘——懒开会话因此
// 停留在未分类，目录只作为磁盘上的产出夹存在，不铸造对应 Project 行。
// ============================================================================
import * as fs from 'fs/promises';
import * as path from 'path';
import { getDefaultWorkDirectory } from '../../config/configPaths';
import { materializeSessionWorkDirectory } from '../../config/sessionWorkDirectory';
import { listSessionWorkDirectoryReservations } from '../../config/sessionWorkDirectoryReservations';
import { isPathWithinRoot } from '../../runtime/workspaceScope';
import { createLogger } from '../../services/infra/logger';

const logger = createLogger('WorkDirectoryMaterializer');

const attempts = new Map<string, Promise<void>>();

async function warnIfForeignClaimed(dir: string, sessionId?: string): Promise<void> {
  if (!sessionId) return;
  try {
    if ((await fs.readdir(dir)).length === 0) return;
    const claimedByOthers = (await listSessionWorkDirectoryReservations({ exceptSessionId: sessionId }))
      .some((reserved) => path.resolve(reserved) === dir);
    if (claimedByOthers) {
      logger.warn(`[WorkDirectoryMaterializer] Session work dir ${dir} is also recorded by another session; this turn's writes will mix — next turn's preflight diverts`);
    }
  } catch (error) {
    logger.warn(`[WorkDirectoryMaterializer] Cannot check ownership of session work dir ${dir}:`, error);
  }
}

async function attemptMaterialization(dir: string, sessionId?: string): Promise<void> {
  if (!isPathWithinRoot(dir, getDefaultWorkDirectory())) return;
  try {
    const stats = await fs.stat(dir);
    // 已存在：不重复建。存在但不是目录更不能动——让后续写入自己撞出真实错误。
    if (!stats.isDirectory()) {
      logger.warn(`[WorkDirectoryMaterializer] Planned session work dir exists but is not a directory: ${dir}`);
      return;
    }
    await warnIfForeignClaimed(dir, sessionId);
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
export function materializeRunWorkDirectoryOnce(
  workingDirectory: string | undefined,
  context?: { sessionId?: string },
): Promise<void> {
  const trimmed = workingDirectory?.trim();
  if (!trimmed) return Promise.resolve();
  const dir = path.resolve(trimmed);
  const existing = attempts.get(dir);
  if (existing) return existing;
  const attempt = attemptMaterialization(dir, context?.sessionId);
  attempts.set(dir, attempt);
  return attempt;
}
