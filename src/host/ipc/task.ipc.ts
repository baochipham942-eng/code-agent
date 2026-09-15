// ============================================================================
// Task IPC Handlers - task:* / domain:task 通道
// Wave 5: 多任务并行支持
// ============================================================================

import type { IpcMain } from '../platform';
import { broadcastToRenderer } from '../platform';
import {
  IPC_CHANNELS,
  type IPCResponse,
  type TaskRuntimeEvent,
} from '../../shared/ipc';
import { TaskSchemas, type TaskDomainRequest } from '../../shared/ipc/schemas/task';
import { defineDomainRoutes, installDomainRoutes } from './domainRoutes/registry';
import type { TaskManager, SessionState, TaskManagerEvent } from '../task';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('TaskIPC');

// ============================================================================
// Types
// ============================================================================

export interface TaskStats {
  running: number;
  queued: number;
  available: number;
  maxConcurrent: number;
}

const unavailableTaskStats = (): TaskStats => ({
  running: 0,
  queued: 0,
  available: 0,
  maxConcurrent: 0,
});

export interface StartTaskPayload {
  sessionId: string;
  message: string;
  attachments?: unknown[];
}

export interface TaskIdPayload {
  sessionId: string;
}

const bridgedTaskManagers = new WeakSet<TaskManager>();

// ============================================================================
// Internal Handlers
// ============================================================================

async function handleStartTask(
  taskManager: TaskManager,
  payload: StartTaskPayload
): Promise<void> {
  const { sessionId, message, attachments } = payload;
  await taskManager.startTask(sessionId, message, attachments);
}

async function handleInterruptTask(
  taskManager: TaskManager,
  payload: TaskIdPayload
): Promise<void> {
  await taskManager.interruptTask(payload.sessionId);
}

async function handleCancelTask(
  taskManager: TaskManager,
  payload: TaskIdPayload
): Promise<void> {
  await taskManager.cancelTask(payload.sessionId);
}

interface BackgroundTaskIdPayload {
  taskId: string;
}

async function handleCancelBackgroundTask(
  taskManager: TaskManager,
  payload: BackgroundTaskIdPayload
): Promise<boolean> {
  return taskManager.cancelBackgroundTask(payload.taskId);
}

function handleGetState(
  taskManager: TaskManager,
  payload: TaskIdPayload
): SessionState {
  return taskManager.getSessionState(payload.sessionId);
}

function handleGetAllStates(
  taskManager: TaskManager
): Record<string, SessionState> {
  const states = taskManager.getAllStates();
  const result: Record<string, SessionState> = {};
  for (const [key, value] of states) {
    result[key] = value;
  }
  return result;
}

function handleGetQueue(
  taskManager: TaskManager
): string[] {
  return taskManager.getWaitingQueue();
}

function handleGetStats(
  taskManager: TaskManager
): TaskStats {
  return taskManager.getStats();
}

function handleCleanup(
  taskManager: TaskManager,
  payload: TaskIdPayload
): void {
  taskManager.cleanup(payload.sessionId);
}

function publishTaskEvent(event: TaskRuntimeEvent): void {
  broadcastToRenderer(IPC_CHANNELS.TASK_EVENT, event);
}

function publishStats(taskManager: TaskManager): void {
  publishTaskEvent({
    type: 'stats_updated',
    data: handleGetStats(taskManager),
  });
}

function ensureTaskEventBridge(taskManager: TaskManager): void {
  if (bridgedTaskManagers.has(taskManager)) return;
  bridgedTaskManagers.add(taskManager);

  taskManager.on('event', (event: TaskManagerEvent) => {
    switch (event.type) {
      case 'state_change':
        publishTaskEvent({
          type: 'state_change',
          sessionId: event.sessionId,
          data: handleGetState(taskManager, { sessionId: event.sessionId }),
        });
        break;

      case 'queue_update':
        publishTaskEvent({
          type: 'queue_update',
          sessionId: event.sessionId,
          queue: handleGetQueue(taskManager),
        });
        break;
    }

    publishStats(taskManager);
  });
}

// ============================================================================
// Public Registration
// ============================================================================

interface TaskRouteCtx {
  getTaskManager: () => TaskManager | null;
  logUnavailableActionOnce: (action: string) => void;
}

