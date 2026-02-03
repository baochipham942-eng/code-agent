// ============================================================================
// Agent Swarm - 并行 Agent 执行引擎
// ============================================================================
//
// 核心特性：
// 1. 并行执行：最多 50 个 Agent 同时运行
// 2. 稀疏汇报：仅在关键节点向协调器汇报
// 3. 依赖管理：基于 DAG 的任务调度
// 4. 冲突检测：资源锁 + 协调器聚合
//
// 参考：
// - Kimi Agent Swarm 的稀疏汇报协议
// - DynTaskMAS 的并行执行引擎
// - TDAG 的动态依赖调整
// ============================================================================

import { createLogger } from '../../services/infra/logger';
import type { DynamicAgentConfig } from './dynamicFactory';
import type { SwarmConfig } from './taskRouter';
import { getSwarmEventEmitter, type SwarmEventEmitter } from '../../ipc/swarm.ipc';

const logger = createLogger('AgentSwarm');

// ============================================================================
// Types
// ============================================================================

// Import and re-export AgentStatus from shared types
import type { AgentStatus } from '../../../shared/types/swarm';
export type { AgentStatus };

/**
 * 汇报类型
 */
export type ReportType =
  | 'started'      // 开始执行
  | 'progress'     // 进度更新（仅 full 模式）
  | 'completed'    // 完成
  | 'failed'       // 失败
  | 'conflict'     // 检测到冲突
  | 'resource';    // 需要资源

/**
 * Agent 汇报
 */
export interface AgentReport {
  agentId: string;
  agentName: string;
  type: ReportType;
  timestamp: number;
  data: {
    status?: AgentStatus;
    output?: string;
    error?: string;
    progress?: number;
    resourceNeeded?: string;
    conflictWith?: string;
  };
}

/**
 * Agent 运行时状态
 */
export interface AgentRuntime {
  agent: DynamicAgentConfig;
  status: AgentStatus;
  startTime?: number;
  endTime?: number;
  output?: string;
  error?: string;
  iterations: number;
  reports: AgentReport[];
}

/**
 * Swarm 执行结果
 */
export interface SwarmResult {
  success: boolean;
  agents: AgentRuntime[];
  aggregatedOutput: string;
  totalTime: number;
  statistics: {
    total: number;
    completed: number;
    failed: number;
    cancelled: number;
    parallelPeak: number;
    totalIterations: number;
  };
}

/**
 * Agent 执行器接口
 */
export interface AgentExecutor {
  execute(
    agent: DynamicAgentConfig,
    onReport: (report: AgentReport) => void
  ): Promise<{ success: boolean; output: string; error?: string }>;
}

// ============================================================================
// Coordinator
// ============================================================================

/**
 * Swarm 协调器
 *
 * 负责：
 * 1. 收集所有 Agent 的汇报
 * 2. 检测冲突
 * 3. 聚合结果
 */
class SwarmCoordinator {
  private reports: AgentReport[] = [];
  private conflicts: Array<{ agentA: string; agentB: string; resource: string }> = [];

  /**
   * 接收汇报
   */
  receive(report: AgentReport): void {
    this.reports.push(report);

    // 检测冲突
    if (report.type === 'conflict' && report.data.conflictWith) {
      this.conflicts.push({
        agentA: report.agentId,
        agentB: report.data.conflictWith,
        resource: report.data.resourceNeeded || 'unknown',
      });
    }

    logger.debug('Coordinator received report', {
      agentId: report.agentId,
      type: report.type,
      status: report.data.status,
    });
  }

  /**
   * 获取冲突列表
   */
  getConflicts() {
    return this.conflicts;
  }

