// @vitest-environment jsdom
import React, { useState } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { sendWithImmediateAssistantFeedback } from '../../../src/renderer/components/ChatView';
import { StreamingIndicator } from '../../../src/renderer/components/features/chat/StreamingIndicator';

function PendingSendHarness({ send }: { send: () => Promise<boolean> }) {
  const [pendingSince, setPendingSince] = useState<number | null>(null);

  return (
    <div>
      <button
        type="button"
        onClick={() => {
          void sendWithImmediateAssistantFeedback({
            showFeedback: () => setPendingSince(Date.now()),
            clearFeedback: () => setPendingSince(null),
            send,
          });
        }}
      >
        发送
      </button>
      {pendingSince !== null && (
        <div data-testid="assistant-send-placeholder">
          <StreamingIndicator startTime={pendingSince} preparationPhase="submitting" />
        </div>
      )}
    </div>
  );
}

describe('ChatView first-turn assistant feedback', () => {
  it('renders non-empty assistant feedback immediately while the send action is still awaiting its first event', () => {
    const send = vi.fn(() => new Promise<boolean>(() => {}));
    render(<PendingSendHarness send={send} />);

    fireEvent.click(screen.getByRole('button', { name: '发送' }));

    expect(send).toHaveBeenCalledOnce();
    const placeholder = screen.getByTestId('assistant-send-placeholder');
    expect(placeholder.textContent?.trim()).toBe('正在发送消息…');
    expect(screen.getAllByTestId('assistant-send-placeholder')).toHaveLength(1);
  });

  it('removes the local signal when auth or model configuration rejects the send', async () => {
    const send = vi.fn(async () => false);
    render(<PendingSendHarness send={send} />);

    fireEvent.click(screen.getByRole('button', { name: '发送' }));

    await waitFor(() => {
      expect(screen.queryByTestId('assistant-send-placeholder')).toBeNull();
    });
  });
});
