// ============================================================================
// AgentScheduler - Agent 调度器
// 管理多 Agent 任务调度和执行
// ============================================================================

import { EventEmitter } from 'events';
import type {
  AgentRole,
  AgentTask,
  AgentTaskResult,
  TaskContext,
  DelegationRequest,
  DelegationResponse,
  SchedulerConfig,
  SchedulingStrategy,
  WorkflowDefinition,
  WorkflowExecution,
  WorkflowStep,
  AgentInstance,
} from './types';
import { getAgentRegistry, AgentRegistry } from './AgentRegistry';
import { getAgentExecutor, AgentExecutor } from './AgentExecutor';
import type { ModelConfig } from '../../../shared/types';
import type { Tool, ToolContext } from '../../tools/ToolRegistry';

// ============================================================================
// 类型定义
// ============================================================================

export interface SchedulerContext {
  modelConfig: ModelConfig;
  toolRegistry: Map<string, Tool>;
  toolContext: ToolContext;
}

interface QueuedTask {
  task: AgentTask;
  context?: TaskContext;
  resolve: (result: AgentTaskResult) => void;
  reject: (error: Error) => void;
}

const DEFAULT_CONFIG: SchedulerConfig = {
  strategy: 'skill_match',
  maxConcurrentAgents: 5,
  taskQueueSize: 100,
  delegationTimeout: 60000,
  retryOnFailure: true,
  maxRetries: 2,
};

// ============================================================================
// AgentScheduler 类
// ============================================================================

export class AgentScheduler extends EventEmitter {
  private config: SchedulerConfig;
  private registry: AgentRegistry;
  private executor: AgentExecutor;
  private context?: SchedulerContext;
  private taskQueue: QueuedTask[] = [];
  private runningTasks: Map<string, AgentTask> = new Map();
  private taskRetries: Map<string, number> = new Map();
  private workflows: Map<string, WorkflowDefinition> = new Map();
  private workflowExecutions: Map<string, WorkflowExecution> = new Map();
  private isProcessing = false;

  constructor(config: Partial<SchedulerConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.registry = getAgentRegistry();
    this.executor = getAgentExecutor();

    // 注册内置工作流
    this.registerBuiltinWorkflows();
  }

  /**
   * 初始化调度器
   */
  initialize(context: SchedulerContext): void {
    this.context = context;
  }

  // --------------------------------------------------------------------------
  // 任务调度
  // --------------------------------------------------------------------------

