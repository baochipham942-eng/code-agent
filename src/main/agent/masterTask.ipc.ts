// ============================================================================
// MasterTask IPC Handlers — 前端 ↔ 后端通信
// ============================================================================
//
// 职责：
//   - 订阅 MasterTaskManager 'event' channel，把 MasterTaskManagerEvent 广播
//     到所有 BrowserWindow（renderer 侧用 IPC_CHANNELS.MASTER_TASK_EVENT 订阅）
//   - 注册 11 个 ipcMain.handle（create / list / listInProgress / getById /
//     updateStatus / pause / resume / cancel / approveReview / rejectReview /
//     bindSession）
//   - 序列化 MasterTask 实例 → renderer 友好的 plain object（Set → Array）
//   - updateStatus 路由：把 renderer 传入的 targetStatus 映射到 manager 的
//     12 个 transition 方法之一
//
// 设计约束：
//   - MasterTask 类含 Set / abortController 等无法跨 IPC 边界的字段，必须走
//     serializeMasterTask 统一转 DTO（MasterTaskDTO）
//   - master-task:list 直接走 repository.list，不走 manager.byId（list 需要
//     全量包含终态历史，manager 内存只保留非终态 / 最近访问过的）
//   - 调用 manager.* transition 方法时不 try/catch：调用方应捕获
//     InvalidMasterTaskTransitionError 并向用户提示，这里仅透传
// ============================================================================

import { ipcMain, BrowserWindow } from '../platform';
import { createLogger } from '../services/infra/logger';
import {
  getMasterTaskManager,
  type MasterTaskManagerEvent,
} from './masterTaskManager';
import { getDatabase } from '../services/core/databaseService';
import {
  MasterTaskRepository,
  getMasterTaskDb,
  type MasterTaskListFilter,
  type MasterTaskRow,
} from '../services/core/repositories/masterTaskRepository';
import type { MasterTask } from './masterTask';
import type { MasterTaskMetadata } from './masterTask';
import type { MasterTaskStatus } from '../../shared/contract/task';
import { IPC_CHANNELS } from '../../shared/ipc';

const logger = createLogger('MasterTaskIPC');

// ----------------------------------------------------------------------------
// DTO（renderer 友好的 plain object）
// ----------------------------------------------------------------------------

export interface MasterTaskDTO {
  id: string;
  status: MasterTaskStatus;
  title: string;
  workspaceUri: string;
  ownerUserId: string;
  sandboxId?: string;
  parentTaskId?: string;
  planProgress: string;
  blocks: string[];
  blockedBy: string[];
  childAgentTaskIds: string[];
  attachedSessionIds: string[];
  error?: string;
}

/** 把 MasterTask 实例（含 Set）转 plain object */
export function serializeMasterTask(task: MasterTask): MasterTaskDTO {
  return {
    id: task.id,
    status: task.status,
    title: task.title,
    workspaceUri: task.workspaceUri,
    ownerUserId: task.ownerUserId,
    sandboxId: task.sandboxId,
    parentTaskId: task.parentTaskId,
    planProgress: task.planProgress,
    blocks: Array.from(task.blocks),
    blockedBy: Array.from(task.blockedBy),
    childAgentTaskIds: Array.from(task.childAgentTaskIds),
    attachedSessionIds: Array.from(task.attachedSessionIds),
    error: task.error,
  };
}

/** 把 repository row 转 DTO（list 场景用，避免重建 MasterTask 实例） */
function serializeMasterTaskRow(row: MasterTaskRow): MasterTaskDTO {
  return {
    id: row.id,
    status: row.status,
    title: row.title,
    workspaceUri: row.workspaceUri,
    ownerUserId: row.ownerUserId,
    sandboxId: row.sandboxId ?? undefined,
    parentTaskId: row.parentTaskId ?? undefined,
    planProgress: row.planProgress,
    blocks: row.blocks,
    blockedBy: row.blockedBy,
    childAgentTaskIds: [],
    attachedSessionIds: [],
  };
}

// ----------------------------------------------------------------------------
// updateStatus 路由表
// ----------------------------------------------------------------------------
//
// renderer 不直接调 12 个 transition 方法，而是统一传 targetStatus，由 main
// 进程路由到对应方法。终态写入（failed / error）需要 error message，目前
// 用占位字符串，后续可让 renderer payload 携带 error。
//
// 不允许 → 'created'：MasterTask 构造器初始状态就是 'created'，业务上没有
// "回到创建态" 的场景，显式拒绝。
//

