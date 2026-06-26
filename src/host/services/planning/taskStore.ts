// ============================================================================
// Task Store - Session-scoped task storage (Claude Code 2.x compatible)
// ============================================================================

import type {
  SessionTask,
  SessionTaskStatus,
  SessionTaskPriority,
  CreateTaskInput,
  UpdateTaskInput,
  SessionTaskEvent,
  SessionTaskEventKind,
} from '../../../shared/contract/planning';
import { createLogger } from '../infra/logger';
import { getDatabase } from '../core/databaseService';

const logger = createLogger('TaskStore');

// Session-scoped task storage: Map<sessionId, Map<taskId, SessionTask>>
const sessionTasks: Map<string, Map<string, SessionTask>> = new Map();

// Auto-incrementing task ID counter per session
const sessionTaskCounters: Map<string, number> = new Map();

// Tracks sessions that were actually hydrated from the durable store. A DB that
// is not ready yet should not permanently turn an empty in-memory map into the
// source of truth.
const hydratedSessions: Set<string> = new Set();

function getReadyDatabase():
  | (Pick<import('../core/databaseService').DatabaseService, 'isReady' | 'saveSessionTasks' | 'getSessionTasks'>
      & {
        appendSessionTaskEvents?: (events: SessionTaskEvent[]) => void;
        getMaxTopLevelTaskIdFromEvents?: (sessionId: string) => number;
      })
  | null {
  try {
    const db = getDatabase();
    return db.isReady ? db : null;
  } catch (err) {
    logger.debug('[TaskStore] Database unavailable for task persistence', err);
    return null;
  }
}

/**
 * 事件日志追加（roadmap 2.6）。失败只记日志，绝不阻塞任务变更本体。
 */
function recordTaskEvent(
  sessionId: string,
  taskId: string,
  kind: SessionTaskEventKind,
  extra?: { summary?: string; actor?: string }
): void {
  try {
    const db = getReadyDatabase();
    if (!db?.appendSessionTaskEvents) return;
    db.appendSessionTaskEvents([
      {
        sessionId,
        taskId,
        at: Date.now(),
        kind,
        ...(extra?.summary ? { summary: extra.summary } : {}),
        ...(extra?.actor ? { actor: extra.actor } : {}),
      },
    ]);
  } catch (err) {
    logger.warn(`[TaskStore] Failed to record task event ${kind} for ${taskId}`, err);
  }
}

function inferCounter(tasks: SessionTask[]): number {
  let counter = 0;
  for (const task of tasks) {
    if (/^\d+$/.test(task.id)) {
      counter = Math.max(counter, Number(task.id));
    }
  }
  return counter;
}

function hydrateTasks(sessionId: string): void {
  if (hydratedSessions.has(sessionId)) return;
  const db = getReadyDatabase();
  if (!db) return;
  try {
    const tasks = db.getSessionTasks(sessionId);
    const existingTasks = sessionTasks.get(sessionId);
    const taskMap = new Map<string, SessionTask>();
    for (const task of tasks) {
      taskMap.set(task.id, { ...task, blocks: [...task.blocks], blockedBy: [...task.blockedBy], metadata: { ...task.metadata } });
    }
    if (existingTasks) {
      for (const task of existingTasks.values()) {
        taskMap.set(task.id, { ...task, blocks: [...task.blocks], blockedBy: [...task.blockedBy], metadata: { ...task.metadata } });
      }
    }
    sessionTasks.set(sessionId, taskMap);
    // 顶层计数器：现存任务之外还参考事件历史里出现过的最大 id（含已删任务，
    // 无 limit 全量聚合——防长会话里早期已删 id 滚出窗口后被复用，
    // Codex R1 HIGH / R2 MED）
    let counter = inferCounter(Array.from(taskMap.values()));
    try {
      counter = Math.max(counter, db.getMaxTopLevelTaskIdFromEvents?.(sessionId) ?? 0);
    } catch {
      // 事件读取失败不影响 hydrate
    }
    sessionTaskCounters.set(sessionId, counter);
    hydratedSessions.add(sessionId);
  } catch (err) {
    logger.warn(`[TaskStore] Failed to hydrate tasks for session ${sessionId}`, err);
  }
}

