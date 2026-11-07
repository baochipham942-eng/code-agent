// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RoleFirstWakeSnapshot } from '../../../src/shared/contract/roleAssets';
import type { RolePanelEntry } from '../../../src/shared/contract/roleAssets';

const getFirstWake = vi.fn<(roleId: string) => Promise<RoleFirstWakeSnapshot | null>>();
const skipFirstWake = vi.fn<(roleId: string) => Promise<{ success: boolean }>>();
const retryFirstWake = vi.fn<(roleId: string) => Promise<{ retried: boolean }>>();
const listRoles = vi.fn<() => Promise<RolePanelEntry[]>>();
const goToExpertThread = vi.fn<(roleId: string, options?: { seed?: string }) => Promise<void>>();
// 提议卡与首次醒来卡同位渲染：mock 需覆盖其 rolesClient 面（空 pending → 不渲染）
const listWakeProposals = vi.fn<(roleId: string) => Promise<unknown[]>>(() => Promise.resolve([]));
const invokeDomain = vi.fn();
const startEditRoleChat = vi.fn<(roleId: string) => Promise<void>>();
const listeners = new Map<string, (event: unknown) => void>();

vi.mock('../../../src/renderer/services/rolesClient', () => ({
  getFirstWake: (roleId: string) => getFirstWake(roleId),
  skipFirstWake: (roleId: string) => skipFirstWake(roleId),
  retryFirstWake: (roleId: string) => retryFirstWake(roleId),
  listRoles: () => listRoles(),
  listWakeProposals: (roleId: string) => listWakeProposals(roleId),
}));

vi.mock('../../../src/renderer/utils/inviteExpert', () => ({
  goToExpertThread: (...args: unknown[]) => goToExpertThread(...(args as [string, { seed?: string }?])),
}));

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    on: (channel: string, cb: (event: unknown) => void) => {
      listeners.set(channel, cb);
      return () => { listeners.delete(channel); };
    },
    invokeDomain: (...args: unknown[]) => invokeDomain(...args),
  },
}));

vi.mock('../../../src/renderer/utils/startEditRoleChat', () => ({
  startEditRoleChat: (roleId: string) => startEditRoleChat(roleId),
}));

import { RoleFirstWakeCard, RoleFirstWakeThreadBanner } from '../../../src/renderer/components/features/chat/RoleFirstWakeCard';
import { RoleWakeProposalsCard } from '../../../src/renderer/components/features/chat/RoleWakeProposalsCard';
import { RoleDraftNotifications } from '../../../src/renderer/components/features/chat/ChatInput/RoleDraftCard';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';
import { useToastStore } from '../../../src/renderer/hooks/useToast';

const ROLE: RolePanelEntry = {
  roleId: 'role-1',
  description: '',
  source: 'user',
  memoryCount: 0,
  lastWork: null,
  displayName: '小满',
};

const COMPLETED: RoleFirstWakeSnapshot = {
  state: 'completed',
  sourcesMode: 'connected',
  suggestions: [
    { title: '总结本周日历', prompt: '帮我总结本周的日程安排' },
    { title: '第二条', prompt: '第二条委托' },
  ],
  intro: '日历连上了，共 6 个，主要是 Home 和 Work。',
};

function emitDraft(draft: { id: string; roleId: string; description: string; tools: string[]; editingRoleId?: string }) {
  act(() => {
    listeners.get('agent:event')?.({
      type: 'role_draft_pending',
      data: { drafts: [draft] },
    });
  });
}

function emitCreatedDirect() {
  act(() => {
    listeners.get('agent:event')?.({
      type: 'role_created_direct',
      data: {
        sessionId: 'sess-1',
        roleId: '日历助理AB12',
        displayName: '日历助理AB12',
        canDo: '每天盯日程，提醒冲突和临近的会议',
        willNotDo: '新建、修改或删除日历事件',
      },
    });
  });
}

