// ============================================================================
// DynamicCoordinator - 动态多 Agent 协调器
// 根据任务动态选择协调策略，管理 Agent 生命周期
// ============================================================================

import { EventEmitter } from 'events';
import { createLogger } from '../services/infra/logger';
import { getAgentBus, type AgentBus, type AgentMessage, type SharedStateEntry } from './agentBus';
import { getSubagentExecutor, type SubagentResult } from './subagentExecutor';
import { getResourceLockManager, type ResourceLockManager } from './resourceLockManager';
import { createProgressAggregator, type ProgressAggregator, type AggregatedProgress } from './progressAggregator';
import { getDynamicAgentFactory, type DynamicAgentDefinition } from './dynamicAgentFactory';
import { getAgentRequirementsAnalyzer, type AgentRequirements, type ExecutionStrategy } from './agentRequirementsAnalyzer';
import type { ModelConfig } from '../../shared/types';
import type { Tool, ToolContext } from '../tools/toolRegistry';
import { AGENT_TIMEOUTS } from '../../shared/constants';

const logger = createLogger('DynamicCoordinator');

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

/**
 * Agent 运行时状态
 */
export interface AgentRuntimeState {
  /** Agent 定义 ID */
  agentId: string;
  /** Agent 名称 */
  name: string;
  /** 当前状态 */
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  /** 开始时间 */
  startedAt?: number;
  /** 结束时间 */
  endedAt?: number;
  /** 当前迭代 */
  currentIteration: number;
  /** 最大迭代 */
  maxIterations: number;
  /** 执行结果 */
  result?: SubagentResult;
  /** 错误信息 */
  error?: string;
  /** 发现的内容 */
  discoveries: string[];
  /** 使用的工具 */
  toolsUsed: string[];
}

/**
 * 协调执行结果
 */
export interface CoordinationResult {
  /** 是否成功 */
  success: boolean;
  /** 执行策略 */
  strategy: ExecutionStrategy;
  /** 各 Agent 状态 */
  agents: AgentRuntimeState[];
  /** 聚合输出 */
  aggregatedOutput: string;
  /** 共享发现 */
  sharedDiscoveries: Array<{ agent: string; discovery: string }>;
  /** 总耗时（毫秒） */
  totalDuration: number;
  /** 总迭代数 */
  totalIterations: number;
  /** 失败的 Agent */
  failures: Array<{ agentId: string; error: string }>;
}

/**
 * 协调器上下文
 */
export interface CoordinatorContext {
  /** 会话 ID */
  sessionId: string;
  /** 模型配置 */
  modelConfig: ModelConfig;
  /** 工具注册表 */
  toolRegistry: Map<string, Tool>;
  /** 工具上下文 */
  toolContext: ToolContext;
  /** 进度回调 */
  onProgress?: (progress: AggregatedProgress) => void;
  /** Agent 状态变更回调 */
  onAgentStateChange?: (agentId: string, state: AgentRuntimeState) => void;
}

/**
 * 协调器配置
 */
export interface DynamicCoordinatorConfig {
  /** 最大并行 Agent 数 */
  maxParallelAgents: number;
  /** 单个 Agent 超时（毫秒） */
  agentTimeout: number;
  /** 总超时（毫秒） */
  totalTimeout: number;
  /** 失败重试次数 */
  maxRetries: number;
  /** 是否启用自动恢复 */
  enableAutoRecovery: boolean;
  /** 是否共享发现 */
  shareDiscoveries: boolean;
  /** 进度更新间隔（毫秒） */
  progressUpdateInterval: number;
}

const DEFAULT_CONFIG: DynamicCoordinatorConfig = {
  maxParallelAgents: 4,
  agentTimeout: AGENT_TIMEOUTS.DYNAMIC_AGENT,
  totalTimeout: AGENT_TIMEOUTS.DYNAMIC_TOTAL,
  maxRetries: 2,
  enableAutoRecovery: true,
  shareDiscoveries: true,
  progressUpdateInterval: 1000,
};

// ----------------------------------------------------------------------------
// DynamicCoordinator
// ----------------------------------------------------------------------------

