// ============================================================================
// Auto Agent Coordinator - 协调自动生成的多 Agent 执行
//
// ## 通信级别 (Communication Levels)
//
// 借鉴 Hermes Agent L0-L3 模型，显式定义 agent 间通信层级：
//
// | Level | Name            | 机制                           | 本项目实现                              |
// |-------|-----------------|-------------------------------|-----------------------------------------|
// | L0    | Isolated        | 完全隔离，父 agent 手动中继    | executeAgent() 无 previousOutput         |
// | L1    | Result Passing  | 上游输出自动注入下游 context   | executeSequential() 的 previousOutput    |
// | L2    | Shared Context  | 共享读写存储（coordinator 中转）| ParallelAgentCoordinator.SharedContext   |
// | L3    | Live Dialogue   | Agent 间 turn-based 对话       | 未实现（P2 交叉验证是简化版）            |
//
// 当前默认：sequential → L1, parallel → L0 + L2(可选)
//
// ## 节点级 Checkpoint（断点恢复）
//
// 长程多 agent 执行中，网络中断/token 耗尽会导致已完成节点工作白费。
// 每个节点完成后持久化结果，重新执行时自动跳过已完成节点。
//
// - 存储: ~/.code-agent/coordination-checkpoints/<sessionId>.json
// - 粒度: Agent 节点级（仅 completed 状态持久化，failed 不缓存以支持重试）
// - 清理: 全部成功后自动删除 checkpoint 文件
// ============================================================================

import * as fs from 'fs';
import * as path from 'path';
import { createLogger } from '../services/infra/logger';
import { getSubagentExecutor, type SubagentResult } from './subagentExecutor';
import { getSessionStateManager } from '../session/sessionStateManager';
import { getResourceLockManager } from './resourceLockManager';
import { createProgressAggregator, type ProgressAggregator } from './progressAggregator';
import { createParallelErrorHandler, type ParallelErrorHandler } from './parallelErrorHandler';
import type { DynamicAgentDefinition } from './dynamicAgentFactory';
import type { AgentRequirements, ExecutionStrategy } from './agentRequirementsAnalyzer';
import type { ModelConfig } from '../../shared/contract';
import type { ToolContext } from '../tools/types';
import type { ToolResolver } from '../protocol/dispatch/toolResolver';
import { getUserConfigDir } from '../config/configPaths';

const logger = createLogger('AutoAgentCoordinator');

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

/**
 * Agent 执行状态
 */
export type AgentExecutionStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

/**
 * 单个 Agent 的执行结果
 */
export interface AgentExecutionResult {
  agentId: string;
  agentName: string;
  status: AgentExecutionStatus;
  result?: SubagentResult;
  error?: string;
  startedAt: number;
  completedAt?: number;
  duration?: number;
}

/**
 * 协调执行的总体结果
 */
export interface CoordinationResult {
  success: boolean;
  strategy: ExecutionStrategy;
  results: AgentExecutionResult[];
  aggregatedOutput: string;
  totalDuration: number;
  totalIterations: number;
  totalCost: number;
  errors: string[];
}

/**
 * 协调器上下文
 */
export interface CoordinatorContext {
  sessionId: string;
  modelConfig: ModelConfig;
  toolResolver: ToolResolver;
  toolContext: ToolContext;
  onProgress?: (agentId: string, status: AgentExecutionStatus, progress?: number) => void;
}

// ----------------------------------------------------------------------------
// Node Checkpoint
// ----------------------------------------------------------------------------

const CHECKPOINT_DIR = 'coordination-checkpoints';

interface ExecutionCheckpoint {
  sessionId: string;
  agentIds: string[];
  completedNodes: Record<string, AgentExecutionResult>;
  createdAt: number;
  updatedAt: number;
}

function getCheckpointPath(sessionId: string): string {
  return path.join(getUserConfigDir(), CHECKPOINT_DIR, `${sessionId}.json`);
}

function loadCheckpoint(sessionId: string, expectedAgentIds: string[]): ExecutionCheckpoint | null {
  const filePath = getCheckpointPath(sessionId);
  try {
    if (!fs.existsSync(filePath)) return null;
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as ExecutionCheckpoint;
    // Verify agent IDs match (same execution plan)
    const match = data.agentIds.length === expectedAgentIds.length
      && data.agentIds.every((id, i) => id === expectedAgentIds[i]);
    if (!match) {
      logger.info('Checkpoint agent IDs mismatch, starting fresh');
      deleteCheckpoint(sessionId);
      return null;
    }
    logger.info(`Loaded checkpoint: ${Object.keys(data.completedNodes).length}/${expectedAgentIds.length} nodes completed`);
    return data;
  } catch {
    return null;
  }
}

