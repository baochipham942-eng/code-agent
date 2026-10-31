// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SidebarSessionItem, type SidebarSessionItemProps } from '../../../src/renderer/components/features/sidebar/SidebarSessionItem';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { getSessionWaitingDetail, hasNeedsInputForSession, type SessionNeedsInputSources } from '../../../src/renderer/utils/sessionNeedsInput';

function rowProps(
  extra: Record<string, unknown> = {},
  sources: SessionNeedsInputSources = {},
): SidebarSessionItemProps {
  return {
    session: {
      id: 'import-session', title: 'Imported task', type: 'chat', status: 'idle',
      createdAt: 1, updatedAt: 2, messageCount: 2, turnCount: 1,
      modelConfig: { provider: 'openai', model: 'gpt-5' },
      ...extra,
    } as SidebarSessionItemProps['session'],
    unreadSessionIds: new Set(), automationSummariesBySessionId: {}, currentSessionId: null,
    selectedSessionIds: new Set(), pinnedSessionIds: new Set(), renamingId: null,
    sessionRuntimes: new Map(), backgroundSessionMap: new Map(), sessionStates: {},
    hasNeedsInputForSession: (id) => hasNeedsInputForSession(id, sources),
    getWaitingDetailForSession: (id) => getSessionWaitingDetail(id, sources),
    searchQuery: '', messageSearchHitsBySessionId: {}, replayEvidenceBySessionId: new Map(),
    reviewItemsBySessionId: {}, trajectoryQualityBySessionId: {}, multiSelectMode: false,
    hoveredSession: null, renameValue: '', renameInputRef: React.createRef<HTMLInputElement>(),
    setHoveredSession: vi.fn(), setRenameValue: vi.fn(), handleSelectSession: vi.fn(),
    handleContextMenu: vi.fn(), handleRenameSubmit: vi.fn(), handleRenameKeyDown: vi.fn(),
    handleDoubleClick: vi.fn(), handleOpenReplayEvidence: vi.fn(),
    handleSelectMessageSearchHit: vi.fn(), handleArchiveSession: vi.fn(),
  };
}

const imported = (kind: string) => ({
  origin: { kind: 'import', name: `${kind} history` },
  engine: { kind, origin: 'import' },
});

afterEach(() => {
  cleanup();
  useAppStore.setState({ language: 'zh' });
});

describe('SidebarSessionItem import source label', () => {
  it.each([
    ['zh', 'claude_code', 'Claude Code 历史'],
    ['zh', 'codex_cli', 'Codex 历史'],
    ['en', 'claude_code', 'Claude Code history'],
    ['en', 'codex_cli', 'Codex history'],
  ] as const)('%s %s shows mapped label, never raw origin.name', (language, kind, text) => {
    useAppStore.setState({ language });
    const { container } = render(<SidebarSessionItem {...rowProps(imported(kind))} />);
    expect(screen.getByTestId('sidebar-session-import-source').textContent).toBe(text);
    expect(container.textContent).not.toContain(`${kind} history`);
  });

  it('shows no label for native, unknown-engine, and non-import rows', () => {
    const { rerender } = render(<SidebarSessionItem {...rowProps()} />);
    expect(screen.queryByTestId('sidebar-session-import-source')).toBeNull();
    rerender(<SidebarSessionItem {...rowProps({ origin: { kind: 'import', name: 'weird history' }, engine: { kind: 'mystery' } })} />);
    expect(screen.queryByTestId('sidebar-session-import-source')).toBeNull();
    rerender(<SidebarSessionItem {...rowProps({ origin: { kind: 'import', name: 'x history' } })} />);
    expect(screen.queryByTestId('sidebar-session-import-source')).toBeNull();
    rerender(<SidebarSessionItem {...rowProps({ origin: { kind: 'manual' }, engine: { kind: 'claude_code' } })} />);
    expect(screen.queryByTestId('sidebar-session-import-source')).toBeNull();
    expect(document.body.textContent).not.toContain('history');
  });

  it('hides the label while the approval subtitle shows', () => {
    const sources: SessionNeedsInputSources = { durableWaitingApprovalSessionIds: new Set(['import-session']) };
    render(<SidebarSessionItem {...rowProps(imported('claude_code'), sources)} />);
    expect(screen.getByTestId('sidebar-session-waiting-text')).toBeTruthy();
    expect(screen.queryByTestId('sidebar-session-import-source')).toBeNull();
  });
});
