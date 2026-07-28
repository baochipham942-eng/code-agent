// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  sessions: [] as Array<Record<string, unknown>>,
  switchSession: vi.fn(),
  setPendingSearchJump: vi.fn(),
}));

vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  return { useI18n: () => ({ t: zh, language: 'zh' }) };
});

vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: (selector: (state: Record<string, unknown>) => unknown) => selector({
    sessions: mocks.sessions,
    switchSession: mocks.switchSession,
  }),
}));

vi.mock('../../../src/renderer/stores/sessionUIStore', () => ({
  useSessionUIStore: (selector: (state: Record<string, unknown>) => unknown) => selector({
    setPendingSearchJump: mocks.setPendingSearchJump,
  }),
}));

import { ForkSourceHint } from '../../../src/renderer/components/features/chat/ForkSourceHint';

beforeEach(() => {
  mocks.sessions.splice(0);
  mocks.switchSession.mockReset();
  mocks.switchSession.mockResolvedValue(undefined);
  mocks.setPendingSearchJump.mockReset();
});

afterEach(cleanup);

describe('ForkSourceHint', () => {
  it('stays absent for an ordinary session', () => {
    mocks.sessions.push({
      id: 'ordinary',
      title: '普通任务',
      metadata: {},
    });

    const { container } = render(<ForkSourceHint sessionId="ordinary" />);

    expect(container.innerHTML).toBe('');
  });

  it('shows only the compact parent source and navigates to its exact anchor', async () => {
    mocks.sessions.push(
      {
        id: 'parent',
        title: '父会话标题',
        metadata: {},
      },
      {
        id: 'child',
        title: '分支任务',
        metadata: {
          forkLineage: {
            forkId: 'fork-1',
            parentSessionId: 'parent',
            childSessionId: 'child',
            sourceAnchorMessageId: 'a2',
            status: 'quarantined',
          },
        },
      },
    );

    render(<ForkSourceHint sessionId="child" />);

    const source = screen.getByRole('button', { name: /父会话标题.*a2/ });
    expect(source.textContent).toContain('由此分支');
    expect(source.textContent).toContain('父会话标题');
    expect(source.textContent).toContain('a2');
    expect(source.textContent).not.toContain('隔离');
    expect(source.textContent).not.toContain('失败');

    fireEvent.click(source);

    expect(mocks.setPendingSearchJump).toHaveBeenCalledWith({
      sessionId: 'parent',
      messageId: 'a2',
      query: '',
      createdAt: expect.any(Number),
    });
    await waitFor(() => expect(mocks.switchSession).toHaveBeenCalledWith('parent'));
  });
});
