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
import { initiateShutdown } from '../shutdownProtocol';
import type { DynamicAgentConfig } from './dynamicFactory';
import type { SwarmConfig } from './taskRouter';
import { getSwarmEventEmitter, type SwarmEventEmitter } from '../../ipc/swarm.ipc';
import { getTeammateService } from '../teammate/teammateService';
import { getTaskListManager } from '../taskList';
import { getAgentWorkerManager, type AgentWorkerManager } from '../worker/agentWorkerManager';
import { getPermissionProxy } from '../worker/permissionProxy';
import { TeammateProxy } from '../worker/teammateProxy';
import { WorkerMonitor } from '../worker/workerMonitor';
import { getVerifierRegistry, initializeVerifiers } from '../verifier';
import type { VerificationResult } from '../verifier/verifierRegistry';
import { analyzeTask } from './taskRouter';
import type { SwarmVerificationResult } from '../../../shared/types/swarm';

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
  /** Verification result (if verifier is available) */
  verification?: SwarmVerificationResult;
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
/**
 * 扩展 Swarm 配置：进程隔离选项
 */
export interface ExtendedSwarmConfig extends SwarmConfig {
  /** 是否启用进程隔离（默认 true） */
  processIsolation?: boolean;
  /** 最大 worker 进程数（默认 4） */
  maxWorkers?: number;
  /** 单个 worker 超时（ms，默认 300000） */
  workerTimeout?: number;
}

export class AgentSwarm {
  private coordinator = new SwarmCoordinator();
  private lockManager = new ResourceLockManager();
  private runtimes: Map<string, AgentRuntime> = new Map();
  private agentAbortControllers: Map<string, AbortController> = new Map();
  private config: ExtendedSwarmConfig | null = null;
  private cancelled = false;
  private eventEmitter: SwarmEventEmitter;

