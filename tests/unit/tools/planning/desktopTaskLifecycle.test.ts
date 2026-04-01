import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  safeStorage: { isEncryptionAvailable: () => false, encryptString: (s: string) => Buffer.from(s) },
  app: { getAppPath: () => '', getPath: () => '' },
}));

import type { ToolContext } from '../../../../src/main/tools/types';
import { createTask, clearTasks } from '../../../../src/main/tools/planning/taskStore';

const desktopActivityMocks = vi.hoisted(() => ({
  recordTodoFeedbackForTask: vi.fn(),
  clearTodoFeedbackForTask: vi.fn(),
  recordTodoFeedback: vi.fn(),
  clearTodoFeedback: vi.fn(),
}));

vi.mock('../../../../src/main/desktop/desktopActivityUnderstandingService', () => ({
  getDesktopActivityUnderstandingService: () => ({
    recordTodoFeedbackForTask: desktopActivityMocks.recordTodoFeedbackForTask,
    clearTodoFeedbackForTask: desktopActivityMocks.clearTodoFeedbackForTask,
    recordTodoFeedback: desktopActivityMocks.recordTodoFeedback,
    clearTodoFeedback: desktopActivityMocks.clearTodoFeedback,
  }),
  isDesktopDerivedSessionTask: (task: { metadata?: Record<string, unknown> }) =>
    task?.metadata?.source === 'desktop_activity'
    && task?.metadata?.sourceKind === 'activity_todo_candidate',
}));

import { taskUpdateTool } from '../../../../src/main/tools/planning/taskUpdate';
import { planUpdateTool } from '../../../../src/main/tools/planning/planUpdate';

const sessionId = 'desktop-lifecycle-test';

function makeContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    workingDirectory: process.cwd(),
    sessionId,
    ...overrides,
  } as ToolContext;
}

