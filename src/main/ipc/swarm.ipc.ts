// ============================================================================
// Swarm IPC - Agent Swarm 事件推送到渲染进程
// ============================================================================

import { BrowserWindow, ipcMain } from '../platform';
import type { SwarmEvent } from '../../shared/contract/swarm';
import type { CompletedAgentRun } from '../../shared/contract/agentHistory';
import type { AgentApplicationService } from '../../shared/contract/appService';
import { getSwarmServices } from '../agent/swarmServices';
import { getSwarmEventEmitter } from '../agent/swarmEventPublisher';
import { createLogger } from '../services/infra/logger';
import { getEventBus } from '../protocol/events/bus';

const logger = createLogger('SwarmIPC');

// ============================================================================
// Swarm 事件回调注册（CLI 模式使用）
// ============================================================================

type SwarmEventListener = (event: SwarmEvent) => void;
const swarmEventListeners: SwarmEventListener[] = [];

/**
 * 注册 Swarm 事件监听器（CLI 模式下将事件路由到终端输出）
 * @returns 取消监听的函数
 */
export function addSwarmEventListener(listener: SwarmEventListener): () => void {
  swarmEventListeners.push(listener);
  return () => {
    const idx = swarmEventListeners.indexOf(listener);
    if (idx >= 0) swarmEventListeners.splice(idx, 1);
  };
}

/**
 * 将 SwarmEvent 投递到渲染进程 + CLI listeners
 * EventBus bridge 订阅器收到事件后调用本函数做实际分发。
 * 业务模块通过 getEventBus().publish('swarm', ...) 发布，不直接调本函数。
 */
function deliverSwarmEvent(event: SwarmEvent): void {
  const windows = BrowserWindow.getAllWindows();
  for (const win of windows) {
    if (!win.isDestroyed()) {
      win.webContents.send('swarm:event', event);
    }
  }
  for (const listener of swarmEventListeners) {
    try { listener(event); } catch { /* 防止监听器错误影响事件流 */ }
  }
}

/**
 * ADR-008: EventBus 'swarm' domain → BrowserWindow + CLI listeners 桥接
 *
 * 业务模块（Phase 2 起：swarmLaunchApproval；Phase 3+：planApproval / agentSwarm）
 * 通过 getEventBus().publish('swarm', ...) 发布事件，由本桥接器统一投递给渲染进程。
 * 订阅 domain 级别（pattern='swarm'）一次即覆盖所有 swarm:* channel。
 *
 * 幂等：多次调用只订阅一次（模块加载 + registerSwarmHandlers 都会触发，
 * 保证即使 swarm.ipc 在 handler 注册前被其它模块引用也能先装好桥）。
 */
let swarmBusBridgeInstalled = false;
function ensureSwarmBusBridge(): void {
  if (swarmBusBridgeInstalled) return;
  swarmBusBridgeInstalled = true;
  getEventBus().subscribe<SwarmEvent>('swarm', (evt) => {
    deliverSwarmEvent(evt.data);
  });
  logger.debug('Swarm EventBus bridge installed');
}

// 模块加载时立即安装桥接器，确保早期发布的事件也能到达渲染进程
ensureSwarmBusBridge();

// ============================================================================
// IPC Handler 注册（Renderer → Main）
// ============================================================================

