// ============================================================================
// Todo Parser - 从模型输出中自动提取任务列表
// ============================================================================
// 替代 TodoWrite 工具，agentLoop 自动从模型的 thinking/text content 中解析任务列表
// 支持：markdown checkbox、编号列表格式
// 规则：忽略代码块内的列表，只提升带明确任务意图的 checkbox 清单

import type { SessionTask, TodoItem, TodoStatus } from '../../shared/contract';
import { createLogger } from '../services/infra/logger';
import { getDatabase } from '../services/core/databaseService';
import { createTask, listTasks, updateTask } from '../services/planning/taskStore';

const logger = createLogger('TodoParser');

// 会话级任务存储（替代 todoWrite 中的 sessionTodos）
const sessionTodos: Map<string, TodoItem[]> = new Map();

function getReadyDatabase():
  | Pick<import('../services/core/databaseService').DatabaseService, 'isReady' | 'saveTodos' | 'getTodos'>
  | null {
  try {
    const db = getDatabase();
    return db.isReady ? db : null;
  } catch (err) {
    logger.debug('[TodoParser] Database unavailable for todo persistence', err);
    return null;
  }
}

function hydrateSessionTodos(sessionId: string): void {
  if (sessionTodos.has(sessionId)) return;
  const db = getReadyDatabase();
  if (!db) return;
  try {
    sessionTodos.set(sessionId, db.getTodos(sessionId));
  } catch (err) {
    logger.warn(`[TodoParser] Failed to hydrate todos for session ${sessionId}`, err);
  }
}

function persistSessionTodos(sessionId: string, todos: TodoItem[]): void {
  const db = getReadyDatabase();
  if (!db) return;
  try {
    db.saveTodos(sessionId, todos);
  } catch (err) {
    logger.warn(`[TodoParser] Failed to persist todos for session ${sessionId}`, err);
  }
}

/**
 * 获取指定会话的任务列表
 */
export function getSessionTodos(sessionId?: string): TodoItem[] {
  if (sessionId) {
    hydrateSessionTodos(sessionId);
  }
  if (sessionId && sessionTodos.has(sessionId)) {
    return [...sessionTodos.get(sessionId)!];
  }
  return [];
}

/**
 * 设置指定会话的任务列表
 */
export function setSessionTodos(sessionId: string | undefined, todos: TodoItem[]): void {
  if (sessionId) {
    const snapshot = todos.map((todo) => ({ ...todo }));
    sessionTodos.set(sessionId, snapshot);
    persistSessionTodos(sessionId, snapshot);
  }
}

/**
 * 清除指定会话的任务列表
 */
export function clearSessionTodos(sessionId?: string): void {
  if (sessionId) {
    sessionTodos.delete(sessionId);
    persistSessionTodos(sessionId, []);
  } else {
    sessionTodos.clear();
  }
}

// ============================================================================
// 代码块剥离
// ============================================================================

/**
 * 移除 markdown 代码块（```...```），避免误将代码中的列表识别为任务
 */
function stripCodeBlocks(content: string): string {
  return content.replace(/```[\s\S]*?```/g, '');
}

