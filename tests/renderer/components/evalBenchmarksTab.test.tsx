// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EVALUATION_CHANNELS } from '@internal-evaluation/shared/evaluationChannels';
import { UNKNOWN_EVAL_RUN_STAMP } from '../../../src/shared/contract/evaluation';
import type {
  EvalExperimentDetail,
  EvalExperimentListItem,
  EvalRunEvent,
  EvalRunPanelProbe,
} from '../../../src/shared/contract/evaluation';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn<(channel: string, arg?: unknown) => Promise<unknown>>(),
  on: vi.fn(),
  eventHandler: undefined as ((event: EvalRunEvent) => void) | undefined,
  order: [] as string[],
}));

vi.mock('@internal-evaluation/renderer/evaluationRunIpc', () => ({
  invokeEvaluation: mocks.invoke,
  onEvaluation: mocks.on,
}));

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    invoke: mocks.invoke,
    on: mocks.on,
  },
}));

vi.mock('react-virtuoso', () => ({
  Virtuoso: React.forwardRef(function MockVirtuoso(props: {
    data?: Array<{ id: string; text: string }>;
    itemContent?: (index: number, item: { id: string; text: string }) => React.ReactNode;
  }, _ref) {
    return <div data-testid="virtuoso-log">{props.data?.map((item, index) => <div key={item.id}>{props.itemContent?.(index, item)}</div>)}</div>;
  }),
}));

import { EvalBenchmarksTab } from '@internal-evaluation/renderer/evalCenter/EvalBenchmarksTab';

const probe: EvalRunPanelProbe = {
  environment: {
    available: true,
    message: '评测环境已就绪',
    packaged: false,
    platform: 'darwin',
    osJail: { enabled: false, available: true, active: false },
  },
  model: 'deepseek-chat',
  provider: 'deepseek',
  priceTableVersion: 1,
  estimatedCostPerCaseUsd: 0.0021,
  judge: { model: 'glm-4.7', provider: 'zhipu', estimatedCostPerCaseUsd: 0.01 },
  aiReview: [
    { dim: 'task_completed', requiresExpectation: false, calibration: { state: 'uncalibrated', reason: 'not_enough_pairs', pairs: 12 } },
    { dim: 'tool_choice', requiresExpectation: true, calibration: { state: 'uncalibrated', reason: 'no_record' } },
    { dim: 'confirmed_before_acting', requiresExpectation: false, calibration: { state: 'calibrated', kappa: 0.71, pairs: 34 } },
    { dim: 'no_extra_changes', requiresExpectation: true, calibration: { state: 'uncalibrated', reason: 'no_record' } },
    { dim: 'self_tested', requiresExpectation: true, calibration: { state: 'uncalibrated', reason: 'no_record' } },
  ],
  splitCounts: { 'held-in': 76, 'held-out': 52, safety: 12 },
  unhardenedCount: 0,
  quickCheck: { tags: ['core-path'], maxCases: 12 },
  productionArm: { name: 'production@sys-v45', model: 'deepseek-chat', provider: 'deepseek' },
  skills: ['data-cleaning', 'xlsx'],
};

const experiment = (
  id: string,
  timestamp: number,
  config: Record<string, unknown>,
  summary: EvalExperimentListItem['summary'] = { passRate: 0.5, passed: 1, total: 2, completed: true, notRun: 0 },
): EvalExperimentListItem => ({
  id,
  name: `eval-${id}`,
  timestamp,
  model: 'deepseek-chat',
  provider: 'deepseek',
  scope: 'full',
  source: 'eval',
  gitCommit: null,
  config,
  summary,
});

const detail = (run: EvalExperimentListItem, cases: EvalExperimentDetail['cases']): EvalExperimentDetail => ({
  experiment: run,
  cases,
});

