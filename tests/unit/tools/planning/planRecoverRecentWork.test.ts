import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../../../../src/main/tools/types';

const planningMocks = vi.hoisted(() => ({
  publishPlanningStateToRenderer: vi.fn(),
}));

const recoveryMocks = vi.hoisted(() => ({
  recoverRecentWorkIntoPlanning: vi.fn(),
}));

vi.mock('../../../../src/main/planning', () => ({
  publishPlanningStateToRenderer: planningMocks.publishPlanningStateToRenderer,
}));

vi.mock('../../../../src/main/planning/recoveredWorkOrchestrator', () => ({
  recoverRecentWorkIntoPlanning: recoveryMocks.recoverRecentWorkIntoPlanning,
}));

import { planRecoverRecentWorkTool } from '../../../../src/main/tools/planning/planRecoverRecentWork';

describe('planRecoverRecentWorkTool', () => {
  beforeEach(() => {
    planningMocks.publishPlanningStateToRenderer.mockReset();
    recoveryMocks.recoverRecentWorkIntoPlanning.mockReset();
  });

  it('recovers recent work into plan/task orchestration and emits sync events', async () => {
    const planningService = { plan: {} };
    const emit = vi.fn();
    recoveryMocks.recoverRecentWorkIntoPlanning.mockResolvedValue({
      taskSync: {
        totalCandidates: 2,
        created: [{ id: '1' }],
        updated: [{ id: '2' }],
        skipped: [],
        supersededTodoKeys: [],
        tasks: [{ id: '1' }, { id: '2' }],
      },
      planningSync: {
        totalDesktopTasks: 2,
        createdPlan: false,
        createdPhase: false,
        addedSteps: ['跟进 issue #42'],
        updatedSteps: ['继续处理 memory plan'],
        skippedSteps: [],
        plan: null,
      },
      workspaceResult: {
        items: [{ id: 'mail:1' }],
        warnings: [],
        countsBySource: { desktop: 0, mail: 1, calendar: 0, reminders: 0 },
      },
      createdWorkspacePhase: true,
      createdWorkspaceReviewStep: true,
      updatedWorkspaceNotes: true,
      planChanged: true,
      plan: null,
    });

    const result = await planRecoverRecentWorkTool.execute(
      {
        query: 'issue #42',
        sinceHours: 24,
      },
      {
        workingDirectory: process.cwd(),
        sessionId: 'session-1',
        planningService,
        emit,
      } as ToolContext,
    );

    expect(result.success).toBe(true);
    expect(recoveryMocks.recoverRecentWorkIntoPlanning).toHaveBeenCalledWith(
      expect.objectContaining({
        planningService,
        sessionId: 'session-1',
        query: 'issue #42',
        sinceHours: 24,
      }),
    );
    expect(emit).toHaveBeenCalledWith('task_update', expect.objectContaining({
      action: 'sync',
      source: 'recovered_work',
      taskIds: ['1', '2'],
    }));
    expect(planningMocks.publishPlanningStateToRenderer).toHaveBeenCalledWith(planningService);
    expect(result.output).toContain('Recovered recent work signals into planning.');
  });
});