function hasExplicitTodoIntent(content: string): boolean {
  if (extractPlanTitle(content) !== null) {
    return true;
  }
  return /(?:^|\n)\s*(?:#{1,6}\s*)?(?:todo(?:s)?|task list|execution plan|agent tasks|任务清单|执行计划|待办|行动项|工作计划)\s*[:：]?\s*(?:\n|$)/i
    .test(content);
}

/**
 * 从模型输出中提取 plan 标题。识别显式 "Plan / 计划" 前缀的 markdown 标题或加粗：
 *   `# Plan: 重构 Auth 模块`
 *   `## 计划：重构 Auth 模块`
 *   `**Plan**: 重构 Auth 模块`
 *   `**计划**：重构 Auth 模块`
 *
 * 不识别裸标题（如 `# 重构 Auth`），避免把无关章节当 plan title。
 * 返回 null 时 UI 隐藏 plan title 行，只显示 checklist。
 */
export function extractPlanTitle(content: string): string | null {
  if (!content) return null;
  const cleaned = stripCodeBlocks(content);
  // group: heading marker (# / **) — title text
  const match = cleaned.match(
    /(?:^|\n)\s*(?:#{1,6}\s*|\*\*\s*)(?:plan|计划)\s*\*{0,2}\s*[:：]\s*([^\n*#]+?)\s*\*{0,2}\s*(?:\n|$)/i,
  );
  if (!match) return null;
  const title = match[1].trim();
  if (title.length === 0 || title.length > 200) return null;
  return title;
}

// ============================================================================
// 解析器：Markdown Checkbox 格式
// ============================================================================

/**
 * 解析 markdown checkbox 格式的任务列表
 * 格式：- [x] 已完成  /  - [ ] 待完成  /  - [-] 进行中
 */
function parseCheckboxTodos(content: string): TodoItem[] | null {
  const lines = content.split('\n');
  const items: TodoItem[] = [];
  let consecutiveCount = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    // 匹配 checkbox 格式：- [x] / - [ ] / - [-] / * [x] 等
    const match = trimmed.match(/^[-*]\s+\[([ xX✓✗-])\]\s+(.+)$/);
    if (match) {
      consecutiveCount++;
      const marker = match[1];
      const taskContent = match[2].trim();

      let status: TodoStatus;
      if (marker === 'x' || marker === 'X' || marker === '✓') {
        status = 'completed';
      } else if (marker === '-') {
        status = 'in_progress';
      } else {
        status = 'pending';
      }

      items.push({
        content: taskContent,
        status,
        activeForm: taskContent.slice(0, 30) + (taskContent.length > 30 ? '...' : ''),
      });
    } else if (trimmed === '') {
      // 空行不中断连续计数
      continue;
    } else {
      // 非 checkbox 行：如果已收集到足够项则停止，否则重置
      if (consecutiveCount >= 2) {
        break;
      }
      consecutiveCount = 0;
      items.length = 0;
    }
  }

  if (items.length >= 2) {
    return items;
  }
  return null;
}

// ============================================================================
// 编号列表解析已移除
// ============================================================================
// 编号列表（1. xxx / 2. xxx）在普通文本中太常见，容易将模型的建议性内容
// 误解析为待办任务，导致 "Agent completing with incomplete items" 假警告。
// 对标 Claude Code：只通过显式 checkbox 格式（- [ ] / - [x]）识别任务。

// ============================================================================
// 主解析函数
// ============================================================================

/**
 * 从模型输出中提取任务列表
 * 优先解析 checkbox 格式，其次编号列表
 * 返回 null 表示没有检测到任务列表
 */
export function parseTodos(content: string): TodoItem[] | null {
  if (!content || content.length < 20) return null;

  // 先剥离代码块，避免误识别
  const cleaned = stripCodeBlocks(content);

  if (!hasExplicitTodoIntent(cleaned)) {
    logger.debug('[TodoParser] checkbox list ignored: missing explicit todo intent');
    return null;
  }

  // 只解析显式 checkbox 格式（- [ ] / - [x]），不解析编号列表
  // 对标 Claude Code：任务必须既有显式标记，也有明确任务意图，不从答案 checklist 推断。
  const checkboxResult = parseCheckboxTodos(cleaned);
  if (checkboxResult) {
    logger.debug(`[TodoParser] 从 checkbox 格式解析到 ${checkboxResult.length} 个任务`);
    return checkboxResult;
  }

  return null;
}

// ============================================================================
// 合并策略
// ============================================================================

/**
 * 合并已有任务和新解析到的任务
 * 策略：保留已完成的，更新/追加新的
 */
export function mergeTodos(existing: TodoItem[], parsed: TodoItem[]): TodoItem[] {
  if (existing.length === 0) return parsed;
  if (parsed.length === 0) return existing;

  const result: TodoItem[] = [];
  const matchedIndices = new Set<number>();

  // 对每个已有任务，尝试在新解析列表中匹配
  for (const existingItem of existing) {
    let matched = false;
    for (let i = 0; i < parsed.length; i++) {
      if (matchedIndices.has(i)) continue;
      if (isSameTask(existingItem.content, parsed[i].content)) {
        matchedIndices.add(i);
        matched = true;
        // 已完成的不降级；否则取新状态
        if (existingItem.status === 'completed') {
          result.push(existingItem);
        } else {
          result.push(parsed[i]);
        }
        break;
      }
    }
    // 没有匹配到新列表中的项：保留原有的（可能是新列表省略了）
    if (!matched) {
      result.push(existingItem);
    }
  }

  // 追加新增的任务（新列表中未匹配到已有的）
  for (let i = 0; i < parsed.length; i++) {
    if (!matchedIndices.has(i)) {
      result.push(parsed[i]);
    }
  }

  return result;
}

/**
 * 判断两个任务内容是否指向同一个任务
 * 使用简化后的文本进行模糊匹配
 */
function isSameTask(a: string, b: string): boolean {
  const normalize = (s: string) =>
    s.toLowerCase()
      .replace(/[^\u4e00-\u9fa5a-z0-9]/g, '') // 保留中文、英文字母、数字
      .trim();

  const na = normalize(a);
  const nb = normalize(b);

  // 完全匹配
  if (na === nb) return true;

  // 一个包含另一个（任务描述可能被缩短或扩展）
  if (na.length > 5 && nb.length > 5) {
    if (na.includes(nb) || nb.includes(na)) return true;
  }

  return false;
}

function todoToTaskStatus(status: TodoStatus): SessionTask['status'] {
  if (status === 'completed') return 'completed';
  if (status === 'in_progress') return 'in_progress';
  return 'pending';
}

function isTerminalSessionTaskStatus(status: SessionTask['status']): boolean {
  return status === 'completed' || status === 'cancelled';
}

function shouldUpdateTaskFromTodo(task: SessionTask, todo: TodoItem): boolean {
  const nextStatus = todoToTaskStatus(todo.status);
  if (task.status !== nextStatus && !isTerminalSessionTaskStatus(task.status)) {
    return true;
  }
  return task.subject !== todo.content || task.description !== todo.content || task.activeForm !== todo.activeForm;
}

export function syncTodosToSessionTasks(
  sessionId: string,
  todos: TodoItem[],
): { tasks: SessionTask[]; created: SessionTask[]; updated: SessionTask[] } {
  const existingTasks = listTasks(sessionId);
  const matchedTaskIds = new Set<string>();
  const created: SessionTask[] = [];
  const updated: SessionTask[] = [];

  for (const todo of todos) {
    const task = existingTasks.find((candidate) => (
      !matchedTaskIds.has(candidate.id)
      && (isSameTask(candidate.subject, todo.content) || isSameTask(candidate.description, todo.content))
    ));

    if (!task) {
      const createdTask = createTask(sessionId, {
        subject: todo.content,
        description: todo.content,
        activeForm: todo.activeForm,
        metadata: { source: 'todo_parser' },
      });
      const nextStatus = todoToTaskStatus(todo.status);
      const finalTask = nextStatus === 'pending'
        ? createdTask
        : updateTask(sessionId, createdTask.id, { status: nextStatus }) ?? createdTask;
      created.push(finalTask);
      continue;
    }

    matchedTaskIds.add(task.id);
    if (!shouldUpdateTaskFromTodo(task, todo)) {
      continue;
    }

    const nextStatus = todoToTaskStatus(todo.status);
    const status = isTerminalSessionTaskStatus(task.status) ? task.status : nextStatus;
    const nextTask = updateTask(sessionId, task.id, {
      subject: todo.content,
      description: todo.content,
      activeForm: todo.activeForm,
      status,
      metadata: { source: 'todo_parser' },
    });
    if (nextTask) {
      updated.push(nextTask);
    }
  }

  return {
    tasks: listTasks(sessionId),
    created,
    updated,
  };
}

// ============================================================================
// 任务状态自动推进
// ============================================================================

/**
 * 按顺序自动推进任务状态
 * 当第 N-1 个任务完成时，第 N 个任务标记为 in_progress
 */
export function advanceTodoStatus(todos: TodoItem[]): { updated: boolean; todos: TodoItem[] } {
  if (todos.some(t => t.status === 'in_progress')) {
    return { updated: false, todos };
  }

  const nextIndex = todos.findIndex((todo, index) => (
    todo.status === 'pending'
    && (index === 0 || todos[index - 1]?.status === 'completed')
  ));
  if (nextIndex < 0) return { updated: false, todos };

  return {
    updated: true,
    todos: todos.map((todo, index) => (
      index === nextIndex ? { ...todo, status: 'in_progress' as TodoStatus } : todo
    )),
  };
}

/**
 * 根据工具调用完成情况，将当前 in_progress 的任务标记为 completed，
 * 并推进下一个 pending 任务为 in_progress
 */
export function completeCurrentAndAdvance(todos: TodoItem[]): { updated: boolean; todos: TodoItem[] } {
  let updated = false;
  const result = [...todos];

  // 找到第一个 in_progress 的任务，标记为 completed
  const inProgressIndex = result.findIndex(t => t.status === 'in_progress');
  if (inProgressIndex >= 0) {
    result[inProgressIndex] = { ...result[inProgressIndex], status: 'completed' };
    updated = true;

    // 推进下一个 pending 任务
    const nextPendingIndex = result.findIndex((t, i) => i > inProgressIndex && t.status === 'pending');
    if (nextPendingIndex >= 0) {
      result[nextPendingIndex] = { ...result[nextPendingIndex], status: 'in_progress' };
    }
  }

  return { updated, todos: result };
}
