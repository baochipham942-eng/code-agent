// ============================================================================
// MasterTask Store - 跨 workspace 用户级工作单元状态管理
// ============================================================================
//
// 职责:
//   - 通过 IPC_CHANNELS.MASTER_TASK_LIST 拉取全量 MasterTask DTO
//   - 订阅 IPC_CHANNELS.MASTER_TASK_EVENT，把 manager 广播的事件增量灌到 store
//   - 暴露 pause/resume/cancel/updateStatus action，结果由 IPC event 回灌而不
//     是 optimistic 更新（避免和 manager 状态机不一致）
//   - 提供 status / workspace 两层 filter（纯本地，组件层 useMemo 过滤显示）
//
// 设计约束:
//   - 不缓存 planProgress 实时增量（PlanProgressDelta 由详情页订阅）
//   - 不缓存 agentTask 子节点（AgentTaskAttached/Completed 走详情页）
//   - 终态(completed/done/failed/cancelled/error)的 task 也保留，由 list 全量
//     拉回；只在用户主动 reload 时刷新
// ============================================================================

import { create } from 'zustand';
import type {
  MasterTaskDTO,
  MasterTaskStatus,
  MasterTaskManagerEvent,
} from '@shared/contract/task';
import { IPC_CHANNELS } from '@shared/ipc';
import { invoke, on } from '../services/ipcService';
import { createLogger } from '../utils/logger';

const logger = createLogger('MasterTaskStore');

// ----------------------------------------------------------------------------
// State 类型
// ----------------------------------------------------------------------------

export type MasterTaskStatusFilter = MasterTaskStatus | 'all';
export type MasterTaskWorkspaceFilter = string | 'all';

export interface MasterTaskStoreState {
  tasks: MasterTaskDTO[];
  filterStatus: MasterTaskStatusFilter;
  filterWorkspace: MasterTaskWorkspaceFilter;
  loading: boolean;
  error: string | null;

  // detail view state（P2-c2）
  // - selectedTaskId: 当前打开详情面板的 task；null 表示无 split view
  // - planProgressBuffer: 详情页订阅到的 PlanProgressDelta 累加 chunk
  //   (taskId → 累计文本)，与 DTO.planProgress (DB baseline) 拼接渲染
  // - detailLoading / detailError: getTaskById IPC 状态
  selectedTaskId: string | null;
  planProgressBuffer: Map<string, string>;
  detailLoading: boolean;
  detailError: string | null;

  // actions
  load: () => Promise<void>;
  updateStatus: (id: string, target: MasterTaskStatus) => Promise<void>;
  cancel: (id: string) => Promise<void>;
  pause: (id: string) => Promise<void>;
  resume: (id: string) => Promise<void>;
  setFilterStatus: (status: MasterTaskStatusFilter) => void;
  setFilterWorkspace: (workspace: MasterTaskWorkspaceFilter) => void;

  // detail view actions（P2-c2）
  selectTask: (id: string | null) => void;
  loadTaskDetail: (id: string) => Promise<MasterTaskDTO | null>;
  clearPlanProgressBuffer: (taskId: string) => void;

  // 事件入口（main → renderer 广播经由 attachMasterTaskIpcListener 调用）
  handleEvent: (event: MasterTaskManagerEvent) => void;

  // 测试用：重置 store（不重新 attach listener）
  reset: () => void;
}

// ----------------------------------------------------------------------------
// 事件处理 helpers
// ----------------------------------------------------------------------------

function applyCreatedEvent(
  tasks: MasterTaskDTO[],
  event: Extract<MasterTaskManagerEvent, { type: 'MasterTaskCreated' }>,
): MasterTaskDTO[] {
  // 去重：同 id 已存在则不重复 append（来自 IPC 重发或 P0 缓存重放场景）
  if (tasks.some((t) => t.id === event.taskId)) {
    return tasks;
  }
  // 仅用事件 payload 拼一个最小 DTO；list 重拉时会被完整 DTO 覆盖。
  // 没有 title / workspaceUri 等元数据 —— 渲染层需要兜底显示 'Unnamed task'
  const stub: MasterTaskDTO = {
    id: event.taskId,
    status: event.status,
    title: '',
    workspaceUri: '',
    ownerUserId: '',
    planProgress: '',
    blocks: [],
    blockedBy: [],
    childAgentTaskIds: [],
    attachedSessionIds: [],
  };
  return [...tasks, stub];
}

function applyStatusChangedEvent(
  tasks: MasterTaskDTO[],
  event: Extract<MasterTaskManagerEvent, { type: 'MasterTaskStatusChanged' }>,
): MasterTaskDTO[] {
  const idx = tasks.findIndex((t) => t.id === event.taskId);
  if (idx < 0) return tasks;
  const next = tasks.slice();
  next[idx] = { ...next[idx], status: event.to };
  return next;
}

function applyFailedEvent(
  tasks: MasterTaskDTO[],
  event: Extract<MasterTaskManagerEvent, { type: 'MasterTaskFailed' }>,
): MasterTaskDTO[] {
  const idx = tasks.findIndex((t) => t.id === event.taskId);
  if (idx < 0) return tasks;
  const next = tasks.slice();
  next[idx] = { ...next[idx], error: event.error };
  return next;
}

/**
 * 把同 id 的 DTO 替换为 fresh 版本；不存在则 append。loadTaskDetail 用。
 */
function upsertTask(tasks: MasterTaskDTO[], fresh: MasterTaskDTO): MasterTaskDTO[] {
  const idx = tasks.findIndex((t) => t.id === fresh.id);
  if (idx < 0) return [...tasks, fresh];
  const next = tasks.slice();
  next[idx] = fresh;
  return next;
}

// ----------------------------------------------------------------------------
// Store
// ----------------------------------------------------------------------------

