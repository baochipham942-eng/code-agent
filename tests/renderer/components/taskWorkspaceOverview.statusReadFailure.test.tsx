// @vitest-environment jsdom
// ============================================================================
// 后台任务状态台账读取失败 UI —— 摘自已删除的 TaskMonitor.tsx（TaskMonitor
// 在 app 里已无挂载点，见 2026-08-01 chip 改写与 TaskMonitor 删除工单 ③）。
// readFailure/requestStatusReadRetry 全仓只有 TaskWorkspaceOverview 一个消费点，
// 删组件前先把这份唯一数据消费契约搬到 Overview「进度」卡片承接，不静默丢失。
// ============================================================================

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const appState = {
  workingDirectory: '/repo/app',
  openPreview: vi.fn(),
  openWorkspacePreview: vi.fn(),
  setSelectedWorkspacePreviewId: vi.fn(),
};

const sessionState = {
  currentSessionId: 'session-1' as string | null,
};

const statusRailState = {
  context: { items: [] as Array<any> },
  outputs: { files: [] as Array<any>, count: 0 },
};

const runWorkbenchState = {
  run: { status: 'running', phase: '执行中', identity: { runId: 'run-1' } },
  tasks: [
    {
      id: 'background:task-1',
      scope: 'global',
      title: '后台任务',
      status: 'in_progress',
      steps: [{ title: '执行中', status: 'in_progress' }],
      ownerRunId: null,
      sourceThreadId: 'session-1',
    },
  ],
  tools: [] as Array<any>,
  memoryActivities: [] as Array<any>,
};

const backgroundTaskStore = {
  readFailure: null as { message: string; failedAt: number } | null,
  isLoading: false,
  requestStatusReadRetry: vi.fn(),
};

const taskStore = {
  cancelTask: vi.fn(async () => {}),
};

vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  return {
    useI18n: () => ({
      language: 'zh',
      t: {
        ...zh,
        taskStatusPanels: {
          ...zh.taskStatusPanels,
          monitor: {
            ...zh.taskStatusPanels.monitor,
            statusReadFailed: '无法确认任务状态',
            statusReadFailedHint: '任务状态读取失败，当前无法判断任务是否仍在执行。',
            retryStatusRead: '重试读取',
            retryingStatusRead: '重试中',
            cancelTask: '取消任务',
            cancellingTask: '取消中',
            cancelTaskFailed: '取消失败',
          },
        },
      },
    }),
  };
});

vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: (selector?: (state: typeof appState) => unknown) => (
    selector ? selector(appState) : appState
  ),
}));

vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: (selector?: (state: typeof sessionState) => unknown) => (
    selector ? selector(sessionState) : sessionState
  ),
}));

vi.mock('../../../src/renderer/stores/backgroundTaskStore', () => ({
  useBackgroundTaskStore: (selector?: (state: typeof backgroundTaskStore) => unknown) => (
    selector ? selector(backgroundTaskStore) : backgroundTaskStore
  ),
}));

vi.mock('../../../src/renderer/stores/taskStore', () => ({
  useTaskStore: (selector?: (state: typeof taskStore) => unknown) => (
    selector ? selector(taskStore) : taskStore
  ),
}));

vi.mock('../../../src/renderer/hooks/useStatusRailModel', () => ({
  useStatusRailModel: () => statusRailState,
}));

vi.mock('../../../src/renderer/hooks/useRunWorkbenchModel', () => ({
  useRunWorkbenchModel: () => runWorkbenchState,
}));

vi.mock('../../../src/renderer/hooks/useCurrentTurnArtifactOwnership', () => ({
  useCurrentTurnArtifactOwnership: () => null,
}));

vi.mock('../../../src/renderer/hooks/useWorkspacePreviewModel', () => ({
  useWorkspacePreviewModel: () => [],
}));

vi.mock('../../../src/renderer/components/features/agentTree/AgentTreeView', () => ({
  AgentTreeView: () => null,
}));

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invoke: vi.fn(), isAvailable: () => false },
  invoke: vi.fn(),
}));

import { TaskWorkspaceOverview } from '../../../src/renderer/components/TaskPanel/TaskWorkspaceOverview';

describe('TaskWorkspaceOverview 后台任务状态读取失败 UI', () => {
  beforeEach(() => {
    backgroundTaskStore.readFailure = null;
    backgroundTaskStore.isLoading = false;
    backgroundTaskStore.requestStatusReadRetry.mockClear();
    taskStore.cancelTask.mockClear();
    sessionState.currentSessionId = 'session-1';
  });

  it('读取失败时用独立失败块替代任务摘要', () => {
    backgroundTaskStore.readFailure = { message: 'ledger unavailable', failedAt: Date.now() };

    render(<TaskWorkspaceOverview />);

    expect(screen.queryByText('无法确认任务状态')).not.toBeNull();
    expect(screen.queryByRole('button', { name: '重试读取' })).not.toBeNull();
    expect(screen.queryByRole('button', { name: '取消任务' })).not.toBeNull();
    // 不暴露内部错误原文
    expect(screen.queryByText('ledger unavailable')).toBeNull();
  });

  it('无读取失败时正常渲染任务摘要，不显示失败块', () => {
    render(<TaskWorkspaceOverview />);

    expect(screen.queryByText('无法确认任务状态')).toBeNull();
    expect(screen.queryAllByText('后台任务').length).toBeGreaterThan(0);
  });

  it('点击重试读取仅调用一次 requestStatusReadRetry', () => {
    backgroundTaskStore.readFailure = { message: 'ledger unavailable', failedAt: Date.now() };

    render(<TaskWorkspaceOverview />);
    fireEvent.click(screen.getByRole('button', { name: '重试读取' }));

    expect(backgroundTaskStore.requestStatusReadRetry).toHaveBeenCalledTimes(1);
    expect(taskStore.cancelTask).not.toHaveBeenCalled();
  });

  it('点击取消任务以 currentSessionId 调用 cancelTask', async () => {
    backgroundTaskStore.readFailure = { message: 'ledger unavailable', failedAt: Date.now() };

    render(<TaskWorkspaceOverview />);
    fireEvent.click(screen.getByRole('button', { name: '取消任务' }));

    await waitFor(() => {
      expect(taskStore.cancelTask).toHaveBeenCalledTimes(1);
      expect(taskStore.cancelTask).toHaveBeenCalledWith('session-1');
    });
  });

  it('无当前会话时取消按钮禁用', () => {
    backgroundTaskStore.readFailure = { message: 'ledger unavailable', failedAt: Date.now() };
    sessionState.currentSessionId = null;

    render(<TaskWorkspaceOverview />);

    expect(screen.getByRole('button', { name: '取消任务' }).getAttribute('disabled')).not.toBeNull();
  });
});
