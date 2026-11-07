import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { PlanManager } from '../../../src/host/planning/planManager';
import { ErrorTracker } from '../../../src/host/planning/errorTracker';
import {
  createDecisionHooks,
  getDecisionHooksForPoint,
  type DecisionHooksConfig,
} from '../../../src/host/planning/hooks/decisionHooks';
import type { DecisionHook, HookPoint } from '../../../src/host/planning/hooks/types';
import { resetObserverState, actionCounter } from '../../../src/host/planning/hooks/observerHooks';
import type {
  HookContext,
  PlanningConfig,
  TaskPhase,
  TaskStep,
  TaskStepStatus,
} from '../../../src/host/planning/types';

// ----------------------------------------------------------------------------
// Fixtures: real PlanManager + ErrorTracker over a temp working directory
// ----------------------------------------------------------------------------

let workingDirectory: string;
const SESSION_ID = 'sess-decision-hooks';
const makeConfig = (): PlanningConfig => ({ workingDirectory, sessionId: SESSION_ID });

let planManager: PlanManager;
let errorTracker: ErrorTracker;

const step = (id: string, status: TaskStepStatus, content = `step ${id}`): TaskStep => ({
  id,
  content,
  status,
});

const createPlan = async (phases: TaskPhase[], title = 'Refactor Plan'): Promise<void> => {
  await planManager.create({ title, objective: 'finish the work', phases });
};

beforeEach(async () => {
  workingDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'decision-hooks-'));
  planManager = new PlanManager(makeConfig());
  errorTracker = new ErrorTracker(makeConfig());
  resetObserverState();
});

afterEach(async () => {
  await fs.rm(workingDirectory, { recursive: true, force: true });
});

const hooksById = (
  registrations: Array<{ point: HookPoint; hook: DecisionHook }>
): Record<string, DecisionHook> => {
  const byId: Record<string, DecisionHook> = {};
  for (const { hook } of registrations) {
    byId[hook.id] = hook;
  }
  return byId;
};

const makeHooks = (config?: Partial<DecisionHooksConfig>) => {
  const registrations = createDecisionHooks(planManager, errorTracker, {
    actionThreshold: 5,
    errorStrikeLimit: 3,
    ...config,
  });
  return { registrations, hooks: hooksById(registrations) };
};

describe('createDecisionHooks registry', () => {
  it('registers eight hooks at the expected hook points', () => {
    const { registrations } = makeHooks();
    expect(registrations).toHaveLength(8);
    expect(registrations.map((r) => `${r.point}:${r.hook.id}`).sort()).toEqual(
      [
        'on_error:three-strike-rule',
        'on_stop:plan-completion-check',
        'post_tool_use:three-strike-rule',
        'post_tool_use:two-action-rule',
        'post_tool_use:write-operation-reminder',
        'pre_tool_use:dangerous-bash-block',
        'pre_tool_use:pre-critical-tool-context',
        'session_start:existing-plan-reminder',
      ].sort()
    );
  });

  it('falls back to the default thresholds when config is omitted', async () => {
    const registrations = createDecisionHooks(planManager, errorTracker);
    const hooks = hooksById(registrations);

    // Default actionThreshold is 5: no reminder at 4 views, reminder at 5.
    for (let i = 0; i < 4; i++) actionCounter.observe({ toolName: 'Read' });
    expect(await hooks['two-action-rule'].decide({ toolName: 'Read' })).toEqual({ allow: true });
    actionCounter.observe({ toolName: 'Read' });
    const fifth = await hooks['two-action-rule'].decide({ toolName: 'Read' });
    expect(fifth.injectContext).toContain('5 view operations');

    // Default errorStrikeLimit is 3: no warning below 3 strikes.
    await errorTracker.log({ toolName: 'Bash', message: 'boom' });
    await errorTracker.log({ toolName: 'Bash', message: 'boom' });
    expect(
      await hooks['three-strike-rule'].decide({ toolName: 'Bash', error: new Error('boom') })
    ).toEqual({ allow: true });
    await errorTracker.log({ toolName: 'Bash', message: 'boom' });
    const struck = await hooks['three-strike-rule'].decide({
      toolName: 'Bash',
      error: new Error('boom'),
    });
    expect(struck.notification).toBe('3-Strike Warning: Error occurred 3 times');
  });
});

