// ============================================================================
// DAGScheduler - Parallel scheduler for Task DAG execution
// Session 4: Task DAG + Parallel Scheduling
// ============================================================================

import { EventEmitter } from 'events';
import type { ModelConfig } from '../../shared/types';
import type {
  DAGTask,
  TaskOutput,
  TaskFailure,
  TaskExecutionContext,
  DAGEventType,
  DAGEvent,
  AgentTaskConfig,
  ShellTaskConfig,
  CheckpointTaskConfig,
} from '../../shared/types/taskDAG';
import { isTaskTerminal } from '../../shared/types/taskDAG';
import { TaskDAG } from './TaskDAG';
import type { Tool, ToolContext } from '../tools/toolRegistry';
import { getSubagentExecutor } from '../agent/subagentExecutor';
import {
  getPredefinedAgent,
  getAgentPrompt,
  getAgentTools,
  getAgentMaxIterations,
  getAgentPermissionPreset,
} from '../agent/agentDefinition';
import { createLogger } from '../services/infra/logger';
import { exec } from 'child_process';
import { promisify } from 'util';
import { DAG_SCHEDULER } from '../../shared/constants';
import { sendDAGInitEvent } from './dagEventBridge';

const execAsync = promisify(exec);
const logger = createLogger('DAGScheduler');

// ============================================================================
// Types
// ============================================================================

/**
 * 任务执行器函数签名
 */
export type TaskExecutor = (
  task: DAGTask,
  context: TaskExecutionContext
) => Promise<TaskOutput>;

/**
 * 调度器配置
 */
export interface DAGSchedulerConfig {
  /** 最大并行任务数 */
  maxParallelism: number;
  /** 调度间隔（毫秒） */
  scheduleInterval: number;
  /** 是否启用任务输出传递 */
  enableOutputPassing: boolean;
  /** 默认任务超时（毫秒） */
  defaultTimeout: number;
}

const DEFAULT_CONFIG: DAGSchedulerConfig = {
  maxParallelism: DAG_SCHEDULER.DEFAULT_PARALLELISM,
  scheduleInterval: DAG_SCHEDULER.SCHEDULE_INTERVAL,
  enableOutputPassing: true,
  defaultTimeout: DAG_SCHEDULER.DEFAULT_TIMEOUT,
};

/**
 * 调度器执行上下文
 */
export interface SchedulerContext {
  modelConfig: ModelConfig;
  toolRegistry: Map<string, Tool>;
  toolContext: ToolContext;
  workingDirectory: string;
  remainingBudget?: number;
}

/**
 * 调度器执行结果
 */
export interface SchedulerResult {
  success: boolean;
  dag: TaskDAG;
  totalDuration: number;
  maxParallelism: number;
  completedTasks: number;
  failedTasks: number;
  errors: Array<{ taskId: string; error: string }>;
}

// ============================================================================
// DAGScheduler
// ============================================================================

/**
 * DAGScheduler - 基于 DAG 的并行任务调度器
 *
 * 特性：
 * 1. 自动检测可并行任务
 * 2. 尊重任务依赖关系
 * 3. 支持任务优先级
 * 4. 失败策略（fail-fast / continue）
 * 5. 任务输出传递
 * 6. 实时进度事件
 *
 * @example
 * ```typescript
 * const scheduler = new DAGScheduler();
 *
 * // 构建 DAG
 * const dag = new TaskDAG('my-dag', 'My Workflow');
 * dag.addAgentTask('analyze', { role: 'architect', prompt: '分析代码' });
 * dag.addAgentTask('implement', { role: 'coder', prompt: '实现功能' });
 * dag.addDependency('implement', 'analyze');
 *
 * // 执行
 * const result = await scheduler.execute(dag, {
 *   modelConfig,
 *   toolRegistry,
 *   toolContext,
 *   workingDirectory: '/path/to/project',
 * });
 *
 * console.log(`Completed: ${result.completedTasks}/${dag.getAllTasks().length}`);
 * ```
 */
export class DAGScheduler extends EventEmitter {
  private config: DAGSchedulerConfig;
  private runningTasks: Map<string, Promise<void>> = new Map();
  private taskOutputs: Map<string, TaskOutput> = new Map();
  private currentDAG?: TaskDAG;
  private context?: SchedulerContext;
  private isRunning = false;
  private isPaused = false;

  // 自定义任务执行器
  private customExecutors: Map<string, TaskExecutor> = new Map();

