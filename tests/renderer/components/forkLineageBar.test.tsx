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
});