describe('getDecisionHooksForPoint', () => {
  it('returns the hooks of a point sorted by priority, highest first', () => {
    const { registrations } = makeHooks();
    expect(getDecisionHooksForPoint(registrations, 'post_tool_use').map((h) => h.id)).toEqual([
      'three-strike-rule',
      'two-action-rule',
      'write-operation-reminder',
    ]);
    expect(getDecisionHooksForPoint(registrations, 'pre_tool_use').map((h) => h.id)).toEqual([
      'dangerous-bash-block',
      'pre-critical-tool-context',
    ]);
    expect(getDecisionHooksForPoint(registrations, 'on_error').map((h) => h.id)).toEqual([
      'three-strike-rule',
    ]);
    expect(getDecisionHooksForPoint(registrations, 'on_stop').map((h) => h.id)).toEqual([
      'plan-completion-check',
    ]);
    expect(getDecisionHooksForPoint(registrations, 'session_start').map((h) => h.id)).toEqual([
      'existing-plan-reminder',
    ]);
  });

  it('sorts hooks without priority below prioritized ones (priority ?? 0)', () => {
    const anyMatcher = () => true;
    const plainHook: DecisionHook = {
      id: 'plain',
      name: 'Plain',
      matcher: anyMatcher,
      decide: async () => ({ allow: true }),
    };
    const prioritizedHook: DecisionHook = { ...plainHook, id: 'prioritized', priority: 10 };
    const plainHook2: DecisionHook = { ...plainHook, id: 'plain2' };
    const sorted = getDecisionHooksForPoint(
      [
        { point: 'on_stop', hook: prioritizedHook },
        { point: 'on_stop', hook: plainHook },
        { point: 'on_stop', hook: plainHook2 },
      ],
      'on_stop'
    );
    expect(sorted.map((h) => h.id)).toEqual(['prioritized', 'plain', 'plain2']);
  });
});

describe('three-strike-rule', () => {
  it('matches error contexts and failed tool results only', () => {
    const { hooks } = makeHooks();
    const matcher = hooks['three-strike-rule'].matcher;
    expect(matcher({ error: new Error('x') })).toBe(true);
    expect(matcher({ toolResult: { success: false } })).toBe(true);
    expect(matcher({ toolResult: { success: true } })).toBe(false);
    expect(matcher({})).toBe(false);
  });

  it('stays silent below the strike limit and warns once the limit is reached', async () => {
    const { hooks } = makeHooks();
    const ctx: HookContext = { toolName: 'Bash', toolResult: { success: false, error: 'boom 42' } };

    expect(await hooks['three-strike-rule'].decide(ctx)).toEqual({ allow: true });
    await errorTracker.log({ toolName: 'Bash', message: 'boom 42' });
    expect(await hooks['three-strike-rule'].decide(ctx)).toEqual({ allow: true });
    await errorTracker.log({ toolName: 'Bash', message: 'boom 42' });
    expect(await hooks['three-strike-rule'].decide(ctx)).toEqual({ allow: true });
    await errorTracker.log({ toolName: 'Bash', message: 'boom 42' });

    const decision = await hooks['three-strike-rule'].decide(ctx);
    expect(decision.allow).toBe(true);
    expect(decision.notification).toBe('3-Strike Warning: Error occurred 3 times');
    expect(decision.reason).toBe('Error threshold reached');
    expect(decision.injectContext).toContain('<three-strike-warning>');
    expect(decision.injectContext).toContain('This error has occurred 3 times!');
    expect(decision.injectContext).toContain('try a DIFFERENT approach');
  });

  it('falls back to "unknown" tool and "Unknown error" message in the lookup key', async () => {
    const { hooks } = makeHooks();
    for (let i = 0; i < 3; i++) {
      await errorTracker.log({ toolName: 'unknown', message: 'Unknown error' });
    }
    const decision = await hooks['three-strike-rule'].decide({
      toolResult: { success: false },
    });
    expect(decision.notification).toBe('3-Strike Warning: Error occurred 3 times');
  });

  it('prefers context.error.message over toolResult.error', async () => {
    const { hooks } = makeHooks();
    for (let i = 0; i < 3; i++) {
      await errorTracker.log({ toolName: 'Bash', message: 'thrown problem' });
    }
    const decision = await hooks['three-strike-rule'].decide({
      toolName: 'Bash',
      error: new Error('thrown problem'),
      toolResult: { success: false, error: 'result problem' },
    });
    expect(decision.notification).toBe('3-Strike Warning: Error occurred 3 times');
  });
});

