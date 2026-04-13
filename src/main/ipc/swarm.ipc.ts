// ============================================================================
// Swarm IPC - Agent Swarm 事件推送到渲染进程
// ============================================================================

import { BrowserWindow, ipcMain } from '../platform';
import type {
  SwarmEvent,
  SwarmAggregation,
  SwarmLaunchRequest,
  SwarmAgentContextSnapshot,
} from '../../shared/contract/swarm';
import type { CompletedAgentRun } from '../../shared/contract/agentHistory';
import type { AgentApplicationService } from '../../shared/contract/appService';
import { getPlanApprovalGate } from '../agent/planApproval';
import { getParallelAgentCoordinator } from '../agent/parallelAgentCoordinator';
import { getSpawnGuard } from '../agent/spawnGuard';
import { getSwarmLaunchApprovalGate } from '../agent/swarmLaunchApproval';
import {
  persistAgentRun,
  getRecentAgentHistory,
} from '../session/agentHistoryPersistence';
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
 * emitSwarmEvent（legacy 直发）和 EventBus bridge 订阅器共用本函数
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
 * 向渲染进程推送 Swarm 事件（legacy 直发路径）
 *
 * ADR-008: 业务模块逐步迁到 EventBus publish → bridge 订阅器（见下方
 * ensureSwarmBusBridge）。尚未迁移的调用方（SwarmEventEmitter / 旧代码）
 * 继续走本函数的直发路径。两条路径互不重叠，每个事件恰好投递一次。
 * Phase 5/6 SwarmEventEmitter 也迁完后，本函数可删除。
 */
