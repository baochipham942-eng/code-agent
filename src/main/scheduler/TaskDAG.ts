// ============================================================================
// TaskDAG - Core DAG data structure with topological operations
// Session 4: Task DAG + Parallel Scheduling
// ============================================================================

import { EventEmitter } from 'events';
import type {
  DAGTask,
  DAGTaskType,
  TaskStatus,
  TaskPriority,
  TaskConfig,
  TaskMetadata,
  TaskOutput,
  TaskFailure,
  TaskDAGDefinition,
  TaskDAGState,
  DAGStatus,
  DAGStatistics,
  DAGOptions,
  DAGEvent,
  DAGEventType,
  AgentTaskConfig,
  ShellTaskConfig,
} from '../../shared/types/taskDAG';
import {
  DEFAULT_DAG_OPTIONS,
  createDefaultMetadata,
  isTaskTerminal,
  getPriorityValue,
  getNextTaskStatus,
} from '../../shared/types/taskDAG';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('TaskDAG');

// ============================================================================
// TaskDAG Class
// ============================================================================

/**
 * TaskDAG - 任务依赖图核心类
 *
 * 提供：
 * 1. DAG 构建和验证
 * 2. 拓扑排序和关键路径分析
 * 3. 任务状态管理
 * 4. 事件驱动的状态更新
 *
 * @example
 * ```typescript
 * const dag = new TaskDAG('my-dag', 'My Workflow');
 *
 * // 添加任务
 * dag.addAgentTask('analyze', { role: 'architect', prompt: '分析代码结构' });
 * dag.addAgentTask('implement', { role: 'coder', prompt: '实现功能' });
 * dag.addAgentTask('test', { role: 'tester', prompt: '编写测试' });
 *
 * // 建立依赖关系
 * dag.addDependency('implement', 'analyze');
 * dag.addDependency('test', 'implement');
 *
 * // 验证 DAG
 * const validation = dag.validate();
 * if (!validation.valid) {
 *   console.error(validation.errors);
 * }
 *
 * // 获取可执行任务
 * const readyTasks = dag.getReadyTasks();
 * ```
 */
export class TaskDAG extends EventEmitter {
  private id: string;
  private name: string;
  private description?: string;
  private options: DAGOptions;

  // 任务存储
  private tasks: Map<string, DAGTask> = new Map();

  // 状态
  private status: DAGStatus = 'idle';
  private startedAt?: number;
  private completedAt?: number;
  private sharedContext: Map<string, unknown> = new Map();

  // 缓存
  private topologicalOrder?: string[];
  private criticalPath?: string[];
  private isDirty = true; // 标记是否需要重新计算拓扑

  constructor(
    id: string,
    name: string,
    options: Partial<DAGOptions> = {}
  ) {
    super();
    this.id = id;
    this.name = name;
    this.options = { ...DEFAULT_DAG_OPTIONS, ...options };
  }

  // ============================================================================
  // Task Management
  // ============================================================================

  /**
   * 添加通用任务
   */
  addTask(task: DAGTask): this {
    if (this.tasks.has(task.id)) {
      throw new Error(`Task "${task.id}" already exists`);
    }

    // 验证依赖是否存在
    for (const depId of task.dependencies) {
      if (!this.tasks.has(depId)) {
        throw new Error(`Dependency "${depId}" not found for task "${task.id}"`);
      }
    }

    // 添加任务
    this.tasks.set(task.id, task);

    // 更新被依赖任务的 dependents 列表
    for (const depId of task.dependencies) {
      const depTask = this.tasks.get(depId)!;
      if (!depTask.dependents.includes(task.id)) {
        depTask.dependents.push(task.id);
      }
    }

    this.markDirty();
    logger.debug(`Task added: ${task.id} (${task.type})`);

    return this;
  }

