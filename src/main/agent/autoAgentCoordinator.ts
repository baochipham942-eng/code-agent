// ============================================================================
// Auto Agent Coordinator - 协调自动生成的多 Agent 执行
// ============================================================================

import { createLogger } from '../services/infra/logger';
import { getSubagentExecutor, type SubagentResult } from './subagentExecutor';
import { getSessionStateManager } from '../session/sessionStateManager';
import { getResourceLockManager } from './resourceLockManager';
import { createProgressAggregator, type ProgressAggregator } from './progressAggregator';
import { createParallelErrorHandler, type ParallelErrorHandler } from './parallelErrorHandler';
import type { DynamicAgentDefinition } from './dynamicAgentFactory';
import type { AgentRequirements, ExecutionStrategy } from './agentRequirementsAnalyzer';
import type { ModelConfig } from '../../shared/types';
import type { Tool, ToolContext } from '../tools/toolRegistry';

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
  toolRegistry: Map<string, Tool>;
  toolContext: ToolContext;
  onProgress?: (agentId: string, status: AgentExecutionStatus, progress?: number) => void;
}

// ----------------------------------------------------------------------------
// Auto Agent Coordinator
// ----------------------------------------------------------------------------

/**
 * 自动 Agent 协调器
 *
 * 负责执行自动生成的 Agent，支持：
 * - 顺序执行
 * - 并行执行
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

    logger.info('Starting auto agent coordination', {
      agentCount: agents.length,
      strategy: requirements.executionStrategy,
      sessionId: context.sessionId,
    });

    // 根据策略选择执行方式
    let results: AgentExecutionResult[];

    try {
      switch (requirements.executionStrategy) {
        case 'direct':
          // 直接执行不应该走到这里，但作为后备
          results = await this.executeSequential(agents, context);
          break;

        case 'sequential':
          results = await this.executeSequential(agents, context);
          break;

        case 'parallel':
          results = await this.executeParallel(agents, context);
          break;

        default:
          results = await this.executeSequential(agents, context);
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

    logger.info('Auto agent coordination completed', {
      success: aggregated.success,
      agentCount: results.length,
      totalDuration,
    });

    return {
      ...aggregated,
      strategy: requirements.executionStrategy,
      totalDuration,
    };
  }

  /**
   * 顺序执行 Agent
   */
  private async executeSequential(
    agents: DynamicAgentDefinition[],
    context: CoordinatorContext
  ): Promise<AgentExecutionResult[]> {
    const results: AgentExecutionResult[] = [];
    let previousOutput = '';

    for (const agent of agents) {
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

      // 如果失败且是关键 agent，可以选择停止
      if (result.status === 'failed' && agent.priority === 1) {
        logger.warn('Primary agent failed, stopping sequential execution');
        break;
      }

      // 传递输出给下一个 agent
      if (result.result?.output) {
        previousOutput = result.result.output;
      }
    }

    return results;
  }

  /**
   * 并行执行 Agent
   */
  private async executeParallel(
    agents: DynamicAgentDefinition[],
    context: CoordinatorContext
  ): Promise<AgentExecutionResult[]> {
    // 分离主 agent 和可并行的辅助 agent
    const primaryAgents = agents.filter(a => !a.canRunParallel);
    const parallelAgents = agents.filter(a => a.canRunParallel);

    const results: AgentExecutionResult[] = [];

    // 先执行主 agent
    for (const agent of primaryAgents) {
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
    }

    // 如果主 agent 成功，并行执行辅助 agent
    const primarySuccess = results.every(r => r.status === 'completed');

    if (primarySuccess && parallelAgents.length > 0) {
      // 注册所有并行 agent 为 pending
      for (const agent of parallelAgents) {
        this.sessionStateManager.addSubagent(context.sessionId, {
          id: agent.id,
          name: agent.name,
          status: 'pending',
          startedAt: Date.now(),
        });
      }

      // 并行执行
      const parallelPromises = parallelAgents.map(async (agent) => {
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

        return result;
      });

      const parallelResults = await Promise.all(parallelPromises);
      results.push(...parallelResults);
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
          toolRegistry: context.toolRegistry,
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
