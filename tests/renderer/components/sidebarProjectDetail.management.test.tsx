// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_DOMAINS } from '../../../src/shared/ipc';

const projectClient = vi.hoisted(() => ({
  addProjectGoal: vi.fn(),
  addProjectRole: vi.fn(),
  removeProjectRole: vi.fn(),
  renameProject: vi.fn(),
  setProjectStatus: vi.fn(),
}));
const invokeDomain = vi.hoisted(() => vi.fn());

vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  return { useI18n: () => ({ t: zh, language: 'zh' }) };
});
vi.mock('../../../src/renderer/services/projectClient', () => projectClient);
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invokeDomain },
}));

const { SidebarProjectDetail } = await import(
  '../../../src/renderer/components/features/sidebar/SidebarProjectDetail'
);

const meta = {
  name: '原项目',
  status: 'active' as const,
  goalCount: 0,
  goals: [],
  roleCount: 1,
  roleIds: ['writer'],
  artifactCount: 0,
  recentArtifacts: [],
  sessionCount: 2,
};

function renderDetail() {
  render(
    <SidebarProjectDetail
      projectId="project-1"
      meta={meta}
      fallbackSessionCount={2}
      onMetaChange={vi.fn()}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  projectClient.renameProject.mockResolvedValue({ id: 'project-1', name: '新项目', status: 'active' });
  projectClient.setProjectStatus.mockResolvedValue({ id: 'project-1', name: '原项目', status: 'archived' });
  projectClient.addProjectGoal.mockResolvedValue({
    id: 'goal-1',
    projectId: 'project-1',
    goal: '补齐验收',
    status: 'active',
    createdAt: 1,
    updatedAt: 1,
  });
  projectClient.addProjectRole.mockResolvedValue({
    projectId: 'project-1',
    roleId: 'reviewer',
    joinedAt: 1,
  });
  projectClient.removeProjectRole.mockResolvedValue(undefined);
  invokeDomain.mockResolvedValue([
    { roleId: 'writer', description: '写作', icon: 'user' },
    { roleId: 'reviewer', description: '审查', icon: 'user' },
  ]);
});

afterEach(cleanup);

describe('SidebarProjectDetail project management', () => {
  it('renames the project through projectClient', async () => {
    renderDetail();

    fireEvent.click(screen.getByRole('button', { name: '修改项目名称' }));
    const input = screen.getByRole('textbox', { name: '修改项目名称' });
    fireEvent.change(input, { target: { value: '新项目' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(projectClient.renameProject).toHaveBeenCalledWith(
      'project-1',
      '新项目',
    ));
  });

  it('adds a goal through projectClient', async () => {
    renderDetail();

    fireEvent.click(screen.getByRole('button', { name: '新增目标' }));
    fireEvent.change(screen.getByPlaceholderText('输入项目目标'), {
      target: { value: '补齐验收' },
    });
    fireEvent.click(screen.getByRole('button', { name: '添加' }));

    await waitFor(() => expect(projectClient.addProjectGoal).toHaveBeenCalledWith(
      'project-1',
      '补齐验收',
    ));
  });

  it('loads the role picker and adds the selected role through projectClient', async () => {
    renderDetail();

    fireEvent.click(screen.getByRole('button', { name: '新增角色' }));

    await waitFor(() => expect(invokeDomain).toHaveBeenCalledWith(IPC_DOMAINS.ROLES, 'list'));
    fireEvent.click(await screen.findByRole('button', { name: /reviewer/ }));

    await waitFor(() => expect(projectClient.addProjectRole).toHaveBeenCalledWith(
      'project-1',
      'reviewer',
    ));
  });

  it('archives the project through projectClient', async () => {
    renderDetail();

    fireEvent.click(screen.getByRole('button', { name: '归档项目' }));

    await waitFor(() => expect(projectClient.setProjectStatus).toHaveBeenCalledWith(
      'project-1',
      'archived',
    ));
  });

  it('removes a joined role through projectClient', async () => {
    renderDetail();

    fireEvent.click(screen.getByRole('button', { name: '移除角色 writer' }));

    await waitFor(() => expect(projectClient.removeProjectRole).toHaveBeenCalledWith(
      'project-1',
      'writer',
    ));
  });
});
