// @vitest-environment jsdom
import React, { useState } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  sendWithImmediateAssistantFeedback,
  transitionAssistantFeedback,
  type AssistantFeedbackState,
} from '../../../src/renderer/utils/sendWithImmediateAssistantFeedback';
import { StreamingIndicator } from '../../../src/renderer/components/features/chat/StreamingIndicator';

function PendingSendHarness({ send }: { send: () => Promise<boolean> }) {
  const [feedback, setFeedback] = useState<AssistantFeedbackState | null>(null);
  const clientMessageId = 'message-1';
  const sessionId = 'session-1';

  return (
    <div>
      <button
        type="button"
        onClick={() => {
          void sendWithImmediateAssistantFeedback({
            showFeedback: () => setFeedback((current) => transitionAssistantFeedback(current, {
              type: 'send_started',
              startedAt: Date.now(),
              clientMessageId,
              sessionId,
            })),
            clearFeedback: () => setFeedback((current) => transitionAssistantFeedback(current, {
              type: 'send_failed',
              clientMessageId,
              sessionId,
            })),
            send,
          });
        }}
      >
        发送
      </button>
      <button type="button" onClick={() => setFeedback((current) => transitionAssistantFeedback(current, {
        type: 'enqueue_succeeded', clientMessageId, sessionId,
      }))}>enqueue 成功</button>
      <button type="button" onClick={() => setFeedback((current) => transitionAssistantFeedback(current, {
        type: 'durable_activated', clientMessageId, sessionId,
      }))}>durable 激活</button>
      <button type="button" onClick={() => setFeedback((current) => transitionAssistantFeedback(current, {
        type: 'model_delta', sessionId,
      }))}>首个 delta</button>
      {feedback !== null && (
        <div data-testid="assistant-send-placeholder">
          <StreamingIndicator
            startTime={feedback.startedAt}
            preparationPhase={feedback.phase === 'submitting'
              ? 'submitting'
              : feedback.phase === 'queued' ? 'queued' : undefined}
            waitingReason={feedback.phase === 'waiting_model' ? 'model' : undefined}
          />
        </div>
      )}
    </div>
  );
}

describe('ChatView first-turn assistant feedback', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

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

  it('advances one placeholder only after enqueue, durable activation, and first model delta events', () => {
    vi.useFakeTimers();
    const send = vi.fn(() => new Promise<boolean>(() => {}));
    render(<PendingSendHarness send={send} />);

    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    vi.advanceTimersByTime(20_000);
    expect(screen.getByTestId('assistant-send-placeholder').textContent).toContain('正在发送消息…');

    fireEvent.click(screen.getByRole('button', { name: 'enqueue 成功' }));
    expect(screen.getByTestId('assistant-send-placeholder').textContent).toContain('已排队，正在启动…');
    expect(screen.getAllByTestId('assistant-send-placeholder')).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: 'durable 激活' }));
    expect(screen.getByTestId('assistant-send-placeholder').textContent).toContain('信号传输中，正在等待模型回响…');
    expect(screen.getAllByTestId('assistant-send-placeholder')).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: '首个 delta' }));
    expect(screen.queryByTestId('assistant-send-placeholder')).toBeNull();
  });

  it('does not regress to queued copy when the activation event wins the cross-process race', () => {
    const send = vi.fn(() => new Promise<boolean>(() => {}));
    render(<PendingSendHarness send={send} />);

    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    fireEvent.click(screen.getByRole('button', { name: 'durable 激活' }));
    fireEvent.click(screen.getByRole('button', { name: 'enqueue 成功' }));

    expect(screen.getByTestId('assistant-send-placeholder').textContent).toContain('信号传输中，正在等待模型回响…');
  });
});
