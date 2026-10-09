// @vitest-environment jsdom
// useCronRunGroups（侧栏分组运行数据）：store 的 getCronRunGroups 选择器用真实现
// groupRunsByTask 驱动（mock 只换 store，不重复实现分组），覆盖 3 轮同任务 + 1 条
// 手动会话的折叠形状与 memo 稳定性；cronRunAggregatesByTaskId 验证 origin.id 聚合映射。
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Fixture = { id: string; updatedAt: number; origin?: { kind: string; id?: string } };

const state = vi.hoisted(() => ({
  sessions: [] as Fixture[],
}));

vi.mock('../../../src/renderer/stores/sessionStore', async () => {
  const { groupRunsByTask } = await import('../../../src/shared/cronRunDigest');
  // 真实 store 的方法是稳定引用、sessions 数组只在更新时换引用——mock 按同样的稳定性
  // 提供（每次 sel 都新建闭包会把 useMemo 的依赖打穿，memo 断言就测不出真行为）。
  let cached: { sessions: typeof state.sessions; getCronRunGroups: () => ReturnType<typeof groupRunsByTask<typeof state.sessions[number]>> } | null = null;
  return {
    useSessionStore: (sel: (s: Record<string, unknown>) => unknown) => {
      if (!cached || cached.sessions !== state.sessions) {
        cached = {
          sessions: state.sessions,
          getCronRunGroups: () => groupRunsByTask(state.sessions),
        };
      }
      return sel(cached);
    },
  };
});

import { cronRunAggregatesByTaskId, useCronRunGroups } from '../../../src/renderer/hooks/useCronRunGroups';

beforeEach(() => {
  state.sessions = [];
});

describe('useCronRunGroups + cronRunAggregatesByTaskId', () => {
  it('同一任务的 3 轮运行折成 1 组（runCount 3、最新会话在前），手动会话留在 ungrouped', () => {
    state.sessions = [
      { id: 'run-old', updatedAt: 10, origin: { kind: 'cron', id: 'job-a' } },
      { id: 'manual-1', updatedAt: 20, origin: { kind: 'manual' } },
      { id: 'run-new', updatedAt: 30, origin: { kind: 'heartbeat', id: 'job-a' } },
      { id: 'run-mid', updatedAt: 25, origin: { kind: 'cron', id: 'job-a' } },
    ];

    const { result } = renderHook(() => useCronRunGroups());
    const groups = result.current;

    expect(Object.keys(groups.groups)).toEqual(['job-a']);
    expect(groups.groups['job-a']).toMatchObject({ runCount: 3, latestSessionId: 'run-new' });
    expect(groups.ungrouped).toEqual([{ id: 'manual-1', updatedAt: 20, origin: { kind: 'manual' } }]);

    expect(cronRunAggregatesByTaskId(groups)).toEqual({
      'job-a': { runCount: 3, latestSessionId: 'run-new' },
    });
  });

  it('sessions 引用不变时 memo 住同一分组结果；无 cron 会话时聚合映射为空', () => {
    state.sessions = [
      { id: 'run-1', updatedAt: 1, origin: { kind: 'cron', id: 'job-a' } },
      { id: 'plain', updatedAt: 2 },
    ];

    const first = renderHook(() => useCronRunGroups());
    const beforeRerender = first.result.current;
    first.rerender();
    expect(first.result.current).toBe(beforeRerender);

    state.sessions = [{ id: 'only-manual', updatedAt: 3, origin: { kind: 'manual' } }];
    const second = renderHook(() => useCronRunGroups());
    expect(second.result.current.groups).toEqual({});
    expect(cronRunAggregatesByTaskId(second.result.current)).toEqual({});
  });
});
