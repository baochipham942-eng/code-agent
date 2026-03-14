import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

const desktopMocks = vi.hoisted(() => ({
  ensureFreshData: vi.fn(),
  refreshRecentActivity: vi.fn(),
  syncTodoCandidatesToTasks: vi.fn(),
  listTodoCandidates: vi.fn(),
}));

const planningBridgeMocks = vi.hoisted(() => ({
  syncDesktopTasksToPlanningService: vi.fn(),
}));

const workspaceMocks = vi.hoisted(() => ({
  searchWorkspaceActivity: vi.fn(),
}));

vi.mock('../../../src/main/memory/desktopActivityUnderstandingService', () => ({
  getDesktopActivityUnderstandingService: () => ({
    ensureFreshData: desktopMocks.ensureFreshData,
    refreshRecentActivity: desktopMocks.refreshRecentActivity,
    syncTodoCandidatesToTasks: desktopMocks.syncTodoCandidatesToTasks,
    listTodoCandidates: desktopMocks.listTodoCandidates,
  }),
}));

vi.mock('../../../src/main/memory/desktopActivityPlanningBridge', async () => {
  const actual = await vi.importActual<
    typeof import('../../../src/main/memory/desktopActivityPlanningBridge')
  >('../../../src/main/memory/desktopActivityPlanningBridge');
  return {
    ...actual,
    syncDesktopTasksToPlanningService: planningBridgeMocks.syncDesktopTasksToPlanningService,
  };
});

vi.mock('../../../src/main/memory/workspaceActivitySearchService', () => ({
  searchWorkspaceActivity: workspaceMocks.searchWorkspaceActivity,
}));

import { createPlanningService } from '../../../src/main/planning';
import {
  buildRecoveredWorkOrchestrationHint,
  buildRecoveredWorkSuggestions,
  recoverRecentWorkIntoPlanning,
} from '../../../src/main/planning/recoveredWorkOrchestrator';

const tempDirs: string[] = [];

async function createTempPlanningService() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'recovered-work-'));
  tempDirs.push(dir);
  return createPlanningService(dir, `session-${crypto.randomUUID()}`);
}

beforeEach(() => {
  desktopMocks.ensureFreshData.mockReset();
  desktopMocks.refreshRecentActivity.mockReset();
  desktopMocks.syncTodoCandidatesToTasks.mockReset();
  desktopMocks.listTodoCandidates.mockReset();
  planningBridgeMocks.syncDesktopTasksToPlanningService.mockReset();
  workspaceMocks.searchWorkspaceActivity.mockReset();

  desktopMocks.ensureFreshData.mockResolvedValue(undefined);
  desktopMocks.refreshRecentActivity.mockResolvedValue(undefined);
  desktopMocks.syncTodoCandidatesToTasks.mockReturnValue({
    totalCandidates: 0,
    created: [],
    updated: [],
    skipped: [],
    supersededTodoKeys: [],
    tasks: [],
  });
  desktopMocks.listTodoCandidates.mockReturnValue([]);
  planningBridgeMocks.syncDesktopTasksToPlanningService.mockResolvedValue({
    totalDesktopTasks: 0,
    createdPlan: false,
    createdPhase: false,
    addedSteps: [],
    updatedSteps: [],
    skippedSteps: [],
    plan: null,
  });
  workspaceMocks.searchWorkspaceActivity.mockResolvedValue({
    items: [],
    warnings: [],
    countsBySource: { desktop: 0, mail: 0, calendar: 0, reminders: 0 },
  });
});

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0, tempDirs.length).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe('recoveredWorkOrchestrator', () => {
  it('creates a workspace recovery phase when merged workspace activity is recovered into planning', async () => {
    const planningService = await createTempPlanningService();

    workspaceMocks.searchWorkspaceActivity.mockResolvedValue({
      items: [
        {
          id: 'mail:1',
          source: 'mail',
          title: 'Issue #42 follow-up',
          snippet: 'alice@example.com | final proposal attached',
          score: 0.88,
          timestampMs: Date.parse('2026-03-14T10:00:00+08:00'),
          metadata: {},
        },
        {
          id: 'calendar:1',
          source: 'calendar',
          title: 'Issue #42 review',
          snippet: 'Today 15:00',
          score: 0.83,
          timestampMs: Date.parse('2026-03-14T15:00:00+08:00'),
          metadata: {},
        },
      ],
      warnings: [],
      countsBySource: { desktop: 0, mail: 1, calendar: 1, reminders: 0 },
    });

    const result = await recoverRecentWorkIntoPlanning({
      planningService,
      sessionId: 'session-1',
      query: 'issue #42',
      refreshDesktop: false,
      refreshArtifacts: false,
    });

    expect(result.createdWorkspacePhase).toBe(true);
    expect(result.createdWorkspaceReviewStep).toBe(true);
    expect(result.planChanged).toBe(true);

    const plan = await planningService.plan.read();
    const workspacePhase = plan?.phases.find((phase) => phase.title === 'Recovered Workspace Activity');

    expect(plan?.title).toBe('Recovered Session Plan');
    expect(workspacePhase?.notes).toContain('Issue #42 follow-up');
    expect(workspacePhase?.steps[0]?.content).toContain('Review recovered workspace activity for "issue #42"');
  });

  it('builds session-start suggestions from current plan and recovered desktop todos without duplicates', async () => {
    const planningService = await createTempPlanningService();

    await planningService.plan.create({
      title: 'Recovered Session Plan',
      objective: 'Continue previous work',
      phases: [
        {
          id: 'phase-1',
          title: 'Recovered From Desktop Activity',
          status: 'in_progress',
          notes: 'Recovered context',
          steps: [
            {
              id: 'step-1',
              content: '继续处理 Issue #42',
              status: 'in_progress',
            },
          ],
        },
      ],
    });

    desktopMocks.listTodoCandidates.mockReturnValue([
      {
        id: 'todo-1',
        sliceKey: 'slice-1',
        content: '继续处理 Issue #42',
        activeForm: '正在处理 Issue #42',
        status: 'pending',
        confidence: 0.81,
        evidence: [],
        createdAtMs: Date.now(),
      },
      {
        id: 'todo-2',
        sliceKey: 'slice-2',
        content: '跟进 memory plan',
        activeForm: '正在跟进 memory plan',
        status: 'pending',
        confidence: 0.73,
        evidence: [],
        createdAtMs: Date.now(),
      },
    ]);

    const suggestions = await buildRecoveredWorkSuggestions({
      sessionId: 'session-1',
      planningService,
    });

    expect(suggestions.map((item) => item.text)).toEqual([
      '继续处理 Issue #42',
      '跟进 memory plan',
    ]);
  });

  it('adds an explicit orchestration hint for continuation-like requests', async () => {
    const planningService = await createTempPlanningService();

    await planningService.plan.create({
      title: 'Recovered Session Plan',
      objective: 'Continue previous work',
      phases: [
        {
          id: 'phase-1',
          title: 'Recovered From Desktop Activity',
          status: 'in_progress',
          notes: 'Recovered context',
          steps: [
            {
              id: 'step-1',
              content: '继续处理 Issue #42',
              status: 'in_progress',
            },
          ],
        },
      ],
    });

    const hint = await buildRecoveredWorkOrchestrationHint({
      userMessage: '继续推进 issue #42',
      planningService,
      recoveredTaskCount: 2,
      hasWorkspaceContext: true,
    });

    expect(hint).toContain('Current plan step: 继续处理 Issue #42');
    expect(hint).toContain('Recovered desktop tasks available: 2');
    expect(hint).toContain('call Plan with action="recover_recent_work"');
  });
});