export function emitSwarmEvent(event: SwarmEvent): void {
  deliverSwarmEvent(event);
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

/**
 * Swarm 事件发射器
 * 封装事件推送逻辑，方便在 AgentSwarm 中使用
 */
export class SwarmEventEmitter {
  launchRequested(request: SwarmLaunchRequest): void {
    emitSwarmEvent({
      type: 'swarm:launch:requested',
      timestamp: request.requestedAt,
      data: {
        launchRequest: request,
      },
    });
  }

  launchApproved(request: SwarmLaunchRequest): void {
    emitSwarmEvent({
      type: 'swarm:launch:approved',
      timestamp: request.resolvedAt || Date.now(),
      data: {
        launchRequest: request,
      },
    });
  }

  launchRejected(request: SwarmLaunchRequest): void {
    emitSwarmEvent({
      type: 'swarm:launch:rejected',
      timestamp: request.resolvedAt || Date.now(),
      data: {
        launchRequest: request,
      },
    });
  }

  /**
   * Swarm 开始
   */
  started(agentCount: number): void {
    emitSwarmEvent({
      type: 'swarm:started',
      timestamp: Date.now(),
      data: {
        statistics: {
          total: agentCount,
          completed: 0,
          failed: 0,
          running: 0,
          pending: agentCount,
          parallelPeak: 0,
          totalTokens: 0,
          totalToolCalls: 0,
        },
      },
    });
  }

  /**
   * Agent 添加
   */
  agentAdded(agent: {
    id: string;
    name: string;
    role: string;
  }): void {
    emitSwarmEvent({
      type: 'swarm:agent:added',
      timestamp: Date.now(),
      data: {
        agentId: agent.id,
        agentState: {
          id: agent.id,
          name: agent.name,
          role: agent.role,
          status: 'pending',
          iterations: 0,
        },
      },
    });
  }

  /**
   * Agent 状态更新
   */
  agentUpdated(agentId: string, update: {
    status?: 'pending' | 'ready' | 'running' | 'completed' | 'failed' | 'cancelled';
    startTime?: number;
    endTime?: number;
    iterations?: number;
    tokenUsage?: { input: number; output: number };
    toolCalls?: number;
    lastReport?: string;
    error?: string;
    contextSnapshot?: SwarmAgentContextSnapshot;
  }): void {
    emitSwarmEvent({
      type: 'swarm:agent:updated',
      timestamp: Date.now(),
      data: {
        agentId,
        agentState: {
          id: agentId,
          name: '',  // Will be merged in store
          role: '',
          status: update.status || 'running',
          startTime: update.startTime,
          endTime: update.endTime,
          iterations: update.iterations || 0,
          tokenUsage: update.tokenUsage,
          toolCalls: update.toolCalls,
          lastReport: update.lastReport,
          error: update.error,
          contextSnapshot: update.contextSnapshot,
        },
      },
    });
  }

  /**
   * Agent 完成
   */
  agentCompleted(agentId: string, output?: string): void {
    emitSwarmEvent({
      type: 'swarm:agent:completed',
      timestamp: Date.now(),
      data: {
        agentId,
        agentState: {
          id: agentId,
          name: '',
          role: '',
          status: 'completed',
          iterations: 0,
          endTime: Date.now(),
          lastReport: output?.slice(0, 100),
        },
      },
    });
  }

  /**
   * Agent 失败
   */
  agentFailed(agentId: string, error: string): void {
    emitSwarmEvent({
      type: 'swarm:agent:failed',
      timestamp: Date.now(),
      data: {
        agentId,
        agentState: {
          id: agentId,
          name: '',
          role: '',
          status: 'failed',
          iterations: 0,
          endTime: Date.now(),
          error,
        },
      },
    });
  }

  /**
   * Swarm 完成
   */
  completed(statistics: {
    total: number;
    completed: number;
    failed: number;
    parallelPeak: number;
    totalTime: number;
  }): void {
    emitSwarmEvent({
      type: 'swarm:completed',
      timestamp: Date.now(),
      data: {
        statistics: {
          ...statistics,
          running: 0,
          pending: 0,
          totalTokens: 0,
          totalToolCalls: 0,
        },
        result: {
          success: statistics.failed === 0,
          totalTime: statistics.totalTime,
        },
      },
    });
  }

  /**
   * Swarm 完成（带聚合结果）
   */
  completedWithAggregation(statistics: {
    total: number;
    completed: number;
    failed: number;
    parallelPeak: number;
    totalTime: number;
  }, aggregation: SwarmAggregation): void {
    emitSwarmEvent({
      type: 'swarm:completed',
      timestamp: Date.now(),
      data: {
        statistics: {
          ...statistics,
          running: 0,
          pending: 0,
          totalTokens: 0,
          totalToolCalls: aggregation.totalIterations,
        },
        result: {
          success: statistics.failed === 0,
          totalTime: statistics.totalTime,
          aggregation,
        },
      },
    });
  }

  /**
   * Swarm 取消
   */
  cancelled(): void {
    emitSwarmEvent({
      type: 'swarm:cancelled',
      timestamp: Date.now(),
      data: {},
    });
  }

  // ========================================================================
  // Agent Teams 扩展事件
  // ========================================================================

  /**
   * Agent 间消息
   */
  agentMessage(from: string, to: string, content: string, messageType?: string): void {
    emitSwarmEvent({
      type: 'swarm:agent:message',
      timestamp: Date.now(),
      data: {
        message: { from, to, content, messageType },
      },
    });
  }

  /**
   * Plan 审批请求
   */
  planReview(agentId: string, planId: string, planContent: string): void {
    emitSwarmEvent({
      type: 'swarm:agent:plan_review',
      timestamp: Date.now(),
      data: {
        agentId,
        plan: { id: planId, agentId, content: planContent, status: 'pending' },
      },
    });
  }

  /**
   * Plan 审批通过
   */
  planApproved(agentId: string, planId: string, feedback?: string): void {
    emitSwarmEvent({
      type: 'swarm:agent:plan_approved',
      timestamp: Date.now(),
      data: {
        agentId,
        plan: { id: planId, agentId, content: '', status: 'approved', feedback },
      },
    });
  }

  /**
   * Plan 驳回
   */
  planRejected(agentId: string, planId: string, feedback: string): void {
    emitSwarmEvent({
      type: 'swarm:agent:plan_rejected',
      timestamp: Date.now(),
      data: {
        agentId,
        plan: { id: planId, agentId, content: '', status: 'rejected', feedback },
      },
    });
  }

  /**
   * 用户直接消息
   */
  userMessage(agentId: string, message: string): void {
    emitSwarmEvent({
      type: 'swarm:user:message',
      timestamp: Date.now(),
      data: {
        agentId,
        message: { from: 'user', to: agentId, content: message },
      },
    });
  }
}

// 单例
let emitterInstance: SwarmEventEmitter | null = null;

export function getSwarmEventEmitter(): SwarmEventEmitter {
  if (!emitterInstance) {
    emitterInstance = new SwarmEventEmitter();
  }
  return emitterInstance;
}

// ============================================================================
// IPC Handler 注册（Renderer → Main）
// ============================================================================

export function registerSwarmHandlers(
  getAppService: () => AgentApplicationService | null
): void {
  // 幂等安装 EventBus bridge（模块加载时已装一次，此处兜底）
  ensureSwarmBusBridge();
  const { getTeammateService } = require('../agent/teammate/teammateService');

  // 用户发送消息给 Agent
  ipcMain.handle('swarm:send-user-message', async (_, payload: { agentId: string; message: string }) => {
    try {
      const service = getTeammateService();
      service.onUserMessage(payload.agentId, payload.message);
      getSwarmEventEmitter().userMessage(payload.agentId, payload.message);
    } catch (error) {
      logger.error('swarm:send-user-message failed', { error: String(error) });
    }
  });

  // 获取 Agent 消息历史
  ipcMain.handle('swarm:get-agent-messages', async (_, agentId: string) => {
    try {
      const service = getTeammateService();
      const history = service.getHistory(200);
      return history
        .filter((m: any) => m.from === agentId || m.to === agentId || m.to === 'all')
        .map((m: any) => ({
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
      const gate = getSwarmLaunchApprovalGate();
      return gate.approve(payload.requestId, payload.feedback);
    } catch (error) {
      logger.error('swarm:approve-launch failed', { error: String(error) });
      return false;
    }
  });

  ipcMain.handle('swarm:reject-launch', async (_, payload: { requestId: string; feedback: string }) => {
    try {
      const gate = getSwarmLaunchApprovalGate();
      return gate.reject(payload.requestId, payload.feedback);
    } catch (error) {
      logger.error('swarm:reject-launch failed', { error: String(error) });
      return false;
    }
  });

  ipcMain.handle('swarm:cancel-agent', async (_, payload: { agentId: string }) => {
    try {
      const guard = getSpawnGuard();
      const coordinator = getParallelAgentCoordinator();
      const cancelled = guard.cancel(payload.agentId) || coordinator.abortTask(payload.agentId);

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
      const coordinator = getParallelAgentCoordinator();
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
      const gate = getPlanApprovalGate();
      const plan = gate.getPlan(payload.planId);
      if (!plan) return false;

      const approved = gate.approve(payload.planId, payload.feedback);
      if (!approved) return false;

      try {
        const service = getTeammateService();
        service.approvePlan(plan.coordinatorId, plan.agentId, payload.planId, payload.feedback);
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
      const gate = getPlanApprovalGate();
      const plan = gate.getPlan(payload.planId);
      if (!plan) return false;

      const rejected = gate.reject(payload.planId, payload.feedback);
      if (!rejected) return false;

      try {
        const service = getTeammateService();
        service.rejectPlan(plan.coordinatorId, plan.agentId, payload.planId, payload.feedback);
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
      await persistAgentRun(payload.sessionId, payload.run);
      return true;
    } catch (error) {
      logger.error('swarm:persist-agent-run failed', { error: String(error) });
      return false;
    }
  });

  // 获取最近完成的 agent runs
  ipcMain.handle('swarm:get-agent-history', async (_, payload?: { limit?: number }) => {
    try {
      return getRecentAgentHistory(payload?.limit);
    } catch (error) {
      logger.error('swarm:get-agent-history failed', { error: String(error) });
      return [];
    }
  });
}
