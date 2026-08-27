// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  refreshStates: vi.fn(),
  refreshStats: vi.fn(),
  switchSession: vi.fn(),
  openWorkbenchTab: vi.fn(),
  setTaskPanelTab: vi.fn(),
}));

vi.mock('../../../src/renderer/stores/taskStore', () => ({
  useTaskStore: () => ({
    sessionStates: {
      current: { status: 'running', startTime: Date.now() - 65_000 },
      queued: { status: 'queued', queuePosition: 2 },
    },
    stats: { running: 1, queued: 1, available: 1, maxConcurrent: 3 },
    refreshStates: mocks.refreshStates,
    refreshStats: mocks.refreshStats,
    initialized: true,
  }),
}));

vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: () => ({
    sessions: [
      { id: 'current', title: '当前任务' },
      { id: 'queued', title: '排队任务' },
    ],
    currentSessionId: 'current',
    switchSession: mocks.switchSession,
  }),
}));

vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: () => ({
    openWorkbenchTab: mocks.openWorkbenchTab,
    setTaskPanelTab: mocks.setTaskPanelTab,
  }),
}));

import { TaskStatusBar } from '../../../src/renderer/components/features/chat/TaskStatusBar';

describe('TaskStatusBar 布局与交互', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-27T10:00:00+08:00'));
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('尾部固定占位，hover 与键盘焦点只改变指示器透明度', () => {
    render(<TaskStatusBar />);

    const tails = screen.getAllByTestId('task-status-tail');
    expect(tails).toHaveLength(2);
    for (const tail of tails) {
      expect(tail.className).toContain('w-16');
      expect(tail.className).toContain('shrink-0');
      expect(tail.className).toContain('text-right');
      expect(tail.className).toContain('tabular-nums');
    }

    const queuedButton = screen.getByRole('button', { name: /排队任务/u });
    expect(queuedButton.getAttribute('type')).toBe('button');
    expect(queuedButton.className).toContain('group');
    expect(queuedButton.className).toContain('focus-visible:ring-1');
    const chevron = queuedButton.querySelector('svg:last-child');
    expect(chevron?.getAttribute('class')).toContain('group-hover:opacity-100');
    expect(chevron?.getAttribute('class')).toContain('group-focus-visible:opacity-100');
  });

  it('任务按钮可点击切换会话并打开任务监控', () => {
    render(<TaskStatusBar />);

    fireEvent.click(screen.getByRole('button', { name: /排队任务/u }));
    expect(mocks.switchSession).toHaveBeenCalledWith('queued');
    expect(mocks.openWorkbenchTab).toHaveBeenCalledWith('task');
    expect(mocks.setTaskPanelTab).toHaveBeenCalledWith('monitor');
  });
});
