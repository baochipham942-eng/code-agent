// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_DOMAINS } from '../../../src/shared/ipc';

const mocks = vi.hoisted(() => ({
  invokeDomain: vi.fn(),
}));

// DomainInvokeError 取真类：组件用 instanceof 判定，mock 里换个同名壳会让判定恒假、测试假绿。
vi.mock('../../../src/renderer/services/ipcService', async () => {
  const actual = await vi.importActual<typeof import('../../../src/renderer/services/ipcService')>(
    '../../../src/renderer/services/ipcService',
  );
  return {
    default: { invokeDomain: mocks.invokeDomain },
    DomainInvokeError: actual.DomainInvokeError,
  };
});

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
        messages: [
          { ordinal: 0, entryId: 'e1', projectedMessageId: 'u1', sourceSessionId: 'session-1', sourceMessageId: 'u1', aliasKind: 'native', message: { id: 'u1', role: 'user', content: '最初的问题', timestamp: 1 } },
        ],
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
        state: 'success',
        done: ['workspace', 'conversation', 'note'],
        failed: [],
        skippedFiles: [],
        restoredFiles: ['/workspace/a.ts'],
        deletedFiles: [],
        staleEvidenceCount: 0,
        redoAvailable: false,
        externalSideEffectsWarning: 'Changes caused by external commands are not rolled back.',
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

    expect((await screen.findByRole('status')).textContent).toContain('已回到「最初的问题」');
    expect(mocks.invokeDomain).toHaveBeenNthCalledWith(
      1,
      IPC_DOMAINS.SESSION,
      'replayConversationBranch',
      {
        sessionId: 'session-1',
        options: { includeRewound: false },
      },
    );

    fireEvent.click(screen.getByRole('button', { name: '反悔' }));

    await waitFor(() => {
      expect(mocks.invokeDomain).toHaveBeenNthCalledWith(
        2,
        IPC_DOMAINS.SESSION,
        'turnRedo',
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
      state: 'success',
      done: ['workspace', 'conversation', 'note'],
      failed: [],
      skippedFiles: [],
      restoredFiles: ['/workspace/a.ts'],
      deletedFiles: [],
      staleEvidenceCount: 0,
      redoAvailable: false,
      externalSideEffectsWarning: 'Changes caused by external commands are not rolled back.',
    });
    await waitFor(() => {
      expect(mocks.invokeDomain).toHaveBeenNthCalledWith(
        3,
        IPC_DOMAINS.SESSION,
        'replayConversationBranch',
        {
          sessionId: 'session-1',
          options: { includeRewound: false },
        },
      );
    });
    expect(screen.getByRole('status').getAttribute('data-rewind-phase')).toBe('open');
    expect(screen.getByRole('status').getAttribute('data-rewind-id')).toBe('rewind-older');
    expect(screen.getByRole('button', { name: '反悔' })).toBeTruthy();
  });

  it('成功后短暂展示即可关闭', async () => {
    mocks.invokeDomain
      .mockResolvedValueOnce({
        lineage: {
          branchId: 'branch-1',
          sessionId: 'session-1',
          ownerUserId: null,
          projectId: null,
          rootBranchId: 'branch-1',
          parentBranchId: null,
          forkId: null,
          anchorEntryId: null,
          createdAt: 1,
        },
        messages: [
          { ordinal: 0, entryId: 'e1', projectedMessageId: 'u1', sourceSessionId: 'session-1', sourceMessageId: 'u1', aliasKind: 'native', message: { id: 'u1', role: 'user', content: '最初的问题', timestamp: 1 } },
        ],
        openRewindIds: ['rewind-latest'],
        ledgerEventCount: 4,
      })
      .mockResolvedValueOnce({
        success: true,
        sessionId: 'session-1',
        rewindId: 'rewind-latest',
        restoredMessageCount: 2,
        activeMessages: [],
        state: 'success',
        done: ['conversation'],
        failed: [],
        skippedFiles: [],
        restoredFiles: [],
        deletedFiles: [],
        staleEvidenceCount: 0,
        redoAvailable: false,
        externalSideEffectsWarning: 'Changes caused by external commands are not rolled back.',
      })
      .mockResolvedValueOnce({
        lineage: {
          branchId: 'branch-1',
          sessionId: 'session-1',
          ownerUserId: null,
          projectId: null,
          rootBranchId: 'branch-1',
          parentBranchId: null,
          forkId: null,
          anchorEntryId: null,
          createdAt: 1,
        },
        messages: [],
        openRewindIds: [],
        ledgerEventCount: 5,
      });

    render(
      <ActiveConversationRewindBanner sessionId="session-1" onRestored={vi.fn()} />,
    );
    expect((await screen.findByRole('status')).textContent).toContain('已回到「最初的问题」');
    fireEvent.click(screen.getByRole('button', { name: '反悔' }));
    await waitFor(() => {
      expect(screen.getByRole('status').getAttribute('data-rewind-phase')).toBe('done');
    });
    fireEvent.click(screen.getByTestId('active-conversation-rewind-dismiss'));
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('已恢复的 rewind 再点不报错，横幅进入完成态', async () => {
    mocks.invokeDomain
      .mockResolvedValueOnce({
        lineage: {
          branchId: 'branch-1',
          sessionId: 'session-1',
          ownerUserId: null,
          projectId: null,
          rootBranchId: 'branch-1',
          parentBranchId: null,
          forkId: null,
          anchorEntryId: null,
          createdAt: 1,
        },
        messages: [],
        openRewindIds: ['rewind-latest'],
        ledgerEventCount: 4,
      })
      .mockResolvedValueOnce({
        success: true,
        sessionId: 'session-1',
        rewindId: 'rewind-latest',
        restoredMessageCount: 0,
        activeMessages: [],
        state: 'success',
        done: [],
        failed: [],
        skippedFiles: [],
        restoredFiles: [],
        deletedFiles: [],
        staleEvidenceCount: 0,
        redoAvailable: false,
        externalSideEffectsWarning: 'Changes caused by external commands are not rolled back.',
      })
      .mockResolvedValueOnce({
        lineage: {
          branchId: 'branch-1',
          sessionId: 'session-1',
          ownerUserId: null,
          projectId: null,
          rootBranchId: 'branch-1',
          parentBranchId: null,
          forkId: null,
          anchorEntryId: null,
          createdAt: 1,
        },
        messages: [],
        openRewindIds: [],
        ledgerEventCount: 5,
      });
    const onRestored = vi.fn();
    render(
      <ActiveConversationRewindBanner sessionId="session-1" onRestored={onRestored} />,
    );
    fireEvent.click(await screen.findByRole('button', { name: '反悔' }));
    await waitFor(() => expect(onRestored).toHaveBeenCalled());
    expect(screen.getByRole('status').getAttribute('data-rewind-phase')).toBe('done');
    expect(screen.queryByRole('button', { name: '反悔' })).toBeNull();
  });

  it('部分失败时不进入完成态，反悔入口仍在', async () => {
    mocks.invokeDomain
      .mockResolvedValueOnce({
        lineage: {
          branchId: 'branch-1',
          sessionId: 'session-1',
          ownerUserId: null,
          projectId: null,
          rootBranchId: 'branch-1',
          parentBranchId: null,
          forkId: null,
          anchorEntryId: null,
          createdAt: 1,
        },
        messages: [],
        openRewindIds: ['rewind-latest'],
        ledgerEventCount: 4,
      })
      .mockResolvedValueOnce({
        success: false,
        sessionId: 'session-1',
        rewindId: 'rewind-latest',
        restoredMessageCount: 0,
        activeMessages: [],
        state: 'partial',
        done: [],
        failed: [{ step: 'conversation', reason: 'restore failed' }],
        skippedFiles: [],
        restoredFiles: [],
        deletedFiles: [],
        staleEvidenceCount: 0,
        redoAvailable: true,
        externalSideEffectsWarning: 'Changes caused by external commands are not rolled back.',
      });
    render(
      <ActiveConversationRewindBanner sessionId="session-1" onRestored={vi.fn()} />,
    );
    fireEvent.click(await screen.findByRole('button', { name: '反悔' }));
    await waitFor(() => expect(mocks.invokeDomain).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('status').getAttribute('data-rewind-phase')).toBe('open');
    expect(screen.getByRole('button', { name: '反悔' })).toBeTruthy();
  });

  it('刷新失败且已切会话时，不把新会话横幅写成已反悔', async () => {
    let rejectRefresh: ((error: Error) => void) | undefined;
    mocks.invokeDomain
      .mockResolvedValueOnce({
        lineage: {
          branchId: 'branch-1',
          sessionId: 'session-1',
          ownerUserId: null,
          projectId: null,
          rootBranchId: 'branch-1',
          parentBranchId: null,
          forkId: null,
          anchorEntryId: null,
          createdAt: 1,
        },
        messages: [],
        openRewindIds: ['rewind-a'],
        ledgerEventCount: 1,
      })
      .mockResolvedValueOnce({
        success: true,
        sessionId: 'session-1',
        rewindId: 'rewind-a',
        restoredMessageCount: 1,
        activeMessages: [],
        state: 'success',
        done: ['conversation'],
        failed: [],
        skippedFiles: [],
        restoredFiles: [],
        deletedFiles: [],
        staleEvidenceCount: 0,
        redoAvailable: false,
        externalSideEffectsWarning: 'Changes caused by external commands are not rolled back.',
      })
      .mockImplementationOnce(() => new Promise((_resolve, reject) => {
        rejectRefresh = reject;
      }))
      .mockResolvedValueOnce({
        lineage: {
          branchId: 'branch-2',
          sessionId: 'session-2',
          ownerUserId: null,
          projectId: null,
          rootBranchId: 'branch-2',
          parentBranchId: null,
          forkId: null,
          anchorEntryId: null,
          createdAt: 2,
        },
        messages: [],
        openRewindIds: ['rewind-b'],
        ledgerEventCount: 1,
      });

    const { rerender } = render(
      <ActiveConversationRewindBanner sessionId="session-1" onRestored={vi.fn()} />,
    );
    fireEvent.click(await screen.findByRole('button', { name: '反悔' }));
    await waitFor(() => expect(mocks.invokeDomain).toHaveBeenCalledTimes(3));
    rerender(
      <ActiveConversationRewindBanner sessionId="session-2" onRestored={vi.fn()} />,
    );
    await waitFor(() => expect(mocks.invokeDomain).toHaveBeenCalledTimes(4));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    rejectRefresh?.(new Error('replay failed'));
    await waitFor(() => expect(warn).toHaveBeenCalled());
    expect(screen.getByRole('status').getAttribute('data-rewind-id')).toBe('rewind-b');
    expect(screen.getByRole('status').getAttribute('data-rewind-phase')).toBe('open');
    expect(screen.getByRole('button', { name: '反悔' })).toBeTruthy();
    warn.mockRestore();
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

  it('treats BRANCH_NOT_FOUND as “this session has no rewind” without logging noise', async () => {
    const { DomainInvokeError } = await import('../../../src/renderer/services/ipcService');
    mocks.invokeDomain.mockRejectedValueOnce(
      new DomainInvokeError('BRANCH_NOT_FOUND', 'BRANCH_NOT_FOUND: no immutable branch exists for session-3'),
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    render(<ActiveConversationRewindBanner sessionId="session-3" onRestored={vi.fn()} />);

    await waitFor(() => expect(mocks.invokeDomain).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('still surfaces genuine read failures (fail-loud 不被上一条顺手关掉)', async () => {
    const { DomainInvokeError } = await import('../../../src/renderer/services/ipcService');
    mocks.invokeDomain.mockRejectedValueOnce(new DomainInvokeError('INTERNAL_ERROR', 'db is on fire'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    render(<ActiveConversationRewindBanner sessionId="session-4" onRestored={vi.fn()} />);

    await waitFor(() => expect(warn).toHaveBeenCalled());
    expect(screen.queryByRole('status')).toBeNull();
    warn.mockRestore();
  });
});
