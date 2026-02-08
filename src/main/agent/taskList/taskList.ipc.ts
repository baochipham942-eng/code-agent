// ============================================================================
// TaskList IPC Handlers - 前端 ↔ 后端通信
// ============================================================================

import { ipcMain } from 'electron';
import { BrowserWindow } from 'electron';
import { getTaskListManager } from './index';
import { createLogger } from '../../services/infra/logger';
import type { TaskItemIpc, TaskListEventIpc } from '../../../shared/ipc';
import { IPC_CHANNELS } from '../../../shared/ipc';

const logger = createLogger('TaskListIPC');

export function registerTaskListHandlers(): void {
  const manager = getTaskListManager();

  // 订阅事件并转发到所有 renderer
  manager.subscribe((event: TaskListEventIpc) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(IPC_CHANNELS.TASKLIST_EVENT, event);
    }
  });

  // getState
  ipcMain.handle(IPC_CHANNELS.TASKLIST_GET_STATE, () => {
    return manager.getState();
  });

  // getTasks
  ipcMain.handle(IPC_CHANNELS.TASKLIST_GET_TASKS, () => {
    return manager.getTasks();
  });

  // updateTask
  ipcMain.handle(
    IPC_CHANNELS.TASKLIST_UPDATE_TASK,
    (_event, taskId: string, changes: Partial<TaskItemIpc>) => {
      return manager.updateTask(taskId, changes);
    }
  );

  // reassign
  ipcMain.handle(
    IPC_CHANNELS.TASKLIST_REASSIGN,
    (_event, taskId: string, assignee: string) => {
      return manager.reassign(taskId, assignee);
    }
  );

  // approve
  ipcMain.handle(IPC_CHANNELS.TASKLIST_APPROVE, (_event, taskId: string) => {
    manager.approve(taskId);
  });

  // approveAll
  ipcMain.handle(IPC_CHANNELS.TASKLIST_APPROVE_ALL, () => {
    manager.approveAll();
  });

  // deleteTask
  ipcMain.handle(IPC_CHANNELS.TASKLIST_DELETE_TASK, (_event, taskId: string) => {
    return manager.deleteTask(taskId);
  });

  // setAutoAssign
  ipcMain.handle(IPC_CHANNELS.TASKLIST_SET_AUTO_ASSIGN, (_event, enabled: boolean) => {
    manager.setAutoAssign(enabled);
  });

  // setRequireApproval
  ipcMain.handle(IPC_CHANNELS.TASKLIST_SET_REQUIRE_APPROVAL, (_event, enabled: boolean) => {
    manager.setRequireApproval(enabled);
  });

  logger.info('TaskList IPC handlers registered');
}
