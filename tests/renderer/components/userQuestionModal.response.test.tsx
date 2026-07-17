// @vitest-environment jsdom

import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UserQuestionRequest } from '../../../src/shared/contract';
import { IPC_CHANNELS } from '../../../src/shared/ipc';
import { UserQuestionModal } from '../../../src/renderer/components/UserQuestionModal';

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    invoke: invokeMock,
  },
}));

function request(): UserQuestionRequest {
  return {
    id: 'question-1',
    sessionId: 'session-1',
    questions: [
      {
        header: '确认',
        question: '要继续吗',
        options: [
          { label: '继续', description: '继续当前操作' },
          { label: '停止', description: '停下等待' },
        ],
      },
    ],
    timestamp: 1,
  };
}

describe('UserQuestionModal response flow', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('submits the response and calls onClose so App can clear pending store state', async () => {
    invokeMock.mockResolvedValue(undefined);
    const onClose = vi.fn();

    render(<UserQuestionModal request={request()} onClose={onClose} />);

    fireEvent.click(screen.getByText('继续'));
    fireEvent.click(screen.getByText('提交回答'));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(IPC_CHANNELS.USER_QUESTION_RESPONSE, {
        requestId: 'question-1',
        answers: { 确认: '继续' },
      });
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });
});
