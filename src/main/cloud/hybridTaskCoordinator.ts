// ============================================================================
// HybridTaskCoordinator - 混合任务协调器
// 智能协调本地和云端任务执行，支持任务拆分和并行处理
// ============================================================================

import { EventEmitter } from 'events';
import { getCloudTaskService, CloudTaskService } from './cloudTaskService';
import { getTaskRouter, TaskRouter } from './taskRouter';
import { getSubagentExecutor } from '../agent/subagentExecutor';
import type {
  CloudTask,
  CreateCloudTaskRequest,
  TaskExecutionLocation,
  TaskExecutionResult,
  CloudAgentType,
  HybridTaskConfig,
  TaskProgressEvent,
} from '../../shared/types/cloud';
import type { ModelConfig } from '../../shared/types';
import type { Tool, ToolContext } from '../tools/toolRegistry';
import { CLOUD, TASK_ANALYSIS, RETRY } from '../../shared/constants';

// ============================================================================
// 类型定义
// ============================================================================

export interface HybridExecutionPlan {
  taskId: string;
  originalRequest: CreateCloudTaskRequest;
  subtasks: SubtaskPlan[];
  dependencies: Map<string, string[]>; // subtaskId -> dependsOn[]
  estimatedDuration: number;
}

export interface SubtaskPlan {
  id: string;
  parentTaskId: string;
  location: TaskExecutionLocation;
  type: CloudAgentType;
  prompt: string;
  priority: number;
  estimatedDuration: number;
}

export interface ExecutionState {
  taskId: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  localProgress: number;
  cloudProgress: number;
  subtaskResults: Map<string, TaskExecutionResult>;
  errors: string[];
  startTime: number;
  endTime?: number;
}

export interface CoordinatorConfig {
  maxLocalConcurrent: number;
  maxCloudConcurrent: number;
  localTimeout: number;
  cloudTimeout: number;
  autoSplitThreshold: number; // 自动拆分的复杂度阈值
  preferLocalForSensitive: boolean;
}

const DEFAULT_CONFIG: CoordinatorConfig = {
  maxLocalConcurrent: 2,
  maxCloudConcurrent: 3,
  localTimeout: CLOUD.LOCAL_EXECUTION_TIMEOUT,
  cloudTimeout: CLOUD.CLOUD_EXECUTION_TIMEOUT,
  autoSplitThreshold: TASK_ANALYSIS.AUTO_SPLIT_THRESHOLD,
  preferLocalForSensitive: true,
};

// ============================================================================
// HybridTaskCoordinator
// ============================================================================

export class HybridTaskCoordinator extends EventEmitter {
  private config: CoordinatorConfig;
  private cloudService: CloudTaskService;
  private router: TaskRouter;
  private executionStates: Map<string, ExecutionState> = new Map();
  private runningLocal: Set<string> = new Set();
  private runningCloud: Set<string> = new Set();
  private modelConfig?: ModelConfig;
  private toolRegistry?: Map<string, Tool>;
  private toolContext?: ToolContext;

  constructor(config: Partial<CoordinatorConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.cloudService = getCloudTaskService();
    this.router = getTaskRouter();

    // 监听云端任务事件
    this.setupCloudServiceListeners();
  }

  /**
   * 初始化协调器
   */
  initialize(context: {
    modelConfig: ModelConfig;
    toolRegistry: Map<string, Tool>;
    toolContext: ToolContext;
  }): void {
    this.modelConfig = context.modelConfig;
    this.toolRegistry = context.toolRegistry;
    this.toolContext = context.toolContext;
  }

  // --------------------------------------------------------------------------
  // 任务执行
  // --------------------------------------------------------------------------

