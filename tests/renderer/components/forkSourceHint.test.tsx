// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  sessions: [] as Array<Record<string, unknown>>,
  language: 'zh' as 'zh' | 'en',
  switchSession: vi.fn(),
  setPendingSearchJump: vi.fn(),
}));

vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  const { en } = await import('../../../src/renderer/i18n/en');
  return {
    useI18n: () => ({
      t: mocks.language === 'zh' ? zh : en,
      language: mocks.language,
    }),
  };
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

const parentSessionId = '4ceba14b-87b3-4b3f-946f-111111111111';
const sourceAnchorMessageId = 'import_external-history_message_assistant_2';

function addForkChild() {
  mocks.sessions.push({
    id: 'child',
    title: '分支任务',
    metadata: {
      forkLineage: {
        forkId: 'fork-1',
        parentSessionId,
        childSessionId: 'child',
        sourceAnchorMessageId,
        status: 'quarantined',
      },
    },
  });
}

function expectNoInternalIds(text: string | null) {
  for (const internalId of ['import_external-history', 'message_', parentSessionId, sourceAnchorMessageId]) {
    expect(text).not.toContain(internalId);
  }
}

beforeEach(() => {
  mocks.sessions.splice(0);
  mocks.language = 'zh';
  mocks.switchSession.mockReset();
  mocks.switchSession.mockResolvedValue(undefined);
  mocks.setPendingSearchJump.mockReset();
});

afterEach(cleanup);

describe('ForkSourceHint', () => {
  it('stays absent for an ordinary session', () => {
    mocks.sessions.push({ id: 'ordinary', title: '普通任务', metadata: {} });

    const { container } = render(<ForkSourceHint sessionId="ordinary" />);

    expect(container.innerHTML).toBe('');
  });

  it('shows an ordinary fork without internal ids', () => {
    mocks.sessions.push({ id: parentSessionId, title: '父会话标题', metadata: {} });
    addForkChild();

    render(<ForkSourceHint sessionId="child" />);

    const source = screen.getByRole('button', { name: '由此分支 · 父会话标题' });
    expectNoInternalIds(source.textContent);
  });

  it.each([
    ['claude_code', 'Claude Code'],
    ['codex_cli', 'Codex'],
  ])('shows the %s import source and navigates to the exact anchor', async (engineKind, sourceName) => {
    mocks.sessions.push({
      id: parentSessionId,
      title: '父会话标题',
      origin: { kind: 'import' },
      engine: { kind: engineKind },
      metadata: {},
    });
    addForkChild();

    render(<ForkSourceHint sessionId="child" />);

    const source = screen.getByRole('button', {
      name: `续接自 ${sourceName} 导入的对话 · 父会话标题`,
    });
    expectNoInternalIds(source.textContent);
    expect(source.textContent).not.toContain('隔离');
    expect(source.textContent).not.toContain('失败');

    fireEvent.click(source);

    expect(mocks.setPendingSearchJump).toHaveBeenCalledWith({
      sessionId: parentSessionId,
      messageId: sourceAnchorMessageId,
      query: '',
      createdAt: expect.any(Number),
    });
    await waitFor(() => expect(mocks.switchSession).toHaveBeenCalledWith(parentSessionId));
  });

  it.each([
    ['zh', '由此分支 · 原对话'],
    ['en', 'Branched from · the original chat'],
  ] as const)('uses the %s fallback when the parent title is unavailable', (language, label) => {
    mocks.language = language;
    addForkChild();

    render(<ForkSourceHint sessionId="child" />);

    const source = screen.getByRole('button', { name: label });
    expectNoInternalIds(source.textContent);
  });
});