  /**
   * 聚合结果
   */
  aggregate(runtimes: AgentRuntime[]): string {
    const outputs: string[] = [];

    // 按完成顺序排序
    const sorted = [...runtimes]
      .filter(r => r.status === 'completed' && r.output)
      .sort((a, b) => (a.endTime || 0) - (b.endTime || 0));

    for (const runtime of sorted) {
      outputs.push(`## ${runtime.agent.name}\n\n${runtime.output}`);
    }

    // 添加失败信息
    const failed = runtimes.filter(r => r.status === 'failed');
    if (failed.length > 0) {
      outputs.push('\n## Failed Agents\n');
      for (const runtime of failed) {
        outputs.push(`- ${runtime.agent.name}: ${runtime.error || 'Unknown error'}`);
      }
    }

    return outputs.join('\n\n');
  }

  /**
   * 重置
   */
  reset(): void {
    this.reports = [];
    this.conflicts = [];
  }
}

// ============================================================================
// Resource Lock
// ============================================================================

/**
 * 资源锁管理器
 */
class ResourceLockManager {
  private locks: Map<string, { owner: string; timestamp: number }> = new Map();

  /**
   * 尝试获取锁
   */
  acquire(resource: string, agentId: string, timeout = 30000): boolean {
    const existing = this.locks.get(resource);

    // 检查是否已被锁定
    if (existing) {
      // 检查是否超时
      if (Date.now() - existing.timestamp > timeout) {
        logger.warn('Lock timeout, forcing release', { resource, previousOwner: existing.owner });
        this.locks.delete(resource);
      } else {
        return false;
      }
    }

    this.locks.set(resource, { owner: agentId, timestamp: Date.now() });
    return true;
  }

  /**
   * 释放锁
   */
  release(resource: string, agentId: string): boolean {
    const lock = this.locks.get(resource);
    if (lock && lock.owner === agentId) {
      this.locks.delete(resource);
      return true;
    }
    return false;
  }

  /**
   * 释放 Agent 的所有锁
   */
  releaseAll(agentId: string): void {
    for (const [resource, lock] of this.locks) {
      if (lock.owner === agentId) {
        this.locks.delete(resource);
      }
    }
  }

  /**
   * 重置所有锁
   */
  reset(): void {
    this.locks.clear();
  }
}

// ============================================================================
// Agent Swarm
// ============================================================================

/**
 * Agent Swarm 执行引擎
 *
 * 管理多个 Agent 的并行执行，支持依赖管理和冲突检测。
 */
export class AgentSwarm {
  private coordinator = new SwarmCoordinator();
  private lockManager = new ResourceLockManager();
  private runtimes: Map<string, AgentRuntime> = new Map();
  private config: SwarmConfig | null = null;
  private cancelled = false;
  private eventEmitter: SwarmEventEmitter;

  constructor() {
    this.eventEmitter = getSwarmEventEmitter();
  }

