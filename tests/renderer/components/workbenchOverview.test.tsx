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

vi.mock('../../../src/renderer/hooks/useTaskActivity', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/renderer/hooks/useTaskActivity')>();
  return {
    ...actual,
    useTaskActivity: () => taskActivity,
  };
});
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
  });

  it('removes the entire task section when the current session has no task activity', () => {
    render(<WorkbenchOverview />);

    expect(screen.queryByTestId('workbench-overview-progress')).toBeNull();
    expect(screen.queryByTestId('task-progress-marker')).toBeNull();
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
