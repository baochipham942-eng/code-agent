// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ForkLineageNavigation } from '../../../src/renderer/components/features/chat/ForkLineageBar';
import type { SessionForkLineageSummary } from '../../../src/shared/contract/sessionFork';

afterEach(() => cleanup());

function lineage(overrides: Partial<SessionForkLineageSummary> = {}): SessionForkLineageSummary {
  return {
    forkId: 'fork-child',
    rootSessionId: 'root',
    parentSessionId: 'parent',
    parentDeleted: false,
    childSessionId: 'current',
    sourceAnchorMessageId: 'a2',
    anchorChildMessageId: 'child-a2',
    depth: 1,
    workspaceMode: 'shared_current',
    contextDeliveryMode: 'neo_native_prefix',
    status: 'completed',
    syncState: 'local_only',
    createdAt: 1,
    ...overrides,
  };
}

describe('ForkLineageNavigation', () => {
  it('navigates to the explicit parent and direct children', () => {
    const onOpenSession = vi.fn();
    render(
      <ForkLineageNavigation
        sessionId="current"
        lineage={lineage()}
        children={[lineage({
          forkId: 'fork-grandchild',
          parentSessionId: 'current',
          childSessionId: 'grandchild',
          depth: 2,
          workspaceMode: 'isolated_at_anchor',
        })]}
        onOpenSession={onOpenSession}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '返回父任务' }));
    fireEvent.click(screen.getByRole('button', { name: '打开分支 1' }));
    expect(onOpenSession).toHaveBeenNthCalledWith(1, 'parent');
    expect(onOpenSession).toHaveBeenNthCalledWith(2, 'grandchild');
  });

  it('does not render for an ordinary session', () => {
    const { container } = render(
      <ForkLineageNavigation
        sessionId="ordinary"
        lineage={null}
        children={[]}
        onOpenSession={vi.fn()}
      />,
    );
    expect(container.innerHTML).toBe('');
  });

  it('keeps an independent child visible while disabling a deleted parent', () => {
    const onOpenSession = vi.fn();
    const onCompareParent = vi.fn();
    render(
      <ForkLineageNavigation
        sessionId="current"
        lineage={lineage({ parentDeleted: true })}
        children={[]}
        onOpenSession={onOpenSession}
        onCompareParent={onCompareParent}
      />,
    );

    expect(screen.getByTestId('fork-parent-deleted').textContent).toBe('父任务已删除');
    expect(screen.queryByRole('button', { name: '返回父任务' })).toBeNull();
    expect(screen.queryByRole('button', { name: '比较父任务' })).toBeNull();
    expect(onOpenSession).not.toHaveBeenCalled();
    expect(onCompareParent).not.toHaveBeenCalled();
  });

  it('offers parent comparison and renders the immutable shared-prefix result', () => {
    const onCompareParent = vi.fn();
    render(
      <ForkLineageNavigation
        sessionId="current"
        lineage={lineage()}
        children={[]}
        onOpenSession={vi.fn()}
        onCompareParent={onCompareParent}
        comparison={{
          left: {
            branchId: 'parent-branch',
            sessionId: 'parent',
            ownerUserId: null,
            projectId: null,
            rootBranchId: 'root-branch',
            parentBranchId: null,
            parentSessionId: null,
            forkId: null,
            anchorEntryId: null,
            createdAt: 1,
          },
          right: {
            branchId: 'child-branch',
            sessionId: 'current',
            ownerUserId: null,
            projectId: null,
            rootBranchId: 'root-branch',
            parentBranchId: 'parent-branch',
            parentSessionId: 'parent',
            forkId: 'fork-child',
            anchorEntryId: 'entry-2',
            createdAt: 2,
          },
          sharedPrefixLength: 2,
          sharedEntryIds: ['entry-1', 'entry-2'],
          leftOnly: [],
          rightOnly: [{
            ordinal: 2,
            entryId: 'entry-3',
            projectedMessageId: 'child-u2',
            sourceSessionId: 'current',
            sourceMessageId: 'child-u2',
            aliasKind: 'native',
            message: { id: 'child-u2', role: 'user', content: 'branch', timestamp: 3 },
          }],
        }}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '比较父任务' }));
    expect(onCompareParent).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('fork-branch-comparison').textContent).toContain(
      '共同前缀 2 · 当前独有 1 · 父任务独有 0',
    );
  });

  it('exposes branch history as an explicit expandable detail', () => {
    const onToggleHistory = vi.fn();
    const { rerender } = render(
      <ForkLineageNavigation
        sessionId="current"
        lineage={lineage()}
        children={[]}
        onOpenSession={vi.fn()}
        historyExpanded={false}
        onToggleHistory={onToggleHistory}
      />,
    );

    const openButton = screen.getByRole('button', { name: '分支历史' });
    expect(openButton.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(openButton);
    expect(onToggleHistory).toHaveBeenCalledTimes(1);

    rerender(
      <ForkLineageNavigation
        sessionId="current"
        lineage={lineage()}
        children={[]}
        onOpenSession={vi.fn()}
        historyExpanded
        onToggleHistory={onToggleHistory}
      />,
    );
    expect(screen.getByRole('button', { name: '收起历史' }).getAttribute('aria-expanded')).toBe('true');
  });
});