describe('RoleFirstWakeCard', () => {
  const openCapabilityHub = vi.fn();

  beforeEach(() => {
    getFirstWake.mockReset();
    skipFirstWake.mockReset().mockResolvedValue({ success: true });
    retryFirstWake.mockReset().mockResolvedValue({ retried: true });
    listRoles.mockReset().mockResolvedValue([ROLE]);
    goToExpertThread.mockReset().mockResolvedValue(undefined);
    startEditRoleChat.mockReset().mockResolvedValue(undefined);
    invokeDomain.mockReset();
    listeners.clear();
    openCapabilityHub.mockReset();
    useAppStore.setState({
      openCapabilityHub,
      developerMode: false,
      firstWakeCardRoleId: null,
      expertDetailRoleId: null,
    });
    useSessionStore.setState({ currentSessionId: 'sess-1', messages: [] });
    useToastStore.setState({ toasts: [] });
    sessionStorage.clear();
  });

  afterEach(() => {
    cleanup();
  });

  it('轮询 firstWakeGet，点建议先跳过再把 prompt 交给该专家', async () => {
    getFirstWake.mockResolvedValue(COMPLETED);
    render(<RoleFirstWakeCard roleId="role-1" />);

    expect(await screen.findByText('日历连上了，共 6 个，主要是 Home 和 Work。')).toBeTruthy();
    expect(getFirstWake).toHaveBeenCalledWith('role-1');
    fireEvent.click(screen.getByRole('button', { name: '总结本周日历' }));

    await waitFor(() => {
      expect(skipFirstWake).toHaveBeenCalledWith('role-1');
      expect(goToExpertThread).toHaveBeenCalledWith('role-1', { seed: '帮我总结本周的日程安排' });
    });
    expect(skipFirstWake.mock.invocationCallOrder[0]).toBeLessThan(goToExpertThread.mock.invocationCallOrder[0]!);
    expect(screen.queryByTestId('role-first-wake-card')).toBeNull();
  });

  it('跳过调用 firstWakeSkip，卡片不再出现；skipped 快照直接不渲染', async () => {
    getFirstWake.mockResolvedValue(COMPLETED);
    const view = render(<RoleFirstWakeCard roleId="role-1" />);
    fireEvent.click(await screen.findByRole('button', { name: '先不用' }));
    await waitFor(() => expect(skipFirstWake).toHaveBeenCalledWith('role-1'));
    expect(screen.queryByTestId('role-first-wake-card')).toBeNull();

    view.unmount();
    getFirstWake.mockResolvedValue({
      state: 'skipped',
      sourcesMode: 'connected',
      suggestions: COMPLETED.suggestions,
      intro: COMPLETED.intro,
    });
    render(<RoleFirstWakeCard roleId="role-1" />);
    await waitFor(() => expect(getFirstWake).toHaveBeenCalled());
    expect(screen.queryByText('日历连上了，共 6 个，主要是 Home 和 Work。')).toBeNull();
    expect(screen.queryByTestId('role-first-wake-card')).toBeNull();
  });

  it('无数据源时给出去连接，不渲染建议按钮', async () => {
    getFirstWake.mockResolvedValue({
      state: 'completed',
      sourcesMode: 'none',
      suggestions: [{ title: '不该出现', prompt: 'nope' }],
      intro: '我还没有数据。',
    });
    render(<RoleFirstWakeCard roleId="role-1" />);
    expect(await screen.findByText('我还没有数据。')).toBeTruthy();
    expect(screen.getByText('连上数据源后我能帮你更多')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '不该出现' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '去连接' }));
    expect(openCapabilityHub).toHaveBeenCalledWith('connectors');
  });

  it('真实清单路径产出的 none 快照（内置源不算，建议被硬闸清空）渲染连接引导，无建议按钮', async () => {
    // 快照镜像 roleFirstWake.sourcesFilter.test.ts「只有内置源」场景经真实
    // CapabilityCenterService.listCapabilities() 跑出的落盘结果：
    // state=completed / sourcesMode=none / suggestions=[]（host 硬闸丢弃模型产出）。
    getFirstWake.mockResolvedValue({
      state: 'completed',
      sessionId: 'fw-1',
      sourcesMode: 'none',
      suggestions: [],
      intro: '日历连上了，共 6 个，主要是 Home 和 Work。',
    });
    render(<RoleFirstWakeCard roleId="role-1" />);

    expect(await screen.findByText('日历连上了，共 6 个，主要是 Home 和 Work。')).toBeTruthy();
    expect(screen.getByText('连上数据源后我能帮你更多')).toBeTruthy();
    expect(screen.getByRole('button', { name: '去连接' })).toBeTruthy();
    expect(screen.queryAllByRole('button').map((button) => button.textContent)).toEqual(
      expect.arrayContaining(['去连接', '进入会话', '先不用']),
    );
    // none 模式没有建议按钮：卡片上的按钮只有引导/导航/跳过三类
    expect(screen.queryByTestId('role-first-wake-card')!.getAttribute('data-sources-mode')).toBe('none');
    fireEvent.click(screen.getByRole('button', { name: '去连接' }));
    expect(openCapabilityHub).toHaveBeenCalledWith('connectors');
  });

  it('失败态先说能用再说哪里没成功，出路可走，不是空卡', async () => {
    getFirstWake.mockResolvedValue({
      state: 'failed',
      sourcesMode: 'none',
      suggestions: [],
      failureReason: 'model exploded',
    });
    render(<RoleFirstWakeCard roleId="role-1" />);
    expect(await screen.findByText('建好了，现在就可以让我做事。')).toBeTruthy();
    // 普通用户不见原始错误：generic 类省略原因和冒号，无 sources → 「你的数据」
    expect(screen.getByTestId('role-first-wake-reason').textContent).toBe('刚才没能看你的数据。');
    fireEvent.click(screen.getByRole('button', { name: '进入会话' }));
    expect(goToExpertThread).toHaveBeenCalledWith('role-1');
    expect(skipFirstWake).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '先不用' }));
    await waitFor(() => expect(skipFirstWake).toHaveBeenCalledWith('role-1'));
    expect(screen.queryByTestId('role-first-wake-card')).toBeNull();
  });

  it('进行中显示熟悉数据，没有建议按钮，「先不用」同排右对齐且有生命体征动画（C & F 钉）', async () => {
    getFirstWake.mockResolvedValue({ state: 'running', sourcesMode: 'connected', suggestions: [] });
    render(<RoleFirstWakeCard roleId="role-1" />);
    const runningText = await screen.findByText('正在熟悉你已连接的数据…');
    expect(runningText).toBeTruthy();
    expect(screen.queryByRole('button', { name: '去连接' })).toBeNull();
    const skipBtn = screen.getByRole('button', { name: '先不用' });
    expect(skipBtn).toBeTruthy();
    // 同排右对齐：runningText 与 skipBtn 同属一个 flex 行容器，且有 pulse 动效点（支持 motion-reduce）
    expect(runningText.parentElement).toBe(skipBtn.parentElement);
    expect(skipBtn.className).toContain('ml-auto');
    const pulseDot = screen.getByTestId('role-first-wake-pulse');
    expect(pulseDot.className).toContain('animate-pulse');
    expect(pulseDot.className).toContain('motion-reduce:animate-none');
  });

  it('确认创建后在原位挂上卡片；确认修改不挂', async () => {
    getFirstWake.mockResolvedValue({ state: 'pending', sourcesMode: 'none', suggestions: [] });
    invokeDomain.mockImplementation(async (_domain: unknown, action: unknown) => {
      if (action === 'confirmDraft') return { success: true, roleId: 'role-1' };
      return {};
    });
    const view = render(<RoleDraftNotifications />);
    emitDraft({ id: 'd1', roleId: 'role-1', description: '整理日程', tools: ['Read'] });
    fireEvent.click(screen.getByRole('button', { name: '确认创建' }));
    expect(await screen.findByTestId('role-first-wake-card')).toBeTruthy();
    expect(getFirstWake).toHaveBeenCalledWith('role-1');

    view.unmount();
    getFirstWake.mockClear();
    sessionStorage.clear();
    render(<RoleDraftNotifications />);
    emitDraft({
      id: 'd2',
      roleId: 'role-1',
      description: '改定义',
      tools: ['Read'],
      editingRoleId: 'role-1',
    });
    fireEvent.click(screen.getByRole('button', { name: '确认修改' }));
    await waitFor(() => expect(invokeDomain).toHaveBeenCalled());
    expect(screen.queryByTestId('role-first-wake-card')).toBeNull();
    expect(getFirstWake).not.toHaveBeenCalled();
  });

  it('直接创建卡按 v2 展示一次名字、编辑/删除和两行说明；删除确认前零 IPC，Undo 后恢复编辑', async () => {
    getFirstWake.mockResolvedValue({ state: 'pending', sourcesMode: 'none', suggestions: [] });
    invokeDomain.mockImplementation(async (_domain: unknown, action: unknown) => {
      if (action === 'deleteRole') return { trashId: 'trash-direct' };
      if (action === 'restoreDeletedRole') return { success: true };
      return {};
    });
    render(<RoleDraftNotifications />);
    emitCreatedDirect();

    const card = await screen.findByTestId('role-created-direct-card');
    expect(card.textContent?.match(/日历助理AB12/g)).toHaveLength(1);
    expect(screen.getByText('已创建')).toBeTruthy();
    expect(screen.getByRole('button', { name: '改一改' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '删除' })).toBeTruthy();
    expect(screen.getByText('能做')).toBeTruthy();
    expect(screen.getByText('每天盯日程，提醒冲突和临近的会议')).toBeTruthy();
    expect(screen.getByText('不会')).toBeTruthy();
    expect(screen.getByText('新建、修改或删除日历事件')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '改一改' }));
    expect(startEditRoleChat).toHaveBeenCalledWith('日历助理AB12');

    invokeDomain.mockClear();
    fireEvent.click(screen.getByRole('button', { name: '删除' }));
    expect(screen.getByText('删除这位专家？')).toBeTruthy();
    expect(invokeDomain).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '确认删除' }));
    await waitFor(() => expect(invokeDomain).toHaveBeenCalledWith(
      'domain:roles',
      'deleteRole',
      { roleId: '日历助理AB12' },
    ));
    await waitFor(() => expect(screen.queryByRole('button', { name: '改一改' })).toBeNull());

    invokeDomain.mockClear();
    await act(async () => {
      useToastStore.getState().toasts[0].action?.onClick();
    });
    await waitFor(() => expect(invokeDomain).toHaveBeenCalledWith(
      'domain:roles',
      'restoreDeletedRole',
      { trashId: 'trash-direct' },
    ));
    await waitFor(() => expect(screen.getByRole('button', { name: '改一改' })).toBeTruthy());
    expect(useAppStore.getState().expertDetailRoleId).toBeNull();
  });

  it('重载会话后从已落库的工具结果恢复直接创建卡', async () => {
    getFirstWake.mockResolvedValue(COMPLETED);
    useSessionStore.setState({
      currentSessionId: 'sess-1',
      messages: [{
        id: 'assistant-1',
        role: 'assistant',
        content: '',
        timestamp: 1,
        toolResults: [{
          toolCallId: 'tool-1',
          success: true,
          output: 'installed',
          metadata: {
            directCreated: true,
            sessionId: 'sess-1',
            roleId: '日历助理AB12',
            displayName: '日历助理AB12',
            canDo: '每天盯日程，提醒冲突和临近的会议',
            willNotDo: '新建、修改或删除日历事件',
          },
        }],
      }],
    });

    render(<RoleDraftNotifications />);

    expect(await screen.findByTestId('role-created-direct-card')).toBeTruthy();
    expect(screen.getByText('日历助理AB12')).toBeTruthy();
    expect(await screen.findByTestId('role-first-wake-card')).toBeTruthy();
  });

  it('专家主会话顶部按 expertThread 挂上同一张卡', async () => {
    getFirstWake.mockResolvedValue(COMPLETED);
    useSessionStore.setState({
      currentSessionId: 'expert-1',
      sessions: [{
        id: 'expert-1',
        metadata: { expertThread: { roleId: 'role-1', setAt: 1 } },
      }] as never,
    });
    const view = render(<RoleFirstWakeThreadBanner />);
    expect(await screen.findByTestId('role-first-wake-card')).toBeTruthy();
    expect(getFirstWake).toHaveBeenCalledWith('role-1');

    view.unmount();
    getFirstWake.mockClear();
    useSessionStore.setState({
      currentSessionId: 'plain',
      sessions: [{ id: 'plain', metadata: {} }] as never,
    });
    render(<RoleFirstWakeThreadBanner />);
    expect(screen.queryByTestId('role-first-wake-card')).toBeNull();
    expect(getFirstWake).not.toHaveBeenCalled();
  });

  describe('首次醒来会话重开（roleId 只在 origin.metadata）', () => {
    const WAKE_ORIGIN = { kind: 'cron', name: 'role-proactivity', metadata: { roleId: 'role-1', trigger: 'first_wake' } };
    const openWakeSession = () => useSessionStore.setState({
      currentSessionId: 'wake-1',
      sessions: [{ id: 'wake-1', metadata: {}, origin: WAKE_ORIGIN }] as never,
    });

    it('仅凭 origin 渲染同样的介绍和同样数量的建议按钮', async () => {
      getFirstWake.mockResolvedValue(COMPLETED);
      openWakeSession();
      render(<RoleFirstWakeThreadBanner />);
      expect(await screen.findByText('日历连上了，共 6 个，主要是 Home 和 Work。')).toBeTruthy();
      expect(getFirstWake).toHaveBeenCalledWith('role-1');
      const card = screen.getByTestId('role-first-wake-card');
      for (const s of COMPLETED.suggestions) {
        expect(card.textContent).toContain(s.title);
      }
      expect(screen.getByRole('button', { name: '先不用' })).toBeTruthy();
    });

    it('点建议后卡片消失；重开时 skipped 快照不渲染', async () => {
      getFirstWake.mockResolvedValue(COMPLETED);
      openWakeSession();
      const view = render(<RoleFirstWakeThreadBanner />);
      fireEvent.click(await screen.findByRole('button', { name: '总结本周日历' }));
      await waitFor(() => expect(skipFirstWake).toHaveBeenCalledWith('role-1'));
      expect(screen.queryByTestId('role-first-wake-card')).toBeNull();

      view.unmount();
      getFirstWake.mockClear();
      getFirstWake.mockResolvedValue({ ...COMPLETED, state: 'skipped' });
      render(<RoleFirstWakeThreadBanner />);
      await waitFor(() => expect(getFirstWake).toHaveBeenCalledWith('role-1'));
      expect(screen.queryByTestId('role-first-wake-card')).toBeNull();
    });

    it('跳过后卡片消失', async () => {
      getFirstWake.mockResolvedValue(COMPLETED);
      openWakeSession();
      render(<RoleFirstWakeThreadBanner />);
      fireEvent.click(await screen.findByRole('button', { name: '先不用' }));
      await waitFor(() => expect(skipFirstWake).toHaveBeenCalledWith('role-1'));
      expect(screen.queryByTestId('role-first-wake-card')).toBeNull();
    });

    it('其他 trigger 的 cron 会话与普通会话不渲染也不查询', () => {
      getFirstWake.mockResolvedValue(COMPLETED);
      useSessionStore.setState({
        currentSessionId: 'cron-1',
        sessions: [{
          id: 'cron-1',
          metadata: {},
          origin: { kind: 'cron', metadata: { roleId: 'role-1', trigger: 'cadence' } },
        }] as never,
      });
      const view = render(<RoleFirstWakeThreadBanner />);
      expect(screen.queryByTestId('role-first-wake-card')).toBeNull();
      view.unmount();
      useSessionStore.setState({
        currentSessionId: 'plain',
        sessions: [{ id: 'plain', metadata: {} }] as never,
      });
      render(<RoleFirstWakeThreadBanner />);
      expect(screen.queryByTestId('role-first-wake-card')).toBeNull();
      expect(getFirstWake).not.toHaveBeenCalled();
    });
  });
});

