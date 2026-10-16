// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SidebarSessionItem, type SidebarSessionItemProps } from '../../../src/renderer/components/features/sidebar/SidebarSessionItem';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { getSessionWaitingDetail, hasNeedsInputForSession, type SessionNeedsInputSources } from '../../../src/renderer/utils/sessionNeedsInput';

function rowProps(sources: SessionNeedsInputSources = {}): SidebarSessionItemProps {
  return {
    session: {
      id: 'waiting-session', title: 'Desktop task', type: 'chat', status: 'idle',
      createdAt: 1, updatedAt: 2, messageCount: 2, turnCount: 1,
      modelConfig: { provider: 'openai', model: 'gpt-5' },
    },
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

afterEach(() => {
  cleanup();
  useAppStore.setState({ language: 'zh' });
});

describe('SidebarSessionItem visible waiting text', () => {
  it.each([
    ['zh', '等你批准：操作《Calculator》', '等你批准', '等你确认'],
    ['en', 'Approve: "Calculator"', 'Waiting for your approval', 'Waiting for you'],
  ] as const)('renders actual %s text nodes for app permission, generic permission and other input', (language, appText, permissionText, otherText) => {
    useAppStore.setState({ language });
    const sources: SessionNeedsInputSources = { permissionState: {
      pendingPermissionRequest: {
        id: 'permission', type: 'command', tool: 'computer_use', timestamp: 1,
        details: { targetApp: { name: 'Calculator' } },
      },
      pendingPermissionSessionId: 'waiting-session',
    } };
    const { container, rerender } = render(<SidebarSessionItem {...rowProps(sources)} />);
    const subtitle = screen.getByTestId('sidebar-session-waiting-text');
    expect(subtitle.textContent).toBe(appText);
    expect(subtitle.hidden).toBe(false);
    expect(subtitle.title).toBe(appText);
    expect(subtitle.className).toContain('line-clamp-2');
    expect(subtitle.className).toContain('break-words');
    expect(subtitle.className).toContain('text-[11px]');
    expect(subtitle.className).toContain('text-badge-accent');
    expect(container.querySelector('.bg-mark-accent[aria-label]')).not.toBeNull();
    process.stdout.write(`DOM ${language} app: ${subtitle.textContent}\n`);

    sources.permissionState!.pendingPermissionRequest!.details = { command: 'pwd' };
    rerender(<SidebarSessionItem {...rowProps(sources)} />);
    expect(screen.getByTestId('sidebar-session-waiting-text').textContent).toBe(permissionText);
    process.stdout.write(`DOM ${language} permission: ${screen.getByTestId('sidebar-session-waiting-text').textContent}\n`);

    rerender(<SidebarSessionItem {...rowProps({ durableWaitingApprovalSessionIds: new Set(['waiting-session']) })} />);
    expect(screen.getByTestId('sidebar-session-waiting-text').textContent).toBe(otherText);
    process.stdout.write(`DOM ${language} other: ${screen.getByTestId('sidebar-session-waiting-text').textContent}\n`);

    rerender(<SidebarSessionItem {...rowProps()} />);
    expect(screen.queryByTestId('sidebar-session-waiting-text')).toBeNull();
  });

  it('does not render a subtitle on a non-approval row, even if stale detail is supplied', () => {
    render(<SidebarSessionItem {...rowProps()} getWaitingDetailForSession={() => ({ kind: 'permission', appName: 'Calculator' })} />);
    expect(screen.queryByTestId('sidebar-session-waiting-text')).toBeNull();
  });
});
