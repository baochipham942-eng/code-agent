/**
 * MasterTask 状态枚举（用户级工作单元）
 * 对应 Qoder Quest 13 状态机
 */
export type MasterTaskStatus =
  | 'created'
  | 'pending'
  | 'queued'
  | 'waiting'
  | 'running'
  | 'paused'
  | 'review'
  | 'completed'
  | 'done'
  | 'cancelled'
  | 'failed'
  | 'error';

/** 所有 MasterTaskStatus 字面量的运行时数组（用于 SQL CHECK / 校验） */
export const MASTER_TASK_STATUSES: readonly MasterTaskStatus[] = [
  'created', 'pending', 'queued', 'waiting', 'running', 'paused',
  'review', 'completed', 'done', 'cancelled', 'failed', 'error',
] as const;

/** 终态：进入后不再转换 */
export const MASTER_TASK_TERMINAL_STATUSES: ReadonlySet<MasterTaskStatus> = new Set([
  'completed', 'done', 'cancelled', 'failed', 'error',
]);

/**
 * MasterTask DTO（renderer 友好的 plain object）
 *
 * 与 src/main/agent/masterTask.ipc.ts 中的 MasterTaskDTO 结构对齐 —— main 进程
 * 通过 serializeMasterTask 把 MasterTask 实例（含 Set / AbortController）转成
 * 此形状，再经 IPC 跨进程。renderer 通过 IPC_CHANNELS.MASTER_TASK_LIST 拿到的
 * 就是这个 shape。
 */
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

/**
 * MasterTask manager 事件（main → renderer 广播）
 *
 * 与 src/main/agent/masterTaskManager.ts 中的 MasterTaskManagerEvent 结构对齐。
 * renderer 通过 IPC_CHANNELS.MASTER_TASK_EVENT 订阅。
 */
export type MasterTaskManagerEvent =
  | { type: 'MasterTaskCreated'; taskId: string; status: MasterTaskStatus }
  | {
      type: 'MasterTaskStatusChanged';
      taskId: string;
      from: MasterTaskStatus;
      to: MasterTaskStatus;
    }
  | {
      type: 'MasterTaskPlanProgressDelta';
      taskId: string;
      chunk: string;
      appendedAt: number;
    }
  | { type: 'MasterTaskCompleted'; taskId: string; success: boolean }
  | { type: 'MasterTaskFailed'; taskId: string; error: string }
  | { type: 'MasterTaskAgentTaskAttached'; taskId: string; agentTaskId: string }
  | {
      type: 'MasterTaskAgentTaskCompleted';
      taskId: string;
      agentTaskId: string;
      success: boolean;
    };

/**
 * master-task:list 过滤参数（shared shape；main 侧 MasterTaskListFilter 兼容）
 */
export interface MasterTaskListFilterShared {
  status?: MasterTaskStatus | MasterTaskStatus[];
  workspaceUri?: string;
  ownerUserId?: string;
  parentTaskId?: string | null;
  limit?: number;
  offset?: number;
}

/**
 * master-task:create 请求 payload（renderer → main）
 *
 * 结构与 src/main/agent/masterTask.ts 中的 MasterTaskMetadata 对齐。
 */
export interface MasterTaskCreatePayload {
  title: string;
  workspaceUri: string;
  ownerUserId?: string;
  sandboxId?: string;
  parentTaskId?: string;
  blocks?: string[];
  blockedBy?: string[];
}

/**
 * Subtask 摘要 DTO（master-task:listSubtasks 响应，P5 IA）
 *
 * 跨 session 合并 session_tasks 的 UI 摘要视图，结构与
 * src/main/services/core/repositories/masterTaskRepository.ts 中的
 * SessionTaskSummaryRow 对齐。status 是 SessionTask 的状态字符串
 * （'pending' | 'in_progress' | 'completed' 等），不复用 MasterTaskStatus。
 */
export interface SessionTaskSummaryDTO {
  sessionId: string;
  taskId: string;
  subject: string;
  status: string;
  createdAt: number;
}
