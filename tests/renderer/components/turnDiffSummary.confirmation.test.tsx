// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { TraceTurn } from '../../../src/shared/contract/trace';
import { IPC_CHANNELS } from '../../../src/shared/ipc';

const invoke = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invoke },
}));
vi.mock('../../../src/renderer/hooks/useToast', () => ({
  toast: { error: toastError },
}));

import { TurnDiffSummary } from '../../../src/renderer/components/features/chat/MessageBubble/TurnDiffSummary';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';

const turn = {
  turnNumber: 1,
  turnId: 'turn-1',
  status: 'completed',
  startTime: 100,
  endTime: 200,
  nodes: [
    {
      id: 'tool-1',
      type: 'tool_call',
      content: '',
      timestamp: 150,
      toolCall: {
        id: 'tool-1',
        name: 'Write',
        args: { file_path: '/tmp/example.ts', content: 'export const value = 1;' },
        result: 'Created file: /tmp/example.ts',
        success: true,
      },
    },
  ],
} satisfies TraceTurn;

beforeEach(() => {
  invoke.mockReset();
  toastError.mockReset();
  useSessionStore.setState({ currentSessionId: 'session-1' });
  invoke.mockResolvedValueOnce([
    { id: 'cp-1', messageId: 'message-1', timestamp: 120, fileCount: 1 },
  ]);
});

afterEach(cleanup);

describe('TurnDiffSummary undo confirmation', () => {
  it('waits for confirmation before rewinding all changed files', async () => {
    invoke.mockResolvedValueOnce({ success: true, filesRestored: 1 });
    render(<TurnDiffSummary turn={turn} />);

    const undo = await screen.findByRole('button', { name: 'Undo' });
    await waitFor(() => expect(undo.getAttribute('disabled')).toBeNull());
    fireEvent.click(undo);

    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(invoke).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(invoke).toHaveBeenCalledTimes(1);

    fireEvent.click(undo);
    fireEvent.click(screen.getByRole('button', { name: /撤销变更/ }));
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        IPC_CHANNELS.CHECKPOINT_REWIND,
        'session-1',
        'message-1',
      );
    });
  });

  it('keeps a retry action and reports the rewind error', async () => {
    invoke.mockResolvedValueOnce({ success: false, filesRestored: 0, error: 'disk busy' });
    render(<TurnDiffSummary turn={turn} />);

    const undo = await screen.findByRole('button', { name: 'Undo' });
    await waitFor(() => expect(undo.getAttribute('disabled')).toBeNull());
    fireEvent.click(undo);
    fireEvent.click(screen.getByRole('button', { name: /撤销变更/ }));

    expect(await screen.findByRole('button', { name: /重试/ })).toBeTruthy();
    expect(toastError).toHaveBeenCalledWith(expect.stringContaining('disk busy'));
  });
});
