// @vitest-environment jsdom
// inviteExpert：请 TA 来 = 关面板 → 建会话 → 绑角色（per-session map 落盘）→ 可选 seed
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const createSession = vi.fn();

vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: {
    getState: () => ({ createSession }),
  },
}));

import { inviteExpert } from '../../../src/renderer/utils/inviteExpert';
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

describe('inviteExpert', () => {
  it('建会话并把角色落盘到 per-session map，seed 写入待发通道', async () => {
    createSession.mockResolvedValue({ id: 'session_new_1' });
    await inviteExpert('牧之', { seed: '帮我梳理需求', title: '牧之' });

    expect(createSession).toHaveBeenCalledWith('牧之');
    const map = JSON.parse(localStorage.getItem(SESSION_MAP_KEY) ?? '{}');
    expect(map['session_new_1']).toBe('牧之');

    const state = useAppStore.getState();
    expect(state.showCapabilityHub).toBe(false);
    expect(state.activeAgentId).toBe('牧之');
    expect(state.pendingRoleChatSeed).toBe('帮我梳理需求');
  });

  it('无 seed 只建绑定会话，不写待发消息', async () => {
    createSession.mockResolvedValue({ id: 'session_new_2' });
    await inviteExpert('溯真');
    expect(useAppStore.getState().pendingRoleChatSeed).toBeNull();
    const map = JSON.parse(localStorage.getItem(SESSION_MAP_KEY) ?? '{}');
    expect(map['session_new_2']).toBe('溯真');
  });

  it('建会话失败时不绑定不写 seed', async () => {
    createSession.mockResolvedValue(null);
    await inviteExpert('青禾', { seed: 'x' });
    expect(localStorage.getItem(SESSION_MAP_KEY)).toBeNull();
    expect(useAppStore.getState().pendingRoleChatSeed).toBeNull();
  });
});