  /**
   * 执行混合任务
   */
  async execute(request: CreateCloudTaskRequest): Promise<TaskExecutionResult> {
    // 路由决策
    const routing = this.router.route(request);
    const location = request.location || routing.recommendedLocation;

    // 创建执行状态
    const taskId = `hybrid_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const state: ExecutionState = {
      taskId,
      status: 'pending',
      localProgress: 0,
      cloudProgress: 0,
      subtaskResults: new Map(),
      errors: [],
      startTime: Date.now(),
    };
    this.executionStates.set(taskId, state);

    try {
      let result: TaskExecutionResult;

      switch (location) {
        case 'local':
          result = await this.executeLocal(taskId, request);
          break;
        case 'cloud':
          result = await this.executeCloud(taskId, request);
          break;
        case 'hybrid':
          result = await this.executeHybrid(taskId, request);
          break;
        default:
          result = await this.executeLocal(taskId, request);
      }

      state.status = result.success ? 'completed' : 'failed';
      state.endTime = Date.now();

      return result;
    } catch (error) {
      state.status = 'failed';
      state.endTime = Date.now();
      state.errors.push(error instanceof Error ? error.message : 'Unknown error');

      return {
        taskId,
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        duration: Date.now() - state.startTime,
        iterations: 0,
        toolsUsed: [],
      };
    }
  }

  /**
   * 本地执行
   */
  private async executeLocal(
    taskId: string,
    request: CreateCloudTaskRequest
  ): Promise<TaskExecutionResult> {
    // 检查并发限制
    while (this.runningLocal.size >= this.config.maxLocalConcurrent) {
      await this.sleep(RETRY.POLL_INTERVAL);
    }

    this.runningLocal.add(taskId);
    const state = this.executionStates.get(taskId)!;
    state.status = 'running';

    try {
      const executor = getSubagentExecutor();

      // 获取 Agent 配置
      const agentConfig = this.getAgentConfig(request.type);

      // 执行
      const result = await executor.execute(
        request.prompt,
        {
          name: agentConfig.name,
          systemPrompt: agentConfig.systemPrompt,
          availableTools: agentConfig.tools,
          maxIterations: request.maxIterations || 20,
        },
        {
          modelConfig: this.modelConfig!,
          toolRegistry: this.toolRegistry!,
          toolContext: this.toolContext!,
        }
      );

      state.localProgress = 100;

      return {
        taskId,
        success: result.success,
        output: result.output,
        error: result.error,
        duration: Date.now() - state.startTime,
        iterations: result.iterations,
        toolsUsed: result.toolsUsed,
      };
    } finally {
      this.runningLocal.delete(taskId);
    }
  }

  /**
   * 云端执行
   */
  private async executeCloud(
    taskId: string,
    request: CreateCloudTaskRequest
  ): Promise<TaskExecutionResult> {
    // 检查并发限制
    while (this.runningCloud.size >= this.config.maxCloudConcurrent) {
      await this.sleep(RETRY.POLL_INTERVAL);
    }

    this.runningCloud.add(taskId);
    const state = this.executionStates.get(taskId)!;
    state.status = 'running';

    try {
      // 创建云端任务
      const cloudTask = await this.cloudService.createTask({
        ...request,
        location: 'cloud',
      });

      // 启动任务
      await this.cloudService.startTask(cloudTask.id);

      // 等待完成
      const result = await this.waitForCloudCompletion(cloudTask.id);

      state.cloudProgress = 100;

      return {
        taskId,
        success: result.status === 'completed',
        output: result.result,
        error: result.error,
        duration: Date.now() - state.startTime,
        iterations: (result.metadata?.iterations as number) || 0,
        toolsUsed: (result.metadata?.toolsUsed as string[]) || [],
      };
    } finally {
      this.runningCloud.delete(taskId);
    }
  }

  /**
   * 混合执行（拆分任务）
   */
  private async executeHybrid(
    taskId: string,
    request: CreateCloudTaskRequest
  ): Promise<TaskExecutionResult> {
    const state = this.executionStates.get(taskId)!;
    state.status = 'running';

    // 分析并拆分任务
    const plan = this.createExecutionPlan(taskId, request);

    // 按依赖顺序执行子任务
    const sortedSubtasks = this.sortByDependencies(plan);

    const results: TaskExecutionResult[] = [];
    const outputs: string[] = [];

    for (const group of sortedSubtasks) {
      // 并行执行同一组的任务
      const groupResults = await Promise.all(
        group.map((subtask) => this.executeSubtask(subtask))
      );

      results.push(...groupResults);

      for (const result of groupResults) {
        if (result.success && result.output) {
          outputs.push(result.output);
        }
        state.subtaskResults.set(result.taskId, result);
      }

      // 检查是否有失败
      const failed = groupResults.find((r) => !r.success);
      if (failed) {
        return {
          taskId,
          success: false,
          error: `Subtask failed: ${failed.error}`,
          duration: Date.now() - state.startTime,
          iterations: results.reduce((sum, r) => sum + r.iterations, 0),
          toolsUsed: [...new Set(results.flatMap((r) => r.toolsUsed))],
        };
      }
    }

    // 聚合结果
    const aggregatedOutput = this.aggregateResults(outputs, request.type);

    return {
      taskId,
      success: true,
      output: aggregatedOutput,
      duration: Date.now() - state.startTime,
      iterations: results.reduce((sum, r) => sum + r.iterations, 0),
      toolsUsed: [...new Set(results.flatMap((r) => r.toolsUsed))],
    };
  }

  /**
   * 执行子任务
   */
  private async executeSubtask(subtask: SubtaskPlan): Promise<TaskExecutionResult> {
    const request: CreateCloudTaskRequest = {
      type: subtask.type,
      title: `Subtask: ${subtask.id}`,
      description: '',
      prompt: subtask.prompt,
      location: subtask.location,
    };

    if (subtask.location === 'local') {
      return this.executeLocal(subtask.id, request);
    } else {
      return this.executeCloud(subtask.id, request);
    }
  }

  // --------------------------------------------------------------------------
  // 任务拆分
  // --------------------------------------------------------------------------

  /**
   * 创建执行计划
   */
  private createExecutionPlan(
    taskId: string,
    request: CreateCloudTaskRequest
  ): HybridExecutionPlan {
    const subtasks: SubtaskPlan[] = [];
    const dependencies = new Map<string, string[]>();

    // 分析 prompt 并拆分
    const parts = this.analyzeAndSplitPrompt(request.prompt, request.type);

    let prevSubtaskId: string | null = null;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const subtaskId = `${taskId}_sub_${i}`;

      // 决定子任务位置
      const location = this.decideSubtaskLocation(part, request.type);

      subtasks.push({
        id: subtaskId,
        parentTaskId: taskId,
        location,
        type: part.type || request.type,
        prompt: part.prompt,
        priority: parts.length - i, // 越靠前优先级越高
        estimatedDuration: part.estimatedDuration || TASK_ANALYSIS.DEFAULT_ESTIMATED_DURATION,
      });

      // 设置依赖
      if (part.dependsOnPrevious && prevSubtaskId) {
        dependencies.set(subtaskId, [prevSubtaskId]);
      } else {
        dependencies.set(subtaskId, []);
      }

      prevSubtaskId = subtaskId;
    }

    return {
      taskId,
      originalRequest: request,
      subtasks,
      dependencies,
      estimatedDuration: subtasks.reduce((sum, s) => sum + s.estimatedDuration, 0),
    };
  }

  /**
   * 分析并拆分 prompt
   */
  private analyzeAndSplitPrompt(
    prompt: string,
    type: CloudAgentType
  ): Array<{
    prompt: string;
    type?: CloudAgentType;
    dependsOnPrevious: boolean;
    estimatedDuration?: number;
  }> {
    // 简单的拆分逻辑 - 按段落或步骤拆分
    const parts: Array<{
      prompt: string;
      type?: CloudAgentType;
      dependsOnPrevious: boolean;
      estimatedDuration?: number;
    }> = [];

    // 检查是否包含步骤标记
    const stepPatterns = [
      /(?:^|\n)(?:第?\s*[1-9一二三四五六七八九十]+[\.、:：\s])/gi,
      /(?:^|\n)(?:step\s*\d+[\.:\s])/gi,
      /(?:^|\n)(?:首先|然后|接着|最后|finally|first|then|next|lastly)/gi,
    ];

    const hasSteps = stepPatterns.some((p) => p.test(prompt));

    if (hasSteps) {
      // 按步骤拆分
      const segments = prompt.split(/(?=(?:第?\s*[1-9一二三四五六七八九十]+[\.、:：\s])|(?:step\s*\d+[\.:\s])|(?:首先|然后|接着|最后))/gi);

      for (let i = 0; i < segments.length; i++) {
        const segment = segments[i].trim();
        if (segment.length > TASK_ANALYSIS.MIN_SEGMENT_LENGTH) {
          parts.push({
            prompt: segment,
            dependsOnPrevious: i > 0,
            estimatedDuration: Math.max(TASK_ANALYSIS.MIN_ESTIMATED_DURATION, segment.length * 100),
          });
        }
      }
    } else if (prompt.length > this.config.autoSplitThreshold * TASK_ANALYSIS.LONG_PROMPT_MULTIPLIER) {
      // 长 prompt 按段落拆分
      const paragraphs = prompt.split(/\n\n+/);

      for (let i = 0; i < paragraphs.length; i++) {
        const para = paragraphs[i].trim();
        if (para.length > TASK_ANALYSIS.MIN_PARAGRAPH_LENGTH) {
          parts.push({
            prompt: para,
            dependsOnPrevious: false, // 段落通常可以并行
            estimatedDuration: Math.max(TASK_ANALYSIS.MIN_ESTIMATED_DURATION, para.length * 100),
          });
        }
      }
    }

    // 如果没有拆分出多个部分，返回整个 prompt
    if (parts.length === 0) {
      parts.push({
        prompt,
        dependsOnPrevious: false,
        estimatedDuration: Math.max(TASK_ANALYSIS.DEFAULT_ESTIMATED_DURATION, prompt.length * 100),
      });
    }

    return parts;
  }

  /**
   * 决定子任务执行位置
   */
  private decideSubtaskLocation(
    part: { prompt: string },
    parentType: CloudAgentType
  ): TaskExecutionLocation {
    const prompt = part.prompt.toLowerCase();

    // 检查敏感内容
    const sensitivePatterns = [
      /password|secret|token|credential|api[_-]?key/i,
      /密码|密钥|凭证/,
    ];

    if (this.config.preferLocalForSensitive) {
      for (const pattern of sensitivePatterns) {
        if (pattern.test(prompt)) {
          return 'local';
        }
      }
    }

    // 检查是否需要本地资源
    const localPatterns = [
      /read|write|file|directory|folder/i,
      /npm|yarn|git|docker|shell|bash/i,
      /读取|写入|文件|目录|执行|运行/,
    ];

    for (const pattern of localPatterns) {
      if (pattern.test(prompt)) {
        return 'local';
      }
    }

    // 默认使用云端
    return 'cloud';
  }

  /**
   * 按依赖关系排序子任务
   */
  private sortByDependencies(plan: HybridExecutionPlan): SubtaskPlan[][] {
    const groups: SubtaskPlan[][] = [];
    const completed = new Set<string>();
    const remaining = [...plan.subtasks];

    while (remaining.length > 0) {
      // 找出所有依赖已完成的任务
      const ready = remaining.filter((task) => {
        const deps = plan.dependencies.get(task.id) || [];
        return deps.every((d) => completed.has(d));
      });

      if (ready.length === 0) {
        // 循环依赖或错误，添加所有剩余任务
        groups.push(remaining);
        break;
      }

      groups.push(ready);

      for (const task of ready) {
        completed.add(task.id);
        const idx = remaining.indexOf(task);
        if (idx !== -1) remaining.splice(idx, 1);
      }
    }

    return groups;
  }

  // --------------------------------------------------------------------------
  // 结果聚合
  // --------------------------------------------------------------------------

  /**
   * 聚合子任务结果
   */
  private aggregateResults(outputs: string[], type: CloudAgentType): string {
    if (outputs.length === 0) return '';
    if (outputs.length === 1) return outputs[0];

    // 根据任务类型选择聚合策略
    switch (type) {
      case 'researcher':
        return this.aggregateResearchResults(outputs);
      case 'analyzer':
        return this.aggregateAnalysisResults(outputs);
      case 'writer':
        return outputs.join('\n\n');
      case 'reviewer':
        return this.aggregateReviewResults(outputs);
      case 'planner':
        return this.aggregatePlanResults(outputs);
      default:
        return outputs.join('\n\n---\n\n');
    }
  }

  private aggregateResearchResults(outputs: string[]): string {
    return `## Research Summary\n\n${outputs.map((o, i) => `### Finding ${i + 1}\n${o}`).join('\n\n')}`;
  }

