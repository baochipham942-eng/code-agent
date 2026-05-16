// ============================================================================
// MasterTaskManager — MasterTask 的内存编排层 + 事件总线 + 持久化
// ============================================================================
//
// 职责：
//   - 在内存维护 MasterTask 索引（byId Map），与 Repository 双轨：内存即时、
//     DB 持久化；listInProgress / getById 在内存 miss 时回退到 DB 重建实例。
//   - 每个 transition 方法做三件事：触发 MasterTask 的状态机方法（含 assertTransition）、
//     调 repository.updateStatus 持久化、emit StatusChanged（终态再 emit Completed/Failed）。
//   - 桥接子 AgentTask：attachAgentTask 时 wrap agent.onHook，chain 旧 hook 不破坏，
//     在子 agent fire TaskCompleted 时只 emit MasterTaskAgentTaskCompleted —— 不
//     自动转 MasterTask 状态，由上层（IPC / agentLoop）决定后续动作。
//   - PlanProgressDelta：appendPlanProgress 4 步全做（in-memory + plan_events
//     append + plan_progress 列更新 + emit Delta）。
//
// 设计约束（来自 P1-c2 任务卡）：
//   - 单一事件 channel：this.emit('event', payload: MasterTaskManagerEvent)，
//     订阅方用 union narrow，不要 12 个 named event。
//   - Repository lazy：getRepository() 每次调用 getMasterTaskDb()，db 为 null
//     时返回 null；写操作 null-db 时 log warning 但不抛（CLI 启动期 transient）。
//   - 不自动转 MasterTask 状态：子 agent 完成只 emit AgentTaskCompleted。
//   - 不订阅 PLANNING_EVENT_CHANNEL：留 handlePlanningEvent 私有方法占位，P1-c4 接入。
//
// 状态枚举 SSOT：src/shared/contract/task.ts 的 MasterTaskStatus +
// MASTER_TASK_TERMINAL_STATUSES。
// ============================================================================

import { EventEmitter } from 'events';

import {
  MasterTask,
  type MasterTaskMetadata,
} from './masterTask';
import { AgentTask } from './agentTask';
import type { TaskHookCallback } from './taskKernel';
import {
  MasterTaskRepository,
  getMasterTaskDb,
  type MasterTaskRow,
} from '../services/core/repositories/masterTaskRepository';
import {
  type MasterTaskStatus,
  MASTER_TASK_TERMINAL_STATUSES,
} from '../../shared/contract/task';
import { generateMessageId } from '../../shared/utils/id';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('MasterTaskManager');

// ----------------------------------------------------------------------------
// 事件类型
// ----------------------------------------------------------------------------

export type MasterTaskManagerEvent =
  | { type: 'MasterTaskCreated'; taskId: string; status: MasterTaskStatus }
  | { type: 'MasterTaskStatusChanged'; taskId: string; from: MasterTaskStatus; to: MasterTaskStatus }
  | { type: 'MasterTaskPlanProgressDelta'; taskId: string; chunk: string; appendedAt: number }
  | { type: 'MasterTaskCompleted'; taskId: string; success: boolean }
  | { type: 'MasterTaskFailed'; taskId: string; error: string }
  | { type: 'MasterTaskAgentTaskAttached'; taskId: string; agentTaskId: string }
  | { type: 'MasterTaskAgentTaskCompleted'; taskId: string; agentTaskId: string; success: boolean };

export interface RegisterOptions {
  /** 显式 id（默认 generateMessageId()） */
  id?: string;
  /** 是否写 DB（默认 true）。false 时只放内存，不写 master_tasks 表 */
  persist?: boolean;
  /** 显式时间戳（默认 Date.now()），便于测试 */
  now?: number;
}

// ----------------------------------------------------------------------------
// MasterTaskManager
// ----------------------------------------------------------------------------

export class MasterTaskManager extends EventEmitter {
  /** 内存索引：id → MasterTask 实例 */
  private byId: Map<string, MasterTask> = new Map();

  // --------------------------------------------------------------------------
  // Repository lazy 取源
  // --------------------------------------------------------------------------

  /**
   * 每次调用都重新取 db，避免缓存过期的 transient null（CLI 启动期 db 尚未 init）。
   * db 为 null 时返回 null，调用方负责 warn + 跳过持久化。
   */
  private getRepository(): MasterTaskRepository | null {
    const db = getMasterTaskDb();
    if (!db) return null;
    return new MasterTaskRepository(db);
  }

  // --------------------------------------------------------------------------
  // 生命周期
  // --------------------------------------------------------------------------

