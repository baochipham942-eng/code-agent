// @vitest-environment jsdom
// N-CRON-AGENT-TIMEOUT-IGNORED：agent 任务到点超时的失败记录，执行详情要显示带时限的人话；
// 编辑器保存时 agentType 填错要给可读错误。
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invokeDomain: vi.fn() },
}));
vi.mock('../../../src/renderer/services/cronClient', () => ({
  cronClient: {
    listJobs: vi.fn().mockResolvedValue([]),
    getStats: vi.fn().mockResolvedValue(null),
    getExecutions: vi.fn().mockResolvedValue([]),
    getRecentExecutions: vi.fn().mockResolvedValue([]),
    triggerJob: vi.fn(),
  },
}));
import type { CronJobExecution } from '@shared/contract';
import { CronExecutionDetail } from '../../../src/renderer/components/features/cron/CronExecutionDetail';
import { buildCronJobInput, createDefaultCronJobDraft } from '../../../src/renderer/components/features/cron/types';
import { useAppStore } from '../../../src/renderer/stores/appStore';

const NOW = new Date(2026, 10, 4, 9, 0).getTime();

function failedExecution(error: string): CronJobExecution {
  return {
    id: 'exec-timeout', jobId: 'job-1', runsOn: 'local', status: 'failed',
    scheduledAt: NOW, startedAt: NOW, completedAt: NOW + 1_000, duration: 1_000,
    retryAttempt: 0, error,
  };
}

afterEach(() => {
  cleanup();
  useAppStore.setState({ language: 'zh' });
});

describe('CronExecutionDetail 超时失败文案', () => {
  it('zh：显示带时限的人话，不露英文机器文本', () => {
    useAppStore.setState({ language: 'zh' });
    render(<CronExecutionDetail execution={failedExecution('Cron job run exceeded its 1s time limit.')} />);
    expect(screen.getByText(/本次执行超过了任务的 1 秒时限/)).toBeTruthy();
    expect(screen.queryByText(/Cron job run exceeded/)).toBeNull();
  });

  it('en：显示 This run exceeded the task time limit of 1s', () => {
    useAppStore.setState({ language: 'en' });
    render(<CronExecutionDetail execution={failedExecution('Cron job run exceeded its 1s time limit.')} />);
    expect(screen.getByText(/This run exceeded the task time limit of 1s/)).toBeTruthy();
  });
});

describe('buildCronJobInput agentType 校验', () => {
  const agentDraft = (agentType: string) => {
    const draft = createDefaultCronJobDraft();
    draft.name = 'agent 任务';
    draft.actionType = 'agent';
    draft.agentType = agentType;
    draft.agentPrompt = '检查一下';
    return draft;
  };

  it('abc 抛出点名坏值并列出可选值的错误', () => {
    expect(() => buildCronJobInput(agentDraft('abc'))).toThrow('Agent 类型“abc”不存在，可选值：default、heartbeat、dream、distill。');
  });

  it('default 通过', () => {
    expect(buildCronJobInput(agentDraft('default'))).toMatchObject({ action: { type: 'agent', agentType: 'default' } });
  });
});