function configureIpc(
  list: () => EvalExperimentListItem[] = () => [],
  eventsOnSubscribe: EvalRunEvent[] = [],
  startResult: unknown = { runId: 'run-live' },
) {
  mocks.on.mockImplementation((_channel: string, callback: (event: EvalRunEvent) => void) => {
    mocks.order.push('listen');
    mocks.eventHandler = callback;
    return vi.fn();
  });
  mocks.invoke.mockImplementation(async (channel: string, arg?: unknown) => {
    if (channel === EVALUATION_CHANNELS.LIST_EXPERIMENTS) return list();
    if (channel === EVALUATION_CHANNELS.RUN_EVENTS && !arg) return probe;
    if (channel === EVALUATION_CHANNELS.RUN_SUITE) return startResult;
    if (channel === EVALUATION_CHANNELS.RUN_EVENTS) {
      mocks.order.push('subscribe');
      eventsOnSubscribe.forEach((event) => mocks.eventHandler?.(event));
      return { runId: 'run-live', running: true };
    }
    if (channel === EVALUATION_CHANNELS.ABORT_RUN) return { runId: 'run-live', pid: 1, terminated: true };
    return null;
  });
}

async function openWizardAndArm(): Promise<void> {
  fireEvent.click(await screen.findByRole('button', { name: '开跑' }));
  fireEvent.click(screen.getByTestId('eval-run-confirm'));
  await screen.findByText(/再点一次确认/);
}

async function startRun(): Promise<void> {
  await openWizardAndArm();
  fireEvent.click(screen.getByTestId('eval-run-confirm'));
  await waitFor(() => expect(mocks.on).toHaveBeenCalledTimes(1));
}

