// @vitest-environment jsdom
import React, { useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionWithMeta } from '../../../src/renderer/stores/sessionStore';
import { SidebarSearchDialog } from '../../../src/renderer/components/features/sidebar/SidebarSearchDialog';

vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  return { useI18n: () => ({ t: zh, language: 'zh' }) };
});

const sessions = [
  {
    id: 'session-message-hit',
    title: '不相关标题',
    modelConfig: { provider: 'openai', model: 'gpt-5.4' },
    createdAt: 100,
    updatedAt: 200,
    status: 'idle',
    messageCount: 3,
    turnCount: 2,
  },
  {
    id: 'session-recent',
    title: '最近任务',
    modelConfig: { provider: 'openai', model: 'gpt-5.4' },
    createdAt: 50,
    updatedAt: 150,
    status: 'idle',
    messageCount: 1,
    turnCount: 1,
  },
] as SessionWithMeta[];

const messageHits = {
  'session-message-hit': {
    sessionId: 'session-message-hit',
    bestHit: {
      sessionId: 'session-message-hit',
      messageId: 'message-1',
      snippet: '正文里的关键字',
      messagePositionLabel: '第 2 轮',
      role: 'user' as const,
      timestamp: 190,
      matchCount: 1,
      relevance: 0.9,
    },
    hits: [],
    totalHitCount: 4,
  },
};

afterEach(cleanup);

describe('SidebarSearchDialog', () => {
  it('shows message-hit counts and moves the search scope controls into the dialog', () => {
    render(
      <SidebarSearchDialog
        isOpen
        query="关键字"
        onQueryChange={vi.fn()}
        onClose={vi.fn()}
        sessions={sessions}
        currentSessionId={null}
        messageSearchHitsBySessionId={messageHits}
        messageSearchLoading={false}
        effectiveSearchScope="current-project"
        setSearchScope={vi.fn()}
        canSearchCurrentProject
        onSelectSession={vi.fn()}
      />,
    );

    expect(screen.queryByText('不相关标题')).not.toBeNull();
    expect(screen.queryByText('命中 4 条消息')).not.toBeNull();
    expect(screen.queryByRole('button', { name: '当前项目' })).not.toBeNull();
    expect(screen.queryByRole('button', { name: '全部' })).not.toBeNull();
    expect(
      screen.getByRole('textbox', { name: '搜索会话标题与消息内容' }).getAttribute('type'),
    ).toBe('text');
  });

  it('selects a session and conditionally removes the dialog from the DOM', async () => {
    const onSelect = vi.fn();
    const Harness = () => {
      const [open, setOpen] = useState(true);
      return (
        <SidebarSearchDialog
          isOpen={open}
          query=""
          onQueryChange={vi.fn()}
          onClose={() => setOpen(false)}
          sessions={sessions}
          currentSessionId={null}
          messageSearchHitsBySessionId={{}}
          messageSearchLoading={false}
          effectiveSearchScope="all"
          setSearchScope={vi.fn()}
          canSearchCurrentProject
          onSelectSession={(sessionId) => {
            onSelect(sessionId);
            setOpen(false);
          }}
        />
      );
    };

    render(<Harness />);
    fireEvent.click(screen.getByRole('option', { name: /最近任务/ }));

    expect(onSelect).toHaveBeenCalledWith('session-recent');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('supports arrow-key selection and Enter navigation', () => {
    const onSelect = vi.fn();
    render(
      <SidebarSearchDialog
        isOpen
        query=""
        onQueryChange={vi.fn()}
        onClose={vi.fn()}
        sessions={sessions}
        currentSessionId={null}
        messageSearchHitsBySessionId={{}}
        messageSearchLoading={false}
        effectiveSearchScope="all"
        setSearchScope={vi.fn()}
        canSearchCurrentProject
        onSelectSession={onSelect}
      />,
    );

    const input = screen.getByRole('textbox', { name: '搜索会话标题与消息内容' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onSelect).toHaveBeenCalledWith('session-recent');
  });
});