  /**
   * 添加 Agent 任务（便捷方法）
   */
  addAgentTask(
    id: string,
    config: Omit<AgentTaskConfig, 'type'>,
    options: {
      name?: string;
      description?: string;
      priority?: TaskPriority;
      dependencies?: string[];
      timeout?: number;
      allowFailure?: boolean;
    } = {}
  ): this {
    const task: DAGTask = {
      id,
      name: options.name || id,
      description: options.description,
      type: 'agent',
      status: 'pending',
      priority: options.priority || 'normal',
      metadata: {
        ...createDefaultMetadata(),
        maxRetries: this.options.defaultMaxRetries,
      },
      dependencies: options.dependencies || [],
      dependents: [],
      config: { type: 'agent', ...config },
      timeout: options.timeout || this.options.defaultTimeout,
      allowFailure: options.allowFailure,
    };

    return this.addTask(task);
  }

  /**
   * 添加 Shell 任务（便捷方法）
   */
  addShellTask(
    id: string,
    config: Omit<ShellTaskConfig, 'type'>,
    options: {
      name?: string;
      description?: string;
      priority?: TaskPriority;
      dependencies?: string[];
      timeout?: number;
      allowFailure?: boolean;
    } = {}
  ): this {
    const task: DAGTask = {
      id,
      name: options.name || id,
      description: options.description,
      type: 'shell',
      status: 'pending',
      priority: options.priority || 'normal',
      metadata: {
        ...createDefaultMetadata(),
        maxRetries: this.options.defaultMaxRetries,
      },
      dependencies: options.dependencies || [],
      dependents: [],
      config: { type: 'shell', ...config },
      timeout: options.timeout || this.options.defaultTimeout,
      allowFailure: options.allowFailure,
    };

    return this.addTask(task);
  }

  /**
   * 添加检查点任务（同步点）
   */
  addCheckpoint(
    id: string,
    dependencies: string[],
    options: {
      name?: string;
      requireAllSuccess?: boolean;
      collectOutputs?: boolean;
    } = {}
  ): this {
    const task: DAGTask = {
      id,
      name: options.name || `Checkpoint: ${id}`,
      type: 'checkpoint',
      status: 'pending',
      priority: 'normal',
      metadata: createDefaultMetadata(),
      dependencies,
      dependents: [],
      config: {
        type: 'checkpoint',
        name: id,
        requireAllSuccess: options.requireAllSuccess ?? true,
        collectOutputs: options.collectOutputs ?? true,
      },
    };

    return this.addTask(task);
  }

  /**
   * 添加依赖关系
   */
  addDependency(taskId: string, dependsOn: string): this {
    const task = this.tasks.get(taskId);
    const depTask = this.tasks.get(dependsOn);

    if (!task) {
      throw new Error(`Task "${taskId}" not found`);
    }
    if (!depTask) {
      throw new Error(`Dependency "${dependsOn}" not found`);
    }

    if (!task.dependencies.includes(dependsOn)) {
      task.dependencies.push(dependsOn);
      depTask.dependents.push(taskId);
      this.markDirty();
    }

    return this;
  }

  /**
   * 移除任务
   */
  removeTask(taskId: string): this {
    const task = this.tasks.get(taskId);
    if (!task) {
      return this;
    }

    // 从依赖任务的 dependents 中移除
    for (const depId of task.dependencies) {
      const depTask = this.tasks.get(depId);
      if (depTask) {
        depTask.dependents = depTask.dependents.filter(id => id !== taskId);
      }
    }

    // 从被依赖任务的 dependencies 中移除
    for (const depId of task.dependents) {
      const depTask = this.tasks.get(depId);
      if (depTask) {
        depTask.dependencies = depTask.dependencies.filter(id => id !== taskId);
      }
    }

    this.tasks.delete(taskId);
    this.markDirty();

    return this;
  }

  /**
   * 获取任务
   */
  getTask(taskId: string): DAGTask | undefined {
    return this.tasks.get(taskId);
  }

  /**
   * 获取所有任务
   */
  getAllTasks(): DAGTask[] {
    return Array.from(this.tasks.values());
  }

  // ============================================================================
  // Status Management
  // ============================================================================

