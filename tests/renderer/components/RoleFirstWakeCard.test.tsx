// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RoleFirstWakeSnapshot } from '../../../src/shared/contract/roleAssets';
import type { RolePanelEntry } from '../../../src/shared/contract/roleAssets';

const getFirstWake = vi.fn<(roleId: string) => Promise<RoleFirstWakeSnapshot | null>>();
const skipFirstWake = vi.fn<(roleId: string) => Promise<{ success: boolean }>>();
const listRoles = vi.fn<() => Promise<RolePanelEntry[]>>();
const goToExpertThread = vi.fn<(roleId: string, options?: { seed?: string }) => Promise<void>>();
const invokeDomain = vi.fn();
const listeners = new Map<string, (event: unknown) => void>();

vi.mock('../../../src/renderer/services/rolesClient', () => ({
  getFirstWake: (roleId: string) => getFirstWake(roleId),
  skipFirstWake: (roleId: string) => skipFirstWake(roleId),
  listRoles: () => listRoles(),
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

import { RoleFirstWakeCard, RoleFirstWakeThreadBanner } from '../../../src/renderer/components/features/chat/RoleFirstWakeCard';
import { RoleDraftNotifications } from '../../../src/renderer/components/features/chat/ChatInput/RoleDraftCard';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';

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
  intro: '我是小满，擅长整理日程。',
};

function emitDraft(draft: { id: string; roleId: string; description: string; tools: string[]; editingRoleId?: string }) {
  act(() => {
    listeners.get('agent:event')?.({
      type: 'role_draft_pending',
      data: { drafts: [draft] },
    });
  });
}

describe('RoleFirstWakeCard', () => {
  const openCapabilityHub = vi.fn();

  beforeEach(() => {
    getFirstWake.mockReset();
    skipFirstWake.mockReset().mockResolvedValue({ success: true });
    listRoles.mockReset().mockResolvedValue([ROLE]);
    goToExpertThread.mockReset().mockResolvedValue(undefined);
    invokeDomain.mockReset();
    listeners.clear();
    openCapabilityHub.mockReset();
    useAppStore.setState({ openCapabilityHub });
    useSessionStore.setState({ currentSessionId: 'sess-1' });
    sessionStorage.clear();
  });

  afterEach(() => {
    cleanup();
  });

  it('轮询 firstWakeGet，点建议先跳过再把 prompt 交给该专家', async () => {
    getFirstWake.mockResolvedValue(COMPLETED);
    render(<RoleFirstWakeCard roleId="role-1" />);

    expect(await screen.findByText('我是小满，擅长整理日程。')).toBeTruthy();
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
    fireEvent.click(await screen.findByRole('button', { name: '跳过' }));
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
    expect(screen.queryByText('我是小满，擅长整理日程。')).toBeNull();
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

  it('失败态展示原因和出路，不是空卡', async () => {
    getFirstWake.mockResolvedValue({
      state: 'failed',
      sourcesMode: 'none',
      suggestions: [],
      failureReason: 'model exploded',
    });
    render(<RoleFirstWakeCard roleId="role-1" />);
    expect(await screen.findByText('这次没能完成自我介绍')).toBeTruthy();
    expect(screen.getByTestId('role-first-wake-reason').textContent).toBe('model exploded');
    fireEvent.click(screen.getByRole('button', { name: '去 TA 的会话' }));
    expect(goToExpertThread).toHaveBeenCalledWith('role-1');
    expect(skipFirstWake).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    await waitFor(() => expect(skipFirstWake).toHaveBeenCalledWith('role-1'));
    expect(screen.queryByTestId('role-first-wake-card')).toBeNull();
  });

  it('进行中显示熟悉数据，没有建议按钮', async () => {
    getFirstWake.mockResolvedValue({ state: 'running', sourcesMode: 'connected', suggestions: [] });
    render(<RoleFirstWakeCard roleId="role-1" />);
    expect(await screen.findByText('小满 正在熟悉你已连接的数据…')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '去连接' })).toBeNull();
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
});