  /**
   * 执行 Agent Swarm
   *
   * @param agents - Agent 配置列表
   * @param config - Swarm 配置
   * @param executor - Agent 执行器
   * @returns 执行结果
   */
  async execute(
    agents: DynamicAgentConfig[],
    config: SwarmConfig,
    executor: AgentExecutor
  ): Promise<SwarmResult> {
    const startTime = Date.now();
    this.config = config;
    this.cancelled = false;

    logger.info('Starting Agent Swarm', {
      agentCount: agents.length,
      maxAgents: config.maxAgents,
      reportingMode: config.reportingMode,
    });

    // 发送 swarm 开始事件
    this.eventEmitter.started(agents.length);

    // 初始化运行时状态
    this.initializeRuntimes(agents);

    // 通知每个 agent 被添加
    for (const agent of agents) {
      this.eventEmitter.agentAdded({
        id: agent.id,
        name: agent.name,
        role: 'dynamic',  // DynamicAgentConfig 没有 role 字段
      });
    }

    // 执行调度循环
    let parallelPeak = 0;

    while (!this.isComplete() && !this.cancelled) {
      // 获取可执行的 Agent
      const readyAgents = this.getReadyAgents();

      // 限制并行数
      const toExecute = readyAgents.slice(0, config.maxAgents - this.getRunningCount());

      parallelPeak = Math.max(parallelPeak, this.getRunningCount() + toExecute.length);

      // 启动执行
      const executions = toExecute.map(runtime =>
        this.executeAgent(runtime, executor)
      );

      // 等待任意一个完成（或全部完成）
      if (executions.length > 0) {
        await Promise.race([
          Promise.all(executions),
          this.waitForTimeout(5000),  // 5 秒检查一次
        ]);
      } else {
        // 没有可执行的 Agent，等待一下
        await this.waitForTimeout(100);
      }

      // 检查超时
      if (Date.now() - startTime > config.timeout) {
        logger.warn('Swarm timeout, cancelling remaining agents');
        this.cancelRemaining();
        break;
      }
    }

    // 收集结果
    const runtimeList = Array.from(this.runtimes.values());
    const statistics = this.calculateStatistics(runtimeList, parallelPeak);
    const aggregatedOutput = this.coordinator.aggregate(runtimeList);

    // 清理
    this.cleanup();

    const result: SwarmResult = {
      success: statistics.failed === 0,
      agents: runtimeList,
      aggregatedOutput,
      totalTime: Date.now() - startTime,
      statistics,
    };

    logger.info('Agent Swarm completed', {
      success: result.success,
      totalTime: result.totalTime,
      statistics,
    });

    // 发送 swarm 完成事件
    this.eventEmitter.completed({
      total: statistics.total,
      completed: statistics.completed,
      failed: statistics.failed,
      parallelPeak: statistics.parallelPeak,
      totalTime: result.totalTime,
    });

    return result;
  }

  /**
   * 取消执行
   */
  cancel(): void {
    this.cancelled = true;
    this.cancelRemaining();
    this.eventEmitter.cancelled();
  }

  /**
   * 初始化运行时状态
   */
  private initializeRuntimes(agents: DynamicAgentConfig[]): void {
    this.runtimes.clear();
    this.coordinator.reset();
    this.lockManager.reset();

    for (const agent of agents) {
      const status: AgentStatus = agent.dependencies.length === 0 ? 'ready' : 'pending';
      this.runtimes.set(agent.id, {
        agent,
        status,
        iterations: 0,
        reports: [],
      });
    }
  }

  /**
   * 执行单个 Agent
   */
  private async executeAgent(
    runtime: AgentRuntime,
    executor: AgentExecutor
  ): Promise<void> {
    runtime.status = 'running';
    runtime.startTime = Date.now();

    // 汇报开始
    this.report(runtime, 'started', { status: 'running' });

    // 发送 agent 更新事件 (running)
    this.eventEmitter.agentUpdated(runtime.agent.id, {
      status: 'running',
      startTime: runtime.startTime,
      iterations: runtime.iterations,
    });

    try {
      const result = await executor.execute(
        runtime.agent,
        (report) => this.handleAgentReport(runtime, report)
      );

      runtime.status = result.success ? 'completed' : 'failed';
      runtime.output = result.output;
      runtime.error = result.error;

      // 汇报完成/失败
      this.report(runtime, result.success ? 'completed' : 'failed', {
        status: runtime.status,
        output: result.output,
        error: result.error,
      });

      // 发送 agent 完成/失败事件
      if (result.success) {
        this.eventEmitter.agentCompleted(runtime.agent.id, result.output);
      } else {
        this.eventEmitter.agentFailed(runtime.agent.id, result.error || 'Unknown error');
      }

    } catch (error) {
      runtime.status = 'failed';
      runtime.error = error instanceof Error ? error.message : String(error);

      this.report(runtime, 'failed', {
        status: 'failed',
        error: runtime.error,
      });

      // 发送 agent 失败事件
      this.eventEmitter.agentFailed(runtime.agent.id, runtime.error);
    }

    runtime.endTime = Date.now();

    // 释放锁
    this.lockManager.releaseAll(runtime.agent.id);

    // 更新依赖此 Agent 的其他 Agent
    this.updateDependents(runtime);
  }

