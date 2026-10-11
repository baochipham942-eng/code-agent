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
    const updateJob = vi.fn(async () => makeAgentJob());
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
    const updateJob = vi.fn(async () => makeAgentJob());
    useCronStore.setState({ updateJob });
    openActionTab(makeAgentJob('旧判据'));

    fireEvent.change(urgencyInput(), { target: { value: '' } });
    fireEvent.click(screen.getByText('保存修改'));

    await waitFor(() => expect(updateJob).toHaveBeenCalledTimes(1), { timeout: 3000 });
    expect(updateJob.mock.calls[0]?.[1].action).toMatchObject({ urgencyCriteria: undefined });
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
