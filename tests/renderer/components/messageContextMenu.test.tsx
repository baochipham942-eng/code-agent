// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TraceNode, TraceTurn } from '../../../src/shared/contract/trace';
import { IPC_CHANNELS } from '../../../src/shared/ipc';
import ipcService from '../../../src/renderer/services/ipcService';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { TurnCard } from '../../../src/renderer/components/features/chat/TurnCard';
import { TraceNodeRenderer } from '../../../src/renderer/components/features/chat/TraceNodeRenderer';
import { messageContextMenuId } from '../../../src/renderer/components/features/chat/useMessageContextInterventions';

const snapshots = new Map<string, { pinned: string[]; excluded: string[]; retained: string[] }>();

function emptySnapshot() {
  return { pinned: [] as string[], excluded: [] as string[], retained: [] as string[] };
}

function snapshotFor(sessionId: string) {
  const current = snapshots.get(sessionId) ?? emptySnapshot();
  return {
    pinned: [...current.pinned],
    excluded: [...current.excluded],
    retained: [...current.retained],
  };
}

function completedTurn(status: TraceTurn['status'] = 'completed'): TraceTurn {
  return {
    turnId: 'turn-keep',
    turnNumber: 2,
    status,
    startTime: 1_000,
    endTime: status === 'completed' ? 2_000 : undefined,
    nodes: [
      { id: 'user-msg', type: 'user', content: '记住这个事实', timestamp: 1_000 },
      {
        id: 'tool-row',
        type: 'tool_call',
        content: 'noop',
        timestamp: 1_500,
        toolCall: { id: 'call-1', name: 'noop', args: { note: 'none' } },
      },
      {
        id: 'mid-text',
        messageId: 'mid-msg',
        type: 'assistant_text',
        content: '中间草稿',
        timestamp: 1_800,
      },
      {
        id: 'final-text',
        messageId: 'final-msg',
        type: 'assistant_text',
        content: '最终回答',
        timestamp: 2_000,
        feedbackEligible: status === 'completed',
      },
    ],
  } as TraceTurn;
}