  /**
   * 提交任务
   */
  async submitTask(
    role: AgentRole,
    prompt: string,
    options: {
      priority?: number;
      context?: TaskContext;
      parentTaskId?: string;
    } = {}
  ): Promise<AgentTaskResult> {
    if (!this.context) {
      throw new Error('Scheduler not initialized');
    }

    // 检查队列容量
    if (this.taskQueue.length >= this.config.taskQueueSize) {
      throw new Error('Task queue is full');
    }

    // 创建任务
    const task: AgentTask = {
      id: `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      agentId: '', // 待分配
      parentTaskId: options.parentTaskId,
      prompt,
      context: options.context,
      priority: options.priority || 5,
      status: 'pending',
      createdAt: Date.now(),
    };

    // 添加到队列
    return new Promise((resolve, reject) => {
      this.taskQueue.push({
        task,
        context: options.context,
        resolve,
        reject,
      });

      // 按优先级排序
      this.taskQueue.sort((a, b) => b.task.priority - a.task.priority);

      this.emit('task:queued', task);

      // 尝试处理队列
      this.processQueue();
    });
  }

  /**
   * 处理任务队列
   */
  private async processQueue(): Promise<void> {
    if (this.isProcessing) return;
    this.isProcessing = true;

    try {
      while (this.taskQueue.length > 0 && this.runningTasks.size < this.config.maxConcurrentAgents) {
        const queuedTask = this.taskQueue.shift();
        if (!queuedTask) break;

        // 选择 Agent
        const instance = await this.selectAgent(queuedTask.task);
        if (!instance) {
          // 没有可用的 Agent，放回队列
          this.taskQueue.unshift(queuedTask);
          break;
        }

        // 分配任务
        queuedTask.task.agentId = instance.id;
        queuedTask.task.status = 'running';
        queuedTask.task.startedAt = Date.now();
        this.runningTasks.set(queuedTask.task.id, queuedTask.task);

        this.emit('task:started', queuedTask.task);

        // 执行任务
        this.executeTask(instance, queuedTask);
      }
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * 执行任务
   */
  private async executeTask(instance: AgentInstance, queuedTask: QueuedTask): Promise<void> {
    try {
      const result = await this.executor.execute(instance, queuedTask.task, {
        modelConfig: this.context!.modelConfig,
        toolRegistry: this.context!.toolRegistry,
        toolContext: this.context!.toolContext,
        onProgress: (progress, step) => {
          this.emit('task:progress', { taskId: queuedTask.task.id, progress, step });
        },
        onOutput: (chunk) => {
          this.emit('task:output', { taskId: queuedTask.task.id, chunk });
        },
        onDelegation: (request) => this.handleDelegation(request),
      });

      // 更新任务状态
      queuedTask.task.status = result.success ? 'completed' : 'failed';
      queuedTask.task.completedAt = Date.now();
      queuedTask.task.result = result;

      this.runningTasks.delete(queuedTask.task.id);

      // 检查是否需要重试
      if (!result.success && this.config.retryOnFailure) {
        const retries = this.taskRetries.get(queuedTask.task.id) || 0;
        if (retries < this.config.maxRetries) {
          this.taskRetries.set(queuedTask.task.id, retries + 1);
          queuedTask.task.status = 'pending';
          this.taskQueue.push(queuedTask);
          this.emit('task:retry', { taskId: queuedTask.task.id, attempt: retries + 1 });
          this.processQueue();
          return;
        }
      }

      this.taskRetries.delete(queuedTask.task.id);
      this.emit('task:completed', { task: queuedTask.task, result });
      queuedTask.resolve(result);

      // 继续处理队列
      this.processQueue();
    } catch (error) {
      this.runningTasks.delete(queuedTask.task.id);
      queuedTask.task.status = 'failed';

      const errorResult: AgentTaskResult = {
        taskId: queuedTask.task.id,
        agentId: instance.id,
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        iterations: 0,
        duration: Date.now() - (queuedTask.task.startedAt || Date.now()),
        toolsUsed: [],
      };

      this.emit('task:failed', { task: queuedTask.task, error: errorResult.error });
      queuedTask.reject(error instanceof Error ? error : new Error(String(error)));

      // 继续处理队列
      this.processQueue();
    }
  }

  // --------------------------------------------------------------------------
  // Agent 选择
  // --------------------------------------------------------------------------

  /**
   * 选择 Agent
   */
  private async selectAgent(task: AgentTask): Promise<AgentInstance | null> {
    // 获取任务需要的角色
    const role = this.inferRole(task);

    switch (this.config.strategy) {
      case 'round_robin':
        return this.selectRoundRobin(role);
      case 'least_busy':
        return this.selectLeastBusy(role);
      case 'skill_match':
        return this.selectSkillMatch(task, role);
      case 'priority_first':
        return this.selectPriorityFirst(task, role);
      default:
        return this.registry.getOrCreateIdleInstance(role);
    }
  }

  /**
   * 推断任务角色
   */
  private inferRole(task: AgentTask): AgentRole {
    const prompt = task.prompt.toLowerCase();

    // 基于关键词推断
    if (prompt.includes('计划') || prompt.includes('分解') || prompt.includes('plan')) {
      return 'planner';
    }
    if (prompt.includes('搜索') || prompt.includes('研究') || prompt.includes('search') || prompt.includes('research')) {
      return 'researcher';
    }
    if (prompt.includes('审查') || prompt.includes('review') || prompt.includes('检查')) {
      return 'reviewer';
    }
    if (prompt.includes('测试') || prompt.includes('test')) {
      return 'tester';
    }
    if (prompt.includes('文档') || prompt.includes('写') || prompt.includes('document') || prompt.includes('write')) {
      return 'writer';
    }
    if (prompt.includes('代码') || prompt.includes('实现') || prompt.includes('code') || prompt.includes('implement')) {
      return 'coder';
    }

    // 默认返回 coder
    return 'coder';
  }

  /**
   * 轮询选择
   */
  private selectRoundRobin(role: AgentRole): AgentInstance | null {
    const instances = this.registry.getInstancesByRole(role);
    const idle = instances.filter((i) => i.status === 'idle');

    if (idle.length === 0) {
      return this.registry.getOrCreateIdleInstance(role);
    }

    // 选择最久未使用的
    idle.sort((a, b) => a.lastActiveAt - b.lastActiveAt);
    return idle[0];
  }

  /**
   * 最空闲选择
   */
  private selectLeastBusy(role: AgentRole): AgentInstance | null {
    const idle = this.registry.getIdleInstances(role);

    if (idle.length === 0) {
      // 创建新实例
      return this.registry.getOrCreateIdleInstance(role);
    }

    // 选择平均执行时间最短的
    idle.sort((a, b) => a.stats.averageDuration - b.stats.averageDuration);
    return idle[0];
  }

  /**
   * 技能匹配选择
   */
  private selectSkillMatch(task: AgentTask, role: AgentRole): AgentInstance | null {
    const definitions = this.registry.getDefinitionsByRole(role);

    if (definitions.length === 0) {
      return null;
    }

    // 评估每个定义的匹配度
    let bestDefinition = definitions[0];
    let bestScore = 0;

    for (const def of definitions) {
      const score = this.calculateMatchScore(task, def);
      if (score > bestScore) {
        bestScore = score;
        bestDefinition = def;
      }
    }

    // 获取或创建实例
    const instances = this.registry.getInstancesByDefinition(bestDefinition.id);
    const idle = instances.find((i) => i.status === 'idle');

    if (idle) {
      return idle;
    }

    // 创建新实例
    return this.registry.createInstance(bestDefinition.id);
  }

  /**
   * 优先级优先选择
   */
  private selectPriorityFirst(task: AgentTask, role: AgentRole): AgentInstance | null {
    // 高优先级任务使用专用实例
    if (task.priority >= 8) {
      return this.registry.createInstance(
        this.registry.getDefinitionsByRole(role)[0]?.id || ''
      );
    }

    return this.selectLeastBusy(role);
  }

  /**
   * 计算匹配分数
   */
  private calculateMatchScore(task: AgentTask, definition: { capabilities: string[]; availableTools: string[] }): number {
    let score = 0;
    const prompt = task.prompt.toLowerCase();

    // 基于能力匹配
    if (prompt.includes('file') && definition.capabilities.includes('file_read')) {
      score += 10;
    }
    if (prompt.includes('shell') && definition.capabilities.includes('shell_execute')) {
      score += 10;
    }
    if (prompt.includes('search') && definition.capabilities.includes('web_search')) {
      score += 10;
    }
    if (prompt.includes('test') && definition.capabilities.includes('test_execution')) {
      score += 10;
    }

    // 基于工具匹配
    const toolKeywords = ['read', 'write', 'edit', 'bash', 'grep', 'glob'];
    for (const keyword of toolKeywords) {
      if (prompt.includes(keyword)) {
        for (const tool of definition.availableTools) {
          if (tool.includes(keyword)) {
            score += 5;
          }
        }
      }
    }

    return score;
  }

  // --------------------------------------------------------------------------
  // 委派处理
  // --------------------------------------------------------------------------

  /**
   * 处理委派请求
   */
  private async handleDelegation(request: DelegationRequest): Promise<DelegationResponse> {
    try {
      // 检查是否可以委派
      const instances = this.registry.getInstancesByRole(request.targetRole);
      const definitions = this.registry.getDefinitionsByRole(request.targetRole);

      if (definitions.length === 0) {
        return {
          requestId: request.id,
          accepted: false,
          reason: `No agent available for role ${request.targetRole}`,
        };
      }

      // 检查容量
      if (this.runningTasks.size >= this.config.maxConcurrentAgents) {
        return {
          requestId: request.id,
          accepted: false,
          reason: 'Scheduler at capacity',
        };
      }

      // 选择或创建实例
      const idle = instances.find((i) => i.status === 'idle');
      const instance = idle || this.registry.createInstance(definitions[0].id);

      // 提交任务
      const result = await this.submitTask(request.targetRole, request.task.prompt, {
        priority: request.priority,
        context: request.context,
        parentTaskId: request.fromAgentId,
      });

      return {
        requestId: request.id,
        accepted: true,
        assignedAgentId: instance.id,
        estimatedDuration: result.duration,
      };
    } catch (error) {
      return {
        requestId: request.id,
        accepted: false,
        reason: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  // --------------------------------------------------------------------------
  // 工作流执行
  // --------------------------------------------------------------------------

  /**
   * 注册工作流
   */
  registerWorkflow(workflow: WorkflowDefinition): void {
    this.workflows.set(workflow.id, workflow);
  }

  /**
   * 执行工作流
   */
  async executeWorkflow(
    workflowId: string,
    initialContext?: TaskContext
  ): Promise<WorkflowExecution> {
    const workflow = this.workflows.get(workflowId);
    if (!workflow) {
      throw new Error(`Workflow ${workflowId} not found`);
    }

    const execution: WorkflowExecution = {
      id: `wf_exec_${Date.now()}`,
      definitionId: workflowId,
      status: 'running',
      completedSteps: [],
      failedSteps: [],
      stepResults: new Map(),
      startedAt: Date.now(),
    };

    this.workflowExecutions.set(execution.id, execution);
    this.emit('workflow:started', execution);

    try {
      await this.executeWorkflowSteps(workflow, execution, initialContext);
      execution.status = execution.failedSteps.length > 0 ? 'failed' : 'completed';
    } catch (error) {
      execution.status = 'failed';
    }

    execution.completedAt = Date.now();
    this.emit('workflow:completed', execution);

    return execution;
  }

  /**
   * 执行工作流步骤
   */
  private async executeWorkflowSteps(
    workflow: WorkflowDefinition,
    execution: WorkflowExecution,
    initialContext?: TaskContext
  ): Promise<void> {
    // 按依赖排序步骤
    const sortedSteps = this.sortStepsByDependencies(workflow.steps);

    for (const group of sortedSteps) {
      if (workflow.parallelExecution) {
        // 并行执行
        const results = await Promise.allSettled(
          group.map((step) =>
            this.executeWorkflowStep(step, execution, initialContext)
          )
        );

        for (let i = 0; i < results.length; i++) {
          const result = results[i];
          const step = group[i];

          if (result.status === 'fulfilled') {
            execution.completedSteps.push(step.id);
            execution.stepResults.set(step.id, result.value);
          } else {
            execution.failedSteps.push(step.id);
            if (workflow.errorHandling === 'stop') {
              throw new Error(`Step ${step.id} failed`);
            }
          }
        }
      } else {
        // 顺序执行
        for (const step of group) {
          try {
            const result = await this.executeWorkflowStep(step, execution, initialContext);
            execution.completedSteps.push(step.id);
            execution.stepResults.set(step.id, result);
          } catch (error) {
            execution.failedSteps.push(step.id);
            if (workflow.errorHandling === 'stop') {
              throw error;
            }
          }
        }
      }
    }
  }

  /**
   * 执行单个工作流步骤
   */
  private async executeWorkflowStep(
    step: WorkflowStep,
    execution: WorkflowExecution,
    initialContext?: TaskContext
  ): Promise<AgentTaskResult> {
    execution.currentStepId = step.id;
    this.emit('workflow:step:started', { executionId: execution.id, step });

    // 构建上下文
    const context: TaskContext = {
      ...initialContext,
      previousResults: Array.from(execution.stepResults.values()),
    };

    const result = await this.submitTask(step.agentRole, step.task, {
      priority: 8,
      context,
    });

    this.emit('workflow:step:completed', { executionId: execution.id, step, result });
    return result;
  }

  /**
   * 按依赖排序步骤
   */
  private sortStepsByDependencies(steps: WorkflowStep[]): WorkflowStep[][] {
    const groups: WorkflowStep[][] = [];
    const completed = new Set<string>();
    const remaining = [...steps];

    while (remaining.length > 0) {
      const ready = remaining.filter((step) => {
        const deps = step.dependsOn || [];
        return deps.every((d) => completed.has(d));
      });

      if (ready.length === 0) {
        groups.push(remaining);
        break;
      }

      groups.push(ready);

      for (const step of ready) {
        completed.add(step.id);
        const idx = remaining.indexOf(step);
        if (idx !== -1) remaining.splice(idx, 1);
      }
    }

    return groups;
  }

  /**
   * 注册内置工作流
   */
  private registerBuiltinWorkflows(): void {
    // 代码审查工作流
    this.registerWorkflow({
      id: 'code-review',
      name: '代码审查',
      description: '分析代码并提供审查意见',
      steps: [
        {
          id: 'analyze',
          agentRole: 'reviewer',
          task: '分析代码结构和逻辑',
        },
        {
          id: 'security',
          agentRole: 'reviewer',
          task: '检查安全漏洞',
          dependsOn: ['analyze'],
        },
        {
          id: 'report',
          agentRole: 'writer',
          task: '生成审查报告',
          dependsOn: ['analyze', 'security'],
        },
      ],
      errorHandling: 'skip',
      parallelExecution: false,
    });

    // 功能开发工作流
    this.registerWorkflow({
      id: 'feature-development',
      name: '功能开发',
      description: '规划、实现和测试新功能',
      steps: [
        {
          id: 'plan',
          agentRole: 'planner',
          task: '分析需求并制定实施计划',
        },
        {
          id: 'research',
          agentRole: 'researcher',
          task: '研究相关技术和最佳实践',
          dependsOn: ['plan'],
        },
        {
          id: 'implement',
          agentRole: 'coder',
          task: '实现功能代码',
          dependsOn: ['plan', 'research'],
        },
        {
          id: 'test',
          agentRole: 'tester',
          task: '编写和执行测试',
          dependsOn: ['implement'],
        },
        {
          id: 'review',
          agentRole: 'reviewer',
          task: '审查代码质量',
          dependsOn: ['implement'],
        },
        {
          id: 'document',
          agentRole: 'writer',
          task: '编写文档',
          dependsOn: ['implement', 'review'],
        },
      ],
      errorHandling: 'retry',
      parallelExecution: true,
    });
  }

  // --------------------------------------------------------------------------
  // 状态查询
  // --------------------------------------------------------------------------

  /**
   * 获取队列长度
   */
  getQueueLength(): number {
    return this.taskQueue.length;
  }

  /**
   * 获取运行中任务数
   */
  getRunningCount(): number {
    return this.runningTasks.size;
  }

  /**
   * 获取统计信息
   */
  getStats(): {
    queueLength: number;
    runningCount: number;
    maxConcurrent: number;
    strategy: SchedulingStrategy;
    agentStats: ReturnType<AgentRegistry['getStats']>;
  } {
    return {
      queueLength: this.taskQueue.length,
      runningCount: this.runningTasks.size,
      maxConcurrent: this.config.maxConcurrentAgents,
      strategy: this.config.strategy,
      agentStats: this.registry.getStats(),
    };
  }

  /**
   * 获取可用工作流
   */
  getAvailableWorkflows(): WorkflowDefinition[] {
    return Array.from(this.workflows.values());
  }

  /**
   * 获取工作流执行状态
   */
  getWorkflowExecution(executionId: string): WorkflowExecution | undefined {
    return this.workflowExecutions.get(executionId);
  }

  // --------------------------------------------------------------------------
  // 任务控制
  // --------------------------------------------------------------------------

  /**
   * 取消任务
   */
  cancelTask(taskId: string): boolean {
    // 从队列中移除
    const queueIndex = this.taskQueue.findIndex((q) => q.task.id === taskId);
    if (queueIndex !== -1) {
      const queued = this.taskQueue.splice(queueIndex, 1)[0];
      queued.reject(new Error('Task cancelled'));
      return true;
    }

    // 取消运行中的任务
    if (this.runningTasks.has(taskId)) {
      return this.executor.cancelTask(taskId);
    }

    return false;
  }

  /**
   * 清理资源
   */
  dispose(): void {
    // 清空队列
    for (const queued of this.taskQueue) {
      queued.reject(new Error('Scheduler disposed'));
    }
    this.taskQueue = [];

    // 清空工作流
    this.workflows.clear();
    this.workflowExecutions.clear();

    this.removeAllListeners();
  }
}

// ============================================================================
// 单例实例
// ============================================================================

let schedulerInstance: AgentScheduler | null = null;

export function getAgentScheduler(): AgentScheduler {
  if (!schedulerInstance) {
    schedulerInstance = new AgentScheduler();
  }
  return schedulerInstance;
}

export function initAgentScheduler(config: Partial<SchedulerConfig>): AgentScheduler {
  schedulerInstance = new AgentScheduler(config);
  return schedulerInstance;
}
