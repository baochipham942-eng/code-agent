import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { SidebarSessionItem } from '../../../src/renderer/components/features/sidebar/SidebarSessionItem';

function renderRow(session: Record<string, unknown>, overrides: Record<string, unknown> = {}): string {
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
        handleOpenReplayEvidence: vi.fn(),
        handleSelectMessageSearchHit: vi.fn(),
        handleArchiveSession: vi.fn(),
        ...overrides,
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
    expect(html).toContain('text-badge-accent');
    expect(html).toContain('源任务：source-session');
    expect(html.indexOf('分支任务')).toBeLessThan(
      html.indexOf('data-testid="fork-lineage-marker"'),
    );
  });

  it('does not treat compatibility parentSessionId alone as a user fork', () => {
    const html = renderRow({ parentSessionId: 'legacy-parent' });

    expect(html).not.toContain('data-testid="fork-lineage-marker"');
    expect(html).not.toContain('legacy-parent');
  });

  // 2026-07-28 产品负责人拍板：行尾只留**一个** 16px 状态轴，内容按优先级互斥（状态 > 分叉）。
  // 此前是两槽并存、分叉占最右轴，导致绝大多数（无分叉）会话最右那格常年空着，
  // 肉眼看到的状态点落在 190.8 而不是全栏右轨 214.8，与分组角标/账号箭头错开 24。
  // 这条门钉的是「同时有状态和分叉时，只显示状态」——退回两槽会立刻红。
  it('状态与分叉同时存在时只显示状态（单槽 + 优先级：状态 > 分叉）', () => {
    const html = renderRow(
      {
        metadata: {
          forkLineage: { parentSessionId: 'source-session', sourceAnchorMessageId: 'a2' },
        },
      },
      { unreadSessionIds: new Set(['child-session']) },
    );

    // 未读状态点在场
    expect(html).toContain('bg-purple-400');
    // 同一时刻分叉标记让位，不再另占一格
    expect(html).not.toContain('data-testid="fork-lineage-marker"');
  });

  it('does not mark an ordinary session as a branch', () => {
    const html = renderRow({});

    expect(html).not.toContain('data-testid="fork-lineage-marker"');
  });
});
