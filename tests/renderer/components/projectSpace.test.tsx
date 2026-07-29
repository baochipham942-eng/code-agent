// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

// ---- 服务层 mock（IPC 一律不进测试） ----
vi.mock('../../../src/renderer/services/projectClient', () => ({
  listProjectsWithActivity: vi.fn(),
  getProjectDetail: vi.fn(),
  getProjectArtifacts: vi.fn(),
  addProjectRole: vi.fn(),
  removeProjectRole: vi.fn(),
  listCapabilitySelections: vi.fn(),
  selectCapability: vi.fn(),
  unselectCapability: vi.fn(),
}));
vi.mock('../../../src/renderer/services/tagClient', () => ({
  tagClient: { listByProject: vi.fn() },
}));
vi.mock('../../../src/renderer/services/rolesClient', () => ({
  listRoles: vi.fn(),
}));
vi.mock('../../../src/renderer/services/cronClient', () => ({
  cronClient: { listJobs: vi.fn(), updateJob: vi.fn() },
}));
vi.mock('../../../src/renderer/services/invokeSkillIPC', () => ({
  invokeSkillIPC: vi.fn(),
  invokeSkillIPCOrThrow: vi.fn(),
  describeSkillIpcError: vi.fn(),
}));
// 重组件内嵌零改造，但测试里不拉它的依赖树
vi.mock('../../../src/renderer/components/features/projectCollaboration/ProjectCollaborationPanel', () => ({
  ProjectCollaborationPanel: () => <div data-testid="mock-collaboration-panel" />,
}));

import { ProjectSpacePage } from '../../../src/renderer/components/features/projectSpace/ProjectSpacePage';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';
import * as projectClient from '../../../src/renderer/services/projectClient';
import { tagClient } from '../../../src/renderer/services/tagClient';
import * as rolesClient from '../../../src/renderer/services/rolesClient';
import { cronClient } from '../../../src/renderer/services/cronClient';
import { invokeSkillIPC } from '../../../src/renderer/services/invokeSkillIPC';
import { projectSpaceZh } from '../../../src/renderer/i18n/projectSpace';

const ps = projectSpaceZh.projectSpace;
const PROJECT_ID = 'proj_test1';

const projectFixture = {
  id: PROJECT_ID,
  name: '测试项目',
  workspacePath: '/tmp/ws',
  workspaceKey: 'ws-key',
  status: 'active' as const,
  description: '项目描述',
  createdAt: 1,
  updatedAt: 2,
  activeTopicCount: 3,
  lastActivityAt: Date.now() - 5 * 60_000,
};

const detailFixture = {
  project: { ...projectFixture },
  sources: [],
  goals: [],
  roles: [{ projectId: PROJECT_ID, roleId: 'role-a', joinedAt: 1 }],
  sessionIds: [],
};

const switchSessionMock = vi.fn();
const createSessionMock = vi.fn();
const openCapabilityHubMock = vi.fn();

function setupHappyPathMocks() {
  vi.mocked(projectClient.listProjectsWithActivity).mockResolvedValue([projectFixture]);
  vi.mocked(projectClient.getProjectDetail).mockResolvedValue(detailFixture as never);
  vi.mocked(projectClient.getProjectArtifacts).mockResolvedValue([]);
  vi.mocked(projectClient.addProjectRole).mockResolvedValue({ projectId: PROJECT_ID, roleId: 'role-b', joinedAt: 2 });
  vi.mocked(projectClient.removeProjectRole).mockResolvedValue({ removed: true });
  vi.mocked(projectClient.listCapabilitySelections).mockResolvedValue([
    { projectId: PROJECT_ID, kind: 'connector', capabilityId: 'mcp-1', selectedAt: 1 },
  ]);
  vi.mocked(projectClient.selectCapability).mockResolvedValue({
    projectId: PROJECT_ID,
    kind: 'connector',
    capabilityId: 'mcp-2',
    selectedAt: 2,
  });
  vi.mocked(projectClient.unselectCapability).mockResolvedValue({ removed: true });
  vi.mocked(tagClient.listByProject).mockResolvedValue([]);
  vi.mocked(rolesClient.listRoles).mockResolvedValue([
    { roleId: 'role-a', description: '', source: 'builtin', memoryCount: 0, lastWork: null },
    { roleId: 'role-b', description: '', source: 'builtin', memoryCount: 0, lastWork: null },
  ] as never);
  vi.mocked(cronClient.listJobs).mockResolvedValue([]);
  vi.mocked(invokeSkillIPC).mockResolvedValue([]);
  (window as unknown as { domainAPI: unknown }).domainAPI = {
    invoke: vi.fn().mockResolvedValue({
      success: true,
      data: {
        categories: [],
        servers: [
          { id: 'mcp-1', name: 'Server 1', description: '' },
          { id: 'mcp-2', name: 'Server 2', description: '' },
        ],
      },
    }),
  };
}

async function enterSpaceView() {
  render(<ProjectSpacePage onClose={() => undefined} />);
  const item = await screen.findByTestId(`project-space-list-item-${PROJECT_ID}`);
  fireEvent.click(item);
  await screen.findByTestId('project-space-tab-activity');
}

beforeEach(() => {
  vi.clearAllMocks();
  setupHappyPathMocks();
  switchSessionMock.mockResolvedValue(undefined);
  createSessionMock.mockResolvedValue({ id: 'sess-new' });
  useAppStore.setState({
    language: 'zh',
    showProjectSpacePage: true,
    pendingProjectChatSeed: null,
    openCapabilityHub: openCapabilityHubMock,
    workingDirectory: null,
  });
  useSessionStore.setState({
    sessions: [],
    currentSessionId: null,
    switchSession: switchSessionMock,
    createSession: createSessionMock,
  } as never);
});

