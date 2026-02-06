// ============================================================================
// Swarm IPC - Agent Swarm 事件推送到渲染进程
// ============================================================================

import { BrowserWindow, ipcMain } from 'electron';
import type { SwarmEvent, AgentStatus } from '../../shared/types/swarm';
import type { AgentOrchestrator } from '../agent/agentOrchestrator';

/**
 * 向渲染进程推送 Swarm 事件
 */
export function emitSwarmEvent(event: SwarmEvent): void {
  const windows = BrowserWindow.getAllWindows();
  for (const win of windows) {
    if (!win.isDestroyed()) {
      win.webContents.send('swarm:event', event);
    }
  }
}

/**
 * Swarm 事件发射器
 * 封装事件推送逻辑，方便在 AgentSwarm 中使用
 */
export class SwarmEventEmitter {
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
  planReview(agentId: string, planContent: string): void {
    emitSwarmEvent({
      type: 'swarm:agent:plan_review',
      timestamp: Date.now(),
      data: {
        agentId,
        plan: { agentId, content: planContent, status: 'pending' },
      },
    });
  }

  /**
   * Plan 审批通过
   */
  planApproved(agentId: string, feedback?: string): void {
    emitSwarmEvent({
      type: 'swarm:agent:plan_approved',
      timestamp: Date.now(),
      data: {
        agentId,
        plan: { agentId, content: '', status: 'approved', feedback },
      },
    });
  }

  /**
   * Plan 驳回
   */
  planRejected(agentId: string, feedback: string): void {
    emitSwarmEvent({
      type: 'swarm:agent:plan_rejected',
      timestamp: Date.now(),
      data: {
        agentId,
        plan: { agentId, content: '', status: 'rejected', feedback },
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
  getOrchestrator: () => AgentOrchestrator | null
): void {
  const { getTeammateService } = require('../agent/teammate/teammateService');

  // 用户发送消息给 Agent
  ipcMain.handle('swarm:send-user-message', async (_, payload: { agentId: string; message: string }) => {
    const service = getTeammateService();
    service.onUserMessage(payload.agentId, payload.message);
    // 同时通过事件推送给 UI
    getSwarmEventEmitter().userMessage(payload.agentId, payload.message);
  });

  // 获取 Agent 消息历史
  ipcMain.handle('swarm:get-agent-messages', async (_, agentId: string) => {
    const service = getTeammateService();
    // 获取该 agent 参与的所有消息
    const history = service.getHistory(200);
    return history
      .filter((m: any) => m.from === agentId || m.to === agentId || m.to === 'all')
      .map((m: any) => ({
        from: m.from,
        to: m.to,
        content: m.content,
        timestamp: m.timestamp,
      }));
  });

  // 切换 delegate 模式
  ipcMain.handle('swarm:set-delegate-mode', async (_, enabled: boolean) => {
    const orchestrator = getOrchestrator();
    if (orchestrator) {
      orchestrator.setDelegateMode(enabled);
    }
  });
}
