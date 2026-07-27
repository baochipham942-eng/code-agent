// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_DOMAINS } from '../../../src/shared/ipc';
import { useMessageActionStore } from '../../../src/renderer/stores/messageActionStore';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';

const mocks = vi.hoisted(() => ({
  invokeDomain: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    invokeDomain: mocks.invokeDomain,
  },
}));

vi.mock('../../../src/renderer/hooks/useToast', () => ({
  toast: {
    success: mocks.success,
    error: mocks.error,
  },
}));

describe('messageActionStore Fork', () => {
  const sourceMessages = [
    { id: 'u1', role: 'user', content: '第一问', timestamp: 1 },
    { id: 'a1', role: 'assistant', content: '第一答', timestamp: 2 },
    { id: 'u2', role: 'user', content: '第二问', timestamp: 3 },
    { id: 'a2', role: 'assistant', content: '第二答', timestamp: 4 },
    { id: 'u3', role: 'user', content: '第三问', timestamp: 5 },
  ] as any[];

  beforeEach(() => {
    vi.clearAllMocks();
    useMessageActionStore.getState().unregister();
    useSessionStore.setState({
      currentSessionId: 'source-session',
      messages: sourceMessages.map((message) => ({ ...message })),
      runningSessionIds: new Set<string>(),
      loadSessions: vi.fn().mockResolvedValue(undefined),
      switchSession: vi.fn().mockResolvedValue(undefined),
    });
  });

  it('calls the session fork domain, preserves source messages, refreshes the list, and opens the child', async () => {
    const before = JSON.stringify(useSessionStore.getState().messages);
    mocks.invokeDomain.mockResolvedValue({
      childSession: { id: 'child-session' },
      lineage: { childSessionId: 'child-session' },
      copiedMessageCount: 4,
      messageMappings: [],
      sourcePrefixDigest: 'sha256:prefix',
      workspaceLabel: '历史对话 + 当前文件',
    });

    await useMessageActionStore.getState().forkFromHere('a2');

    expect(mocks.invokeDomain).toHaveBeenCalledWith(
      IPC_DOMAINS.SESSION,
      'fork',
      expect.objectContaining({
        sourceSessionId: 'source-session',
        anchorAssistantMessageId: 'a2',
        idempotencyKey: expect.any(String),
        workspaceMode: 'shared_current',
      }),
    );
    expect(JSON.stringify(useSessionStore.getState().messages)).toBe(before);
    expect(useSessionStore.getState().loadSessions).toHaveBeenCalledWith({ silent: true });
    expect(useSessionStore.getState().switchSession).toHaveBeenCalledWith('child-session');
    expect(mocks.success).toHaveBeenCalledWith('已创建分支任务：历史对话 + 当前文件');
  });

  it('does not call any fork endpoint while the source session is running', async () => {
    useSessionStore.setState({ runningSessionIds: new Set(['source-session']) });

    await useMessageActionStore.getState().forkFromHere('a2');

    expect(mocks.invokeDomain).not.toHaveBeenCalled();
    expect(mocks.error).toHaveBeenCalledWith('任务仍在运行，停止后才能创建分支');
  });

  it('never falls back to the destructive checkpoint fork channel when the domain call fails', async () => {
    mocks.invokeDomain.mockRejectedValue(new Error('ANCHOR_REWOUND'));
    const before = JSON.stringify(useSessionStore.getState().messages);

    await useMessageActionStore.getState().forkFromHere('a2');

    expect(mocks.invokeDomain).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(useSessionStore.getState().messages)).toBe(before);
    expect(useSessionStore.getState().loadSessions).not.toHaveBeenCalled();
    expect(useSessionStore.getState().switchSession).not.toHaveBeenCalled();
    expect(mocks.error).toHaveBeenCalledWith('创建分支失败: ANCHOR_REWOUND');
  });
});
