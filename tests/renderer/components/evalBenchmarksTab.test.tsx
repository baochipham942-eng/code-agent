// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

// 显式标注签名：vi.fn(async () => undefined) 会把类型推成零参，
// 后面 mockImplementation((channel) => ...) 就装不进去（tests tsconfig 棘轮会红）。
const invokeMock = vi.hoisted(() => vi.fn<(channel: string, arg?: unknown) => Promise<unknown>>(async () => undefined));
vi.mock('../../../src/renderer/services/ipcService', () => ({
  ipcService: { invoke: invokeMock, on: vi.fn() },
  default: { invoke: invokeMock, on: vi.fn() },
}));

import { EvalBenchmarksTab } from '../../../src/renderer/components/features/evalCenter/EvalBenchmarksTab';
import { IPC_CHANNELS } from '@shared/ipc';
import type {
  EvalExperimentDetail,
  EvalExperimentListItem,
} from '../../../src/shared/contract/evaluation';

const experiment = (
  id: string,
  timestamp: number,
  passRate: number,
  passed: number,
  total: number,
  source = 'eval-harness',
  name = `${source}-${id}`,
): EvalExperimentListItem => ({
  id,
  name,
  timestamp,
  model: 'test-model',
  provider: 'test-provider',
  scope: 'full',
  source,
  gitCommit: null,
  summary: { passRate, passed, total },
});

const detail = (id: string, passRate: number, cases: EvalExperimentDetail['cases']): EvalExperimentDetail => ({
  experiment: { ...experiment(id, 0, 0, 0, 0), summary: { passRate } },
  cases,
});

describe('EvalBenchmarksTab', () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it('渲染五关卡分层条与空态', async () => {
    invokeMock.mockImplementation(async (channel: string) => {
      if (channel === IPC_CHANNELS.EVALUATION_LIST_EXPERIMENTS) return [];
      return null;
    });
    render(<EvalBenchmarksTab />);

    for (let level = 1; level <= 5; level += 1) {
      expect(screen.getByTestId(`benchmark-level-${level}`)).toBeTruthy();
    }
    expect(await screen.findByText('还没有落盘的跑分结果（experiments 表为空）。')).toBeTruthy();
  });

  it('按归一数据集名分组列出跑分，展开后显示最近两次对比（用例状态变迁）', async () => {
    const runs = [
      experiment('run-new', 2000, 1, 2, 2, 'eval-harness', 'gsm8k-2026-07-21'),
      experiment('run-old', 1000, 0.5, 1, 2, 'eval-harness', 'gsm8k-2026-07-20'),
    ];
    invokeMock.mockImplementation(async (channel: string, arg?: unknown) => {
      if (channel === IPC_CHANNELS.EVALUATION_LIST_EXPERIMENTS) return runs;
      if (channel === IPC_CHANNELS.EVALUATION_LOAD_EXPERIMENT) {
        if (arg === 'run-new') {
          return detail('run-new', 1, [
            { caseId: 'case-a', status: 'passed', score: 100, durationMs: 10 },
            { caseId: 'case-b', status: 'passed', score: 90, durationMs: 20 },
          ]);
        }
        return detail('run-old', 0.5, [
          { caseId: 'case-a', status: 'passed', score: 100, durationMs: 10 },
          { caseId: 'case-b', status: 'failed', score: 0, durationMs: 20 },
        ]);
      }
      return null;
    });
    render(<EvalBenchmarksTab />);

    // 组标题显示归一后的数据集名（原始 name 的日期后缀被剥掉）
    const group = await screen.findByTestId('benchmark-group-eval-harness-gsm8k');
    expect(group.textContent).toContain('gsm8k');
    expect(group.textContent).toContain('Eval Harness 跑分');
    expect(group.textContent).toContain('2 次运行');

    // 展开分组 → 懒加载两次运行的用例行并计算变迁
    fireEvent.click(group.querySelector('button') as HTMLButtonElement);

    const compare = await screen.findByTestId('benchmark-compare-eval-harness-gsm8k');
    expect(compare.textContent).toContain('50.0% → 100.0%');
    expect(compare.textContent).toContain('新增失败 0');
    expect(compare.textContent).toContain('转通过 1');
    expect(compare.textContent).toContain('case-b');

    // 两次运行的行显示原始 name（保留日期后缀可追溯）
    expect(group.textContent).toContain('gsm8k-2026-07-21');
    expect(group.textContent).toContain('gsm8k-2026-07-20');
  });

  it('跨数据集混跑时最近两次对比不跨数据集', async () => {
    const runs = [
      experiment('gsm8k-new', 3000, 1, 2, 2, 'eval-harness', 'gsm8k-2026-07-21'),
      experiment('math-only', 2000, 0.5, 1, 2, 'eval-harness', 'math-2026-07-20'),
      experiment('gsm8k-old', 1000, 0.5, 1, 2, 'eval-harness', 'gsm8k-2026-07-19'),
    ];
    const loadedIds: string[] = [];
    invokeMock.mockImplementation(async (channel: string, arg?: unknown) => {
      if (channel === IPC_CHANNELS.EVALUATION_LIST_EXPERIMENTS) return runs;
      if (channel === IPC_CHANNELS.EVALUATION_LOAD_EXPERIMENT) {
        loadedIds.push(String(arg));
        return detail(String(arg), 1, [
          { caseId: 'case-a', status: 'passed', score: 100, durationMs: 10 },
        ]);
      }
      return null;
    });
    render(<EvalBenchmarksTab />);

    // 归一后分成 gsm8k / math 两组，各自独立对比
    const gsm8kGroup = await screen.findByTestId('benchmark-group-eval-harness-gsm8k');
    const mathGroup = await screen.findByTestId('benchmark-group-eval-harness-math');
    expect(gsm8kGroup.textContent).toContain('2 次运行');
    expect(mathGroup.textContent).toContain('1 次运行');

    fireEvent.click(gsm8kGroup.querySelector('button') as HTMLButtonElement);
    await screen.findByTestId('benchmark-compare-eval-harness-gsm8k');
    // 对比取的是 gsm8k 名下按时间最近的两次，不掺 math 的运行
    expect(loadedIds.sort()).toEqual(['gsm8k-new', 'gsm8k-old']);

    fireEvent.click(mathGroup.querySelector('button') as HTMLButtonElement);
    expect(await screen.findByText('该组至少两次运行才能对比。')).toBeTruthy();
  });

  it('单次运行的组给出「至少两次运行才能对比」提示', async () => {
    invokeMock.mockImplementation(async (channel: string) => {
      if (channel === IPC_CHANNELS.EVALUATION_LIST_EXPERIMENTS) {
        return [experiment('only-run', 1000, 1, 1, 1, 'regression', 'regression-2026-07-21')];
      }
      return null;
    });
    render(<EvalBenchmarksTab />);

    const group = await screen.findByTestId('benchmark-group-regression-regression');
    fireEvent.click(group.querySelector('button') as HTMLButtonElement);

    expect(await screen.findByText('该组至少两次运行才能对比。')).toBeTruthy();
  });
});
