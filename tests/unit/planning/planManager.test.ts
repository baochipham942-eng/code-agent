import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { PlanManager } from '../../../src/main/planning/planManager';
import type { PlanningConfig, TaskPhase } from '../../../src/main/planning/types';

let workingDirectory: string;
const SESSION_ID = 'sess-plan';
const makeConfig = (): PlanningConfig => ({ workingDirectory, sessionId: SESSION_ID });

const basePlan = (phases: TaskPhase[] = []) => ({
  title: 'My Plan',
  objective: 'ship it',
  phases,
});

const phase = (over: Partial<TaskPhase> & { title: string }): Omit<TaskPhase, 'id'> => ({
  status: 'pending',
  steps: [],
  ...over,
});

beforeEach(async () => {
  workingDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'plan-manager-'));
});

afterEach(async () => {
  await fs.rm(workingDirectory, { recursive: true, force: true });
});

describe('PlanManager.create + read (markdown round-trip)', () => {
  it('creates a plan, computes metadata, and persists it', async () => {
    const mgr = new PlanManager(makeConfig());
    const created = await mgr.create(
      basePlan([
        {
          id: 'ph1',
          title: 'Build',
          status: 'pending',
          steps: [
            { id: 'a', content: 'first', status: 'completed' },
            { id: 'b', content: 'second', status: 'pending' },
          ],
        },
      ])
    );

    expect(created.id).toBeTruthy();
    expect(created.metadata).toEqual({ totalSteps: 2, completedSteps: 1, blockedSteps: 0 });
    expect(mgr.getCurrentPlan()).toEqual(created);
    expect(mgr.getPlanPath()).toContain(SESSION_ID);

    const md = await fs.readFile(mgr.getPlanPath(), 'utf-8');
    expect(md).toContain('# My Plan');
    expect(md).toContain('**Objective:** ship it');
  });

  it('round-trips title/objective/steps/status/StepMeta through a fresh instance', async () => {
    const writer = new PlanManager(makeConfig());
    await writer.create(
      basePlan([
        {
          id: 'ph1',
          title: 'Phase One',
          status: 'in_progress',
          notes: 'a note',
          steps: [
            {
              id: 'step-x',
              content: 'do the thing',
              status: 'in_progress',
              activeForm: 'Doing the thing',
              metadata: { weight: 3 },
            },
            { id: 'step-y', content: 'skip this', status: 'skipped' },
          ],
        },
      ])
    );

    const reader = new PlanManager(makeConfig());
    const loaded = await reader.read();
    expect(loaded).not.toBeNull();
    expect(loaded!.title).toBe('My Plan');
    expect(loaded!.objective).toBe('ship it');
    expect(loaded!.phases).toHaveLength(1);

    const ph = loaded!.phases[0];
    expect(ph.title).toBe('Phase One');
    expect(ph.status).toBe('in_progress');
    expect(ph.notes).toBe('a note');

    const xStep = ph.steps.find((s) => s.content === 'do the thing')!;
    expect(xStep.id).toBe('step-x'); // restored from StepMeta
    expect(xStep.status).toBe('in_progress');
    expect(xStep.activeForm).toBe('Doing the thing');
    expect(xStep.metadata).toEqual({ weight: 3 });

    const yStep = ph.steps.find((s) => s.content === 'skip this')!;
    expect(yStep.status).toBe('skipped');
  });

  it('regenerates phase ids on read (phase ids are NOT persisted in markdown)', async () => {
    // Known limitation: toMarkdown serializes the plan id + per-step StepMeta id,
    // but not phase ids. A fresh reader gets new phase ids, so callers must use
    // the reloaded plan's actual phase ids — not ids from the original create().
    const writer = new PlanManager(makeConfig());
    await writer.create(
      basePlan([
        { id: 'ph-original', title: 'Phase', status: 'pending', steps: [{ id: 's1', content: 'x', status: 'pending' }] },
      ])
    );

    const reader = new PlanManager(makeConfig());
    const loaded = await reader.read();
    expect(loaded!.phases[0].id).not.toBe('ph-original'); // regenerated
    // Mutating via a reloaded phase id works; via the original id it throws.
    await expect(reader.updateStepStatus('ph-original', 's1', 'completed')).rejects.toThrow('not found');
    await expect(
      reader.updateStepStatus(loaded!.phases[0].id, loaded!.phases[0].steps[0].id, 'completed')
    ).resolves.toBeUndefined();
  });

  it('read returns null when no plan file exists', async () => {
    const mgr = new PlanManager(makeConfig());
    expect(await mgr.exists()).toBe(false);
    expect(await mgr.read()).toBeNull();
  });
});

