// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkbenchOverview } from '../../../src/renderer/components/WorkbenchOverview';
import { deriveHasTaskActivity } from '../../../src/renderer/hooks/useTaskActivity';

const taskActivity = vi.hoisted(() => ({
  hasTaskActivity: false,
  agentTreeSnapshot: null,
}));

// 当前会话的 workbenchSnapshot 决定空态挂不挂「最近产物」预览
const sessionState = vi.hoisted(() => ({
  currentSessionId: null as string | null,
  sessions: [] as Array<{ id: string; workbenchSnapshot?: { summary: string } }>,
}));

// 会话已有产物（跑完的任务/重开的会话）时不进叙事空态，产物区继续展示
const previewItems = vi.hoisted(() => ({ length: 0 }));

vi.mock('../../../src/renderer/hooks/useTaskActivity', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/renderer/hooks/useTaskActivity')>();
  return {
    ...actual,
    useTaskActivity: () => taskActivity,
  };
});
vi.mock('../../../src/renderer/hooks/useWorkspacePreviewModel', () => ({
  useWorkspacePreviewModel: () => previewItems,
}));
vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: (selector: (state: typeof sessionState) => unknown) => selector(sessionState),
}));
vi.mock('../../../src/renderer/components/TaskPanel', () => ({
  TaskPanel: () => <div data-testid="task-progress-marker">task progress</div>,
}));
vi.mock('../../../src/renderer/components/WorkspacePreviewPanel', () => ({
  WorkspacePreviewPanel: () => <div data-testid="artifact-marker">artifacts</div>,
}));

afterEach(() => cleanup());

describe('WorkbenchOverview', () => {
  beforeEach(() => {
    taskActivity.hasTaskActivity = false;
    taskActivity.agentTreeSnapshot = null;
    sessionState.currentSessionId = null;
    sessionState.sessions = [];
    previewItems.length = 0;
  });

  it('shows the task-scene narrative instead of an empty artifact shell when there is no task activity', () => {
    render(<WorkbenchOverview />);

    expect(screen.queryByTestId('workbench-overview-progress')).toBeNull();
    expect(screen.queryByTestId('task-progress-marker')).toBeNull();
    // 空态是叙事（运行中的任务会实时显示在这里），不再是产物区自己的空壳
    expect(screen.getByTestId('workbench-overview-empty')).toBeTruthy();
    expect(screen.queryByTestId('workbench-overview-artifacts')).toBeNull();
    expect(screen.queryByTestId('artifact-marker')).toBeNull();
    // 没有会话快照时不挂「最近产物」预览
    expect(screen.queryByTestId('workbench-overview-recent')).toBeNull();
  });

  it('previews the latest workbench snapshot summary in the empty state', () => {
    sessionState.currentSessionId = 'session-1';
    sessionState.sessions = [
      { id: 'session-1', workbenchSnapshot: { summary: '工作区 · 3 个文件' } },
    ];
    render(<WorkbenchOverview />);

    const recent = screen.getByTestId('workbench-overview-recent');
    expect(recent.textContent).toContain('工作区 · 3 个文件');
  });

  it('does not treat a plain-chat snapshot as a deliverable scene', () => {
    sessionState.currentSessionId = 'session-1';
    sessionState.sessions = [
      { id: 'session-1', workbenchSnapshot: { summary: '纯对话' } },
    ];
    render(<WorkbenchOverview />);

    expect(screen.getByTestId('workbench-overview-empty')).toBeTruthy();
    expect(screen.queryByTestId('workbench-overview-recent')).toBeNull();
  });

  it('keeps the artifact region when the session has artifacts but no live task activity', () => {
    previewItems.length = 1;
    render(<WorkbenchOverview />);

    // 跑完的任务/重开的会话：没有任务进程区，但产物不能丢进叙事空态
    expect(screen.queryByTestId('workbench-overview-empty')).toBeNull();
    expect(screen.queryByTestId('workbench-overview-progress')).toBeNull();
    expect(screen.getByTestId('workbench-overview-artifacts')).toBeTruthy();
    expect(screen.getByTestId('artifact-marker')).toBeTruthy();
  });

  it('renders the complete task panel when any task activity exists', () => {
    taskActivity.hasTaskActivity = true;
    render(<WorkbenchOverview />);

    expect(screen.getByTestId('workbench-overview-progress')).toBeTruthy();
    expect(screen.getByTestId('task-progress-marker')).toBeTruthy();
    expect(screen.getByTestId('workbench-overview-artifacts')).toBeTruthy();
    expect(screen.getByTestId('artifact-marker')).toBeTruthy();
    expect(screen.queryByTestId('workbench-overview-empty')).toBeNull();
  });

  it('recognizes agent trees, tasks, stored progress, and live runs as activity', () => {
    const quiet = {
      agentNodeCount: 0,
      taskCount: 0,
      taskProgress: null,
      runStatus: 'completed' as const,
    };

    expect(deriveHasTaskActivity(quiet)).toBe(false);
    expect(deriveHasTaskActivity({ ...quiet, agentNodeCount: 1 })).toBe(true);
    expect(deriveHasTaskActivity({ ...quiet, taskCount: 1 })).toBe(true);
    expect(deriveHasTaskActivity({
      ...quiet,
      taskProgress: { turnId: 'turn-1', phase: 'tool_running', progress: 50 },
    })).toBe(true);
    expect(deriveHasTaskActivity({ ...quiet, runStatus: 'using_tools' })).toBe(true);
  });
});
