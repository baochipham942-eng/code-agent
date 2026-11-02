// @vitest-environment jsdom
// ============================================================================
// 保存前确认卡的入口测试（N-CRON-MORNING-TRIAGE-REST1）：
// 无角色任务在 CronSimpleCreate / CronJobEditor（手动表单 create + edit + 复制 +
// 模板填参）提交后先出四行复述卡——createJob/updateJob 只在「确认保存」后调用
// 一次；「返回修改」回到原表单且表单值不丢。角色绑定任务照旧直存（不出这张卡，
// 保存后出 SavedRoutineRestate）。
// ============================================================================
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CronJobDefinition } from '../../../src/shared/contract';

const mocks = vi.hoisted(() => ({
  listJobs: vi.fn(),
  createJob: vi.fn(),
  updateJob: vi.fn(),
  listRoles: vi.fn(),
  listProjects: vi.fn(),
}));

vi.mock('../../../src/renderer/services/cronClient', () => {
  const transport = {
    listJobs: mocks.listJobs,
    createJob: mocks.createJob,
    updateJob: mocks.updateJob,
    deleteJob: vi.fn().mockResolvedValue(true),
    triggerJob: vi.fn().mockResolvedValue(null),
    getExecutions: vi.fn().mockResolvedValue([]),
    getRecentExecutions: vi.fn().mockResolvedValue([]),
    getStats: vi.fn().mockResolvedValue(null),
    generateFromPrompt: vi.fn(),
    getGroupListenCheck: vi.fn(),
    startGroupListenCheck: vi.fn(),
    grantLoginPassThrough: vi.fn(),
  };
  return { cronClient: transport, default: transport };
});
vi.mock('../../../src/renderer/services/rolesClient', () => ({
  listRoles: mocks.listRoles,
}));
vi.mock('../../../src/renderer/services/projectClient', () => ({
  listProjects: mocks.listProjects,
}));
vi.mock('../../../src/renderer/hooks/useMcpServerStates', () => ({
  useMcpServerStates: () => [],
}));
vi.mock('../../../src/renderer/components/features/cron/useChannelCatalog', () => ({
  useChannelCatalog: () => ({
    accounts: [{ id: 'acc-1', type: 'feishu', name: '工作飞书' }],
    accountsLoading: false,
    conversationsByAccount: {
      'acc-1': { supported: true, conversations: [{ id: 'chat-1', name: '项目群' }], loading: false },
    },
  }),
  useEventScheduleNames: () => () => ({}),
}));

import { CronSimpleCreate } from '../../../src/renderer/components/features/cron/CronSimpleCreate';
import { CronJobEditor } from '../../../src/renderer/components/features/cron/CronJobEditor';
import { useCronStore } from '../../../src/renderer/stores/cronStore';

