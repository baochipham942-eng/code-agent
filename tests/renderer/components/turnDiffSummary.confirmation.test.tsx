// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { TraceTurn } from '../../../src/shared/contract/trace';
import { IPC_CHANNELS, IPC_DOMAINS } from '../../../src/shared/ipc';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  invokeDomain: vi.fn(),
}));
const toastError = vi.hoisted(() => vi.fn());

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    invoke: mocks.invoke,
    invokeDomain: mocks.invokeDomain,
  },
}));
vi.mock('../../../src/renderer/hooks/useToast', () => ({
  toast: { error: toastError },
}));
vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  return { useI18n: () => ({ t: zh, language: 'zh' }) };
});

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
  mocks.invoke.mockReset();
  mocks.invokeDomain.mockReset();
  toastError.mockReset();
  useSessionStore.setState({ currentSessionId: 'session-1' });
  mocks.invoke.mockResolvedValueOnce([
    { id: 'cp-1', messageId: 'message-1', timestamp: 120, fileCount: 1 },
  ]);
});

afterEach(cleanup);

describe('TurnDiffSummary undo confirmation', () => {
  it('waits for confirmation before rewinding all changed files', async () => {
    mocks.invokeDomain.mockResolvedValueOnce({
      success: true,
      restoredFileCount: 1,
      deletedFileCount: 0,
      workspaceChanged: true,
      conversationChanged: false,
    });
    render(<TurnDiffSummary turn={turn} />);

    const undo = await screen.findByRole('button', { name: '撤销' });
    await waitFor(() => expect(undo.getAttribute('disabled')).toBeNull());
    fireEvent.click(undo);

    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    expect(mocks.invokeDomain).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    expect(mocks.invokeDomain).not.toHaveBeenCalled();

    fireEvent.click(undo);
    fireEvent.click(screen.getByRole('button', { name: /撤销变更/ }));
    await waitFor(() => {
      expect(mocks.invokeDomain).toHaveBeenCalledWith(
        IPC_DOMAINS.SESSION,
        'restoreWorkspaceFilesAtCheckpoint',
        {
          sessionId: 'session-1',
          checkpointMessageId: 'message-1',
        },
      );
    });
    expect(mocks.invoke).not.toHaveBeenCalledWith(
      IPC_CHANNELS.CHECKPOINT_REWIND,
      expect.anything(),
      expect.anything(),
    );
  });

  it('keeps a retry action and reports the rewind error', async () => {
    mocks.invokeDomain.mockRejectedValueOnce(new Error('disk busy'));
    render(<TurnDiffSummary turn={turn} />);

    const undo = await screen.findByRole('button', { name: '撤销' });
    await waitFor(() => expect(undo.getAttribute('disabled')).toBeNull());
    fireEvent.click(undo);
    fireEvent.click(screen.getByRole('button', { name: /撤销变更/ }));

    expect(await screen.findByRole('button', { name: /重试/ })).toBeTruthy();
    expect(toastError).toHaveBeenCalledWith(expect.stringContaining('disk busy'));
  });
});

// ----------------------------------------------------------------------------
// 这张卡是一屏里唯一真的动了用户电脑的东西，所以它说的话要经得起看：
// 新建的文件不能说成「已修改」，路径不能是一长条与本次改动无关的前缀。
// ----------------------------------------------------------------------------
describe('TurnDiffSummary 说人话', () => {
  it('新建文件也说「已编辑」，不说「已修改」', async () => {
    render(<TurnDiffSummary turn={turn} />);

    await screen.findByRole('button', { name: '撤销' });
    expect(document.body.textContent).toContain('已编辑 1 个文件');
    expect(document.body.textContent).not.toContain('已修改');
  });

  it('路径相对当前工作目录显示，完整路径退到 title', async () => {
    useSessionStore.setState({
      currentSessionId: 'session-1',
      sessions: [{ id: 'session-1', workingDirectory: '/tmp' }] as never,
    });
    render(<TurnDiffSummary turn={turn} />);

    await screen.findByRole('button', { name: '撤销' });
    const pathNode = screen.getByTitle('/tmp/example.ts');
    expect(pathNode.textContent).toContain('example.ts');
    // 工作目录前缀不该出现在正文里——它占满整行却与这次改动无关
    expect(pathNode.textContent).not.toContain('/tmp/');
  });
});
