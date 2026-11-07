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
import { CLOUD_ROLE_BOUND_ERROR } from '../../../src/renderer/components/features/cron/CronCloudRoleRestriction';
import { useCronStore } from '../../../src/renderer/stores/cronStore';
import { useAppStore } from '../../../src/renderer/stores/appStore';

const zhReason = '角色自动化要读取这台电脑上的角色记忆，云端是全新的隔离环境用不了，所以只能在本机运行。';
const enReason = "Role automations need this computer's role memory, which the cloud's fresh isolated environment cannot access, so they can only run on this computer.";

function localAgentJob(roleId?: string): CronJobDefinition {
  return {
    id: 'job-local-agent',
    name: '晨间简报',
    scheduleType: 'every',
    schedule: { type: 'every', interval: 1, unit: 'hours' },
    action: {
      type: 'agent',
      agentType: 'default',
      prompt: '汇总今天的日程',
      ...(roleId == null ? {} : { roleId }),
    },
    runsOn: 'local',
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  };
}

function openCopy(roleId?: string) {
  render(<CronJobEditor isOpen job={null} copySource={localAgentJob(roleId)} onClose={() => undefined} />);
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
    copyingJobId: null,
    error: null,
    createJob: vi.fn(),
    updateJob: vi.fn(),
  });
  mockMcpServerStates = [];
});

afterEach(() => {
  cleanup();
  useAppStore.setState({ language: 'zh' });
  vi.clearAllMocks();
});

describe('cloud copy role restriction', () => {
  it.each([
    ['zh', zhReason],
    ['en', enReason],
  ] as const)('%s copy editor shows the reason immediately and disables Save', (language, reason) => {
    useAppStore.setState({ language });
    openCopy('role-muzhi');

    expect(screen.getByTestId('cron-runs-on-cloud').className).toContain('border-badge-info/50');
    expect(screen.getByRole('alert').textContent).toBe(reason);
    expect((screen.getByRole('button', { name: '创建任务' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('leaves a non-role cloud copy unaffected', () => {
    openCopy();

    expect(screen.queryByTestId('cron-cloud-role-restriction')).toBeNull();
    expect((screen.getByRole('button', { name: '创建任务' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('localizes the stable host rejection', async () => {
    const createJob = vi.fn(async () => { throw new Error(`${CLOUD_ROLE_BOUND_ERROR}: test`); });
    useCronStore.setState({ createJob });
    openCopy();

    fireEvent.click(screen.getByRole('button', { name: '创建任务' }));

    expect(await screen.findByText(zhReason)).toBeTruthy();
    expect(screen.queryByText(new RegExp(CLOUD_ROLE_BOUND_ERROR))).toBeNull();
  });
});
