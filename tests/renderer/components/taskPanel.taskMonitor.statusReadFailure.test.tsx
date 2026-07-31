// @vitest-environment jsdom

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const appState = {
  workingDirectory: '/repo/app',
  sessionTaskProgress: {} as Record<string, any>,
  pendingPermissionRequest: null,
  pendingPermissionSessionId: null,
  queuedPermissionRequests: {},
  openWorkspacePreview: vi.fn(),
};

const sessionState = {
  currentSessionId: 'session-1',
  sessions: [] as Array<any>,
  messages: [] as Array<any>,
  sessionTasks: [] as Array<any>,
  sessionDesignBriefs: new Map<string, any>(),
};

const statusRailState = {
  context: {
    currentTokens: 3200,
    maxTokens: 128000,
    usagePercent: 3,
    warningLevel: 'normal' as const,
    buckets: { rules: 1, files: 0, web: 0, other: 0 },
    items: [] as Array<any>,
  },
  compact: { canCompact: false, compressionCount: 0, totalSavedTokens: 0 },
  todos: { items: [] as Array<any>, completed: 0, total: 0 },
  outputs: { files: [] as Array<any>, count: 0 },
  swarm: { isRunning: false, agentCount: 0, selectedAgentId: null },
  cache: { promptCacheHits: 0, promptCacheMisses: 0, totalCachedTokens: 0, hitRate: 0 },
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
  subagents: [],
  loopDecisions: [],
  tools: [],
  memoryActivities: [],
  outputs: { files: [], count: 0 },
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
        taskPanel: {
          ...zh.taskPanel,
          sectionOutputs: '产物',
          sectionContext: '上下文',
          runtimeApprovalsBadge: '待审',
          skillsMcpEmpty: '没有技能',
          taskProgressFallbackTitle: '任务进度',
        },
      },
    }),
  };
});

vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: (selector?: (state: typeof sessionState) => unknown) => (
    selector ? selector(sessionState) : sessionState
  ),
}));

vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: (selector?: (state: typeof appState) => unknown) => (
    selector ? selector(appState) : appState
  ),
}));

vi.mock('../../../src/renderer/stores/taskStore', () => ({
  useTaskStore: (selector?: (state: typeof taskStore) => unknown) => (
    selector ? selector(taskStore) : taskStore
  ),
}));

vi.mock('../../../src/renderer/stores/backgroundTaskStore', () => ({
  useBackgroundTaskStore: (selector?: (state: typeof backgroundTaskStore) => unknown) => (
    selector ? selector(backgroundTaskStore) : backgroundTaskStore
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

vi.mock('../../../src/renderer/hooks/useCurrentTurnCapabilityScope', () => ({
  useCurrentTurnCapabilityScope: () => null,
}));

vi.mock('../../../src/renderer/hooks/useCurrentTurnRoutingEvidence', () => ({
  useCurrentTurnRoutingEvidence: () => null,
}));

vi.mock('../../../src/renderer/hooks/useWorkspacePreviewModel', () => ({
  useWorkspacePreviewModel: () => [],
}));

vi.mock('../../../src/renderer/hooks/useWorkbenchCapabilityQuickActionRunner', () => ({
  useWorkbenchCapabilityQuickActionRunner: () => ({
    runningActionKey: null,
    actionErrors: {},
    completedActions: {},
    runQuickAction: vi.fn(),
  }),
}));

vi.mock('../../../src/renderer/components/TaskPanel/useToolProgress', () => ({
  useToolProgress: () => ({ toolProgress: null, toolTimeout: null }),
}));

vi.mock('../../../src/renderer/hooks/useWorkbenchInsights', () => ({
  useWorkbenchInsights: () => ({ references: [], history: [] }),
}));

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invoke: vi.fn() },
  invoke: vi.fn(),
}));

import { TaskMonitor } from '../../../src/renderer/components/TaskPanel/TaskMonitor';

describe('TaskMonitor 后台任务状态读取失败 UI', () => {
  beforeEach(() => {
    backgroundTaskStore.readFailure = null;
    backgroundTaskStore.isLoading = false;
    backgroundTaskStore.requestStatusReadRetry.mockClear();
    taskStore.cancelTask.mockClear();
    sessionState.currentSessionId = 'session-1';
    runWorkbenchState.tasks = [
      {
        id: 'background:task-1',
        scope: 'global',
        title: '后台任务',
        status: 'in_progress',
        steps: [{ title: '执行中', status: 'in_progress' }],
        ownerRunId: null,
        sourceThreadId: 'session-1',
      },
    ];
  });

  it('读取失败时用独立失败块替代任务摘要', () => {
    backgroundTaskStore.readFailure = { message: 'ledger unavailable', failedAt: Date.now() };

    render(<TaskMonitor />);

    expect(screen.queryByText('无法确认任务状态')).not.toBeNull();
    expect(screen.queryByText('任务状态读取失败，当前无法判断任务是否仍在执行。')).not.toBeNull();
    expect(screen.queryByRole('button', { name: '重试读取' })).not.toBeNull();
    expect(screen.queryByRole('button', { name: '取消任务' })).not.toBeNull();

    // 不暴露内部错误原文
    expect(screen.queryByText('ledger unavailable')).toBeNull();
    // 不渲染旧任务摘要，避免等待时长继续增长
    expect(screen.queryByText('后台任务')).toBeNull();
  });

  it('无读取失败时正常渲染任务摘要', () => {
    render(<TaskMonitor />);

    expect(screen.queryAllByText('后台任务').length).toBeGreaterThan(0);
    expect(screen.queryByText('无法确认任务状态')).toBeNull();
  });

  it('点击重试读取仅调用一次 requestStatusReadRetry', () => {
    backgroundTaskStore.readFailure = { message: 'ledger unavailable', failedAt: Date.now() };

    render(<TaskMonitor />);
    const retryButton = screen.getByRole('button', { name: '重试读取' });

    fireEvent.click(retryButton);

    expect(backgroundTaskStore.requestStatusReadRetry).toHaveBeenCalledTimes(1);
    expect(taskStore.cancelTask).not.toHaveBeenCalled();
  });

  it('点击取消任务以 currentSessionId 调用 cancelTask', async () => {
    backgroundTaskStore.readFailure = { message: 'ledger unavailable', failedAt: Date.now() };

    render(<TaskMonitor />);
    const cancelButton = screen.getByRole('button', { name: '取消任务' });

    fireEvent.click(cancelButton);

    await waitFor(() => {
      expect(taskStore.cancelTask).toHaveBeenCalledTimes(1);
      expect(taskStore.cancelTask).toHaveBeenCalledWith('session-1');
    });
    expect(backgroundTaskStore.requestStatusReadRetry).not.toHaveBeenCalled();
  });

  it('重试 pending 时两按钮均禁用且显示重试中', () => {
    backgroundTaskStore.readFailure = { message: 'ledger unavailable', failedAt: Date.now() };
    backgroundTaskStore.isLoading = true;

    render(<TaskMonitor />);

    const retryButton = screen.getByRole('button', { name: '重试读取' });
    const cancelButton = screen.getByRole('button', { name: '取消任务' });

    expect(retryButton.disabled).toBe(true);
    expect(retryButton.textContent).toContain('重试中');
    expect(cancelButton.disabled).toBe(true);
  });

  it('无当前会话时取消按钮禁用', () => {
    backgroundTaskStore.readFailure = { message: 'ledger unavailable', failedAt: Date.now() };
    sessionState.currentSessionId = null;

    render(<TaskMonitor />);
    const cancelButton = screen.getByRole('button', { name: '取消任务' });

    expect(cancelButton.disabled).toBe(true);
  });
});