  /**
   * 处理 Agent 汇报
   */
  private handleAgentReport(runtime: AgentRuntime, report: AgentReport): void {
    runtime.reports.push(report);
    runtime.iterations++;

    // 稀疏模式下只转发关键汇报
    if (this.config?.reportingMode === 'sparse') {
      if (['started', 'completed', 'failed', 'conflict', 'resource'].includes(report.type)) {
        this.coordinator.receive(report);
      }
    } else {
      this.coordinator.receive(report);
    }
  }

  /**
   * 发送汇报
   */
  private report(runtime: AgentRuntime, type: ReportType, data: AgentReport['data']): void {
    const report: AgentReport = {
      agentId: runtime.agent.id,
      agentName: runtime.agent.name,
      type,
      timestamp: Date.now(),
      data,
    };

    this.handleAgentReport(runtime, report);
  }

  /**
   * 更新依赖的 Agent
   */
  private updateDependents(completed: AgentRuntime): void {
    for (const [_, runtime] of this.runtimes) {
      if (runtime.status === 'pending') {
        // 移除已完成的依赖
        const deps = runtime.agent.dependencies.filter(
          dep => {
            const depRuntime = this.runtimes.get(dep);
            return depRuntime && depRuntime.status !== 'completed';
          }
        );

        // 如果所有依赖都完成，标记为 ready
        if (deps.length === 0) {
          runtime.status = 'ready';
          logger.debug('Agent ready after dependency completion', {
            agentId: runtime.agent.id,
            completedDep: completed.agent.id,
          });
        }
      }
    }
  }

  /**
   * 获取可执行的 Agent
   */
  private getReadyAgents(): AgentRuntime[] {
    return Array.from(this.runtimes.values())
      .filter(r => r.status === 'ready');
  }

  /**
   * 获取正在运行的 Agent 数量
   */
  private getRunningCount(): number {
    return Array.from(this.runtimes.values())
      .filter(r => r.status === 'running').length;
  }

  /**
   * 检查是否全部完成
   */
  private isComplete(): boolean {
    for (const runtime of this.runtimes.values()) {
      if (['pending', 'ready', 'running'].includes(runtime.status)) {
        return false;
      }
    }
    return true;
  }

  /**
   * 取消剩余的 Agent
   */
  private cancelRemaining(): void {
    for (const runtime of this.runtimes.values()) {
      if (['pending', 'ready'].includes(runtime.status)) {
        runtime.status = 'cancelled';
        this.report(runtime, 'failed', { status: 'cancelled', error: 'Cancelled' });
      }
    }
  }

  /**
   * 等待超时
   */
  private waitForTimeout(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * 计算统计信息
   */
  private calculateStatistics(
    runtimes: AgentRuntime[],
    parallelPeak: number
  ): SwarmResult['statistics'] {
    let completed = 0;
    let failed = 0;
    let cancelled = 0;
    let totalIterations = 0;

    for (const runtime of runtimes) {
      if (runtime.status === 'completed') completed++;
      if (runtime.status === 'failed') failed++;
      if (runtime.status === 'cancelled') cancelled++;
      totalIterations += runtime.iterations;
    }

    return {
      total: runtimes.length,
      completed,
      failed,
      cancelled,
      parallelPeak,
      totalIterations,
    };
  }

  /**
   * 清理
   */
  private cleanup(): void {
    this.runtimes.clear();
    this.lockManager.reset();
  }
}

// ============================================================================
// Singleton
// ============================================================================

let swarmInstance: AgentSwarm | null = null;

export function getAgentSwarm(): AgentSwarm {
  if (!swarmInstance) {
    swarmInstance = new AgentSwarm();
  }
  return swarmInstance;
}
