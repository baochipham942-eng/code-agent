// ============================================================================
// Coordinator Mode - 轻量级多 Agent 编排器
// ============================================================================
//
// 借鉴 Claude Code "coordinator mode"：当单次请求需要 3+ Agent 时自动激活，
// 由一个 leader 负责任务分解、依赖调度、结果合成。
//
// 与 ParallelAgentCoordinator 的关系：
// - ParallelAgentCoordinator 负责底层并行执行（executor 层）
// - CoordinatorSession 负责上层任务编排（task decomposition + DAG 层）
// - CoordinatorSession 产出 ready tasks → ParallelAgentCoordinator 消费执行
// ============================================================================

import { createLogger } from '../services/infra/logger';
import { validateNoCycles, getReadyTasks } from './taskDag';

const logger = createLogger('CoordinatorMode');

// ============================================================================
// Types
// ============================================================================

export type CoordinatorTaskStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

export interface CoordinatorTask {
  id: string;
  description: string;
  assignedTo?: string;   // agent ID
  status: CoordinatorTaskStatus;
  result?: string;
  dependsOn?: string[];  // task IDs
  createdAt: number;
  completedAt?: number;
}

// ============================================================================
// 阈值常量
// ============================================================================

/** 自动激活 coordinator mode 的最少 agent 数量 */
export const COORDINATOR_ACTIVATION_THRESHOLD = 3;

// ============================================================================
// CoordinatorSession
// ============================================================================

export class CoordinatorSession {
  private tasks: Map<string, CoordinatorTask> = new Map();
  private agentTaskMap: Map<string, string> = new Map(); // agentId -> taskId
  private readonly sessionId: string;

  constructor(sessionId?: string) {
    this.sessionId = sessionId ?? `coord_${Date.now()}`;
  }

  // --------------------------------------------------------------------------
  // 任务分解
  // --------------------------------------------------------------------------

  /**
   * 将复杂请求分解为子任务，返回带依赖关系的 CoordinatorTask 数组。
   * 调用方提供预分解好的 subtask 描述（由 LLM 或人工拆分），
   * 本方法负责生成 ID、校验依赖环、注册到内部 Map。
   */
  decompose(
    _request: string,
    subtasks: Array<{ id?: string; description: string; dependsOn?: string[] }>
  ): CoordinatorTask[] {
    const created: CoordinatorTask[] = [];

    // Phase 1: 生成 ID（优先使用调用方提供的 id，否则自动生成）
    const idMap = new Map<number, string>(); // index -> taskId
    for (let i = 0; i < subtasks.length; i++) {
      idMap.set(i, subtasks[i].id ?? `${this.sessionId}_task_${i}`);
    }

    // Phase 2: 构建任务
    for (let i = 0; i < subtasks.length; i++) {
      const sub = subtasks[i];
      const taskId = idMap.get(i)!;

      // 解析 dependsOn：支持 index 引用（"0", "1"）和已有 taskId 引用
      const resolvedDeps = sub.dependsOn?.map(dep => {
        const idx = Number(dep);
        if (!isNaN(idx) && idMap.has(idx)) return idMap.get(idx)!;
        return dep; // 直接使用 taskId
      });

      const task: CoordinatorTask = {
        id: taskId,
        description: sub.description,
        status: 'pending',
        dependsOn: resolvedDeps,
        createdAt: Date.now(),
      };

      created.push(task);
      this.tasks.set(taskId, task);
    }

    // Phase 3: 校验无环
    const blockedBy = new Map<string, Set<string>>();
    for (const task of created) {
      blockedBy.set(task.id, new Set(task.dependsOn ?? []));
    }
    if (!validateNoCycles(blockedBy)) {
      // 回滚
      for (const task of created) {
        this.tasks.delete(task.id);
      }
      logger.error('Cycle detected in subtask dependencies, decompose aborted');
      throw new Error('Cycle detected in subtask dependencies');
    }

    logger.info(`Decomposed into ${created.length} subtasks (session: ${this.sessionId})`);
    return created;
  }

  // --------------------------------------------------------------------------
  // 任务分配
  // --------------------------------------------------------------------------

  /**
   * 将任务分配给指定 agent
   */
  assign(taskId: string, agentId: string): void {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }
    if (task.status !== 'pending') {
      throw new Error(`Cannot assign task in status '${task.status}': ${taskId}`);
    }

    task.assignedTo = agentId;
    task.status = 'in_progress';
    this.agentTaskMap.set(agentId, taskId);

