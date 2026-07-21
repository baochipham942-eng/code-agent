// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SurfaceSessionStateV1 } from '../../../../src/shared/contract/surfaceExecution';
import { SidebarSessionItem } from '../../../../src/renderer/components/features/sidebar/SidebarSessionItem';
import {
  SurfaceExecutionComposerStatus,
} from '../../../../src/renderer/components/features/surfaceExecution/SurfaceExecutionRunStatus';
import {
  selectSurfaceExecutionRunSessionV1,
  useSurfaceExecutionStore,
} from '../../../../src/renderer/stores/surfaceExecutionStore';
import { surfaceExecutionScopeKeyV1 } from '../../../../src/renderer/utils/surfaceExecutionProjection';
import { surfaceSession } from './fixtures';

vi.mock('../../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../../src/renderer/i18n/zh');
  return { useI18n: () => ({ t: zh, language: 'zh' }) };
});

function mapSessions(...sessions: ReturnType<typeof surfaceSession>[]) {
  return Object.fromEntries(sessions.map((session) => [
    surfaceExecutionScopeKeyV1(session.scope),
    session,
  ]));
}

function setConversationState(state: SurfaceSessionStateV1): void {
  const current = surfaceSession({
    id: `current-${state}`,
    conversationId: 'conversation-a',
    state,
    updatedAt: 20_000,
  });
  const foreign = surfaceSession({
    id: `foreign-${state}`,
    conversationId: 'conversation-b',
    state: state === 'paused' ? 'running' : 'paused',
    updatedAt: 90_000,
  });
  act(() => {
    useSurfaceExecutionStore.setState({ sessionsByScope: mapSessions(current, foreign) });
  });
}

function sidebarProps(): React.ComponentProps<typeof SidebarSessionItem> {
  return {
    session: {
      id: 'conversation-a',
      title: 'Surface Run',
      type: 'chat',
      status: 'idle',
      createdAt: 1,
      updatedAt: 2,
      messageCount: 2,
      turnCount: 1,
      modelConfig: { provider: 'openai', model: 'gpt-5' },
      workingDirectory: '/repo/code-agent',
    },
    unreadSessionIds: new Set(),
    automationSummariesBySessionId: {},
    currentSessionId: 'conversation-a',
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
    canOpenSessionReplay: false,
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
    handleOpenSessionReplay: vi.fn(),
    handleOpenSessionAssets: vi.fn(),
    handleOpenReplayEvidence: vi.fn(),
    handleSelectMessageSearchHit: vi.fn(),
    handleArchiveSession: vi.fn(),
  };
}

beforeEach(() => {
  useSurfaceExecutionStore.getState().reset();
});

afterEach(() => {
  cleanup();
  useSurfaceExecutionStore.getState().reset();
});

describe('Surface Execution unified Run status', () => {
  it('uses the same projected session in Sidebar and Composer through state transitions', async () => {
    setConversationState('running');
    render(
      <>
        <SidebarSessionItem {...sidebarProps()} />
        <SurfaceExecutionComposerStatus conversationId="conversation-a" />
      </>,
    );

    const sidebar = screen.getByTestId('surface-execution-sidebar-status');
    const composer = screen.getByTestId('surface-execution-composer-status');
    expect(sidebar.getAttribute('data-state')).toBe('running');
    expect(sidebar.getAttribute('aria-label')).toBe('浏览器 · 执行中');
    expect(composer.getAttribute('data-state')).toBe('running');
    expect(composer.textContent).toContain('浏览器 · 执行中');

    for (const [state, label] of [
      ['paused', '浏览器 · 已暂停'],
      ['waiting_human', '浏览器 · 等待你操作'],
      ['stopping', '浏览器 · 正在停止'],
      ['completed', '浏览器 · 已完成'],
    ] as const) {
      setConversationState(state);
      await waitFor(() => {
        expect(sidebar.getAttribute('data-state')).toBe(state);
        expect(sidebar.getAttribute('aria-label')).toBe(label);
        expect(composer.getAttribute('data-state')).toBe(state);
        expect(composer.textContent).toContain(label);
      });
    }
  });

  it('rejects a newer session whose run/agent/session ownership disagrees with its scope', () => {
    const owned = surfaceSession({
      id: 'owned',
      conversationId: 'conversation-a',
      state: 'paused',
      updatedAt: 10,
    });
    const forged = surfaceSession({
      id: 'forged',
      conversationId: 'conversation-a',
      state: 'running',
      updatedAt: 99,
    });
    forged.scope = { ...forged.scope, agentId: 'foreign-agent' };

    expect(selectSurfaceExecutionRunSessionV1(mapSessions(owned, forged), {
      conversationId: 'conversation-a',
    })).toBe(owned);
    expect(selectSurfaceExecutionRunSessionV1(mapSessions(owned, forged), {
      conversationId: 'conversation-b',
    })).toBeNull();
  });

  it('keeps every live surface on the active session and falls back to terminal history only after it ends', () => {
    const active = surfaceSession({
      id: 'active',
      conversationId: 'conversation-a',
      state: 'paused',
      updatedAt: 10,
    });
    const newerTerminal = surfaceSession({
      id: 'terminal',
      conversationId: 'conversation-a',
      state: 'completed',
      updatedAt: 99,
    });
    const sessions = mapSessions(active, newerTerminal);

    expect(selectSurfaceExecutionRunSessionV1(sessions, {
      conversationId: 'conversation-a',
    })).toBe(active);
    expect(selectSurfaceExecutionRunSessionV1(sessions, {
      conversationId: 'conversation-a',
      includeTerminal: false,
    })).toBe(active);

    active.session = { ...active.session, state: 'completed' };
    expect(selectSurfaceExecutionRunSessionV1(mapSessions(active, newerTerminal), {
      conversationId: 'conversation-a',
    })).toBe(newerTerminal);
    expect(selectSurfaceExecutionRunSessionV1(mapSessions(active, newerTerminal), {
      conversationId: 'conversation-a',
      includeTerminal: false,
    })).toBeNull();
  });

  it('keeps the real ChatInput seam connected to the current conversation', () => {
    const source = readFileSync(
      'src/renderer/components/features/chat/ChatInput/index.tsx',
      'utf8',
    );
    expect(source).toContain('<SurfaceExecutionComposerStatus conversationId={currentSessionId} />');
  });
});