describe('pre-critical-tool-context', () => {
  it('matches only critical tools', () => {
    const { hooks } = makeHooks();
    const matcher = hooks['pre-critical-tool-context'].matcher;
    expect(matcher({ toolName: 'Bash' })).toBe(true);
    expect(matcher({ toolName: 'Write' })).toBe(true);
    expect(matcher({ toolName: 'Edit' })).toBe(true);
    expect(matcher({ toolName: 'Read' })).toBe(false);
    expect(matcher({})).toBe(false);
  });

  it('allows with no injected context when no plan exists', async () => {
    const { hooks } = makeHooks();
    const decision = await hooks['pre-critical-tool-context'].decide({ toolName: 'Bash' });
    expect(decision).toEqual({ allow: true });
    expect(decision.injectContext).toBeUndefined();
  });

  it('injects error history with the [3-STRIKE] marker and the current task', async () => {
    await createPlan([
      {
        id: 'ph1',
        title: 'Implement',
        status: 'in_progress',
        steps: [step('s1', 'in_progress', 'write the parser'), step('s2', 'pending')],
      },
    ]);
    for (let i = 0; i < 3; i++) {
      await errorTracker.log({ toolName: 'Bash', message: 'permission denied' });
    }
    await errorTracker.log({ toolName: 'Bash', message: 'syntax error' });

    const { hooks } = makeHooks();
    const decision = await hooks['pre-critical-tool-context'].decide({ toolName: 'Bash' });

    expect(decision.allow).toBe(true);
    expect(decision.injectContext).toContain('<error-history>');
    expect(decision.injectContext).toContain('Previous failures with Bash:');
    // Same message logged 3 times collapses into one counted record.
    expect(decision.injectContext).toContain('- permission denied (3 times) [3-STRIKE]');
    expect(decision.injectContext).toContain('- syntax error (1 times)');
    expect(decision.injectContext).toContain('Avoid repeating these mistakes.');
    expect(decision.injectContext).toContain('<current-task>');
    expect(decision.injectContext).toContain('Phase: Implement');
    expect(decision.injectContext).toContain('Step: write the parser');
  });

  it('caps the injected history at 3 records', async () => {
    await createPlan([
      { id: 'ph1', title: 'Implement', status: 'in_progress', steps: [step('s1', 'pending')] },
    ]);
    // Give each record a distinct timestamp so recency ordering is deterministic.
    // Messages must differ without digits: the tracker normalizes digits to "N"
    // for dedup, so "e1".."e4" would collapse into one counted record.
    let tick = 1000;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => tick++);
    for (const message of ['alpha', 'bravo', 'charlie', 'delta']) {
      await errorTracker.log({ toolName: 'Write', message });
    }
    nowSpy.mockRestore();
    const { hooks } = makeHooks();
    const decision = await hooks['pre-critical-tool-context'].decide({ toolName: 'Write' });
    expect(decision.injectContext).toContain('- delta (1 times)');
    expect(decision.injectContext).toContain('- charlie (1 times)');
    expect(decision.injectContext).toContain('- bravo (1 times)');
    expect(decision.injectContext).not.toContain('- alpha (');
  });

  it('injects undefined context when the plan has neither errors nor a current task', async () => {
    await createPlan([
      { id: 'ph1', title: 'Implement', status: 'pending', steps: [step('s1', 'pending')] },
    ]);
    const { hooks } = makeHooks();
    const decision = await hooks['pre-critical-tool-context'].decide({ toolName: 'Bash' });
    expect(decision).toEqual({ allow: true, injectContext: undefined });
  });

  it('labels the error history "unknown" when the context has no tool name', async () => {
    await createPlan([
      { id: 'ph1', title: 'Implement', status: 'in_progress', steps: [step('s1', 'pending')] },
    ]);
    await errorTracker.log({ toolName: 'unknown', message: 'mystery failure' });
    const { hooks } = makeHooks();
    const decision = await hooks['pre-critical-tool-context'].decide({});
    expect(decision.injectContext).toContain('Previous failures with unknown:');
    expect(decision.injectContext).toContain('- mystery failure (1 times)');
  });
});