describe('desktop-derived task lifecycle hooks', () => {
  beforeEach(() => {
    clearTasks(sessionId);
    desktopActivityMocks.recordTodoFeedbackForTask.mockReset();
    desktopActivityMocks.clearTodoFeedbackForTask.mockReset();
    desktopActivityMocks.recordTodoFeedback.mockReset();
    desktopActivityMocks.clearTodoFeedback.mockReset();
  });

  it('task_update records feedback when a desktop-derived task is completed', async () => {
    const task = createTask(sessionId, {
      subject: '跟进 issue #42',
      description: 'recovered from desktop activity',
      metadata: {
        source: 'desktop_activity',
        sourceKind: 'activity_todo_candidate',
        desktopTodoKey: 'slice-1:跟进 issue #42',
      },
    });

    const result = await taskUpdateTool.execute(
      { taskId: task.id, status: 'completed' },
      makeContext()
    );

    expect(result.success).toBe(true);
    expect(desktopActivityMocks.recordTodoFeedbackForTask).toHaveBeenCalledTimes(1);
    expect(desktopActivityMocks.recordTodoFeedbackForTask).toHaveBeenCalledWith(
      expect.objectContaining({ id: task.id, subject: '跟进 issue #42' }),
      'completed',
      { sessionId, source: 'task' },
    );
  });

  it('task_update records accepted feedback when a desktop-derived task starts', async () => {
    const task = createTask(sessionId, {
      subject: '跟进 issue #42',
      description: 'recovered from desktop activity',
      metadata: {
        source: 'desktop_activity',
        sourceKind: 'activity_todo_candidate',
        desktopTodoKey: 'slice-1:跟进 issue #42',
      },
    });

    const result = await taskUpdateTool.execute(
      { taskId: task.id, status: 'in_progress' },
      makeContext()
    );

    expect(result.success).toBe(true);
    expect(desktopActivityMocks.recordTodoFeedbackForTask).toHaveBeenCalledWith(
      expect.objectContaining({ id: task.id }),
      'accepted',
      { sessionId, source: 'task' },
    );
  });

  it('task_update supports explicit snooze for desktop-derived tasks', async () => {
    const task = createTask(sessionId, {
      subject: '跟进 issue #42',
      description: 'recovered from desktop activity',
      metadata: {
        source: 'desktop_activity',
        sourceKind: 'activity_todo_candidate',
        desktopTodoKey: 'slice-1:跟进 issue #42',
      },
    });

    const before = Date.now();
    const result = await taskUpdateTool.execute(
      { taskId: task.id, desktopAction: 'snooze', desktopSnoozeHours: 4 },
      makeContext()
    );

    expect(result.success).toBe(true);
    expect(desktopActivityMocks.recordTodoFeedbackForTask).toHaveBeenCalledWith(
      expect.objectContaining({ id: task.id }),
      'snoozed',
      expect.objectContaining({
        sessionId,
        source: 'task',
        reason: 'task_update:snooze:4h',
      }),
    );
    const options = desktopActivityMocks.recordTodoFeedbackForTask.mock.calls[0]?.[2];
    expect(options.resumeAtMs).toBeGreaterThanOrEqual(before + (4 * 60 * 60 * 1000) - 1000);
  });

  it('plan_update records dismissed feedback when a recovered desktop step is skipped', async () => {
    createTask(sessionId, {
      subject: '跟进 issue #42',
      description: 'recovered from desktop activity',
      metadata: {
        source: 'desktop_activity',
        sourceKind: 'activity_todo_candidate',
        desktopTodoKey: 'slice-1:跟进 issue #42',
      },
    });

    const planningService = {
      plan: {
        read: vi.fn()
          .mockResolvedValueOnce({
            id: 'plan-1',
            title: 'Recovered Session Plan',
            objective: 'Continue recent work',
            createdAt: Date.now(),
            updatedAt: Date.now(),
            metadata: { totalSteps: 1, completedSteps: 0, blockedSteps: 0 },
            phases: [
              {
                id: 'phase-1',
                title: 'Recovered From Desktop Activity',
                status: 'pending',
                steps: [
                  {
                    id: 'step-1',
                    content: '跟进 issue #42',
                    status: 'pending',
                  },
                ],
              },
            ],
          })
          .mockResolvedValueOnce({
            id: 'plan-1',
            title: 'Recovered Session Plan',
            objective: 'Continue recent work',
            createdAt: Date.now(),
            updatedAt: Date.now(),
            metadata: { totalSteps: 1, completedSteps: 0, blockedSteps: 1 },
            phases: [
              {
                id: 'phase-1',
                title: 'Recovered From Desktop Activity',
                status: 'pending',
                steps: [
                  {
                    id: 'step-1',
                    content: '跟进 issue #42',
                    status: 'skipped',
                  },
                ],
              },
            ],
          }),
        updateStepStatus: vi.fn().mockResolvedValue(undefined),
      },
    };

    const result = await planUpdateTool.execute(
      { stepContent: 'issue #42', status: 'skipped', phaseTitle: 'Recovered From Desktop Activity' },
      makeContext({ planningService })
    );

    expect(result.success).toBe(true);
    expect(desktopActivityMocks.recordTodoFeedbackForTask).toHaveBeenCalledTimes(1);
    expect(desktopActivityMocks.recordTodoFeedbackForTask).toHaveBeenCalledWith(
      expect.objectContaining({ subject: '跟进 issue #42' }),
      'dismissed',
      { sessionId, source: 'plan' },
    );
  });

  it('plan_update can fall back to step metadata todoKey when no task exists in memory', async () => {
    const planningService = {
      plan: {
        read: vi.fn()
          .mockResolvedValueOnce({
            id: 'plan-1',
            title: 'Recovered Session Plan',
            objective: 'Continue recent work',
            createdAt: Date.now(),
            updatedAt: Date.now(),
            metadata: { totalSteps: 1, completedSteps: 0, blockedSteps: 0 },
            phases: [
              {
                id: 'phase-1',
                title: 'Recovered From Desktop Activity',
                status: 'pending',
                steps: [
                  {
                    id: 'step-1',
                    content: '跟进 issue #42',
                    status: 'pending',
                    metadata: {
                      desktopTodoKey: 'slice-1:跟进 issue #42',
                    },
                  },
                ],
              },
            ],
          })
          .mockResolvedValueOnce({
            id: 'plan-1',
            title: 'Recovered Session Plan',
            objective: 'Continue recent work',
            createdAt: Date.now(),
            updatedAt: Date.now(),
            metadata: { totalSteps: 1, completedSteps: 1, blockedSteps: 0 },
            phases: [
              {
                id: 'phase-1',
                title: 'Recovered From Desktop Activity',
                status: 'completed',
                steps: [
                  {
                    id: 'step-1',
                    content: '跟进 issue #42',
                    status: 'completed',
                    metadata: {
                      desktopTodoKey: 'slice-1:跟进 issue #42',
                    },
                  },
                ],
              },
            ],
          }),
        updateStepStatus: vi.fn().mockResolvedValue(undefined),
      },
    };

    const result = await planUpdateTool.execute(
      { stepContent: 'issue #42', status: 'completed', phaseTitle: 'Recovered From Desktop Activity' },
      makeContext({ planningService })
    );

    expect(result.success).toBe(true);
    expect(desktopActivityMocks.recordTodoFeedback).toHaveBeenCalledWith(
      expect.objectContaining({
        todoKey: 'slice-1:跟进 issue #42',
        status: 'completed',
        sessionId,
        source: 'plan',
        reason: 'plan_step_metadata',
      }),
    );
  });
});
