// @vitest-environment jsdom
// ============================================================================
// Cron 中心编辑器 metadata 往返（N-ARTIFACT-STANDING-REFRESH-REALRUN ⑤①缺陷回归）。
// 真跑实测：编辑器保存走 buildCronJobInput(draft)，载荷固定 metadata:{}，而 host
// updateJob 对 metadata 是顶层整体替换（updates.metadata ?? existing，{} 非 nullish）
// ——一次「无操作编辑」就把 metadata.artifactRefresh 清空，常设刷新任务随即停止
// 留版。修复 = draft 携带原 metadata 往返回写（eventMailSource 同款先例），复制
// 分支显式剥离。
// ============================================================================
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { CronJobDefinition } from '../../../src/shared/contract/cron';

const ipc = vi.hoisted(() => ({
  invoke: vi.fn(),
  on: vi.fn(() => () => undefined),
}));

vi.mock('../../../src/renderer/services/ipcService', () => ({ default: ipc }));
vi.mock('../../../src/renderer/hooks/useMcpServerStates', () => ({
  useMcpServerStates: () => [],
}));

import { CronJobEditor } from '../../../src/renderer/components/features/cron/CronJobEditor';
import { buildCronJobInput, buildDraftFromJob } from '../../../src/renderer/components/features/cron/types';
import { useCronStore } from '../../../src/renderer/stores/cronStore';

function makeRefreshJob(overrides: Partial<CronJobDefinition> = {}): CronJobDefinition {
  return {
    id: 'job-refresh-md',
    name: 'Refresh status.md',
    scheduleType: 'every',
    schedule: { type: 'every', interval: 5, unit: 'minutes' },
    action: {
      type: 'agent',
      agentType: 'default',
      prompt: 'You are maintaining the file artifact at "/tmp/status.md".',
    },
    runsOn: 'local',
    enabled: true,
    createdAt: 1,
    updatedAt: 2,
    tags: ['artifact-refresh'],
    metadata: {
      artifactRefresh: {
        path: '/tmp/status.md',
        instruction: 'append a refreshed line',
        cadence: 'hourly',
      },
    },
    ...overrides,
  };
}

beforeEach(() => {
  ipc.invoke.mockReset();
  useCronStore.setState({
    jobs: [],
    stats: null,
    latestExecutions: {},
    executionsByJobId: {},
    selectedJobId: null,
    filterMode: 'all',
    searchQuery: '',
    isLoading: false,
    isEditorOpen: false,
    editingJobId: null,
    copyingJobId: null,
    error: null,
    createJob: vi.fn(),
    updateJob: vi.fn(),
    deleteJob: vi.fn(),
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('编辑器 metadata 往返（纯函数链 = 编辑器保存时的真实载荷）', () => {
  it('buildDraftFromJob → buildCronJobInput 原样回写 metadata.artifactRefresh（无操作编辑不清空）', () => {
    const job = makeRefreshJob();
    const input = buildCronJobInput(buildDraftFromJob(job));
    // 修复前：metadata 恒为 {}，artifactRefresh 被顶层整体替换清空
    expect(input.metadata).toEqual(job.metadata);
  });

  it('任务没有 metadata 时照旧送空对象（新建/无载荷任务行为不变）', () => {
    const job = makeRefreshJob({ metadata: undefined });
    const input = buildCronJobInput(buildDraftFromJob(job));
    expect(input.metadata).toEqual({});
  });
});

describe('挂载编辑器（编辑路径）', () => {
  it('无操作编辑保存：updateJob 载荷携带原 metadata.artifactRefresh', async () => {
    const job = makeRefreshJob();
    render(<CronJobEditor isOpen job={job} onClose={() => undefined} />);
    await waitFor(() => expect(screen.getByDisplayValue('Refresh status.md')).toBeTruthy());

    fireEvent.click(screen.getByText('保存修改'));

    const updateJob = useCronStore.getState().updateJob as Mock;
    await waitFor(() => expect(updateJob).toHaveBeenCalledTimes(1));
    const input = updateJob.mock.calls[0][1];
    expect(input.metadata).toEqual(job.metadata);
  });
});

describe('挂载编辑器（复制路径，基线护栏）', () => {
  it('复制出的新任务不继承原 metadata（createJob 收到空对象）', async () => {
    const source = makeRefreshJob();
    render(<CronJobEditor isOpen job={null} copySource={source} onClose={() => undefined} />);
    await waitFor(() => expect(screen.getByDisplayValue(/Refresh status\.md/)).toBeTruthy());

    fireEvent.click(screen.getByText('创建任务'));

    const createJob = useCronStore.getState().createJob as Mock;
    await waitFor(() => expect(createJob).toHaveBeenCalledTimes(1));
    const input = createJob.mock.calls[0][0];
    expect(input.metadata).toEqual({});
  });
});