// ----------------------------------------------------------------------------
// 2026-11-05 owner 返修（role-wake-prototype-v2）：名字不出现在卡片可见文本、
// 原始错误只对开发者露出、failed 出路按 category 分流、重看走真实 IPC。
// ----------------------------------------------------------------------------

describe('RoleFirstWakeCard 返修 r2', () => {
  const openCapabilityHub = vi.fn();

  beforeEach(() => {
    getFirstWake.mockReset();
    skipFirstWake.mockReset().mockResolvedValue({ success: true });
    retryFirstWake.mockReset().mockResolvedValue({ retried: true });
    listRoles.mockReset().mockResolvedValue([ROLE]);
    goToExpertThread.mockReset().mockResolvedValue(undefined);
    openCapabilityHub.mockReset();
    useAppStore.setState({ openCapabilityHub, developerMode: false, firstWakeCardRoleId: null });
    useSessionStore.setState({ currentSessionId: 'sess-1' });
  });

  afterEach(() => {
    cleanup();
    useAppStore.setState({ firstWakeCardRoleId: null, developerMode: false });
  });

  it('A：任何状态下卡片可见文本都不含展示名（名字只在头像 aria-label/title 里）', async () => {
    const snapshots: RoleFirstWakeSnapshot[] = [
      COMPLETED,
      { state: 'running', sourcesMode: 'connected', suggestions: [] },
      { state: 'failed', sourcesMode: 'none', suggestions: [], failureReason: 'Invalid API key unauthorized' },
      { state: 'completed', sourcesMode: 'none', suggestions: [], intro: '我还没有数据。' },
    ];
    for (const snapshot of snapshots) {
      getFirstWake.mockResolvedValue(snapshot);
      const view = render(<RoleFirstWakeCard roleId="role-1" />);
      await waitFor(() => {
        expect(screen.getByTestId('role-first-wake-card').getAttribute('data-state')).toBe(snapshot.state);
      });
      const card = screen.getByTestId('role-first-wake-card');
      expect(card.textContent, `state=${snapshot.state}`).not.toContain('小满');
      // 名字进无障碍标签：头像带 aria-label
      expect(card.querySelector('[aria-label="小满"]')).toBeTruthy();
      view.unmount();
      getFirstWake.mockClear();
    }
  });

  it('B：failed 原始错误普通用户不可见，使用短原因词条（auth / 余额 / 网络 / generic），开发者模式原样露出', async () => {
    getFirstWake.mockResolvedValue({
      state: 'failed',
      sourcesMode: 'connected',
      sources: ['日历'],
      suggestions: [],
      failureReason: 'RAW SECRET invalid api key unauthorized',
    });
    render(<RoleFirstWakeCard roleId="role-1" />);
    await waitFor(() => expect(screen.getByTestId('role-first-wake-card').getAttribute('data-state')).toBe('failed'));
    // 有日历源 → 「你的日历」；auth 类错误映射成短文案，单冒号，不见原始串
    expect(screen.getByTestId('role-first-wake-reason').textContent)
      .toBe('刚才没能看你的日历：模型账号没通过授权。');
    expect(screen.getByTestId('role-first-wake-card').textContent).not.toContain('RAW SECRET');

    cleanup();
    // insufficient_balance / usage_limit → 模型额度用完了
    getFirstWake.mockResolvedValue({
      state: 'failed',
      sourcesMode: 'connected',
      sources: ['日历'],
      suggestions: [],
      failureReason: 'insufficient balance 402',
    });
    render(<RoleFirstWakeCard roleId="role-1" />);
    await waitFor(() => expect(screen.getByTestId('role-first-wake-reason').textContent).toBe('刚才没能看你的日历：模型额度用完了。'));

    cleanup();
    // network → 网络连不上
    getFirstWake.mockResolvedValue({
      state: 'failed',
      sourcesMode: 'connected',
      sources: ['日历'],
      suggestions: [],
      failureReason: 'fetch failed ECONNREFUSED',
    });
    render(<RoleFirstWakeCard roleId="role-1" />);
    await waitFor(() => expect(screen.getByTestId('role-first-wake-reason').textContent).toBe('刚才没能看你的日历：网络连不上。'));

    cleanup();
    // generic / empty_first_wake_output → 省略冒号与原因，提供「重新查看」恢复动作与「建好了，现在就可以让我做事。」说明
    getFirstWake.mockResolvedValue({
      state: 'failed',
      sourcesMode: 'connected',
      sources: ['日历'],
      suggestions: [],
      failureReason: 'empty_first_wake_output',
    });
    render(<RoleFirstWakeCard roleId="role-1" />);
    await waitFor(() => expect(screen.getByTestId('role-first-wake-reason').textContent).toBe('刚才没能看你的日历。'));
    expect(screen.getByText('建好了，现在就可以让我做事。')).toBeTruthy();
    expect(screen.getByRole('button', { name: '重新查看' })).toBeTruthy();

    cleanup();
    useAppStore.setState({ developerMode: true });
    getFirstWake.mockResolvedValue({
      state: 'failed',
      sourcesMode: 'connected',
      sources: ['日历'],
      suggestions: [],
      failureReason: 'RAW SECRET invalid api key unauthorized',
    });
    render(<RoleFirstWakeCard roleId="role-1" />);
    await waitFor(() => expect(screen.getByTestId('role-first-wake-reason').textContent).toBe('RAW SECRET invalid api key unauthorized'));
  });

  it('C：auth 类 failed 给「换个模型再看 + 检查账号」，点击打开对应入口', async () => {
    getFirstWake.mockResolvedValue({
      state: 'failed',
      sourcesMode: 'connected',
      suggestions: [],
      failureReason: 'Invalid API key unauthorized',
    });
    render(<RoleFirstWakeCard roleId="role-1" />);
    await waitFor(() => expect(screen.getByTestId('role-first-wake-card').getAttribute('data-state')).toBe('failed'));
    expect(screen.getByRole('button', { name: '换个模型再看' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '重新查看' })).toBeNull();

    const events: string[] = [];
    const record = (event: Event) => { events.push(event.type); };
    window.addEventListener('code-agent:open-model-switcher', record);
    fireEvent.click(screen.getByRole('button', { name: '换个模型再看' }));
    window.removeEventListener('code-agent:open-model-switcher', record);
    expect(events).toContain('code-agent:open-model-switcher');

    useAppStore.setState({ openSettingsTab: openCapabilityHub });
    fireEvent.click(screen.getByRole('button', { name: '检查账号' }));
    expect(openCapabilityHub).toHaveBeenCalledWith('model');
  });

  it('C：换模型后（override 事件）自动重看一次', async () => {
    getFirstWake.mockResolvedValue({
      state: 'failed',
      sourcesMode: 'connected',
      suggestions: [],
      failureReason: 'Invalid API key unauthorized',
    });
    render(<RoleFirstWakeCard roleId="role-1" />);
    await waitFor(() => expect(screen.getByTestId('role-first-wake-card').getAttribute('data-state')).toBe('failed'));
    window.dispatchEvent(new CustomEvent('code-agent:model-override-change', { detail: { sessionId: 'sess-1' } }));
    await waitFor(() => expect(retryFirstWake).toHaveBeenCalledWith('role-1'));
  });

  it('C：其它类别 failed 给「重新查看」，点击走 firstWakeRetry 并回到进行中', async () => {
    const failedSnapshot: RoleFirstWakeSnapshot = {
      state: 'failed',
      sourcesMode: 'none',
      suggestions: [],
      failureReason: 'model exploded',
    };
    // 第一次读 = failed（渲染失败态）；重看后轮询重启读到 running（host 侧已复位 pending）
    let calls = 0;
    getFirstWake.mockImplementation(async () => {
      calls += 1;
      return calls === 1 ? failedSnapshot : { state: 'running' as const, sourcesMode: 'connected', suggestions: [] };
    });
    render(<RoleFirstWakeCard roleId="role-1" />);
    await waitFor(() => expect(screen.getByTestId('role-first-wake-card').getAttribute('data-state')).toBe('failed'));
    expect(screen.queryByRole('button', { name: '换个模型再看' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '重新查看' }));
    await waitFor(() => expect(retryFirstWake).toHaveBeenCalledWith('role-1'));
    await waitFor(() => expect(screen.getByTestId('role-first-wake-card').getAttribute('data-state')).toBe('running'));
    expect(screen.getByText('正在熟悉你已连接的数据…')).toBeTruthy();
  });

  it('C：framed（角色自己的会话顶部）不出现「进入会话」，原位卡有', async () => {
    getFirstWake.mockResolvedValue({
      state: 'failed',
      sourcesMode: 'none',
      suggestions: [],
      failureReason: 'model exploded',
    });
    const framed = render(<RoleFirstWakeCard roleId="role-1" framed />);
    await waitFor(() => expect(screen.getByTestId('role-first-wake-card').getAttribute('data-state')).toBe('failed'));
    expect(screen.queryByRole('button', { name: '进入会话' })).toBeNull();
    framed.unmount();

    render(<RoleFirstWakeCard roleId="role-1" />);
    await waitFor(() => expect(screen.getByTestId('role-first-wake-card').getAttribute('data-state')).toBe('failed'));
    expect(screen.getByRole('button', { name: '进入会话' })).toBeTruthy();
  });

  it('D：首次醒来卡可见/消失驱动空态压制信号（ChatView 据此藏欢迎空态）', async () => {
    getFirstWake.mockResolvedValue(COMPLETED);
    const view = render(<RoleFirstWakeCard roleId="role-1" />);
    await waitFor(() => expect(useAppStore.getState().firstWakeCardRoleId).toBe('role-1'));
    // 点先不用 → 卡消失 → 信号清空、空态恢复
    fireEvent.click(screen.getByRole('button', { name: '先不用' }));
    await waitFor(() => expect(useAppStore.getState().firstWakeCardRoleId).toBeNull());
    view.unmount();
  });
});