beforeEach(() => {
  mocks.invoke.mockReset();
  mocks.on.mockReset();
  mocks.eventHandler = undefined;
  mocks.order.length = 0;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('EvalBenchmarksTab 跑分闭环', () => {
  it('T3：读侧即使返回 compare 行，跑分历史仍主动隔离', async () => {
    const compare = { ...experiment('compare-only', 1_000, { split: 'held-in', k: 1, mode: 'real' }), source: 'compare' };
    configureIpc(() => [compare]);
    render(<EvalBenchmarksTab />);

    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith(
      EVALUATION_CHANNELS.LIST_EXPERIMENTS,
      { limit: 100, source: 'eval' },
    ));
    expect(screen.queryByTestId('benchmark-run-compare-only')).toBeNull();
  });

  it('T1：第一次点击不发车，5 秒收回；第二次点击才发且 payload 不含 host 配置', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    configureIpc();
    render(<EvalBenchmarksTab />);

    await openWizardAndArm();
    expect(mocks.invoke.mock.calls.some(([channel]) => channel === EVALUATION_CHANNELS.RUN_SUITE)).toBe(false);

    act(() => vi.advanceTimersByTime(5_000));
    expect(screen.getByTestId('eval-run-confirm').textContent).toContain('真跑并计费');
    expect(mocks.invoke.mock.calls.some(([channel]) => channel === EVALUATION_CHANNELS.RUN_SUITE)).toBe(false);

    fireEvent.click(screen.getByTestId('eval-run-confirm'));
    fireEvent.click(screen.getByTestId('eval-run-confirm'));
    await waitFor(() => expect(mocks.invoke.mock.calls.some(([channel]) => channel === EVALUATION_CHANNELS.RUN_SUITE)).toBe(true));

    const call = mocks.invoke.mock.calls.find(([channel]) => channel === EVALUATION_CHANNELS.RUN_SUITE);
    expect(call?.[1]).toMatchObject({ scope: 'full', split: 'held-in', maxCases: 76 });
    expect(call?.[1]).not.toHaveProperty('apiKey');
    expect(call?.[1]).not.toHaveProperty('model');
    expect(call?.[1]).not.toHaveProperty('provider');
    expect(call?.[1]).not.toHaveProperty('workingDirectory');
  });

  it('T1b：host 拒跑信封不创建幽灵运行，也不订阅事件', async () => {
    configureIpc(
      () => [],
      [],
      { success: false, error: { code: 'EVAL_RUN_REJECTED', message: 'environment unavailable' } },
    );
    render(<EvalBenchmarksTab />);

    await openWizardAndArm();
    fireEvent.click(screen.getByTestId('eval-run-confirm'));

    expect(await screen.findByText('这轮没有成功发车，请检查评测环境后重试。')).toBeTruthy();
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.queryByTestId('eval-run-active')).toBeNull();
    expect(mocks.on).not.toHaveBeenCalled();
    expect(mocks.invoke.mock.calls.some(([channel, arg]) => (
      channel === EVALUATION_CHANNELS.RUN_EVENTS && Boolean(arg)
    ))).toBe(false);
  });

  it('T6：未校准维默认不勾，勾选后请求透传且费用按题数×维数×评审单价单列', async () => {
    configureIpc();
    render(<EvalBenchmarksTab />);
    fireEvent.click(await screen.findByRole('button', { name: '开跑' }));

    const toggle = screen.getByTestId('eval-ai-review-toggle-task_completed');
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    expect(toggle.textContent).toContain('金标不足 N<20');
    fireEvent.click(toggle);

    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText('结果只作参考，不作能力证据')).toBeTruthy();
    expect(screen.getByTestId('eval-ai-review-cost').textContent).toContain('$0.76');

    fireEvent.click(screen.getByTestId('eval-run-confirm'));
    fireEvent.click(screen.getByTestId('eval-run-confirm'));
    await waitFor(() => expect(mocks.invoke.mock.calls.some(([channel]) => channel === EVALUATION_CHANNELS.RUN_SUITE)).toBe(true));
    const call = mocks.invoke.mock.calls.find(([channel]) => channel === EVALUATION_CHANNELS.RUN_SUITE);
    expect(call?.[1]).toMatchObject({ aiReview: ['task_completed'] });
  });

  it('T2：先监听再 subscribe，事件流驱动三行步骤并把工具调用折成一行', async () => {
    const base = { schemaVersion: 3 as const, runId: 'run-live' };
    const synchronousEvents: EvalRunEvent[] = [
      {
        ...base,
        type: 'run_start',
        ts: 1_000,
        plannedCaseIds: ['case-a', 'case-b', 'case-c'],
        config: {
          ...UNKNOWN_EVAL_RUN_STAMP,
          evalSet: { ...UNKNOWN_EVAL_RUN_STAMP.evalSet, split: 'held-in' },
          mode: 'real', model: 'deepseek-chat', provider: 'deepseek', scope: 'full', split: 'held-in',
          maxCases: 3, concurrency: 1, gitCommit: 'abc', testCaseDir: '.claude/test-cases',
        },
      },
      { ...base, type: 'case_start', ts: 1_100, testId: 'case-a', description: 'A' },
      { ...base, type: 'tool_call', ts: 1_200, testId: 'case-a', tool: 'read_file', input: {} },
      { ...base, type: 'tool_call', ts: 1_300, testId: 'case-a', tool: 'bash', input: {} },
      { ...base, type: 'case_end', ts: 1_400, testId: 'case-a', status: 'passed', score: 1, durationMs: 300 },
      { ...base, type: 'case_end', ts: 1_500, testId: 'case-b', status: 'infra_excluded', score: 0, durationMs: 100 },
    ];
    configureIpc(() => [], synchronousEvents);
    render(<EvalBenchmarksTab />);
    await startRun();
    expect(mocks.order).toEqual(['listen', 'subscribe']);

    expect(await screen.findByText('case-a')).toBeTruthy();
    expect(screen.getByText('case-b')).toBeTruthy();
    expect(screen.getByText('case-c')).toBeTruthy();
    expect(screen.getByText('不计入通过率（环境故障）')).toBeTruthy();
    expect(screen.getByTestId('virtuoso-log').textContent).toContain('case-a 调用了 2 个工具');
    expect(screen.getByTestId('virtuoso-log').textContent?.match(/调用了/g)).toHaveLength(1);
  });

  it('T3/T4：停止进入等待态；run_end 标未跑满，error 平静退化且不抛错', async () => {
    let history: EvalExperimentListItem[] = [];
    configureIpc(() => history);
    render(<EvalBenchmarksTab />);
    await startRun();

    act(() => {
      mocks.eventHandler?.({
        schemaVersion: 3,
        type: 'run_start',
        ts: 1_000,
        runId: 'run-live',
        plannedCaseIds: ['case-a', 'case-b'],
        config: {
          ...UNKNOWN_EVAL_RUN_STAMP,
          evalSet: { ...UNKNOWN_EVAL_RUN_STAMP.evalSet, split: 'held-in' },
          mode: 'real', model: 'deepseek-chat', provider: 'deepseek', scope: 'full',
          maxCases: 2, concurrency: 1, gitCommit: 'abc', testCaseDir: 'cases',
        },
      });
    });
    fireEvent.click(screen.getByRole('button', { name: '停止' }));
    expect(screen.getByText('正在停止…')).toBeTruthy();

    history = [experiment('run-live', 2_000, { split: 'held-in', k: 1, caseBankSha: 'abcdef0123', mode: 'real' }, {
      passRate: 0.5, passed: 1, total: 2, completed: false, notRun: 1, aborted: true,
    })];
    act(() => {
      mocks.eventHandler?.({
        schemaVersion: 3,
        type: 'run_end',
        ts: 2_000,
        runId: 'run-live',
        summary: {
          runId: 'run-live', startTime: 1_000, endTime: 2_000, duration: 1_000, total: 2,
          passed: 1, failed: 0, skipped: 0, partial: 0, averageScore: 1,
          plannedCaseIds: ['case-a', 'case-b'], completed: false, notRun: 1, invalidCases: 0, aborted: true,
        },
        reportFiles: [], exitCode: 0, aborted: true,
      });
    });
    const row = await screen.findByTestId('benchmark-run-run-live');
    expect(row.textContent).toContain('未跑满');
    expect(row.querySelector('button')?.disabled).toBe(true);

    cleanup();
    history = [];
    configureIpc(() => history);
    render(<EvalBenchmarksTab />);
    await startRun();
    act(() => {
      mocks.eventHandler?.({ schemaVersion: 3, type: 'error', ts: 3_000, runId: 'run-live', error: 'boom' });
    });
    expect(await screen.findByText('这轮没有正常结束，已按已跑完的题记录')).toBeTruthy();
  });

  it('T5：按评测集 × k × 题库版本分组，缺版本回落 unknown，mock 不显示', async () => {
    const runA = experiment('a', 3_000, { split: 'held-in', k: 1, caseBankSha: 'abcdef0123', mode: 'real' });
    const runB = experiment('b', 2_000, { evalSet: { split: 'held-in' }, k: 1, caseBankSha: 'abcdef0123', mode: 'real' });
    const runUnknown = experiment('unknown', 1_000, { split: 'held-in', k: 1, mode: 'real' });
    const runMock = experiment('mock', 4_000, { split: 'held-in', k: 1, caseBankSha: 'abcdef0123', mode: 'mock' });
    configureIpc(() => [runA, runB, runUnknown, runMock]);
    mocks.invoke.mockImplementation(async (channel: string, arg?: unknown) => {
      if (channel === EVALUATION_CHANNELS.LIST_EXPERIMENTS) return [runA, runB, runUnknown, runMock];
      if (channel === EVALUATION_CHANNELS.RUN_EVENTS && !arg) return probe;
      if (channel === EVALUATION_CHANNELS.LOAD_EXPERIMENT) {
        const run = arg === 'a' ? runA : runB;
        return detail(run, [{ caseId: 'case-1', status: arg === 'a' ? 'passed' : 'failed', score: 1, durationMs: 10 }]);
      }
      return null;
    });
    render(<EvalBenchmarksTab />);

    expect(await screen.findByText('日常集 · 每题 1 次 · 题库 abcdef0')).toBeTruthy();
    expect(screen.getByText('日常集 · 每题 1 次 · 题库 未知版本')).toBeTruthy();
    expect(screen.queryByTestId('benchmark-run-mock')).toBeNull();

    fireEvent.click(screen.getByTestId('benchmark-run-a').querySelector('button') as HTMLButtonElement);
    fireEvent.click(screen.getByTestId('benchmark-run-b').querySelector('button') as HTMLButtonElement);
    expect(await screen.findByText('50.0% → 50.0%')).toBeTruthy();
    expect(screen.getByText('case-1')).toBeTruthy();
  });
});