  // Phase 2: 进程隔离组件
  private workerManager: AgentWorkerManager | null = null;
  private teammateProxy: TeammateProxy | null = null;
  private workerMonitor: WorkerMonitor | null = null;

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
    config: SwarmConfig | ExtendedSwarmConfig,
    executor: AgentExecutor
  ): Promise<SwarmResult> {
    const startTime = Date.now();
    this.config = config as ExtendedSwarmConfig;
    this.cancelled = false;

    const useProcessIsolation = (config as ExtendedSwarmConfig).processIsolation ?? false;

    logger.info('Starting Agent Swarm', {
      agentCount: agents.length,
      maxAgents: config.maxAgents,
      reportingMode: config.reportingMode,
      processIsolation: useProcessIsolation,
    });

    // 发送 swarm 开始事件
    this.eventEmitter.started(agents.length);

    // 初始化运行时状态
    this.initializeRuntimes(agents);

    // === TaskList Integration: 写入任务列表 ===
    const taskListManager = getTaskListManager();
    for (const agent of agents) {
      taskListManager.createTask({
        subject: agent.name,
        description: agent.prompt || `Execute ${agent.name}`,
        assignee: agent.name,
        priority: agent.dependencies.length === 0 ? 1 : 3,
        dependencies: agent.dependencies,
      });
    }

    // === Phase 2: 进程隔离初始化 ===
    if (useProcessIsolation) {
      this.workerManager = getAgentWorkerManager({
        processIsolation: true,
        maxWorkers: (config as ExtendedSwarmConfig).maxWorkers ?? 4,
        workerTimeout: (config as ExtendedSwarmConfig).workerTimeout ?? 300000,
      });
      this.teammateProxy = new TeammateProxy(this.workerManager);
      this.workerMonitor = new WorkerMonitor(this.workerManager);

      // 设置工具调用代理和权限代理
      const permissionProxy = getPermissionProxy();
      this.workerManager.setToolCallHandler(async (workerId: string, tool: string, args: unknown) => {
        const approved = await permissionProxy.checkPermission(workerId, tool, args);
        if (!approved) throw new Error(`Permission denied: ${tool}`);
        // 在主进程中执行工具（通过 executor）
        return executor.execute(
          agents[0], // 使用第一个 agent 配置作为代理
          (report) => this.coordinator.receive(report)
        );
      });
      this.workerManager.setPermissionHandler(async (workerId: string, tool: string, args: unknown) => {
        return permissionProxy.checkPermission(workerId, tool, args);
      });

      logger.info('[AgentSwarm] Process isolation enabled, worker manager initialized');
    }

    // Agent Teams: 注册到 TeammateService（如果启用 P2P 通信）
    if (config.enablePeerCommunication) {
      const teammateService = getTeammateService();
      for (const agent of agents) {
        teammateService.register(agent.id, agent.name, 'swarm-agent');
        teammateService.updateStatus(agent.id, 'waiting');
      }
      logger.info('[AgentSwarm] Peer communication enabled, agents registered to TeammateService');
    }

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

    // === 验证步骤：对聚合结果运行确定性检查 ===
    let verification: SwarmVerificationResult | undefined;
    try {
      initializeVerifiers();
      const verifierRegistry = getVerifierRegistry();
      // 从第一个 agent 的 prompt 推断任务类型
      const firstPrompt = agents[0]?.prompt || '';
      const taskAnalysis = analyzeTask(firstPrompt);
      const verificationResult = await verifierRegistry.verifyTask({
        taskDescription: firstPrompt,
        taskAnalysis,
        agentOutput: aggregatedOutput,
        workingDirectory: process.cwd(),
        modifiedFiles: [],
      }, taskAnalysis);

      verification = {
        passed: verificationResult.passed,
        score: verificationResult.score,
        checks: verificationResult.checks.map(c => ({
          name: c.name,
          passed: c.passed,
          score: c.score,
          message: c.message,
        })),
        suggestions: verificationResult.suggestions,
        taskType: verificationResult.taskType,
        durationMs: verificationResult.durationMs,
      };

      logger.info('Swarm verification result', {
        passed: verification.passed,
        score: verification.score.toFixed(2),
      });
    } catch (err) {
      logger.warn('Swarm verification failed (non-blocking):', err);
    }

    // 清理
    this.cleanup();

    const result: SwarmResult = {
      success: statistics.failed === 0,
      agents: runtimeList,
      aggregatedOutput,
      totalTime: Date.now() - startTime,
      statistics,
      verification,
    };

    // === P2: 记录 agent 性能画像 ===
    try {
      const { getAgentProfiler } = await import('../profiling/agentProfiler');
      const profiler = getAgentProfiler();
      for (const runtime of runtimeList) {
        if (runtime.status === 'completed' || runtime.status === 'failed') {
          profiler.recordOutcome({
            agentId: runtime.agent.id,
            agentName: runtime.agent.name,
            taskType: analyzeTask(runtime.agent.prompt || '').taskType,
            success: runtime.status === 'completed',
            verificationScore: verification?.score ?? (runtime.status === 'completed' ? 0.8 : 0),
            durationMs: (runtime.endTime || Date.now()) - (runtime.startTime || Date.now()),
            costUSD: 0, // TODO: actual cost tracking
            timestamp: Date.now(),
          });
        }
      }
    } catch {
      // Profiler not available
    }

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

    // === TaskList Integration: 标记开始执行 ===
    const taskListManager = getTaskListManager();
    const tasks = taskListManager.getTasks();
    const matchingTask = tasks.find(t => t.subject === runtime.agent.name);
    if (matchingTask) {
      taskListManager.startExecution(matchingTask.id);
    }

    try {
      let result: { success: boolean; output: string; error?: string };

      // === Phase 2: 进程隔离执行 ===
      if (this.workerManager && (this.config as ExtendedSwarmConfig)?.processIsolation) {
        // 通过 worker 子进程执行
        const workerId = await this.workerManager.spawn({
          role: runtime.agent.name,
          taskId: runtime.agent.id,
          modelConfig: {} as any, // 从 agent config 获取
          systemPrompt: runtime.agent.prompt || '',
          task: runtime.agent.prompt || 'Execute task',
          allowedTools: runtime.agent.tools?.length ? runtime.agent.tools : (() => {
            logger.warn(`[AgentSwarm] Agent "${runtime.agent.name}" has no tools defined, falling back to basic tools`);
            return ['read_file', 'glob', 'grep', 'list_directory'];
          })(),
          workingDirectory: process.cwd(),
          timeout: (this.config as ExtendedSwarmConfig)?.workerTimeout ?? 300000,
          maxIterations: runtime.agent.maxIterations || 20,
        });

        // 监控 worker
        if (this.workerMonitor) {
          this.workerMonitor.startMonitoring(workerId);
        }

        // 投递排队消息
        if (this.teammateProxy) {
          this.teammateProxy.flushQueue(workerId);
        }

        // 等待 worker 完成
        result = await new Promise<{ success: boolean; output: string; error?: string }>((resolve) => {
          const onEvent = (event: any) => {
            if (event.workerId !== workerId) return;
            if (event.type === 'worker_completed') {
              this.workerManager!.removeListener('event', onEvent);
              resolve({ success: true, output: event.result || '' });
            } else if (event.type === 'worker_failed') {
              this.workerManager!.removeListener('event', onEvent);
              resolve({ success: false, output: '', error: event.error });
            }
          };
          this.workerManager!.on('event', onEvent);
        });

        // 停止监控
        if (this.workerMonitor) {
          this.workerMonitor.stopMonitoring(workerId);
        }
      } else {
        // 原有同进程执行方式
        result = await executor.execute(
          runtime.agent,
          (report) => this.handleAgentReport(runtime, report)
        );
      }

      runtime.status = result.success ? 'completed' : 'failed';
      runtime.output = result.output;
      runtime.error = result.error;

      // 汇报完成/失败
      this.report(runtime, result.success ? 'completed' : 'failed', {
        status: runtime.status,
        output: result.output,
        error: result.error,
      });

      // === TaskList Integration: 同步完成/失败状态 ===
      if (matchingTask) {
        if (result.success) {
          taskListManager.completeExecution(matchingTask.id, result.output || 'Completed');
        } else {
          taskListManager.failExecution(matchingTask.id, result.error || 'Unknown error');
        }
      }

      // 发送 agent 完成/失败事件
      if (result.success) {
        this.eventEmitter.agentCompleted(runtime.agent.id, result.output);

        // Agent Teams: 广播完成通知给其他 agent
        if (this.config?.enablePeerCommunication) {
          try {
            const teammateService = getTeammateService();
            teammateService.updateStatus(runtime.agent.id, 'idle');
            teammateService.send({
              from: runtime.agent.id,
              to: 'all',
              type: 'broadcast',
              content: `[完成] ${runtime.agent.name} 已完成任务。输出摘要: ${(result.output || '').slice(0, 200)}`,
            });
          } catch (err) {
            logger.warn('[AgentSwarm] Failed to broadcast completion via TeammateService:', err);
          }
        }
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
   * 取消剩余的 Agent（含优雅关闭 running agents）
   */
  private cancelRemaining(): void {
    for (const runtime of this.runtimes.values()) {
      if (['pending', 'ready'].includes(runtime.status)) {
        runtime.status = 'cancelled';
        this.report(runtime, 'failed', { status: 'cancelled', error: 'Cancelled' });
      }
    }
    // Abort running agents via their AbortControllers
    for (const [agentId, controller] of this.agentAbortControllers) {
      if (!controller.signal.aborted) {
        logger.info(`[AgentSwarm] Aborting running agent: ${agentId}`);
        controller.abort('swarm_cancelled');
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
    // Agent Teams: 注销 agents
    if (this.config?.enablePeerCommunication) {
      try {
        const teammateService = getTeammateService();
        for (const runtime of this.runtimes.values()) {
          teammateService.unregister(runtime.agent.id);
        }
      } catch (err) {
        logger.warn('[AgentSwarm] Failed to unregister agents from TeammateService:', err);
      }
    }

    // Phase 2: 清理 worker 资源
    if (this.workerMonitor) {
      this.workerMonitor.stopAll();
      this.workerMonitor = null;
    }
    if (this.workerManager) {
      this.workerManager.terminateAll('Swarm cleanup').catch((err: unknown) => {
        logger.warn('[AgentSwarm] Failed to terminate workers:', err);
      });
      this.workerManager = null;
    }
    if (this.teammateProxy) {
      this.teammateProxy.reset();
      this.teammateProxy = null;
    }

    this.runtimes.clear();
    this.agentAbortControllers.clear();
    this.lockManager.reset();
  }

  // ==========================================================================
  // Optimistic Execution Mode
  // ==========================================================================

  /**
   * 乐观并发执行模式
   *
   * 工作 Agent 从任务池自选任务（而非 DAG 预排），锁过期自动释放。
   * 适合松耦合任务场景。
   *
   * @param tasks - 任务列表（每个任务变成一个虚拟 agent）
   * @param config - Swarm 配置
   * @param executor - Agent 执行器
   * @param workerCount - 并发 worker 数量（默认 config.maxAgents）
   */
  async executeOptimistic(
    tasks: Array<{ id: string; name: string; prompt: string; tools: string[]; tags?: string[] }>,
    config: SwarmConfig,
    executor: AgentExecutor,
    workerCount?: number
  ): Promise<SwarmResult> {
    const { getTaskClaimService } = await import('./taskClaimService');
    const startTime = Date.now();
    this.config = config as ExtendedSwarmConfig;
    this.cancelled = false;

    const claimService = getTaskClaimService();
    claimService.reset();
    claimService.addTasks(tasks.map(t => ({
      id: t.id,
      description: t.prompt,
      tags: t.tags || [],
      priority: 1,
      createdAt: Date.now(),
    })));

    const workers = workerCount ?? config.maxAgents;
    const results: AgentRuntime[] = [];
    let parallelPeak = 0;

    logger.info('[AgentSwarm] Starting optimistic execution', {
      taskCount: tasks.length,
      workerCount: workers,
    });

    this.eventEmitter.started(tasks.length);

    // Worker loop: claim → execute → claim until no tasks left
    const workerLoop = async (workerId: string) => {
      while (!this.cancelled) {
        const claimed = claimService.claimNext(workerId);
        if (!claimed) break; // No more tasks

        const taskDef = tasks.find(t => t.id === claimed.id);
        if (!taskDef) {
          claimService.complete(claimed.id, workerId, '');
          continue;
        }

        const agent: DynamicAgentConfig = {
          id: taskDef.id,
          name: taskDef.name,
          prompt: taskDef.prompt,
          tools: taskDef.tools,
          model: { provider: 'moonshot' as any, model: 'kimi-k2.5' },
          maxIterations: 20,
          timeout: 300000,
          parentTaskId: `swarm-${Date.now()}`,
          parallelizable: true,
          dependencies: [],
          ttl: 'task',
          spec: { name: taskDef.name, responsibility: taskDef.prompt, tools: taskDef.tools, parallelizable: true },
        };

        const runtime: AgentRuntime = {
          agent,
          status: 'running',
          startTime: Date.now(),
          iterations: 0,
          reports: [],
        };

        this.eventEmitter.agentAdded({ id: agent.id, name: agent.name, role: 'worker' });
        this.eventEmitter.agentUpdated(agent.id, { status: 'running', startTime: runtime.startTime, iterations: 0 });

        try {
          const result = await executor.execute(agent, (report) => {
            runtime.reports.push(report);
            runtime.iterations++;
          });
          runtime.status = result.success ? 'completed' : 'failed';
          runtime.output = result.output;
          runtime.error = result.error;
          runtime.endTime = Date.now();

          if (result.success) {
            claimService.complete(claimed.id, workerId, result.output || '');
            this.eventEmitter.agentCompleted(agent.id, result.output);
          } else {
            claimService.fail(claimed.id, workerId, result.error || 'Unknown error');
            this.eventEmitter.agentFailed(agent.id, result.error || 'Unknown error');
          }
        } catch (err) {
          runtime.status = 'failed';
          runtime.error = err instanceof Error ? err.message : String(err);
          runtime.endTime = Date.now();
          claimService.fail(claimed.id, workerId, runtime.error);
          this.eventEmitter.agentFailed(agent.id, runtime.error);
        }

        results.push(runtime);
      }
    };

    // Launch workers in parallel
    const workerPromises = Array.from({ length: workers }, (_, i) =>
      workerLoop(`worker-${i}`)
    );

    // Track parallel peak
    const peakInterval = setInterval(() => {
      const running = results.filter(r => r.status === 'running').length;
      parallelPeak = Math.max(parallelPeak, running);
    }, 100);

    await Promise.all(workerPromises);
    clearInterval(peakInterval);

    const statistics = this.calculateStatistics(results, parallelPeak);
    const aggregatedOutput = results
      .filter(r => r.status === 'completed' && r.output)
      .map(r => `## ${r.agent.name}\n\n${r.output}`)
      .join('\n\n');

    this.eventEmitter.completed({
      total: statistics.total,
      completed: statistics.completed,
      failed: statistics.failed,
      parallelPeak: statistics.parallelPeak,
      totalTime: Date.now() - startTime,
    });

    return {
      success: statistics.failed === 0,
      agents: results,
      aggregatedOutput,
      totalTime: Date.now() - startTime,
      statistics,
    };
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
