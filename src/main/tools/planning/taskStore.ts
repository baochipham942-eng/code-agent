// ============================================================================
// Task Store - Session-scoped task storage (Claude Code 2.x compatible)
// ============================================================================

import type {
  SessionTask,
  SessionTaskStatus,
  SessionTaskPriority,
  CreateTaskInput,
  UpdateTaskInput,
} from '../../../shared/types/planning';

// Session-scoped task storage: Map<sessionId, Map<taskId, SessionTask>>
const sessionTasks: Map<string, Map<string, SessionTask>> = new Map();

// Auto-incrementing task ID counter per session
const sessionTaskCounters: Map<string, number> = new Map();

/**
 * 生成唯一任务 ID
 */
function generateTaskId(sessionId: string): string {
  const counter = (sessionTaskCounters.get(sessionId) || 0) + 1;
  sessionTaskCounters.set(sessionId, counter);
  return String(counter);
}

/**
 * 获取 session 的任务 Map（不存在则创建）
 */
function getSessionTaskMap(sessionId: string): Map<string, SessionTask> {
  if (!sessionTasks.has(sessionId)) {
    sessionTasks.set(sessionId, new Map());
  }
  return sessionTasks.get(sessionId)!;
}

/**
 * 创建任务
 */
export function createTask(sessionId: string, input: CreateTaskInput): SessionTask {
  const taskMap = getSessionTaskMap(sessionId);
  const now = Date.now();

  const task: SessionTask = {
    id: generateTaskId(sessionId),
    subject: input.subject,
    description: input.description,
    activeForm: input.activeForm || generateActiveForm(input.subject),
    status: 'pending',
    priority: input.priority || 'normal',
    blocks: [],
    blockedBy: [],
    metadata: input.metadata || {},
    createdAt: now,
    updatedAt: now,
  };

  taskMap.set(task.id, task);
  return task;
}

/**
 * 获取任务详情
 */
export function getTask(sessionId: string, taskId: string): SessionTask | null {
  const taskMap = sessionTasks.get(sessionId);
  if (!taskMap) return null;
  return taskMap.get(taskId) || null;
}

/**
 * 更新任务
 */
export function updateTask(
  sessionId: string,
  taskId: string,
  updates: UpdateTaskInput
): SessionTask | null {
  const taskMap = sessionTasks.get(sessionId);
  if (!taskMap) return null;

  const task = taskMap.get(taskId);
  if (!task) return null;

  // Handle deletion
  if (updates.status === 'deleted') {
    // Remove from other tasks' blockedBy/blocks lists
    for (const otherTask of taskMap.values()) {
      otherTask.blockedBy = otherTask.blockedBy.filter((id) => id !== taskId);
      otherTask.blocks = otherTask.blocks.filter((id) => id !== taskId);
    }
    taskMap.delete(taskId);
    return task;
  }

  // Update fields
  if (updates.status) task.status = updates.status as SessionTaskStatus;
  if (updates.subject) task.subject = updates.subject;
  if (updates.description) task.description = updates.description;
  if (updates.activeForm) task.activeForm = updates.activeForm;
  if (updates.owner !== undefined) task.owner = updates.owner;

  // Handle dependency additions
  if (updates.addBlockedBy) {
    for (const depId of updates.addBlockedBy) {
      if (!task.blockedBy.includes(depId) && depId !== taskId) {
        task.blockedBy.push(depId);
        // Also update the blocking task's blocks list
        const blockingTask = taskMap.get(depId);
        if (blockingTask && !blockingTask.blocks.includes(taskId)) {
          blockingTask.blocks.push(taskId);
        }
      }
    }
  }

  if (updates.addBlocks) {
    for (const depId of updates.addBlocks) {
      if (!task.blocks.includes(depId) && depId !== taskId) {
        task.blocks.push(depId);
        // Also update the blocked task's blockedBy list
        const blockedTask = taskMap.get(depId);
        if (blockedTask && !blockedTask.blockedBy.includes(taskId)) {
          blockedTask.blockedBy.push(taskId);
        }
      }
    }
  }

  // Merge metadata (null values remove keys)
  if (updates.metadata) {
    for (const [key, value] of Object.entries(updates.metadata)) {
      if (value === null) {
        delete task.metadata[key];
      } else {
        task.metadata[key] = value;
      }
    }
  }

  task.updatedAt = Date.now();
  return task;
}

/**
 * 删除任务
 */
export function deleteTask(sessionId: string, taskId: string): boolean {
  return updateTask(sessionId, taskId, { status: 'deleted' }) !== null;
}

/**
 * 列出所有任务
 */
export function listTasks(sessionId: string): SessionTask[] {
  const taskMap = sessionTasks.get(sessionId);
  if (!taskMap) return [];
  return Array.from(taskMap.values());
}

/**
 * 获取未完成任务数量
 */
export function getIncompleteTasks(sessionId: string): SessionTask[] {
  return listTasks(sessionId).filter((t) => t.status !== 'completed');
}

/**
 * 清除 session 的所有任务
 */
export function clearTasks(sessionId: string): void {
  sessionTasks.delete(sessionId);
  sessionTaskCounters.delete(sessionId);
}

/**
 * 生成 activeForm（进行时形式）
 * 将祈使句转换为进行时形式
 */
function generateActiveForm(subject: string): string {
  // Simple transformation: add "ing" suffix pattern
  // "Implement X" -> "Implementing X"
  // "Fix bug" -> "Fixing bug"
  // "Add feature" -> "Adding feature"

  const words = subject.split(' ');
  if (words.length === 0) return subject;

  const firstWord = words[0];
  let ingForm: string;

  // Handle common verb patterns
  if (firstWord.endsWith('e') && !firstWord.endsWith('ee')) {
    // "Implement" -> "Implementing", "Create" -> "Creating"
    ingForm = firstWord.slice(0, -1) + 'ing';
  } else if (
    firstWord.length > 2 &&
    /[aeiou]/.test(firstWord[firstWord.length - 2]) &&
    !/[aeiou]/.test(firstWord[firstWord.length - 1]) &&
    !['w', 'x', 'y'].includes(firstWord[firstWord.length - 1])
  ) {
    // Double consonant: "Run" -> "Running", "Stop" -> "Stopping"
    ingForm = firstWord + firstWord[firstWord.length - 1] + 'ing';
  } else {
    // Default: just add "ing"
    ingForm = firstWord + 'ing';
  }

  return [ingForm, ...words.slice(1)].join(' ');
}
