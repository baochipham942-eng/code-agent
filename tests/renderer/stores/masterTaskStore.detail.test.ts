// ============================================================================
// MasterTask Store - 详情视图相关单元测试（P2-c2）
// ============================================================================
//
// 覆盖：
//   - 初始 detail state（selectedTaskId / planProgressBuffer / detailLoading /
//     detailError 默认值）
//   - selectTask 切换
//   - loadTaskDetail 成功（upsert）/ 失败（detailError，tasks 不变）
//   - handleEvent PlanProgressDelta 累加（首次 / append / 多 task 互不干扰）
//   - clearPlanProgressBuffer 只清指定 task
//   - reset() 清掉 4 个新字段
// ============================================================================

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type {
  MasterTaskDTO,
  MasterTaskManagerEvent,
} from '../../../src/shared/contract/task';

// Mock ipcService —— 与 masterTaskStore.test.ts 风格一致
const mockInvoke = vi.fn();
const mockOn = vi.fn();
const mockOff = vi.fn();

vi.mock('../../../src/renderer/services/ipcService', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
  on: (...args: unknown[]) => mockOn(...args),
  off: (...args: unknown[]) => mockOff(...args),
}));

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

describe('masterTaskStore - detail view (P2-c2)', () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    mockOn.mockReset();
    mockOff.mockReset();
    useMasterTaskStore.getState().reset();
  });

  // --------------------------------------------------------------------------
  // 1) 初始 state
  // --------------------------------------------------------------------------

  it('初始 detail state: selectedTaskId=null / buffer 空 / detailLoading=false / detailError=null', () => {
    const state = useMasterTaskStore.getState();
    expect(state.selectedTaskId).toBeNull();
    expect(state.planProgressBuffer).toBeInstanceOf(Map);
    expect(state.planProgressBuffer.size).toBe(0);
    expect(state.detailLoading).toBe(false);
    expect(state.detailError).toBeNull();
  });

  // --------------------------------------------------------------------------
  // 2) selectTask 切换
  // --------------------------------------------------------------------------

  it('selectTask 在 null / id / null 之间切换', () => {
    const store = useMasterTaskStore.getState();
    expect(useMasterTaskStore.getState().selectedTaskId).toBeNull();

    store.selectTask('task-1');
    expect(useMasterTaskStore.getState().selectedTaskId).toBe('task-1');

    store.selectTask(null);
    expect(useMasterTaskStore.getState().selectedTaskId).toBeNull();
  });

  // --------------------------------------------------------------------------
  // 3) loadTaskDetail 成功：upsert（替换同 id / 追加新 id）
  // --------------------------------------------------------------------------

  it('loadTaskDetail 成功时把 fresh DTO 替换 tasks 中同 id 的旧 entry', async () => {
    // 先 seed 一个旧的 t1（planProgress 为空）
    mockInvoke.mockResolvedValueOnce([makeTask('t1', { planProgress: '' })]);
    await useMasterTaskStore.getState().load();
    expect(useMasterTaskStore.getState().tasks).toHaveLength(1);
    expect(useMasterTaskStore.getState().tasks[0].planProgress).toBe('');

    // 拿到 fresh 版本（planProgress 已有内容）
    const fresh = makeTask('t1', {
      planProgress: '# Plan\nstep 1',
      attachedSessionIds: ['sess-1'],
      childAgentTaskIds: ['agt-1'],
    });
    mockInvoke.mockResolvedValueOnce(fresh);

    const result = await useMasterTaskStore.getState().loadTaskDetail('t1');

    expect(mockInvoke).toHaveBeenLastCalledWith(IPC_CHANNELS.MASTER_TASK_GET_BY_ID, 't1');
    expect(result).toEqual(fresh);

    const state = useMasterTaskStore.getState();
    expect(state.tasks).toHaveLength(1);
    expect(state.tasks[0].planProgress).toBe('# Plan\nstep 1');
    expect(state.tasks[0].attachedSessionIds).toEqual(['sess-1']);
    expect(state.tasks[0].childAgentTaskIds).toEqual(['agt-1']);
    expect(state.detailLoading).toBe(false);
    expect(state.detailError).toBeNull();
  });

  it('loadTaskDetail 拿到 list 中不存在的 id 时 append', async () => {
    mockInvoke.mockResolvedValueOnce([makeTask('t1')]);
    await useMasterTaskStore.getState().load();

    const fresh = makeTask('t2', { title: 'New from detail' });
    mockInvoke.mockResolvedValueOnce(fresh);

    await useMasterTaskStore.getState().loadTaskDetail('t2');

    const state = useMasterTaskStore.getState();
    expect(state.tasks).toHaveLength(2);
    expect(state.tasks.map((t) => t.id).sort()).toEqual(['t1', 't2']);
  });

  // --------------------------------------------------------------------------
  // 4) loadTaskDetail 失败：detailError 被设，tasks 不变
  // --------------------------------------------------------------------------

  it('loadTaskDetail IPC reject 时 detailError 被设、tasks 不变', async () => {
    mockInvoke.mockResolvedValueOnce([makeTask('t1', { planProgress: 'original' })]);
    await useMasterTaskStore.getState().load();
    const before = useMasterTaskStore.getState().tasks;

    mockInvoke.mockRejectedValueOnce(new Error('IPC boom'));
    const result = await useMasterTaskStore.getState().loadTaskDetail('t1');

    expect(result).toBeNull();
    const state = useMasterTaskStore.getState();
    expect(state.detailLoading).toBe(false);
    expect(state.detailError).toBe('IPC boom');
    expect(state.tasks).toBe(before); // 引用相等：未触发 upsert
  });

  it('loadTaskDetail 拿到 undefined / null 时不改 tasks，detailLoading 清空', async () => {
    mockInvoke.mockResolvedValueOnce([makeTask('t1')]);
    await useMasterTaskStore.getState().load();
    const before = useMasterTaskStore.getState().tasks;

    mockInvoke.mockResolvedValueOnce(null);
    const result = await useMasterTaskStore.getState().loadTaskDetail('ghost-id');

    expect(result).toBeNull();
    const state = useMasterTaskStore.getState();
    expect(state.tasks).toBe(before);
    expect(state.detailLoading).toBe(false);
    expect(state.detailError).toBeNull();
  });

  // --------------------------------------------------------------------------
  // 5) handleEvent PlanProgressDelta 累加
  // --------------------------------------------------------------------------

  it('PlanProgressDelta 首次写入 buffer', () => {
    const event: MasterTaskManagerEvent = {
      type: 'MasterTaskPlanProgressDelta',
      taskId: 't1',
      chunk: 'hello ',
      appendedAt: Date.now(),
    };
    useMasterTaskStore.getState().handleEvent(event);

    const state = useMasterTaskStore.getState();
    expect(state.planProgressBuffer.get('t1')).toBe('hello ');
  });

  it('PlanProgressDelta 同 id 多次触发会 append chunk', () => {
    const ts = Date.now();
    useMasterTaskStore.getState().handleEvent({
      type: 'MasterTaskPlanProgressDelta',
      taskId: 't1',
      chunk: 'hello ',
      appendedAt: ts,
    });
    useMasterTaskStore.getState().handleEvent({
      type: 'MasterTaskPlanProgressDelta',
      taskId: 't1',
      chunk: 'world',
      appendedAt: ts + 1,
    });
    useMasterTaskStore.getState().handleEvent({
      type: 'MasterTaskPlanProgressDelta',
      taskId: 't1',
      chunk: '!',
      appendedAt: ts + 2,
    });

    expect(useMasterTaskStore.getState().planProgressBuffer.get('t1')).toBe('hello world!');
  });

  it('PlanProgressDelta 多 task 互不干扰', () => {
    const ts = Date.now();
    useMasterTaskStore.getState().handleEvent({
      type: 'MasterTaskPlanProgressDelta',
      taskId: 't1',
      chunk: 'AAA',
      appendedAt: ts,
    });
    useMasterTaskStore.getState().handleEvent({
      type: 'MasterTaskPlanProgressDelta',
      taskId: 't2',
      chunk: 'BBB',
      appendedAt: ts + 1,
    });
    useMasterTaskStore.getState().handleEvent({
      type: 'MasterTaskPlanProgressDelta',
      taskId: 't1',
      chunk: 'CCC',
      appendedAt: ts + 2,
    });

    const buffer = useMasterTaskStore.getState().planProgressBuffer;
    expect(buffer.get('t1')).toBe('AAACCC');
    expect(buffer.get('t2')).toBe('BBB');
    expect(buffer.size).toBe(2);
  });

  it('PlanProgressDelta 触发后返回新 Map 实例（zustand 重渲染）', () => {
    const before = useMasterTaskStore.getState().planProgressBuffer;
    useMasterTaskStore.getState().handleEvent({
      type: 'MasterTaskPlanProgressDelta',
      taskId: 't1',
      chunk: 'x',
      appendedAt: Date.now(),
    });
    const after = useMasterTaskStore.getState().planProgressBuffer;
    expect(after).not.toBe(before);
  });

  // --------------------------------------------------------------------------
  // 6) clearPlanProgressBuffer 只清指定 task
  // --------------------------------------------------------------------------

  it('clearPlanProgressBuffer 只清指定 task 的 buffer', () => {
    const ts = Date.now();
    useMasterTaskStore.getState().handleEvent({
      type: 'MasterTaskPlanProgressDelta',
      taskId: 't1',
      chunk: 'AAA',
      appendedAt: ts,
    });
    useMasterTaskStore.getState().handleEvent({
      type: 'MasterTaskPlanProgressDelta',
      taskId: 't2',
      chunk: 'BBB',
      appendedAt: ts + 1,
    });

    useMasterTaskStore.getState().clearPlanProgressBuffer('t1');

    const buffer = useMasterTaskStore.getState().planProgressBuffer;
    expect(buffer.has('t1')).toBe(false);
    expect(buffer.get('t2')).toBe('BBB');
  });

  it('clearPlanProgressBuffer 对未知 taskId no-op，buffer 引用保持', () => {
    const before = useMasterTaskStore.getState().planProgressBuffer;
    useMasterTaskStore.getState().clearPlanProgressBuffer('ghost');
    const after = useMasterTaskStore.getState().planProgressBuffer;
    expect(after).toBe(before);
  });

  // --------------------------------------------------------------------------
  // 7) reset 清零 detail state
  // --------------------------------------------------------------------------

  it('reset 把 4 个 detail 字段全部清零', () => {
    // 先污染 detail state
    useMasterTaskStore.getState().selectTask('task-x');
    useMasterTaskStore.getState().handleEvent({
      type: 'MasterTaskPlanProgressDelta',
      taskId: 'task-x',
      chunk: 'data',
      appendedAt: Date.now(),
    });
    expect(useMasterTaskStore.getState().selectedTaskId).toBe('task-x');
    expect(useMasterTaskStore.getState().planProgressBuffer.size).toBe(1);

    useMasterTaskStore.getState().reset();

    const state = useMasterTaskStore.getState();
    expect(state.selectedTaskId).toBeNull();
    expect(state.planProgressBuffer.size).toBe(0);
    expect(state.detailLoading).toBe(false);
    expect(state.detailError).toBeNull();
  });

  // --------------------------------------------------------------------------
  // 8) selectTask 切换不清 planProgressBuffer（保留每 task 的流式累积）
  // --------------------------------------------------------------------------

  it('selectTask 切换不清空 planProgressBuffer', () => {
    useMasterTaskStore.getState().handleEvent({
      type: 'MasterTaskPlanProgressDelta',
      taskId: 't1',
      chunk: 'streamed',
      appendedAt: Date.now(),
    });

    useMasterTaskStore.getState().selectTask('t1');
    useMasterTaskStore.getState().selectTask('t2');
    useMasterTaskStore.getState().selectTask('t1');

    expect(useMasterTaskStore.getState().planProgressBuffer.get('t1')).toBe('streamed');
  });
});
