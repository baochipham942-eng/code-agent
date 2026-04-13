// ============================================================================
// SwarmEventEmitter - Agent Swarm 事件发布器
// ============================================================================
//
// ADR-008 Phase 5: 从 ipc/swarm.ipc.ts 迁出，切断 agentSwarm → swarm.ipc 的
// 正向边（Cycle 1）。所有事件通过 EventBus 'swarm' domain 发布，由 swarm.ipc
// 的 bridge 订阅器（ensureSwarmBusBridge）统一投递到 BrowserWindow + CLI listeners。
//
// 本模块只依赖 protocol/events/bus 和 shared/contract/swarm 类型，不反向
// import 任何 agent/* 或 ipc/*，确保不引入新循环。
// ============================================================================

import type {
  SwarmEvent,
  SwarmAgentContextSnapshot,
  SwarmAggregation,
  SwarmLaunchRequest,
} from '../../shared/contract/swarm';
import { getEventBus } from '../protocol/events/bus';

/**
 * 将 SwarmEvent 发布到 EventBus 'swarm' domain
 * Channel 命名去掉 'swarm:' 前缀避免 'swarm:swarm:...' 双重命名
 */
function publish(event: SwarmEvent): void {
  const busType = event.type.startsWith('swarm:') ? event.type.slice(6) : event.type;
  getEventBus().publish('swarm', busType, event, { bridgeToRenderer: false });
}

/**
 * Swarm 事件发射器
 * 封装事件推送逻辑，方便在 AgentSwarm / IPC handler 中使用
 */
export class SwarmEventEmitter {
  launchRequested(request: SwarmLaunchRequest): void {
    publish({
      type: 'swarm:launch:requested',
      timestamp: request.requestedAt,
      data: { launchRequest: request },
    });
  }

  launchApproved(request: SwarmLaunchRequest): void {
    publish({
      type: 'swarm:launch:approved',
      timestamp: request.resolvedAt || Date.now(),
      data: { launchRequest: request },
    });
  }

  launchRejected(request: SwarmLaunchRequest): void {
    publish({
      type: 'swarm:launch:rejected',
      timestamp: request.resolvedAt || Date.now(),
      data: { launchRequest: request },
    });
  }

  started(agentCount: number): void {
    publish({
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

  agentAdded(agent: { id: string; name: string; role: string }): void {
    publish({
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
    publish({
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

  agentCompleted(agentId: string, output?: string): void {
    publish({
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

  agentFailed(agentId: string, error: string): void {
    publish({
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

  completed(statistics: {
    total: number;
    completed: number;
    failed: number;
    parallelPeak: number;
    totalTime: number;
  }): void {
    publish({
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

  completedWithAggregation(statistics: {
    total: number;
    completed: number;
    failed: number;
    parallelPeak: number;
    totalTime: number;
  }, aggregation: SwarmAggregation): void {
    publish({
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

  cancelled(): void {
    publish({
      type: 'swarm:cancelled',
      timestamp: Date.now(),
      data: {},
    });
  }

  // ========================================================================
  // Agent Teams 扩展事件
  // ========================================================================

  agentMessage(from: string, to: string, content: string, messageType?: string): void {
    publish({
      type: 'swarm:agent:message',
      timestamp: Date.now(),
      data: {
        message: { from, to, content, messageType },
      },
    });
  }

  planReview(agentId: string, planId: string, planContent: string): void {
    publish({
      type: 'swarm:agent:plan_review',
      timestamp: Date.now(),
      data: {
        agentId,
        plan: { id: planId, agentId, content: planContent, status: 'pending' },
      },
    });
  }

  planApproved(agentId: string, planId: string, feedback?: string): void {
    publish({
      type: 'swarm:agent:plan_approved',
      timestamp: Date.now(),
      data: {
        agentId,
        plan: { id: planId, agentId, content: '', status: 'approved', feedback },
      },
    });
  }

  planRejected(agentId: string, planId: string, feedback: string): void {
    publish({
      type: 'swarm:agent:plan_rejected',
      timestamp: Date.now(),
      data: {
        agentId,
        plan: { id: planId, agentId, content: '', status: 'rejected', feedback },
      },
    });
  }

  userMessage(agentId: string, message: string): void {
    publish({
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