/** 无角色任务（createJob 的返回）：简易创建/手动表单的缺省产物。 */
function savedRoleLessJob(overrides: Partial<CronJobDefinition> = {}): CronJobDefinition {
  return {
    id: 'job-saved',
    runsOn: 'local',
    name: '盯竞品',
    scheduleType: 'cron',
    schedule: { type: 'cron', expression: '0 9 * * *' },
    action: { type: 'agent', agentType: 'default', prompt: '盯竞品并汇总' },
    resultChannel: undefined,
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function pendingCard(): HTMLElement {
  return screen.getByTestId('cron-pending-routine-restate');
}

function pendingRowValue(key: string): string {
  return pendingCard().querySelector(`[data-pending-routine-value="${key}"]`)?.textContent ?? '';
}

beforeEach(() => {
  mocks.listJobs.mockResolvedValue([]);
  mocks.listRoles.mockResolvedValue([]);
  mocks.listProjects.mockResolvedValue([]);
  useCronStore.setState({
    jobs: [],
    stats: null,
    latestExecutions: {},
    executionsByJobId: {},
    recentExecutions: [],
    selectedJobId: null,
    filterMode: 'all',
    searchQuery: '',
    isLoading: false,
    isEditorOpen: false,
    editingJobId: null,
    copyingJobId: null,
    error: null,
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('CronSimpleCreate · 无角色任务先复述后保存', () => {
  it('提交后出四行复述卡（含兜底通知句），createJob 不被调用', async () => {
    const onDone = vi.fn();
    render(<CronSimpleCreate onDone={onDone} />);

    fireEvent.change(screen.getByPlaceholderText(/竞品动态/), { target: { value: '每天盯一下竞品发布' } });
    fireEvent.click(screen.getByRole('button', { name: '创建自动化' }));

    await waitFor(() => expect(pendingCard()).toBeTruthy());
    expect(mocks.createJob).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
    // 四行：what 跟 goal（复述语义源），when 是人话时间，notifyWhen 走兜底句，result 落审核收件箱。
    expect(pendingRowValue('what')).toBe('每天盯一下竞品发布');
    expect(pendingRowValue('when')).toBe('每天 09:00');
    expect(pendingRowValue('when')).not.toContain('*');
    expect(pendingRowValue('notifyWhen')).toBe('任务完成或发现异常时通知');
    expect(pendingRowValue('result')).toBe('自动化审核收件箱');
  });

  it('「确认保存」后 createJob 恰好一次，随后关闭（onDone）', async () => {
    mocks.createJob.mockResolvedValue(savedRoleLessJob());
    const onDone = vi.fn();
    render(<CronSimpleCreate onDone={onDone} />);

    fireEvent.change(screen.getByPlaceholderText(/竞品动态/), { target: { value: '每天盯一下竞品发布' } });
    fireEvent.click(screen.getByRole('button', { name: '创建自动化' }));
    await waitFor(() => expect(pendingCard()).toBeTruthy());

    fireEvent.click(screen.getByTestId('cron-pending-routine-confirm'));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(mocks.createJob).toHaveBeenCalledTimes(1);
    expect((mocks.createJob.mock.calls[0] as unknown[])[0]).toMatchObject({
      action: { type: 'agent', prompt: '每天盯一下竞品发布' },
      schedule: { type: 'cron', expression: '0 9 * * *' },
    });
  });

  it('「返回修改」回到表单且表单值原样，createJob 仍为零；可改完再提交', async () => {
    mocks.createJob.mockResolvedValue(savedRoleLessJob());
    const onDone = vi.fn();
    render(<CronSimpleCreate onDone={onDone} />);

    const goalBox = screen.getByPlaceholderText(/竞品动态/) as HTMLTextAreaElement;
    fireEvent.change(goalBox, { target: { value: '每天盯一下竞品发布' } });
    fireEvent.click(screen.getByRole('button', { name: '创建自动化' }));
    await waitFor(() => expect(pendingCard()).toBeTruthy());

    fireEvent.click(screen.getByTestId('cron-pending-routine-back'));
    await waitFor(() => expect(screen.queryByTestId('cron-pending-routine-restate')).toBeNull());
    expect(mocks.createJob).not.toHaveBeenCalled();
    // 表单状态没被重置：目标还在，时间还是 09:00。
    expect((screen.getByPlaceholderText(/竞品动态/) as HTMLTextAreaElement).value).toBe('每天盯一下竞品发布');
    expect((screen.getByDisplayValue('09:00') as HTMLInputElement).value).toBe('09:00');

    // 改完目标再提交：卡上的 what 跟新值走。
    fireEvent.change(screen.getByPlaceholderText(/竞品动态/), { target: { value: '改成盯新版本发布' } });
    fireEvent.click(screen.getByRole('button', { name: '创建自动化' }));
    await waitFor(() => expect(pendingCard()).toBeTruthy());
    expect(pendingRowValue('what')).toBe('改成盯新版本发布');
    fireEvent.click(screen.getByTestId('cron-pending-routine-confirm'));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(mocks.createJob).toHaveBeenCalledTimes(1);
  });

  it('结果通道设置了：result 行是解析标签（账号 · 会话），不透出原始串', async () => {
    render(<CronSimpleCreate onDone={() => undefined} />);
    fireEvent.change(screen.getByPlaceholderText(/竞品动态/), { target: { value: '盯竞品' } });
    fireEvent.click(screen.getByRole('button', { name: '创建自动化' }));
    await waitFor(() => expect(pendingCard()).toBeTruthy());
    // 本用例没在表单里选结果通道（目录 mock 在，字段默认空）：result = 审核收件箱。
    // 原始串不透出的断言在 builder 级测试（resolveSavedRoutineChannelLabel）覆盖。
    expect(pendingRowValue('result')).toBe('自动化审核收件箱');
  });

  it('确认时 createJob 抛错：错误横幅在卡上，不关闭；返回修改后错误仍可见、可重试', async () => {
    mocks.createJob.mockRejectedValueOnce(new Error('Cloud jobs must have an interval of at least 15 minutes'));
    const onDone = vi.fn();
    render(<CronSimpleCreate onDone={onDone} />);

    fireEvent.change(screen.getByPlaceholderText(/竞品动态/), { target: { value: '盯竞品' } });
    fireEvent.click(screen.getByRole('button', { name: '创建自动化' }));
    await waitFor(() => expect(pendingCard()).toBeTruthy());
    fireEvent.click(screen.getByTestId('cron-pending-routine-confirm'));

    await waitFor(() => expect(screen.getByText('云端任务最小间隔 1 小时')).toBeTruthy());
    expect(pendingCard()).toBeTruthy();
    expect(onDone).not.toHaveBeenCalled();
    // 返回修改：错误进表单错误框（卡还在场时横幅同句可见）。
    fireEvent.click(screen.getByTestId('cron-pending-routine-back'));
    await waitFor(() => expect(screen.queryByTestId('cron-pending-routine-restate')).toBeNull());
    expect(screen.getByText('云端任务最小间隔 1 小时')).toBeTruthy();
  });

  it('选了角色（角色绑定）不出这张卡：照旧直存 → 保存后复述视图', async () => {
    mocks.listRoles.mockResolvedValue([{ roleId: 'role-x', displayName: '小星' }]);
    mocks.createJob.mockResolvedValue(savedRoleLessJob({
      action: { type: 'agent', agentType: 'default', prompt: '盯竞品并汇总', roleId: 'role-x' },
    }));
    const onDone = vi.fn();
    render(<CronSimpleCreate onDone={onDone} />);

    fireEvent.change(screen.getByPlaceholderText(/竞品动态/), { target: { value: '盯竞品' } });
    // 角色下拉（FormField 未挂 htmlFor）：从「小星」option 反查所属 select。
    const roleOption = await screen.findByRole('option', { name: '小星' });
    const roleSelect = roleOption.closest('select') as HTMLSelectElement;
    fireEvent.change(roleSelect, { target: { value: 'role-x' } });
    fireEvent.click(screen.getByRole('button', { name: '创建自动化' }));

    await waitFor(() => expect(screen.getByTestId('cron-saved-routine-restate')).toBeTruthy());
    expect(screen.queryByTestId('cron-pending-routine-restate')).toBeNull();
    expect(mocks.createJob).toHaveBeenCalledTimes(1);
    expect(onDone).not.toHaveBeenCalled();
  });
});

describe('CronJobEditor · 无角色任务先复述后保存', () => {
  it('编辑路径（updateJob）：保存前出卡，紧急判据进 notifyWhen 行；确认后 updateJob 一次', async () => {
    mocks.updateJob.mockResolvedValue(savedRoleLessJob({ id: 'job-edit' }));
    const onClose = vi.fn();
    const job = savedRoleLessJob({
      id: 'job-edit',
      action: { type: 'agent', agentType: 'default', prompt: '盯竞品并汇总', urgencyCriteria: '只有老板的邮件算必办' },
    });
    render(<CronJobEditor isOpen job={job} onClose={onClose} />);

    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));

    await waitFor(() => expect(pendingCard()).toBeTruthy());
    expect(mocks.updateJob).not.toHaveBeenCalled();
    expect(pendingRowValue('notifyWhen')).toBe('只有老板的邮件算必办');

    fireEvent.click(screen.getByTestId('cron-pending-routine-confirm'));
    await waitFor(() => expect(mocks.updateJob).toHaveBeenCalledTimes(1));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mocks.updateJob.mock.calls[0]).toEqual(['job-edit', expect.objectContaining({
      action: expect.objectContaining({ urgencyCriteria: '只有老板的邮件算必办' }),
    })]);
  });

  it('编辑路径「返回修改」：表单值原样（含紧急判据），updateJob 为零', async () => {
    const onClose = vi.fn();
    const job = savedRoleLessJob({
      id: 'job-edit',
      name: '编辑中的名字',
      action: { type: 'agent', agentType: 'default', prompt: '盯竞品并汇总', urgencyCriteria: '判据原文' },
    });
    render(<CronJobEditor isOpen job={job} onClose={onClose} />);

    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));
    await waitFor(() => expect(pendingCard()).toBeTruthy());
    fireEvent.click(screen.getByTestId('cron-pending-routine-back'));

    await waitFor(() => expect(screen.queryByTestId('cron-pending-routine-restate')).toBeNull());
    expect(mocks.updateJob).not.toHaveBeenCalled();
    expect((screen.getByDisplayValue('编辑中的名字') as HTMLInputElement).value).toBe('编辑中的名字');
    fireEvent.click(screen.getByText('执行动作'));
    expect((screen.getByTestId('cron-agent-urgency-criteria') as HTMLInputElement).value).toBe('判据原文');
  });

  it('复制路径（createJob）：出卡；确认后 createJob 一次并关闭', async () => {
    mocks.createJob.mockResolvedValue(savedRoleLessJob());
    const onClose = vi.fn();
    render(<CronJobEditor isOpen job={null} copySource={savedRoleLessJob({ id: 'job-origin' })} onClose={onClose} />);

    fireEvent.click(screen.getByRole('button', { name: '创建任务' }));

    await waitFor(() => expect(pendingCard()).toBeTruthy());
    expect(mocks.createJob).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('cron-pending-routine-confirm'));
    await waitFor(() => expect(mocks.createJob).toHaveBeenCalledTimes(1));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('模板填参路径（无角色档）：出卡；确认后 createJob 一次并关闭', async () => {
    mocks.createJob.mockImplementation(async (input: unknown) => ({
      ...(input as object),
      id: 'job-tpl',
      createdAt: 1,
      updatedAt: 1,
    } as CronJobDefinition));
    mocks.listRoles.mockResolvedValue([]);
    const onClose = vi.fn();
    render(<CronJobEditor isOpen job={null} onClose={onClose} />);

    // 晨间分诊模板：唯一字段是可选角色，缺省不选 = 无角色任务；prompt 是模板内置的。
    fireEvent.click(screen.getByText('从模板创建'));
    fireEvent.click(await screen.findByText('晨间分诊'));
    await waitFor(() => expect(screen.getByTestId('cron-template-role-select')).toBeTruthy());
    fireEvent.click(screen.getByText('创建任务'));

    await waitFor(() => expect(pendingCard()).toBeTruthy());
    expect(mocks.createJob).not.toHaveBeenCalled();
    expect(pendingRowValue('what')).toContain('未读邮件');
    expect(pendingRowValue('when')).toBe('工作日 08:30');

    fireEvent.click(screen.getByTestId('cron-pending-routine-confirm'));
    await waitFor(() => expect(mocks.createJob).toHaveBeenCalledTimes(1));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('角色绑定编辑照旧直存：不出确认卡，保存后出 SavedRoutineRestate', async () => {
    mocks.listRoles.mockResolvedValue([{ roleId: 'role-x', displayName: '小星' }]);
    mocks.updateJob.mockResolvedValue(savedRoleLessJob({
      id: 'job-edit',
      action: { type: 'agent', agentType: 'default', prompt: '盯竞品并汇总', roleId: 'role-x' },
    }));
    const onClose = vi.fn();
    render(
      <CronJobEditor
        isOpen
        job={savedRoleLessJob({
          id: 'job-edit',
          action: { type: 'agent', agentType: 'default', prompt: '盯竞品并汇总', roleId: 'role-x' },
        })}
        onClose={onClose}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));

    await waitFor(() => expect(screen.getByTestId('cron-saved-routine-restate')).toBeTruthy());
    expect(screen.queryByTestId('cron-pending-routine-restate')).toBeNull();
    expect(mocks.updateJob).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });
});
