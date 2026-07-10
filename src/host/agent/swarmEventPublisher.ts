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

import { randomUUID } from 'crypto';
import type {
  SwarmEvent,
  SwarmAgentContextSnapshot,
  SwarmAggregation,
  SwarmLaunchRequest,
  SwarmContextUpdate,
  SwarmRunScope,
} from '../../shared/contract/swarm';
import {
  createScopedSwarmMessageId,
  parseScopedSwarmMessageId,
} from '../../shared/contract/swarm';
import { getEventBus } from '../services/eventing/bus';

/**
 * Swarm 事件发射器
 * 封装事件推送逻辑，方便在 AgentSwarm / IPC handler 中使用
 *
 * 运行身份由每次调用显式传入。Emitter 自身无可变 active-run 状态，允许多个
 * Team 重叠发布而不会互相覆盖 sessionId/runId。
 */
export class SwarmEventEmitter {
  private resolveMessageId(scope: SwarmRunScope, suppliedId: string): string {
    const parsed = parseScopedSwarmMessageId(suppliedId);
    if (!parsed) return createScopedSwarmMessageId(scope, suppliedId);
    if (
      parsed.scope.sessionId !== scope.sessionId
      || parsed.scope.runId !== scope.runId
      || parsed.scope.treeId !== scope.treeId
    ) {
      throw new Error('Scoped swarm event message id belongs to a different Team run');
    }
    return suppliedId;
  }

  private publish(
    scope: SwarmRunScope,
    event: Omit<SwarmEvent, 'sessionId' | 'runId' | 'treeId'>,
  ): void {
    const stamped: SwarmEvent = {
      ...event,
      sessionId: scope.sessionId,
      runId: scope.runId,
      treeId: scope.treeId,
    };
    const busType = stamped.type.startsWith('swarm:') ? stamped.type.slice(6) : stamped.type;
    getEventBus().publish('swarm', busType, stamped, {
      sessionId: scope.sessionId,
      bridgeToRenderer: false,
    });
  }

  launchRequested(request: SwarmLaunchRequest): void {
    this.publish(request, {
      type: 'swarm:launch:requested',
      timestamp: request.requestedAt,
      data: { launchRequest: request },
    });
  }

  launchApproved(request: SwarmLaunchRequest): void {
    this.publish(request, {
      type: 'swarm:launch:approved',
      timestamp: request.resolvedAt || Date.now(),
      data: { launchRequest: request },
    });
  }

  launchRejected(request: SwarmLaunchRequest): void {
    this.publish(request, {
      type: 'swarm:launch:rejected',
      timestamp: request.resolvedAt || Date.now(),
      data: { launchRequest: request },
    });
  }

  started(scope: SwarmRunScope, agentCount: number): void {
    this.publish(scope, {
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

  agentAdded(scope: SwarmRunScope, agent: { id: string; name: string; role: string }): void {
    this.publish(scope, {
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

  agentUpdated(scope: SwarmRunScope, agentId: string, update: {
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
    this.publish(scope, {
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

  agentCompleted(scope: SwarmRunScope, agentId: string, output?: string): void {
    this.publish(scope, {
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

  agentFailed(scope: SwarmRunScope, agentId: string, error: string): void {
    this.publish(scope, {
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

  agentCancelled(scope: SwarmRunScope, agentId: string, reason = 'Cancelled by user'): void {
    this.publish(scope, {
      type: 'swarm:agent:failed',
      timestamp: Date.now(),
      data: {
        agentId,
        agentState: {
          id: agentId,
          name: '',
          role: '',
          status: 'cancelled',
          iterations: 0,
          endTime: Date.now(),
          error: reason,
        },
      },
    });
  }

  completed(scope: SwarmRunScope, statistics: {
    total: number;
    completed: number;
    failed: number;
    parallelPeak: number;
    totalTime: number;
  }): void {
    this.publish(scope, {
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

  completedWithAggregation(scope: SwarmRunScope, statistics: {
    total: number;
    completed: number;
    failed: number;
    parallelPeak: number;
    totalTime: number;
  }, aggregation: SwarmAggregation): void {
    this.publish(scope, {
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

  cancelled(scope: SwarmRunScope): void {
    this.publish(scope, {
      type: 'swarm:cancelled',
      timestamp: Date.now(),
      data: {},
    });
  }

  // ========================================================================
  // Agent Teams 扩展事件
  // ========================================================================

  agentMessage(
    scope: SwarmRunScope,
    from: string,
    to: string,
    content: string,
    messageType?: string,
    messageId: string = randomUUID(),
  ): void {
    this.publish(scope, {
      type: 'swarm:agent:message',
      timestamp: Date.now(),
      data: {
        message: { id: this.resolveMessageId(scope, messageId), from, to, content, messageType },
      },
    });
  }

  /**
   * SharedContext 协作过程变更（P1-3 讨论流）：发现 / 决策 / 人话状态 / result passing。
   * 事件 timestamp 复用 update.at（SharedContext.lastUpdated 版本戳），保证讨论流时序
   * 与底层数据新鲜度一致。
   */
  contextUpdate(scope: SwarmRunScope, update: SwarmContextUpdate): void {
    this.publish(scope, {
      type: 'swarm:context:update',
      timestamp: update.at,
      data: {
        agentId: update.agentId,
        contextUpdate: update,
      },
    });
  }

  planReview(scope: SwarmRunScope, agentId: string, planId: string, planContent: string): void {
    this.publish(scope, {
      type: 'swarm:agent:plan_review',
      timestamp: Date.now(),
      data: {
        agentId,
        plan: { id: planId, agentId, content: planContent, status: 'pending' },
      },
    });
  }

  planApproved(scope: SwarmRunScope, agentId: string, planId: string, feedback?: string): void {
    this.publish(scope, {
      type: 'swarm:agent:plan_approved',
      timestamp: Date.now(),
      data: {
        agentId,
        plan: { id: planId, agentId, content: '', status: 'approved', feedback },
      },
    });
  }

  planRejected(scope: SwarmRunScope, agentId: string, planId: string, feedback: string): void {
    this.publish(scope, {
      type: 'swarm:agent:plan_rejected',
      timestamp: Date.now(),
      data: {
        agentId,
        plan: { id: planId, agentId, content: '', status: 'rejected', feedback },
      },
    });
  }

  userMessage(
    scope: SwarmRunScope,
    agentId: string,
    message: string,
    messageId: string = randomUUID(),
  ): void {
    this.publish(scope, {
      type: 'swarm:user:message',
      timestamp: Date.now(),
      data: {
        agentId,
        message: {
          id: this.resolveMessageId(scope, messageId),
          from: 'user',
          to: agentId,
          content: message,
        },
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
