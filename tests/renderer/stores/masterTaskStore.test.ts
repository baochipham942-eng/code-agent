// ============================================================================
// MasterTask Store - 单元测试
// ============================================================================

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type {
  MasterTaskDTO,
  MasterTaskManagerEvent,
} from '../../../src/shared/contract/task';

// Mock ipcService —— 所有 invoke/on/off 都返回 mock resolve
const mockInvoke = vi.fn();
const mockOn = vi.fn();
const mockOff = vi.fn();

vi.mock('../../../src/renderer/services/ipcService', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
  on: (...args: unknown[]) => mockOn(...args),
  off: (...args: unknown[]) => mockOff(...args),
}));

// Mock renderer logger
vi.mock('../../../src/renderer/utils/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { useMasterTaskStore } from '../../../src/renderer/stores/masterTaskStore';
import { IPC_CHANNELS } from '../../../src/shared/ipc';

function makeTask(id: string, overrides: Partial<MasterTaskDTO> = {}): MasterTaskDTO {
  return {
    id,
    status: 'pending',
    title: `Task ${id}`,
    workspaceUri: '/tmp/workspace-a',
    ownerUserId: 'user-1',
    planProgress: '',
    blocks: [],
    blockedBy: [],
    childAgentTaskIds: [],
    attachedSessionIds: [],
    ...overrides,
  };
}

describe('masterTaskStore', () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    mockOn.mockReset();
    mockOff.mockReset();
    useMasterTaskStore.getState().reset();
  });

  // --------------------------------------------------------------------------
  // 1) 初始 state
  // --------------------------------------------------------------------------

  it('初始 state: tasks 为空数组，filter 为 "all"，loading=false，error=null', () => {
    const state = useMasterTaskStore.getState();
    expect(state.tasks).toEqual([]);
    expect(state.filterStatus).toBe('all');
    expect(state.filterWorkspace).toBe('all');
    expect(state.loading).toBe(false);
    expect(state.error).toBeNull();
  });

  // --------------------------------------------------------------------------
  // 2) load() 调用 IPC + 设置 tasks
  // --------------------------------------------------------------------------

  it('load() 调用 master-task:list 并填充 tasks', async () => {
    const fakeTasks = [makeTask('t1'), makeTask('t2', { status: 'running' })];
    mockInvoke.mockResolvedValueOnce(fakeTasks);

    await useMasterTaskStore.getState().load();

    expect(mockInvoke).toHaveBeenCalledWith(IPC_CHANNELS.MASTER_TASK_LIST);
    const state = useMasterTaskStore.getState();
    expect(state.tasks).toHaveLength(2);
    expect(state.tasks[0].id).toBe('t1');
    expect(state.tasks[1].status).toBe('running');
    expect(state.loading).toBe(false);
    expect(state.error).toBeNull();
  });

  it('load() 失败时记录 error 并清 loading', async () => {
    mockInvoke.mockRejectedValueOnce(new Error('IPC down'));

    await useMasterTaskStore.getState().load();

    const state = useMasterTaskStore.getState();
    expect(state.loading).toBe(false);
    expect(state.error).toBe('IPC down');
    expect(state.tasks).toEqual([]);
  });

  // --------------------------------------------------------------------------
  // 3) MasterTaskCreated 事件 → tasks 追加
  // --------------------------------------------------------------------------

  it('收到 MasterTaskCreated 事件后 tasks 增加一条', () => {
    const event: MasterTaskManagerEvent = {
      type: 'MasterTaskCreated',
      taskId: 'new-1',
      status: 'created',
    };

    useMasterTaskStore.getState().handleEvent(event);

    const state = useMasterTaskStore.getState();
    expect(state.tasks).toHaveLength(1);
    expect(state.tasks[0].id).toBe('new-1');
    expect(state.tasks[0].status).toBe('created');
  });

  // --------------------------------------------------------------------------
  // 4) 重复 MasterTaskCreated 不重复追加
  // --------------------------------------------------------------------------

  it('同 id 的 MasterTaskCreated 重复触发不会重复追加', () => {
    const event: MasterTaskManagerEvent = {
      type: 'MasterTaskCreated',
      taskId: 'dup-1',
      status: 'pending',
    };

    useMasterTaskStore.getState().handleEvent(event);
    useMasterTaskStore.getState().handleEvent(event);
    useMasterTaskStore.getState().handleEvent(event);

    expect(useMasterTaskStore.getState().tasks).toHaveLength(1);
  });

  // --------------------------------------------------------------------------
  // 5) MasterTaskStatusChanged 事件 → 对应 task status 更新
  // --------------------------------------------------------------------------

  it('收到 MasterTaskStatusChanged 后对应 task.status 被更新', async () => {
    mockInvoke.mockResolvedValueOnce([makeTask('t1', { status: 'pending' })]);
    await useMasterTaskStore.getState().load();

    useMasterTaskStore.getState().handleEvent({
      type: 'MasterTaskStatusChanged',
      taskId: 't1',
      from: 'pending',
      to: 'running',
    });

    const state = useMasterTaskStore.getState();
    expect(state.tasks[0].status).toBe('running');
  });

  it('StatusChanged 针对未知 taskId 时 tasks 不变', async () => {
    mockInvoke.mockResolvedValueOnce([makeTask('t1')]);
    await useMasterTaskStore.getState().load();

    useMasterTaskStore.getState().handleEvent({
      type: 'MasterTaskStatusChanged',
      taskId: 'ghost-id',
      from: 'pending',
      to: 'running',
    });

    expect(useMasterTaskStore.getState().tasks).toHaveLength(1);
    expect(useMasterTaskStore.getState().tasks[0].status).toBe('pending');
  });

  // --------------------------------------------------------------------------
  // 6) MasterTaskFailed 事件 → error 字段更新
  // --------------------------------------------------------------------------

  it('收到 MasterTaskFailed 后对应 task.error 被填充', async () => {
    mockInvoke.mockResolvedValueOnce([makeTask('t1')]);
    await useMasterTaskStore.getState().load();

    useMasterTaskStore.getState().handleEvent({
      type: 'MasterTaskFailed',
      taskId: 't1',
      error: 'sandbox crashed',
    });

    expect(useMasterTaskStore.getState().tasks[0].error).toBe('sandbox crashed');
  });

  // --------------------------------------------------------------------------
  // 7) updateStatus / pause / resume / cancel actions 调用对应 IPC
  // --------------------------------------------------------------------------

  it('updateStatus action 调用 master-task:updateStatus IPC', async () => {
    mockInvoke.mockResolvedValueOnce(undefined);

    await useMasterTaskStore.getState().updateStatus('task-1', 'running');

    expect(mockInvoke).toHaveBeenCalledWith(
      IPC_CHANNELS.MASTER_TASK_UPDATE_STATUS,
      'task-1',
      'running',
    );
  });

  it('pause / resume / cancel actions 各自调用对应 IPC channel', async () => {
    mockInvoke.mockResolvedValue(undefined);
    const store = useMasterTaskStore.getState();

    await store.pause('p-1');
    await store.resume('r-1');
    await store.cancel('c-1');

    expect(mockInvoke).toHaveBeenCalledWith(IPC_CHANNELS.MASTER_TASK_PAUSE, 'p-1');
    expect(mockInvoke).toHaveBeenCalledWith(IPC_CHANNELS.MASTER_TASK_RESUME, 'r-1');
    expect(mockInvoke).toHaveBeenCalledWith(IPC_CHANNELS.MASTER_TASK_CANCEL, 'c-1');
  });

  // --------------------------------------------------------------------------
  // 8) setFilterStatus / setFilterWorkspace 纯本地 state 更新
  // --------------------------------------------------------------------------

  it('setFilterStatus 和 setFilterWorkspace 只改本地 state，不触发 IPC', () => {
    const store = useMasterTaskStore.getState();
    store.setFilterStatus('running');
    store.setFilterWorkspace('/tmp/workspace-b');

    const state = useMasterTaskStore.getState();
    expect(state.filterStatus).toBe('running');
    expect(state.filterWorkspace).toBe('/tmp/workspace-b');
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  // --------------------------------------------------------------------------
  // 9) ignored events: PlanProgressDelta / AgentTaskAttached / AgentTaskCompleted
  // --------------------------------------------------------------------------

  it('PlanProgressDelta / AgentTaskAttached / AgentTaskCompleted 事件不修改 tasks', async () => {
    mockInvoke.mockResolvedValueOnce([makeTask('t1')]);
    await useMasterTaskStore.getState().load();
    const before = useMasterTaskStore.getState().tasks;

    useMasterTaskStore.getState().handleEvent({
      type: 'MasterTaskPlanProgressDelta',
      taskId: 't1',
      chunk: 'hello',
      appendedAt: Date.now(),
    });
    useMasterTaskStore.getState().handleEvent({
      type: 'MasterTaskAgentTaskAttached',
      taskId: 't1',
      agentTaskId: 'a1',
    });
    useMasterTaskStore.getState().handleEvent({
      type: 'MasterTaskAgentTaskCompleted',
      taskId: 't1',
      agentTaskId: 'a1',
      success: true,
    });

    expect(useMasterTaskStore.getState().tasks).toBe(before);
  });
});
