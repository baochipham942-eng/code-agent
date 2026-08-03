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
  listCloudCards: vi.fn(),
  resyncCloudCards: vi.fn(),
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
  // 信任类错误判据保持真实语义（按 host 稳定文案前缀），否则 mock 掉等于测空气
  isSkillFolderTrustError: (error: unknown) =>
    error instanceof Error && error.message.includes('该目录未被信任'),
}));
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invokeDomain: vi.fn() },
}));
vi.mock('../../../src/renderer/hooks/useToast', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
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
import { IPC_DOMAINS } from '../../../src/shared/ipc';
import ipcService from '../../../src/renderer/services/ipcService';
import { toast } from '../../../src/renderer/hooks/useToast';
import { projectSpaceZh } from '../../../src/renderer/i18n/projectSpace';

const ps = projectSpaceZh.projectSpace;
const PROJECT_ID = 'proj_test1';

// FOLDER_TRUST 'get' 预检的默认评估（干净目录）；单测可换危险评估
const cleanTrustEvaluation = {
  state: 'untrusted',
  canonicalRealpath: '/tmp/ws',
  displayPath: '/tmp/ws',
  dangerousItems: [],
  blockedItems: [],
  identityChanged: false,
};
const dangerousTrustEvaluation = {
  state: 'untrusted',
  canonicalRealpath: '/tmp/new-ws',
  displayPath: '/tmp/new-ws',
  dangerousItems: [
    {
      kind: 'project-hooks',
      displayPath: '.code-agent/hooks/hooks.json',
      label: 'Project hooks',
      risk: 'execution',
      gated: true,
    },
  ],
  blockedItems: [],
  identityChanged: false,
};
let folderTrustEvaluationStub: unknown = cleanTrustEvaluation;

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
  vi.mocked(projectClient.listCloudCards).mockResolvedValue([]);
  vi.mocked(projectClient.resyncCloudCards).mockResolvedValue({ queued: 0, synced: 0, failed: 0 });
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
    { roleId: 'role-b', description: '做研究调研', source: 'builtin', memoryCount: 0, lastWork: null, displayName: '研究员', icon: 'Microscope', profession: '资深研究员' },
    { roleId: 'role-c', description: '', source: 'user', memoryCount: 0, lastWork: null },
  ] as never);
  vi.mocked(cronClient.listJobs).mockResolvedValue([]);
  vi.mocked(invokeSkillIPC).mockResolvedValue([]);
  vi.mocked(invokeSkillIPCOrThrow).mockResolvedValue(undefined as never);
  // 连接器可选项真源：connector 域 listNativeInventory（与能力中心「连接器」页同源）；
  // FOLDER_TRUST 域 'get' 走创建即信任预检 stub（默认干净目录）
  vi.mocked(ipcService.invokeDomain).mockImplementation(((domain: string) => Promise.resolve(
    domain === IPC_DOMAINS.FOLDER_TRUST
      ? folderTrustEvaluationStub
      : [
        { id: 'mcp-1', label: 'Server 1', enabled: true },
        { id: 'mcp-2', label: 'Server 2', enabled: true },
      ],
  )) as never);
}

async function enterSpaceView() {
  render(<ProjectSpacePage onClose={() => undefined} />);
  const item = await screen.findByTestId(`project-space-list-item-${PROJECT_ID}`);
  fireEvent.click(item);
  await screen.findByTestId('project-space-tab-activity');
}

