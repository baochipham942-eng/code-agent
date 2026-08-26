// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const agentRowsRuntime = vi.hoisted(() => ({ rows: [] as Array<Record<string, unknown>> }));

vi.mock('../../../src/renderer/hooks/useSessionAgentRows', () => ({
  useSessionAgentRows: () => ({ rows: agentRowsRuntime.rows, conflicts: [] }),
}));

import { WorkbenchTabs } from '../../../src/renderer/components/WorkbenchTabs';
import { TaskPanel } from '../../../src/renderer/components/TaskPanel';
import { TaskDashboardSummary } from '../../../src/renderer/components/TaskPanel/RunWorkbenchCards';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';
import { useRightPanelTabsStore } from '../../../src/renderer/stores/rightPanelTabsStore';
import { en } from '../../../src/renderer/i18n/en';
import type { TaskRecord } from '../../../src/renderer/types/runWorkbench';

const workbenchActions = {
  openWorkbenchTab: useAppStore.getState().openWorkbenchTab,
  closeWorkbenchTab: useAppStore.getState().closeWorkbenchTab,
  syncWorkbenchForSession: useAppStore.getState().syncWorkbenchForSession,
};

beforeEach(() => {
  agentRowsRuntime.rows = [];
  useAppStore.setState({
    ...workbenchActions,
    workbenchTabs: [],
    activeWorkbenchTab: null,
    workbenchBySession: {},
    workbenchSessionKey: null,
    workbenchCollapsed: false,
    previewTabs: [],
    activePreviewTabId: null,
    developerMode: false,
    language: 'en',
  });
  useRightPanelTabsStore.setState({
    logsTargetTurn: null,
    logsTargetNonce: 0,
    logsPinned: false,
    expertsDismissedBySession: {},
  });
  useSessionStore.setState({ currentSessionId: 'session-1' });
});

afterEach(() => {
  cleanup();
  useSessionStore.setState({ currentSessionId: null });
});

describe('right panel primary task/logs/experts tabs', () => {
  it('starts each session with only Task and never renders or accepts a close action for it', () => {
    useAppStore.getState().syncWorkbenchForSession('session-1');
    expect(useAppStore.getState().workbenchTabs).toEqual(['overview']);

    render(<WorkbenchTabs />);
    const taskTab = screen.getByTestId('workbench-tab-overview');
    expect(taskTab.textContent).toContain(en.workbenchTabs.overviewLabel);
    expect(within(taskTab).queryByLabelText(
      en.workbenchTabs.closeView.replace('{view}', en.workbenchTabs.overviewLabel),
    )).toBeNull();

    useAppStore.getState().closeWorkbenchTab('overview');
    expect(useAppStore.getState().workbenchTabs).toEqual(['overview']);
  });

  it('auto-opens one Experts tab when members appear, retains it when they leave, then allows manual close', async () => {
    useAppStore.getState().syncWorkbenchForSession('session-1');
    const view = render(<WorkbenchTabs />);
    expect(screen.queryByTestId('workbench-tab-experts')).toBeNull();

    agentRowsRuntime.rows = [{ key: 'a' }, { key: 'b' }];
    view.rerender(<WorkbenchTabs />);
    await waitFor(() => expect(useAppStore.getState().workbenchTabs).toEqual(['overview', 'experts']));
    expect(screen.getByTestId('workbench-tab-experts')).toBeTruthy();

    // 会话快照若晚于成员数据恢复，自动页仍须补回来；真机启动会走到这个时序。
    useAppStore.setState({ workbenchTabs: ['overview'], activeWorkbenchTab: 'overview' });
    await waitFor(() => expect(useAppStore.getState().workbenchTabs).toEqual(['overview', 'experts']));

    agentRowsRuntime.rows = [];
    view.rerender(<WorkbenchTabs />);
    expect(useAppStore.getState().workbenchTabs).toEqual(['overview', 'experts']);

    fireEvent.click(within(screen.getByTestId('workbench-tab-experts')).getByLabelText(
      en.workbenchTabs.closeView.replace('{view}', en.workbenchTabs.expertsLabel),
    ));
    expect(useAppStore.getState().workbenchTabs).toEqual(['overview']);
    expect(useRightPanelTabsStore.getState().expertsDismissedBySession['session-1']).toBe(true);
  });

  it('reuses the same Logs tab and moves its target when another task step opens the process', () => {
    useAppStore.getState().syncWorkbenchForSession('session-1');
    const task: TaskRecord = {
      id: 'session-task',
      scope: 'session',
      title: 'Prepare report',
      status: 'in_progress',
      steps: [
        { title: 'Read data', status: 'completed' },
        { title: 'Build chart', status: 'in_progress' },
      ],
      ownerRunId: null,
      sourceThreadId: 'session-1',
    };
    render(<TaskDashboardSummary tasks={[task]} run={null} />);

    fireEvent.click(screen.getByTestId('view-step-process-1'));
    expect(useAppStore.getState()).toMatchObject({
      workbenchTabs: ['overview', 'logs'],
      activeWorkbenchTab: 'logs',
    });
    expect(useRightPanelTabsStore.getState().logsTargetTurn).toBe(1);

    fireEvent.click(screen.getByTestId('view-step-process-2'));
    expect(useRightPanelTabsStore.getState().logsTargetTurn).toBe(2);
    expect(useAppStore.getState().workbenchTabs.filter((tab) => tab === 'logs')).toHaveLength(1);

    useAppStore.getState().closeWorkbenchTab('logs');
    fireEvent.click(screen.getByTestId('view-step-process-1'));
    expect(useAppStore.getState()).toMatchObject({
      workbenchTabs: ['overview', 'logs'],
      activeWorkbenchTab: 'logs',
    });
    expect(useRightPanelTabsStore.getState().logsTargetTurn).toBe(1);
    expect(useAppStore.getState().workbenchTabs.filter((tab) => tab === 'logs')).toHaveLength(1);
  });

  it('keeps pinned Logs across a session switch in developer mode', () => {
    useAppStore.getState().syncWorkbenchForSession('session-1');
    useRightPanelTabsStore.getState().targetLogsTurn(1);
    useAppStore.getState().openWorkbenchTab('logs');
    useAppStore.setState({ developerMode: true });
    render(<WorkbenchTabs />);

    fireEvent.click(screen.getByTestId('workbench-logs-pin'));
    expect(useRightPanelTabsStore.getState().logsPinned).toBe(true);
    useAppStore.getState().syncWorkbenchForSession('session-2');
    expect(useAppStore.getState()).toMatchObject({
      workbenchTabs: ['overview', 'logs'],
      activeWorkbenchTab: 'logs',
    });
    expect(useRightPanelTabsStore.getState().logsTargetTurn).toBeNull();
  });

  it('removes the old secondary tab strip from TaskPanel', () => {
    render(<TaskPanel overviewContent={<div>Task content</div>} />);
    expect(screen.getByText('Task content')).toBeTruthy();
    expect(screen.queryByTestId('task-panel-tabs')).toBeNull();
    expect(screen.queryByTestId('task-panel-tab-overview')).toBeNull();
    expect(screen.queryByTestId('task-panel-tab-inspector')).toBeNull();
    expect(screen.queryByTestId('task-panel-tab-agents')).toBeNull();
  });
});
