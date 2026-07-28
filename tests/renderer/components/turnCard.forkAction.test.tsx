// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TraceTurn } from '../../../src/shared/contract/trace';

const mocks = vi.hoisted(() => ({
  createForkFromReply: vi.fn(),
}));

vi.mock('../../../src/renderer/stores/messageActionStore', () => ({
  useMessageActionStore: (selector: (state: Record<string, unknown>) => unknown) => selector({
    createForkFromReply: mocks.createForkFromReply,
    sendPrompt: vi.fn(),
  }),
}));

import { TurnCard } from '../../../src/renderer/components/features/chat/TurnCard';

function completedTurn(status: TraceTurn['status'] = 'completed'): TraceTurn {
  return {
    turnId: 'turn-2',
    turnNumber: 2,
    status,
    startTime: 1_000,
    endTime: status === 'completed' ? 2_000 : undefined,
    nodes: [
      { id: 'u2', type: 'user', content: '第二问', timestamp: 1_000 },
      {
        id: 'a2-text',
        messageId: 'a2',
        type: 'assistant_text',
        content: '第二答',
        timestamp: 2_000,
        feedbackEligible: true,
      },
    ],
  } as TraceTurn;
}

describe('TurnCard Fork reply action', () => {
  beforeEach(() => {
    mocks.createForkFromReply.mockReset();
    mocks.createForkFromReply.mockResolvedValue(undefined);
  });

  afterEach(cleanup);

  it('forks a completed assistant reply with shared_current on a single click, anchored to the persisted assistant message', async () => {
    render(<TurnCard turn={completedTurn()} sessionId="source-session" />);

    fireEvent.click(screen.getByRole('button', { name: '从这条回复创建分支' }));

    await waitFor(() => expect(mocks.createForkFromReply).toHaveBeenCalledWith('a2', 'shared_current'));
  });

  it('keeps the Fork action visible but disabled while the source session is processing', () => {
    render(
      <TurnCard
        turn={completedTurn()}
        sessionId="source-session"
        isSessionProcessing={true}
      />,
    );

    const button = screen.getByRole('button', { name: '从这条回复创建分支' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(button);
    expect(mocks.createForkFromReply).not.toHaveBeenCalled();
  });

  it('does not offer Fork before the assistant reply is completed', () => {
    render(<TurnCard turn={completedTurn('streaming')} sessionId="source-session" />);

    expect(screen.queryByRole('button', { name: '从这条回复创建分支' })).toBeNull();
  });

  it('places compact source context immediately before the first user message', () => {
    render(
      <TurnCard
        turn={completedTurn()}
        sessionId="source-session"
        beforeUserMessage={<div data-testid="fork-source-hint">由此分支</div>}
      />,
    );

    const hint = screen.getByTestId('fork-source-hint');
    const userMessage = screen.getByText('第二问');
    expect(hint.compareDocumentPosition(userMessage) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBeTruthy();
  });
});