    logger.info(`Assigned task ${taskId} to agent ${agentId}`);
  }

  // --------------------------------------------------------------------------
  // 任务完成
  // --------------------------------------------------------------------------

  /**
   * 标记任务完成并记录结果
   */
  complete(taskId: string, result: string): void {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    task.status = 'completed';
    task.result = result;
    task.completedAt = Date.now();

    logger.info(`Task ${taskId} completed (${task.completedAt - task.createdAt}ms)`);
  }

  /**
   * 标记任务失败
   */
  fail(taskId: string, error: string): void {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    task.status = 'failed';
    task.result = error;
    task.completedAt = Date.now();

    logger.warn(`Task ${taskId} failed: ${error}`);
  }

  // --------------------------------------------------------------------------
  // 调度查询
  // --------------------------------------------------------------------------

  /**
   * 获取所有就绪任务（依赖全部完成且自身尚未开始）。
   * 复用 taskDag.ts 的 getReadyTasks 函数。
   */
  getReadyTasks(): CoordinatorTask[] {
    const blockedBy = new Map<string, Set<string>>();
    const completedIds = new Set<string>();

    for (const [id, task] of this.tasks) {
      blockedBy.set(id, new Set(task.dependsOn ?? []));
      if (task.status === 'completed') {
        completedIds.add(id);
      }
    }

    // getReadyTasks 返回的是 taskId 列表，过滤掉已在执行/已完成/已失败的
    const readyIds = getReadyTasks(blockedBy, completedIds);
    return readyIds
      .map(id => this.tasks.get(id)!)
      .filter(t => t.status === 'pending');
  }

  /**
   * 根据 agentId 查找对应的 taskId
   */
  getTaskByAgent(agentId: string): CoordinatorTask | undefined {
    const taskId = this.agentTaskMap.get(agentId);
    if (!taskId) return undefined;
    return this.tasks.get(taskId);
  }

  // --------------------------------------------------------------------------
  // 状态查询
  // --------------------------------------------------------------------------

  /**
   * 检查所有任务是否已完成（completed 或 failed）
   */
  isComplete(): boolean {
    for (const task of this.tasks.values()) {
      if (task.status === 'pending' || task.status === 'in_progress') {
        return false;
      }
    }
    return this.tasks.size > 0;
  }

  /**
   * 获取所有任务的摘要统计
   */
  getStats(): { total: number; pending: number; inProgress: number; completed: number; failed: number } {
    let pending = 0, inProgress = 0, completed = 0, failed = 0;
    for (const task of this.tasks.values()) {
      switch (task.status) {
        case 'pending': pending++; break;
        case 'in_progress': inProgress++; break;
        case 'completed': completed++; break;
        case 'failed': failed++; break;
      }
    }
    return { total: this.tasks.size, pending, inProgress, completed, failed };
  }

  // --------------------------------------------------------------------------
  // 结果合成
  // --------------------------------------------------------------------------

  /**
   * 合成所有任务结果为最终摘要，供父 agent 消费。
   */
  synthesize(): string {
    const stats = this.getStats();
    const parts: string[] = [
      `## Coordinator Summary (${this.sessionId})`,
      `Tasks: ${stats.completed}/${stats.total} completed, ${stats.failed} failed`,
      '',
    ];

    for (const task of this.tasks.values()) {
      const statusIcon = task.status === 'completed' ? '[OK]'
        : task.status === 'failed' ? '[FAIL]'
        : `[${task.status.toUpperCase()}]`;
      parts.push(`${statusIcon} ${task.description}`);
      if (task.result) {
        // 截断过长结果
        const preview = task.result.length > 500
          ? task.result.slice(0, 500) + '...'
          : task.result;
        parts.push(`  → ${preview}`);
      }
      parts.push('');
    }

    return parts.join('\n');
  }

  // --------------------------------------------------------------------------
  // 内部工具
  // --------------------------------------------------------------------------

  getSessionId(): string {
    return this.sessionId;
  }

  getTask(taskId: string): CoordinatorTask | undefined {
    return this.tasks.get(taskId);
  }

  getAllTasks(): CoordinatorTask[] {
    return Array.from(this.tasks.values());
  }
}

// ============================================================================
// 工厂函数
// ============================================================================

/**
 * 检查是否应该激活 coordinator mode
 */
export function shouldActivateCoordinator(agentCount: number): boolean {
  return agentCount >= COORDINATOR_ACTIVATION_THRESHOLD;
}

/**
 * 创建 CoordinatorSession 实例
 */
export function createCoordinatorSession(sessionId?: string): CoordinatorSession {
  return new CoordinatorSession(sessionId);
}