function saveCheckpoint(checkpoint: ExecutionCheckpoint): void {
  const filePath = getCheckpointPath(checkpoint.sessionId);
  const dir = path.dirname(filePath);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(checkpoint, null, 2));
  } catch (error) {
    logger.warn('Failed to save checkpoint', { error });
  }
}

function deleteCheckpoint(sessionId: string): void {
  try {
    const filePath = getCheckpointPath(sessionId);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch { /* ignore cleanup errors */ }
}

function createCheckpoint(sessionId: string, agentIds: string[]): ExecutionCheckpoint {
  return {
    sessionId,
    agentIds,
    completedNodes: {},
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

// ----------------------------------------------------------------------------
// Auto Agent Coordinator
// ----------------------------------------------------------------------------

/**
 * 自动 Agent 协调器
 *
 * 负责执行自动生成的 Agent，支持：
 * - 顺序执行（L1 Result Passing）
 * - 并行执行（L0 Isolated + L2 Shared Context）
 * - 节点级 Checkpoint 断点恢复
 * - 进度跟踪
 * - 结果聚合
 */
export class AutoAgentCoordinator {
  private subagentExecutor = getSubagentExecutor();
  private sessionStateManager = getSessionStateManager();

  /**
   * 执行自动生成的 Agent
   */
  async execute(
    agents: DynamicAgentDefinition[],
    requirements: AgentRequirements,
    context: CoordinatorContext
  ): Promise<CoordinationResult> {
    const startTime = Date.now();
    const agentIds = agents.map(a => a.id);

    // 加载或创建 checkpoint
    const checkpoint = loadCheckpoint(context.sessionId, agentIds)
      ?? createCheckpoint(context.sessionId, agentIds);

    const resumedCount = Object.keys(checkpoint.completedNodes).length;

    logger.info('Starting auto agent coordination', {
      agentCount: agents.length,
      strategy: requirements.executionStrategy,
      sessionId: context.sessionId,
      resumedFromCheckpoint: resumedCount,
    });

    // 根据策略选择执行方式
    let results: AgentExecutionResult[];

    try {
      switch (requirements.executionStrategy) {
        case 'direct':
          results = await this.executeSequential(agents, context, checkpoint);
          break;

        case 'sequential':
          results = await this.executeSequential(agents, context, checkpoint);
          break;

        case 'parallel':
          results = await this.executeParallel(agents, context, checkpoint);
          break;

        default:
          results = await this.executeSequential(agents, context, checkpoint);
      }
    } catch (error) {
      logger.error('Coordination failed', error);
      return {
        success: false,
        strategy: requirements.executionStrategy,
        results: [],
        aggregatedOutput: '',
        totalDuration: Date.now() - startTime,
        totalIterations: 0,
        totalCost: 0,
        errors: [error instanceof Error ? error.message : 'Unknown error'],
      };
    }

    // 聚合结果
    const aggregated = this.aggregateResults(results, requirements);
    const totalDuration = Date.now() - startTime;

    // 全部成功时清理 checkpoint
    if (aggregated.success) {
      deleteCheckpoint(context.sessionId);
    }

    logger.info('Auto agent coordination completed', {
      success: aggregated.success,
      agentCount: results.length,
      totalDuration,
      checkpointCleaned: aggregated.success,
    });

    return {
      ...aggregated,
      strategy: requirements.executionStrategy,
      totalDuration,
    };
  }

  /**
   * 顺序执行 Agent (L1 Result Passing)
   */
  private async executeSequential(
    agents: DynamicAgentDefinition[],
    context: CoordinatorContext,
    checkpoint: ExecutionCheckpoint
  ): Promise<AgentExecutionResult[]> {
    const results: AgentExecutionResult[] = [];
    let previousOutput = '';

    for (const agent of agents) {
      // Checkpoint: 跳过已完成节点
      const cached = checkpoint.completedNodes[agent.id];
      if (cached && cached.status === 'completed') {
        logger.info(`Checkpoint hit, skipping agent: ${agent.name} (${agent.id})`);
        results.push(cached);
        if (cached.result?.output) {
          previousOutput = cached.result.output;
        }
        context.onProgress?.(agent.id, 'completed');
        continue;
      }

      // 更新会话状态
      this.sessionStateManager.addSubagent(context.sessionId, {
        id: agent.id,
        name: agent.name,
        status: 'running',
        startedAt: Date.now(),
      });

      context.onProgress?.(agent.id, 'running');

      const result = await this.executeAgent(agent, context, previousOutput);
      results.push(result);

      // 更新子代理状态
      this.sessionStateManager.updateSubagent(context.sessionId, agent.id, {
        status: result.status === 'completed' ? 'completed' : 'failed',
        completedAt: Date.now(),
        error: result.error,
      });

      context.onProgress?.(agent.id, result.status);

      // Checkpoint: 成功节点持久化（failed 不缓存，支持重试）
      if (result.status === 'completed') {
        checkpoint.completedNodes[agent.id] = result;
        checkpoint.updatedAt = Date.now();
        saveCheckpoint(checkpoint);
      }

      // 如果失败且是关键 agent，可以选择停止
      if (result.status === 'failed' && agent.priority === 1) {
        logger.warn('Primary agent failed, stopping sequential execution');
        break;
      }

      // 传递输出给下一个 agent (L1 Result Passing)
      if (result.result?.output) {
        previousOutput = result.result.output;
      }
    }

    return results;
  }

  /**
   * 并行执行 Agent (L0 Isolated + L2 Shared Context 可选)
   */
  private async executeParallel(
    agents: DynamicAgentDefinition[],
    context: CoordinatorContext,
    checkpoint: ExecutionCheckpoint
  ): Promise<AgentExecutionResult[]> {
    // 分离主 agent 和可并行的辅助 agent
    const primaryAgents = agents.filter(a => !a.canRunParallel);
    const parallelAgents = agents.filter(a => a.canRunParallel);

    const results: AgentExecutionResult[] = [];

    // 先执行主 agent（顺序）
    for (const agent of primaryAgents) {
      // Checkpoint: 跳过已完成节点
      const cached = checkpoint.completedNodes[agent.id];
      if (cached && cached.status === 'completed') {
        logger.info(`Checkpoint hit, skipping primary agent: ${agent.name}`);
        results.push(cached);
        context.onProgress?.(agent.id, 'completed');
        continue;
      }

      this.sessionStateManager.addSubagent(context.sessionId, {
        id: agent.id,
        name: agent.name,
        status: 'running',
        startedAt: Date.now(),
      });

      context.onProgress?.(agent.id, 'running');

      const result = await this.executeAgent(agent, context);
      results.push(result);

      this.sessionStateManager.updateSubagent(context.sessionId, agent.id, {
        status: result.status === 'completed' ? 'completed' : 'failed',
        completedAt: Date.now(),
      });

      context.onProgress?.(agent.id, result.status);

      // Checkpoint: 成功节点持久化
      if (result.status === 'completed') {
        checkpoint.completedNodes[agent.id] = result;
        checkpoint.updatedAt = Date.now();
        saveCheckpoint(checkpoint);
      }
    }

    // 如果主 agent 成功，并行执行辅助 agent
    const primarySuccess = results.every(r => r.status === 'completed');

    if (primarySuccess && parallelAgents.length > 0) {
      // 过滤掉已 checkpoint 的并行 agent
      const pendingParallel = parallelAgents.filter(a => {
        const cached = checkpoint.completedNodes[a.id];
        if (cached && cached.status === 'completed') {
          logger.info(`Checkpoint hit, skipping parallel agent: ${a.name}`);
          results.push(cached);
          context.onProgress?.(a.id, 'completed');
          return false;
        }
        return true;
      });

      if (pendingParallel.length > 0) {
        // 注册待执行的并行 agent 为 pending
        for (const agent of pendingParallel) {
          this.sessionStateManager.addSubagent(context.sessionId, {
            id: agent.id,
            name: agent.name,
            status: 'pending',
            startedAt: Date.now(),
          });
        }

        // 并行执行
        const parallelPromises = pendingParallel.map(async (agent) => {
          this.sessionStateManager.updateSubagent(context.sessionId, agent.id, {
            status: 'running',
          });
          context.onProgress?.(agent.id, 'running');

          const result = await this.executeAgent(agent, context);

          this.sessionStateManager.updateSubagent(context.sessionId, agent.id, {
            status: result.status === 'completed' ? 'completed' : 'failed',
            completedAt: Date.now(),
          });
          context.onProgress?.(agent.id, result.status);

          // Checkpoint: 成功节点持久化
          if (result.status === 'completed') {
            checkpoint.completedNodes[agent.id] = result;
            checkpoint.updatedAt = Date.now();
            saveCheckpoint(checkpoint);
          }

          return result;
        });

        const parallelResults = await Promise.all(parallelPromises);
        results.push(...parallelResults);
      }
    }

    return results;
  }

  /**
   * 执行单个 Agent
   */
  private async executeAgent(
    agent: DynamicAgentDefinition,
    context: CoordinatorContext,
    previousOutput?: string
  ): Promise<AgentExecutionResult> {
    const startedAt = Date.now();

    logger.debug(`Executing agent: ${agent.id}`, {
      name: agent.name,
      tools: agent.tools,
      maxIterations: agent.maxIterations,
    });

    try {
      // 构建执行 prompt
      let prompt = agent.taskDescription;
      if (previousOutput) {
        prompt = `${prompt}\n\n**前置任务输出**：\n${previousOutput}`;
      }

      // 执行
      const result = await this.subagentExecutor.execute(
        prompt,
        {
          name: agent.name,
          systemPrompt: agent.systemPrompt,
          availableTools: agent.tools,
          maxIterations: agent.maxIterations,
          maxBudget: agent.maxBudget,
        },
        {
          modelConfig: context.modelConfig,
          toolResolver: context.toolResolver,
          toolContext: context.toolContext,
        }
      );

      const completedAt = Date.now();

      return {
        agentId: agent.id,
        agentName: agent.name,
        status: result.success ? 'completed' : 'failed',
        result,
        error: result.error,
        startedAt,
        completedAt,
        duration: completedAt - startedAt,
      };
    } catch (error) {
      const completedAt = Date.now();
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      logger.error(`Agent ${agent.id} execution failed`, error);

      return {
        agentId: agent.id,
        agentName: agent.name,
        status: 'failed',
        error: errorMessage,
        startedAt,
        completedAt,
        duration: completedAt - startedAt,
      };
    }
  }

  /**
   * 聚合执行结果
   */
  private aggregateResults(
    results: AgentExecutionResult[],
    requirements: AgentRequirements
  ): Omit<CoordinationResult, 'strategy' | 'totalDuration'> {
    const errors: string[] = [];
    let totalIterations = 0;
    let totalCost = 0;
    const outputs: string[] = [];

    for (const result of results) {
      if (result.error) {
        errors.push(`[${result.agentName}] ${result.error}`);
      }
      if (result.result) {
        totalIterations += result.result.iterations;
        totalCost += result.result.cost || 0;
        if (result.result.output) {
          outputs.push(`## ${result.agentName}\n\n${result.result.output}`);
        }
      }
    }

    // 判断整体成功
    const success = results.some(r => r.status === 'completed');

    // 聚合输出
    const aggregatedOutput = outputs.join('\n\n---\n\n');

    return {
      success,
      results,
      aggregatedOutput,
      totalIterations,
      totalCost,
      errors,
    };
  }

  /**
   * 取消正在执行的 Agent
   */
  cancelAgents(sessionId: string): void {
    const state = this.sessionStateManager.get(sessionId);
    if (!state) return;

    for (const [agentId] of state.activeSubagents) {
      this.sessionStateManager.updateSubagent(sessionId, agentId, {
        status: 'failed',
        error: 'Cancelled by user',
        completedAt: Date.now(),
      });
    }

    logger.info(`Cancelled all agents for session: ${sessionId}`);
  }

  /**
   * 获取执行进度
   */
  getProgress(sessionId: string): {
    total: number;
    completed: number;
    running: number;
    failed: number;
    pending: number;
  } {
    const state = this.sessionStateManager.get(sessionId);
    if (!state) {
      return { total: 0, completed: 0, running: 0, failed: 0, pending: 0 };
    }

    let completed = 0;
    let running = 0;
    let failed = 0;
    let pending = 0;

    for (const subagent of state.activeSubagents.values()) {
      switch (subagent.status) {
        case 'completed':
          completed++;
          break;
        case 'running':
          running++;
          break;
        case 'failed':
          failed++;
          break;
        case 'pending':
          pending++;
          break;
      }
    }

    return {
      total: state.activeSubagents.size,
      completed,
      running,
      failed,
      pending,
    };
  }
}

// ----------------------------------------------------------------------------
// Singleton Instance
// ----------------------------------------------------------------------------

let coordinatorInstance: AutoAgentCoordinator | null = null;

/**
 * 获取 AutoAgentCoordinator 单例
 */
export function getAutoAgentCoordinator(): AutoAgentCoordinator {
  if (!coordinatorInstance) {
    coordinatorInstance = new AutoAgentCoordinator();
  }
  return coordinatorInstance;
}
