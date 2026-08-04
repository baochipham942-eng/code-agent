// @vitest-environment jsdom
//
// 概览四模块 · 模块一「任务」：细进度线三态 + 步骤计数（spec §1 模块一）。
// 状态点替代色块 badge：进行中蓝点呼吸 / 等你确认黄点 / 已完成绿点 / 异常红点；
// 步骤计数只在有 TODO 时出现，完成态定格「已完成 · 共 N 步」，异常态出人话结局。

import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildOverviewRunHeaderModel,
  deriveRunOverviewTone,
} from '../../../src/renderer/utils/overviewRunHeader';
import type { RunUiState, RunUiStatus } from '../../../src/renderer/types/runWorkbench';

const runModel = vi.hoisted(() => ({ current: null as unknown }));

vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  return { useI18n: () => ({ language: 'zh', t: zh }) };
});
vi.mock('../../../src/renderer/hooks/useRunWorkbenchModel', () => ({
  useRunWorkbenchModel: () => runModel.current,
}));

import { OverviewRunHeader } from '../../../src/renderer/components/TaskPanel/OverviewRunHeader';
import { useRunControlStore } from '../../../src/renderer/stores/runControlStore';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';

const START = 1_700_000_000_000;

function run(overrides: Partial<RunUiState> & { status: RunUiStatus }): RunUiState {
  return {
    identity: {
      sessionId: 'session-a',
      turnId: 'turn-1',
      runId: 'run-1',
      streamRunId: null,
      status: overrides.status,
    },
    phase: '调用工具',
    ...overrides,
  } as RunUiState;
}

function setRun(state: RunUiState, tasks: unknown[] = []): void {
  runModel.current = {
    run: state,
    loopDecisions: [],
    tools: [],
    tasks,
    subagents: [],
    memoryActivities: [],
    outputs: [],
  };
}

function sessionTask(steps: Array<{ title: string; status: string }>) {
  return [{
    id: 'session:todos',
    scope: 'session',
    title: '写周报',
    status: 'in_progress',
    steps,
    ownerRunId: null,
    sourceThreadId: 'session-a',
  }];
}

afterEach(() => cleanup());

describe('deriveRunOverviewTone', () => {
  it('进行中系 → live；waiting_approval 单列 waiting；completed → done；blocked/cancelled → error', () => {
    expect(deriveRunOverviewTone('planning')).toBe('live');
    expect(deriveRunOverviewTone('running')).toBe('live');
    expect(deriveRunOverviewTone('using_tools')).toBe('live');
    expect(deriveRunOverviewTone('verifying')).toBe('live');
    expect(deriveRunOverviewTone('waiting_approval')).toBe('waiting');
    expect(deriveRunOverviewTone('completed')).toBe('done');
    expect(deriveRunOverviewTone('blocked')).toBe('error');
    expect(deriveRunOverviewTone('cancelled')).toBe('error');
  });
});

describe('buildOverviewRunHeaderModel 步骤计数与结局', () => {
  it('uses the current run instruction instead of the session first-message title', () => {
    const model = buildOverviewRunHeaderModel({
      run: run({ status: 'completed', title: '第二轮任务' }),
      sessionTitle: '第一轮会话标题',
      now: START,
    });

    expect(model?.title).toBe('第二轮任务');
  });

  it('进行中且有 TODO：steps = 当前步/总步（当前步 = 已完成 + 1）', () => {
    const model = buildOverviewRunHeaderModel({
      run: run({ status: 'using_tools', startedAt: START }),
      sessionTitle: '写周报',
      now: START + 1_000,
      todoProgress: { completed: 1, total: 5 },
    });

    expect(model).toMatchObject({ tone: 'live', steps: { current: 2, total: 5 } });
  });

  it('无 TODO 时不出现步骤段', () => {
    const model = buildOverviewRunHeaderModel({
      run: run({ status: 'running', startedAt: START }),
      sessionTitle: '写周报',
      now: START,
      todoProgress: { completed: 0, total: 0 },
    });

    expect(model?.steps).toBeNull();
  });

  it('完成态：steps 定格总步数，当前动作句消失', () => {
    const model = buildOverviewRunHeaderModel({
      run: run({ status: 'completed', phase: '已完成', startedAt: START, endedAt: START + 5_000 }),
      sessionTitle: '写周报',
      now: START + 9_000,
      todoProgress: { completed: 5, total: 5 },
    });

    expect(model).toMatchObject({ tone: 'done', steps: { current: 5, total: 5 }, phase: null });
  });

  it('异常态：outcome 人话结局，不暴露内部状态名', () => {
    const cancelled = buildOverviewRunHeaderModel({
      run: run({ status: 'cancelled', startedAt: START, endedAt: START + 2_000 }),
      sessionTitle: '写周报',
      now: START + 3_000,
    });
    const blocked = buildOverviewRunHeaderModel({
      run: run({ status: 'blocked', startedAt: START, endedAt: START + 2_000 }),
      sessionTitle: '写周报',
      now: START + 3_000,
    });

    expect(cancelled).toMatchObject({ tone: 'error', outcome: 'cancelled', phase: null });
    expect(blocked).toMatchObject({ tone: 'error', outcome: 'error', phase: null });
  });
});

