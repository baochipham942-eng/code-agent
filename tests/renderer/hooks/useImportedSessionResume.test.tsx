// @vitest-environment jsdom
//
// ============================================================================
// useImportedSessionResume hook 测试（N-EXTHISTORY-IMPORT-CHATS-RESUME）
// ----------------------------------------------------------------------------
// 导入外部历史会话的「发送即分支」：
// - 非导入会话直通原发送链（不 fork）；
// - 导入会话：fork 锚点 = 最后一条完整助手回复 → SESSION fork IPC → 刷新会话列表
//   → 切到子会话 → envelope 重定向到子会话再发送；
// - 无助手回复：不发不 fork，一句人话 toast（无错误码外泄）；
// - fork IPC 失败：人话 toast + 返回 false（composer 恢复草稿）。
// ============================================================================

import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  return { useI18n: () => ({ t: zh, language: 'zh' }) };
});
vi.mock('../../../src/renderer/hooks/useToast', () => ({
  toast: { info: vi.fn(), success: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));

const storeMocks = vi.hoisted(() => ({
  sessionState: {
    currentSessionId: 'session-imported' as string | null,
    sessions: [] as Array<Record<string, unknown>>,
    messages: [] as unknown[],
    isLoading: false,
    isHydratingSession: false,
    isSessionRunning: vi.fn(() => false),
    loadSessions: vi.fn(async () => {}),
    switchSession: vi.fn(async () => {}),
  },
}));

vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: Object.assign(
    (selector: (state: typeof storeMocks.sessionState) => unknown) => selector(storeMocks.sessionState),
    { getState: () => storeMocks.sessionState },
  ),
}));

const ipcMocks = vi.hoisted(() => ({
  invokeDomain: vi.fn(),
}));

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invokeDomain: ipcMocks.invokeDomain },
  invokeDomain: ipcMocks.invokeDomain,
}));

import { toast } from '../../../src/renderer/hooks/useToast';
import type { ConversationEnvelope } from '../../../src/shared/contract/conversationEnvelope';
import type { Message } from '../../../src/shared/contract';
import type { Session } from '../../../src/shared/contract/session';
import {
  useImportedSessionNotice,
  useImportedSessionResumeSend,
} from '../../../src/renderer/hooks/useImportedSessionResume';

const importedSession = {
  id: 'session-imported',
  title: 'Claude Code history',
  engine: { kind: 'claude_code', origin: 'import', permissionProfile: 'read_only' },
} as unknown as Session;

const nativeSession = { id: 'session-native', engine: { kind: 'native', origin: 'manual' } } as unknown as Session;

function message(over: Partial<Message> & { id: string; role: 'user' | 'assistant' }): Message {
  return { content: 'text', timestamp: 1, ...over } as Message;
}

beforeEach(() => {
  vi.clearAllMocks();
  storeMocks.sessionState.currentSessionId = 'session-imported';
  storeMocks.sessionState.sessions = [importedSession as unknown as Record<string, unknown>];
  storeMocks.sessionState.messages = [];
  storeMocks.sessionState.isSessionRunning = vi.fn(() => false);
  storeMocks.sessionState.loadSessions = vi.fn(async () => {});
  storeMocks.sessionState.switchSession = vi.fn(async () => {});
});

describe('说明行状态与锚点判据（经 useImportedSessionNotice 的公开面）', () => {
  it('非导入会话不显示：native 引擎、以及仅带 import origin 的 native 引擎都不算', () => {
    storeMocks.sessionState.sessions = [nativeSession as unknown as Record<string, unknown>];
    expect(renderHook(() => useImportedSessionNotice()).result.current).toBeNull();
    storeMocks.sessionState.sessions = [{
      ...importedSession,
      engine: { kind: 'native', origin: 'import' },
    } as unknown as Record<string, unknown>];
    expect(renderHook(() => useImportedSessionNotice()).result.current).toBeNull();
  });

  it('codex_cli 导入会话同样识别', () => {
    storeMocks.sessionState.sessions = [{
      ...importedSession,
      engine: { kind: 'codex_cli', origin: 'import' },
    } as unknown as Record<string, unknown>];
    storeMocks.sessionState.messages = [message({ id: 'a1', role: 'assistant' })];
    expect(renderHook(() => useImportedSessionNotice()).result.current)
      .toEqual({ kind: 'explain', engineKind: 'codex_cli' });
  });

  it('锚点取最后一条完整助手回复：尾随未回复的用户消息不阻断', () => {
    storeMocks.sessionState.sessions = [importedSession as unknown as Record<string, unknown>];
    storeMocks.sessionState.messages = [
      message({ id: 'u1', role: 'user' }),
      message({ id: 'a1', role: 'assistant', content: 'first answer' }),
      message({ id: 'u2', role: 'user', content: 'unanswered' }),
    ];
    expect(renderHook(() => useImportedSessionNotice()).result.current)
      .toEqual({ kind: 'explain', engineKind: 'claude_code' });
  });

  it('唯一助手回复带 tool_calls 载荷 → 无锚点（与 host 锚点规则一致）', () => {
    storeMocks.sessionState.sessions = [importedSession as unknown as Record<string, unknown>];
    storeMocks.sessionState.messages = [
      message({
        id: 'a2', role: 'assistant', content: 'running tool',
        toolCalls: [{ id: 't1', name: 'Read', arguments: {} }] as Message['toolCalls'],
      }),
    ];
    expect(renderHook(() => useImportedSessionNotice()).result.current)
      .toEqual({ kind: 'no_anchor', engineKind: 'claude_code' });
  });
});

