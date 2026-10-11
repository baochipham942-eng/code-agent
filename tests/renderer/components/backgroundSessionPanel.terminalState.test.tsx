// @vitest-environment jsdom
// ============================================================================
// BackgroundSessionPanel 终态行契约（N-RUNINPUT-TOBACKGROUND-OPTION 2026-10-11 rework）
// ============================================================================
// 无槽验收实测：后台任务撞 max-step 上限结束后，面板 spinner 永不收线（12/22 分钟）。
// 契约：每个终态（成功/失败/撞顶停止/取消）都必须停 spinner 并给一行结果——
// completionMessage 携带稳定 code（MAX_ITERATIONS_REACHED / USER_CANCELLED）时翻译成人话，
// 其余原样展示；running 条目才有 spinner 与计时。

import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import {
  BackgroundSessionPanel,
  formatBackgroundDuration,
  resolveBackgroundTaskStatusLine,
} from '../../../src/renderer/components/features/background/BackgroundSessionPanel';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';
import type { BackgroundSessionInfo } from '../../../src/shared/contract/sessionState';
import { BACKGROUND_TASK_CANCELLED, RUN_ERROR_CODE_MAX_ITERATIONS } from '../../../src/shared/constants';

const LABELS = {
  completed: '已完成',
  failed: '执行失败',
  cancelled: '已停止',
  maxIterations: '已达轮次上限，已停止（部分结果已保留）',
};

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

function renderPanelWith(task: BackgroundSessionInfo) {
  useSessionStore.setState({ backgroundSessions: [task] });
  return render(<BackgroundSessionPanel />);
}

describe('resolveBackgroundTaskStatusLine（纯函数表）', () => {
  it('running → 计时态，无结果行', () => {
    expect(resolveBackgroundTaskStatusLine({ status: 'running' }, LABELS))
      .toEqual({ isRunning: true, line: '' });
  });

  it('completed / failed 空消息 → 默认结果行', () => {
    expect(resolveBackgroundTaskStatusLine({ status: 'completed' }, LABELS))
      .toEqual({ isRunning: false, line: '已完成' });
    expect(resolveBackgroundTaskStatusLine({ status: 'failed' }, LABELS))
      .toEqual({ isRunning: false, line: '执行失败' });
  });

  it('稳定 code 翻译成人话：撞顶停止 / 用户取消', () => {
    expect(resolveBackgroundTaskStatusLine(
      { status: 'failed', completionMessage: RUN_ERROR_CODE_MAX_ITERATIONS }, LABELS,
    )).toEqual({ isRunning: false, line: LABELS.maxIterations });
    expect(resolveBackgroundTaskStatusLine(
      { status: 'completed', completionMessage: BACKGROUND_TASK_CANCELLED }, LABELS,
    )).toEqual({ isRunning: false, line: '已停止' });
  });

  it('其余消息原样展示（engine 终态消息直通）', () => {
    expect(resolveBackgroundTaskStatusLine(
      { status: 'failed', completionMessage: 'Provider auth failure' }, LABELS,
    )).toEqual({ isRunning: false, line: 'Provider auth failure' });
  });
});

describe('面板终态渲染（spinner 必须停 + 结果行必须给）', () => {
  afterEach(() => {
    cleanup();
    useSessionStore.setState({ backgroundSessions: [] });
  });

  it('running 条目：spinner 在场', () => {
    renderPanelWith(backgroundTask({ status: 'running' }));
    const item = screen.getByTestId('background-session-item');
    expect(item.getAttribute('data-status')).toBe('running');
    expect(item.querySelector('.animate-spin')).not.toBeNull();
  });

  it('撞顶停止（MAX_ITERATIONS code）：spinner 停 + 撞顶结果行', () => {
    renderPanelWith(backgroundTask({ status: 'failed', completionMessage: RUN_ERROR_CODE_MAX_ITERATIONS }));
    const item = screen.getByTestId('background-session-item');
    expect(item.getAttribute('data-status')).toBe('failed');
    expect(item.querySelector('.animate-spin')).toBeNull();
    expect(screen.getByTestId('background-session-item-line').textContent)
      .toBe('已达轮次上限，已停止（部分结果已保留）');
  });

  it('用户取消（USER_CANCELLED code）：spinner 停 + 已停止行', () => {
    renderPanelWith(backgroundTask({ status: 'completed', completionMessage: BACKGROUND_TASK_CANCELLED }));
    expect(screen.getByTestId('background-session-item').querySelector('.animate-spin')).toBeNull();
    expect(screen.getByTestId('background-session-item-line').textContent).toBe('已停止');
  });

  it('成功：spinner 停 + 已完成行；失败空消息：执行失败行', () => {
    renderPanelWith(backgroundTask({ status: 'completed' }));
    expect(screen.getByTestId('background-session-item').querySelector('.animate-spin')).toBeNull();
    expect(screen.getByTestId('background-session-item-line').textContent).toBe('已完成');
    cleanup();

    renderPanelWith(backgroundTask({ status: 'failed' }));
    expect(screen.getByTestId('background-session-item-line').textContent).toBe('执行失败');
  });

  it('计时行：秒/分钟/小时三档', () => {
    const labels = { seconds: '{n}秒', minutes: '{n}分钟', hours: '{n}小时{m}分钟' };
    expect(formatBackgroundDuration(1000, 5_500, labels)).toBe('4秒');
    expect(formatBackgroundDuration(1000, 125_000, labels)).toBe('2分钟');
    expect(formatBackgroundDuration(1000, 7_325_000, labels)).toBe('2小时2分钟');
  });
});
