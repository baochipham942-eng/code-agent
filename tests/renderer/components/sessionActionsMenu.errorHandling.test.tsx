// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const invokeDomain = vi.hoisted(() => vi.fn());
const showToast = vi.hoisted(() => vi.fn());
const setWorkingDirectory = vi.hoisted(() => vi.fn());

const appState = {
  workingDirectory: '/repo/other',
  setWorkingDirectory,
  openDevServerLauncher: vi.fn(),
  openWorkbenchTab: vi.fn(),
  pendingPermissionRequest: null,
  pendingPermissionSessionId: null,
  queuedPermissionRequests: {},
};
const sessionState = {
  currentSessionId: 'session-1',
  sessions: [{
    id: 'session-1',
    title: '当前会话',
    workingDirectory: '/repo/project',
    messageCount: 2,
    turnCount: 1,
  }],
  sessionRuntimes: new Map([
    ['session-1', { sessionId: 'session-1', status: 'paused', activeAgentCount: 0, lastActivityAt: Date.now() }],
  ]),
  backgroundTasks: [],
  moveToBackground: vi.fn(),
};
const taskState = { sessionStates: { 'session-1': { status: 'idle' } } };

vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: (selector: (state: typeof appState) => unknown) => selector(appState),
}));
vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: (selector: (state: typeof sessionState) => unknown) => selector(sessionState),
}));
vi.mock('../../../src/renderer/stores/taskStore', () => ({
  useTaskStore: (selector: (state: typeof taskState) => unknown) => selector(taskState),
}));
vi.mock('../../../src/renderer/stores/workflowStore', () => ({
  useWorkflowStore: (selector: (state: { runs: object }) => unknown) => selector({ runs: {} }),
}));
vi.mock('../../../src/renderer/stores/backgroundTaskStore', () => ({
  useBackgroundTaskStore: (selector: (state: { tasks: unknown[] }) => unknown) => selector({ tasks: [] }),
}));
vi.mock('../../../src/renderer/stores/authStore', () => ({
  useAuthStore: (selector: (state: { user: null }) => unknown) => selector({ user: null }),
}));
vi.mock('../../../src/renderer/stores/uiStore', () => ({
  useUIStore: (selector: (state: { showToast: typeof showToast }) => unknown) => selector({ showToast }),
}));
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invoke: vi.fn() },
}));

import { SessionActionsMenu } from '../../../src/renderer/components/SessionActionsMenu';

function openMenu() {
  render(<SessionActionsMenu />);
  fireEvent.click(screen.getByRole('button', { name: '会话动作' }));
}

describe('SessionActionsMenu async action feedback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(window, 'domainAPI', {
      configurable: true,
      value: { invoke: invokeDomain },
    });
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'blob:markdown'),
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: vi.fn(),
    });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('恢复执行失败时提示错误', async () => {
    invokeDomain.mockRejectedValueOnce(new Error('连接中断'));
    openMenu();

    fireEvent.click(screen.getByText('恢复执行'));

    await waitFor(() => expect(showToast).toHaveBeenCalledWith('error', '恢复执行失败：连接中断'));
  });

  it('导出 Markdown 失败时提示错误', async () => {
    invokeDomain.mockRejectedValueOnce(new Error('磁盘不可写'));
    openMenu();

    fireEvent.click(screen.getByText('导出 Markdown'));

    await waitFor(() => expect(showToast).toHaveBeenCalledWith('error', '导出 Markdown 失败：磁盘不可写'));
  });

  it('导出 Markdown 成功时提示成功', async () => {
    invokeDomain.mockResolvedValueOnce({
      success: true,
      data: { markdown: '# 会话', suggestedFileName: 'session.md' },
    });
    openMenu();

    fireEvent.click(screen.getByText('导出 Markdown'));

    await waitFor(() => expect(showToast).toHaveBeenCalledWith('success', 'Markdown 已导出'));
  });

  it('恢复工作区失败时提示错误且不更新本地目录', async () => {
    invokeDomain.mockRejectedValueOnce(new Error('目录不存在'));
    openMenu();

    fireEvent.click(screen.getByText('恢复工作区'));

    await waitFor(() => expect(showToast).toHaveBeenCalledWith('error', '恢复工作区失败：目录不存在'));
    expect(setWorkingDirectory).not.toHaveBeenCalled();
  });
});
