// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

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
  renameProject: vi.fn(),
  setProjectDescription: vi.fn(),
  deleteProject: vi.fn(),
  createSpace: vi.fn(),
  promoteToSpace: vi.fn(),
  promoteToCloudSpace: vi.fn(),
  createInvite: vi.fn(),
  listMembers: vi.fn(),
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
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invokeDomain: vi.fn() },
}));
// 重组件内嵌零改造，但测试里不拉它的依赖树
vi.mock('../../../src/renderer/components/features/projectCollaboration/ProjectCollaborationPanel', () => ({
  ProjectCollaborationPanel: () => <div data-testid="mock-collaboration-panel" />,
}));

import { ProjectSpacePage } from '../../../src/renderer/components/features/projectSpace/ProjectSpacePage';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useProjectChatSeedStore } from '../../../src/renderer/stores/projectChatSeedStore';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';
import * as projectClient from '../../../src/renderer/services/projectClient';
import { tagClient } from '../../../src/renderer/services/tagClient';
import * as rolesClient from '../../../src/renderer/services/rolesClient';
import { cronClient } from '../../../src/renderer/services/cronClient';
import { invokeSkillIPC, invokeSkillIPCOrThrow } from '../../../src/renderer/services/invokeSkillIPC';
import { SKILL_CHANNELS } from '../../../src/shared/ipc/channels';
import ipcService from '../../../src/renderer/services/ipcService';
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
  vi.mocked(projectClient.renameProject).mockResolvedValue({ ...projectFixture, name: '新名字' } as never);
  vi.mocked(projectClient.setProjectDescription).mockResolvedValue(projectFixture as never);
  vi.mocked(projectClient.deleteProject).mockResolvedValue({ deleted: true });
  vi.mocked(projectClient.createSpace).mockResolvedValue(projectFixture as never);
  vi.mocked(projectClient.promoteToSpace).mockResolvedValue(projectFixture as never);
  vi.mocked(projectClient.promoteToCloudSpace).mockResolvedValue({
    localProjectId: PROJECT_ID,
    cloudProjectId: 'cloud-1',
    name: projectFixture.name,
  });
  vi.mocked(projectClient.createInvite).mockResolvedValue({
    code: 'INVITE-CODE-1',
    projectId: PROJECT_ID,
    expiresAt: new Date(Date.now() + 72 * 3600_000).toISOString(),
    maxUses: 10,
    usedCount: 0,
    revokedAt: null,
  });
  vi.mocked(projectClient.listMembers).mockResolvedValue([]);
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
  vi.mocked(invokeSkillIPCOrThrow).mockResolvedValue(undefined as never);
  // 连接器可选项真源：connector 域 listNativeInventory（与能力中心「连接器」页同源）
  vi.mocked(ipcService.invokeDomain).mockResolvedValue([
    { id: 'mcp-1', label: 'Server 1', enabled: true },
    { id: 'mcp-2', label: 'Server 2', enabled: true },
  ] as never);
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
    openCapabilityHub: openCapabilityHubMock,
    workingDirectory: null,
  });
  useProjectChatSeedStore.setState({ pendingProjectChatSeed: null });
  useSessionStore.setState({
    sessions: [],
    currentSessionId: null,
    switchSession: switchSessionMock,
    createSession: createSessionMock,
  } as never);
});