describe('PlanManager mutations', () => {
  const seed = async () => {
    const mgr = new PlanManager(makeConfig());
    await mgr.create(
      basePlan([
        {
          id: 'ph1',
          title: 'Phase',
          status: 'pending',
          steps: [
            { id: 's1', content: 'one', status: 'pending' },
            { id: 's2', content: 'two', status: 'pending' },
          ],
        },
      ])
    );
    return mgr;
  };

  it('updateStepStatus recomputes metadata and auto-completes the phase', async () => {
    const mgr = await seed();
    await mgr.updateStepStatus('ph1', 's1', 'completed');
    await mgr.updateStepStatus('ph1', 's2', 'completed');

    const plan = mgr.getCurrentPlan()!;
    expect(plan.metadata.completedSteps).toBe(2);
    expect(plan.phases[0].status).toBe('completed'); // auto-updated
    expect(mgr.isComplete()).toBe(true);
  });

  it('updateStepStatus marks the phase in_progress when a step is active', async () => {
    const mgr = await seed();
    await mgr.updateStepStatus('ph1', 's1', 'in_progress');
    expect(mgr.getCurrentPlan()!.phases[0].status).toBe('in_progress');
  });

  it('updatePhaseStatus sets the phase status directly', async () => {
    const mgr = await seed();
    await mgr.updatePhaseStatus('ph1', 'blocked');
    expect(mgr.getCurrentPlan()!.phases[0].status).toBe('blocked');
  });

  it('updatePhaseNotes trims and clears blank notes', async () => {
    const mgr = await seed();
    await mgr.updatePhaseNotes('ph1', '  hello  ');
    expect(mgr.getCurrentPlan()!.phases[0].notes).toBe('hello');
    await mgr.updatePhaseNotes('ph1', '   ');
    expect(mgr.getCurrentPlan()!.phases[0].notes).toBeUndefined();
  });

  it('addStep appends a step with a generated id and updates metadata', async () => {
    const mgr = await seed();
    const step = await mgr.addStep('ph1', { content: 'three', status: 'pending' });
    expect(step.id).toBeTruthy();
    expect(mgr.getCurrentPlan()!.metadata.totalSteps).toBe(3);
  });

  it('addPhase appends a pending phase', async () => {
    const mgr = await seed();
    const newPhase = await mgr.addPhase({ title: 'Second', steps: [] });
    expect(newPhase.status).toBe('pending');
    expect(mgr.getCurrentPlan()!.phases).toHaveLength(2);
  });

  it('throws a clear error for an unknown phase or step', async () => {
    const mgr = await seed();
    await expect(mgr.updateStepStatus('nope', 's1', 'completed')).rejects.toThrow('Phase nope not found');
    await expect(mgr.updateStepStatus('ph1', 'nope', 'completed')).rejects.toThrow('Step nope not found');
    await expect(mgr.updatePhaseStatus('nope', 'completed')).rejects.toThrow('Phase nope not found');
  });
});

describe('PlanManager task navigation', () => {
  it('getCurrentTask returns the in-progress phase + step', async () => {
    const mgr = new PlanManager(makeConfig());
    await mgr.create(
      basePlan([
        {
          id: 'ph1',
          title: 'P',
          status: 'in_progress',
          steps: [{ id: 's1', content: 'active', status: 'in_progress' }],
        },
      ])
    );
    const cur = mgr.getCurrentTask();
    expect(cur?.step.content).toBe('active');
  });

  it('getNextPendingTask returns the first pending step', async () => {
    const mgr = new PlanManager(makeConfig());
    await mgr.create(
      basePlan([
        {
          id: 'ph1',
          title: 'P',
          status: 'pending',
          steps: [
            { id: 's1', content: 'done', status: 'completed' },
            { id: 's2', content: 'todo', status: 'pending' },
          ],
        },
      ])
    );
    expect(mgr.getNextPendingTask()?.step.content).toBe('todo');
  });

  it('getIncompleteItems lists non-completed phases and steps', async () => {
    const mgr = new PlanManager(makeConfig());
    await mgr.create(
      basePlan([
        {
          id: 'ph1',
          title: 'Open Phase',
          status: 'in_progress',
          steps: [
            { id: 's1', content: 'pending step', status: 'pending' },
            { id: 's2', content: 'done step', status: 'completed' },
          ],
        },
      ])
    );
    const text = mgr.getIncompleteItems();
    expect(text).toContain('Phase: Open Phase');
    expect(text).toContain('pending step');
    expect(text).not.toContain('done step');
  });

  it('navigation getters return null/empty without a current plan', () => {
    const mgr = new PlanManager(makeConfig());
    expect(mgr.getCurrentTask()).toBeNull();
    expect(mgr.getNextPendingTask()).toBeNull();
    expect(mgr.getIncompleteItems()).toBe('');
    expect(mgr.isComplete()).toBe(false);
  });
});
