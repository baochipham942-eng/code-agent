// @vitest-environment jsdom
//
// T1 Overview 主路径：Run header 三态 / 队列投影 / 诊断下沉不丢内容。

import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildOverviewRunHeaderModel,
  formatElapsedClock,
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
vi.mock('../../../src/renderer/hooks/useStatusRailModel', () => ({
  useStatusRailModel: () => ({ context: { items: [] }, outputs: { count: 0, files: [] } }),
}));
vi.mock('../../../src/renderer/hooks/useCurrentTurnArtifactOwnership', () => ({
  useCurrentTurnArtifactOwnership: () => null,
}));
vi.mock('../../../src/renderer/hooks/useWorkspacePreviewModel', () => ({
  useWorkspacePreviewModel: () => [],
}));

import { OverviewRunHeader } from '../../../src/renderer/components/TaskPanel/OverviewRunHeader';
import { OverviewSteeringQueue } from '../../../src/renderer/components/TaskPanel/OverviewSteeringQueue';
import { TaskWorkspaceOverview } from '../../../src/renderer/components/TaskPanel/TaskWorkspaceOverview';
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

function setRun(state: RunUiState): void {
  runModel.current = {
    run: state,
    loopDecisions: [],
    tools: [],
    tasks: [],
    subagents: [],
    memoryActivities: [],
    outputs: [],
  };
}

afterEach(() => cleanup());

describe('buildOverviewRunHeaderModel 三态', () => {
  it('无 run（会话里还没有任何 turn）时不摆表头', () => {
    const idle = run({ status: 'completed' });
    idle.identity.turnId = null;

    expect(buildOverviewRunHeaderModel({ run: idle, sessionTitle: '写周报', now: START }))
      .toBeNull();
  });

  it('运行中：live，用时按当前时间走', () => {
    const model = buildOverviewRunHeaderModel({
      run: run({ status: 'using_tools', startedAt: START }),
      sessionTitle: '写周报',
      now: START + 7_000,
    });

    expect(model).toMatchObject({ title: '写周报', phase: '调用工具', live: true, elapsedMs: 7_000 });
  });

  it('完成：不 live，用时冻结在 endedAt 而不是继续走', () => {
    const model = buildOverviewRunHeaderModel({
      run: run({ status: 'completed', phase: '已完成', startedAt: START, endedAt: START + 12_000 }),
      sessionTitle: '写周报',
      now: START + 999_000,
    });

    expect(model).toMatchObject({ live: false, elapsedMs: 12_000 });
  });

  it('起点未知时不假造 0 用时', () => {
    expect(buildOverviewRunHeaderModel({
      run: run({ status: 'running' }),
      sessionTitle: null,
      now: START,
    })).toMatchObject({ title: '调用工具', phase: null, elapsedMs: null });
  });

  it('formatElapsedClock 跨分/跨时', () => {
    expect(formatElapsedClock(7_000)).toBe('0:07');
    expect(formatElapsedClock(83_000)).toBe('1:23');
    expect(formatElapsedClock(3_723_000)).toBe('1:02:03');
  });
});

