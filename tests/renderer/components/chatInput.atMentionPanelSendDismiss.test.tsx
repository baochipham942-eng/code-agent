// @vitest-environment jsdom
//
// FB-586 收尾半：提交发送清空草稿走的是 setValue('')，不经 handleValueChange，
// @ 触发面板因此留在原地，盖住随后的「需要你的回答」确认卡。发送清草稿后面板必须关掉。

import React from 'react';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatInput } from '../../../src/renderer/components/features/chat/ChatInput';
import { IPC_DOMAINS } from '../../../src/shared/ipc';
import ipcService from '../../../src/renderer/services/ipcService';
import { useBundledCapabilityStore } from '../../../src/renderer/stores/bundledCapabilityStore';
import { useSessionStore, type SessionWithMeta } from '../../../src/renderer/stores/sessionStore';

const realCreateSession = useSessionStore.getState().createSession;

function makeSession(id: string): SessionWithMeta {
  return {
    id,
    title: id,
    modelConfig: { provider: 'openai', model: 'gpt-5' },
    createdAt: 1,
    updatedAt: 1,
    messageCount: 0,
    turnCount: 0,
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

describe('@ 面板随发送关闭（FB-586）', () => {
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

  function typeAtTrigger(container: HTMLElement): void {
    // window.domainAPI 在 jsdom 下不存在 → listWorkspaceFiles 抛错 → catch 分支
    // 仍 setIsOpen(true)：面板开着但 0 行，正是 FB-586 的可达状态。
    const editor = container.querySelector('[data-testid="chat-composer-textarea"]') as HTMLElement;
    editor.replaceChildren(document.createTextNode('@'));
    fireEvent.input(editor);
  }

  it('面板开着时提交发送：草稿清空后面板不再渲染', async () => {
    useSessionStore.setState({
      sessions: [makeSession('s-mention-1')],
      currentSessionId: 's-mention-1',
      messages: [],
      createSession: realCreateSession,
    });
    const onSend = vi.fn(async () => true);
    const { container } = render(<ChatInput onSend={onSend} />);

    typeAtTrigger(container);
    await waitFor(() => {
      expect(container.querySelector('[data-at-mention-popover]')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.submit(container.querySelector('form')!);
    });
    expect(onSend).toHaveBeenCalledTimes(1);

    await waitFor(() => {
      expect(container.querySelector('[data-at-mention-popover]')).toBeNull();
    });
  });
});