  private aggregateAnalysisResults(outputs: string[]): string {
    return `## Analysis Results\n\n${outputs.join('\n\n---\n\n')}`;
  }

  private aggregateReviewResults(outputs: string[]): string {
    return `## Code Review Summary\n\n${outputs.map((o, i) => `### Review ${i + 1}\n${o}`).join('\n\n')}`;
  }

  private aggregatePlanResults(outputs: string[]): string {
    return `## Execution Plan\n\n${outputs.join('\n\n')}`;
  }

  // --------------------------------------------------------------------------
  // 辅助方法
  // --------------------------------------------------------------------------

  /**
   * 获取 Agent 配置
   */
  private getAgentConfig(type: CloudAgentType): {
    name: string;
    systemPrompt: string;
    tools: string[];
  } {
    const configs: Record<CloudAgentType, { name: string; systemPrompt: string; tools: string[] }> = {
      researcher: {
        name: 'Researcher',
        systemPrompt: 'You are a research specialist. Search, analyze, and summarize information effectively.',
        tools: ['web_fetch', 'grep', 'glob'],
      },
      analyzer: {
        name: 'Analyzer',
        systemPrompt: 'You are a code analyzer. Examine code structure, patterns, and potential issues.',
        tools: ['read_file', 'grep', 'glob', 'list_directory'],
      },
      writer: {
        name: 'Writer',
        systemPrompt: 'You are a technical writer. Create clear, well-structured documentation and content.',
        tools: ['read_file', 'write_file'],
      },
      reviewer: {
        name: 'Reviewer',
        systemPrompt: 'You are a code reviewer. Review code for bugs, security issues, and best practices.',
        tools: ['read_file', 'grep', 'glob'],
      },
      planner: {
        name: 'Planner',
        systemPrompt: 'You are a task planner. Break down complex tasks and create structured execution plans.',
        tools: ['todo_write', 'read_file', 'glob'],
      },
    };

    return configs[type] || configs.analyzer;
  }

