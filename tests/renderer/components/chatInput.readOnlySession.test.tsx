// @vitest-environment jsdom
//
// 只读会话的输入区换成出路提示；筛选条不再列出从未写入的 subagent 类型。

import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatInput } from '../../../src/renderer/components/features/chat/ChatInput';
import {
  getSessionTypeLabel,
  SessionTypeFilterBar,
} from '../../../src/renderer/components/features/sidebar/SessionTypeFilterBar';
import { IPC_DOMAINS } from '../../../src/shared/ipc';
import ipcService from '../../../src/renderer/services/ipcService';
import { useBundledCapabilityStore } from '../../../src/renderer/stores/bundledCapabilityStore';
import { useSessionStore, type SessionWithMeta } from '../../../src/renderer/stores/sessionStore';

const realCreateSession = useSessionStore.getState().createSession;

function makeSession(id: string, readOnly?: boolean): SessionWithMeta {
  return {
    id,
    title: id,
    modelConfig: { provider: 'openai', model: 'gpt-5' },
    createdAt: 1,
    updatedAt: 1,
    messageCount: 0,
    turnCount: 0,
    ...(readOnly === undefined ? {} : { readOnly }),
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

function showSession(session: SessionWithMeta, createSession = realCreateSession): void {
  useSessionStore.setState({
    sessions: [session],
    currentSessionId: session.id,
    messages: [],
    createSession,
  });
}

describe('只读会话输入框', () => {
  beforeEach(() => {
    resetCapabilityStore();
    const invokeDomain = ipcService.invokeDomain.bind(ipcService);
    vi.spyOn(ipcService, 'invokeDomain').mockImplementation((domain, action, payload) => {
      if (domain === IPC_DOMAINS.QUEUED_INPUT && action === 'list') return Promise.resolve([]);
      return invokeDomain(domain, action, payload);
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    useSessionStore.setState({
      sessions: [],
      currentSessionId: null,
      messages: [],
      createSession: realCreateSession,
    });
    resetCapabilityStore();
  });

  it('readOnly 为 true 时渲染提示和按钮，不渲染输入区', () => {
    showSession(makeSession('ro-true', true));
    render(<ChatInput onSend={() => true} />);

    expect(screen.getByTestId('readonly-session-notice').textContent).toContain('这个会话是只读的，不能在这里继续输入。');
    expect(screen.getByTestId('readonly-session-new').textContent).toContain('新开会话继续');
    expect(screen.queryByTestId('chat-composer-textarea')).toBeNull();
  });

  it('点击「新开会话继续」只调用一次 createSession', () => {
    const createSession = vi.fn(async () => null);
    showSession(makeSession('ro-click', true), createSession);
    render(<ChatInput onSend={() => true} />);

    fireEvent.click(screen.getByTestId('readonly-session-new'));

    expect(createSession).toHaveBeenCalledTimes(1);
  });

  it('readOnly 为 false 时渲染输入区，没有只读提示', () => {
    showSession(makeSession('ro-false', false));
    render(<ChatInput onSend={() => true} />);

    expect(screen.getByTestId('chat-composer-textarea')).toBeTruthy();
    expect(screen.queryByTestId('readonly-session-notice')).toBeNull();
  });

  it('没有 readOnly 字段时渲染输入区，没有只读提示', () => {
    showSession(makeSession('ro-absent'));
    render(<ChatInput onSend={() => true} />);

    expect(screen.getByTestId('chat-composer-textarea')).toBeTruthy();
    expect(screen.queryByTestId('readonly-session-notice')).toBeNull();
  });
});

describe('会话类型筛选条去掉 subagent', () => {
  afterEach(() => cleanup());

  it('getSessionTypeLabel(subagent) 为 null，筛选条没有 subagent', () => {
    expect(getSessionTypeLabel('subagent')).toBeNull();
    expect(getSessionTypeLabel('schedule')).toBe('Schedule');
    expect(getSessionTypeLabel('heartbeat')).toBe('Heartbeat');

    render(<SessionTypeFilterBar value="all" onChange={() => {}} />);
    const labels = screen.getAllByRole('button').map((button) => button.textContent ?? '');
    expect(labels.some((label) => label.toLowerCase().includes('subagent'))).toBe(false);
    expect(labels).toEqual(['全部', 'Chat', 'Schedule', 'Heartbeat']);
  });
});