  /**
   * 更新任务状态
   */
  updateTaskStatus(
    taskId: string,
    newStatus: TaskStatus,
    data?: {
      output?: TaskOutput;
      failure?: TaskFailure;
    }
  ): void {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Task "${taskId}" not found`);
    }

    const oldStatus = task.status;
    task.status = newStatus;

    // 更新元数据
    const now = Date.now();
    if (newStatus === 'running' && !task.metadata.startedAt) {
      task.metadata.startedAt = now;
    }
    if (isTaskTerminal(newStatus)) {
      task.metadata.completedAt = now;
      if (task.metadata.startedAt) {
        task.metadata.duration = now - task.metadata.startedAt;
      }
    }

    // 更新输出/失败信息
    if (data?.output) {
      task.output = data.output;
    }
    if (data?.failure) {
      task.failure = data.failure;
    }

    // 发送事件
    this.emitTaskEvent(taskId, oldStatus, newStatus);

    // 如果任务完成，检查依赖它的任务是否可以变为 ready
    if (newStatus === 'completed') {
      this.updateDependentStatuses(taskId);
    }

    // 如果任务失败，根据策略处理
    if (newStatus === 'failed') {
      this.handleTaskFailure(task);
    }

    logger.debug(`Task ${taskId} status: ${oldStatus} -> ${newStatus}`);
  }

  /**
   * 标记任务开始执行
   */
  startTask(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Task "${taskId}" not found`);
    }

    if (task.status !== 'ready') {
      throw new Error(`Task "${taskId}" is not ready (current: ${task.status})`);
    }

    this.updateTaskStatus(taskId, 'running');
  }

  /**
   * 标记任务完成
   */
  completeTask(taskId: string, output: TaskOutput): void {
    this.updateTaskStatus(taskId, 'completed', { output });
  }

  /**
   * 标记任务失败
   */
  failTask(taskId: string, failure: TaskFailure): void {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Task "${taskId}" not found`);
    }

    // 检查是否可以重试
    if (failure.retryable && task.metadata.retryCount < task.metadata.maxRetries) {
      task.metadata.retryCount++;
      task.status = 'ready';
      task.failure = failure;
      this.emitEvent('task:retry', taskId, { retryCount: task.metadata.retryCount });
      logger.info(`Task ${taskId} will retry (${task.metadata.retryCount}/${task.metadata.maxRetries})`);
    } else {
      this.updateTaskStatus(taskId, 'failed', { failure });
    }
  }

  /**
   * 取消任务
   */
  cancelTask(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (!task || isTaskTerminal(task.status)) {
      return;
    }

    this.updateTaskStatus(taskId, 'cancelled');
  }

  /**
   * 更新依赖任务的状态
   */
  private updateDependentStatuses(completedTaskId: string): void {
    const completedTask = this.tasks.get(completedTaskId);
    if (!completedTask) return;

    for (const depId of completedTask.dependents) {
      const depTask = this.tasks.get(depId);
      if (!depTask || depTask.status !== 'pending') continue;

      // 检查所有依赖是否都已完成
      const allDepsCompleted = depTask.dependencies.every(d => {
        const dep = this.tasks.get(d);
        return dep && (dep.status === 'completed' || dep.allowFailure);
      });

      if (allDepsCompleted) {
        depTask.status = 'ready';
        this.emitEvent('task:ready', depId);
      }
    }
  }

  /**
   * 处理任务失败
   */
  private handleTaskFailure(task: DAGTask): void {
    if (this.options.failureStrategy === 'fail-fast' && !task.allowFailure) {
      // 取消所有未完成的任务
      for (const [id, t] of this.tasks) {
        if (!isTaskTerminal(t.status) && id !== task.id) {
          t.status = 'cancelled';
          this.emitEvent('task:cancelled', id);
        }
      }
      this.status = 'failed';
      this.emitEvent('dag:failed', undefined, { failedTask: task.id });
    } else {
      // 标记依赖此任务的所有任务为 skipped
      this.skipDependents(task.id);
    }
  }

  /**
   * 跳过依赖失败任务的所有后续任务
   */
  private skipDependents(taskId: string): void {
    const failedTask = this.tasks.get(taskId);
    if (!failedTask) return;

    // 如果失败的任务有 allowFailure 标志，不需要跳过其依赖者
    // 而是检查它们是否可以变为 ready
    if (failedTask.allowFailure) {
      for (const depId of failedTask.dependents) {
        const depTask = this.tasks.get(depId);
        if (!depTask || depTask.status !== 'pending') continue;

        // 检查所有依赖是否都已满足（completed 或 allowFailure 的 failed）
        const allDepsSatisfied = depTask.dependencies.every(d => {
          const dep = this.tasks.get(d);
          return dep && (dep.status === 'completed' || (dep.status === 'failed' && dep.allowFailure));
        });

        if (allDepsSatisfied) {
          depTask.status = 'ready';
          this.emitEvent('task:ready', depId);
        }
      }
      return;
    }

    // 对于非 allowFailure 的失败任务，跳过其依赖者
    for (const depId of failedTask.dependents) {
      const depTask = this.tasks.get(depId);
      if (!depTask || isTaskTerminal(depTask.status)) continue;

      // 检查是否还有其他有效的依赖（未失败，或失败但有 allowFailure）
      const hasValidDep = depTask.dependencies.some(d => {
        const dep = this.tasks.get(d);
        if (!dep) return false;
        // 有效依赖：未失败/跳过，或者失败但允许失败
        return (dep.status !== 'failed' && dep.status !== 'skipped') ||
               (dep.status === 'failed' && dep.allowFailure);
      });

      if (!hasValidDep) {
        depTask.status = 'skipped';
        this.emitEvent('task:skipped', depId);
        // 递归跳过
        this.skipDependents(depId);
      }
    }
  }

  // ============================================================================
  // Query Methods
  // ============================================================================

  /**
   * 获取可执行的任务（状态为 ready 的任务）
   */
  getReadyTasks(): DAGTask[] {
    const ready: DAGTask[] = [];

    for (const task of this.tasks.values()) {
      if (task.status === 'ready') {
        ready.push(task);
      } else if (task.status === 'pending') {
        // 检查是否所有依赖都已完成
        const allDepsCompleted = task.dependencies.every(depId => {
          const dep = this.tasks.get(depId);
          return dep && (dep.status === 'completed' || dep.allowFailure);
        });

        if (allDepsCompleted) {
          task.status = 'ready';
          ready.push(task);
        }
      }
    }

    // 按优先级排序
    return ready.sort((a, b) => getPriorityValue(b.priority) - getPriorityValue(a.priority));
  }

  /**
   * 获取正在运行的任务
   */
  getRunningTasks(): DAGTask[] {
    return Array.from(this.tasks.values()).filter(t => t.status === 'running');
  }

  /**
   * 获取已完成的任务
   */
  getCompletedTasks(): DAGTask[] {
    return Array.from(this.tasks.values()).filter(t => t.status === 'completed');
  }

  /**
   * 获取失败的任务
   */
  getFailedTasks(): DAGTask[] {
    return Array.from(this.tasks.values()).filter(t => t.status === 'failed');
  }

  /**
   * 检查是否所有任务都已完成（包括失败、取消、跳过）
   */
  isComplete(): boolean {
    for (const task of this.tasks.values()) {
      if (!isTaskTerminal(task.status)) {
        return false;
      }
    }
    return true;
  }

  /**
   * 检查是否全部成功完成
   */
  isSuccessful(): boolean {
    for (const task of this.tasks.values()) {
      if (task.status !== 'completed' && !task.allowFailure) {
        return false;
      }
    }
    return true;
  }

  // ============================================================================
  // Topological Operations
  // ============================================================================

  /**
   * 获取拓扑排序
   * 使用 Kahn 算法
   */
  getTopologicalOrder(): string[] {
    if (!this.isDirty && this.topologicalOrder) {
      return this.topologicalOrder;
    }

    const result: string[] = [];
    const inDegree = new Map<string, number>();
    const queue: string[] = [];

    // 初始化入度
    for (const [id, task] of this.tasks) {
      inDegree.set(id, task.dependencies.length);
      if (task.dependencies.length === 0) {
        queue.push(id);
      }
    }

    // Kahn 算法
    while (queue.length > 0) {
      // 按优先级排序后取第一个
      queue.sort((a, b) => {
        const taskA = this.tasks.get(a)!;
        const taskB = this.tasks.get(b)!;
        return getPriorityValue(taskB.priority) - getPriorityValue(taskA.priority);
      });

      const current = queue.shift()!;
      result.push(current);

      const task = this.tasks.get(current)!;
      for (const depId of task.dependents) {
        const newDegree = inDegree.get(depId)! - 1;
        inDegree.set(depId, newDegree);
        if (newDegree === 0) {
          queue.push(depId);
        }
      }
    }

    // 检查是否有循环依赖
    if (result.length !== this.tasks.size) {
      throw new Error('Circular dependency detected in DAG');
    }

    this.topologicalOrder = result;
    this.isDirty = false;

    return result;
  }

  /**
   * 获取执行层级（同层可并行）
   */
  getExecutionLevels(): string[][] {
    const levels: string[][] = [];
    const completed = new Set<string>();
    const remaining = new Set(this.tasks.keys());

    while (remaining.size > 0) {
      const currentLevel: string[] = [];

      // 找出所有依赖已满足的任务
      for (const id of remaining) {
        const task = this.tasks.get(id)!;
        const allDepsCompleted = task.dependencies.every(d => completed.has(d));
        if (allDepsCompleted) {
          currentLevel.push(id);
        }
      }

      if (currentLevel.length === 0) {
        throw new Error('Circular dependency or invalid DAG');
      }

      // 按优先级排序
      currentLevel.sort((a, b) => {
        const taskA = this.tasks.get(a)!;
        const taskB = this.tasks.get(b)!;
        return getPriorityValue(taskB.priority) - getPriorityValue(taskA.priority);
      });

      levels.push(currentLevel);

      // 标记为已完成并从 remaining 移除
      for (const id of currentLevel) {
        completed.add(id);
        remaining.delete(id);
      }
    }

    return levels;
  }

  /**
   * 获取关键路径（最长路径）
   * 使用动态规划计算
   */
  getCriticalPath(): string[] {
    if (!this.isDirty && this.criticalPath) {
      return this.criticalPath;
    }

    const order = this.getTopologicalOrder();
    const dist = new Map<string, number>(); // 到达该任务的最长路径长度
    const prev = new Map<string, string>(); // 前驱节点

    // 初始化
    for (const id of order) {
      dist.set(id, 0);
    }

    // 动态规划计算最长路径
    for (const id of order) {
      const task = this.tasks.get(id)!;
      const currentDist = dist.get(id)!;
      const taskDuration = task.metadata.estimatedDuration || this.options.defaultTimeout;

      for (const depId of task.dependents) {
        const newDist = currentDist + taskDuration;
        if (newDist > (dist.get(depId) || 0)) {
          dist.set(depId, newDist);
          prev.set(depId, id);
        }
      }
    }

    // 找到最远的终点
    let maxDist = 0;
    let endNode = '';
    for (const [id, d] of dist) {
      if (d > maxDist) {
        maxDist = d;
        endNode = id;
      }
    }

    // 回溯构建关键路径
    const path: string[] = [];
    let current: string | undefined = endNode;
    while (current) {
      path.unshift(current);
      current = prev.get(current);
    }

    this.criticalPath = path;
    return path;
  }

  // ============================================================================
  // Validation
  // ============================================================================

  /**
   * 验证 DAG 的完整性
   */
  validate(): { valid: boolean; errors: string[]; warnings: string[] } {
    const errors: string[] = [];
    const warnings: string[] = [];

    // 1. 检查空 DAG
    if (this.tasks.size === 0) {
      errors.push('DAG is empty');
      return { valid: false, errors, warnings };
    }

    // 2. 检查循环依赖
    try {
      this.getTopologicalOrder();
    } catch {
      errors.push('Circular dependency detected');
    }

    // 3. 检查悬空依赖
    for (const task of this.tasks.values()) {
      for (const depId of task.dependencies) {
        if (!this.tasks.has(depId)) {
          errors.push(`Task "${task.id}" depends on non-existent task "${depId}"`);
        }
      }
    }

    // 4. 检查无入口点
    const hasEntryPoint = Array.from(this.tasks.values()).some(t => t.dependencies.length === 0);
    if (!hasEntryPoint) {
      errors.push('DAG has no entry point (all tasks have dependencies)');
    }

    // 5. 检查任务配置
    for (const task of this.tasks.values()) {
      if (task.type === 'agent') {
        const config = task.config as AgentTaskConfig;
        if (!config.role) {
          errors.push(`Agent task "${task.id}" missing role`);
        }
        if (!config.prompt) {
          errors.push(`Agent task "${task.id}" missing prompt`);
        }
      }
    }

    // 6. 警告：孤立任务（无依赖也无被依赖）
    for (const task of this.tasks.values()) {
      if (task.dependencies.length === 0 && task.dependents.length === 0 && this.tasks.size > 1) {
        warnings.push(`Task "${task.id}" is isolated (no dependencies or dependents)`);
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  // ============================================================================
  // Statistics
  // ============================================================================

  /**
   * 获取执行统计
   */
  getStatistics(): DAGStatistics {
    const tasks = Array.from(this.tasks.values());

    const stats: DAGStatistics = {
      totalTasks: tasks.length,
      completedTasks: tasks.filter(t => t.status === 'completed').length,
      failedTasks: tasks.filter(t => t.status === 'failed').length,
      skippedTasks: tasks.filter(t => t.status === 'skipped' || t.status === 'cancelled').length,
      runningTasks: tasks.filter(t => t.status === 'running').length,
      pendingTasks: tasks.filter(t => t.status === 'pending').length,
      readyTasks: tasks.filter(t => t.status === 'ready').length,
      totalDuration: this.completedAt && this.startedAt
        ? this.completedAt - this.startedAt
        : Date.now() - (this.startedAt || Date.now()),
      totalCost: tasks.reduce((sum, t) => sum + (t.metadata.cost || 0), 0),
      maxParallelism: this.getExecutionLevels().reduce((max, level) => Math.max(max, level.length), 0),
    };

    // 计算关键路径耗时
    try {
      const criticalPath = this.getCriticalPath();
      stats.criticalPathDuration = criticalPath.reduce((sum, id) => {
        const task = this.tasks.get(id);
        return sum + (task?.metadata.duration || task?.metadata.estimatedDuration || 0);
      }, 0);
    } catch {
      // 忽略循环依赖错误
    }

    return stats;
  }

  // ============================================================================
  // State Management
  // ============================================================================

  /**
   * 获取 DAG 状态
   */
  getState(): TaskDAGState {
    return {
      definition: {
        id: this.id,
        name: this.name,
        description: this.description,
        tasks: Array.from(this.tasks.values()),
        options: this.options,
      },
      status: this.status,
      statistics: this.getStatistics(),
      startedAt: this.startedAt,
      completedAt: this.completedAt,
      sharedContext: this.sharedContext,
    };
  }

  /**
   * 设置 DAG 状态
   */
  setStatus(status: DAGStatus): void {
    const oldStatus = this.status;
    this.status = status;

    if (status === 'running' && !this.startedAt) {
      this.startedAt = Date.now();
      this.emitEvent('dag:start');
    }

    if (status === 'completed') {
      this.completedAt = Date.now();
      this.emitEvent('dag:complete');
    }

    if (status === 'failed') {
      this.completedAt = Date.now();
      this.emitEvent('dag:failed');
    }

    if (status === 'cancelled') {
      this.completedAt = Date.now();
      this.emitEvent('dag:cancelled');
    }

    logger.info(`DAG ${this.id} status: ${oldStatus} -> ${status}`);
  }

  /**
   * 获取 DAG 状态
   */
  getStatus(): DAGStatus {
    return this.status;
  }

  /**
   * 获取 DAG ID
   */
  getId(): string {
    return this.id;
  }

  /**
   * 获取 DAG 名称
   */
  getName(): string {
    return this.name;
  }

  /**
   * 获取配置选项
   */
  getOptions(): DAGOptions {
    return { ...this.options };
  }

  /**
   * 更新配置选项
   */
  updateOptions(options: Partial<DAGOptions>): void {
    this.options = { ...this.options, ...options };
  }

  // ============================================================================
  // Shared Context
  // ============================================================================

  /**
   * 设置共享上下文数据
   */
  setSharedData(key: string, value: unknown): void {
    this.sharedContext.set(key, value);
  }

  /**
   * 获取共享上下文数据
   */
  getSharedData(key: string): unknown {
    return this.sharedContext.get(key);
  }

  /**
   * 获取所有共享上下文
   */
  getAllSharedData(): Map<string, unknown> {
    return new Map(this.sharedContext);
  }

  // ============================================================================
  // Event Helpers
  // ============================================================================

  private emitEvent(type: DAGEventType, taskId?: string, data?: unknown): void {
    const event: DAGEvent = {
      type,
      dagId: this.id,
      taskId,
      timestamp: Date.now(),
      data,
    };
    this.emit(type, event);
    this.emit('progress:update', this.getStatistics());
  }

  private emitTaskEvent(taskId: string, oldStatus: TaskStatus, newStatus: TaskStatus): void {
    const eventMap: Record<TaskStatus, DAGEventType | null> = {
      pending: null,
      ready: 'task:ready',
      running: 'task:start',
      completed: 'task:complete',
      failed: 'task:failed',
      cancelled: 'task:cancelled',
      skipped: 'task:skipped',
    };

    const eventType = eventMap[newStatus];
    if (eventType) {
      this.emitEvent(eventType, taskId, { oldStatus, newStatus });
    }
  }

  private markDirty(): void {
    this.isDirty = true;
    this.topologicalOrder = undefined;
    this.criticalPath = undefined;
  }

  // ============================================================================
  // Serialization
  // ============================================================================

  /**
   * 序列化为 JSON
   */
  toJSON(): TaskDAGDefinition {
    return {
      id: this.id,
      name: this.name,
      description: this.description,
      tasks: Array.from(this.tasks.values()),
      options: this.options,
    };
  }

  /**
   * 从 JSON 创建 DAG
   */
  static fromJSON(definition: TaskDAGDefinition): TaskDAG {
    const dag = new TaskDAG(definition.id, definition.name, definition.options);
    dag.description = definition.description;

    // 按拓扑顺序添加任务（确保依赖先添加）
    // 首先添加无依赖的任务
    const remaining = [...definition.tasks];
    const added = new Set<string>();

    while (remaining.length > 0) {
      const ready = remaining.filter(t =>
        t.dependencies.every(d => added.has(d))
      );

      if (ready.length === 0 && remaining.length > 0) {
        // 循环依赖，直接添加剩余任务
        for (const task of remaining) {
          dag.tasks.set(task.id, { ...task, dependents: [] });
          added.add(task.id);
        }
        break;
      }

      for (const task of ready) {
        dag.tasks.set(task.id, { ...task, dependents: [] });
        added.add(task.id);
        const idx = remaining.indexOf(task);
        if (idx !== -1) remaining.splice(idx, 1);
      }
    }

    // 重建 dependents
    for (const task of dag.tasks.values()) {
      for (const depId of task.dependencies) {
        const depTask = dag.tasks.get(depId);
        if (depTask && !depTask.dependents.includes(task.id)) {
          depTask.dependents.push(task.id);
        }
      }
    }

    return dag;
  }

  /**
   * 重置 DAG 状态（用于重新执行）
   */
  reset(): void {
    for (const task of this.tasks.values()) {
      task.status = 'pending';
      task.output = undefined;
      task.failure = undefined;
      task.metadata.startedAt = undefined;
      task.metadata.completedAt = undefined;
      task.metadata.duration = undefined;
      task.metadata.retryCount = 0;
      task.metadata.cost = undefined;
    }

    this.status = 'idle';
    this.startedAt = undefined;
    this.completedAt = undefined;
    this.sharedContext.clear();

    logger.info(`DAG ${this.id} reset`);
  }
}