function routeUpdateStatus(
  manager: ReturnType<typeof getMasterTaskManager>,
  id: string,
  target: MasterTaskStatus,
): void {
  switch (target) {
    case 'pending':
      manager.advance(id);
      break;
    case 'queued':
      manager.enqueue(id);
      break;
    case 'waiting':
      manager.waitForDependency(id);
      break;
    case 'running':
      manager.start(id);
      break;
    case 'paused':
      manager.pause(id);
      break;
    case 'review':
      manager.requestReview(id);
      break;
    case 'done':
      manager.approveReview(id);
      break;
    case 'completed':
      manager.complete(id);
      break;
    case 'cancelled':
      manager.cancel(id);
      break;
    case 'failed':
      manager.fail(id, 'updateStatus(failed)');
      break;
    case 'error':
      manager.errorOut(id, 'updateStatus(error)');
      break;
    case 'created':
      throw new Error(`Cannot transition to 'created' via updateStatus`);
  }
}

// ----------------------------------------------------------------------------
// 注册入口
// ----------------------------------------------------------------------------

export function registerMasterTaskHandlers(): void {
  const manager = getMasterTaskManager();

  // 订阅 manager 事件 → 广播给所有 BrowserWindow
  manager.on('event', (event: MasterTaskManagerEvent) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(IPC_CHANNELS.MASTER_TASK_EVENT, event);
    }
  });

  // create
  ipcMain.handle(
    IPC_CHANNELS.MASTER_TASK_CREATE,
    (_e, payload: MasterTaskMetadata) => {
      const task = manager.register(payload);
      return serializeMasterTask(task);
    },
  );

  // list — 直接走 repository.list，包含终态历史（manager.byId 不含）
  ipcMain.handle(
    IPC_CHANNELS.MASTER_TASK_LIST,
    (_e, filter?: MasterTaskListFilter): MasterTaskDTO[] => {
      // 先试 helper（test mock 走这路径）；helper 在 dev/cjs 下因
      // module duplication 拿不到 isReady DB，fallback 到 singleton getDatabase。
      let db = getMasterTaskDb();
      if (!db) {
        const svc = getDatabase();
        db = svc?.isReady ? svc.getDb() : null;
      }
      if (!db) {
        logger.warn('master-task:list — DB unavailable');
        return [];
      }
      const repo = new MasterTaskRepository(db);
      const rows = repo.list(filter ?? {});
      return rows.map(serializeMasterTaskRow);
    },
  );

  // listInProgress — 走 manager（内存 ∪ DB）
  ipcMain.handle(
    IPC_CHANNELS.MASTER_TASK_LIST_IN_PROGRESS,
    (_e, ownerUserId?: string): MasterTaskDTO[] => {
      return manager.listInProgress(ownerUserId).map(serializeMasterTask);
    },
  );

  // getById
  ipcMain.handle(
    IPC_CHANNELS.MASTER_TASK_GET_BY_ID,
    (_e, id: string): MasterTaskDTO | null => {
      const task = manager.getById(id);
      return task ? serializeMasterTask(task) : null;
    },
  );

  // updateStatus
  ipcMain.handle(
    IPC_CHANNELS.MASTER_TASK_UPDATE_STATUS,
    (_e, id: string, targetStatus: MasterTaskStatus) => {
      routeUpdateStatus(manager, id, targetStatus);
    },
  );

  // pause / resume / cancel
  ipcMain.handle(IPC_CHANNELS.MASTER_TASK_PAUSE, (_e, id: string) => {
    manager.pause(id);
  });

  // resume = start from paused（状态机里 start() 接受 paused → running）
  ipcMain.handle(IPC_CHANNELS.MASTER_TASK_RESUME, (_e, id: string) => {
    manager.start(id);
  });

  ipcMain.handle(IPC_CHANNELS.MASTER_TASK_CANCEL, (_e, id: string) => {
    manager.cancel(id);
  });

  // approveReview / rejectReview
  ipcMain.handle(IPC_CHANNELS.MASTER_TASK_APPROVE_REVIEW, (_e, id: string) => {
    manager.approveReview(id);
  });

  ipcMain.handle(IPC_CHANNELS.MASTER_TASK_REJECT_REVIEW, (_e, id: string) => {
    manager.rejectReview(id);
  });

  // bindSession
  ipcMain.handle(
    IPC_CHANNELS.MASTER_TASK_BIND_SESSION,
    (_e, masterTaskId: string, sessionId: string) => {
      manager.attachSession(masterTaskId, sessionId);
    },
  );

  logger.info('MasterTask IPC handlers registered');
}
