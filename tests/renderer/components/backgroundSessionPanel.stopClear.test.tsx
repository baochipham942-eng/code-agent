// @vitest-environment jsdom
// ============================================================================
// BackgroundSessionPanel 行级 Stop/Clear 契约（N-BGPANEL-STOP-TERMINAL）
// ============================================================================
// FB-536：后台运行中的行没法停；FB-518：终态行 3 秒消失。现在 running 行给 Stop
// （触发 AGENT_CANCEL 收线）、终态行给 Clear（触发宿主 dismiss）。这里钉 UI 接线：
//   1. running 行只有 Stop、终态行只有 Clear，且是切前台按钮的兄弟节点（不嵌套 button）；
//   2. 点击 Stop/Clear 走 store 的对应 action（channel/payload 契约在 store 测试钉）；
//   3. 收起胶囊只数 running 行：全终态不转 spinner、改报「已结束」条数。
// 通知恰好一次与终态常驻的宿主契约在 tests/unit/session/backgroundTaskManager.test.ts。

import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BackgroundSessionPanel } from '../../../src/renderer/components/features/background/BackgroundSessionPanel';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';
import type { BackgroundSessionInfo } from '../../../src/shared/contract/sessionState';
import { BACKGROUND_TASK_CANCELLED } from '../../../src/shared/constants';

function backgroundTask(overrides: Partial<BackgroundSessionInfo>): BackgroundSessionInfo {
  return {
    sessionId: 's1',
    title: '长任务',
    startedAt: Date.now(),
    backgroundedAt: Date.now(),
    status: 'running',
    ...overrides,
  };
}

const stopSpy = vi.fn();
const dismissSpy = vi.fn();

function renderPanelWith(tasks: BackgroundSessionInfo[]) {
  useSessionStore.setState({
    backgroundSessions: tasks,
    stopBackgroundSession: stopSpy,
    dismissBackgroundSession: dismissSpy,
  } as never);
  return render(<BackgroundSessionPanel />);
}

beforeEach(() => {
  stopSpy.mockClear();
  dismissSpy.mockClear();
});

afterEach(() => {
  cleanup();
  useSessionStore.setState({ backgroundSessions: [] } as never);
});

describe('行级 Stop/Clear 接线', () => {
  it('running 行：Stop 在场、Clear 不在；点击 Stop 调用 stopBackgroundSession(sessionId)', () => {
    renderPanelWith([backgroundTask({})]);

    expect(screen.getByTestId('background-session-stop')).toBeTruthy();
    expect(screen.queryByTestId('background-session-clear')).toBeNull();

    fireEvent.click(screen.getByTestId('background-session-stop'));

    expect(stopSpy).toHaveBeenCalledTimes(1);
    expect(stopSpy).toHaveBeenCalledWith('s1');
    expect(dismissSpy).not.toHaveBeenCalled();
  });

  it('终态行（stopped）：Clear 在场、Stop 不在；点击 Clear 调用 dismissBackgroundSession(sessionId)', () => {
    renderPanelWith([backgroundTask({ status: 'completed', completionMessage: BACKGROUND_TASK_CANCELLED })]);
    expect(screen.getByTestId('background-session-item-line').textContent).toBe('已停止');

    expect(screen.getByTestId('background-session-clear')).toBeTruthy();
    expect(screen.queryByTestId('background-session-stop')).toBeNull();

    fireEvent.click(screen.getByTestId('background-session-clear'));

    expect(dismissSpy).toHaveBeenCalledTimes(1);
    expect(dismissSpy).toHaveBeenCalledWith('s1');
    expect(stopSpy).not.toHaveBeenCalled();
  });

  it('Stop/Clear 与切前台按钮是兄弟节点（行内不嵌套 button）', () => {
    renderPanelWith([backgroundTask({})]);
    const row = screen.getByTestId('background-session-item');
    const foreground = screen.getByTestId('background-session-foreground');

    expect(row.tagName).toBe('DIV');
    expect(foreground.parentElement).toBe(row);
    expect(screen.getByTestId('background-session-stop').parentElement).toBe(row);
  });

  it('终态行常驻面板：只有终态行时面板仍渲染（隐藏仅当 backgroundSessions 为空）', () => {
    renderPanelWith([backgroundTask({ status: 'failed' })]);

    expect(screen.getByTestId('background-session-panel')).toBeTruthy();
    expect(screen.getByTestId('background-session-item').getAttribute('data-status')).toBe('failed');
  });
});

describe('收起胶囊只数 running 行', () => {
  function collapse() {
    fireEvent.click(screen.getByRole('button', { name: '收起后台任务面板' }));
    return screen.getByTestId('background-session-panel-collapsed');
  }

  it('1 running + 1 终态：报「1 个后台任务」，spinner 转着', () => {
    renderPanelWith([
      backgroundTask({ sessionId: 's1' }),
      backgroundTask({ sessionId: 's2', status: 'completed', completionMessage: BACKGROUND_TASK_CANCELLED }),
    ]);

    const pill = collapse();
    expect(pill.textContent).toBe('1 个后台任务');
    expect(pill.querySelector('.animate-spin')).not.toBeNull();
  });

  it('全终态：不转 spinner，改报「已结束」条数', () => {
    renderPanelWith([
      backgroundTask({ sessionId: 's1', status: 'completed', completionMessage: BACKGROUND_TASK_CANCELLED }),
      backgroundTask({ sessionId: 's2', status: 'failed' }),
    ]);

    const pill = collapse();
    expect(pill.textContent).toBe('2 个已结束后台任务');
    expect(pill.querySelector('.animate-spin')).toBeNull();
  });
});
