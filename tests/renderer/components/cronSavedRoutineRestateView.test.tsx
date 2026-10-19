// @vitest-environment jsdom
// ============================================================================
// 保存后复述视图的入口测试（N-ROLE-ROUTINE-RESTATE）：
// CronSimpleCreate / CronJobEditor（create + update）保存角色绑定任务后切换到
// 只读「已保存」视图，三行取自保存返回的记录而非表单状态；Done 才关闭；
// 非角色任务照旧立即关闭。
// ============================================================================
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CronJobDefinition } from '../../../src/shared/contract';

const mocks = vi.hoisted(() => ({
  listJobs: vi.fn(),
  createJob: vi.fn(),
  updateJob: vi.fn(),
  listRoles: vi.fn(),
  listProjects: vi.fn(),
}));

// 传输层 mock、store 动作走真实现：createJob/updateJob 成功后是否误关编辑器
// （isEditorOpen）是本单踩过的真集成坑，必须在入口测试里被钉住。
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
vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  return { useI18n: () => ({ t: zh, language: 'zh' }) };
});

import { CronSimpleCreate } from '../../../src/renderer/components/features/cron/CronSimpleCreate';
import { CronJobEditor } from '../../../src/renderer/components/features/cron/CronJobEditor';
import { useCronStore } from '../../../src/renderer/stores/cronStore';