describe('useImportedSessionResumeSend（发送包装器）', () => {
  function renderSend(send: (envelope: ConversationEnvelope) => Promise<boolean>, messages: Message[]) {
    const { result } = renderHook(() => useImportedSessionResumeSend(
      send,
      () => messages,
    ));
    return result.current;
  }

  it('非导入会话：不 fork，直接走原发送链', async () => {
    storeMocks.sessionState.sessions = [nativeSession as unknown as Record<string, unknown>];
    const send = vi.fn(async () => true);
    const wrapped = renderSend(send, [message({ id: 'a1', role: 'assistant' })]);

    const outcome = await wrapped({ content: 'hi' });
    expect(outcome).toBe(true);
    expect(send).toHaveBeenCalledWith({ content: 'hi' });
    expect(ipcMocks.invokeDomain).not.toHaveBeenCalled();
    expect(storeMocks.sessionState.switchSession).not.toHaveBeenCalled();
  });

  it('导入会话：fork 最后助手回复 → 切子会话 → envelope 重定向后发送', async () => {
    const messages = [
      message({ id: 'u1', role: 'user', content: 'question' }),
      message({ id: 'a1', role: 'assistant', content: 'answer' }),
    ];
    ipcMocks.invokeDomain.mockResolvedValue({
      childSession: { id: 'child-1' },
      lineage: {},
      messageMappings: [],
    });
    const send = vi.fn(async () => true);
    const wrapped = renderSend(send, messages);

    const outcome = await act(async () => wrapped({ content: 'follow-up', clientMessageId: 'cm-9' }));
    expect(outcome).toBe(true);

    expect(ipcMocks.invokeDomain).toHaveBeenCalledWith(
      'domain:session',
      'fork',
      expect.objectContaining({
        sourceSessionId: 'session-imported',
        anchorAssistantMessageId: 'a1',
        workspaceMode: 'shared_current',
      }),
    );
    expect(storeMocks.sessionState.loadSessions).toHaveBeenCalledWith({ silent: true });
    expect(storeMocks.sessionState.switchSession).toHaveBeenCalledWith('child-1');
    expect(send).toHaveBeenCalledWith({ content: 'follow-up', clientMessageId: 'cm-9', sessionId: 'child-1' });
  });

  it('无助手回复：不发不 fork，一句人话 toast，返回 false', async () => {
    const send = vi.fn(async () => true);
    const wrapped = renderSend(send, [message({ id: 'u1', role: 'user' })]);

    const outcome = await act(async () => wrapped({ content: 'hi' }));
    expect(outcome).toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect(ipcMocks.invokeDomain).not.toHaveBeenCalled();
    expect(toast.info).toHaveBeenCalledWith(expect.stringContaining('导入的对话'));
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('fork IPC 失败：人话 toast + 返回 false，不切会话不发送', async () => {
    ipcMocks.invokeDomain.mockRejectedValue(new Error('SESSION_RUNNING'));
    const send = vi.fn(async () => true);
    const wrapped = renderSend(send, [message({ id: 'a1', role: 'assistant' })]);

    const outcome = await act(async () => wrapped({ content: 'hi' }));
    expect(outcome).toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect(storeMocks.sessionState.switchSession).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('没能开启续接会话'));
  });
});

describe('useImportedSessionNotice（说明行状态）', () => {
  it('非导入会话不显示；导入会话有尾锚点 → explain；无助手回复 → no_anchor', () => {
    storeMocks.sessionState.sessions = [nativeSession as unknown as Record<string, unknown>];
    const { result: nativeResult } = renderHook(() => useImportedSessionNotice());
    expect(nativeResult.current).toBeNull();

    storeMocks.sessionState.sessions = [importedSession as unknown as Record<string, unknown>];
    storeMocks.sessionState.messages = [
      message({ id: 'u1', role: 'user' }),
      message({ id: 'a1', role: 'assistant' }),
    ];
    const { result: explainResult } = renderHook(() => useImportedSessionNotice());
    expect(explainResult.current).toEqual({ kind: 'explain', engineKind: 'claude_code' });

    storeMocks.sessionState.messages = [message({ id: 'u1', role: 'user' })];
    const { result: noAnchorResult } = renderHook(() => useImportedSessionNotice());
    expect(noAnchorResult.current).toEqual({ kind: 'no_anchor', engineKind: 'claude_code' });
  });

  it('消息还在装载（空 + hydrating）时不给结论，避免闪现「暂无可续接回复」', () => {
    storeMocks.sessionState.sessions = [importedSession as unknown as Record<string, unknown>];
    storeMocks.sessionState.messages = [];
    storeMocks.sessionState.isHydratingSession = true;
    const { result } = renderHook(() => useImportedSessionNotice());
    expect(result.current).toBeNull();
  });
});
