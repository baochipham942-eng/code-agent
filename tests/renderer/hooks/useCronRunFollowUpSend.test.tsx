// @vitest-environment jsdom
// N-UI-CRON-RUN-RECORD-CLEAR：运行记录会话的「接着问这次运行」发送包装器。
// 发送不在原会话里跑：先 fork（锚点=最后一条完成的助手回复）→ 切换 → 重定向；
// 运行记录本体一行不改。中断得太早没有锚点时开普通新会话带任务原文。
// 非运行记录会话直通、运行中不发送。

import { renderHook, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invokeDomainMock = vi.hoisted(() => vi.fn());

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invoke: vi.fn(), invokeDomain: invokeDomainMock, on: vi.fn().mockReturnValue(() => undefined) },
}));

import { useCronRunFollowUpSend } from '../../../src/renderer/hooks/useCronRunFollowUpSend';
import { setObservedCronRunStatusForSession } from '../../../src/renderer/components/features/chat/cronRunSessionStatus';
import { useCronStore } from '../../../src/renderer/stores/cronStore';
import { useSessionStore, type SessionWithMeta } from '../../../src/renderer/stores/sessionStore';
import type { Message } from '../../../src/shared/contract';
import type { ConversationEnvelope } from '../../../src/shared/contract/conversationEnvelope';

const cronRunSession: SessionWithMeta = {
  id: 'record-1',
  title: '[Schedule] 每日日程检查',
  readOnly: true,
  origin: { kind: 'cron', id: 'job-1', name: '每日日程检查' },
  sourceRunId: 'exec-1',
  createdAt: 1,
  updatedAt: 1,
  messageCount: 2,
  turnCount: 1,
} as SessionWithMeta;

function userMessage(content: string): Message {
  return { id: `user-${content.length}`, role: 'user', content, timestamp: 1 } as Message;
}

function assistantMessage(id: string, content: string, extra: Partial<Message> = {}): Message {
  return { id, role: 'assistant', content, timestamp: 2, ...extra } as Message;
}

function envelope(content: string): ConversationEnvelope {
  return { content, clientMessageId: 'cmid-1' } as ConversationEnvelope;
}

beforeEach(() => {
  vi.clearAllMocks();
  setObservedCronRunStatusForSession('record-1', null);
  useCronStore.setState({ executionsByJobId: {}, latestExecutions: {}, recentExecutions: [] } as never);
  useSessionStore.setState({
    sessions: [cronRunSession],
    currentSessionId: 'record-1',
    messages: [],
    isSessionRunning: () => false,
    loadSessions: vi.fn().mockResolvedValue(undefined),
    switchSession: vi.fn().mockResolvedValue(undefined),
    createSession: vi.fn().mockResolvedValue({ id: 'fresh-1' }),
  } as never);
});

afterEach(() => {
  setObservedCronRunStatusForSession('record-1', null);
  vi.restoreAllMocks();
});