afterEach(() => {
  cleanup();
  useAppStore.setState({ showProjectSpacePage: false });
  useProjectChatSeedStore.setState({ pendingProjectChatSeed: null });
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

  it('无描述显示占位灰字；编辑弹层改名/改描述', async () => {
    vi.mocked(projectClient.listProjectsWithActivity).mockResolvedValue([
      { ...projectFixture, description: null },
    ] as never);
    render(<ProjectSpacePage onClose={() => undefined} />);
    await screen.findByTestId(`project-space-description-placeholder-${PROJECT_ID}`);

    fireEvent.click(screen.getByTestId(`project-space-edit-${PROJECT_ID}`));
    const nameInput = await screen.findByTestId('project-space-edit-name');
    fireEvent.change(nameInput, { target: { value: '新名字' } });
    fireEvent.change(screen.getByTestId('project-space-edit-description'), { target: { value: '新描述' } });
    fireEvent.click(screen.getByText(ps.save));

    await waitFor(() => expect(projectClient.renameProject).toHaveBeenCalledWith(PROJECT_ID, '新名字'));
    await waitFor(() => expect(projectClient.setProjectDescription).toHaveBeenCalledWith(PROJECT_ID, '新描述'));
  });

  it('删除走确认对话框，确认后调 deleteProject；文案照实写会话/topic 归入「未分类」', async () => {
    render(<ProjectSpacePage onClose={() => undefined} />);
    await screen.findByTestId(`project-space-list-item-${PROJECT_ID}`);

    fireEvent.click(screen.getByTestId(`project-space-delete-${PROJECT_ID}`));
    const dialog = await screen.findByTestId('project-space-delete-modal');
    expect(dialog.textContent).toContain('未分类');
    expect(dialog.textContent).toContain(projectFixture.name);

    fireEvent.click(screen.getByText(ps.deleteSpace));
    await waitFor(() => expect(projectClient.deleteProject).toHaveBeenCalledWith(PROJECT_ID));
  });

  it('proj_unsorted 保留桶：不显示编辑/删除，也不显示描述占位', async () => {
    vi.mocked(projectClient.listProjectsWithActivity).mockResolvedValue([
      { ...projectFixture, id: 'proj_unsorted', name: '未分类', description: null },
    ] as never);
    render(<ProjectSpacePage onClose={() => undefined} />);
    await screen.findByTestId('project-space-list-item-proj_unsorted');
    expect(screen.queryByTestId('project-space-edit-proj_unsorted')).toBeNull();
    expect(screen.queryByTestId('project-space-delete-proj_unsorted')).toBeNull();
    expect(screen.queryByTestId('project-space-description-placeholder-proj_unsorted')).toBeNull();
  });

  it('列表数据走 spacesOnly=true（verify-* 噪音与未分类不出现）', async () => {
    render(<ProjectSpacePage onClose={() => undefined} />);
    await screen.findByTestId(`project-space-list-item-${PROJECT_ID}`);
    expect(projectClient.listProjectsWithActivity).toHaveBeenCalledWith(false, true);
  });

  it('新建空间：选择工作目录来源，提交调 createSpace 并刷新列表', async () => {
    render(<ProjectSpacePage onClose={() => undefined} />);
    await screen.findByTestId(`project-space-list-item-${PROJECT_ID}`);

    fireEvent.click(screen.getByTestId('project-space-create-open'));
    await screen.findByTestId('project-space-create-modal');
    fireEvent.change(screen.getByTestId('project-space-create-name'), { target: { value: '新空间' } });
    fireEvent.change(screen.getByTestId('project-space-create-description'), { target: { value: '空间描述' } });
    fireEvent.change(screen.getByTestId('project-space-create-workspace'), { target: { value: '/tmp/new-ws' } });
    fireEvent.click(screen.getByText(ps.createSubmit));

    await waitFor(() =>
      expect(projectClient.createSpace).toHaveBeenCalledWith({
        name: '新空间',
        description: '空间描述',
        workspacePath: '/tmp/new-ws',
      }),
    );
    expect(projectClient.promoteToSpace).not.toHaveBeenCalled();
    // 提交后关闭并刷新列表（再发一次 spacesOnly=true 查询）
    await waitFor(() => {
      const spacesCalls = vi.mocked(projectClient.listProjectsWithActivity).mock.calls
        .filter((call) => call[1] === true);
      expect(spacesCalls.length).toBeGreaterThanOrEqual(2);
    });
  });

  it('新建空间：从现有项目升级，提交调 promoteToSpace；候选排除未分类与已升级', async () => {
    render(<ProjectSpacePage onClose={() => undefined} />);
    await screen.findByTestId(`project-space-list-item-${PROJECT_ID}`);

    fireEvent.click(screen.getByTestId('project-space-create-open'));
    await screen.findByTestId('project-space-create-modal');
    fireEvent.change(screen.getByTestId('project-space-create-name'), { target: { value: '升级空间' } });
    fireEvent.click(screen.getByTestId('project-space-create-source-promote'));

    // 候选列表拉的是全量项目（spacesOnly=false）；fixture 无 spacePromotedAt → 候选
    await waitFor(() =>
      expect(projectClient.listProjectsWithActivity).toHaveBeenCalledWith(false, false),
    );
    const select = await screen.findByTestId('project-space-create-promote-select');
    await within(select).findByRole('option', { name: projectFixture.name });
    fireEvent.change(select, { target: { value: PROJECT_ID } });
    fireEvent.click(screen.getByText(ps.createSubmit));

    await waitFor(() => expect(projectClient.promoteToSpace).toHaveBeenCalledWith(PROJECT_ID));
    expect(projectClient.createSpace).not.toHaveBeenCalled();
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
    // 显示名从 listNativeInventory 反查（查不到才回落裸 id）
    const chip = await screen.findByTestId('project-space-card-connectors-chip-mcp-1');
    expect(chip.textContent).toContain('Server 1');
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

  it('技能卡：项目有工作目录即可增删（不要求等于当前会话目录），IPC 收到显式 workspacePath', async () => {
    vi.mocked(invokeSkillIPC).mockResolvedValue([
      { name: 'skill-a', description: '', projectOverride: null },
      { name: 'skill-b', description: '', projectOverride: true },
    ] as never);
    await enterSpaceView();
    // SKILL_LIST 也带显式 workspacePath
    await waitFor(() =>
      expect(invokeSkillIPC).toHaveBeenCalledWith(SKILL_CHANNELS.SKILL_LIST, '/tmp/ws'),
    );
    const addButton = await screen.findByTestId('project-space-card-skills-add');
    expect((addButton as HTMLButtonElement).disabled).toBe(false);
    expect(addButton.getAttribute('title')).toBe(ps.add);

    fireEvent.click(addButton);
    const option = await screen.findByTestId('project-space-card-skills-option-skill-a');
    fireEvent.click(option);
    await waitFor(() =>
      expect(invokeSkillIPCOrThrow).toHaveBeenCalledWith(
        SKILL_CHANNELS.SKILL_PROJECT_SET, 'skill-a', true, '/tmp/ws',
      ),
    );

    const remove = await screen.findByTestId('project-space-card-skills-remove-skill-b');
    fireEvent.click(remove);
    await waitFor(() =>
      expect(invokeSkillIPCOrThrow).toHaveBeenCalledWith(
        SKILL_CHANNELS.SKILL_PROJECT_CLEAR, 'skill-b', '/tmp/ws',
      ),
    );
  });

  it('技能卡：无工作目录的空间禁用「+」+ skillsNoWorkspaceHint 降级提示', async () => {
    const noWorkspace = { ...projectFixture, workspacePath: null, workspaceKey: null };
    vi.mocked(projectClient.listProjectsWithActivity).mockResolvedValue([noWorkspace] as never);
    vi.mocked(projectClient.getProjectDetail).mockResolvedValue({
      ...detailFixture,
      project: { ...noWorkspace },
    } as never);
    await enterSpaceView();
    const addButton = await screen.findByTestId('project-space-card-skills-add');
    expect((addButton as HTMLButtonElement).disabled).toBe(true);
    expect(addButton.getAttribute('title')).toBe(ps.skillsNoWorkspaceHint);
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
    fireEvent.click(within(screen.getByTestId('project-space-composer-send')).getByRole('button'));

    await waitFor(() =>
      expect(createSessionMock).toHaveBeenCalledWith('帮我整理这个项目的周报', { workingDirectory: '/tmp/ws' }),
    );
    await waitFor(() =>
      expect(useProjectChatSeedStore.getState().pendingProjectChatSeed).toEqual({
        sessionId: 'sess-new',
        content: '帮我整理这个项目的周报',
      }),
    );
    expect(switchSessionMock).toHaveBeenCalledWith('sess-new');
  });

  it('Enter 发送、Shift+Enter 不发送（多行 textarea 观感）', async () => {
    await enterSpaceView();
    const input = await screen.findByTestId('project-space-composer-input');
    fireEvent.change(input, { target: { value: '整理周报' } });
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(createSessionMock).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(createSessionMock).toHaveBeenCalled());
  });

  it('空文本不发送', async () => {
    await enterSpaceView();
    const input = await screen.findByTestId('project-space-composer-input');
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(createSessionMock).not.toHaveBeenCalled();
  });
});

// ---- P1-C0：云协同空间（邀请按钮 / 成员卡 / 云标） ----
const cloudFixture = { ...projectFixture, cloudProjectId: 'cloud-1' };
const cloudDetailFixture = { ...detailFixture, project: { ...cloudFixture } };

const membersFixture = [
  {
    projectId: PROJECT_ID,
    userId: 'user-owner',
    role: 'owner' as const,
    displayName: '房主',
    avatarUrl: null,
    joinedAt: '2026-07-01T00:00:00Z',
  },
  {
    projectId: PROJECT_ID,
    userId: 'user-member',
    role: 'member' as const,
    displayName: null,
    avatarUrl: null,
    joinedAt: '2026-07-02T00:00:00Z',
  },
];

function setupCloudSpace() {
  vi.mocked(projectClient.listProjectsWithActivity).mockResolvedValue([cloudFixture] as never);
  vi.mocked(projectClient.getProjectDetail).mockResolvedValue(cloudDetailFixture as never);
}

describe('空间页头邀请按钮（两态）', () => {
  it('cloudProjectId 为空：文案「升级为协同空间」，确认后调 promoteToCloudSpace 并刷新 detail', async () => {
    await enterSpaceView();
    const button = await screen.findByTestId('project-space-invite-open');
    expect(button.textContent).toContain(ps.promoteToCloud);

    fireEvent.click(button);
    await screen.findByTestId('project-space-invite-promote-modal');
    expect(projectClient.createInvite).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText(ps.promoteSubmit));
    await waitFor(() => expect(projectClient.promoteToCloudSpace).toHaveBeenCalledWith(PROJECT_ID));
    // 成功后刷新 detail（再发一次 detail 查询）
    await waitFor(() => {
      expect(vi.mocked(projectClient.getProjectDetail).mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });

  it('promoteToCloudSpace 失败：toast 真因，detail 不刷新', async () => {
    vi.mocked(projectClient.promoteToCloudSpace).mockRejectedValue(new Error('请先登录后再使用协同空间。'));
    await enterSpaceView();
    fireEvent.click(await screen.findByTestId('project-space-invite-open'));
    await screen.findByTestId('project-space-invite-promote-modal');
    fireEvent.click(screen.getByText(ps.promoteSubmit));
    await waitFor(() => expect(projectClient.promoteToCloudSpace).toHaveBeenCalled());
    // 确认弹层未关闭、未刷新 detail
    expect(screen.getByTestId('project-space-invite-promote-modal')).toBeTruthy();
    expect(vi.mocked(projectClient.getProjectDetail).mock.calls.length).toBe(1);
  });

  it('cloudProjectId 非空：文案「邀请」，打开 Modal 调 createInvite（72h/10 次）并展示邀请码', async () => {
    setupCloudSpace();
    await enterSpaceView();
    const button = await screen.findByTestId('project-space-invite-open');
    expect(button.textContent).toContain(ps.invite);
    expect(button.textContent).not.toContain(ps.promoteToCloud);

    fireEvent.click(button);
    await screen.findByTestId('project-space-invite-modal');
    await waitFor(() =>
      expect(projectClient.createInvite).toHaveBeenCalledWith(PROJECT_ID, { expiresInHours: 72, maxUses: 10 }),
    );
    const codeInput = await screen.findByTestId('project-space-invite-code');
    expect((codeInput as HTMLInputElement).value).toBe('INVITE-CODE-1');
    expect(screen.getByTestId('project-space-invite-hint').textContent).toContain('72');
    expect(screen.getByTestId('project-space-invite-hint').textContent).toContain('10');
  });

  it('createInvite 失败：Modal 内展示真因，不吞错', async () => {
    setupCloudSpace();
    vi.mocked(projectClient.createInvite).mockRejectedValue(new Error('只有空间所有者可以执行此操作。'));
    await enterSpaceView();
    fireEvent.click(await screen.findByTestId('project-space-invite-open'));
    const error = await screen.findByTestId('project-space-invite-error');
    expect(error.textContent).toContain('只有空间所有者可以执行此操作。');
  });
});

describe('右栏成员卡', () => {
  it('云协同空间：渲染成员行（首字母圆片 + 显示名 + role chip），无显示名回落 userId', async () => {
    setupCloudSpace();
    vi.mocked(projectClient.listMembers).mockResolvedValue(membersFixture);
    await enterSpaceView();
    const card = await screen.findByTestId('project-space-members-card');
    await within(card).findByTestId('project-space-members-row-user-owner');
    expect(within(card).getByTestId('project-space-members-row-user-owner').textContent).toContain('房主');
    expect(within(card).getByTestId('project-space-members-role-user-owner').textContent).toBe(ps.memberRoleOwner);
    expect(within(card).getByTestId('project-space-members-row-user-member').textContent).toContain('user-member');
    expect(within(card).getByTestId('project-space-members-role-user-member').textContent).toBe(ps.memberRoleMember);
  });

  it('空态：无成员显示引导文案，卡不消失', async () => {
    setupCloudSpace();
    await enterSpaceView();
    const card = await screen.findByTestId('project-space-members-card');
    await within(card).findByTestId('project-space-members-empty');
    expect(card.textContent).toContain(ps.membersEmpty);
  });

  it('取数失败：显示失败提示，卡不消失', async () => {
    setupCloudSpace();
    vi.mocked(projectClient.listMembers).mockRejectedValue(new Error('协同服务当前不可用，请检查网络后重试。'));
    await enterSpaceView();
    const card = await screen.findByTestId('project-space-members-card');
    await within(card).findByTestId('project-space-members-error');
    expect(card.textContent).toContain(ps.membersLoadFailed);
  });

  it('纯本地空间（cloudProjectId 为空）：成员卡整个不渲染', async () => {
    await enterSpaceView();
    await screen.findByTestId('project-space-card-experts');
    expect(screen.queryByTestId('project-space-members-card')).toBeNull();
    expect(projectClient.listMembers).not.toHaveBeenCalled();
  });

  it('成员卡「邀请」入口走页头同一 Modal 逻辑（createInvite 只此一份）', async () => {
    setupCloudSpace();
    await enterSpaceView();
    const entry = await screen.findByTestId('project-space-members-invite');
    fireEvent.click(entry);
    await screen.findByTestId('project-space-invite-modal');
    await waitFor(() =>
      expect(projectClient.createInvite).toHaveBeenCalledWith(PROJECT_ID, { expiresInHours: 72, maxUses: 10 }),
    );
    await screen.findByTestId('project-space-invite-code');
  });
});

describe('云标', () => {
  it('列表行：cloudProjectId 非空出现「云」Badge，为空不出现', async () => {
    setupCloudSpace();
    render(<ProjectSpacePage onClose={() => undefined} />);
    await screen.findByTestId(`project-space-cloud-badge-${PROJECT_ID}`);
    expect(screen.getByTestId(`project-space-cloud-badge-${PROJECT_ID}`).textContent).toBe(ps.cloudBadge);
  });

  it('列表行：纯本地空间不渲染云标', async () => {
    render(<ProjectSpacePage onClose={() => undefined} />);
    await screen.findByTestId(`project-space-list-item-${PROJECT_ID}`);
    expect(screen.queryByTestId(`project-space-cloud-badge-${PROJECT_ID}`)).toBeNull();
  });

  it('空间页头：云协同空间状态 chip 旁出现云标', async () => {
    setupCloudSpace();
    await enterSpaceView();
    await screen.findByTestId('project-space-header-cloud-badge');
  });

  it('空间页头：纯本地空间不渲染云标', async () => {
    await enterSpaceView();
    await screen.findByTestId('project-space-header-status');
    expect(screen.queryByTestId('project-space-header-cloud-badge')).toBeNull();
  });
});
