// ============================================================================
// TaskList Manager - 可视化任务列表管理
// 用于 Auto Agent / Swarm 执行时的任务状态追踪与 UI 同步
// ============================================================================

import { createLogger } from '../../services/infra/logger';
import { generateMessageId } from '../../../shared/utils/id';
import type {
  TaskItemIpc,
  TaskItemStatusIpc,
  TaskListStateIpc,
  TaskListEventIpc,
} from '../../../shared/ipc';

const logger = createLogger('TaskListManager');

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

export interface CreateTaskInput {
  subject: string;
  description: string;
  assignee?: string;
  priority?: number;
  dependencies?: string[];
}

type TaskListListener = (event: TaskListEventIpc) => void;

// ----------------------------------------------------------------------------
// TaskListManager
// ----------------------------------------------------------------------------

export class TaskListManager {
  private tasks: Map<string, TaskItemIpc> = new Map();
  private autoAssign: boolean = false;
  private requireApproval: boolean = false;
  private listeners: Set<TaskListListener> = new Set();
  private approvalResolvers: Map<string, () => void> = new Map();
  private approvalRejecters: Map<string, (err: Error) => void> = new Map();

  // --------------------------------------------------------------------------
  // Task CRUD
  // --------------------------------------------------------------------------

  createTask(input: CreateTaskInput): TaskItemIpc {
    const now = Date.now();
    const task: TaskItemIpc = {
      id: generateMessageId(),
      subject: input.subject,
      description: input.description,
      status: 'pending',
      assignee: input.assignee,
      priority: input.priority ?? 3,
      dependencies: input.dependencies ?? [],
      createdAt: now,
      updatedAt: now,
    };

    this.tasks.set(task.id, task);
    this.emit({ type: 'task_created', task });
    logger.debug(`[TaskList] Task created: ${task.id} — ${task.subject}`);
    return task;
  }

  updateTask(taskId: string, changes: Partial<TaskItemIpc>): TaskItemIpc | null {
    const task = this.tasks.get(taskId);
    if (!task) return null;

    Object.assign(task, changes, { updatedAt: Date.now() });
    this.emit({ type: 'task_updated', task, taskId, changes });
    return task;
  }

  deleteTask(taskId: string): boolean {
    const existed = this.tasks.delete(taskId);
    if (existed) {
      this.emit({ type: 'task_deleted', taskId });
    }
    return existed;
  }

  getTasks(): TaskItemIpc[] {
    return Array.from(this.tasks.values());
  }

  getTask(taskId: string): TaskItemIpc | undefined {
    return this.tasks.get(taskId);
  }

  // --------------------------------------------------------------------------
  // Execution Lifecycle
  // --------------------------------------------------------------------------

  startExecution(taskId: string): void {
    this.updateTask(taskId, { status: 'in_progress' });
    this.emit({ type: 'task_started', taskId });
  }

  completeExecution(taskId: string, result: string): void {
    this.updateTask(taskId, { status: 'completed', result });
    this.emit({ type: 'task_completed', taskId, result });
  }

  failExecution(taskId: string, error: string): void {
    this.updateTask(taskId, { status: 'failed', error });
    this.emit({ type: 'task_failed', taskId, error });
  }

  reassign(taskId: string, assignee: string): TaskItemIpc | null {
    const result = this.updateTask(taskId, { assignee });
    if (result) {
      this.emit({ type: 'task_reassigned', taskId, assignee });
    }
    return result;
  }

  // --------------------------------------------------------------------------
  // Approval
  // --------------------------------------------------------------------------

  waitForApproval(taskId: string): Promise<void> {
    if (!this.requireApproval) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      this.approvalResolvers.set(taskId, resolve);
      this.approvalRejecters.set(taskId, reject);
    });
  }

  approve(taskId: string): void {
    const resolver = this.approvalResolvers.get(taskId);
    if (resolver) {
      resolver();
      this.approvalResolvers.delete(taskId);
      this.approvalRejecters.delete(taskId);
    }
    this.emit({ type: 'task_approved', taskId });
  }

  approveAll(): void {
    for (const [taskId, resolver] of this.approvalResolvers) {
      resolver();
      this.approvalRejecters.delete(taskId);
    }
    this.approvalResolvers.clear();
    this.emit({ type: 'all_approved' });
  }

  // --------------------------------------------------------------------------
  // Task Claiming (for optimistic concurrency in Swarm)
  // --------------------------------------------------------------------------

  /**
   * 尝试认领一个任务（乐观锁）
   * @returns 认领的任务，或 null 如果无可认领任务
   */
  claimTask(agentId: string, preferredTags?: string[]): TaskItemIpc | null {
    // 找到第一个 pending 且无 assignee 的任务
    for (const task of this.tasks.values()) {
      if (task.status === 'pending' && !task.assignee) {
        // 检查依赖是否已满足
        const depsOk = (task.dependencies || []).every(depId => {
          const dep = this.tasks.get(depId);
          return dep && dep.status === 'completed';
        });
        if (!depsOk) continue;

        // 认领
        this.updateTask(task.id, { assignee: agentId, status: 'in_progress' });
        this.emit({ type: 'task_started', taskId: task.id });
        logger.debug(`[TaskList] Task ${task.id} claimed by ${agentId}`);
        return this.tasks.get(task.id) || null;
      }
    }
    return null;
  }

  /**
   * 释放一个任务认领（恢复为 pending）
   */
  releaseTask(taskId: string, agentId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task || task.assignee !== agentId) return false;
    this.updateTask(taskId, { assignee: undefined, status: 'pending' });
    logger.debug(`[TaskList] Task ${taskId} released by ${agentId}`);
    return true;
  }

  // --------------------------------------------------------------------------
  // State & Settings
  // --------------------------------------------------------------------------

  getState(): TaskListStateIpc {
    return {
      tasks: this.getTasks(),
      autoAssign: this.autoAssign,
      requireApproval: this.requireApproval,
    };
  }

  setAutoAssign(enabled: boolean): void {
    this.autoAssign = enabled;
    this.emit({ type: 'settings_changed', state: this.getState() });
  }

  setRequireApproval(enabled: boolean): void {
    this.requireApproval = enabled;
    this.emit({ type: 'settings_changed', state: this.getState() });
  }

  reset(): void {
    // Reject any pending approvals
    for (const [, rejecter] of this.approvalRejecters) {
      rejecter(new Error('TaskList reset'));
    }
    this.approvalResolvers.clear();
    this.approvalRejecters.clear();
    this.tasks.clear();
    this.emit({ type: 'reset', state: this.getState() });
  }

  // --------------------------------------------------------------------------
  // Event System
  // --------------------------------------------------------------------------

  subscribe(listener: TaskListListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: TaskListEventIpc): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        logger.error('[TaskList] Listener error:', err);
      }
    }
  }
}

// ----------------------------------------------------------------------------
// Singleton
// ----------------------------------------------------------------------------

let instance: TaskListManager | null = null;

export function getTaskListManager(): TaskListManager {
  if (!instance) {
    instance = new TaskListManager();
  }
  return instance;
}
