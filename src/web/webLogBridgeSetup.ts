// ============================================================================
// LogBridge + P3-A 只读任务状态 provider —— 发行版路径接线
//
// 从 webServer.ts 原地抽出（行为逐字不变）。抽出的原因：webServer 有效行数正好卡在
// max-lines(1000, skipComments) 上限，加不进任何新代码；本块自包含且无外部依赖，
// 是最适合挪走的一块。与 webCapabilityBootstrap.ts / queuedInputStartupSweep.ts /
// webStartupRetention.ts 同一手法。
//
// 原注释（保留）：与 webServer 步骤 5/6/7 同类的 web/main 路径分离修复：
// logBridge.start() + provider 注册此前只在 Electron main 路径
// （initBackgroundServices.ts）执行，而所有发行版实际跑的是 webServer 路径 ——
// 不补这里，bridge 在发行版里从不启动，P3-A 只读工具（neo_list_tasks 等）以及现有
// get_logs/get_status 的 bridge 拉取在发行版里全部失效。
// ============================================================================

import { createLogger } from '../host/services/infra/logger';

const logger = createLogger('WebLogBridgeSetup');

export async function setupWebLogBridge(): Promise<void> {
  try {
    const { logBridge } = await import('../host/mcp/logBridge');
    const { TaskStatusProvider } = await import('../host/mcp/taskStatusProvider');
    const { getDatabase } = await import('../host/services/core/databaseService');
    const { getProjectService } = await import('../host/services/project/projectService');
    const { getTaskManager } = await import('../host/task/TaskManager');
    logBridge.setTaskStatusProvider(
      new TaskStatusProvider({
        getSwarmRepo: () => {
          try {
            const db = getDatabase();
            return db.isReady ? db.getSwarmTraceRepo() : null;
          } catch {
            return null;
          }
        },
        getProjectService: () => getProjectService(),
        getTaskManager: () => getTaskManager(),
      }),
    );
    await logBridge.start();
    logger.info('LogBridge started (web path) + P3-A task status provider registered');
  } catch (error) {
    logger.warn('LogBridge / task status provider init failed (non-blocking):', (error as Error).message);
  }
}