afterEach(() => {
  cleanup();
  useAppStore.setState({ showProjectSpacePage: false, pendingProjectChatSeed: null });
});

describe('ProjectSpacePage 列表视图', () => {
  it('渲染项目行：状态 chip + 活跃 topic 徽标', async () => {
    render(<ProjectSpacePage onClose={() => undefined} />);
    await screen.findByTestId(`project-space-list-item-${PROJECT_ID}`);
    expect(screen.getByTestId(`project-space-status-${PROJECT_ID}`).textContent).toBe(ps.statusActive);
    expect(screen.getByTestId(`project-space-topic-count-${PROJECT_ID}`).textContent).toBe(
      ps.activeTopicBadge.replace('{count}', '3'),
    );
  });

  it('空态：没有项目时渲染引导文案', async () => {
    vi.mocked(projectClient.listProjectsWithActivity).mockResolvedValue([]);
    render(<ProjectSpacePage onClose={() => undefined} />);
    await screen.findByText(ps.listEmpty);
  });
});

describe('ProjectSpacePage 空间视图', () => {
  it('三个 tab 可切换：任务 tab 内嵌 ProjectCollaborationPanel', async () => {
    await enterSpaceView();
    expect(screen.getByTestId('project-space-tab-activity')).toBeTruthy();
    expect(screen.getByTestId('project-space-tab-tasks')).toBeTruthy();
    expect(screen.getByTestId('project-space-tab-assets')).toBeTruthy();

    fireEvent.click(screen.getByTestId('project-space-tab-tasks'));
    expect(screen.getByTestId('mock-collaboration-panel')).toBeTruthy();

    fireEvent.click(screen.getByTestId('project-space-tab-assets'));
    await screen.findByText(ps.assetsEmpty);
  });

  it('动态流 session 条目跳源：调用 switchSession', async () => {
    useSessionStore.setState({
      sessions: [
        { id: 'sess-1', title: '会话一', projectId: PROJECT_ID, updatedAt: Date.now() - 60_000, createdAt: 1 },
      ],
    } as never);
    await enterSpaceView();
    const jump = await screen.findByTestId('project-space-activity-jump-session-sess-1');
    fireEvent.click(jump);
    expect(switchSessionMock).toHaveBeenCalledWith('sess-1');
  });
});

describe('ProjectConfigRail 项目配置', () => {
  it('专家：移除已选调用 removeProjectRole，添加调用 addProjectRole', async () => {
    await enterSpaceView();
    const remove = await screen.findByTestId('project-space-card-experts-remove-role-a');
    fireEvent.click(remove);
    await waitFor(() => expect(projectClient.removeProjectRole).toHaveBeenCalledWith(PROJECT_ID, 'role-a'));

    fireEvent.click(screen.getByTestId('project-space-card-experts-add'));
    const option = await screen.findByTestId('project-space-card-experts-option-role-b');
    fireEvent.click(option);
    await waitFor(() => expect(projectClient.addProjectRole).toHaveBeenCalledWith(PROJECT_ID, 'role-b'));
  });

  it('连接器：移除调用 unselectCapability，添加调用 selectCapability', async () => {
    await enterSpaceView();
    const remove = await screen.findByTestId('project-space-card-connectors-remove-mcp-1');
    fireEvent.click(remove);
    await waitFor(() =>
      expect(projectClient.unselectCapability).toHaveBeenCalledWith(PROJECT_ID, 'connector', 'mcp-1'),
    );

    fireEvent.click(screen.getByTestId('project-space-card-connectors-add'));
    const option = await screen.findByTestId('project-space-card-connectors-option-mcp-2');
    fireEvent.click(option);
    await waitFor(() =>
      expect(projectClient.selectCapability).toHaveBeenCalledWith(PROJECT_ID, 'connector', 'mcp-2'),
    );
  });

  it('「去配置」深链：专家卡调 openCapabilityHub(experts)', async () => {
    await enterSpaceView();
    const configure = await screen.findByTestId('project-space-card-experts-configure');
    fireEvent.click(configure);
    expect(openCapabilityHubMock).toHaveBeenCalledWith('experts');
  });
});

describe('ProjectComposer 底部输入框', () => {
  it('发送：createSession 带项目工作目录、落 seed、切到新会话', async () => {
    await enterSpaceView();
    const input = await screen.findByTestId('project-space-composer-input');
    fireEvent.change(input, { target: { value: '帮我整理这个项目的周报' } });
    fireEvent.click(screen.getByTestId('project-space-composer-send'));

    await waitFor(() =>
      expect(createSessionMock).toHaveBeenCalledWith('帮我整理这个项目的周报', { workingDirectory: '/tmp/ws' }),
    );
    await waitFor(() =>
      expect(useAppStore.getState().pendingProjectChatSeed).toEqual({
        sessionId: 'sess-new',
        content: '帮我整理这个项目的周报',
      }),
    );
    expect(switchSessionMock).toHaveBeenCalledWith('sess-new');
  });

  it('空文本不发送', async () => {
    await enterSpaceView();
    const input = await screen.findByTestId('project-space-composer-input');
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.click(screen.getByTestId('project-space-composer-send'));
    expect(createSessionMock).not.toHaveBeenCalled();
  });
});
