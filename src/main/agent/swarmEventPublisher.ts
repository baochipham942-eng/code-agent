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
} from '../../shared/contract/swarm';
import { getEventBus } from '../services/eventing/bus';

/**
 * Swarm 事件发射器
 * 封装事件推送逻辑，方便在 AgentSwarm / IPC handler 中使用
 *
 * runId 生命周期（ADR-010 #5）：
 * - `started()` 生成新的 runId 并保存为 currentRunId
 * - 其余 emit 方法在 publish 前为 event 打戳 currentRunId
 * - `completed()` / `cancelled()` 在事件 publish 之后清空
 *
 * 同一时刻只允许一个 active run（单进程单 swarm，与 ADR-009 假设一致）。
 */
export class SwarmEventEmitter {
  private currentRunId: string | null = null;
  private currentSessionId: string | null = null;

  /** 当前活跃 run 的 id（外部用于读，不要写） */
  getCurrentRunId(): string | null {
    return this.currentRunId;
  }

  private publish(event: SwarmEvent): void {
    const stamped: SwarmEvent = {
      ...event,
      runId: event.runId ?? this.currentRunId ?? undefined,
      sessionId: event.sessionId ?? this.currentSessionId ?? undefined,
    };
    const busType = stamped.type.startsWith('swarm:') ? stamped.type.slice(6) : stamped.type;
    getEventBus().publish('swarm', busType, stamped, { bridgeToRenderer: false });
  }

  launchRequested(request: SwarmLaunchRequest): void {
    this.publish({
      type: 'swarm:launch:requested',
      sessionId: request.sessionId,
      timestamp: request.requestedAt,
      data: { launchRequest: request },
    });
  }

  launchApproved(request: SwarmLaunchRequest): void {
    this.publish({
      type: 'swarm:launch:approved',
      sessionId: request.sessionId,
      timestamp: request.resolvedAt || Date.now(),
      data: { launchRequest: request },
    });
  }

  launchRejected(request: SwarmLaunchRequest): void {
    this.publish({
      type: 'swarm:launch:rejected',
      sessionId: request.sessionId,
      timestamp: request.resolvedAt || Date.now(),
      data: { launchRequest: request },
    });
  }

  started(agentCount: number, sessionId?: string): void {
    // 新一次 swarm 执行的入口：开 runId，所有后续事件自动打戳此 runId
    // 直到 completed/cancelled 清空。重复 started 被视为新 run（旧 run
    // 若未收尾应由调用方先 cancelled，否则旧 run 会漏掉收尾事件）。
    this.currentRunId = randomUUID();
    this.currentSessionId = sessionId ?? null;
    this.publish({
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
    this.publish({
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
    this.publish({
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
    this.publish({
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
    this.publish({
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

  agentCancelled(agentId: string, reason = 'Cancelled by user'): void {
    this.publish({
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

  completed(statistics: {
    total: number;
    completed: number;
    failed: number;
    parallelPeak: number;
    totalTime: number;
  }): void {
    this.publish({
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
    // run 收尾，清空 currentRunId（事件 publish 之后清才能让收尾事件带上 runId）
    this.currentRunId = null;
    this.currentSessionId = null;
  }

  completedWithAggregation(statistics: {
    total: number;
    completed: number;
    failed: number;
    parallelPeak: number;
    totalTime: number;
  }, aggregation: SwarmAggregation): void {
    this.publish({
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
    this.currentRunId = null;
    this.currentSessionId = null;
  }

  cancelled(): void {
    this.publish({
      type: 'swarm:cancelled',
      timestamp: Date.now(),
      data: {},
    });
    this.currentRunId = null;
    this.currentSessionId = null;
  }

  // ========================================================================
  // Agent Teams 扩展事件
  // ========================================================================

  agentMessage(from: string, to: string, content: string, messageType?: string): void {
    this.publish({
      type: 'swarm:agent:message',
      timestamp: Date.now(),
      data: {
        message: { from, to, content, messageType },
      },
    });
  }

  planReview(agentId: string, planId: string, planContent: string): void {
    this.publish({
      type: 'swarm:agent:plan_review',
      timestamp: Date.now(),
      data: {
        agentId,
        plan: { id: planId, agentId, content: planContent, status: 'pending' },
      },
    });
  }

  planApproved(agentId: string, planId: string, feedback?: string): void {
    this.publish({
      type: 'swarm:agent:plan_approved',
      timestamp: Date.now(),
      data: {
        agentId,
        plan: { id: planId, agentId, content: '', status: 'approved', feedback },
      },
    });
  }

  planRejected(agentId: string, planId: string, feedback: string): void {
    this.publish({
      type: 'swarm:agent:plan_rejected',
      timestamp: Date.now(),
      data: {
        agentId,
        plan: { id: planId, agentId, content: '', status: 'rejected', feedback },
      },
    });
  }

  userMessage(
    agentId: string,
    message: string,
    options: { sessionId?: string; runId?: string } = {},
  ): void {
    this.publish({
      type: 'swarm:user:message',
      runId: options.runId,
      sessionId: options.sessionId,
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