function persistTasks(sessionId: string): void {
  const db = getReadyDatabase();
  if (!db) return;
  try {
    const taskMap = sessionTasks.get(sessionId);
    db.saveSessionTasks(sessionId, taskMap ? Array.from(taskMap.values()) : []);
  } catch (err) {
    logger.warn(`[TaskStore] Failed to persist tasks for session ${sessionId}`, err);
  }
}

/**
 * 生成唯一任务 ID。
 * 顶层任务走会话级自增计数；子任务派生父 id（"1" → "1.1" → "1.1.2"，
 * roadmap 2.6 树状结构），不消耗顶层计数器。
 */
const CHILD_COUNTER_META_KEY = '__childIdCounter';

function generateTaskId(sessionId: string, parentTaskId?: string): string {
  if (!parentTaskId) {
    const counter = (sessionTaskCounters.get(sessionId) || 0) + 1;
    sessionTaskCounters.set(sessionId, counter);
    return String(counter);
  }

  const taskMap = sessionTasks.get(sessionId);
  const parent = taskMap?.get(parentTaskId);
  const prefix = `${parentTaskId}.`;
  // 已删子任务的 id 不复用（避免继承 session_task_events 里旧任务的历史，
  // Codex R1 HIGH）：取「现存子任务最大序号」与「父 metadata 持久化计数器」
  // 的较大者，计数器随父任务持久化、重启可恢复
  let maxChild = Number(parent?.metadata?.[CHILD_COUNTER_META_KEY] ?? 0) || 0;
  if (taskMap) {
    for (const id of taskMap.keys()) {
      if (!id.startsWith(prefix)) continue;
      const tail = id.slice(prefix.length);
      if (/^\d+$/.test(tail)) {
        maxChild = Math.max(maxChild, Number(tail));
      }
    }
  }
  const next = maxChild + 1;
  if (parent) {
    parent.metadata = { ...parent.metadata, [CHILD_COUNTER_META_KEY]: next };
  }
  return `${prefix}${next}`;
}

/**
 * 获取 session 的任务 Map（不存在则创建）
 */
function getSessionTaskMap(sessionId: string): Map<string, SessionTask> {
  hydrateTasks(sessionId);
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

  if (input.parentTaskId && !taskMap.has(input.parentTaskId)) {
    throw new Error(`parent task not found: ${input.parentTaskId}`);
  }

  const task: SessionTask = {
    id: generateTaskId(sessionId, input.parentTaskId),
    subject: input.subject,
    description: input.description,
    activeForm: input.activeForm || generateActiveForm(input.subject),
    status: 'pending',
    priority: input.priority || 'normal',
    blocks: [],
    blockedBy: [],
    ...(input.parentTaskId ? { parentTaskId: input.parentTaskId } : {}),
    ...(input.owner ? { owner: input.owner } : {}),
    metadata: input.metadata || {},
    createdAt: now,
    updatedAt: now,
  };

  taskMap.set(task.id, task);
  persistTasks(sessionId);
  recordTaskEvent(sessionId, task.id, 'created', {
    summary: task.subject,
    ...(task.owner ? { actor: task.owner } : {}),
  });
  return task;
}

/**
 * 获取任务详情
 */
