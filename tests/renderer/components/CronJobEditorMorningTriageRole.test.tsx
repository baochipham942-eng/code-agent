// @vitest-environment jsdom
// 晨间分诊填参：可选角色下拉。选了角色则创建的任务绑定该角色，并切到现有的保存后复述卡。
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CronJobDefinition } from '../../../src/shared/contract/cron';
import type { RolePanelEntry } from '../../../src/shared/contract/roleAssets';
import { cronCenterZh } from '../../../src/renderer/i18n/cronCenter';

const cronStore = vi.hoisted(() => ({
  createJob: vi.fn(),
  updateJob: vi.fn(),
}));

const listRoles = vi.hoisted(() => vi.fn());

vi.mock('../../../src/renderer/stores/cronStore', () => ({
  useCronStore: () => cronStore,
}));
vi.mock('../../../src/renderer/services/rolesClient', () => ({
  listRoles: () => listRoles(),
}));
vi.mock('../../../src/renderer/hooks/useMcpServerStates', () => ({
  useMcpServerStates: () => [],
}));
vi.mock('../../../src/renderer/components/features/cron/useChannelCatalog', () => ({
  useChannelCatalog: () => ({ accounts: [], accountsLoading: false, conversationsByAccount: {} }),
  useEventScheduleNames: () => () => ({}),
}));

import { CronJobEditor } from '../../../src/renderer/components/features/cron/CronJobEditor';

const assistant: RolePanelEntry = {
  roleId: 'assistant-lin',
  displayName: '助理小林',
  description: '',
  source: 'user',
  memoryCount: 2,
  lastWork: null,
};

function savedFrom(input: CronJobDefinition): CronJobDefinition {
  return {
    ...input,
    id: 'job-morning',
    createdAt: 1,
    updatedAt: 1,
  };
}

describe('morning-triage template role field', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listRoles.mockResolvedValue([assistant]);
    cronStore.createJob.mockImplementation(async (input: CronJobDefinition) => savedFrom(input));
  });

  afterEach(() => {
    cleanup();
  });

  it('shows a role select with an empty none option and binds the saved job to the chosen role', async () => {
    const onClose = vi.fn();
    render(<CronJobEditor isOpen job={null} onClose={onClose} />);
    fireEvent.click(screen.getByText(cronCenterZh.cronCenter.fromTemplate));
    fireEvent.click(await screen.findByText('晨间分诊'));

    const select = await screen.findByTestId('cron-template-role-select') as HTMLSelectElement;
    expect(screen.getByText(cronCenterZh.cronCenter.templateRoleLabel)).toBeTruthy();
    await waitFor(() => expect(screen.getByRole('option', { name: '助理小林' })).toBeTruthy());
    const none = screen.getByRole('option', { name: cronCenterZh.cronCenter.templateRoleNone }) as HTMLOptionElement;
    expect(none.value).toBe('');
    expect(select.value).toBe('');

    fireEvent.change(select, { target: { value: 'assistant-lin' } });
    fireEvent.click(screen.getByText('创建任务'));

    await waitFor(() => expect(cronStore.createJob).toHaveBeenCalledTimes(1));
    const payload = cronStore.createJob.mock.calls[0]?.[0] as CronJobDefinition;
    expect(payload.action).toMatchObject({
      type: 'agent',
      roleId: 'assistant-lin',
    });
    expect(payload.action.type === 'agent' ? payload.action.prompt : '').toContain('草稿（未发送）');
    expect(await screen.findByTestId('cron-saved-routine-restate')).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('leaves the job unbound and the prompt unchanged when none is chosen', async () => {
    const onClose = vi.fn();
    render(<CronJobEditor isOpen job={null} onClose={onClose} />);
    fireEvent.click(screen.getByText(cronCenterZh.cronCenter.fromTemplate));
    fireEvent.click(await screen.findByText('晨间分诊'));
    await screen.findByTestId('cron-template-role-select');

    fireEvent.click(screen.getByText('创建任务'));

    await waitFor(() => expect(cronStore.createJob).toHaveBeenCalledTimes(1));
    const payload = cronStore.createJob.mock.calls[0]?.[0] as CronJobDefinition;
    expect(payload.action.type === 'agent' ? payload.action.roleId : 'present').toBeUndefined();
    expect(payload.action.type === 'agent' ? payload.action.prompt : '').not.toContain('草稿（未发送）');
    expect(payload.action.type === 'agent' ? payload.action.prompt : '').toContain('「未读取：<来源>」');
    expect(screen.queryByTestId('cron-saved-routine-restate')).toBeNull();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