/** 保存返回的角色绑定记录：字段刻意与表单会产生的值不同（行跟记录不跟表单）。 */
function savedRoleJob(overrides: Partial<CronJobDefinition> = {}): CronJobDefinition {
  return {
    id: 'job-saved',
    runsOn: 'local',
    name: '记录里的任务名',
    scheduleType: 'cron',
    schedule: { type: 'cron', expression: '0 9 * * *' },
    action: { type: 'agent', agentType: 'default', prompt: '记录里的目标', roleId: 'role-x' },
    resultChannel: '工作飞书:chat-1',
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function existingRoleJob(): CronJobDefinition {
  return savedRoleJob({
    id: 'job-edit',
    name: '编辑前的旧名字',
    resultChannel: undefined,
  });
}

function rowValue(key: string): string {
  const root = screen.getByTestId('cron-saved-routine-restate');
  return root.querySelector(`[data-saved-routine-value="${key}"]`)?.textContent ?? '';
}

beforeEach(() => {
  mocks.listJobs.mockResolvedValue([]);
  mocks.listRoles.mockResolvedValue([{ roleId: 'role-x', displayName: '小星' }]);
  mocks.listProjects.mockResolvedValue([]);
  // store 动作保持真实现（createJob/updateJob 走上面的传输层 mock），
  // 只复位数据字段；isEditorOpen 由用例显式摆位后断言 store 的开合。
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

describe('CronSimpleCreate 保存后复述', () => {
  it('角色绑定任务保存后：三行跟保存返回的记录（不是表单值），Done 才关闭', async () => {
    mocks.createJob.mockResolvedValue(savedRoleJob());
    const onDone = vi.fn();
    useCronStore.setState({ isEditorOpen: true });
    render(<CronSimpleCreate onDone={onDone} />);

    // 表单里填的是另一套值；createJob 返回的记录与之不同。
    fireEvent.change(screen.getByPlaceholderText('例如：读一遍我关注的竞品动态，整理成简报'), {
      target: { value: '表单里填的目标' },
    });
    fireEvent.click(screen.getByRole('button', { name: '创建自动化' }));

    await waitFor(() => {
      expect(screen.getByTestId('cron-saved-routine-restate')).toBeTruthy();
    });
    expect(onDone).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(rowValue('what')).toBe('由 小星 执行：记录里的目标');
    });
    expect(rowValue('what')).not.toContain('表单里填的目标');
    expect(rowValue('when')).toBe('每天 09:00');
    expect(rowValue('result')).toBe('工作飞书 · 项目群');
    // 真集成钉子：store 不得把编辑器关掉（否则 Modal 连带复述视图卸载）。
    expect(useCronStore.getState().isEditorOpen).toBe(true);

    fireEvent.click(screen.getByTestId('cron-saved-routine-done'));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('非角色任务照旧立即关闭，不出复述视图', async () => {
    mocks.createJob.mockResolvedValue(savedRoleJob({
      action: { type: 'agent', agentType: 'default', prompt: '记录里的目标' },
      resultChannel: undefined,
    }));
    const onDone = vi.fn();
    useCronStore.setState({ isEditorOpen: true });
    render(<CronSimpleCreate onDone={onDone} />);

    fireEvent.change(screen.getByPlaceholderText('例如：读一遍我关注的竞品动态，整理成简报'), {
      target: { value: '普通目标' },
    });
    fireEvent.click(screen.getByRole('button', { name: '创建自动化' }));

    await waitFor(() => {
      expect(onDone).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByTestId('cron-saved-routine-restate')).toBeNull();
    // 非角色任务：store 照旧关掉编辑器。
    await waitFor(() => {
      expect(useCronStore.getState().isEditorOpen).toBe(false);
    });
  });
});

/** 与 CronCenterPanel 同形的最小挂载：job/copySource 从 store 的 jobs 派生。
 * 静态字面量 props 测不出「保存后 refresh() 用 IPC 新对象换掉 prop 身份」的形状
 * （r2 返修根因），必须走真 store 订阅让身份抖动真实传进编辑器。 */
function EditorFromStore() {
  const isEditorOpen = useCronStore((s) => s.isEditorOpen);
  const jobs = useCronStore((s) => s.jobs);
  const editingJobId = useCronStore((s) => s.editingJobId);
  const copyingJobId = useCronStore((s) => s.copyingJobId);
  const closeEditor = useCronStore((s) => s.closeEditor);
  const editingJob = React.useMemo(
    () => jobs.find((j) => j.id === editingJobId) || null,
    [jobs, editingJobId],
  );
  const copyingJob = React.useMemo(
    () => jobs.find((j) => j.id === copyingJobId) || null,
    [jobs, copyingJobId],
  );
  return (
    <CronJobEditor
      isOpen={isEditorOpen}
      job={editingJob}
      copySource={copyingJob}
      onClose={closeEditor}
    />
  );
}

describe('CronJobEditor 保存后复述', () => {
  it('update 路径：保存角色绑定任务后切换复述视图，行跟 updateJob 返回的记录', async () => {
    mocks.updateJob.mockResolvedValue(savedRoleJob({ id: 'job-edit' }));
    const onClose = vi.fn();
    useCronStore.setState({ isEditorOpen: true });
    render(<CronJobEditor isOpen job={existingRoleJob()} onClose={onClose} />);

    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));

    await waitFor(() => {
      expect(screen.getByTestId('cron-saved-routine-restate')).toBeTruthy();
    });
    expect(onClose).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(rowValue('what')).toBe('由 小星 执行：记录里的目标');
    });
    expect(rowValue('when')).toBe('每天 09:00');
    expect(rowValue('result')).toBe('工作飞书 · 项目群');
    expect(useCronStore.getState().isEditorOpen).toBe(true);

    fireEvent.click(screen.getByTestId('cron-saved-routine-done'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('create 路径（复制角色绑定任务）：createJob 返回角色绑定时切换复述视图', async () => {
    mocks.createJob.mockResolvedValue(savedRoleJob());
    const onClose = vi.fn();
    useCronStore.setState({ isEditorOpen: true });
    render(<CronJobEditor isOpen job={null} copySource={existingRoleJob()} onClose={onClose} />);

    fireEvent.click(screen.getByRole('button', { name: '创建任务' }));

    await waitFor(() => {
      expect(screen.getByTestId('cron-saved-routine-restate')).toBeTruthy();
    });
    expect(onClose).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(rowValue('what')).toBe('由 小星 执行：记录里的目标');
    });

    fireEvent.click(screen.getByTestId('cron-saved-routine-done'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('非角色任务的 update 照旧立即关闭', async () => {
    mocks.updateJob.mockResolvedValue(savedRoleJob({
      id: 'job-edit',
      action: { type: 'agent', agentType: 'default', prompt: '记录里的目标' },
    }));
    const onClose = vi.fn();
    useCronStore.setState({ isEditorOpen: true });
    render(
      <CronJobEditor
        isOpen
        job={savedRoleJob({
          id: 'job-edit',
          name: '无角色任务',
          action: { type: 'agent', agentType: 'default', prompt: '无角色 prompt' },
        })}
        onClose={onClose}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));

    await waitFor(() => {
      expect(onClose).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByTestId('cron-saved-routine-restate')).toBeNull();
    await waitFor(() => {
      expect(useCronStore.getState().isEditorOpen).toBe(false);
    });
  });
});

describe('CronJobEditor 保存后复述 · refresh 换 prop 身份（r2 回归）', () => {
  it('update 路径：保存后 jobs 被新对象替换（prop 换身份），复述视图不被重置', async () => {
    // listJobs 每次调用都返回全新对象（模拟 IPC 往返），每次 refresh prop 身份必换。
    const updatedFromServer = () => savedRoleJob({ id: 'job-edit', name: '更新后的任务名' });
    mocks.updateJob.mockImplementation(async () => updatedFromServer());
    mocks.listJobs.mockImplementation(async () => [updatedFromServer()]);
    const initialJob = existingRoleJob();
    useCronStore.setState({ jobs: [initialJob], isEditorOpen: true, editingJobId: 'job-edit' });
    render(<EditorFromStore />);

    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));

    await waitFor(() => {
      expect(screen.getByTestId('cron-saved-routine-restate')).toBeTruthy();
    });
    await waitFor(() => {
      expect(rowValue('what')).toBe('由 小星 执行：记录里的目标');
    });

    // 复述视图在场时再触发一次 store refresh（编辑器开着时面板级刷新/挂载刷新
    // 都会换掉 jobs 身份）：reset effect 因 job prop 换身份重跑，旧实现无条件
    // setSavedJob(null) 会把视图重置回编辑表单——此处即 r2 红点。
    const jobWhileViewShown = useCronStore.getState().jobs[0];
    await act(async () => {
      await useCronStore.getState().refresh();
    });
    expect(useCronStore.getState().jobs[0]).not.toBe(jobWhileViewShown);
    await act(async () => {});
    expect(screen.getByTestId('cron-saved-routine-restate')).toBeTruthy();
    expect(rowValue('what')).toBe('由 小星 执行：记录里的目标');
    expect(useCronStore.getState().isEditorOpen).toBe(true);

    fireEvent.click(screen.getByTestId('cron-saved-routine-done'));
    await waitFor(() => {
      expect(useCronStore.getState().isEditorOpen).toBe(false);
    });
  });

  it('copy 路径：保存后 jobs 被新对象替换（copySource 换身份），复述视图不被重置', async () => {
    const createdFromServer = () => savedRoleJob();
    mocks.createJob.mockImplementation(async () => createdFromServer());
    mocks.listJobs.mockImplementation(async () => [existingRoleJob(), createdFromServer()]);
    const initialSource = existingRoleJob();
    useCronStore.setState({ jobs: [initialSource], isEditorOpen: true, copyingJobId: 'job-edit' });
    render(<EditorFromStore />);

    fireEvent.click(screen.getByRole('button', { name: '创建任务' }));

    await waitFor(() => {
      expect(screen.getByTestId('cron-saved-routine-restate')).toBeTruthy();
    });
    await waitFor(() => {
      expect(rowValue('what')).toBe('由 小星 执行：记录里的目标');
    });

    const sourceWhileViewShown = useCronStore.getState().jobs[0];
    await act(async () => {
      await useCronStore.getState().refresh();
    });
    expect(useCronStore.getState().jobs[0]).not.toBe(sourceWhileViewShown);
    await act(async () => {});
    expect(screen.getByTestId('cron-saved-routine-restate')).toBeTruthy();
    expect(rowValue('what')).toBe('由 小星 执行：记录里的目标');

    fireEvent.click(screen.getByTestId('cron-saved-routine-done'));
    await waitFor(() => {
      expect(useCronStore.getState().isEditorOpen).toBe(false);
    });
  });
});