describe('two-action-rule', () => {
  it('matches only view tools', () => {
    const { hooks } = makeHooks();
    const matcher = hooks['two-action-rule'].matcher;
    for (const tool of ['Read', 'Glob', 'Grep', 'ListDirectory', 'WebFetch']) {
      expect(matcher({ toolName: tool })).toBe(true);
    }
    expect(matcher({ toolName: 'Bash' })).toBe(false);
    expect(matcher({})).toBe(false);
  });

  it('injects the reminder once the action threshold is reached', async () => {
    const { hooks } = makeHooks({ actionThreshold: 2 });
    expect(await hooks['two-action-rule'].decide({ toolName: 'Read' })).toEqual({ allow: true });

    actionCounter.observe({ toolName: 'Read' });
    actionCounter.observe({ toolName: 'Read' });

    const decision = await hooks['two-action-rule'].decide({ toolName: 'Read' });
    expect(decision.allow).toBe(true);
    expect(decision.reason).toBe('Action threshold reached');
    expect(decision.injectContext).toContain('You\'ve performed 2 view operations without writing');
    expect(decision.injectContext).toContain('STOP READING AND START ACTING');
  });

  it('counts the global action counter, which write tools reset via observers', async () => {
    const { hooks } = makeHooks({ actionThreshold: 1 });
    actionCounter.observe({ toolName: 'Grep' });
    const hit = await hooks['two-action-rule'].decide({ toolName: 'Grep' });
    expect(hit.injectContext).toContain('1 view operations');

    resetObserverState();
    expect(await hooks['two-action-rule'].decide({ toolName: 'Grep' })).toEqual({ allow: true });
  });
});

describe('write-operation-reminder', () => {
  it('matches successful write tools only', () => {
    const { hooks } = makeHooks();
    const matcher = hooks['write-operation-reminder'].matcher;
    expect(matcher({ toolName: 'Write', toolResult: { success: true } })).toBe(true);
    expect(matcher({ toolName: 'Edit', toolResult: { success: true } })).toBe(true);
    expect(matcher({ toolName: 'Write', toolResult: { success: false } })).toBe(false);
    expect(matcher({ toolName: 'Write' })).toBe(false);
    expect(matcher({ toolName: 'Bash', toolResult: { success: true } })).toBe(false);
  });

  it('always injects the write reminder', async () => {
    const { hooks } = makeHooks();
    const decision = await hooks['write-operation-reminder'].decide({
      toolName: 'Write',
      toolResult: { success: true },
    });
    expect(decision).toEqual({ allow: true, injectContext: expect.stringContaining('<reminder>') });
    expect(decision.injectContext).toContain('updating task_plan.md');
    expect(decision.injectContext).toContain('plan_read');
  });
});