/**
 * 动态多 Agent 协调器
 *
 * 功能：
 * 1. 动态分析任务需求
 * 2. 自动选择执行策略（直接/顺序/并行）
 * 3. 通过 AgentBus 实现 Agent 间通信
 * 4. 管理资源锁和进度
 * 5. 聚合结果
 */
export class DynamicCoordinator extends EventEmitter {
  private config: DynamicCoordinatorConfig;
  private bus: AgentBus;
  private lockManager: ResourceLockManager;
  private progressAggregator: ProgressAggregator;
  private subagentExecutor = getSubagentExecutor();
  private factory = getDynamicAgentFactory();
  private analyzer = getAgentRequirementsAnalyzer();

  private activeAgents: Map<string, AgentRuntimeState> = new Map();
  private runningPromises: Map<string, Promise<SubagentResult>> = new Map();
  private isCancelled = false;
  private busSubscriptions: string[] = [];

  constructor(config: Partial<DynamicCoordinatorConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.bus = getAgentBus();
    this.lockManager = getResourceLockManager();
    this.progressAggregator = createProgressAggregator();
  }

  /**
   * 执行协调任务
   */
  async coordinate(
    userMessage: string,
    context: CoordinatorContext
  ): Promise<CoordinationResult> {
    const startTime = Date.now();
    this.isCancelled = false;
    this.activeAgents.clear();

    logger.info('Starting dynamic coordination', { sessionId: context.sessionId });

    try {
      // 1. 分析任务需求
      const requirements = await this.analyzer.analyze(userMessage, context.toolContext.workingDirectory);

      logger.info('Task analysis complete', {
        taskType: requirements.taskType,
        strategy: requirements.executionStrategy,
        needsAutoAgent: requirements.needsAutoAgent,
      });

      // 2. 根据策略执行
      let result: CoordinationResult;

      switch (requirements.executionStrategy) {
        case 'direct':
          result = await this.executeDirectly(userMessage, requirements, context);
          break;

        case 'sequential':
          result = await this.executeSequentially(userMessage, requirements, context);
          break;

        case 'parallel':
          result = await this.executeInParallel(userMessage, requirements, context);
          break;

        default:
          result = await this.executeSequentially(userMessage, requirements, context);
      }

      result.totalDuration = Date.now() - startTime;
      result.strategy = requirements.executionStrategy;

      logger.info('Coordination complete', {
        success: result.success,
        duration: result.totalDuration,
        agentCount: result.agents.length,
      });

      return result;

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Coordination failed', error);

      return {
        success: false,
        strategy: 'direct',
        agents: Array.from(this.activeAgents.values()),
        aggregatedOutput: '',
        sharedDiscoveries: [],
        totalDuration: Date.now() - startTime,
        totalIterations: 0,
        failures: [{ agentId: 'coordinator', error: errorMessage }],
      };
    } finally {
      this.cleanup();
    }
  }

  /**
   * 直接执行（无需多 Agent）
   */
  private async executeDirectly(
    userMessage: string,
    requirements: AgentRequirements,
    context: CoordinatorContext
  ): Promise<CoordinationResult> {
    // 直接策略不创建子代理，返回空结果让主循环处理
    return {
      success: true,
      strategy: 'direct',
      agents: [],
      aggregatedOutput: '',
      sharedDiscoveries: [],
      totalDuration: 0,
      totalIterations: 0,
      failures: [],
    };
  }

