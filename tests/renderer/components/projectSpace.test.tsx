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
// ChatInput 完整件依赖树巨大（voice/命令面板/模型选择器…），测试用轻量 stub 守住
// ProjectComposer 的 onSend 契约；stub 行为对齐真件：Enter 发送、Shift+Enter 换行
const chatInputStub = vi.hoisted(() => ({
  extras: {} as Record<string, unknown>,
  lastProps: {} as { sessionless?: boolean; disabled?: boolean },
}));
vi.mock('../../../src/renderer/components/features/chat/ChatInput', () => ({
  ChatInput: (props: {
    onSend: (envelope: { content: string } & Record<string, unknown>) => boolean | Promise<boolean>;
    disabled?: boolean;
    sessionless?: boolean;
  }) => {
    chatInputStub.lastProps = { sessionless: props.sessionless, disabled: props.disabled };
    const [text, setText] = React.useState('');
    const submit = () => { void props.onSend({ content: text, ...chatInputStub.extras }); };
    return (
      <div data-testid="mock-chat-input">
        <textarea
          data-testid="project-space-composer-input"
          value={text}
          disabled={props.disabled}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
        />
        <button type="button" data-testid="project-space-composer-send" onClick={submit}>send</button>
      </div>
    );
  },
}));

import { ProjectSpacePage } from '../../../src/renderer/components/features/projectSpace/ProjectSpacePage';
import { ProjectConfigRail } from '../../../src/renderer/components/features/projectSpace/ProjectConfigRail';
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
  vi.mocked(projectClient.selectCapability).mockResolvedValue({
    projectId: PROJECT_ID,
    kind: 'connector',
    capabilityId: 'mcp-2',
    selectedAt: 2,
  });
  vi.mocked(projectClient.unselectCapability).mockResolvedValue({ removed: true });
  vi.mocked(tagClient.listByProject).mockResolvedValue([]);
  vi.mocked(rolesClient.listRoles).mockResolvedValue([
    { roleId: 'role-a', description: '分析数据', source: 'builtin', memoryCount: 0, lastWork: null, displayName: '数据分析师', icon: 'BarChart3' },
    { roleId: 'role-b', description: '做研究调研', source: 'builtin', memoryCount: 0, lastWork: null, displayName: '研究员', icon: 'Microscope' },
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

describe('ProjectConfigRail 项目配置（tab 化右栏）', () => {
  it('tab 条贴顶：四个 tab + 收起钮在条内；「协作空间配置」标题行取消；本分支无成员 tab', async () => {
    await enterSpaceView();
    const strip = await screen.findByTestId('project-space-config-rail-tabs');
    expect(within(strip).getByTestId('project-space-rail-tab-experts')).toBeTruthy();
    expect(within(strip).getByTestId('project-space-rail-tab-skills')).toBeTruthy();
    expect(within(strip).getByTestId('project-space-rail-tab-connectors')).toBeTruthy();
    expect(within(strip).getByTestId('project-space-rail-tab-automation')).toBeTruthy();
    // 成员 tab 仅云空间注入内容时出现（成员内容在 p1-c0-ui 分支，本分支只留 tab 位）
    expect(within(strip).queryByTestId('project-space-rail-tab-members')).toBeNull();
    // 收起钮并在 tab 条右端（两态不换位置）
    expect(within(strip).getByTestId('project-space-config-rail-collapse')).toBeTruthy();
    // 标题行取消：栏内不再有「协作空间配置」标题文案
    const rail = screen.getByTestId('project-space-config-rail');
    expect(within(rail).queryByText(ps.configRailTitle)).toBeNull();
    // 默认激活专家 tab，内容区拿全高（panel 直接在栏内，无弹窗）
    expect(screen.getByTestId('project-space-rail-tab-experts').getAttribute('aria-selected')).toBe('true');
    await screen.findByTestId('project-space-rail-experts');
  });

  it('专家：移除已选调用 removeProjectRole；可选列表点击即 addProjectRole；chip 与列表项显示 displayName', async () => {
    await enterSpaceView();
    // 已选 chip 用 displayName（不是裸 roleId）
    const chip = await screen.findByTestId('project-space-rail-experts-chip-role-a');
    expect(chip.textContent).toContain('数据分析师');
    const remove = await screen.findByTestId('project-space-rail-experts-remove-role-a');
    fireEvent.click(remove);
    await waitFor(() => expect(projectClient.removeProjectRole).toHaveBeenCalledWith(PROJECT_ID, 'role-a'));

    // 可选列表同屏（无弹窗）：两行项 displayName + 描述，点击即选用
    const option = await screen.findByTestId('project-space-rail-experts-option-role-b');
    expect(option.textContent).toContain('研究员');
    expect(option.textContent).toContain('做研究调研');
    fireEvent.click(option);
    await waitFor(() => expect(projectClient.addProjectRole).toHaveBeenCalledWith(PROJECT_ID, 'role-b'));
  });

  it('搜索：名称与描述都过滤，无匹配给提示', async () => {
    await enterSpaceView();
    await screen.findByTestId('project-space-rail-experts-option-role-b');
    // 按描述命中（「调研」只在描述里）
    fireEvent.change(screen.getByTestId('project-space-rail-experts-search'), { target: { value: '调研' } });
    await screen.findByTestId('project-space-rail-experts-option-role-b');
    // 按名称命中
    fireEvent.change(screen.getByTestId('project-space-rail-experts-search'), { target: { value: '研究员' } });
    await screen.findByTestId('project-space-rail-experts-option-role-b');
    // 无匹配
    fireEvent.change(screen.getByTestId('project-space-rail-experts-search'), { target: { value: '不存在的词' } });
    await screen.findByTestId('project-space-rail-experts-no-match');
    expect(screen.queryByTestId('project-space-rail-experts-option-role-b')).toBeNull();
  });

  it('连接器：切 tab 后移除调用 unselectCapability，可选点击调用 selectCapability', async () => {
    await enterSpaceView();
    await screen.findByTestId('project-space-rail-experts');
    fireEvent.click(screen.getByTestId('project-space-rail-tab-connectors'));
    // 显示名从 listNativeInventory 反查（查不到才回落裸 id）
    const chip = await screen.findByTestId('project-space-rail-connectors-chip-mcp-1');
    expect(chip.textContent).toContain('Server 1');
    const remove = await screen.findByTestId('project-space-rail-connectors-remove-mcp-1');
    fireEvent.click(remove);
    await waitFor(() =>
      expect(projectClient.unselectCapability).toHaveBeenCalledWith(PROJECT_ID, 'connector', 'mcp-1'),
    );

    const option = await screen.findByTestId('project-space-rail-connectors-option-mcp-2');
    fireEvent.click(option);
    await waitFor(() =>
      expect(projectClient.selectCapability).toHaveBeenCalledWith(PROJECT_ID, 'connector', 'mcp-2'),
    );
  });

  it('连接器可选项含货架 MCP（飞书）且带描述——扩口径 2026-07-30', async () => {
    await enterSpaceView();
    await screen.findByTestId('project-space-rail-experts');
    fireEvent.click(screen.getByTestId('project-space-rail-tab-connectors'));
    // getCatalog 的 mock 返回形状不对 → 走 builtin 货架兜底，'lark'（飞书）必在
    const larkOption = await screen.findByTestId('project-space-rail-connectors-option-lark');
    expect(larkOption.textContent).toContain('飞书');
    // 两行项：描述真的渲染出来（货架条目自带 description）
    expect(larkOption.textContent).toContain('多维表格');
  });

  it('技能：项目有工作目录即可增删（不要求等于当前会话目录），IPC 收到显式 workspacePath', async () => {
    vi.mocked(invokeSkillIPC).mockResolvedValue([
      { name: 'skill-a', description: '', projectOverride: null },
      { name: 'skill-b', description: '', projectOverride: true },
    ] as never);
    await enterSpaceView();
    // SKILL_LIST 也带显式 workspacePath
    await waitFor(() =>
      expect(invokeSkillIPC).toHaveBeenCalledWith(SKILL_CHANNELS.SKILL_LIST, '/tmp/ws'),
    );
    fireEvent.click(screen.getByTestId('project-space-rail-tab-skills'));
    const option = await screen.findByTestId('project-space-rail-skills-option-skill-a');
    expect((option as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(option);
    await waitFor(() =>
      expect(invokeSkillIPCOrThrow).toHaveBeenCalledWith(
        SKILL_CHANNELS.SKILL_PROJECT_SET, 'skill-a', true, '/tmp/ws',
      ),
    );

    const remove = await screen.findByTestId('project-space-rail-skills-remove-skill-b');
    fireEvent.click(remove);
    await waitFor(() =>
      expect(invokeSkillIPCOrThrow).toHaveBeenCalledWith(
        SKILL_CHANNELS.SKILL_PROJECT_CLEAR, 'skill-b', '/tmp/ws',
      ),
    );
  });

  it('技能：无工作目录的空间只读——选项行禁用 + hint 内联降级提示（不消失）', async () => {
    const noWorkspace = { ...projectFixture, workspacePath: null, workspaceKey: null };
    vi.mocked(projectClient.listProjectsWithActivity).mockResolvedValue([noWorkspace] as never);
    vi.mocked(projectClient.getProjectDetail).mockResolvedValue({
      ...detailFixture,
      project: { ...noWorkspace },
    } as never);
    await enterSpaceView();
    await screen.findByTestId('project-space-rail-experts');
    fireEvent.click(screen.getByTestId('project-space-rail-tab-skills'));
    const hint = await screen.findByTestId('project-space-rail-skills-readonly-hint');
    expect(hint.textContent).toBe(ps.skillsNoWorkspaceHint);
  });

  it('成员 tab 位：注入 membersContent 才出现第五 tab，可切换', async () => {
    const { unmount } = render(
      <ProjectConfigRail
        projectId={PROJECT_ID}
        project={projectFixture as never}
        detail={detailFixture as never}
        onRefreshDetail={() => undefined}
        membersContent={<div data-testid="mock-members-content" />}
      />,
    );
    const membersTab = await screen.findByTestId('project-space-rail-tab-members');
    fireEvent.click(membersTab);
    expect(membersTab.getAttribute('aria-selected')).toBe('true');
    await screen.findByTestId('mock-members-content');
    unmount();
  });
});

describe('ProjectComposer 底部输入框', () => {
  beforeEach(() => {
    chatInputStub.extras = {};
    chatInputStub.lastProps = {};
    useSessionStore.setState({ messages: [] } as never);
  });

  it('渲染完整 ChatInput（sessionless 模式），不是简化 textarea', async () => {
    await enterSpaceView();
    await screen.findByTestId('mock-chat-input');
    expect(chatInputStub.lastProps.sessionless).toBe(true);
  });

  it('发送：createSession 带项目工作目录、落地即上屏用户消息、seed 带完整 envelope、切到新会话', async () => {
    chatInputStub.extras = {
      attachments: [{ id: 'att-1', type: 'image', category: 'image', name: 'a.png' }],
      context: { routing: { mode: 'auto' } },
    };
    await enterSpaceView();
    const input = await screen.findByTestId('project-space-composer-input');
    fireEvent.change(input, { target: { value: '帮我整理这个项目的周报' } });
    fireEvent.click(screen.getByTestId('project-space-composer-send'));

    await waitFor(() =>
      expect(createSessionMock).toHaveBeenCalledWith('帮我整理这个项目的周报', { workingDirectory: '/tmp/ws' }),
    );
    // 落地即进行中态：切进会话那一刻用户消息已在时间线上
    await waitFor(() => {
      const messages = useSessionStore.getState().messages;
      expect(messages.some((message) => message.role === 'user' && message.content === '帮我整理这个项目的周报')).toBe(true);
    });
    const optimistic = useSessionStore.getState().messages.find((message) => message.role === 'user');
    // seed 带完整 envelope（附件/context 透传），clientMessageId 与乐观消息同 id（sendMessage 按 id 去重）
    await waitFor(() => {
      const seed = useProjectChatSeedStore.getState().pendingProjectChatSeed;
      expect(seed?.sessionId).toBe('sess-new');
      expect(seed?.envelope.content).toBe('帮我整理这个项目的周报');
      expect(seed?.envelope.attachments).toHaveLength(1);
      expect(seed?.envelope.context).toEqual({ routing: { mode: 'auto' } });
      expect(seed?.envelope.clientMessageId).toBe(optimistic?.id);
    });
    expect(switchSessionMock).toHaveBeenCalledWith('sess-new');
  });

  it('Enter 发送、Shift+Enter 不发送（多行输入观感）', async () => {
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

  it('createSession 失败：不落 seed、不留乐观消息', async () => {
    createSessionMock.mockResolvedValueOnce(null);
    await enterSpaceView();
    const input = await screen.findByTestId('project-space-composer-input');
    fireEvent.change(input, { target: { value: '整理周报' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(createSessionMock).toHaveBeenCalled());
    expect(useProjectChatSeedStore.getState().pendingProjectChatSeed).toBeNull();
    expect(useSessionStore.getState().messages).toHaveLength(0);
  });
});
