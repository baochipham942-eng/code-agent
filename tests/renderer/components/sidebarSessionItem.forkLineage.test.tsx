import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { SidebarSessionItem } from '../../../src/renderer/components/features/sidebar/SidebarSessionItem';

function renderRow(session: Record<string, unknown>): string {
  return renderToStaticMarkup(
    <SidebarSessionItem
      {...({
        session: {
          id: 'child-session',
          title: '分支任务',
          type: 'chat',
          status: 'idle',
          createdAt: 1,
          updatedAt: 2,
          messageCount: 4,
          turnCount: 2,
          modelConfig: { provider: 'openai', model: 'gpt-5' },
          ...session,
        },
        unreadSessionIds: new Set(),
        automationSummariesBySessionId: {},
        currentSessionId: null,
        selectedSessionIds: new Set(),
        pinnedSessionIds: new Set(),
        renamingId: null,
        sessionRuntimes: new Map(),
        backgroundSessionMap: new Map(),
        sessionStates: {},
        hasNeedsInputForSession: () => false,
        searchQuery: '',
        messageSearchHitsBySessionId: {},
        replayEvidenceBySessionId: new Map(),
        canOpenSessionReplay: true,
        reviewItemsBySessionId: {},
        trajectoryQualityBySessionId: {},
        multiSelectMode: false,
        hoveredSession: null,
        renameValue: '',
        renameInputRef: React.createRef<HTMLInputElement>(),
        setHoveredSession: vi.fn(),
        setRenameValue: vi.fn(),
        handleSelectSession: vi.fn(),
        handleContextMenu: vi.fn(),
        handleRenameSubmit: vi.fn(),
        handleRenameKeyDown: vi.fn(),
        handleDoubleClick: vi.fn(),
        handleOpenSessionReplayInEvalCenter: vi.fn(),
        handleOpenSessionAssets: vi.fn(),
        handleOpenReplayEvidence: vi.fn(),
        handleSelectMessageSearchHit: vi.fn(),
        handleArchiveSession: vi.fn(),
      } as React.ComponentProps<typeof SidebarSessionItem>)}
    />,
  );
}

describe('SidebarSessionItem fork lineage marker', () => {
  it('shows a persistent purple branch marker from explicit fork lineage metadata', () => {
    const html = renderRow({
      metadata: {
        forkLineage: {
          parentSessionId: 'source-session',
          sourceAnchorMessageId: 'a2',
        },
      },
    });

    expect(html).toContain('data-testid="fork-lineage-marker"');
    expect(html).toContain('text-violet-400');
    expect(html).toContain('源任务：source-session');
  });

  it('keeps parentSessionId as a compatibility projection for legacy child rows', () => {
    const html = renderRow({ parentSessionId: 'legacy-parent' });

    expect(html).toContain('data-testid="fork-lineage-marker"');
    expect(html).toContain('源任务：legacy-parent');
  });

  it('does not mark an ordinary session as a branch', () => {
    const html = renderRow({});

    expect(html).not.toContain('data-testid="fork-lineage-marker"');
  });
});
