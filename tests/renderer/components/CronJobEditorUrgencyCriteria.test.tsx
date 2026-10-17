// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CronJobDefinition } from '../../../src/shared/contract/cron';
import type { MCPServerStateSummary } from '../../../src/renderer/hooks/useMcpServerStates';
import { CRON_URGENCY_CRITERIA } from '../../../src/shared/constants';

let mockMcpServerStates: MCPServerStateSummary[] = [];
vi.mock('../../../src/renderer/hooks/useMcpServerStates', () => ({
  useMcpServerStates: () => mockMcpServerStates,
}));

import { CronJobEditor } from '../../../src/renderer/components/features/cron/CronJobEditor';
import { buildCronJobInput, buildDraftFromJob } from '../../../src/renderer/components/features/cron/types';
import { useCronStore } from '../../../src/renderer/stores/cronStore';
import { useAppStore } from '../../../src/renderer/stores/appStore';

function makeAgentJob(urgencyCriteria?: string): CronJobDefinition {
  return {
    id: 'job-urgency',
    name: '晨间分诊',
    scheduleType: 'cron',
    schedule: { type: 'cron', expression: '30 8 * * 1-5', timezone: 'Asia/Shanghai' },
    action: {
      type: 'agent',
      agentType: 'default',
      prompt: '汇总未读邮件和消息',
      ...(urgencyCriteria ? { urgencyCriteria } : {}),
    },
    runsOn: 'local',
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
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

function openActionTab(job: CronJobDefinition | null) {
  render(<CronJobEditor isOpen job={job} onClose={() => undefined} />);
  fireEvent.click(screen.getByText('执行动作'));
}

function urgencyInput(): HTMLInputElement {
  return screen.getByTestId('cron-agent-urgency-criteria') as HTMLInputElement;
}

describe('N-CRON-MORNING-TRIAGE-URGENCY-RULE 编辑器紧急判据字段', () => {
  it('agent 动作有单行输入（maxLength=CRON_URGENCY_CRITERIA.MAX_CHARS），job → draft 显示已存值', () => {
    openActionTab(makeAgentJob('只有老板的邮件算紧急'));

    const input = urgencyInput();
    expect(input.tagName).toBe('INPUT');
    expect(input.maxLength).toBe(CRON_URGENCY_CRITERIA.MAX_CHARS);
    expect(input.value).toBe('只有老板的邮件算紧急');
  });

  it('改完保存：draft → 提交的 action 带 urgencyCriteria（job → draft → saved 往返）', async () => {
    const updateJob = vi.fn(async (_jobId: string, _updates: unknown) => makeAgentJob());
    useCronStore.setState({ updateJob });
    openActionTab(makeAgentJob('旧判据'));

    fireEvent.change(urgencyInput(), { target: { value: '只有老板发来的邮件算今天必须处理' } });
    fireEvent.click(screen.getByText('保存修改'));

    await waitFor(() => expect(updateJob).toHaveBeenCalledTimes(1), { timeout: 3000 });
    expect(updateJob.mock.calls[0]?.[1]).toMatchObject({
      action: {
        type: 'agent',
        urgencyCriteria: '只有老板发来的邮件算今天必须处理',
      },
    });
  });

  it('清空后保存：提交的 action 不带 urgencyCriteria（回落缺省判据）', async () => {
    const updateJob = vi.fn(async (_jobId: string, _updates: unknown) => makeAgentJob());
    useCronStore.setState({ updateJob });
    openActionTab(makeAgentJob('旧判据'));

    fireEvent.change(urgencyInput(), { target: { value: '' } });
    fireEvent.click(screen.getByText('保存修改'));

    await waitFor(() => expect(updateJob).toHaveBeenCalledTimes(1), { timeout: 3000 });
    const submitted = updateJob.mock.calls[0]?.[1] as { action?: { urgencyCriteria?: string } };
    expect(submitted?.action).toMatchObject({ urgencyCriteria: undefined });
  });

  it('非 agent 动作不渲染该字段；draft 往返两端默认空串', () => {
    const shellJob: CronJobDefinition = {
      ...makeAgentJob(),
      action: { type: 'shell', command: 'echo ok' },
    };
    openActionTab(shellJob);
    expect(screen.queryByTestId('cron-agent-urgency-criteria')).toBeNull();

    // job → draft：未设置时是空串；draft → input：空串归 undefined
    const draft = buildDraftFromJob(makeAgentJob());
    expect(draft.agentUrgencyCriteria).toBe('');
    draft.name = 'x';
    const input = buildCronJobInput(draft);
    expect(input.action).toMatchObject({ type: 'agent', urgencyCriteria: undefined });
  });
});

// N-CRON-URGENCY-NOTIFY：判据字段下方的 hint 告诉用户「设了判据，非必办的运行
// 不再弹通知、安静等在待过目列表里」——不解释这条后果，用户会以为判据只影响
// 收件箱排序，被静音了也不知道去哪找结果。
describe('N-CRON-URGENCY-NOTIFY 判据字段 hint（zh/en）', () => {
  it('zh：字段下渲染安静语义 hint', () => {
    openActionTab(makeAgentJob('只有老板的邮件算紧急'));
    expect(
      screen.getByText('设置后，非今日必办（可以稍后 / 仅供参考）的运行不再弹通知，安静等在待过目列表里。'),
    ).toBeTruthy();
  });

  it('en：hint 走 en 文案（语言切换生效）', () => {
    useAppStore.setState({ language: 'en' });
    try {
      openActionTab(makeAgentJob('only mail from my boss'));
      expect(
        screen.getByText('With a rule set, non-urgent runs (can wait / FYI) skip notifications and wait quietly in the review list.'),
      ).toBeTruthy();
    } finally {
      useAppStore.setState({ language: 'zh' });
    }
  });
});