  /**
   * 等待云端任务完成
   */
  private async waitForCloudCompletion(
    taskId: string,
    timeout = this.config.cloudTimeout
  ): Promise<CloudTask> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      const task = await this.cloudService.getTask(taskId);
      if (!task) {
        throw new Error('Task not found');
      }

      if (['completed', 'failed', 'cancelled'].includes(task.status)) {
        return task;
      }

      await this.sleep(RETRY.CLOUD_WAIT_INTERVAL);
    }

    throw new Error('Cloud task timeout');
  }

  /**
   * 设置云端服务监听器
   */
  private setupCloudServiceListeners(): void {
    this.cloudService.on('task:progress', (event: TaskProgressEvent) => {
      const state = this.findStateByCloudTask(event.taskId);
      if (state) {
        state.cloudProgress = event.progress;
        this.emit('progress', {
          taskId: state.taskId,
          localProgress: state.localProgress,
          cloudProgress: state.cloudProgress,
          overallProgress: (state.localProgress + state.cloudProgress) / 2,
        });
      }
    });
  }

  /**
   * 根据云端任务 ID 查找执行状态
   */
  private findStateByCloudTask(cloudTaskId: string): ExecutionState | undefined {
    for (const [, state] of this.executionStates) {
      if (state.subtaskResults.has(cloudTaskId)) {
        return state;
      }
    }
    return undefined;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * 获取执行状态
   */
  getExecutionState(taskId: string): ExecutionState | undefined {
    return this.executionStates.get(taskId);
  }

  /**
   * 清理资源
   */
  dispose(): void {
    this.executionStates.clear();
    this.runningLocal.clear();
    this.runningCloud.clear();
    this.removeAllListeners();
  }
}

// ============================================================================
// 单例实例
// ============================================================================

let coordinatorInstance: HybridTaskCoordinator | null = null;

export function getHybridTaskCoordinator(): HybridTaskCoordinator {
  if (!coordinatorInstance) {
    coordinatorInstance = new HybridTaskCoordinator();
  }
  return coordinatorInstance;
}

export function initHybridTaskCoordinator(
  config: Partial<CoordinatorConfig>
): HybridTaskCoordinator {
  coordinatorInstance = new HybridTaskCoordinator(config);
  return coordinatorInstance;
}
