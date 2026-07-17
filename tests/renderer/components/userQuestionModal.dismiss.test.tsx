// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invoke: invokeMock },
}));

import { UserQuestionModal } from '../../../src/renderer/components/UserQuestionModal';
import { IPC_CHANNELS } from '../../../src/shared/ipc';
import type { UserQuestionRequest } from '../../../src/shared/contract';

const request: UserQuestionRequest = {
  id: 'question-1',
  timestamp: 1,
  questions: [
    {
      header: 'Choice',
      question: 'Which option?',
      options: [
        { label: 'A', description: 'Option A' },
        { label: 'B', description: 'Option B' },
      ],
    },
  ],
};

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
});

async function expectDeclinedResponse(dismiss: () => void): Promise<void> {
  const onClose = vi.fn();
  render(<UserQuestionModal request={request} onClose={onClose} />);

  dismiss();

  await waitFor(() => {
    expect(invokeMock).toHaveBeenCalledWith(
      IPC_CHANNELS.USER_QUESTION_RESPONSE,
      { requestId: request.id, declined: true },
    );
  });
  expect(invokeMock).toHaveBeenCalledTimes(1);
  expect(onClose).toHaveBeenCalledTimes(1);
}

describe('UserQuestionModal dismissal', () => {
  it('sends a declined response when dismissed with Escape', async () => {
    await expectDeclinedResponse(() => fireEvent.keyDown(document, { key: 'Escape' }));
  });

  it('sends a declined response when dismissed via the backdrop', async () => {
    await expectDeclinedResponse(() => {
      const backdrop = screen.getByRole('dialog').previousElementSibling;
      expect(backdrop).not.toBeNull();
      fireEvent.click(backdrop as Element);
    });
  });

  it('sends a declined response when dismissed via the header close button', async () => {
    await expectDeclinedResponse(() => fireEvent.click(screen.getByRole('button', { name: '关闭' })));
  });

  it('sends a declined response when dismissed via the cancel button', async () => {
    await expectDeclinedResponse(() => fireEvent.click(screen.getByRole('button', { name: '取消' })));
  });
});
