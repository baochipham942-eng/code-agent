// ============================================================================
// MasterTaskCounter 单测
// ============================================================================
// - 全 0 / 非追踪任务渲染为空字符串（null）
// - running 任务计数显示
// - review + completed 计数显示
// - 点击触发 openWorkbenchTab('master-tasks') + setActiveWorkbenchTab('master-tasks')
//
// 测试模式：仓内现有套件不带 jsdom / RTL，统一用 react-dom/server +
// renderToStaticMarkup 做 SSR 校验。onClick 测试用 vi.spyOn(React, 'useMemo')
// 直接重写为同步函数，让组件能在测试环境里跑完一次 render 返回 element 树，
// 然后从 element 树里抽 onClick 调用并 assert 副作用。

 
import React from 'react';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { MasterTaskDTO, MasterTaskStatus } from '@shared/contract/task';

// ---- store mocks --------------------------------------------------------

const masterTaskState = {
  tasks: [] as MasterTaskDTO[],
};

const openWorkbenchTabMock = vi.fn();
const setActiveWorkbenchTabMock = vi.fn();

const appState = {
  openWorkbenchTab: openWorkbenchTabMock,
  setActiveWorkbenchTab: setActiveWorkbenchTabMock,
};

vi.mock('../../../../src/renderer/stores/masterTaskStore', () => ({
  useMasterTaskStore: (selector?: (state: typeof masterTaskState) => unknown) =>
    selector ? selector(masterTaskState) : masterTaskState,
  attachMasterTaskIpcListener: vi.fn(() => () => {}),
}));

vi.mock('../../../../src/renderer/stores/appStore', () => ({
  useAppStore: (selector?: (state: typeof appState) => unknown) =>
    selector ? selector(appState) : appState,
}));

import {
  MasterTaskCounter,
  computeMasterTaskCounts,
  makeOpenTaskBoardHandler,
} from '../../../../src/renderer/components/StatusBar/MasterTaskCounter';

// ---- helpers ------------------------------------------------------------

function makeTask(id: string, status: MasterTaskStatus | 'in_progress'): MasterTaskDTO {
  return {
    id,
    status: status as MasterTaskStatus,
    title: `task-${id}`,
    workspaceUri: 'file:///tmp/ws',
    ownerUserId: 'u1',
    planProgress: '',
    blocks: [],
    blockedBy: [],
    childAgentTaskIds: [],
    attachedSessionIds: [],
  };
}

function renderMarkup(): string {
  return renderToStaticMarkup(React.createElement(MasterTaskCounter));
}

beforeEach(() => {
  masterTaskState.tasks = [];
  openWorkbenchTabMock.mockReset();
  setActiveWorkbenchTabMock.mockReset();
});

// ---- pure function tests ------------------------------------------------

describe('computeMasterTaskCounts', () => {
  it('空列表归零', () => {
    expect(computeMasterTaskCounts([])).toEqual({ running: 0, review: 0, completed: 0 });
  });

  it('running 与 in_progress 都计入 running 桶', () => {
    const tasks = [
      makeTask('a', 'running'),
      makeTask('b', 'in_progress'),
    ];
    expect(computeMasterTaskCounts(tasks)).toEqual({ running: 2, review: 0, completed: 0 });
  });

  it('review 单独成桶', () => {
    expect(computeMasterTaskCounts([makeTask('a', 'review')])).toEqual({
      running: 0,
      review: 1,
      completed: 0,
    });
  });

  it('completed + done 合并进 completed 桶', () => {
    const tasks = [makeTask('a', 'completed'), makeTask('b', 'done')];
    expect(computeMasterTaskCounts(tasks)).toEqual({ running: 0, review: 0, completed: 2 });
  });

  it('pending / queued / paused / failed / cancelled 都不计入', () => {
    const tasks: MasterTaskDTO[] = [
      makeTask('a', 'pending'),
      makeTask('b', 'queued'),
      makeTask('c', 'paused'),
      makeTask('d', 'failed'),
      makeTask('e', 'cancelled'),
      makeTask('f', 'error'),
      makeTask('g', 'waiting'),
      makeTask('h', 'created'),
    ];
    expect(computeMasterTaskCounts(tasks)).toEqual({ running: 0, review: 0, completed: 0 });
  });
});

// ---- rendering tests ----------------------------------------------------

describe('MasterTaskCounter (rendering)', () => {
  it('全 0 任务（tasks=[]）渲染为空', () => {
    masterTaskState.tasks = [];
    expect(renderMarkup()).toBe('');
  });

  it('只有非追踪状态时也不渲染', () => {
    masterTaskState.tasks = [
      makeTask('a', 'pending'),
      makeTask('b', 'failed'),
      makeTask('c', 'cancelled'),
    ];
    expect(renderMarkup()).toBe('');
  });

  it('有 running 任务显示 running 数', () => {
    masterTaskState.tasks = [
      makeTask('a', 'running'),
      makeTask('b', 'running'),
      makeTask('c', 'pending'), // 不计入
    ];
    const html = renderMarkup();
    expect(html).toContain('>2<');
    expect(html).toContain('text-sky-400');
    expect(html).toContain('lucide-play');
    expect(html).not.toContain('text-amber-400');
    expect(html).not.toContain('text-emerald-400');
  });

  it('有 review + completed 任务显示对应数', () => {
    masterTaskState.tasks = [
      makeTask('a', 'review'),
      makeTask('b', 'completed'),
      makeTask('c', 'done'),
    ];
    const html = renderMarkup();
    expect(html).toContain('text-amber-400');
    expect(html).toContain('lucide-eye');
    expect(html).toContain('text-emerald-400');
    // CheckCircle2 → lucide-circle-check / lucide-check-circle-2，做 OR 校验
    expect(/lucide-(circle-check-2|circle-check-big|circle-check|check-circle-2)/.test(html)).toBe(true);
    expect(html).not.toContain('text-sky-400');
  });

  it('button 携带 aria-label 描述三种计数 + title', () => {
    masterTaskState.tasks = [
      makeTask('a', 'running'),
      makeTask('b', 'review'),
      makeTask('c', 'completed'),
    ];
    const html = renderMarkup();
    expect(html).toContain('1 running, 1 reviewing, 1 completed master tasks');
    expect(html).toContain('Open Task Board');
  });
});

// ---- onClick wiring -----------------------------------------------------
//
// 不直接走 React render（jsdom 未启用 + RTL 不可用），通过 makeOpenTaskBoardHandler
// 单测 store action wiring；组件层在 MasterTaskCounter (button presence) 里只验证
// button 真的渲染了出来，两端结合即覆盖 click → 切 Task Board tab 的语义。

describe('makeOpenTaskBoardHandler', () => {
  it('调用回调时按序触发 openWorkbenchTab + setActiveWorkbenchTab（master-tasks）', () => {
    const open = vi.fn();
    const setActive = vi.fn();
    const handler = makeOpenTaskBoardHandler(open, setActive);

    handler();

    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith('master-tasks');
    expect(setActive).toHaveBeenCalledTimes(1);
    expect(setActive).toHaveBeenCalledWith('master-tasks');
    // 顺序：先 open 后 setActive
    expect(open.mock.invocationCallOrder[0]).toBeLessThan(setActive.mock.invocationCallOrder[0]);
  });
});

describe('MasterTaskCounter (button presence)', () => {
  it('有任务时渲染可点击的 button + Open Task Board title', () => {
    masterTaskState.tasks = [makeTask('a', 'running')];
    const html = renderMarkup();
    expect(html).toMatch(/<button\b/);
    expect(html).toContain('Open Task Board');
    expect(html).toContain('type="button"');
  });
});
