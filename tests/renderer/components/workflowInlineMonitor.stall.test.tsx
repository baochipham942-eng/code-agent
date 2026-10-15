// @vitest-environment jsdom
//
// N-WF-STALL-UI：WorkflowInlineMonitor 两级「无进展」提示的档位/隐藏/文案行为。
// 阈值单一真源 WORKFLOW_STALL_THRESHOLDS（2min 软提示 / 10min 硬停顿）；fake timers
// 拨快 1s 刷新节拍 + 系统时钟，断言提示行随 idle 增长出现/升级/消失。

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, act } from '@testing-library/react';
import type { ScriptRunSnapshot } from '../../../src/shared/contract/scriptRun';
import { WORKFLOW_STALL_THRESHOLDS } from '../../../src/shared/constants';

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invoke: vi.fn().mockResolvedValue(undefined) },
}));

import { WorkflowInlineMonitor } from '../../../src/renderer/components/features/workflow/WorkflowInlineMonitor';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';
import { useWorkflowStore } from '../../../src/renderer/stores/workflowStore';
import { useAppStore } from '../../../src/renderer/stores/appStore';

const T0 = 1_700_000_000_000;

function stallSnapshot(over: Partial<ScriptRunSnapshot> = {}): ScriptRunSnapshot {
  return {
    runId: 'wf-stall',
    sessionId: 'session-stall',
    status: 'running',
    goal: 'long research',
    phases: ['read'],
    logs: [],
    agents: [],
    runningCount: 0,
    doneCount: 0,
    errorCount: 0,
    startedAt: T0,
    lastActivityAt: T0,
    ...over,
  };
}

function mount(over: Partial<ScriptRunSnapshot> = {}) {
  useWorkflowStore.setState({ runs: { 'wf-stall': stallSnapshot(over) }, activeRunId: 'wf-stall' });
  return render(<WorkflowInlineMonitor />);
}

/** 拨快时钟（系统时间 + 组件的 1s 刷新 interval）。 */
function elapse(ms: number) {
  act(() => { vi.advanceTimersByTime(ms); });
}

function stallBadgeText(container: HTMLElement): string | null {
  const badge = container.querySelector('[data-stall-level]');
  return badge ? badge.textContent : null;
}

describe('WorkflowInlineMonitor stall hint（N-WF-STALL-UI）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    useWorkflowStore.getState().clear();
    useSessionStore.setState({ currentSessionId: 'session-stall' });
    useAppStore.setState({ language: 'zh' });
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  it('① 软阈值：超过 2 分钟出「暂无进展」，之前不出', () => {
    const view = mount();
    elapse(WORKFLOW_STALL_THRESHOLDS.N_SOFT_MS - 1000);
    expect(stallBadgeText(view.container)).toBeNull();

    elapse(2000); // 越过 N_SOFT_MS，且 1s 节拍已 fire
    expect(stallBadgeText(view.container)).toBe('暂无进展');
  });

  it('① 硬阈值：超过 10 分钟且宿主已公告（epoch>=1）升「长时间无进展，已提醒 Neo」', () => {
    const view = mount({ stallNoticeEpoch: 1 });
    elapse(WORKFLOW_STALL_THRESHOLDS.N_SOFT_MS + 2000);
    expect(stallBadgeText(view.container)).toBe('暂无进展'); // 硬阈值前只有软提示

    elapse(WORKFLOW_STALL_THRESHOLDS.N_HARD_MS - WORKFLOW_STALL_THRESHOLDS.N_SOFT_MS + 2000);
    expect(stallBadgeText(view.container)).toBe('长时间无进展，已提醒 Neo');
  });

  it('① 硬阈值但宿主未公告（epoch 缺省）停在软提示——「已提醒」不许说谎', () => {
    const view = mount();
    elapse(WORKFLOW_STALL_THRESHOLDS.N_HARD_MS + 2000);
    expect(stallBadgeText(view.container)).toBe('暂无进展');
  });

  it('② 终态不显示：completed/cancelled 整卡隐藏，failed 保留报错但无停顿行', () => {
    const completed = mount({ status: 'completed' });
    expect(completed.container.textContent).toBe('');
    const cancelled = mount({ status: 'cancelled' });
    expect(cancelled.container.textContent).toBe('');

    const failed = mount({ status: 'failed', error: 'boom' });
    elapse(WORKFLOW_STALL_THRESHOLDS.N_HARD_MS * 2);
    expect(failed.container.textContent).toContain('boom');
    expect(stallBadgeText(failed.container)).toBeNull();
  });

  it('② parked（等审批/审查）期间不报停顿，unpark 后恢复', () => {
    const view = mount({ parked: true });
    elapse(WORKFLOW_STALL_THRESHOLDS.N_HARD_MS * 2);
    expect(stallBadgeText(view.container)).toBeNull();

    useWorkflowStore.setState({ runs: { 'wf-stall': stallSnapshot({ parked: false }) }, activeRunId: 'wf-stall' });
    elapse(2000);
    expect(stallBadgeText(view.container)).toBe('暂无进展');
  });

  it('③ 英文界面同阈值同语义（No progress for a while / Stalled for a long time; Neo notified）', () => {
    useAppStore.setState({ language: 'en' });
    const view = mount();
    elapse(WORKFLOW_STALL_THRESHOLDS.N_SOFT_MS + 2000);
    expect(stallBadgeText(view.container)).toBe('No progress for a while');

    useWorkflowStore.setState({
      runs: { 'wf-stall': stallSnapshot({ stallNoticeEpoch: 1 }) },
      activeRunId: 'wf-stall',
    });
    elapse(WORKFLOW_STALL_THRESHOLDS.N_HARD_MS + 2000);
    // en 'long' 文案收短到单行量级（卡头 743px 内不换行、不挤计数，N-WF-STALL-UI rework）。
    expect(stallBadgeText(view.container)).toBe('Stalled for a long time; Neo notified');
  });

  it('刷新节拍清理：unmount 后 interval 不再 fire（无泄漏定时器）', () => {
    const view = mount();
    elapse(WORKFLOW_STALL_THRESHOLDS.N_SOFT_MS + 2000);
    expect(stallBadgeText(view.container)).toBe('暂无进展');
    view.unmount();
    // unmount 后再拨 10 分钟也不炸（interval 已清）；此断言主要保证 unmount 路径可跑。
    elapse(WORKFLOW_STALL_THRESHOLDS.N_HARD_MS);
    expect(view.container.textContent).toBe('');
  });
});
