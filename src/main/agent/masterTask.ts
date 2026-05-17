// ============================================================================
// MasterTask — 用户级工作单元（对应 Qoder Quest 状态机）
// ============================================================================
//
// 与 AgentTask（sidecar 子任务）的区别：
//   - MasterTask 是用户视角的"一件事"，可以挂多个 AgentTask 和 Session
//   - 13 个 transition 方法覆盖 created/pending/queued/waiting/running/paused/
//     review/completed/done/cancelled/failed/error 12 个状态
//   - 终态判定走 src/shared/contract/task.ts 的 MASTER_TASK_TERMINAL_STATUSES，
//     而不是字面量数组，保证 SSOT
//
// 注意：本类只负责状态机 + 内部字段更新，不负责 Repository / Manager / IPC，
// 那些走 P1 阶段。PlanProgressDelta 事件后续在 MasterTaskManager 用独立 channel
// 推送，这里只通过 appendPlanProgress 维护内部 planProgress 字段。
// ============================================================================

import { TaskKernel } from './taskKernel';
import {
  type MasterTaskStatus,
  MASTER_TASK_TERMINAL_STATUSES,
} from '../../shared/contract/task';

export interface MasterTaskMetadata {
  title: string;
  workspaceUri: string;
  ownerUserId?: string;
  sandboxId?: string;
  parentTaskId?: string;
  blocks?: string[];
  blockedBy?: string[];
}

export class InvalidMasterTaskTransitionError extends Error {
  constructor(from: MasterTaskStatus, to: MasterTaskStatus) {
    super(`Invalid master task state transition: ${from} → ${to}`);
    this.name = 'InvalidMasterTaskTransitionError';
  }
}

export class MasterTask extends TaskKernel<MasterTaskStatus> {
  title: string;
  workspaceUri: string;
  ownerUserId: string;
  sandboxId?: string;
  parentTaskId?: string;
  /**
   * 计划进度的累积字符串。MasterTaskManager 会通过独立的 PlanProgressDelta
   * channel 把增量推送给前端；本类只负责维护内部状态。
   */
  planProgress: string = '';
  readonly childAgentTaskIds: Set<string> = new Set();
  readonly attachedSessionIds: Set<string> = new Set();

  constructor(id: string, metadata: MasterTaskMetadata) {
    super(id, 'created');
    this.title = metadata.title;
    this.workspaceUri = metadata.workspaceUri;
    this.ownerUserId = metadata.ownerUserId ?? 'local';
    this.sandboxId = metadata.sandboxId;
    this.parentTaskId = metadata.parentTaskId;
    if (metadata.blocks) {
      for (const id of metadata.blocks) this.blocks.add(id);
    }
    if (metadata.blockedBy) {
      for (const id of metadata.blockedBy) this.blockedBy.add(id);
    }
  }

  /** 覆盖基类默认实现，抛出携带具体 MasterTaskStatus 的专用错误 */
  protected assertTransition(target: MasterTaskStatus, validFrom: MasterTaskStatus[]): void {
    if (!validFrom.includes(this._status)) {
      throw new InvalidMasterTaskTransitionError(this._status, target);
    }
  }

  // --- State transitions ----------------------------------------------------

  /** created → pending（任务创建完成，登记到队列前） */
  advance(): void {
    this.assertTransition('pending', ['created']);
    this._status = 'pending';
    this.onHook?.('TaskCreated', { taskId: this.id, agentType: 'master' });
  }

  /** pending → queued（进入调度队列） */
  enqueue(): void {
    this.assertTransition('queued', ['pending']);
    this._status = 'queued';
  }

  /** pending/queued → waiting（等待依赖完成） */
  waitForDependency(): void {
    this.assertTransition('waiting', ['pending', 'queued']);
    this._status = 'waiting';
  }

  /** pending/queued/waiting/paused/review → running */
  start(): void {
    this.assertTransition('running', ['pending', 'queued', 'waiting', 'paused', 'review']);
    this._status = 'running';
    this.abortController = new AbortController();
  }

  /** running → paused（中断执行） */
  pause(): void {
    this.assertTransition('paused', ['running']);
    this._status = 'paused';
    this.abortController?.abort();
    this.abortController = null;
  }

  /** running → review（请求人工审核） */
  requestReview(): void {
    this.assertTransition('review', ['running']);
    this._status = 'review';
  }

  /** review → done（审核通过） */
  approveReview(): void {
    this.assertTransition('done', ['review']);
    this._status = 'done';
    this.onHook?.('TaskCompleted', { taskId: this.id, agentType: 'master', success: true });
  }

  /** review → running（审核打回，重新执行） */
  rejectReview(): void {
    this.assertTransition('running', ['review']);
    this._status = 'running';
    this.abortController = new AbortController();
  }

  /** running → completed（正常完成） */
  complete(): void {
    this.assertTransition('completed', ['running']);
    this._status = 'completed';
    this.abortController = null;
    this.onHook?.('TaskCompleted', { taskId: this.id, agentType: 'master', success: true });
  }

  /** running → failed（执行失败） */
  fail(error: string): void {
    this.assertTransition('failed', ['running']);
    this._status = 'failed';
    this._error = error;
    this.abortController = null;
    this.onHook?.('TaskCompleted', { taskId: this.id, agentType: 'master', success: false });
  }

  /** 任何非终态 → error（系统级异常） */
  errorOut(error: string): void {
    if (MASTER_TASK_TERMINAL_STATUSES.has(this._status)) {
      throw new InvalidMasterTaskTransitionError(this._status, 'error');
    }
    this._status = 'error';
    this._error = error;
    this.abortController = null;
    this.onHook?.('TaskCompleted', { taskId: this.id, agentType: 'master', success: false });
  }

  /** 任何非终态 → cancelled（用户取消） */
  cancel(): void {
    if (MASTER_TASK_TERMINAL_STATUSES.has(this._status)) {
      throw new InvalidMasterTaskTransitionError(this._status, 'cancelled');
    }
    this._status = 'cancelled';
    this.abortController?.abort();
    this.abortController = null;
    this.onHook?.('TaskCompleted', { taskId: this.id, agentType: 'master', success: false });
  }

  // --- 内部字段维护 ---------------------------------------------------------

  /**
   * 累加计划进度字符串。注意：TaskKernel 的 TaskHookCallback 字面量仅
   * 'TaskCreated' | 'TaskCompleted'，PlanProgressDelta 事件后续 P1-c2 在
   * MasterTaskManager 用独立 channel 推送，这里只更新内部字段。
   */
  appendPlanProgress(chunk: string): void {
    this.planProgress += chunk;
  }

  attachAgentTask(agentTaskId: string): void {
    this.childAgentTaskIds.add(agentTaskId);
  }

  attachSession(sessionId: string): void {
    this.attachedSessionIds.add(sessionId);
  }
}