describe('OverviewRunHeader 细进度线', () => {
  beforeEach(() => {
    useRunControlStore.setState({ queue: [], actions: null });
    useSessionStore.setState({ currentSessionId: 'session-a', sessions: [
      { id: 'session-a', title: '写周报' },
    ] as never });
  });

  it('不再是带边框的卡片容器', () => {
    setRun(run({ status: 'running', startedAt: START }));
    render(<OverviewRunHeader />);

    const header = screen.getByTestId('overview-run-header');
    expect(header.className).not.toContain('border');
  });

  it('状态点替代状态 badge：live 蓝点，waiting_approval 黄点，done 绿点，error 红点', () => {
    const cases: Array<[RunUiStatus, string]> = [
      ['running', 'live'],
      ['waiting_approval', 'waiting'],
      ['completed', 'done'],
      ['blocked', 'error'],
    ];
    for (const [status, tone] of cases) {
      cleanup();
      setRun(run({ status, startedAt: START, endedAt: START + 1_000 }));
      render(<OverviewRunHeader />);
      expect(screen.getByTestId('overview-run-header-dot').getAttribute('data-tone')).toBe(tone);
      // 旧色块 badge 不再出现
      expect(screen.queryByTestId('overview-run-header-status')).toBeNull();
    }
  });

  it('进行中显示「第 N 步 / 共 M 步」，无 TODO 不显示步骤段', () => {
    setRun(
      run({ status: 'using_tools', startedAt: START }),
      sessionTask([
        { title: '收集资料', status: 'completed' },
        { title: '整理成文', status: 'in_progress' },
        { title: '校对导出', status: 'pending' },
      ]),
    );
    render(<OverviewRunHeader />);
    expect(screen.getByTestId('overview-run-header-steps').textContent).toBe('第 2 步 / 共 3 步');

    cleanup();
    setRun(run({ status: 'using_tools', startedAt: START }));
    render(<OverviewRunHeader />);
    expect(screen.queryByTestId('overview-run-header-steps')).toBeNull();
  });

  it('waiting_approval 当前动作句显示「等你确认」', () => {
    setRun(run({ status: 'waiting_approval', startedAt: START }));
    render(<OverviewRunHeader />);
    expect(screen.getByTestId('overview-run-header-phase').textContent).toBe('等你确认');
  });

  it('完成态不显示当前动作句', () => {
    setRun(run({ status: 'completed', phase: '已完成', startedAt: START, endedAt: START + 5_000 }));
    render(<OverviewRunHeader />);
    expect(screen.queryByTestId('overview-run-header-phase')).toBeNull();
  });

  it('异常态显示人话结局，不出现 error/blocked 字样', () => {
    setRun(run({ status: 'cancelled', startedAt: START, endedAt: START + 2_000 }));
    render(<OverviewRunHeader />);
    const phase = screen.getByTestId('overview-run-header-phase');
    expect(phase.textContent).toBe('已中断');
    expect(screen.getByTestId('overview-run-header').textContent).not.toMatch(/cancelled|blocked|error/i);
  });
});
