// ============================================================================
// Shutdown Reaper - 进程退出前的收尸
// ============================================================================
// 每个入口都有自己的停机属主（webServer 的 shutdown / CLI bootstrap 的 cleanup），
// 本模块只提供它们共用的那一步：取消在跑的 agent + 确认后台任务的进程树死干净。
//
// **不在这里注册任何 SIGTERM/SIGINT 处理器**：本进程的终止权已经有主，
// 抢注册会让干净关库一步都跑不到（同目录 backgroundTasks.ts 末尾那段注释记的就是这个
// 2026-08-08 真机事故）。属主自己在合适的位置调 reapChildProcesses()。
// ============================================================================

import { getSpawnGuard } from '../../agent/spawnGuard';
import { getAllBackgroundTasks, killBackgroundTask } from './backgroundTasks';

/**
 * 取消全部在跑 agent，并等待全部后台任务的进程树确认退出。
 *
 * 必须排在关库之前调用：关库是不设超时上限的最后一步，排在它后面的步骤在真机上
 * 可能永远轮不到。本函数自己的等待上限由 killProcessTree 的 confirmTimeoutMs 兜住。
 *
 * @returns 取消的 agent 数与收掉的后台任务数（供属主打日志）
 */
export async function reapChildProcesses(
  reason: string = 'app_shutdown',
): Promise<{ cancelledAgents: number; killedTasks: number }> {
  let cancelledAgents = 0;
  try {
    cancelledAgents = getSpawnGuard().cancelAll(reason);
  } catch (error) {
    console.warn('[shutdown] spawnGuard.cancelAll failed:', error);
  }

  const running = getAllBackgroundTasks().filter((task) => task.status === 'running');
  const results = await Promise.all(
    running.map(async (task) => {
      try {
        const result = await killBackgroundTask(task.taskId);
        return result.success;
      } catch (error) {
        console.warn(`[shutdown] failed to kill background task ${task.taskId}:`, error);
        return false;
      }
    }),
  );

  return { cancelledAgents, killedTasks: results.filter(Boolean).length };
}
