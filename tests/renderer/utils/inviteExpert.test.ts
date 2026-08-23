// @vitest-environment jsdom
// inviteExpert / goToExpertThread（N-NAMEDMATE 刀 1「去 TA 的会话」）：
// 有主 thread = 关面板 → 切会话续聊（绑角色保持缓存一致）→ 可选 seed；
// 没有（或查询失败）= 走原新建链路：建会话 → 绑角色（per-session map 落盘）→ 可选 seed
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const createSession = vi.fn();
const switchSession = vi.fn();
const invokeDomain = vi.fn();

vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: {
    getState: () => ({ createSession, switchSession }),
  },
}));

// ipcService 走全量 mock（真模块 import 期就要 window/Electron）
vi.mock('../../../src/renderer/services/ipcService', () => ({
  invokeDomain: (...args: unknown[]) => invokeDomain(...args),
  default: {
    invokeDomain: (...args: unknown[]) => invokeDomain(...args),
    on: () => () => {},
  },
}));

import { goToExpertThread } from '../../../src/renderer/utils/inviteExpert';
import { useAppStore } from '../../../src/renderer/stores/appStore';

const SESSION_MAP_KEY = 'app:activeAgentIdBySession';

beforeEach(() => {
  localStorage.clear();
  useAppStore.setState({
    showCapabilityHub: true,
    pendingRoleChatSeed: null,
    activeAgentId: null,
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('inviteExpert 新建链路（经 goToExpertThread 无 thread 进入）', () => {
  beforeEach(() => {
    invokeDomain.mockResolvedValue({ sessionId: null });
  });

  it('建会话并把角色落盘到 per-session map，seed 写入待发通道', async () => {
    createSession.mockResolvedValue({ id: 'session_new_1' });
    await goToExpertThread('牧之', { seed: '帮我梳理需求', title: '牧之' });

    expect(createSession).toHaveBeenCalledWith('牧之', { expertRoleId: '牧之' });
    const map = JSON.parse(localStorage.getItem(SESSION_MAP_KEY) ?? '{}');
    expect(map['session_new_1']).toBe('牧之');

    const state = useAppStore.getState();
    expect(state.showCapabilityHub).toBe(false);
    expect(state.activeAgentId).toBe('牧之');
    expect(state.pendingRoleChatSeed).toBe('帮我梳理需求');
  });

  it('无 seed 只建绑定会话，不写待发消息', async () => {
    createSession.mockResolvedValue({ id: 'session_new_2' });
    await goToExpertThread('溯真');
    expect(useAppStore.getState().pendingRoleChatSeed).toBeNull();
    const map = JSON.parse(localStorage.getItem(SESSION_MAP_KEY) ?? '{}');
    expect(map['session_new_2']).toBe('溯真');
  });

  it('建会话失败时不绑定不写 seed', async () => {
    createSession.mockResolvedValue(null);
    await goToExpertThread('青禾', { seed: 'x' });
    expect(localStorage.getItem(SESSION_MAP_KEY)).toBeNull();
    expect(useAppStore.getState().pendingRoleChatSeed).toBeNull();
  });
});

describe('goToExpertThread', () => {
  it('已有专家主 thread：切到那条会话续聊，不新建会话', async () => {
    invokeDomain.mockResolvedValue({ sessionId: 'session_expert_1' });
    await goToExpertThread('牧之', { title: '牧之' });

    expect(invokeDomain).toHaveBeenCalledWith(expect.anything(), 'findExpertThread', { roleId: '牧之' });
    expect(switchSession).toHaveBeenCalledWith('session_expert_1');
    expect(createSession).not.toHaveBeenCalled();
    // 绑定缓存保持一致（切过去的会话仍按这位专家路由）
    const map = JSON.parse(localStorage.getItem(SESSION_MAP_KEY) ?? '{}');
    expect(map['session_expert_1']).toBe('牧之');
    expect(useAppStore.getState().showCapabilityHub).toBe(false);
    expect(useAppStore.getState().pendingRoleChatSeed).toBeNull();
  });

  it('已有 thread + seed（引用条点击）：续上后以该句发起', async () => {
    invokeDomain.mockResolvedValue({ sessionId: 'session_expert_2' });
    await goToExpertThread('牧之', { seed: '帮我梳理需求', title: '牧之' });

    expect(switchSession).toHaveBeenCalledWith('session_expert_2');
    expect(createSession).not.toHaveBeenCalled();
    expect(useAppStore.getState().pendingRoleChatSeed).toBe('帮我梳理需求');
  });

  it('没有专家主 thread：走新建链路（createSession 带 expertRoleId）', async () => {
    invokeDomain.mockResolvedValue({ sessionId: null });
    createSession.mockResolvedValue({ id: 'session_new_3' });
    await goToExpertThread('牧之', { title: '牧之' });

    expect(switchSession).not.toHaveBeenCalled();
    expect(createSession).toHaveBeenCalledWith('牧之', { expertRoleId: '牧之' });
  });

  it('查询失败：退回新建链路（与刀 0 之前行为一致）', async () => {
    invokeDomain.mockRejectedValue(new Error('ipc down'));
    createSession.mockResolvedValue({ id: 'session_new_4' });
    await goToExpertThread('牧之', { title: '牧之' });

    expect(switchSession).not.toHaveBeenCalled();
    expect(createSession).toHaveBeenCalledWith('牧之', { expertRoleId: '牧之' });
  });
});
