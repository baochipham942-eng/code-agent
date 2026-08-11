// ============================================================================
// orchestratorGoalSeed — /goal 播种编排（F-4c 抽出前无覆盖，补测钉住行为）
// ----------------------------------------------------------------------------
// 三个协作者全 mock，只验编排顺序与两个事件的精确形状——这正是从 run 主线原样
// 搬出来的行为契约，搬迁若走样这里必红。
// ============================================================================

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../../../src/shared/contract';
import type { GoalContract } from '../../../src/host/agent/goalModeController';

const buildGoalSeedTodos = vi.fn();
const setSessionTodos = vi.fn();
const syncTodosToSessionTasks = vi.fn();

vi.mock('../../../src/shared/utils/goalTodos', () => ({
  buildGoalSeedTodos: (...args: unknown[]) => buildGoalSeedTodos(...args),
}));
vi.mock('../../../src/host/agent/todoParser', () => ({
  setSessionTodos: (...args: unknown[]) => setSessionTodos(...args),
  syncTodosToSessionTasks: (...args: unknown[]) => syncTodosToSessionTasks(...args),
}));

import { seedGoalContractForRun } from '../../../src/host/agent/orchestratorGoalSeed';

const goalContract = { goal: '把首页做出来', tokenBudget: 1000, maxTurns: 20 } as GoalContract;
const seededTodos = [{ content: '任务目标：把首页做出来', status: 'completed', activeForm: '目标：把首页做出来' }];

describe('seedGoalContractForRun', () => {
  afterEach(() => vi.clearAllMocks());

  it('按 目标→todos→session todos→tasks 顺序播种，并发两个事件', () => {
    buildGoalSeedTodos.mockReturnValue(seededTodos);
    syncTodosToSessionTasks.mockReturnValue({
      tasks: [{ id: 't1' }, { id: 't2' }],
      created: [{ id: 't1' }],
      updated: [{ id: 't2' }],
    });
    const events: AgentEvent[] = [];

    seedGoalContractForRun({
      goalContract,
      sessionId: 'sess-1',
      emitEvent: (e) => events.push(e),
    });

    // 种子由 goalContract.goal 生成，落进 session todos 与 tasks（都用同一份 todos）
    expect(buildGoalSeedTodos).toHaveBeenCalledWith('把首页做出来');
    expect(setSessionTodos).toHaveBeenCalledWith('sess-1', seededTodos);
    expect(syncTodosToSessionTasks).toHaveBeenCalledWith('sess-1', seededTodos);

    // 事件一：todo_update 原样带种子 todos
    expect(events[0]).toEqual({ type: 'todo_update', data: seededTodos });
    // 事件二：task_update，taskIds = created + updated 拼接，source 固定 goal_mode
    expect(events[1]).toEqual({
      type: 'task_update',
      data: {
        tasks: [{ id: 't1' }, { id: 't2' }],
        action: 'sync',
        taskIds: ['t1', 't2'],
        source: 'goal_mode',
      },
    });
  });

  it('created/updated 为空时 taskIds 为空数组（不塞脏 id）', () => {
    buildGoalSeedTodos.mockReturnValue(seededTodos);
    syncTodosToSessionTasks.mockReturnValue({ tasks: [], created: [], updated: [] });
    const events: AgentEvent[] = [];

    seedGoalContractForRun({ goalContract, sessionId: 'sess-2', emitEvent: (e) => events.push(e) });

    expect((events[1] as { data: { taskIds: string[] } }).data.taskIds).toEqual([]);
  });
});