describe('dangerous-bash-block', () => {
  it('matches dangerous bash commands and canonicalization failures', () => {
    const { hooks } = makeHooks();
    const matcher = hooks['dangerous-bash-block'].matcher;
    expect(matcher({ toolName: 'Bash', toolParams: { command: 'rm -rf /tmp/x' } })).toBe(true);
    expect(matcher({ toolName: 'bash', toolParams: { command: 'rm -fr ~' } })).toBe(true);
    expect(matcher({ toolName: 'Bash', toolParams: { command: 'chmod -R 777 /etc' } })).toBe(true);
    expect(matcher({ toolName: 'Bash', toolParams: { command: 'ls -la' } })).toBe(false);
    expect(matcher({ toolName: 'Read', toolParams: { command: 'rm -rf /' } })).toBe(false);
    expect(matcher({ toolName: 'Bash', toolParams: {} })).toBe(false);
    expect(matcher({ toolName: 'Bash' })).toBe(false);
  });

  it('flags a plain "chmod 777" as dangerous', () => {
    const { hooks } = makeHooks();
    const matcher = hooks['dangerous-bash-block'].matcher;
    expect(matcher({ toolName: 'Bash', toolParams: { command: 'chmod 777 /etc' } })).toBe(true);
  });

  it('blocks with a safety notice containing the truncated command', async () => {
    const { hooks } = makeHooks();
    const decision = await hooks['dangerous-bash-block'].decide({
      toolName: 'Bash',
      toolParams: { command: 'rm -rf /usr' },
    });
    expect(decision.allow).toBe(false);
    expect(decision.notification).toBe('Blocked potentially dangerous command');
    expect(decision.reason).toBe('Dangerous command detected');
    expect(decision.injectContext).toContain('<safety-block>');
    expect(decision.injectContext).toContain('The command "rm -rf /usr..." was blocked for safety.');
    expect(decision.injectContext).toContain('confirm with the user');
    expect(decision.injectContext).toContain('</safety-block>');
  });

  it('truncates long commands to 50 characters in the injected context', async () => {
    const { hooks } = makeHooks();
    const longCommand = `rm -rf ${'x'.repeat(60)}`;
    const decision = await hooks['dangerous-bash-block'].decide({
      toolName: 'Bash',
      toolParams: { command: longCommand },
    });
    expect(decision.injectContext).toContain(`"${longCommand.slice(0, 50)}..."`);
    expect(decision.injectContext).not.toContain(longCommand);
  });
});

describe('plan-completion-check', () => {
  const onStop = async () => makeHooks().hooks['plan-completion-check'].decide({});

  it('allows stopping freely when no plan exists', async () => {
    expect(await onStop()).toEqual({ allow: true });
  });

  it('allows stopping without a notification for small plans (<= 4 steps)', async () => {
    await createPlan([
      {
        id: 'ph1',
        title: 'Small',
        status: 'in_progress',
        steps: [step('s1', 'completed'), step('s2', 'completed'), step('s3', 'pending')],
      },
    ]);
    const decision = await onStop();
    expect(decision).toEqual({ allow: true });
    expect(decision.notification).toBeUndefined();
    expect(decision.injectContext).toBeUndefined();
  });

  it('allows with a progress notification when at least half of the steps are done', async () => {
    await createPlan([
      {
        id: 'ph1',
        title: 'Halfway',
        status: 'in_progress',
        steps: [
          step('s1', 'completed'),
          step('s2', 'completed'),
          step('s3', 'completed'),
          step('s4', 'pending'),
          step('s5', 'pending'),
          step('s6', 'pending'),
        ],
      },
    ]);
    const decision = await onStop();
    expect(decision.allow).toBe(true);
    expect(decision.notification).toBe('Good progress! 3 items remaining - reply to continue.');
  });

  it('allows with a completion notification when every phase is completed', async () => {
    // All phases are completed but the metadata says 0/5 — this pins the
    // isComplete() branch independently of the "at least half done" branch.
    await createPlan([
      {
        id: 'ph1',
        title: 'Marked done',
        status: 'completed',
        steps: [step('s1', 'pending'), step('s2', 'pending')],
      },
      {
        id: 'ph2',
        title: 'Also marked done',
        status: 'completed',
        steps: [step('s3', 'pending'), step('s4', 'pending'), step('s5', 'pending')],
      },
    ]);
    const decision = await onStop();
    expect(decision.allow).toBe(true);
    expect(decision.notification).toBe('Plan completed: 0/5 steps');
  });

  it('allows with an almost-done notification when at most 3 items remain', async () => {
    await createPlan([
      {
        id: 'ph1',
        title: 'Tail work',
        status: 'in_progress',
        steps: [
          step('s1', 'completed'),
          step('s2', 'completed'),
          step('s3', 'pending'),
          step('s4', 'pending'),
          step('s5', 'pending'),
        ],
      },
    ]);
    const decision = await onStop();
    expect(decision.allow).toBe(true);
    expect(decision.notification).toBe('Almost done! 3 items remaining.');
  });

  it('reports zero remaining items when the only incomplete phase has only skipped steps', async () => {
    // Phase is "blocked" (not completed) so the plan is incomplete, but every
    // step is skipped: the incomplete summary has no newline, exercising the
    // (match(/\n/g) || []) fallback in the incomplete-count computation.
    await createPlan([
      {
        id: 'ph1',
        title: 'Abandoned',
        status: 'blocked',
        steps: [step('s1', 'skipped'), step('s2', 'skipped'), step('s3', 'skipped'), step('s4', 'skipped'), step('s5', 'skipped')],
      },
    ]);
    const decision = await onStop();
    expect(decision.allow).toBe(true);
    expect(decision.notification).toBe('Almost done! 0 items remaining.');
  });

  it('blocks the stop with the incomplete list when enough work remains', async () => {
    await createPlan([
      {
        id: 'ph1',
        title: 'Alpha',
        status: 'in_progress',
        steps: [step('s1', 'pending'), step('s2', 'pending'), step('s3', 'pending')],
      },
      {
        id: 'ph2',
        title: 'Beta',
        status: 'pending',
        steps: [step('s4', 'pending'), step('s5', 'pending'), step('s6', 'pending')],
      },
    ]);
    const decision = await onStop();
    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe('Plan not complete');
    expect(decision.notification).toBe('Plan incomplete - verification required');
    expect(decision.injectContext).toContain('<completion-check>');
    expect(decision.injectContext).toContain('WARNING: Plan is not complete!');
    expect(decision.injectContext).toContain('Phase: Alpha');
    expect(decision.injectContext).toContain('- step s2');
    expect(decision.injectContext).toContain('Phase: Beta');
    expect(decision.injectContext).toContain('mark them as skipped');
  });
});

