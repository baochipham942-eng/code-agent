// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CronJobDefinition } from '../../../src/shared/contract/cron';
import type { MCPServerStateSummary } from '../../../src/renderer/hooks/useMcpServerStates';

let mockMcpServerStates: MCPServerStateSummary[] = [];
vi.mock('../../../src/renderer/hooks/useMcpServerStates', () => ({
  useMcpServerStates: () => mockMcpServerStates,
}));

import { CronJobEditor } from '../../../src/renderer/components/features/cron/CronJobEditor';
import { buildCronJobInput, buildDraftFromJob, createDefaultCronJobDraft } from '../../../src/renderer/components/features/cron/types';
import { useCronStore } from '../../../src/renderer/stores/cronStore';

function makeJob(overrides: Partial<CronJobDefinition> = {}): CronJobDefinition {
  return {
    id: 'job-budget',
    name: '受限任务',
    scheduleType: 'every',
    schedule: { type: 'every', interval: 1, unit: 'hours' },
    action: { type: 'shell', command: 'echo ok' },
    runsOn: 'local',
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

beforeEach(() => {
  useCronStore.setState({
    jobs: [],
    stats: null,
    latestExecutions: {},
    executionsByJobId: {},
    selectedJobId: null,
    isLoading: false,
    isEditorOpen: false,
    editingJobId: null,
    error: null,
    createJob: vi.fn(),
    updateJob: vi.fn(),
  });
  mockMcpServerStates = [];
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function openAdvancedTab(job: CronJobDefinition) {
  render(<CronJobEditor isOpen job={job} onClose={() => undefined} />);
  fireEvent.click(screen.getByText('高级选项'));
}

describe('N-CRON-BUDGET-EXPOSE 编辑器额度字段', () => {
  it('本地任务的高级选项展示单次预算与运行次数上限，并显示已跑计数', () => {
    openAdvancedTab(makeJob({ maxRunBudget: 0.5, maxRuns: 3, runCount: 2 }));

    expect(screen.getByText('单次预算上限 (USD)')).toBeTruthy();
    expect(screen.getByText('运行次数上限')).toBeTruthy();
    expect(screen.getByText(/已运行 2\/3 次/)).toBeTruthy();
    expect(screen.getByDisplayValue('0.5')).toBeTruthy();
    expect(screen.getByDisplayValue('3')).toBeTruthy();
  });

  it('云端任务不展示这两个字段', () => {
    openAdvancedTab(makeJob({ runsOn: 'cloud', schedule: { type: 'every', interval: 2, unit: 'hours' } }));

    expect(screen.queryByText('单次预算上限 (USD)')).toBeNull();
    expect(screen.queryByText('运行次数上限')).toBeNull();
  });

  it('buildCronJobInput emits numbers for filled fields and null for empty ones (PR#2208 R4)', () => {
    const filled = createDefaultCronJobDraft();
    filled.name = '受限任务';
    filled.shellCommand = 'echo ok';
    filled.maxRunBudget = '0.25';
    filled.maxRuns = '4';
    expect(buildCronJobInput(filled)).toMatchObject({ maxRunBudget: 0.25, maxRuns: 4 });

    // 空值必须送 null 而不是 undefined：JSON 传输丢 undefined 键，host 合并时会保留旧值。
    const empty = createDefaultCronJobDraft();
    empty.name = '不限任务';
    empty.shellCommand = 'echo ok';
    expect(buildCronJobInput(empty)).toMatchObject({ maxRunBudget: null, maxRuns: null });
  });

  it('cleared/cloud-dropped limits emit null that survives JSON transport (PR#2208 R4 Important)', () => {
    // 场景 a：编辑时把已设的上限清空——null 必须活着到 host，updateJob 合并才能真正清掉。
    const cleared = buildDraftFromJob(makeJob({ maxRuns: 3, maxRunBudget: 0.5 }));
    cleared.maxRuns = '';
    cleared.maxRunBudget = '';
    const clearedWire = JSON.parse(JSON.stringify(buildCronJobInput(cleared)));
    expect(clearedWire).toMatchObject({ maxRuns: null, maxRunBudget: null });

    // 场景 b：带 maxRuns 的本地任务切/复制到云端——丢弃也必须以 null 落在线上，
    // 否则缺键会被 host 从旧定义继承回来，云端校验每存必炸。
    const toCloud = { ...buildDraftFromJob(makeJob({ maxRuns: 3 })), runsOn: 'cloud' as const };
    const cloudWire = JSON.parse(JSON.stringify(buildCronJobInput(toCloud)));
    expect(cloudWire.maxRuns).toBeNull();
  });

  it('buildDraftFromJob maps an unset budget/limit to empty strings', () => {
    const draft = buildDraftFromJob(makeJob());
    expect(draft.maxRunBudget).toBe('');
    expect(draft.maxRuns).toBe('');
  });

  it('buildCronJobInput drops a hidden maxRuns for cloud jobs (PR#2208 R2 Important)', () => {
    // 复制本地任务到云端：draft 里带着来源任务的 maxRuns，但编辑面已把字段隐藏。
    const copied = { ...buildDraftFromJob(makeJob({ maxRuns: 3 })), runsOn: 'cloud' as const };
    expect(buildCronJobInput(copied).maxRuns).toBeNull();

    // 新建：先填运行次数上限再切到云端。
    const switched = createDefaultCronJobDraft();
    switched.name = '先填后切';
    switched.shellCommand = 'echo ok';
    switched.maxRuns = '5';
    switched.runsOn = 'cloud';
    expect(buildCronJobInput(switched).maxRuns).toBeNull();

    // 本地任务照常携带。
    const local = createDefaultCronJobDraft();
    local.name = '本地任务';
    local.shellCommand = 'echo ok';
    local.maxRuns = '5';
    expect(buildCronJobInput(local).maxRuns).toBe(5);
  });

  it('复制带 maxRuns 的本地任务到云端：保存时不再提交 maxRuns（PR#2208 R2 Important）', async () => {
    const createJob = vi.fn(async (_input: unknown) => makeJob());
    useCronStore.setState({ createJob });
    render(<CronJobEditor isOpen job={null} copySource={makeJob({ maxRuns: 3 })} onClose={() => undefined} />);

    fireEvent.click(screen.getByText('创建任务'));

    await waitFor(() => expect(createJob).toHaveBeenCalledTimes(1), { timeout: 3000 });
    expect(createJob.mock.calls[0]?.[0]).toMatchObject({ runsOn: 'cloud', maxRuns: null });
  });

  it('非法次数/预算在客户端就被拦下：buildCronJobInput 抛中文错，不把 host 英文原文放行到用户脸上（N-CRON-BUDGET-EXPOSE-SHOTS ⑤）', () => {
    for (const invalid of ['0', '1.5', '-1']) {
      const draft = createDefaultCronJobDraft();
      draft.name = '非法次数';
      draft.shellCommand = 'echo ok';
      draft.maxRuns = invalid;
      expect(() => buildCronJobInput(draft)).toThrow('运行次数上限必须是大于等于 1 的整数');
    }

    const budget = createDefaultCronJobDraft();
    budget.name = '非法预算';
    budget.shellCommand = 'echo ok';
    budget.maxRunBudget = '-1';
    expect(() => buildCronJobInput(budget)).toThrow('单次预算上限必须是大于等于 0 的数字');

    // 合法值与留空不受影响（空 = null = 不限）。
    const valid = createDefaultCronJobDraft();
    valid.name = '合法值';
    valid.shellCommand = 'echo ok';
    valid.maxRuns = '5';
    valid.maxRunBudget = '0.01';
    expect(() => buildCronJobInput(valid)).not.toThrow();
  });

  it('编辑器里保存非法次数：表单错误框给出可见中文提示，且不发出 updateJob（⑤ 的 UI 面）', async () => {
    const updateJob = vi.fn();
    useCronStore.setState({ updateJob });
    render(<CronJobEditor isOpen job={makeJob({ maxRuns: 3, maxRunBudget: 0.5 })} onClose={() => undefined} />);

    fireEvent.click(screen.getByText('高级选项'));
    fireEvent.change(screen.getByDisplayValue('3'), { target: { value: '1.5' } });
    fireEvent.click(screen.getByText('保存修改'));

    await waitFor(() => expect(screen.getByText('运行次数上限必须是大于等于 1 的整数')).toBeTruthy());
    expect(updateJob).not.toHaveBeenCalled();
  });

  it('编辑器里保存非法预算：同款可见中文提示（⑤ 的 UI 面）', async () => {
    const updateJob = vi.fn();
    useCronStore.setState({ updateJob });
    render(<CronJobEditor isOpen job={makeJob({ maxRuns: 3, maxRunBudget: 0.5 })} onClose={() => undefined} />);

    fireEvent.click(screen.getByText('高级选项'));
    fireEvent.change(screen.getByDisplayValue('0.5'), { target: { value: '-1' } });
    fireEvent.click(screen.getByText('保存修改'));

    await waitFor(() => expect(screen.getByText('单次预算上限必须是大于等于 0 的数字')).toBeTruthy());
    expect(updateJob).not.toHaveBeenCalled();
  });
});