/**
 * 缺席门（原 switch 前置分支平移为 guard，未知 action 也先过门）：Web 模式（webServer.ts 注入
 * getTaskManager: () => null）或桌面 bootstrap 尚未完成时，TaskManager 为 null 是预期状态。轮询读操作
 * 返回安全默认且静默；写/控制类动作（含未知 action）返回结构化 unavailable 响应，并按 action 只打一次 debug。
 */
function taskManagerUnavailableGuard(action: unknown, ctx: TaskRouteCtx): IPCResponse | null {
  if (ctx.getTaskManager()) return null;
  switch (action) {
    case 'getAllStates':
      return { success: true, data: {} };
    case 'getQueue':
      return { success: true, data: [] };
    case 'getStats':
      return { success: true, data: unavailableTaskStats() };
    default:
      ctx.logUnavailableActionOnce(String(action));
      return {
        success: false,
        error: {
          code: 'TASK_MANAGER_UNAVAILABLE',
          message: 'TaskManager not initialized in this runtime (web mode or pre-bootstrap)',
        },
      };
  }
}

/** 按请求取 manager 并确保事件桥（缺席已被门拦下；门后仍为 null 视为运行期异常，走 mapError） */
function bridgedTaskManager(ctx: TaskRouteCtx): TaskManager {
  const taskManager = ctx.getTaskManager();
  if (!taskManager) throw new Error('TaskManager not initialized');
  ensureTaskEventBridge(taskManager);
  return taskManager;
}

/**
 * task 域单源路由表（RQ-183 续作·TASK 刀）：原 domain switch 逐 case 平移（handler 返回 data，装配器包
 * { success: true, data }）；缺席分支走 guard；未知 action → INVALID_ACTION `Unknown action: <action>`（装配器
 * 缺省）；抛错 → INTERNAL_ERROR（Error 取 message、非 Error 取 String(error)）+ `Task IPC error [<action>]:` 日志。
 */
const taskRoutes = defineDomainRoutes<TaskDomainRequest, TaskRouteCtx>(
  TaskSchemas.REQUEST,
  {
    start: async (ctx, payload) => {
      await handleStartTask(bridgedTaskManager(ctx), payload as StartTaskPayload);
      return null;
    },
    interrupt: async (ctx, payload) => {
      await handleInterruptTask(bridgedTaskManager(ctx), payload as TaskIdPayload);
      return null;
    },
    cancel: async (ctx, payload) => {
      await handleCancelTask(bridgedTaskManager(ctx), payload as TaskIdPayload);
      return null;
    },
    // 行级停单个 delegate_task 后台任务（SessionAgentsPanel）：TaskManager 既有
    // cancelBackgroundTask(taskId)，此前只有 cancel_task 工具内部用，IPC 无出口。
    cancelBackgroundTask: async (ctx, payload) => ({
      cancelled: await handleCancelBackgroundTask(bridgedTaskManager(ctx), payload as BackgroundTaskIdPayload),
    }),
    getState: (ctx, payload) => handleGetState(bridgedTaskManager(ctx), payload as TaskIdPayload),
    getAllStates: (ctx) => handleGetAllStates(bridgedTaskManager(ctx)),
    getQueue: (ctx) => handleGetQueue(bridgedTaskManager(ctx)),
    getStats: (ctx) => handleGetStats(bridgedTaskManager(ctx)),
    cleanup: (ctx, payload) => {
      handleCleanup(bridgedTaskManager(ctx), payload as TaskIdPayload);
      return null;
    },
  },
  {
    guard: taskManagerUnavailableGuard,
    mapError: (error, action) => {
      logger.error(`Task IPC error [${String(action)}]:`, error);
      return { code: 'INTERNAL_ERROR', message: error instanceof Error ? error.message : String(error) };
    },
  },
);

/**
 * 注册 Task 相关 IPC handlers
 */
export function registerTaskHandlers(
  ipcMain: IpcMain,
  getTaskManager: () => TaskManager | null
): void {
  const loggedUnavailableActions = new Set<string>();

  function logUnavailableActionOnce(action: string): void {
    if (loggedUnavailableActions.has(action)) return;
    loggedUnavailableActions.add(action);
    logger.debug(`Task IPC ${action}: TaskManager unavailable in this mode; returning unavailable response`);
  }

  installDomainRoutes(ipcMain, taskRoutes, { getTaskManager, logUnavailableActionOnce });

  logger.info('Task IPC handlers registered');
}

// 表挂装配函数对象上供 parity 门枚举（同 registerMemoryHandlers.routes 先例）
registerTaskHandlers.routes = taskRoutes;