describe('RoleWakeProposalsCard 返修 A（首次醒来卡可见时不出现，收起后照常出现）', () => {
  beforeEach(() => {
    getFirstWake.mockReset();
    skipFirstWake.mockReset().mockResolvedValue({ success: true });
    listRoles.mockReset().mockResolvedValue([ROLE]);
    listWakeProposals.mockReset().mockResolvedValue([
      { title: '整理本周会议纪要', prompt: 'p', createdAt: 1 },
    ]);
    useAppStore.setState({ firstWakeCardRoleId: null, developerMode: false });
  });

  afterEach(() => cleanup());

  it.each([
    ['running', { state: 'running' as const, sourcesMode: 'connected' as const, suggestions: [] }],
    ['completed', COMPLETED],
    ['failed', { state: 'failed' as const, sourcesMode: 'none' as const, suggestions: [], failureReason: 'err' }],
  ])('first wake %s 可见时 → 提议卡不渲染', async (_label, snapshot) => {
    getFirstWake.mockResolvedValue(snapshot);
    render(
      <>
        <RoleFirstWakeCard roleId="role-1" />
        <RoleWakeProposalsCard roleId="role-1" />
      </>,
    );
    await waitFor(() => expect(screen.getByTestId('role-first-wake-card')).toBeTruthy());
    expect(screen.queryByTestId('role-wake-proposals-card')).toBeNull();
  });

  it('首次醒来卡被「先不用」收起后（或本身已 skipped）→ 提议卡照常出现', async () => {
    let currentWake: RoleFirstWakeSnapshot = COMPLETED;
    getFirstWake.mockImplementation(async () => currentWake);
    skipFirstWake.mockImplementation(async () => {
      currentWake = { ...COMPLETED, state: 'skipped' };
      return { success: true };
    });
    render(
      <>
        <RoleFirstWakeCard roleId="role-1" />
        <RoleWakeProposalsCard roleId="role-1" />
      </>,
    );
    await waitFor(() => expect(screen.getByTestId('role-first-wake-card')).toBeTruthy());
    expect(screen.queryByTestId('role-wake-proposals-card')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '先不用' }));
    await waitFor(() => expect(screen.queryByTestId('role-first-wake-card')).toBeNull());
    await waitFor(() => expect(screen.getByTestId('role-wake-proposals-card')).toBeTruthy());
    expect(screen.getByText('整理本周会议纪要')).toBeTruthy();
  });
});
