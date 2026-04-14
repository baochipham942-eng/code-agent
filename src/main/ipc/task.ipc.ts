// ============================================================================
// Task IPC Handlers - task:* / domain:task 通道
// Wave 5: 多任务并行支持
// ============================================================================

import type { IpcMain } from '../platform';
import { IPC_DOMAINS, type IPCRequest, type IPCResponse } from '../../shared/ipc';
import type { TaskManager, SessionState } from '../task';
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

export interface StartTaskPayload {
  sessionId: string;
  message: string;
  attachments?: unknown[];
}

export interface TaskIdPayload {
  sessionId: string;
}

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

// ============================================================================
// Public Registration
// ============================================================================

/**
 * 注册 Task 相关 IPC handlers
 */
export function registerTaskHandlers(
  ipcMain: IpcMain,
  getTaskManager: () => TaskManager | null
): void {
  // Domain Handler
  ipcMain.handle(IPC_DOMAINS.TASK, async (_, request: IPCRequest): Promise<IPCResponse> => {
    const { action, payload } = request;

    // Web 模式（webServer.ts 注入 getTaskManager: () => null）或桌面 bootstrap
    // 尚未完成时，TaskManager 为 null 是预期状态。返回结构化 unavailable 响应，
    // 且只发 debug 日志，避免把噪音升成 error。getAllStates/getStats 在可选字段
    // 场景下返回安全默认，让 renderer 侧轮询查询不需要特殊分支。
    const taskManager = getTaskManager();
    if (!taskManager) {
      logger.debug(`Task IPC ${action}: TaskManager unavailable (likely web mode or pre-bootstrap)`);
      switch (action) {
        case 'getAllStates':
          return { success: true, data: {} };
        case 'getQueue':
          return { success: true, data: [] };
        case 'getStats':
          return {
            success: true,
            data: { running: 0, queued: 0, available: 0, maxConcurrent: 0 } as TaskStats,
          };
        default:
          return {
            success: false,
            error: {
              code: 'TASK_MANAGER_UNAVAILABLE',
              message: 'TaskManager not initialized in this runtime (web mode or pre-bootstrap)',
            },
          };
      }
    }

    try {
      switch (action) {
        case 'start':
          await handleStartTask(taskManager, payload as StartTaskPayload);
          return { success: true, data: null };

        case 'interrupt':
          await handleInterruptTask(taskManager, payload as TaskIdPayload);
          return { success: true, data: null };

        case 'cancel':
          await handleCancelTask(taskManager, payload as TaskIdPayload);
          return { success: true, data: null };

        case 'getState':
          return { success: true, data: handleGetState(taskManager, payload as TaskIdPayload) };

        case 'getAllStates':
          return { success: true, data: handleGetAllStates(taskManager) };

        case 'getQueue':
          return { success: true, data: handleGetQueue(taskManager) };

        case 'getStats':
          return { success: true, data: handleGetStats(taskManager) };

        case 'cleanup':
          handleCleanup(taskManager, payload as TaskIdPayload);
          return { success: true, data: null };

        default:
          return {
            success: false,
            error: { code: 'INVALID_ACTION', message: `Unknown action: ${action}` },
          };
      }
    } catch (error) {
      logger.error(`Task IPC error [${action}]:`, error);
      return {
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: error instanceof Error ? error.message : String(error)
        },
      };
    }
  });

  logger.info('Task IPC handlers registered');
}