  /**
   * 顺序执行
   */
  private async executeSequentially(
    userMessage: string,
    requirements: AgentRequirements,
    context: CoordinatorContext
  ): Promise<CoordinationResult> {
    // 创建动态 Agent
    const agents = this.factory.create(requirements, {
      userMessage,
      workingDirectory: context.toolContext.workingDirectory,
      sessionId: context.sessionId,
    });

    if (agents.length === 0) {
      return this.executeDirectly(userMessage, requirements, context);
    }

    // 设置 Bus 订阅
    this.setupBusSubscriptions(context);

    const results: AgentRuntimeState[] = [];
    const discoveries: Array<{ agent: string; discovery: string }> = [];
    let previousOutput = '';

    for (const agent of agents) {
      if (this.isCancelled) break;

      // 初始化进度
      this.progressAggregator.initAgent(agent.id, agent.name, agent.maxIterations);

      // 创建运行时状态
      const state = this.initAgentState(agent);
      this.activeAgents.set(agent.id, state);

      // 执行
      const result = await this.executeAgent(agent, context, previousOutput);

      // 更新状态
      state.status = result.success ? 'completed' : 'failed';
      state.endedAt = Date.now();
      state.result = result;
      state.error = result.error;
      state.toolsUsed = result.toolsUsed;

      this.progressAggregator.completeAgent(agent.id, result.success, result.error);
      context.onAgentStateChange?.(agent.id, state);

      results.push(state);

      // 收集发现
      if (this.config.shareDiscoveries) {
        const agentDiscoveries = this.collectDiscoveries(agent.id);
        discoveries.push(...agentDiscoveries.map(d => ({ agent: agent.name, discovery: d })));
      }

      // 传递输出给下一个
      if (result.success && result.output) {
        previousOutput = result.output;
      }

      // 主 Agent 失败则停止
      if (!result.success && agent.priority === 1) {
        logger.warn('Primary agent failed, stopping sequence');
        break;
      }
    }

    return {
      success: results.some(r => r.status === 'completed'),
      strategy: 'sequential',
      agents: results,
      aggregatedOutput: this.aggregateOutputs(results),
      sharedDiscoveries: discoveries,
      totalDuration: 0,
      totalIterations: results.reduce((sum, r) => sum + r.currentIteration, 0),
      failures: results
        .filter(r => r.status === 'failed')
        .map(r => ({ agentId: r.agentId, error: r.error || 'Unknown error' })),
    };
  }

  /**
   * 并行执行
   */
  private async executeInParallel(
    userMessage: string,
    requirements: AgentRequirements,
    context: CoordinatorContext
  ): Promise<CoordinationResult> {
    // 创建动态 Agent
    const agents = this.factory.create(requirements, {
      userMessage,
      workingDirectory: context.toolContext.workingDirectory,
      sessionId: context.sessionId,
    });

    if (agents.length === 0) {
      return this.executeDirectly(userMessage, requirements, context);
    }

    // 设置 Bus 订阅
    this.setupBusSubscriptions(context);

    // 分离主 Agent 和并行 Agent
    const primaryAgents = agents.filter(a => !a.canRunParallel);
    const parallelAgents = agents.filter(a => a.canRunParallel);

    const results: AgentRuntimeState[] = [];
    const discoveries: Array<{ agent: string; discovery: string }> = [];

    // 先执行主 Agent
    for (const agent of primaryAgents) {
      if (this.isCancelled) break;

      this.progressAggregator.initAgent(agent.id, agent.name, agent.maxIterations);
      const state = this.initAgentState(agent);
      this.activeAgents.set(agent.id, state);

      const result = await this.executeAgent(agent, context);

      state.status = result.success ? 'completed' : 'failed';
      state.endedAt = Date.now();
      state.result = result;
      state.error = result.error;
      state.toolsUsed = result.toolsUsed;

      this.progressAggregator.completeAgent(agent.id, result.success, result.error);
      context.onAgentStateChange?.(agent.id, state);

      results.push(state);

      // 收集发现
      const agentDiscoveries = this.collectDiscoveries(agent.id);
      discoveries.push(...agentDiscoveries.map(d => ({ agent: agent.name, discovery: d })));
    }

    // 主 Agent 成功后，并行执行其他 Agent
    const primarySuccess = results.every(r => r.status === 'completed');

    if (primarySuccess && parallelAgents.length > 0 && !this.isCancelled) {
      // 初始化所有并行 Agent
      for (const agent of parallelAgents) {
        this.progressAggregator.initAgent(agent.id, agent.name, agent.maxIterations);
        const state = this.initAgentState(agent);
        this.activeAgents.set(agent.id, state);
      }

      // 限制并行数量
      const chunks = this.chunkArray(parallelAgents, this.config.maxParallelAgents);

      for (const chunk of chunks) {
        if (this.isCancelled) break;

        // 并行执行当前批次
        const promises = chunk.map(async (agent) => {
          const state = this.activeAgents.get(agent.id)!;
          state.status = 'running';
          state.startedAt = Date.now();
          context.onAgentStateChange?.(agent.id, state);

          try {
            const result = await this.executeAgent(agent, context);

            state.status = result.success ? 'completed' : 'failed';
            state.endedAt = Date.now();
            state.result = result;
            state.error = result.error;
            state.toolsUsed = result.toolsUsed;

            this.progressAggregator.completeAgent(agent.id, result.success, result.error);

            // 收集发现
            const agentDiscoveries = this.collectDiscoveries(agent.id);
            discoveries.push(...agentDiscoveries.map(d => ({ agent: agent.name, discovery: d })));

            return state;
          } catch (error) {
            state.status = 'failed';
            state.endedAt = Date.now();
            state.error = error instanceof Error ? error.message : 'Unknown error';
            this.progressAggregator.completeAgent(agent.id, false, state.error);
            return state;
          } finally {
            context.onAgentStateChange?.(agent.id, state);
          }
        });

        const chunkResults = await Promise.all(promises);
        results.push(...chunkResults);
      }
    }

    return {
      success: results.some(r => r.status === 'completed'),
      strategy: 'parallel',
      agents: results,
      aggregatedOutput: this.aggregateOutputs(results),
      sharedDiscoveries: discoveries,
      totalDuration: 0,
      totalIterations: results.reduce((sum, r) => sum + r.currentIteration, 0),
      failures: results
        .filter(r => r.status === 'failed')
        .map(r => ({ agentId: r.agentId, error: r.error || 'Unknown error' })),
    };
  }