export function getTask(sessionId: string, taskId: string): SessionTask | null {
  const taskMap = getSessionTaskMap(sessionId);
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
  const taskMap = getSessionTaskMap(sessionId);

  const task = taskMap.get(taskId);
  if (!task) return null;

  // Handle deletion
  if (updates.status === 'deleted') {
    // Remove from other tasks' blockedBy/blocks lists；解除阻塞的任务记 unblocked；
    // 子任务 detach（清 parentTaskId）防悬空引用（Codex R1 MED）
    for (const otherTask of taskMap.values()) {
      const wasBlocked = otherTask.blockedBy.includes(taskId);
      otherTask.blockedBy = otherTask.blockedBy.filter((id) => id !== taskId);
      otherTask.blocks = otherTask.blocks.filter((id) => id !== taskId);
      if (wasBlocked) {
        recordTaskEvent(sessionId, otherTask.id, 'unblocked', { summary: `blocker ${taskId} deleted` });
      }
      if (otherTask.parentTaskId === taskId) {
        otherTask.parentTaskId = undefined;
        otherTask.updatedAt = Date.now();
        recordTaskEvent(sessionId, otherTask.id, 'parent_detached', { summary: `parent ${taskId} deleted` });
      }
    }
    taskMap.delete(taskId);
    persistTasks(sessionId);
    recordTaskEvent(sessionId, taskId, 'deleted');
    return task;
  }

  // 事件日志（roadmap 2.6）：先比对变更，统一在持久化后追加
  const events: Array<{ kind: SessionTaskEventKind; summary?: string }> = [];
  if (updates.status && updates.status !== task.status) {
    if (updates.status === 'in_progress') events.push({ kind: 'started' });
    else if (updates.status === 'pending' && task.status === 'in_progress') events.push({ kind: 'unstarted' });
    else if (updates.status === 'completed') events.push({ kind: 'done' });
    else if (updates.status === 'cancelled') events.push({ kind: 'abandoned' });
  }
  if (updates.subject && updates.subject !== task.subject) {
    events.push({ kind: 'renamed', summary: updates.subject });
  }
  if (updates.owner !== undefined && updates.owner !== task.owner) {
    events.push({ kind: 'owner_changed', summary: updates.owner || '(released)' });
  }
  if (updates.addBlockedBy?.some((id) => !task.blockedBy.includes(id) && id !== taskId)) {
    events.push({ kind: 'blocked', summary: updates.addBlockedBy.join(', ') });
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

  // Merge metadata (null values remove keys)；__ 前缀为 taskStore 内部保留键
  // （如 __childIdCounter），外部 merge 不可改写/删除（Codex R2 MED）
  if (updates.metadata) {
    for (const [key, value] of Object.entries(updates.metadata)) {
      if (key.startsWith('__')) continue;
      if (value === null) {
        delete task.metadata[key];
      } else {
        task.metadata[key] = value;
      }
    }
  }

  task.updatedAt = Date.now();
  persistTasks(sessionId);
  for (const event of events) {
    recordTaskEvent(sessionId, taskId, event.kind, event.summary ? { summary: event.summary } : undefined);
  }
  return task;
}

/**
 * Orphan 接管（roadmap 2.6）：subagent 结束时，名下未收口任务释放回主会话
 * （owner 清空），主循环 taskGate 据此继续督办。返回被接管的任务。
 */
export function adoptOrphanTasks(sessionId: string, owner: string): SessionTask[] {
  if (!owner) return [];
  const taskMap = getSessionTaskMap(sessionId);
  const adopted: SessionTask[] = [];
  for (const task of taskMap.values()) {
    if (task.owner === owner && !isClosedTaskStatus(task.status)) {
      task.owner = undefined;
      task.updatedAt = Date.now();
      adopted.push(task);
    }
  }
  if (adopted.length > 0) {
    persistTasks(sessionId);
    for (const task of adopted) {
      recordTaskEvent(sessionId, task.id, 'orphan_adopted', { summary: `from ${owner}`, actor: owner });
    }
    logger.info(`[TaskStore] Adopted ${adopted.length} orphan task(s) from ${owner} in ${sessionId}`);
  }
  return adopted;
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
  const taskMap = getSessionTaskMap(sessionId);
  return Array.from(taskMap.values());
}

export function isClosedTaskStatus(status: SessionTaskStatus): boolean {
  return status === 'completed' || status === 'cancelled';
}

/**
 * 获取未完成任务数量
 */
export function getIncompleteTasks(sessionId: string): SessionTask[] {
  return listTasks(sessionId).filter((t) => !isClosedTaskStatus(t.status));
}

/**
 * 清除 session 的所有任务
 */
export function clearTasks(sessionId: string): void {
  sessionTasks.delete(sessionId);
  sessionTaskCounters.delete(sessionId);
  hydratedSessions.delete(sessionId);
  persistTasks(sessionId);
}

/**
 * 导出 session 的所有任务和计数器（用于持久化）
 */
export function exportTasks(sessionId: string): { tasks: SessionTask[]; counter: number } {
  hydrateTasks(sessionId);
  const taskMap = sessionTasks.get(sessionId);
  const counter = sessionTaskCounters.get(sessionId) || 0;
  return {
    tasks: taskMap ? Array.from(taskMap.values()) : [],
    counter,
  };
}

/**
 * 导入任务到 session（用于恢复持久化状态）
 */
export function importTasks(sessionId: string, tasks: SessionTask[], counter: number): void {
  const taskMap = new Map<string, SessionTask>();
  for (const task of tasks) {
    taskMap.set(task.id, task);
  }
  sessionTasks.set(sessionId, taskMap);
  sessionTaskCounters.set(sessionId, counter);
  hydratedSessions.add(sessionId);
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