describe('OverviewRunHeader', () => {
  beforeEach(() => {
    useRunControlStore.setState({ queue: [], actions: null });
    useSessionStore.setState({ currentSessionId: 'session-a', sessions: [
      { id: 'session-a', title: '写周报' },
    ] as never });
  });

  it('无 run 时整块不渲染', () => {
    const idle = run({ status: 'completed' });
    idle.identity.turnId = null;
    setRun(idle);

    render(<OverviewRunHeader />);
    expect(screen.queryByTestId('overview-run-header')).toBeNull();
  });

  it('运行中给中断按钮，点击调既有 interrupt 动作', () => {
    setRun(run({ status: 'running', startedAt: START }));
    const interrupt = vi.fn();
    useRunControlStore.setState({
      actions: { interrupt, retractQueued: vi.fn(), sendQueuedNow: vi.fn() },
    });

    render(<OverviewRunHeader />);
    expect(screen.getByTestId('overview-run-header-title').textContent).toBe('写周报');
    fireEvent.click(screen.getByTestId('overview-run-header-interrupt'));
    expect(interrupt).toHaveBeenCalledTimes(1);
  });

  it('完成态不给中断按钮，但状态与用时仍在', () => {
    setRun(run({ status: 'completed', phase: '已完成', startedAt: START, endedAt: START + 5_000 }));
    useRunControlStore.setState({
      actions: { interrupt: vi.fn(), retractQueued: vi.fn(), sendQueuedNow: vi.fn() },
    });

    render(<OverviewRunHeader />);
    expect(screen.getByTestId('overview-run-header')).toBeTruthy();
    expect(screen.queryByTestId('overview-run-header-interrupt')).toBeNull();
    expect(screen.getByTestId('overview-run-header-elapsed').textContent).toBe('0:05');
  });

  it('聊天运行时未挂载（actions 为 null）时不摆点了没反应的中断按钮', () => {
    setRun(run({ status: 'running', startedAt: START }));

    render(<OverviewRunHeader />);
    expect(screen.getByTestId('overview-run-header')).toBeTruthy();
    expect(screen.queryByTestId('overview-run-header-interrupt')).toBeNull();
  });
});

describe('OverviewSteeringQueue', () => {
  const actions = { interrupt: vi.fn(), retractQueued: vi.fn(), sendQueuedNow: vi.fn() };

  beforeEach(() => {
    actions.interrupt.mockReset();
    actions.retractQueued.mockReset();
    actions.sendQueuedNow.mockReset();
    useRunControlStore.setState({ queue: [], actions });
  });

  it('空队列不占主视线', () => {
    render(<OverviewSteeringQueue />);
    expect(screen.queryByTestId('overview-queue-rows')).toBeNull();
  });

  it('每条排队消息一行，删除/立即发送各自调对应动作', () => {
    useRunControlStore.setState({
      queue: [
        { id: 'q1', content: '再补一段结论', attachmentsCount: 0 },
        { id: 'q2', content: '顺手改下标题', attachmentsCount: 2 },
      ],
    });

    render(<OverviewSteeringQueue />);
    expect(screen.getAllByTestId('overview-queue-row')).toHaveLength(2);
    expect(screen.getByText('再补一段结论')).toBeTruthy();
    expect(screen.getByText('2 个附件')).toBeTruthy();

    fireEvent.click(screen.getByTestId('overview-queue-send-q1'));
    fireEvent.click(screen.getByTestId('overview-queue-remove-q2'));

    expect(actions.sendQueuedNow).toHaveBeenCalledWith('q1');
    expect(actions.retractQueued).toHaveBeenCalledWith('q2');
    // 两个动作不能互串
    expect(actions.retractQueued).not.toHaveBeenCalledWith('q1');
    expect(actions.sendQueuedNow).not.toHaveBeenCalledWith('q2');
  });

  it('发送失败的条目只留删除，不摆宿主已不接受的重发按钮', () => {
    useRunControlStore.setState({
      queue: [{ id: 'q3', content: '发不出去那条', attachmentsCount: 0, sendFailed: true }],
    });

    render(<OverviewSteeringQueue />);
    expect(screen.queryByTestId('overview-queue-send-q3')).toBeNull();
    expect(screen.getByTestId('overview-queue-remove-q3')).toBeTruthy();
  });
});

describe('TaskWorkspaceOverview 四模块归位', () => {
  beforeEach(() => {
    window.localStorage.clear();
    useRunControlStore.setState({ queue: [], actions: null });
    useSessionStore.setState({ currentSessionId: 'session-a', sessions: [] as never });
    setRun(run({ status: 'running', startedAt: START }));
  });

  it('Run header 在主视线第一块，诊断 UI 不复存在（拍板三）', () => {
    render(<TaskWorkspaceOverview />);
    const root = screen.getByTestId('task-workspace-overview');
    const blocks = Array.from(root.children);

    expect(blocks[0]?.getAttribute('data-module')).toBe('task');
    expect(screen.queryByTestId('overview-diagnostics-body')).toBeNull();
    expect(screen.queryByText('诊断详情')).toBeNull();
  });
});