  register(metadata: MasterTaskMetadata, options: RegisterOptions = {}): MasterTask {
    const id = options.id ?? generateMessageId();
    const persist = options.persist !== false;
    const now = options.now ?? Date.now();

    const task = new MasterTask(id, metadata);
    this.byId.set(id, task);

    if (persist) {
      const repo = this.getRepository();
      if (repo) {
        try {
          repo.create({
            id,
            title: task.title,
            status: task.status,
            workspaceUri: task.workspaceUri,
            planProgress: task.planProgress,
            sandboxId: task.sandboxId ?? null,
            parentTaskId: task.parentTaskId ?? null,
            ownerUserId: task.ownerUserId,
            blocks: Array.from(task.blocks),
            blockedBy: Array.from(task.blockedBy),
            createdAt: now,
            updatedAt: now,
          });
        } catch (err) {
          logger.warn(`register: repository.create failed for ${id}`, err);
        }
      } else {
        logger.warn(`register: master task db unavailable, skipping persist for ${id}`);
      }
    }

    this.emit('event', {
      type: 'MasterTaskCreated',
      taskId: id,
      status: task.status,
    } satisfies MasterTaskManagerEvent);

    return task;
  }

  /** 仅从内存移除；DB row 仍存在（终态保留，由调用方决定 softDelete 时机） */
  unregister(id: string): void {
    this.byId.delete(id);
  }

  /**
   * 内存优先 → DB 重建。
   * 重建时通过私有字段直写恢复 _status / planProgress（参考 AgentTask.loadFromDisk）。
   * 注意：重建是 lookup 不是变更，不 emit 任何事件。
   */
  getById(id: string): MasterTask | null {
    const cached = this.byId.get(id);
    if (cached) return cached;

    const repo = this.getRepository();
    if (!repo) return null;

    const row = repo.getById(id);
    if (!row) return null;

    const task = this.reviveFromRow(row);
    this.byId.set(id, task);
    return task;
  }

  /**
   * 内存 ∪ DB 的 in-progress 集合（按 ownerUserId 过滤，默认 'local'）。
   * 内存优先（包含未持久化的 persist:false 任务），DB 兜底补未在内存的。
   */
  listInProgress(ownerUserId?: string): MasterTask[] {
    const result: MasterTask[] = [];
    const owner = ownerUserId ?? 'local';
    const seen = new Set<string>();

    // 1) 内存：过滤非终态 + ownerUserId 匹配
    for (const task of this.byId.values()) {
      if (task.ownerUserId !== owner) continue;
      if (MASTER_TASK_TERMINAL_STATUSES.has(task.status)) continue;
      result.push(task);
      seen.add(task.id);
    }

    // 2) DB：补未在内存的（lazy 重建并放回内存）
    const repo = this.getRepository();
    if (repo) {
      try {
        const rows = repo.listInProgress(owner);
        for (const row of rows) {
          if (seen.has(row.id)) continue;
          const task = this.reviveFromRow(row);
          this.byId.set(row.id, task);
          result.push(task);
        }
      } catch (err) {
        logger.warn(`listInProgress: repository.listInProgress failed`, err);
      }
    }

    return result;
  }

  // --------------------------------------------------------------------------
  // 状态机驱动
  // --------------------------------------------------------------------------

  advance(id: string): void {
    this.runTransition(id, (task) => task.advance());
  }

  enqueue(id: string): void {
    this.runTransition(id, (task) => task.enqueue());
  }

  waitForDependency(id: string): void {
    this.runTransition(id, (task) => task.waitForDependency());
  }

  start(id: string): void {
    this.runTransition(id, (task) => task.start());
  }

  pause(id: string): void {
    this.runTransition(id, (task) => task.pause());
  }

  requestReview(id: string): void {
    this.runTransition(id, (task) => task.requestReview());
  }

  approveReview(id: string): void {
    this.runTransition(id, (task) => task.approveReview());
  }

  rejectReview(id: string): void {
    this.runTransition(id, (task) => task.rejectReview());
  }

  complete(id: string): void {
    this.runTransition(id, (task) => task.complete());
  }

  fail(id: string, error: string): void {
    this.runTransition(id, (task) => task.fail(error), { error });
  }

  errorOut(id: string, error: string): void {
    this.runTransition(id, (task) => task.errorOut(error), { error });
  }

  cancel(id: string): void {
    this.runTransition(id, (task) => task.cancel());
  }

  // --------------------------------------------------------------------------
  // 子 agent / session 关联
  // --------------------------------------------------------------------------

  attachAgentTask(masterTaskId: string, agentTask: AgentTask): void {
    const master = this.requireById(masterTaskId);
    master.attachAgentTask(agentTask.id);
    // 反向引用：让 agentTask 知道自己挂在哪个 master 下（持久化时进 metadata.json）
    if (!agentTask.parentMasterTaskId) {
      agentTask.parentMasterTaskId = masterTaskId;
    }

    // chain 现有 onHook：保留 previous，新逻辑追加
    const previous = agentTask.onHook;
    const chained: TaskHookCallback = (event, payload) => {
      try {
        previous?.(event, payload);
      } catch (err) {
        logger.warn(`attachAgentTask: previous onHook threw for ${agentTask.id}`, err);
      }
      if (event === 'TaskCompleted') {
        this.emit('event', {
          type: 'MasterTaskAgentTaskCompleted',
          taskId: masterTaskId,
          agentTaskId: agentTask.id,
          success: payload.success ?? false,
        } satisfies MasterTaskManagerEvent);
      }
    };
    agentTask.onHook = chained;

    this.emit('event', {
      type: 'MasterTaskAgentTaskAttached',
      taskId: masterTaskId,
      agentTaskId: agentTask.id,
    } satisfies MasterTaskManagerEvent);
  }