beforeEach(() => {
  vi.clearAllMocks();
  folderTrustEvaluationStub = cleanTrustEvaluation;
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

  it('创建即信任：目录含危险项 → 同一 Modal 切确认步，再点创建带 trustAcknowledged', async () => {
    folderTrustEvaluationStub = dangerousTrustEvaluation;
    render(<ProjectSpacePage onClose={() => undefined} />);
    await screen.findByTestId(`project-space-list-item-${PROJECT_ID}`);

    fireEvent.click(screen.getByTestId('project-space-create-open'));
    await screen.findByTestId('project-space-create-modal');
    fireEvent.change(screen.getByTestId('project-space-create-name'), { target: { value: '危险空间' } });
    fireEvent.change(screen.getByTestId('project-space-create-workspace'), { target: { value: '/tmp/new-ws' } });
    fireEvent.click(screen.getByText(ps.createSubmit));

    // 预检拦截：不切新弹层，同一 Modal 内出现确认步 + 危险项清单，createSpace 未提交
    const confirm = await screen.findByTestId('project-space-create-trust-confirm');
    expect(confirm.textContent).toContain(ps.trustConfirmHint);
    expect(within(confirm).getByTestId('folder-trust-danger-list').textContent).toContain('.code-agent/hooks/hooks.json');
    expect(projectClient.createSpace).not.toHaveBeenCalled();

    // 再点「创建」= 知情确认：带 trustAcknowledged 提交
    fireEvent.click(screen.getByText(ps.createSubmit));
    await waitFor(() =>
      expect(projectClient.createSpace).toHaveBeenCalledWith({
        name: '危险空间',
        workspacePath: '/tmp/new-ws',
        trustAcknowledged: true,
      }),
    );
  });

  it('创建即信任：干净目录零额外交互，直接创建且无 trustAcknowledged', async () => {
    render(<ProjectSpacePage onClose={() => undefined} />);
    await screen.findByTestId(`project-space-list-item-${PROJECT_ID}`);

    fireEvent.click(screen.getByTestId('project-space-create-open'));
    await screen.findByTestId('project-space-create-modal');
    fireEvent.change(screen.getByTestId('project-space-create-name'), { target: { value: '干净空间' } });
    fireEvent.change(screen.getByTestId('project-space-create-workspace'), { target: { value: '/tmp/new-ws' } });
    fireEvent.click(screen.getByText(ps.createSubmit));

    await waitFor(() =>
      expect(projectClient.createSpace).toHaveBeenCalledWith({
        name: '干净空间',
        workspacePath: '/tmp/new-ws',
      }),
    );
    expect(screen.queryByTestId('project-space-create-trust-confirm')).toBeNull();
  });

  it('创建即信任竞态兜底：host 抛 coded 错 → 进同一确认步，不 toast 报错', async () => {
    // 预检时干净、提交瞬间 host 发现危险项（竞态）：createSpace 首次抛 coded 错，
    // 同时把后续 get 评估切成危险（host 抛错后 renderer 会重新 get 评估进确认步）
    vi.mocked(projectClient.createSpace).mockImplementationOnce(() => {
      folderTrustEvaluationStub = dangerousTrustEvaluation;
      return Promise.reject(new Error('FOLDER_TRUST_CONFIRM_REQUIRED: The folder contains project configuration that needs your review'));
    });
    render(<ProjectSpacePage onClose={() => undefined} />);
    await screen.findByTestId(`project-space-list-item-${PROJECT_ID}`);

    fireEvent.click(screen.getByTestId('project-space-create-open'));
    await screen.findByTestId('project-space-create-modal');
    fireEvent.change(screen.getByTestId('project-space-create-name'), { target: { value: '竞态空间' } });
    fireEvent.change(screen.getByTestId('project-space-create-workspace'), { target: { value: '/tmp/new-ws' } });
    // host 抛错后重新 get 评估，此时返回危险评估 → 确认步
    fireEvent.click(screen.getByText(ps.createSubmit));
    await waitFor(() => expect(projectClient.createSpace).toHaveBeenCalled());

    const confirm = await screen.findByTestId('project-space-create-trust-confirm');
    expect(confirm).toBeTruthy();
    expect(vi.mocked(toast.error)).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText(ps.createSubmit));
    await waitFor(() =>
      expect(projectClient.createSpace).toHaveBeenLastCalledWith({
        name: '竞态空间',
        workspacePath: '/tmp/new-ws',
        trustAcknowledged: true,
      }),
    );
  });

  it('创建即信任：promote 候选项目带危险目录 → 确认步后 promoteToSpace 带 trustAcknowledged', async () => {
    folderTrustEvaluationStub = dangerousTrustEvaluation;
    render(<ProjectSpacePage onClose={() => undefined} />);
    await screen.findByTestId(`project-space-list-item-${PROJECT_ID}`);

    fireEvent.click(screen.getByTestId('project-space-create-open'));
    await screen.findByTestId('project-space-create-modal');
    fireEvent.change(screen.getByTestId('project-space-create-name'), { target: { value: '升级空间' } });
    fireEvent.click(screen.getByTestId('project-space-create-source-promote'));
    const select = await screen.findByTestId('project-space-create-promote-select');
    await within(select).findByRole('option', { name: projectFixture.name });
    fireEvent.change(select, { target: { value: PROJECT_ID } });
    fireEvent.click(screen.getByText(ps.createSubmit));

    // 候选项目带 workspacePath '/tmp/ws' → 预检进确认步
    await screen.findByTestId('project-space-create-trust-confirm');
    expect(projectClient.promoteToSpace).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText(ps.createSubmit));
    await waitFor(() =>
      expect(projectClient.promoteToSpace).toHaveBeenCalledWith(PROJECT_ID, { trustAcknowledged: true }),
    );
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

describe('ProjectConfigRail 项目配置（四卡竖排形态，第四波①回滚）', () => {
  it('四卡竖排：专家/技能/连接器/自动化四卡 + 标题行（含收起钮）；纯本地空间无成员卡', async () => {
    await enterSpaceView();
    const rail = await screen.findByTestId('project-space-config-rail');
    expect(within(rail).getByTestId('project-space-card-experts')).toBeTruthy();
    expect(within(rail).getByTestId('project-space-card-skills')).toBeTruthy();
    expect(within(rail).getByTestId('project-space-card-connectors')).toBeTruthy();
    expect(within(rail).getByTestId('project-space-card-automation')).toBeTruthy();
    // 标题行回来：「协作空间配置」标题 + 收起钮同行
    expect(within(rail).getByText(ps.configRailTitle)).toBeTruthy();
    expect(within(rail).getByTestId('project-space-config-rail-collapse')).toBeTruthy();
    // 成员卡仅云空间渲染（纯本地不渲染卡位）
    expect(within(rail).queryByTestId('project-space-members-card')).toBeNull();
  });

  it('专家：移除已选调用 removeProjectRole，添加调用 addProjectRole；chip 与弹窗项显示 displayName', async () => {
    await enterSpaceView();
    // 已选 chip 用 displayName（不是裸 roleId）
    const chip = await screen.findByTestId('project-space-card-experts-chip-role-a');
    expect(chip.textContent).toContain('数据分析师');
    const remove = await screen.findByTestId('project-space-card-experts-remove-role-a');
    fireEvent.click(remove);
    await waitFor(() => expect(projectClient.removeProjectRole).toHaveBeenCalledWith(PROJECT_ID, 'role-a'));

    fireEvent.click(screen.getByTestId('project-space-card-experts-add'));
    const option = await screen.findByTestId('project-space-card-experts-option-role-b');
    // 弹窗项两行：displayName · 职能 + 描述（第六波③）
    expect(option.textContent).toContain('研究员');
    expect(option.textContent).toContain('· 资深研究员');
    expect(option.textContent).toContain('做研究调研');
    // 缺 displayName/icon/描述的角色不塌行：图标兜底槽在（svg），标签回落裸 roleId
    const bare = screen.getByTestId('project-space-card-experts-option-role-c');
    expect(bare.querySelector('svg')).toBeTruthy();
    expect(bare.textContent).toContain('role-c');
    fireEvent.click(option);
    await waitFor(() => expect(projectClient.addProjectRole).toHaveBeenCalledWith(PROJECT_ID, 'role-b'));
  });

  it('整卡可点打开添加弹窗；chip 删除不冒泡（不弹弹窗）', async () => {
    await enterSpaceView();
    await screen.findByTestId('project-space-card-experts-chip-role-a');
    // 整卡点击 → 弹窗打开
    fireEvent.click(screen.getByTestId('project-space-card-experts'));
    await screen.findByTestId('project-space-card-experts-picker');
    fireEvent.keyDown(document, { key: 'Escape' });
    // chip 删除 × 不冒泡：移除被调用、弹窗不再打开
    const removeCallCount = vi.mocked(projectClient.removeProjectRole).mock.calls.length;
    fireEvent.click(screen.getByTestId('project-space-card-experts-remove-role-a'));
    expect(vi.mocked(projectClient.removeProjectRole).mock.calls.length).toBe(removeCallCount + 1);
    expect(screen.queryByTestId('project-space-card-experts-picker')).toBeNull();
  });

  it('点遮罩关闭添加弹窗（backdrop 点击不冒泡成卡面点击把弹窗重开）', async () => {
    await enterSpaceView();
    fireEvent.click(await screen.findByTestId('project-space-card-experts-add'));
    await screen.findByTestId('project-space-card-experts-picker');
    // backdrop = Modal 根 overlay 的第一个子元素（dialog 的兄弟）
    const dialog = screen.getByRole('dialog');
    const backdrop = dialog.parentElement?.firstElementChild;
    expect(backdrop).toBeTruthy();
    fireEvent.click(backdrop as Element);
    await waitFor(() => expect(screen.queryByTestId('project-space-card-experts-picker')).toBeNull());
  });

  it('弹窗搜索：名称与描述都过滤，无匹配给提示', async () => {
    await enterSpaceView();
    fireEvent.click(await screen.findByTestId('project-space-card-experts-add'));
    await screen.findByTestId('project-space-card-experts-option-role-b');
    // 按描述命中（「调研」只在描述里）
    fireEvent.change(screen.getByTestId('project-space-card-experts-search'), { target: { value: '调研' } });
    await screen.findByTestId('project-space-card-experts-option-role-b');
    // 按名称命中
    fireEvent.change(screen.getByTestId('project-space-card-experts-search'), { target: { value: '研究员' } });
    await screen.findByTestId('project-space-card-experts-option-role-b');
    // 无匹配
    fireEvent.change(screen.getByTestId('project-space-card-experts-search'), { target: { value: '不存在的词' } });
    await screen.findByTestId('project-space-card-experts-picker-no-match');
    expect(screen.queryByTestId('project-space-card-experts-option-role-b')).toBeNull();
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

  it('连接器弹窗可选项含货架 MCP（飞书）且带描述——扩口径 2026-07-30', async () => {
    await enterSpaceView();
    fireEvent.click(await screen.findByTestId('project-space-card-connectors-add'));
    // getCatalog 的 mock 返回形状不对 → 走 builtin 货架兜底，'lark'（飞书）必在
    const larkOption = await screen.findByTestId('project-space-card-connectors-option-lark');
    expect(larkOption.textContent).toContain('飞书');
    // 两行项：描述真的渲染出来（货架条目自带 description）
    expect(larkOption.textContent).toContain('多维表格');
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

  it('技能卡撞信任门：错误 toast 带「确认信任」动作；授权后自动重放刚才那次设置（爸 2026-07-30：不跑腿）', async () => {
    vi.mocked(invokeSkillIPC).mockResolvedValue([
      { name: 'skill-a', description: '', projectOverride: null },
    ] as never);
    // 首次 SET 撞信任门（host 稳定文案前缀），授权后的重放成功
    vi.mocked(invokeSkillIPCOrThrow)
      .mockRejectedValueOnce(new Error('该目录未被信任，无法为其配置技能：/tmp/ws'))
      .mockResolvedValueOnce(undefined as never);
    // 未信任评估 → set 后已信任
    vi.mocked(ipcService.invokeDomain).mockImplementation((async (domain: string, action: string) => {
      if (domain === IPC_DOMAINS.FOLDER_TRUST) {
        return action === 'set'
          ? { state: 'trusted', workingDirectory: '/tmp/ws', dangerousItems: [] }
          : { state: 'untrusted', workingDirectory: '/tmp/ws', dangerousItems: [] };
      }
      return [] as never;
    }) as never);

    await enterSpaceView();
    fireEvent.click(await screen.findByTestId('project-space-card-skills-add'));
    fireEvent.click(await screen.findByTestId('project-space-card-skills-option-skill-a'));

    // 错误 toast 带动作按钮（第二参数），普通失败不会有
    await waitFor(() => expect(vi.mocked(toast.error).mock.calls.at(-1)?.[1]).toBeTruthy());
    const action = vi.mocked(toast.error).mock.calls.at(-1)?.[1] as { label: string; onClick: () => void };
    expect(action.label).toBe(ps.trustConfirmAction);

    // 点动作 → 评估未信任 → 弹既有完整信任框（按空间自己的工作目录评估，不是 app 当前目录）
    action.onClick();
    // CI 高负载下默认 1s 窗口不够（真实时序竞态，非逻辑断言变化），统一放宽到 3s
    await waitFor(() =>
      expect(ipcService.invokeDomain).toHaveBeenCalledWith(
        IPC_DOMAINS.FOLDER_TRUST, 'get', { workingDirectory: '/tmp/ws' },
      ), { timeout: 3000 },
    );
    // 弹的是既有完整信任框（无 testid，按其真实按钮文案定位）
    const trustButton = await screen.findByText('信任并加载', undefined, { timeout: 3000 });
    fireEvent.click(trustButton);

    // 授权走空间目录 + 自动重放刚才的 SET
    await waitFor(() =>
      expect(ipcService.invokeDomain).toHaveBeenCalledWith(
        IPC_DOMAINS.FOLDER_TRUST, 'set',
        { state: 'trusted', decidedBy: 'project-space-rail', workingDirectory: '/tmp/ws' },
      ), { timeout: 3000 },
    );
    await waitFor(() =>
      expect(vi.mocked(invokeSkillIPCOrThrow).mock.calls.filter(
        (call) => call[0] === SKILL_CHANNELS.SKILL_PROJECT_SET && call[1] === 'skill-a',
      ).length).toBe(2), { timeout: 3000 },
    );
  });

  it('技能卡非信任类失败：toast 无动作按钮（只有信任门给原地修复入口）', async () => {
    vi.mocked(invokeSkillIPC).mockResolvedValue([
      { name: 'skill-a', description: '', projectOverride: null },
    ] as never);
    vi.mocked(invokeSkillIPCOrThrow).mockRejectedValueOnce(new Error('磁盘写入失败'));
    await enterSpaceView();
    fireEvent.click(await screen.findByTestId('project-space-card-skills-add'));
    fireEvent.click(await screen.findByTestId('project-space-card-skills-option-skill-a'));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(vi.mocked(toast.error).mock.calls.at(-1)?.[1]).toBeUndefined();
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

  it('无工作目录的只读卡整卡不可点（降级提示而非消失）', async () => {
    const noWorkspace = { ...projectFixture, workspacePath: null, workspaceKey: null };
    vi.mocked(projectClient.listProjectsWithActivity).mockResolvedValue([noWorkspace] as never);
    vi.mocked(projectClient.getProjectDetail).mockResolvedValue({
      ...detailFixture,
      project: { ...noWorkspace },
    } as never);
    await enterSpaceView();
    const card = await screen.findByTestId('project-space-card-skills');
    fireEvent.click(card);
    expect(screen.queryByTestId('project-space-card-skills-picker')).toBeNull();
    expect(card.getAttribute('role')).toBeNull();
  });

  it('成员卡位：注入 membersContent 才渲染第五卡，位置在四卡之后', async () => {
    const { unmount } = render(
      <ProjectConfigRail
        projectId={PROJECT_ID}
        project={projectFixture as never}
        detail={detailFixture as never}
        onRefreshDetail={() => undefined}
        membersContent={<div data-testid="mock-members-content" />}
      />,
    );
    await screen.findByTestId('project-space-card-automation');
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

describe('右栏成员卡（四卡形态的第五卡：云空间直渲染，无需切 tab）', () => {
  async function openMembersCard() {
    await enterSpaceView();
    return screen.findByTestId('project-space-members-card');
  }

  it('云协同空间：渲染成员行（首字母圆片 + 显示名 + role chip），无显示名回落 userId', async () => {
    setupCloudSpace();
    vi.mocked(projectClient.listMembers).mockResolvedValue(membersFixture);
    const card = await openMembersCard();
    await within(card).findByTestId('project-space-members-row-user-owner');
    expect(within(card).getByTestId('project-space-members-row-user-owner').textContent).toContain('房主');
    expect(within(card).getByTestId('project-space-members-role-user-owner').textContent).toBe(ps.memberRoleOwner);
    expect(within(card).getByTestId('project-space-members-row-user-member').textContent).toContain('user-member');
    expect(within(card).getByTestId('project-space-members-role-user-member').textContent).toBe(ps.memberRoleMember);
  });

  it('空态：无成员显示引导文案，卡不消失', async () => {
    setupCloudSpace();
    const card = await openMembersCard();
    await within(card).findByTestId('project-space-members-empty');
    expect(card.textContent).toContain(ps.membersEmpty);
  });

  it('取数失败：显示失败提示，卡不消失', async () => {
    setupCloudSpace();
    vi.mocked(projectClient.listMembers).mockRejectedValue(new Error('协同服务当前不可用，请检查网络后重试。'));
    const card = await openMembersCard();
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
    const card = await openMembersCard();
    const entry = within(card).getByTestId('project-space-members-invite');
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

// ---- P1-C1：任务 tab 云端成员卡只读区（组件行为详见 cloudCollabCardsSection.test） ----
describe('任务 tab 云端成员卡只读区（挂载条件）', () => {
  it('云协同空间：切任务 tab 渲染只读区（在本地 topic 面板之上）', async () => {
    setupCloudSpace();
    await enterSpaceView();
    fireEvent.click(screen.getByTestId('project-space-tab-tasks'));
    const section = await screen.findByTestId('cloud-collab-cards-section');
    expect(within(section).getByTestId('cloud-collab-readonly-badge').textContent).toBe(ps.cloudCardsReadonlyBadge);
    // 本地 topic 面板仍在同 tab（上下分区共存）
    expect(screen.getByTestId('mock-collaboration-panel')).toBeTruthy();
    await waitFor(() => expect(projectClient.listCloudCards).toHaveBeenCalledWith(PROJECT_ID));
  });

  it('纯本地空间（cloudProjectId 为空）：只读区不渲染，listCloudCards 不调用', async () => {
    await enterSpaceView();
    fireEvent.click(screen.getByTestId('project-space-tab-tasks'));
    await screen.findByTestId('mock-collaboration-panel');
    expect(screen.queryByTestId('cloud-collab-cards-section')).toBeNull();
    expect(projectClient.listCloudCards).not.toHaveBeenCalled();
  });
});
