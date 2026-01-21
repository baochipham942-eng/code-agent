// ============================================================================
// Task IPC Handlers - task:* / domain:task 通道
// Wave 5: 多任务并行支持
// ============================================================================

import type { IpcMain } from 'electron';
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
  getTaskManager: () => TaskManager | null,
  payload: StartTaskPayload
): Promise<void> {
  const taskManager = getTaskManager();
  if (!taskManager) throw new Error('TaskManager not initialized');

  const { sessionId, message, attachments } = payload;
  await taskManager.startTask(sessionId, message, attachments);
}

async function handleInterruptTask(
  getTaskManager: () => TaskManager | null,
  payload: TaskIdPayload
): Promise<void> {
  const taskManager = getTaskManager();
  if (!taskManager) throw new Error('TaskManager not initialized');

  await taskManager.interruptTask(payload.sessionId);
}

async function handleCancelTask(
  getTaskManager: () => TaskManager | null,
  payload: TaskIdPayload
): Promise<void> {
  const taskManager = getTaskManager();
  if (!taskManager) throw new Error('TaskManager not initialized');

  await taskManager.cancelTask(payload.sessionId);
}

function handleGetState(
  getTaskManager: () => TaskManager | null,
  payload: TaskIdPayload
): SessionState {
  const taskManager = getTaskManager();
  if (!taskManager) throw new Error('TaskManager not initialized');

  return taskManager.getSessionState(payload.sessionId);
}

function handleGetAllStates(
  getTaskManager: () => TaskManager | null
): Record<string, SessionState> {
  const taskManager = getTaskManager();
  if (!taskManager) throw new Error('TaskManager not initialized');

  const states = taskManager.getAllStates();
  const result: Record<string, SessionState> = {};
  for (const [key, value] of states) {
    result[key] = value;
  }
  return result;
}

function handleGetQueue(
  getTaskManager: () => TaskManager | null
): string[] {
  const taskManager = getTaskManager();
  if (!taskManager) throw new Error('TaskManager not initialized');

  return taskManager.getWaitingQueue();
}

function handleGetStats(
  getTaskManager: () => TaskManager | null
): TaskStats {
  const taskManager = getTaskManager();
  if (!taskManager) throw new Error('TaskManager not initialized');

  return taskManager.getStats();
}

function handleCleanup(
  getTaskManager: () => TaskManager | null,
  payload: TaskIdPayload
): void {
  const taskManager = getTaskManager();
  if (!taskManager) throw new Error('TaskManager not initialized');

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

    try {
      switch (action) {
        case 'start':
          await handleStartTask(getTaskManager, payload as StartTaskPayload);
          return { success: true, data: null };

        case 'interrupt':
          await handleInterruptTask(getTaskManager, payload as TaskIdPayload);
          return { success: true, data: null };

        case 'cancel':
          await handleCancelTask(getTaskManager, payload as TaskIdPayload);
          return { success: true, data: null };

        case 'getState':
          return { success: true, data: handleGetState(getTaskManager, payload as TaskIdPayload) };

        case 'getAllStates':
          return { success: true, data: handleGetAllStates(getTaskManager) };

        case 'getQueue':
          return { success: true, data: handleGetQueue(getTaskManager) };

        case 'getStats':
          return { success: true, data: handleGetStats(getTaskManager) };

        case 'cleanup':
          handleCleanup(getTaskManager, payload as TaskIdPayload);
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
