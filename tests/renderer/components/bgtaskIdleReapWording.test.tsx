// @vitest-environment jsdom
//
// 空闲回收的后台任务：主任务表头 / 面板徽章 / 任务行用词一致，且与「用户停止」「真实失败」三者互不相同。
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TraceProjection } from '../../../src/shared/contract/trace';
import type { RunUiState, TaskRecord } from '../../../src/renderer/types/runWorkbench';
import { buildRunUiState } from '../../../src/renderer/utils/runWorkbenchProjection';

const runModel = vi.hoisted(() => ({ current: null as unknown }));

vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  return { useI18n: () => ({ language: 'zh', t: zh }) };
});
vi.mock('../../../src/renderer/hooks/useRunWorkbenchModel', () => ({
  useRunWorkbenchModel: () => runModel.current,
}));

import { OverviewRunHeader } from '../../../src/renderer/components/TaskPanel/OverviewRunHeader';
import { TaskDashboardSummary, getRunUiStatusLabel } from '../../../src/renderer/components/TaskPanel/RunWorkbenchCards';
import { zh } from '../../../src/renderer/i18n/zh';
import { en } from '../../../src/renderer/i18n/en';

function projectionWith(reason?: string, status: 'completed' | 'error' = 'completed'): TraceProjection {
  return {
    sessionId: 's1',
    activeTurnIndex: -1,
    turns: [{
      turnNumber: 1,
      turnId: 'turn-1',
      status,
      startTime: 100,
      nodes: [{
        id: 'user-1',
        type: 'user',
        content: '跑一个会卡住的后台命令',
        timestamp: 100,
        metadata: reason
          ? { workbench: { runCancellation: { status: 'cancelled', cancelledAt: 200, reason } } }
          : undefined,
      }],
    }],
  } as TraceProjection;
}

function renderHeader(run: RunUiState): string {
  runModel.current = { run, loopDecisions: [], tools: [], tasks: [], subagents: [], memoryActivities: [], outputs: [] };
  render(<OverviewRunHeader />);
  return screen.getByTestId('overview-run-header').textContent ?? '';
}

afterEach(() => cleanup());

describe('idle-reaped background run wording', () => {
  const reaped = buildRunUiState({ projection: projectionWith('idle_reaped'), sessionId: 's1' });
  const stopped = buildRunUiState({ projection: projectionWith('user_cancelled'), sessionId: 's1' });
  const failed = buildRunUiState({ projection: projectionWith(undefined, 'error'), sessionId: 's1' });

  it('projects idle_reaped onto the run, and leaves user stop / failure untouched', () => {
    expect(reaped.status).toBe('cancelled');
    expect(reaped.terminalReason).toBe('idle_reaped');
    expect(stopped.status).toBe('cancelled');
    expect(stopped.terminalReason).toBeUndefined();
    expect(failed.status).toBe('blocked');
  });

  it('main-task header gives three different words for reap / user stop / failure', () => {
    const reapedText = renderHeader(reaped);
    cleanup();
    const stoppedText = renderHeader(stopped);
    cleanup();
    const failedText = renderHeader(failed);

    expect(reapedText).toContain(zh.outcomeWords['failed-idle-reaped'].timeline.reason);
    expect(reapedText).not.toContain('你停止了这次执行');
    expect(stoppedText).toContain('你停止了这次执行');
    expect(failedText).toContain(zh.outcomeWords['failed-unknown'].timeline.reason);
    expect(new Set([reapedText, stoppedText, failedText]).size).toBe(3);
  });

  it('panel badge agrees with the header for the reaped run', () => {
    const badge = getRunUiStatusLabel(reaped.status, zh, reaped.terminalReason);
    expect(badge).toBe(zh.outcomeWords['failed-idle-reaped'].badge.label);
    expect(badge).not.toBe(getRunUiStatusLabel(stopped.status, zh, stopped.terminalReason));
    expect(getRunUiStatusLabel(stopped.status, zh)).toBe(zh.outcomeWords['cancelled-by-user'].badge.label);
  });

  it('reaped copy exists in zh and en and is passive', () => {
    expect(en.outcomeWords['failed-idle-reaped'].timeline.label).toBe('Interrupted');
    expect(en.outcomeWords['failed-idle-reaped'].timeline.reason).toBe('No progress for a long time, reclaimed automatically');
    expect(zh.outcomeWords['failed-idle-reaped'].notification.reason).toBe('长时间没有进展，已自动回收');
  });

  it('a failed background task row says Failed, while a genuinely blocked row still says Blocked', () => {
    const base: TaskRecord = {
      id: 'background:1', scope: 'global', title: 'sleep 600', status: 'blocked', steps: [],
    };
    const failedHtml = renderToStaticMarkup(
      <TaskDashboardSummary tasks={[{ ...base, failed: true }]} run={null} />,
    );
    const blockedHtml = renderToStaticMarkup(
      <TaskDashboardSummary tasks={[base]} run={null} />,
    );
    expect(failedHtml).toContain('>失败<');
    expect(failedHtml).not.toContain('>阻塞<');
    expect(blockedHtml).toContain('>阻塞<');
  });
});
