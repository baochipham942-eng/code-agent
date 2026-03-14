import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { SessionTask } from '../../../src/shared/types';
import { createPlanningService } from '../../../src/main/planning';
import { syncDesktopTasksToPlanningService } from '../../../src/main/memory/desktopActivityPlanningBridge';

const tempDirs: string[] = [];

function makeDesktopTask(overrides: Partial<SessionTask> = {}): SessionTask {
  const id = overrides.id || crypto.randomUUID();
  return {
    id,
    subject: overrides.subject || '跟进 issue #42',
    description: overrides.description || '从桌面活动恢复的待办',
    activeForm: overrides.activeForm || '正在跟进 issue #42',
    status: overrides.status || 'pending',
    priority: overrides.priority || 'normal',
    blocks: overrides.blocks || [],
    blockedBy: overrides.blockedBy || [],
    metadata: {
      source: 'desktop_activity',
      sourceKind: 'activity_todo_candidate',
      desktopTodoKey: overrides.metadata?.desktopTodoKey || `desktop:${id}`,
      ...(overrides.metadata || {}),
    },
    createdAt: overrides.createdAt || Date.now(),
    updatedAt: overrides.updatedAt || Date.now(),
    owner: overrides.owner,
  };
}

async function createTempPlanningService() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'desktop-plan-'));
  tempDirs.push(dir);
  return createPlanningService(dir, `session-${crypto.randomUUID()}`);
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0, tempDirs.length).map((dir) => fs.rm(dir, { recursive: true, force: true }))
  );
});

describe('desktopActivityPlanningBridge', () => {
  it('creates a recovered plan when no plan exists yet', async () => {
    const planningService = await createTempPlanningService();
    const task = makeDesktopTask();

    const result = await syncDesktopTasksToPlanningService(planningService, [
      task,
    ]);

    expect(result.createdPlan).toBe(true);
    expect(result.createdPhase).toBe(true);
    expect(result.addedSteps).toEqual(['跟进 issue #42']);

    const plan = await planningService.plan.read();
    expect(plan?.title).toBe('Recovered Session Plan');
    expect(plan?.phases[0]?.title).toBe('Recovered From Desktop Activity');
    expect(plan?.phases[0]?.steps[0]?.content).toBe('跟进 issue #42');
    expect(plan?.phases[0]?.steps[0]?.metadata?.desktopTodoKey).toBe(task.metadata.desktopTodoKey);
    expect(plan?.phases[0]?.steps[0]?.metadata?.sourceTaskId).toBe(task.id);
  });

  it('does not duplicate recovered steps on repeated sync', async () => {
    const planningService = await createTempPlanningService();
    const task = makeDesktopTask();

    await syncDesktopTasksToPlanningService(planningService, [task]);
    const second = await syncDesktopTasksToPlanningService(planningService, [task]);

    expect(second.createdPlan).toBe(false);
    expect(second.addedSteps).toHaveLength(0);

    const plan = await planningService.plan.read();
    const recoveredPhase = plan?.phases.find((phase) => phase.title === 'Recovered From Desktop Activity');
    expect(recoveredPhase?.steps).toHaveLength(1);
  });
});