  constructor(config: Partial<DAGSchedulerConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ============================================================================
  // Configuration
  // ============================================================================

  /**
   * 更新配置
   */
  updateConfig(config: Partial<DAGSchedulerConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * 获取配置
   */
  getConfig(): DAGSchedulerConfig {
    return { ...this.config };
  }

  /**
   * 注册自定义执行器
   */
  registerExecutor(type: string, executor: TaskExecutor): void {
    this.customExecutors.set(type, executor);
  }

  // ============================================================================
  // Execution
  // ============================================================================

  /**
   * 执行 DAG
   */
  async execute(dag: TaskDAG, context: SchedulerContext): Promise<SchedulerResult> {
    // 验证 DAG
    const validation = dag.validate();
    if (!validation.valid) {
      throw new Error(`Invalid DAG: ${validation.errors.join(', ')}`);
    }

    // 初始化
    this.currentDAG = dag;
    this.context = context;
    this.runningTasks.clear();
    this.taskOutputs.clear();
    this.isRunning = true;
    this.isPaused = false;

    const startTime = Date.now();
    let maxParallelism = 0;

    // 设置 DAG 状态
    dag.setStatus('running');

    // 转发 DAG 事件
    this.forwardDAGEvents(dag);

    // 发送 DAG 初始化事件到渲染进程（用于可视化）
    sendDAGInitEvent(dag);

    logger.info(`Starting DAG execution: ${dag.getName()} (${dag.getAllTasks().length} tasks)`);

    try {
      // 主调度循环
      while (!dag.isComplete() && this.isRunning) {
        // 检查暂停
        if (this.isPaused) {
          await this.waitForResume();
        }

        // 获取可执行任务
        const readyTasks = dag.getReadyTasks();

        // 计算当前可启动的任务数量
        const currentRunning = this.runningTasks.size;
        const slotsAvailable = this.config.maxParallelism - currentRunning;
        const tasksToStart = readyTasks.slice(0, slotsAvailable);

        // 更新最大并行度
        maxParallelism = Math.max(maxParallelism, currentRunning + tasksToStart.length);

        // 启动任务
        for (const task of tasksToStart) {
          this.startTask(task);
        }

        // 等待任一任务完成或间隔
        if (this.runningTasks.size > 0) {
          await Promise.race([
            ...this.runningTasks.values(),
            this.sleep(this.config.scheduleInterval),
          ]);
        } else if (readyTasks.length === 0) {
          // 没有可执行任务也没有运行中的任务
          await this.sleep(this.config.scheduleInterval);
        }

        // 清理已完成的任务
        this.cleanupCompletedTasks();
      }

      // 等待所有运行中的任务完成
      if (this.runningTasks.size > 0) {
        await Promise.all(this.runningTasks.values());
      }

      // 设置最终状态
      if (dag.isSuccessful()) {
        dag.setStatus('completed');
      } else if (dag.getFailedTasks().length > 0) {
        dag.setStatus('failed');
      }

    } catch (error) {
      logger.error('DAG execution error', { error });
      dag.setStatus('failed');
      throw error;
    } finally {
      this.isRunning = false;
    }

    const totalDuration = Date.now() - startTime;
    const errors = dag.getFailedTasks().map(t => ({
      taskId: t.id,
      error: t.failure?.message || 'Unknown error',
    }));

    const result: SchedulerResult = {
      success: dag.isSuccessful(),
      dag,
      totalDuration,
      maxParallelism,
      completedTasks: dag.getCompletedTasks().length,
      failedTasks: dag.getFailedTasks().length,
      errors,
    };

    logger.info(`DAG execution completed: ${dag.getName()}`, {
      success: result.success,
      duration: totalDuration,
      completed: result.completedTasks,
      failed: result.failedTasks,
    });

    return result;
  }

  /**
   * 启动单个任务
   */
  private startTask(task: DAGTask): void {
    if (this.runningTasks.has(task.id)) {
      return;
    }

    const promise = this.executeTask(task);
    this.runningTasks.set(task.id, promise);

    logger.debug(`Task started: ${task.id} (${task.type})`);
  }

  /**
   * 执行单个任务
   */
  private async executeTask(task: DAGTask): Promise<void> {
    const dag = this.currentDAG!;
    const context = this.context!;

    // 标记任务开始
    dag.startTask(task.id);

    try {
      // 构建执行上下文
      const execContext: TaskExecutionContext = {
        dependencyOutputs: this.getDependencyOutputs(task),
        sharedData: dag.getAllSharedData(),
        workingDirectory: context.workingDirectory,
        remainingBudget: context.remainingBudget,
      };

      // 创建超时 Promise
      const timeout = task.timeout || this.config.defaultTimeout;
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error(`Task timeout after ${timeout}ms`)), timeout);
      });

      // 执行任务
      let output: TaskOutput;
      const executionPromise = this.executeTaskByType(task, execContext);
      output = await Promise.race([executionPromise, timeoutPromise]);

