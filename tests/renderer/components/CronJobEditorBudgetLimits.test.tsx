// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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

  it('buildCronJobInput emits numbers for filled fields and undefined for empty ones', () => {
    const filled = createDefaultCronJobDraft();
    filled.name = '受限任务';
    filled.shellCommand = 'echo ok';
    filled.maxRunBudget = '0.25';
    filled.maxRuns = '4';
    expect(buildCronJobInput(filled)).toMatchObject({ maxRunBudget: 0.25, maxRuns: 4 });

    const empty = createDefaultCronJobDraft();
    empty.name = '不限任务';
    empty.shellCommand = 'echo ok';
    expect(buildCronJobInput(empty)).toMatchObject({ maxRunBudget: undefined, maxRuns: undefined });
  });

  it('buildDraftFromJob maps an unset budget/limit to empty strings', () => {
    const draft = buildDraftFromJob(makeJob());
    expect(draft.maxRunBudget).toBe('');
    expect(draft.maxRuns).toBe('');
  });
});