  attachSession(masterTaskId: string, sessionId: string): void {
    const master = this.requireById(masterTaskId);
    master.attachSession(sessionId);
  }

  // --------------------------------------------------------------------------
  // Plan progress
  // --------------------------------------------------------------------------

  appendPlanProgress(masterTaskId: string, chunk: string): void {
    const master = this.requireById(masterTaskId);
    const appendedAt = Date.now();

    // 1) in-memory 累加
    master.appendPlanProgress(chunk);

    // 2) plan_events append-only 写入 + 3) plan_progress 列覆盖
    const repo = this.getRepository();
    if (repo) {
      try {
        repo.appendPlanEvent(masterTaskId, chunk, appendedAt);
        repo.updatePlanProgress(masterTaskId, master.planProgress, appendedAt);
      } catch (err) {
        logger.warn(`appendPlanProgress: repository writes failed for ${masterTaskId}`, err);
      }
    } else {
      logger.warn(`appendPlanProgress: master task db unavailable, skipping persist for ${masterTaskId}`);
    }

    // 4) emit Delta
    this.emit('event', {
      type: 'MasterTaskPlanProgressDelta',
      taskId: masterTaskId,
      chunk,
      appendedAt,
    } satisfies MasterTaskManagerEvent);
  }

  // --------------------------------------------------------------------------
  // 私有 helpers
  // --------------------------------------------------------------------------

  /**
   * 通用 transition 模板：触发 MasterTask 状态机方法 → 持久化 updateStatus →
   * emit StatusChanged → 终态时额外 emit Completed / Failed。
   *
   * MasterTask 的状态机方法已经包含 assertTransition，违法转换会抛
   * InvalidMasterTaskTransitionError，调用方负责 catch。
   */
  private runTransition(
    id: string,
    apply: (task: MasterTask) => void,
    context?: { error?: string },
  ): void {
    const task = this.requireById(id);
    const from = task.status;

    apply(task); // 内部抛错由调用方处理；抛错时不持久化、不 emit

    const to = task.status;
    if (to === from) return; // 防御：理论上状态机方法都会改 status，这里只保险

    const now = Date.now();
    const isTerminal = MASTER_TASK_TERMINAL_STATUSES.has(to);

    const repo = this.getRepository();
    if (repo) {
      try {
        repo.updateStatus(id, to, {
          updatedAt: now,
          finishedAt: isTerminal ? now : undefined,
        });
      } catch (err) {
        logger.warn(`runTransition: repository.updateStatus failed for ${id}`, err);
      }
    } else {
      logger.warn(`runTransition: master task db unavailable, skipping persist for ${id}`);
    }

    this.emit('event', {
      type: 'MasterTaskStatusChanged',
      taskId: id,
      from,
      to,
    } satisfies MasterTaskManagerEvent);

    if (isTerminal) {
      if (to === 'failed' || to === 'error') {
        this.emit('event', {
          type: 'MasterTaskFailed',
          taskId: id,
          error: context?.error ?? task.error ?? to,
        } satisfies MasterTaskManagerEvent);
      } else {
        // completed / done / cancelled — 都视为 Completed，success 仅 completed/done 为 true
        const success = to === 'completed' || to === 'done';
        this.emit('event', {
          type: 'MasterTaskCompleted',
          taskId: id,
          success,
        } satisfies MasterTaskManagerEvent);
      }
    }
  }

  private requireById(id: string): MasterTask {
    const task = this.getById(id);
    if (!task) {
      throw new Error(`MasterTaskManager: unknown master task id=${id}`);
    }
    return task;
  }

  /**
   * 用 DB row 重建 MasterTask 实例。
   * 私有字段直写 _status 参考 AgentTask.loadFromDisk pattern（注释里 TODO 提到
   * 后续应该提供 fromPersisted 静态构造器，但本次先沿用一致风格）。
   */
  private reviveFromRow(row: MasterTaskRow): MasterTask {
    const task = new MasterTask(row.id, {
      title: row.title,
      workspaceUri: row.workspaceUri,
      ownerUserId: row.ownerUserId,
      sandboxId: row.sandboxId ?? undefined,
      parentTaskId: row.parentTaskId ?? undefined,
      blocks: row.blocks,
      blockedBy: row.blockedBy,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- _status 是 TaskKernel 的 protected 字段，反序列化时需要绕过；与 AgentTask.loadFromDisk 同 pattern
    (task as any)._status = row.status;
    task.planProgress = row.planProgress;
    return task;
  }
}