describe('message context menu', () => {
  beforeEach(() => {
    snapshots.clear();
    useAppStore.setState({ language: 'zh', processingSessionIds: new Set() });
    vi.spyOn(ipcService, 'invoke').mockImplementation((async (channel: string, payload?: {
      sessionId?: string;
      messageId?: string;
      action?: 'pin' | 'exclude' | 'retain';
      enabled?: boolean;
    }) => {
      const sessionId = payload?.sessionId ?? '';
      if (channel === IPC_CHANNELS.CONTEXT_INTERVENTION_GET) return snapshotFor(sessionId);
      if (channel === IPC_CHANNELS.CONTEXT_INTERVENTION_SET && payload?.messageId && payload.action) {
        const current = snapshots.get(sessionId) ?? emptySnapshot();
        current.pinned = current.pinned.filter((id) => id !== payload.messageId);
        current.excluded = current.excluded.filter((id) => id !== payload.messageId);
        current.retained = current.retained.filter((id) => id !== payload.messageId);
        if (payload.enabled) {
          if (payload.action === 'pin') current.pinned.push(payload.messageId);
          if (payload.action === 'exclude') current.excluded.push(payload.messageId);
        }
        snapshots.set(sessionId, current);
        return snapshotFor(sessionId);
      }
      return undefined;
    }) as typeof ipcService.invoke);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    useAppStore.setState({ processingSessionIds: new Set() });
  });

  it('offers pin and exclude only on the user bubble and the final reply', async () => {
    const { container } = render(<TurnCard turn={completedTurn()} sessionId="session-menu" />);

    await waitFor(() => {
      expect(ipcService.invoke).toHaveBeenCalledWith(IPC_CHANNELS.CONTEXT_INTERVENTION_GET, { sessionId: 'session-menu' });
    });

    const buttons = screen.getAllByTestId('message-context-menu-button');
    expect(buttons).toHaveLength(2);
    const userNode = container.querySelector('[data-trace-node-id="user-msg"]');
    expect(userNode?.querySelector('[data-testid="message-context-menu-button"]')).toBeTruthy();
    for (const node of container.querySelectorAll('[data-trace-node-type="tool_call"], [data-trace-node-id="mid-text"]')) {
      expect(node.querySelector('[data-testid="message-context-menu-button"]')).toBeNull();
    }

    fireEvent.click(userNode?.querySelector('[data-testid="message-context-menu-button"]') as HTMLElement);
    expect(screen.getByTestId('message-context-pin').textContent).toContain('记住这条，压缩时别丢');
    expect(screen.getByTestId('message-context-exclude').textContent).toContain('这条以后不给 AI 看');

    fireEvent.click(screen.getByTestId('message-context-pin'));
    await waitFor(() => {
      expect(screen.getByTestId('message-context-badge').textContent).toContain('已记住');
    });
    expect(ipcService.invoke).toHaveBeenCalledWith(IPC_CHANNELS.CONTEXT_INTERVENTION_SET, {
      sessionId: 'session-menu',
      messageId: 'user-msg',
      action: 'pin',
      enabled: true,
    });

    const replyRow = screen.getByTestId('turn-reply-actions');
    fireEvent.click(replyRow.querySelector('[data-testid="message-context-menu-button"]') as HTMLElement);
    expect(screen.getByTestId('message-context-pin').textContent).toContain('记住这条，压缩时别丢');
    fireEvent.click(screen.getByTestId('message-context-exclude'));
    await waitFor(() => {
      expect(screen.getAllByTestId('message-context-badge').some((badge) => badge.textContent?.includes('AI 看不到这条'))).toBe(true);
    });
    expect(ipcService.invoke).toHaveBeenCalledWith(IPC_CHANNELS.CONTEXT_INTERVENTION_SET, {
      sessionId: 'session-menu',
      messageId: 'final-msg',
      action: 'exclude',
      enabled: true,
    });
    const dimmed = container.querySelector('[data-testid="message-context-frame"][data-dimmed="true"]');
    expect(dimmed).toBeTruthy();
    expect(dimmed?.className).toContain('opacity-60');
    expect(dimmed?.textContent).toContain('最终回答');

    fireEvent.click(replyRow.querySelector('[data-testid="message-context-menu-button"]') as HTMLElement);
    expect(screen.getByTestId('message-context-exclude').textContent).toContain('恢复给 AI 看');
    fireEvent.click(screen.getByTestId('message-context-exclude'));
    await waitFor(() => {
      expect(container.querySelector('[data-dimmed="true"]')).toBeNull();
    });
    expect(ipcService.invoke).toHaveBeenCalledWith(IPC_CHANNELS.CONTEXT_INTERVENTION_SET, {
      sessionId: 'session-menu',
      messageId: 'final-msg',
      action: 'exclude',
      enabled: false,
    });
  });

  it('hides the menu while the turn is streaming', async () => {
    render(<TurnCard turn={completedTurn('streaming')} sessionId="session-stream" />);
    expect(screen.queryByTestId('message-context-menu-button')).toBeNull();
    await act(async () => { await Promise.resolve(); });
  });

  it('hides the menu while the session is processing', async () => {
    useAppStore.setState({ processingSessionIds: new Set(['session-busy']) });
    render(<TurnCard turn={completedTurn()} sessionId="session-busy" />);
    expect(screen.queryByTestId('message-context-menu-button')).toBeNull();
    await act(async () => { await Promise.resolve(); });
  });

  it('mounts the menu on a user bubble and not on a tool row', () => {
    const { rerender } = render(
      <TraceNodeRenderer
        node={{ id: 'user-direct', type: 'user', content: 'hello', timestamp: 1 } as TraceNode}
        sessionId="session-direct"
      />,
    );
    expect(screen.getByTestId('message-context-menu-button')).toBeTruthy();

    rerender(
      <TraceNodeRenderer
        node={{
          id: 'tool-direct',
          type: 'tool_call',
          content: '',
          timestamp: 2,
          toolCall: { id: 'c', name: 'noop', args: { note: 'none' } },
        } as TraceNode}
        sessionId="session-direct-tool"
      />,
    );
    expect(screen.queryByTestId('message-context-menu-button')).toBeNull();
  });

  it('derives persisted ids and skips tool rows and non-final replies', () => {
    expect(messageContextMenuId({ id: 'user-msg', type: 'user' })).toBe('user-msg');
    expect(messageContextMenuId({ id: 'node-id', type: 'user', messageId: 'persisted' })).toBe('persisted');
    expect(messageContextMenuId({
      id: 'final-text',
      type: 'assistant_text',
      messageId: 'final-msg',
      feedbackEligible: true,
    })).toBe('final-msg');
    expect(messageContextMenuId({
      id: 'final-text',
      type: 'assistant_text',
      feedbackEligible: true,
    })).toBe('final');
    expect(messageContextMenuId({ id: 'mid-text', type: 'assistant_text', messageId: 'mid-msg' })).toBeNull();
    expect(messageContextMenuId({ id: 'tool-row', type: 'tool_call' })).toBeNull();
    expect(messageContextMenuId({ id: 'sys', type: 'system' })).toBeNull();
  });
});
