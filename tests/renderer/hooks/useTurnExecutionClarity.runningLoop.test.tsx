// @vitest-environment jsdom
// 真机回归复现：hook_started → turnExecutionStore → useTurnExecutionClarity 不得引发
// React #185（Maximum update depth exceeded）。zustand v5 的 useStore 是裸
// useSyncExternalStore（无 selector 记忆化/等值比较），selector 每次返回新引用就会
// 让 React 认为 snapshot 一直在变 → 无限重渲染。
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TraceProjection } from '../../../src/shared/contract/trace';
import { useTurnExecutionStore } from '../../../src/renderer/stores/turnExecutionStore';

// useWorkbenchCapabilities 依赖运行时能力数据，这里给空实现——本测试只关心
// hookRunning 链路的渲染稳定性。
vi.mock('../../../src/renderer/hooks/useWorkbenchCapabilities', () => ({
  useWorkbenchCapabilities: () => ({ skills: [], connectors: [], mcpServers: [] }),
}));

import { useTurnExecutionClarity } from '../../../src/renderer/hooks/useTurnExecutionClarity';

function baseProjection(): TraceProjection {
  return {
    sessionId: 'session-hook-running',
    activeTurnIndex: -1,
    turns: [
      {
        turnNumber: 1,
        turnId: 'turn-1',
        status: 'streaming',
        startTime: 100,
        nodes: [
          { id: 'user-1', type: 'user', content: '跑一下', timestamp: 100 },
          { id: 'assistant-1-text', type: 'assistant_text', content: 'working', timestamp: 150 },
        ],
      },
    ],
  } as unknown as TraceProjection;
}

describe('hook running 链路不引发无限重渲染（React #185 回归）', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let renderCount: number;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  function Probe() {
    const projection = useTurnExecutionClarity(baseProjection());
    renderCount += 1;
    return React.createElement('div', null, JSON.stringify(
      projection.turns[0]?.nodes.find((n) => n.turnTimeline?.kind === 'hook_activity')?.turnTimeline?.hookActivity?.running ?? null,
    ));
  }

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    useTurnExecutionStore.getState().reset();
    renderCount = 0;
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    consoleErrorSpy.mockRestore();
  });

  it('hook_started/hook_trigger 只引起有限次渲染', () => {
    act(() => {
      root.render(React.createElement(Probe));
    });
    const afterMount = renderCount;

    act(() => {
      useTurnExecutionStore.getState().recordHookStart('session-hook-running', {
        timestamp: 140,
        event: 'PreToolUse',
        names: ['命令门禁'],
      });
    });

    act(() => {
      useTurnExecutionStore.getState().recordHookActivity('session-hook-running', {
        timestamp: 145,
        event: 'PreToolUse',
        action: 'allow',
        durationMs: 4000,
        hookCount: 1,
        modified: false,
        sources: ['project'],
        hookType: 'decision',
      });
    });

    expect(container.textContent).not.toBe('');
    // 每次 store 更新最多引起一两次渲染；#185 时这里会是 50+（React 上限）并伴随 console.error
    expect(renderCount - afterMount).toBeLessThan(10);
    expect(consoleErrorSpy.mock.calls.flat().join(' ')).not.toContain('Maximum update depth');
    expect(consoleErrorSpy.mock.calls.flat().join(' ')).not.toContain('getSnapshot should be cached');
  });

  it('started 后兜底清除（turn_end/终态路径）→ running 指示撤下', () => {
    act(() => {
      root.render(React.createElement(Probe));
    });

    act(() => {
      useTurnExecutionStore.getState().recordHookStart('session-hook-running', {
        timestamp: 140,
        event: 'PreToolUse',
        names: ['命令门禁'],
      });
    });
    expect(container.textContent).toContain('PreToolUse');

    // 模拟 turn_end / agent 终态到达（配对的 hook_trigger 因断流永不到达）
    act(() => {
      useTurnExecutionStore.getState().clearHookRunning('session-hook-running');
    });
    expect(container.textContent).toBe('null');
  });

  it('无关的 hook_trigger 不抖 hookRunningBySession 切片引用（防快照风暴）', () => {
    act(() => {
      root.render(React.createElement(Probe));
    });
    const afterMount = renderCount;

    const trigger = {
      timestamp: 145,
      event: 'PreToolUse',
      action: 'allow' as const,
      durationMs: 4,
      hookCount: 1,
      modified: false,
      sources: ['project'] as Array<'project'>,
      hookType: 'decision' as const,
    };

    // 从未 recordHookStart：trigger 到达时 running 切片必须保持引用不变……
    const sliceBefore = useTurnExecutionStore.getState().hookRunningBySession;
    act(() => {
      useTurnExecutionStore.getState().recordHookActivity('session-hook-running', trigger);
    });
    expect(useTurnExecutionStore.getState().hookRunningBySession).toBe(sliceBefore);

    // ……重复 started（SSE 重放）同理
    act(() => {
      useTurnExecutionStore.getState().recordHookStart('session-hook-running', {
        timestamp: 150, event: 'PreToolUse', names: ['门禁'], turnId: 'assistant-1',
      });
    });
    const sliceAfterStart = useTurnExecutionStore.getState().hookRunningBySession;
    act(() => {
      useTurnExecutionStore.getState().recordHookStart('session-hook-running', {
        timestamp: 150, event: 'PreToolUse', names: ['门禁'], turnId: 'assistant-1',
      });
    });
    expect(useTurnExecutionStore.getState().hookRunningBySession).toBe(sliceAfterStart);

    // 事件风暴（慢 hook 窗口里 trigger/started 与流式更新交织）下渲染次数仍有界
    act(() => {
      for (let i = 0; i < 50; i += 1) {
        useTurnExecutionStore.getState().recordHookStart('session-hook-running', {
          timestamp: 200 + i, event: 'PreToolUse', names: ['门禁'],
        });
        useTurnExecutionStore.getState().recordHookActivity('session-hook-running', {
          ...trigger, timestamp: 200 + i,
        });
      }
    });
    expect(renderCount - afterMount).toBeLessThan(30);
    expect(consoleErrorSpy.mock.calls.flat().join(' ')).not.toContain('Maximum update depth');
  });
});
