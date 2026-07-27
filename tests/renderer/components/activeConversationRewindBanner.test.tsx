// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_DOMAINS } from '../../../src/shared/ipc';

const mocks = vi.hoisted(() => ({
  invokeDomain: vi.fn(),
}));

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    invokeDomain: mocks.invokeDomain,
  },
}));

vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  return { useI18n: () => ({ t: zh, language: 'zh' }) };
});

import { ActiveConversationRewindBanner } from '../../../src/renderer/components/features/chat/ActiveConversationRewindBanner';

describe('ActiveConversationRewindBanner', () => {
  beforeEach(() => {
    mocks.invokeDomain.mockReset();
  });

  afterEach(() => cleanup());

  it('reloads durable rewind state on mount and restores the latest open rewind explicitly', async () => {
    mocks.invokeDomain
      .mockResolvedValueOnce({
        lineage: {
          branchId: 'branch-1',
          sessionId: 'session-1',
          ownerUserId: null,
          projectId: null,
          rootBranchId: 'branch-1',
          parentBranchId: null,
          parentSessionId: null,
          forkId: null,
          anchorEntryId: null,
          createdAt: 1,
        },
        messages: [],
        openRewindIds: ['rewind-older', 'rewind-latest'],
        ledgerEventCount: 4,
      })
      .mockResolvedValueOnce({
        success: true,
        sessionId: 'session-1',
        rewindId: 'rewind-latest',
        restoredMessageCount: 2,
        activeMessages: [{
          id: 'u2',
          role: 'user',
          content: '继续',
          timestamp: 2,
        }],
        workspaceChanged: false,
      })
      .mockResolvedValueOnce({
        lineage: {
          branchId: 'branch-1',
          sessionId: 'session-1',
          ownerUserId: null,
          projectId: null,
          rootBranchId: 'branch-1',
          parentBranchId: null,
          parentSessionId: null,
          forkId: null,
          anchorEntryId: null,
          createdAt: 1,
        },
        messages: [],
        openRewindIds: ['rewind-older'],
        ledgerEventCount: 5,
      });
    const onRestored = vi.fn();

    render(
      <ActiveConversationRewindBanner
        sessionId="session-1"
        onRestored={onRestored}
      />,
    );

    expect((await screen.findByRole('status')).textContent).toContain('已回退到这条提示词');
    expect(mocks.invokeDomain).toHaveBeenNthCalledWith(
      1,
      IPC_DOMAINS.SESSION,
      'replayConversationBranch',
      {
        sessionId: 'session-1',
        options: { includeRewound: true },
      },
    );

    fireEvent.click(screen.getByRole('button', { name: '恢复对话' }));

    await waitFor(() => {
      expect(mocks.invokeDomain).toHaveBeenNthCalledWith(
        2,
        IPC_DOMAINS.SESSION,
        'restoreConversationRewind',
        {
          sessionId: 'session-1',
          rewindId: 'rewind-latest',
        },
      );
    });
    expect(onRestored).toHaveBeenCalledWith({
      success: true,
      sessionId: 'session-1',
      rewindId: 'rewind-latest',
      restoredMessageCount: 2,
      activeMessages: [{
        id: 'u2',
        role: 'user',
        content: '继续',
        timestamp: 2,
      }],
      workspaceChanged: false,
    });
    await waitFor(() => {
      expect(mocks.invokeDomain).toHaveBeenNthCalledWith(
        3,
        IPC_DOMAINS.SESSION,
        'replayConversationBranch',
        {
          sessionId: 'session-1',
          options: { includeRewound: true },
        },
      );
    });
    expect(screen.getByRole('status')).toBeTruthy();
  });

  it('does not leak a late replay result after switching sessions', async () => {
    let resolveFirst: ((value: unknown) => void) | undefined;
    mocks.invokeDomain
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolveFirst = resolve;
      }))
      .mockResolvedValueOnce({
        lineage: {
          branchId: 'branch-2',
          sessionId: 'session-2',
          ownerUserId: null,
          projectId: null,
          rootBranchId: 'branch-2',
          parentBranchId: null,
          parentSessionId: null,
          forkId: null,
          anchorEntryId: null,
          createdAt: 2,
        },
        messages: [],
        openRewindIds: [],
        ledgerEventCount: 1,
      });

    const { rerender } = render(
      <ActiveConversationRewindBanner sessionId="session-1" onRestored={vi.fn()} />,
    );
    rerender(
      <ActiveConversationRewindBanner sessionId="session-2" onRestored={vi.fn()} />,
    );

    await waitFor(() => expect(mocks.invokeDomain).toHaveBeenCalledTimes(2));
    resolveFirst?.({
      lineage: {
        branchId: 'branch-1',
        sessionId: 'session-1',
        ownerUserId: null,
        projectId: null,
        rootBranchId: 'branch-1',
        parentBranchId: null,
        parentSessionId: null,
        forkId: null,
        anchorEntryId: null,
        createdAt: 1,
      },
      messages: [],
      openRewindIds: ['stale-rewind'],
      ledgerEventCount: 2,
    });

    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
  });
});