describe('existing-plan-reminder', () => {
  const onSessionStart = async () =>
    makeHooks().hooks['existing-plan-reminder'].decide({});

  it('allows silently when no plan exists', async () => {
    expect(await onSessionStart()).toEqual({ allow: true });
  });

  it('allows silently when the existing plan is complete', async () => {
    await createPlan([
      {
        id: 'ph1',
        title: 'Done deal',
        status: 'completed',
        steps: [step('s1', 'completed'), step('s2', 'completed')],
      },
    ]);
    expect(await onSessionStart()).toEqual({ allow: true });
  });

  it('reminds about an incomplete plan with the current task section', async () => {
    await createPlan([
      {
        id: 'ph1',
        title: 'Implement',
        status: 'in_progress',
        steps: [step('s1', 'completed'), step('s2', 'in_progress', 'write the parser')],
      },
    ]);
    const decision = await onSessionStart();
    expect(decision.allow).toBe(true);
    expect(decision.notification).toBe('Found existing plan: Refactor Plan (1/2 completed)');
    expect(decision.injectContext).toContain('<existing-plan>');
    expect(decision.injectContext).toContain('Plan: Refactor Plan');
    expect(decision.injectContext).toContain('Objective: finish the work');
    expect(decision.injectContext).toContain('Progress: 1/2 steps completed');
    expect(decision.injectContext).toContain('Current task:');
    expect(decision.injectContext).toContain('- Phase: Implement');
    expect(decision.injectContext).toContain('- Step: write the parser');
    expect(decision.injectContext).toContain('Please continue from where you left off.');
    expect(decision.injectContext).toContain('</existing-plan>');
  });

  it('omits the current task section when no step is in progress', async () => {
    await createPlan([
      {
        id: 'ph1',
        title: 'Implement',
        status: 'pending',
        steps: [step('s1', 'pending'), step('s2', 'pending')],
      },
    ]);
    const decision = await onSessionStart();
    expect(decision.notification).toBe('Found existing plan: Refactor Plan (0/2 completed)');
    expect(decision.injectContext).not.toContain('Current task:');
    expect(decision.injectContext).toContain('Progress: 0/2 steps completed');
  });
});