  /**
   * 执行单个 Agent
   */
  private async executeAgent(
    agent: DynamicAgentDefinition,
    context: CoordinatorContext,
    previousOutput?: string
  ): Promise<SubagentResult> {
    const state = this.activeAgents.get(agent.id);
    if (state) {
      state.status = 'running';
      state.startedAt = Date.now();
      context.onAgentStateChange?.(agent.id, state);
    }

    // 构建 prompt
    let prompt = agent.taskDescription;
    if (previousOutput) {
      prompt = `${prompt}\n\n**前置任务输出**：\n${previousOutput}`;
    }

    // 注入共享发现
    if (this.config.shareDiscoveries) {
      const sharedContext = this.getSharedContext(agent.id);
      if (sharedContext) {
        prompt = `${prompt}\n\n${sharedContext}`;
      }
    }

    // 设置进度回调
    const progressCallback = (iteration: number, operation?: string) => {
      this.progressAggregator.updateIteration(agent.id, iteration, operation);
      if (state) {
        state.currentIteration = iteration;
      }
      context.onProgress?.(this.progressAggregator.getProgress());
    };

    // 创建超时
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('Agent timeout')), this.config.agentTimeout);
    });

    try {
      const result = await Promise.race([
        this.subagentExecutor.execute(
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
        ),
        timeoutPromise,
      ]);

      // 广播完成
      await this.bus.notifyComplete(agent.id, {
        success: result.success,
        output: result.output,
        summary: result.output.substring(0, 200),
      });

      return result;

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      // 广播错误
      await this.bus.reportError(agent.id, {
        message: errorMessage,
        fatal: true,
      });

      return {
        success: false,
        output: '',
        error: errorMessage,
        toolsUsed: [],
        iterations: state?.currentIteration || 0,
      };
    }
  }

  /**
   * 取消执行
   */
  cancel(): void {
    this.isCancelled = true;

    // 取消所有运行中的 Agent
    for (const [agentId, state] of this.activeAgents) {
      if (state.status === 'running') {
        state.status = 'cancelled';
        state.endedAt = Date.now();
        this.progressAggregator.completeAgent(agentId, false, 'Cancelled');
      }
    }

    logger.info('Coordination cancelled');
    this.emit('cancelled');
  }

  /**
   * 获取当前进度
   */
  getProgress(): AggregatedProgress {
    return this.progressAggregator.getProgress();
  }

  /**
   * 获取 Agent 状态
   */
  getAgentState(agentId: string): AgentRuntimeState | undefined {
    return this.activeAgents.get(agentId);
  }

  /**
   * 获取所有 Agent 状态
   */
  getAllAgentStates(): AgentRuntimeState[] {
    return Array.from(this.activeAgents.values());
  }

  // ==========================================================================
  // Private Methods
  // ==========================================================================

  private initAgentState(agent: DynamicAgentDefinition): AgentRuntimeState {
    return {
      agentId: agent.id,
      name: agent.name,
      status: 'pending',
      currentIteration: 0,
      maxIterations: agent.maxIterations,
      discoveries: [],
      toolsUsed: [],
    };
  }

  private setupBusSubscriptions(context: CoordinatorContext): void {
    // 订阅发现频道
    const discoverySub = this.bus.subscribe('coordinator', 'discoveries', (message) => {
      const state = this.activeAgents.get(message.from);
      if (state && message.payload) {
        const discovery = (message.payload as { content?: string }).content;
        if (discovery) {
          state.discoveries.push(discovery);
        }
      }
    });
    this.busSubscriptions.push(discoverySub);

    // 订阅进度频道
    const progressSub = this.bus.subscribe('coordinator', 'progress', (message) => {
      const payload = message.payload as { iteration?: number; status?: string };
      if (payload.iteration !== undefined) {
        this.progressAggregator.updateIteration(message.from, payload.iteration, payload.status);
        context.onProgress?.(this.progressAggregator.getProgress());
      }
    });
    this.busSubscriptions.push(progressSub);

    // 订阅错误频道
    const errorSub = this.bus.subscribe('coordinator', 'errors', (message) => {
      const payload = message.payload as { message?: string; fatal?: boolean };
      logger.error(`Agent ${message.from} reported error:`, payload.message);
      if (payload.fatal) {
        const state = this.activeAgents.get(message.from);
        if (state) {
          state.error = payload.message;
        }
      }
    });
    this.busSubscriptions.push(errorSub);
  }

  private collectDiscoveries(agentId: string): string[] {
    // 从 Bus 状态中收集发现
    const states = this.bus.getStates(/^discovery:/);
    const discoveries: string[] = [];

    for (const [, entry] of states) {
      const owner = (entry as SharedStateEntry).owner;
      if (owner === agentId) {
        const value = entry.value as { content?: string };
        if (value.content) {
          discoveries.push(value.content);
        }
      }
    }

    return discoveries;
  }

  private getSharedContext(excludeAgentId: string): string | null {
    const discoveries: string[] = [];

    // 从其他 Agent 获取发现
    for (const [agentId, state] of this.activeAgents) {
      if (agentId !== excludeAgentId && state.discoveries.length > 0) {
        discoveries.push(`\n### ${state.name} 的发现：`);
        discoveries.push(...state.discoveries.slice(0, 5).map(d => `- ${d}`));
      }
    }

    if (discoveries.length === 0) {
      return null;
    }

    return `\n## 其他 Agent 的发现：\n${discoveries.join('\n')}`;
  }

  private aggregateOutputs(results: AgentRuntimeState[]): string {
    const outputs: string[] = [];

    for (const state of results) {
      if (state.result?.output) {
        outputs.push(`## ${state.name}\n\n${state.result.output}`);
      }
    }

    return outputs.join('\n\n---\n\n');
  }

  private chunkArray<T>(array: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < array.length; i += size) {
      chunks.push(array.slice(i, i + size));
    }
    return chunks;
  }

  private cleanup(): void {
    // 取消订阅
    for (const subId of this.busSubscriptions) {
      this.bus.unsubscribe(subId);
    }
    this.busSubscriptions = [];

    // 释放所有资源锁
    for (const agentId of this.activeAgents.keys()) {
      this.lockManager.releaseAll(agentId);
    }

    // 重置进度聚合器
    this.progressAggregator.reset();
  }
}

// ----------------------------------------------------------------------------
// Singleton Instance
// ----------------------------------------------------------------------------

let coordinatorInstance: DynamicCoordinator | null = null;

/**
 * 获取 DynamicCoordinator 单例
 */
export function getDynamicCoordinator(): DynamicCoordinator {
  if (!coordinatorInstance) {
    coordinatorInstance = new DynamicCoordinator();
  }
  return coordinatorInstance;
}

/**
 * 初始化 DynamicCoordinator（自定义配置）
 */
export function initDynamicCoordinator(config: Partial<DynamicCoordinatorConfig>): DynamicCoordinator {
  coordinatorInstance = new DynamicCoordinator(config);
  return coordinatorInstance;
}

/**
 * 重置 DynamicCoordinator（用于测试）
 */
export function resetDynamicCoordinator(): void {
  coordinatorInstance = null;
}