export function registerSwarmHandlers(
  getAppService: () => AgentApplicationService | null
): void {
  // 幂等安装 EventBus bridge（模块加载时已装一次，此处兜底）
  ensureSwarmBusBridge();

  // 用户发送消息给 Agent
  ipcMain.handle('swarm:send-user-message', async (_, payload: { agentId: string; message: string }) => {
    try {
      const services = getSwarmServices();
      services.teammateService.onUserMessage(payload.agentId, payload.message);
      getSwarmEventEmitter().userMessage(payload.agentId, payload.message);
    } catch (error) {
      logger.error('swarm:send-user-message failed', { error: String(error) });
    }
  });

  // 获取 Agent 消息历史
  ipcMain.handle('swarm:get-agent-messages', async (_, agentId: string) => {
    try {
      const services = getSwarmServices();
      const history = services.teammateService.getHistory(200);
      return history
        .filter((m: { from: string; to: string }) => m.from === agentId || m.to === agentId || m.to === 'all')
        .map((m: { from: string; to: string; content: string; timestamp: number }) => ({
          from: m.from,
          to: m.to,
          content: m.content,
          timestamp: m.timestamp,
        }));
    } catch (error) {
      logger.error('swarm:get-agent-messages failed', { error: String(error) });
      return [];
    }
  });

  // 切换 delegate 模式
  ipcMain.handle('swarm:set-delegate-mode', async (_, enabled: boolean) => {
    try {
      const appService = getAppService();
      if (appService) {
        appService.setDelegateMode(enabled);
      }
    } catch (error) {
      logger.error('swarm:set-delegate-mode failed', { error: String(error) });
    }
  });

  ipcMain.handle('swarm:get-delegate-mode', async () => {
    try {
      const appService = getAppService();
      return appService?.isDelegateMode() ?? false;
    } catch (error) {
      logger.error('swarm:get-delegate-mode failed', { error: String(error) });
      return false;
    }
  });

  ipcMain.handle('swarm:approve-launch', async (_, payload: { requestId: string; feedback?: string }) => {
    try {
      return getSwarmServices().launchApproval.approve(payload.requestId, payload.feedback);
    } catch (error) {
      logger.error('swarm:approve-launch failed', { error: String(error) });
      return false;
    }
  });

  ipcMain.handle('swarm:reject-launch', async (_, payload: { requestId: string; feedback: string }) => {
    try {
      return getSwarmServices().launchApproval.reject(payload.requestId, payload.feedback);
    } catch (error) {
      logger.error('swarm:reject-launch failed', { error: String(error) });
      return false;
    }
  });

  ipcMain.handle('swarm:cancel-agent', async (_, payload: { agentId: string }) => {
    try {
      const services = getSwarmServices();
      const cancelled =
        services.spawnGuard.cancel(payload.agentId) ||
        services.parallelCoordinator.abortTask(payload.agentId);

      if (cancelled) {
        getSwarmEventEmitter().agentUpdated(payload.agentId, {
          status: 'cancelled',
          endTime: Date.now(),
          error: 'Cancelled by user',
        });
      }

      return cancelled;
    } catch (error) {
      logger.error('swarm:cancel-agent failed', { error: String(error) });
      return false;
    }
  });

  ipcMain.handle('swarm:retry-agent', async (_, payload: { agentId: string }) => {
    try {
      const coordinator = getSwarmServices().parallelCoordinator;
      const task = coordinator.getTaskDefinition(payload.agentId);
      if (!task) return false;

      getSwarmEventEmitter().agentUpdated(payload.agentId, {
        status: 'running',
        startTime: Date.now(),
        endTime: undefined,
        error: '',
        lastReport: 'Retrying task',
      });

      void coordinator.retryTask(payload.agentId)
        .then((result) => {
          if (result.success) {
            getSwarmEventEmitter().agentCompleted(payload.agentId, result.output);
            return;
          }

          getSwarmEventEmitter().agentFailed(payload.agentId, result.error || 'Unknown error');
        })
        .catch((error: unknown) => {
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          getSwarmEventEmitter().agentFailed(payload.agentId, errorMessage);
        });

      return true;
    } catch (error) {
      logger.error('swarm:retry-agent failed', { error: String(error) });
      return false;
    }
  });

  ipcMain.handle('swarm:approve-plan', async (_, payload: { planId: string; feedback?: string }) => {
    try {
      const services = getSwarmServices();
      const plan = services.planApproval.getPlan(payload.planId);
      if (!plan) return false;

      const approved = services.planApproval.approve(payload.planId, payload.feedback);
      if (!approved) return false;

      try {
        services.teammateService.approvePlan(plan.coordinatorId, plan.agentId, payload.planId, payload.feedback);
      } catch {
        // Ignore teammate sync failure; gate state is the source of truth.
      }

      getSwarmEventEmitter().planApproved(plan.agentId, payload.planId, payload.feedback);
      return true;
    } catch (error) {
      logger.error('swarm:approve-plan failed', { error: String(error) });
      return false;
    }
  });

  ipcMain.handle('swarm:reject-plan', async (_, payload: { planId: string; feedback: string }) => {
    try {
      const services = getSwarmServices();
      const plan = services.planApproval.getPlan(payload.planId);
      if (!plan) return false;

      const rejected = services.planApproval.reject(payload.planId, payload.feedback);
      if (!rejected) return false;

      try {
        services.teammateService.rejectPlan(plan.coordinatorId, plan.agentId, payload.planId, payload.feedback);
      } catch {
        // Ignore teammate sync failure; gate state is the source of truth.
      }

      getSwarmEventEmitter().planRejected(plan.agentId, payload.planId, payload.feedback);
      return true;
    } catch (error) {
      logger.error('swarm:reject-plan failed', { error: String(error) });
      return false;
    }
  });

  // Agent 历史持久化
  ipcMain.handle('swarm:persist-agent-run', async (_, payload: { sessionId: string; run: CompletedAgentRun }) => {
    try {
      await getSwarmServices().agentHistory.persistAgentRun(payload.sessionId, payload.run);
      return true;
    } catch (error) {
      logger.error('swarm:persist-agent-run failed', { error: String(error) });
      return false;
    }
  });

  // 获取最近完成的 agent runs
  ipcMain.handle('swarm:get-agent-history', async (_, payload?: { limit?: number }) => {
    try {
      return await getSwarmServices().agentHistory.getRecentAgentHistory(payload?.limit);
    } catch (error) {
      logger.error('swarm:get-agent-history failed', { error: String(error) });
      return [];
    }
  });
}
