// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const showToast = vi.hoisted(() => vi.fn());
const projectClient = vi.hoisted(() => ({
  addProjectGoal: vi.fn(),
  addProjectRole: vi.fn(),
  getProjectArtifacts: vi.fn(),
  getProjectDetail: vi.fn(),
  removeProjectRole: vi.fn(),
  renameProject: vi.fn(),
  setProjectStatus: vi.fn(),
  updateProjectGoalStatus: vi.fn(),
}));
const invokeDomain = vi.hoisted(() => vi.fn());

vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: (selector: (state: unknown) => unknown) =>
    selector({ currentSessionId: 'session-1', sessions: [{ id: 'session-1', projectId: 'project-1' }] }),
}));
vi.mock('../../../src/renderer/stores/uiStore', () => ({
  useUIStore: (selector: (state: { showToast: typeof showToast }) => unknown) => selector({ showToast }),
}));
vi.mock('../../../src/renderer/services/projectClient', () => projectClient);
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invokeDomain },
}));
vi.mock('../../../src/renderer/utils/logger', () => ({
  createLogger: () => ({ warn: vi.fn() }),
}));

import { ProjectHeaderBar } from '../../../src/renderer/components/ProjectHeaderBar';

const detail = {
  project: { id: 'project-1', name: '原项目', status: 'active' },
  goals: [{ id: 'goal-1', projectId: 'project-1', goal: '原目标', status: 'active' }],
  roles: [{ roleId: 'writer' }],
  sessionIds: ['session-1'],
};

async function renderHeader() {
  render(<ProjectHeaderBar />);
  await screen.findByText('原项目');
}

async function expandHeader() {
  fireEvent.click(screen.getByTitle('展开项目信息'));
  await screen.findByText('原目标');
}

describe('ProjectHeaderBar write failure feedback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    projectClient.getProjectDetail.mockResolvedValue(detail);
    projectClient.getProjectArtifacts.mockResolvedValue([]);
    invokeDomain.mockResolvedValue([{ roleId: 'reviewer', icon: 'user' }]);
  });

  afterEach(cleanup);

  it('改名失败时提示错误，并保留编辑状态和用户草稿', async () => {
    projectClient.renameProject.mockRejectedValueOnce(new Error('disk full'));
    await renderHeader();

    fireEvent.click(screen.getByTitle('点击改名'));
    const input = screen.getByDisplayValue('原项目');
    fireEvent.change(input, { target: { value: '新项目名' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(showToast).toHaveBeenCalledWith('error', '项目改名失败，请重试'));
    expect(screen.getByDisplayValue('新项目名')).toBeTruthy();
  });

  it('归档失败时提示错误', async () => {
    projectClient.setProjectStatus.mockRejectedValueOnce(new Error('offline'));
    await renderHeader();

    fireEvent.click(screen.getByTitle('归档项目'));

    await waitFor(() => expect(showToast).toHaveBeenCalledWith('error', '项目归档失败，请重试'));
  });

  it('新增目标失败时提示错误', async () => {
    projectClient.addProjectGoal.mockRejectedValueOnce(new Error('offline'));
    await renderHeader();
    await expandHeader();

    fireEvent.click(screen.getByTitle('新增目标'));
    const input = screen.getByPlaceholderText('输入目标后回车');
    fireEvent.change(input, { target: { value: '新增目标' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(showToast).toHaveBeenCalledWith('error', '新增项目目标失败，请重试'));
  });

  it('更新目标状态失败时提示错误', async () => {
    projectClient.updateProjectGoalStatus.mockRejectedValueOnce(new Error('offline'));
    await renderHeader();
    await expandHeader();

    fireEvent.click(screen.getByTitle('标记为已达成'));

    await waitFor(() => expect(showToast).toHaveBeenCalledWith('error', '更新项目目标失败，请重试'));
  });

  it('角色入驻失败时提示错误', async () => {
    projectClient.addProjectRole.mockRejectedValueOnce(new Error('offline'));
    await renderHeader();
    await expandHeader();

    fireEvent.click(screen.getByTitle('角色入驻'));
    fireEvent.click(await screen.findByText('reviewer'));

    await waitFor(() => expect(showToast).toHaveBeenCalledWith('error', '角色入驻失败，请重试'));
  });

  it('角色退出失败时提示错误', async () => {
    projectClient.removeProjectRole.mockRejectedValueOnce(new Error('offline'));
    await renderHeader();
    await expandHeader();

    fireEvent.click(screen.getByTitle('退出'));

    await waitFor(() => expect(showToast).toHaveBeenCalledWith('error', '角色退出失败，请重试'));
  });
});