export const useMasterTaskStore = create<MasterTaskStoreState>()((set, get) => ({
  tasks: [],
  filterStatus: 'all',
  filterWorkspace: 'all',
  loading: false,
  error: null,

  // detail view state（P2-c2）
  selectedTaskId: null,
  planProgressBuffer: new Map<string, string>(),
  detailLoading: false,
  detailError: null,

  load: async () => {
    set({ loading: true, error: null });
    try {
      const tasks = await invoke(IPC_CHANNELS.MASTER_TASK_LIST);
      set({ tasks: tasks ?? [], loading: false });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('Failed to load master tasks', err);
      set({ loading: false, error: message });
    }
  },

  updateStatus: async (id, target) => {
    try {
      await invoke(IPC_CHANNELS.MASTER_TASK_UPDATE_STATUS, id, target);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('updateStatus failed', { id, target, err });
      set({ error: message });
    }
  },

  cancel: async (id) => {
    try {
      await invoke(IPC_CHANNELS.MASTER_TASK_CANCEL, id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('cancel failed', { id, err });
      set({ error: message });
    }
  },

  pause: async (id) => {
    try {
      await invoke(IPC_CHANNELS.MASTER_TASK_PAUSE, id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('pause failed', { id, err });
      set({ error: message });
    }
  },

  resume: async (id) => {
    try {
      await invoke(IPC_CHANNELS.MASTER_TASK_RESUME, id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('resume failed', { id, err });
      set({ error: message });
    }
  },

  setFilterStatus: (status) => set({ filterStatus: status }),
  setFilterWorkspace: (workspace) => set({ filterWorkspace: workspace }),

  // ------------------------------------------------------------------------
  // detail view actions（P2-c2）
  // ------------------------------------------------------------------------
  //
  // selectTask 不清空 planProgressBuffer —— 用户可能在 task A → B → A 切换间
  // 期待 A 的流式 chunk 累积保留（避免重新拉详情时丢失中间过程）。显式清理
  // 走 clearPlanProgressBuffer。

  selectTask: (id) => set({ selectedTaskId: id }),

  loadTaskDetail: async (id) => {
    set({ detailLoading: true, detailError: null });
    try {
      const fresh = await invoke(IPC_CHANNELS.MASTER_TASK_GET_BY_ID, id);
      if (!fresh) {
        set({ detailLoading: false });
        return null;
      }
      const { tasks } = get();
      set({ tasks: upsertTask(tasks, fresh), detailLoading: false });
      return fresh;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('loadTaskDetail failed', { id, err });
      set({ detailLoading: false, detailError: message });
      return null;
    }
  },

  clearPlanProgressBuffer: (taskId) => {
    const { planProgressBuffer } = get();
    if (!planProgressBuffer.has(taskId)) return;
    const next = new Map(planProgressBuffer);
    next.delete(taskId);
    set({ planProgressBuffer: next });
  },

  handleEvent: (event) => {
    const { tasks, planProgressBuffer } = get();
    switch (event.type) {
      case 'MasterTaskCreated':
        set({ tasks: applyCreatedEvent(tasks, event) });
        break;
      case 'MasterTaskStatusChanged':
        set({ tasks: applyStatusChangedEvent(tasks, event) });
        break;
      case 'MasterTaskFailed':
        set({ tasks: applyFailedEvent(tasks, event) });
        break;
      case 'MasterTaskCompleted':
        // 状态由 StatusChanged 事件覆盖；这里仅作 no-op
        break;
      case 'MasterTaskPlanProgressDelta': {
        // 累加 chunk 到 buffer。同 id 多次事件 append，不同 id 互不干扰。
        // 用新 Map 实例触发 zustand selector 重渲染。
        const next = new Map(planProgressBuffer);
        const prev = next.get(event.taskId) ?? '';
        next.set(event.taskId, prev + event.chunk);
        set({ planProgressBuffer: next });
        break;
      }
      case 'MasterTaskAgentTaskAttached':
      case 'MasterTaskAgentTaskCompleted':
        // 详情页只显示 childAgentTaskIds 列表（来自 DTO）；这里 no-op，等
        // loadTaskDetail 重拉刷新关联 ID 列表
        break;
      default: {
        const _exhaustive: never = event;
        void _exhaustive;
      }
    }
  },

  reset: () =>
    set({
      tasks: [],
      filterStatus: 'all',
      filterWorkspace: 'all',
      loading: false,
      error: null,
      selectedTaskId: null,
      planProgressBuffer: new Map<string, string>(),
      detailLoading: false,
      detailError: null,
    }),
}));

// ----------------------------------------------------------------------------
// IPC 订阅 wiring
// ----------------------------------------------------------------------------
//
// renderer 模块顶层 attach 一次 listener；测试环境（vitest jsdom）下 ipcService
// 已被 mock，调用 on() 不会真注册到 Electron。生产环境 attach 后 unsubscribe
// 函数保留在闭包里 —— 通常 store 模块生命周期等同于 renderer 进程生命周期，
// 不需要主动 detach。

let _detach: (() => void) | undefined;

export function attachMasterTaskIpcListener(): () => void {
  if (_detach) return _detach;
  const unsubscribe = on(IPC_CHANNELS.MASTER_TASK_EVENT, (event) => {
    useMasterTaskStore.getState().handleEvent(event);
  });
  _detach = () => {
    unsubscribe?.();
    _detach = undefined;
  };
  return _detach;
}

// 模块顶层订阅（renderer 进程启动时一次）。
// 若 ipcService 不可用（SSR / 测试 mock 返回 undefined），on() 返回 undefined，
// attachMasterTaskIpcListener 内部会容错处理。
if (typeof window !== 'undefined') {
  attachMasterTaskIpcListener();
}