describe('useCronRunFollowUpSend', () => {
  it('运行记录会话：以最后一条完成的助手回复为锚点 fork，切换后把 envelope 重定向到子会话', async () => {
    const messages = [
      userMessage('查一下今天的日程\n\n【当前时间】2026-11-04T08:27:33.512Z（UTC）。今天本地日期是 2026-11-04。'),
      assistantMessage('a-1', '今天有 2 个冲突'),
      assistantMessage('a-2', '中间过渡', { toolCalls: [{ id: 'tc', name: 'bash' }] as never }),
    ];
    const send = vi.fn().mockResolvedValue(true);
    invokeDomainMock.mockResolvedValue({ childSession: { id: 'child-1' } });

    const { result } = renderHook(() => useCronRunFollowUpSend(send, () => messages));
    let sent: boolean | undefined;
    await act(async () => {
      sent = await result.current(envelope('哪两个冲突？'));
    });

    expect(sent).toBe(true);
    // 锚点必须是「完成的助手回复」：带 tool_calls 的 a-2 不算，取 a-1
    expect(invokeDomainMock).toHaveBeenCalledWith('domain:session', 'fork', expect.objectContaining({
      sourceSessionId: 'record-1',
      anchorAssistantMessageId: 'a-1',
      workspaceMode: 'shared_current',
    }));
    expect(useSessionStore.getState().switchSession).toHaveBeenCalledWith('child-1');
    // 发到新会话的是用户原话，一字不改；原记录会话不落任何消息
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'child-1', content: '哪两个冲突？' }));
    expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'record-1' }));
  });

  it('运行记录本体不被改写：不往原会话 sendMessage、不进任何排队', async () => {
    const messages = [userMessage('任务'), assistantMessage('a-1', '结果')];
    const send = vi.fn().mockResolvedValue(true);
    invokeDomainMock.mockResolvedValue({ childSession: { id: 'child-1' } });

    const { result } = renderHook(() => useCronRunFollowUpSend(send, () => messages));
    await act(async () => {
      await result.current(envelope('接着问'));
    });

    const calls = send.mock.calls as Array<[ConversationEnvelope]>;
    expect(calls.every(([arg]) => arg.sessionId !== 'record-1')).toBe(true);
  });

  it('中断得太早没有任何助手回复：开普通新会话，任务原文（去掉机器尾段）随问题带过去', async () => {
    setObservedCronRunStatusForSession('record-1', { kind: 'interrupted' });
    const messages = [
      userMessage('查一下今天的日程\n\n【当前时间】2026-11-04T08:27:33.512Z（UTC）。今天本地日期是 2026-11-04。'),
    ];
    const send = vi.fn().mockResolvedValue(true);

    const { result } = renderHook(() => useCronRunFollowUpSend(send, () => messages));
    let sent: boolean | undefined;
    await act(async () => {
      sent = await result.current(envelope('这个任务后来怎么样了？'));
    });

    expect(sent).toBe(true);
    expect(invokeDomainMock).not.toHaveBeenCalled();
    expect(useSessionStore.getState().createSession).toHaveBeenCalled();
    const [arg] = (send.mock.calls as Array<[ConversationEnvelope]>)[0];
    expect(arg.sessionId).toBe('fresh-1');
    expect(arg.content).toContain('那次运行中断了，没有留下结果。');
    expect(arg.content).toContain('这个任务后来怎么样了？');
    expect(arg.content).toContain('查一下今天的日程');
    expect(arg.content).not.toContain('【当前时间】');
  });

  it('failed 或 cancelled 且无助手回复：不冒充「中断了，没有留下结果」，改用「那次运行没有跑完。」', async () => {
    const messages = [
      userMessage('查一下今天的日程\n\n【当前时间】2026-11-04T08:27:33.512Z（UTC）。今天本地日期是 2026-11-04。'),
    ];
    for (const execution of [
      { id: 'exec-1', jobId: 'job-1', status: 'failed' as const, error: 'Permission denied', scheduledAt: 1, retryAttempt: 0, sessionId: 'record-1' },
      { id: 'exec-1', jobId: 'job-1', status: 'failed' as const, error: 'Command failed: exit code 1', scheduledAt: 1, retryAttempt: 0, sessionId: 'record-1' },
      { id: 'exec-1', jobId: 'job-1', status: 'cancelled' as const, scheduledAt: 1, retryAttempt: 0, sessionId: 'record-1' },
    ]) {
      setObservedCronRunStatusForSession('record-1', null);
      useCronStore.setState({ executionsByJobId: { 'job-1': [execution] }, latestExecutions: {}, recentExecutions: [] } as never);
      const send = vi.fn().mockResolvedValue(true);
      const { result } = renderHook(() => useCronRunFollowUpSend(send, () => messages));
      await act(async () => {
        await result.current(envelope('为什么没跑成？'));
      });
      const [arg] = (send.mock.calls as Array<[ConversationEnvelope]>)[0];
      expect(arg.content).toContain('那次运行没有跑完。');
      expect(arg.content).not.toContain('那次运行中断了，没有留下结果。');
    }
  });

  it('fork 失败：返回 false（草稿回滚）并出声，不切会话', async () => {
    const messages = [userMessage('任务'), assistantMessage('a-1', '结果')];
    const send = vi.fn().mockResolvedValue(true);
    invokeDomainMock.mockRejectedValue(new Error('SESSION_RUNNING: source session is running'));

    const { result } = renderHook(() => useCronRunFollowUpSend(send, () => messages));
    let sent: boolean | undefined;
    await act(async () => {
      sent = await result.current(envelope('接着问'));
    });

    expect(sent).toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect(useSessionStore.getState().switchSession).not.toHaveBeenCalled();
  });

  it('普通会话直通：不 fork 不切换', async () => {
    useSessionStore.setState({
      sessions: [{ ...cronRunSession, origin: { kind: 'manual' }, readOnly: false } as SessionWithMeta],
    });
    const send = vi.fn().mockResolvedValue(true);
    const { result } = renderHook(() => useCronRunFollowUpSend(send, () => []));
    await act(async () => {
      await result.current(envelope('普通发送'));
    });
    expect(invokeDomainMock).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ content: '普通发送' }));
  });

  it('这次运行还在跑：不发送、不出错，把话还给用户', async () => {
    useSessionStore.setState({ isSessionRunning: () => true } as never);
    const messages = [userMessage('任务'), assistantMessage('a-1', '结果')];
    const send = vi.fn().mockResolvedValue(true);
    const { result } = renderHook(() => useCronRunFollowUpSend(send, () => messages));
    let sent: boolean | undefined;
    await act(async () => {
      sent = await result.current(envelope('现在怎么样了'));
    });
    expect(sent).toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect(invokeDomainMock).not.toHaveBeenCalled();
  });
});
