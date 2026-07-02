// @vitest-environment jsdom
// useStatusRailModel 主 hook（纯 store 投影；纯函数 derive* 已由
// useStatusRailModel.todos.test.ts 覆盖）。mock 3 个 store 的 selector，
// messages=[] 让 contextBuckets/artifacts 工具确定性产空，覆盖 context/
// compact/swarm 各分支（有无 contextHealth）。cache 死件已删（WP2-2a）。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

const state = vi.hoisted(() => ({
  app: {} as Record<string, unknown>,
  session: { todos: [], messages: [] } as Record<string, unknown>,
  swarm: { isRunning: false, agents: [] as unknown[] } as Record<string, unknown>,
}));

vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: (sel: (s: Record<string, unknown>) => unknown) => sel(state.app),
}));
vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: (sel: (s: Record<string, unknown>) => unknown) => sel(state.session),
}));
vi.mock('../../../src/renderer/stores/swarmStore', () => ({
  useSwarmStore: (sel: (s: Record<string, unknown>) => unknown) => sel(state.swarm),
}));

import { useStatusRailModel } from '../../../src/renderer/hooks/useStatusRailModel';

beforeEach(() => {
  state.app = {};
  state.session = { todos: [], messages: [] };
  state.swarm = { isRunning: false, agents: [] };
});

describe('context 模型', () => {
  it('无 contextHealth → 默认值（maxTokens 取模型上下文窗口，usagePercent 0）', () => {
    state.app = { modelConfig: { model: 'kimi-k2.5' } };
    const { result } = renderHook(() => useStatusRailModel());
    expect(result.current.context.currentTokens).toBe(0);
    expect(result.current.context.usagePercent).toBe(0);
    expect(result.current.context.warningLevel).toBe('normal');
    expect(result.current.context.maxTokens).toBeGreaterThan(0);
  });

  it('有 contextHealth → 透传其字段', () => {
    state.app = {
      contextHealth: { currentTokens: 5000, maxTokens: 100000, usagePercent: 5, warningLevel: 'normal' },
    };
    const { result } = renderHook(() => useStatusRailModel());
    expect(result.current.context).toMatchObject({ currentTokens: 5000, maxTokens: 100000, usagePercent: 5 });
  });
});

describe('compact 模型', () => {
  it('usagePercent>=70 → canCompact，带压缩统计', () => {
    state.app = {
      contextHealth: { usagePercent: 75, compression: { compressionCount: 2, totalSavedTokens: 1200 } },
    };
    const { result } = renderHook(() => useStatusRailModel());
    expect(result.current.compact).toEqual({ canCompact: true, compressionCount: 2, totalSavedTokens: 1200 });
  });

  it('usagePercent<70 → 不可压缩，统计取 0', () => {
    state.app = { contextHealth: { usagePercent: 30 } };
    const { result } = renderHook(() => useStatusRailModel());
    expect(result.current.compact).toEqual({ canCompact: false, compressionCount: 0, totalSavedTokens: 0 });
  });
});

describe('cache 模型（已删除，WP2-2a）', () => {
  it('rail model 不再暴露 cache 键（死件删除：无生产者亦无渲染方）', () => {
    const { result } = renderHook(() => useStatusRailModel());
    expect('cache' in result.current).toBe(false);
  });
});

describe('swarm 模型', () => {
  it('透传运行态 / agent 数 / 选中 agent', () => {
    state.swarm = { isRunning: true, agents: [{ id: 'a' }, { id: 'b' }] };
    state.app = { selectedSwarmAgentId: 'a' };
    const { result } = renderHook(() => useStatusRailModel());
    expect(result.current.swarm).toEqual({ isRunning: true, agentCount: 2, selectedAgentId: 'a' });
  });
});

describe('outputs / todos 接线', () => {
  it('messages 为空 → outputs 计数 0', () => {
    const { result } = renderHook(() => useStatusRailModel());
    expect(result.current.outputs.count).toBe(0);
    expect(result.current.outputs.files).toEqual([]);
  });

  it('todos 委派 deriveStatusRailTodoModel（空 → 不显示）', () => {
    const { result } = renderHook(() => useStatusRailModel());
    expect(result.current.todos).toBeDefined();
  });
});
