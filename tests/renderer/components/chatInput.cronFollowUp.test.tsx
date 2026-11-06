// @vitest-environment jsdom
// N-UI-CRON-RUN-RECORD-CLEAR：定时任务运行记录会话（readOnly + origin cron/heartbeat）
// 的 composer：不出现「只读」，输入区照常可用，placeholder 说清「发送会开一条新对话，
// 带上这次的结果」。非 cron 的 readOnly 会话仍走原只读提示（防御分支，当前无来源）。

import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatInput } from '../../../src/renderer/components/features/chat/ChatInput';
import { setObservedCronRunStatusForSession } from '../../../src/renderer/components/features/chat/cronRunSessionStatus';
import { IPC_DOMAINS } from '../../../src/shared/ipc';
import ipcService from '../../../src/renderer/services/ipcService';
import { useBundledCapabilityStore } from '../../../src/renderer/stores/bundledCapabilityStore';
import { useCronStore } from '../../../src/renderer/stores/cronStore';
import { useSessionStore, type SessionWithMeta } from '../../../src/renderer/stores/sessionStore';

const realCreateSession = useSessionStore.getState().createSession;

function makeSession(overrides: Partial<SessionWithMeta> & { id: string }): SessionWithMeta {
  return {
    title: overrides.id,
    modelConfig: { provider: 'openai', model: 'gpt-5' },
    createdAt: 1,
    updatedAt: 1,
    messageCount: 0,
    turnCount: 0,
    ...overrides,
  } as SessionWithMeta;
}

function resetCapabilityStore(): void {
  useBundledCapabilityStore.setState({
    installed: { 'builtin.voice-live': false, 'builtin.voice-input': false },
    states: [],
    loaded: true,
    error: null,
  });
}

function showSession(session: SessionWithMeta): void {
  useSessionStore.setState({
    sessions: [session],
    currentSessionId: session.id,
    messages: [],
    createSession: realCreateSession,
  });
}

const cronRunSession = (id: string) => makeSession({
  id,
  readOnly: true,
  origin: { kind: 'cron', id: 'job-1', name: '每日日程检查' },
  sourceRunId: 'exec-1',
});

/** 指定观测状态：placeholder 按「有没有结果可带」分叉，逐 kind 钉死。 */
function withObservedStatus(
  id: string,
  kind: 'running' | 'awaiting' | 'interrupted' | 'failed-denied' | 'failed-generic' | 'cancelled' | 'finished',
): void {
  // 夹具形状对齐 CronRunStatusLine：finished 必须带 durationMs（tsc-tests 棘轮），
  // 值本身不参与 placeholder 分叉（组件只看 kind）。
  const line = kind === 'running'
    ? { kind, startedAt: Date.now() }
    : kind === 'awaiting'
      ? { kind, approval: { id: 'req-1', requestedAt: Date.now() } }
      : kind === 'finished'
        ? { kind, durationMs: 65_000 }
        : { kind };
  setObservedCronRunStatusForSession(id, line);
}

describe('定时任务运行记录的 composer（readOnly + origin cron）', () => {
  beforeEach(() => {
    setObservedCronRunStatusForSession('cron-record-interrupted', null);
    // 复位真实 store 字段（review r6：executions 是不存在的字段，之前没复位到）：
    // ChatInput 的 cronStore 兜底选择器读 executionsByJobId / latestExecutions / recentExecutions。
    useCronStore.setState({ executionsByJobId: {}, latestExecutions: {}, recentExecutions: [] });
    resetCapabilityStore();
    const invokeDomain = ipcService.invokeDomain.bind(ipcService);
    vi.spyOn(ipcService, 'invokeDomain').mockImplementation((domain, action, payload) => {
      if (domain === IPC_DOMAINS.QUEUED_INPUT && action === 'list') return Promise.resolve([]);
      return invokeDomain(domain, action, payload);
    });
  });

  afterEach(() => {
    cleanup();
    setObservedCronRunStatusForSession('cron-record-interrupted', null);
    setObservedCronRunStatusForSession('cron-record-status', null);
    vi.restoreAllMocks();
    useSessionStore.setState({
      sessions: [],
      currentSessionId: null,
      messages: [],
      createSession: realCreateSession,
    });
    resetCapabilityStore();
  });

  it('readOnly 的运行记录会话：输入区照常渲染，不出现「只读」提示', () => {
    showSession(cronRunSession('cron-record'));
    render(<ChatInput onSend={() => true} />);

    expect(screen.getByTestId('chat-composer-textarea')).toBeTruthy();
    expect(screen.queryByTestId('readonly-session-notice')).toBeNull();
    // 整个输入区没有「只读」字样
    expect(screen.getByTestId('chat-composer-textarea').textContent).not.toContain('只读');
  });

  it('placeholder 说明去向：finished（有结果）才承诺会开一条新对话并带上这次的结果', () => {
    showSession(cronRunSession('cron-record-status'));
    withObservedStatus('cron-record-status', 'finished');
    render(<ChatInput onSend={() => true} />);

    // composer 是 contenteditable，placeholder 是空态时的兄弟 span
    expect(screen.getByText('接着问这次运行…（会开一条新对话，带上这次的结果）')).toBeTruthy();
  });

  it('interrupted（没有结果）时 placeholder 不承诺「带上这次的结果」', () => {
    showSession(cronRunSession('cron-record-interrupted'));
    withObservedStatus('cron-record-interrupted', 'interrupted');
    render(<ChatInput onSend={() => true} />);

    expect(screen.getByText('接着问这次运行…（会开一条新对话）')).toBeTruthy();
    expect(screen.queryByText('接着问这次运行…（会开一条新对话，带上这次的结果）')).toBeNull();
  });

  // review r6：没有结果的收尾不止 interrupted——failed-denied / failed-generic / cancelled
  // 同样不承诺「带上这次的结果」；只有 finished 才承诺。
  it.each(['failed-denied', 'failed-generic', 'cancelled'] as const)(
    '%s（没有结果）placeholder 同样不承诺「带上这次的结果」',
    (kind) => {
      showSession(cronRunSession('cron-record-status'));
      withObservedStatus('cron-record-status', kind);
      render(<ChatInput onSend={() => true} />);

      expect(screen.getByText('接着问这次运行…（会开一条新对话）')).toBeTruthy();
      expect(screen.queryByText('接着问这次运行…（会开一条新对话，带上这次的结果）')).toBeNull();
    },
  );

  it('finished（有结果）placeholder 保持承诺「带上这次的结果」', () => {
    showSession(cronRunSession('cron-record-status'));
    withObservedStatus('cron-record-status', 'finished');
    render(<ChatInput onSend={() => true} />);

    expect(screen.getByText('接着问这次运行…（会开一条新对话，带上这次的结果）')).toBeTruthy();
  });

  it('heartbeat 运行记录同样处理', () => {
    showSession(makeSession({
      id: 'hb-record',
      readOnly: true,
      origin: { kind: 'heartbeat', id: 'hb-1' },
    }));
    render(<ChatInput onSend={() => true} />);

    expect(screen.getByTestId('chat-composer-textarea')).toBeTruthy();
    expect(screen.queryByTestId('readonly-session-notice')).toBeNull();
  });

  it('非 cron 的 readOnly 会话仍走只读提示（防御分支）', () => {
    showSession(makeSession({ id: 'ro-other', readOnly: true }));
    render(<ChatInput onSend={() => true} />);

    expect(screen.getByTestId('readonly-session-notice')).toBeTruthy();
    expect(screen.queryByTestId('chat-composer-textarea')).toBeNull();
  });
});
