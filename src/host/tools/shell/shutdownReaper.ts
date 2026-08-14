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
import { reapTerminalSessions } from '../../services/terminal/terminalSessionManager';
import { getAllBackgroundTasks, killBackgroundTask } from './backgroundTasks';
import { reapPtySessions } from './ptyExecutor';

/**
 * 取消全部在跑 agent，并等待后台任务、PTY 会话与终端会话的进程树确认退出。
 *
 * 必须排在关库之前调用：关库是不设超时上限的最后一步，排在它后面的步骤在真机上
 * 可能永远轮不到。本函数自己的等待上限由 killProcessTree 的 confirmTimeoutMs 兜住。
 *
 * @returns 取消的 agent 数、收掉的后台任务数、PTY 会话数与终端会话数（供属主打日志）
 */
export async function reapChildProcesses(
  reason: string = 'app_shutdown',
): Promise<{ cancelledAgents: number; killedTasks: number; killedPtySessions: number; killedTerminalSessions: number }> {
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

  // PTY 会话是第三个会 spawn 进程的子系统（node-pty 走的不是 child_process，
  // 但 POSIX 上它天生自成进程组，收树反而比后台任务更直接）。
  let killedPtySessions = 0;
  try {
    killedPtySessions = await reapPtySessions();
  } catch (error) {
    console.warn('[shutdown] reapPtySessions failed:', error);
  }

  // 第四个会 spawn 进程的子系统：会话级交互终端。它自带「下次启动收孤儿」的兜底
  // （reapOrphanTerminals），但那要等到下次启动——用户不重启就一直挂着，所以停机时也收一次。
  let killedTerminalSessions = 0;
  try {
    killedTerminalSessions = await reapTerminalSessions();
  } catch (error) {
    console.warn('[shutdown] reapTerminalSessions failed:', error);
  }

  return {
    cancelledAgents,
    killedTasks: results.filter(Boolean).length,
    killedPtySessions,
    killedTerminalSessions,
  };
}
