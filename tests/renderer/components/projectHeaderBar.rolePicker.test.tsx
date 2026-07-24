// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const showToast = vi.hoisted(() => vi.fn());
const projectClient = vi.hoisted(() => ({
  addProjectGoal: vi.fn(),
  addProjectRole: vi.fn(),
  getProjectArtifacts: vi.fn(),
  getProjectDetail: vi.fn(),
  getProjectSourceGitStates: vi.fn(),
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
  goals: [],
  roles: [],
  sessionIds: ['session-1'],
};

async function renderHeaderAndOpenPicker() {
  render(<ProjectHeaderBar />);
  await screen.findByText('原项目');
  fireEvent.click(screen.getByTitle('展开项目信息'));
  fireEvent.click(await screen.findByTitle('角色入驻'));
}

// C-3：picker 行此前只渲染 roleId，角色描述（RolePanelEntry.description，roles.ipc.ts 已在
// payload 里）没露出。这里只钉「有描述就渲染，没描述不留空行」两个方向，不测整套 picker 交互
// （那部分 projectHeaderBar.errorHandling.test.tsx 已覆盖）。
describe('ProjectHeaderBar 角色 picker 行渲染 description', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    projectClient.getProjectDetail.mockResolvedValue(detail);
    projectClient.getProjectArtifacts.mockResolvedValue([]);
    projectClient.getProjectSourceGitStates.mockResolvedValue([]);
  });

  afterEach(cleanup);

  it('角色有 description 时渲染为副标题', async () => {
    invokeDomain.mockResolvedValue([{ roleId: 'reviewer', description: '代码审查专员', icon: 'user' }]);
    await renderHeaderAndOpenPicker();

    await screen.findByText('reviewer');
    expect(screen.getByText('代码审查专员')).toBeTruthy();
  });

  it('角色无 description（空字符串）时不渲染空副标题行', async () => {
    invokeDomain.mockResolvedValue([{ roleId: 'orphaned-role', description: '', icon: 'user' }]);
    await renderHeaderAndOpenPicker();

    const roleButton = (await screen.findByText('orphaned-role')).closest('button');
    expect(roleButton).toBeTruthy();
    // 结构性断言，不走 textContent——空 description 的 <span></span> 也会让
    // textContent 拼接结果等于 'orphaned-role'，测不出「多渲染了一个空节点」。
    // 副标题节点专属的 text-zinc-500 class 不该存在，而不是「存在但是空」。
    expect(roleButton!.querySelector('.text-zinc-500')).toBeNull();
  });
});