      // 保存输出
      this.taskOutputs.set(task.id, output);

      // 标记完成
      dag.completeTask(task.id, output);

      logger.debug(`Task completed: ${task.id}`, {
        iterations: output.iterations,
        toolsUsed: output.toolsUsed?.length,
      });

    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      const isTimeout = message.includes('timeout');

      dag.failTask(task.id, {
        message,
        retryable: !isTimeout && task.metadata.retryCount < task.metadata.maxRetries,
        stack: error instanceof Error ? error.stack : undefined,
      });

      logger.error(`Task failed: ${task.id}`, { error: message });
    }
  }

  /**
   * 根据任务类型执行
   */
  private async executeTaskByType(
    task: DAGTask,
    context: TaskExecutionContext
  ): Promise<TaskOutput> {
    // 检查自定义执行器
    const customExecutor = this.customExecutors.get(task.type);
    if (customExecutor) {
      return customExecutor(task, context);
    }

    switch (task.type) {
      case 'agent':
        return this.executeAgentTask(task, context);
      case 'shell':
        return this.executeShellTask(task, context);
      case 'checkpoint':
        return this.executeCheckpointTask(task, context);
      default:
        throw new Error(`Unsupported task type: ${task.type}`);
    }
  }

  /**
   * 执行 Agent 任务
   */
  private async executeAgentTask(
    task: DAGTask,
    context: TaskExecutionContext
  ): Promise<TaskOutput> {
    const config = task.config as AgentTaskConfig;
    const schedContext = this.context!;

    // 解析 Agent 配置
    const agentConfig = getPredefinedAgent(config.role);

    if (!agentConfig) {
      throw new Error(`Unknown agent role: ${config.role}`);
    }

    // 构建增强的 prompt，包含依赖任务的输出
    let enhancedPrompt = config.prompt;
    if (this.config.enableOutputPassing && context.dependencyOutputs.size > 0) {
      enhancedPrompt += '\n\n---\n**Context from previous tasks:**\n';
      for (const [depId, output] of context.dependencyOutputs) {
        enhancedPrompt += `\n### ${depId} output:\n${output.text}\n`;
        if (output.data) {
          enhancedPrompt += `\n**Structured data:**\n\`\`\`json\n${JSON.stringify(output.data, null, 2)}\n\`\`\`\n`;
        }
      }
    }

    // 执行 Agent
    const executor = getSubagentExecutor();
    const result = await executor.execute(
      enhancedPrompt,
      {
        name: task.name,
        systemPrompt: config.systemPrompt || getAgentPrompt(agentConfig),
        availableTools: config.tools || getAgentTools(agentConfig),
        maxIterations: config.maxIterations || getAgentMaxIterations(agentConfig),
      },
      {
        modelConfig: schedContext.modelConfig,
        toolRegistry: schedContext.toolRegistry,
        toolContext: schedContext.toolContext,
        // 传递父工具调用 ID，用于 subagent 消息追踪
        parentToolUseId: schedContext.toolContext.currentToolCallId,
      }
    );

    return {
      text: result.output,
      data: this.extractStructuredData(result.output),
      toolsUsed: result.toolsUsed,
      iterations: result.iterations,
    };
  }

  /**
   * 执行 Shell 任务
   */
  private async executeShellTask(
    task: DAGTask,
    context: TaskExecutionContext
  ): Promise<TaskOutput> {
    const config = task.config as ShellTaskConfig;

    const { stdout, stderr } = await execAsync(config.command, {
      cwd: config.cwd || context.workingDirectory,
      env: { ...process.env, ...config.env },
      timeout: task.timeout || this.config.defaultTimeout,
    });

    return {
      text: stdout + (stderr ? `\n[stderr]: ${stderr}` : ''),
    };
  }

  /**
   * 执行检查点任务
   */
  private async executeCheckpointTask(
    task: DAGTask,
    context: TaskExecutionContext
  ): Promise<TaskOutput> {
    const config = task.config as CheckpointTaskConfig;
    const dag = this.currentDAG!;

    // 检查依赖任务状态
    const depStatuses: string[] = [];
    let allSuccess = true;

    for (const depId of task.dependencies) {
      const depTask = dag.getTask(depId);
      if (depTask) {
        depStatuses.push(`${depId}: ${depTask.status}`);
        if (depTask.status !== 'completed') {
          allSuccess = false;
        }
      }
    }

    if (config.requireAllSuccess && !allSuccess) {
      throw new Error(`Checkpoint "${config.name}" failed: not all dependencies completed successfully`);
    }

    // 收集输出
    const collectedData: Record<string, unknown> = {};
    if (config.collectOutputs) {
      for (const [depId, output] of context.dependencyOutputs) {
        collectedData[depId] = {
          text: output.text.substring(0, 500), // 截断长文本
          data: output.data,
        };
      }
    }

    return {
      text: `Checkpoint "${config.name}" passed.\nDependency statuses:\n${depStatuses.join('\n')}`,
      data: collectedData,
    };
  }

  /**
   * 获取依赖任务的输出
   */
  private getDependencyOutputs(task: DAGTask): Map<string, TaskOutput> {
    const outputs = new Map<string, TaskOutput>();

    for (const depId of task.dependencies) {
      const output = this.taskOutputs.get(depId);
      if (output) {
        outputs.set(depId, output);
      }
    }

    return outputs;
  }

  /**
   * 从文本中提取结构化数据
   */
  private extractStructuredData(output: string): Record<string, unknown> | undefined {
    // 尝试提取 JSON 代码块
    const jsonMatch = output.match(/```json\s*([\s\S]*?)\s*```/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[1]);
      } catch {
        // 忽略解析错误
      }
    }

    // 尝试直接解析
    const trimmed = output.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        return JSON.parse(trimmed);
      } catch {
        // 忽略解析错误
      }
    }

    return undefined;
  }

  /**
   * 清理已完成的任务 Promise
   */
  private cleanupCompletedTasks(): void {
    const dag = this.currentDAG!;

    for (const [taskId] of this.runningTasks) {
      const task = dag.getTask(taskId);
      if (task && isTaskTerminal(task.status)) {
        this.runningTasks.delete(taskId);
      }
    }
  }

  // ============================================================================
  // Control Methods
  // ============================================================================

  /**
   * 暂停执行
   */
  pause(): void {
    if (this.isRunning && !this.isPaused) {
      this.isPaused = true;
      this.currentDAG?.setStatus('paused');
      logger.info('DAG execution paused');
    }
  }

  /**
   * 恢复执行
   */
  resume(): void {
    if (this.isPaused) {
      this.isPaused = false;
      this.currentDAG?.setStatus('running');
      logger.info('DAG execution resumed');
    }
  }

  /**
   * 取消执行
   */
  cancel(): void {
    if (this.isRunning) {
      this.isRunning = false;
      this.isPaused = false;

      // 取消所有未完成的任务
      const dag = this.currentDAG;
      if (dag) {
        for (const task of dag.getAllTasks()) {
          if (!isTaskTerminal(task.status)) {
            dag.cancelTask(task.id);
          }
        }
        dag.setStatus('cancelled');
      }

      logger.info('DAG execution cancelled');
    }
  }

  /**
   * 等待恢复
   */
  private async waitForResume(): Promise<void> {
    while (this.isPaused && this.isRunning) {
      await this.sleep(100);
    }
  }

  /**
   * 睡眠
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // ============================================================================
  // Event Forwarding
  // ============================================================================

  /**
   * 转发 DAG 事件
   */
  private forwardDAGEvents(dag: TaskDAG): void {
    const eventTypes: DAGEventType[] = [
      'dag:start',
      'dag:complete',
      'dag:failed',
      'dag:cancelled',
      'dag:paused',
      'dag:resumed',
      'task:ready',
      'task:start',
      'task:complete',
      'task:failed',
      'task:retry',
      'task:cancelled',
      'task:skipped',
      'progress:update',
    ];

    for (const eventType of eventTypes) {
      dag.on(eventType, (event: DAGEvent) => {
        this.emit(eventType, event);
      });
    }
  }

  // ============================================================================
  // Status
  // ============================================================================

  /**
   * 获取运行状态
   */
  isExecuting(): boolean {
    return this.isRunning;
  }

  /**
   * 获取暂停状态
   */
  isPausedState(): boolean {
    return this.isPaused;
  }

  /**
   * 获取当前运行任务数
   */
  getRunningTaskCount(): number {
    return this.runningTasks.size;
  }

  /**
   * 获取当前 DAG
   */
  getCurrentDAG(): TaskDAG | undefined {
    return this.currentDAG;
  }
}

// ============================================================================
// Singleton
// ============================================================================

let schedulerInstance: DAGScheduler | null = null;

/**
 * 获取 DAGScheduler 单例
 */
export function getDAGScheduler(): DAGScheduler {
  if (!schedulerInstance) {
    schedulerInstance = new DAGScheduler();
  }
  return schedulerInstance;
}

/**
 * 初始化 DAGScheduler（带配置）
 */
export function initDAGScheduler(config: Partial<DAGSchedulerConfig>): DAGScheduler {
  schedulerInstance = new DAGScheduler(config);
  return schedulerInstance;
}

/**
 * 重置 DAGScheduler（用于测试）
 */
export function resetDAGScheduler(): void {
  schedulerInstance = null;
}
