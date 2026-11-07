import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { HooksEngine } from '../../../src/host/planning/hooksEngine';
import { PlanManager } from '../../../src/host/planning/planManager';
import { ErrorTracker } from '../../../src/host/planning/errorTracker';
import { FindingsManager } from '../../../src/host/planning/findingsManager';
import {
  actionCounter,
  getActionCount,
  getObserversForPoint,
  resetObserverState,
} from '../../../src/host/planning/hooks/observerHooks';
import type {
  HookPoint,
  ObserverHook,
} from '../../../src/host/planning/hooks/types';
import type {
  HookContext,
  PlanningConfig,
  TaskPhase,
  TaskPlan,
  TaskStep,
  TaskStepStatus,
} from '../../../src/host/planning/types';

// The observer registry is resolved from the module-level observerHooks list
// via getObserversForPoint, so the failure-isolation tests below swap that one
// function for a controllable vi.fn. The factory bakes the real registry as
// the mock's original implementation (every other export — the shared state
// helpers and built-in hooks — stays real), and beforeEach mockReset()s back
// to it.
vi.mock('../../../src/host/planning/hooks/observerHooks', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../../../src/host/planning/hooks/observerHooks')
  >();
  return { ...actual, getObserversForPoint: vi.fn(actual.getObserversForPoint) };
});

const getObserversForPointMock = vi.mocked(getObserversForPoint);

// ----------------------------------------------------------------------------
// Fixtures: real PlanManager + ErrorTracker + FindingsManager over a temp dir
// ----------------------------------------------------------------------------

let workingDirectory: string;
const SESSION_ID = 'sess-hooks-engine';
const makeConfig = (): PlanningConfig => ({ workingDirectory, sessionId: SESSION_ID });

let planManager: PlanManager;
let errorTracker: ErrorTracker;
let findingsManager: FindingsManager;
let engine: HooksEngine;

const step = (id: string, status: TaskStepStatus, content = `step ${id}`): TaskStep => ({
  id,
  content,
  status,
});

const createPlan = async (phases: TaskPhase[], title = 'Integration Plan'): Promise<void> => {
  await planManager.create({ title, objective: 'finish the work', phases });
};

const blockingPlan = (): TaskPhase[] => [
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
];

beforeEach(async () => {
  workingDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'hooks-engine-'));
  planManager = new PlanManager(makeConfig());
  errorTracker = new ErrorTracker(makeConfig());
  findingsManager = new FindingsManager(makeConfig());
  engine = new HooksEngine(planManager, errorTracker, findingsManager);
  getObserversForPointMock.mockReset(); // back to the real observer registry
  resetObserverState();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(workingDirectory, { recursive: true, force: true });
});

describe('HooksEngine construction and config merging', () => {
  it('merges partial hooks and rules config over the defaults', async () => {
    const tuned = new HooksEngine(planManager, errorTracker, findingsManager, {
      hooks: { preToolUse: false },
      rules: { actionThreshold: 2 },
    });

    // hooks.preToolUse is disabled and short-circuits to an empty aggregated result.
    expect(await tuned.preToolUse({ toolName: 'Read' })).toEqual({
      shouldContinue: true,
      decisions: [],
      observerErrors: [],
    });

    // postToolUse stays on by default and still runs its decision hooks.
    const writeResult = await tuned.postToolUse({
      toolName: 'Write',
      toolResult: { success: true },
    });
    expect(writeResult.decisions.map((d) => d.hookId)).toEqual(['write-operation-reminder']);

    // rules.actionThreshold merge: the reminder fires at 2 views, not 5.
    await tuned.postToolUse({ toolName: 'Read' });
    const secondRead = await tuned.postToolUse({ toolName: 'Read' });
    expect(secondRead.injectContext).toContain('2 view operations');
  });

  it('merges dualChannel config over the defaults (decisions off = no blocking)', async () => {
    const noDecisions = new HooksEngine(planManager, errorTracker, findingsManager, {
      dualChannel: { enableDecisions: false },
    });
    const result = await noDecisions.preToolUse({
      toolName: 'Bash',
      toolParams: { command: 'rm -rf /tmp/x' },
    });
    expect(result.shouldContinue).toBe(true);
    expect(result.decisions).toEqual([]);
    expect(result.injectContext).toBeUndefined();
    expect(result.notification).toBeUndefined();
  });

  it('registers the eight built-in decision hooks and returns a copy', () => {
    const registered = engine.getRegisteredDecisionHooks();
    expect(registered).toHaveLength(8);
    expect(registered.map((r) => r.hook.id)).toContain('dangerous-bash-block');
    expect(registered.map((r) => r.point)).toContain('session_start');

    registered.push(registered[0]);
    expect(engine.getRegisteredDecisionHooks()).toHaveLength(8);
  });

  it('resetActionCount/getActionCount delegate to the observer state', () => {
    actionCounter.observe({ toolName: 'Read' });
    expect(engine.getActionCount()).toBe(1);
    engine.resetActionCount();
    expect(engine.getActionCount()).toBe(0);
  });
});

describe('onSessionStart', () => {
  it('resets observer state and surfaces the existing-plan reminder', async () => {
    await createPlan([
      {
        id: 'ph1',
        title: 'Implement',
        status: 'in_progress',
        steps: [step('s1', 'completed'), step('s2', 'in_progress', 'write the parser')],
      },
    ]);
    actionCounter.observe({ toolName: 'Read' });
    actionCounter.observe({ toolName: 'Read' });

    const bridge = vi.fn<(point: HookPoint, context: HookContext) => void>();
    const sessionEngine = new HooksEngine(planManager, errorTracker, findingsManager, {
      onBridgeEvent: bridge,
    });

    const result = await sessionEngine.onSessionStart();

    expect(getActionCount()).toBe(0);
    expect(result.shouldContinue).toBe(true);
    expect(result.decisions.map((d) => d.hookId)).toEqual(['existing-plan-reminder']);
    expect(result.notification).toBe('Found existing plan: Integration Plan (1/2 completed)');
    expect(result.injectContext).toContain('<existing-plan>');
    expect(result.observerErrors).toEqual([]);
    expect(bridge).toHaveBeenCalledWith('session_start', expect.objectContaining({ actionCount: 0 }));
  });
});

describe('preToolUse', () => {
  it('blocks a dangerous bash command before the other hooks run', async () => {
    const result = await engine.preToolUse({
      toolName: 'Bash',
      toolParams: { command: 'rm -rf /tmp/x' },
    });
    expect(result.shouldContinue).toBe(false);
    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0].hookId).toBe('dangerous-bash-block');
    expect(result.decisions[0].decision).toMatchObject({
      allow: false,
      notification: 'Blocked potentially dangerous command',
      reason: 'Dangerous command detected',
    });
    expect(result.decisions[0].decision.injectContext).toContain('<safety-block>');
  });

  it('lets a safe bash command through to the critical-tool context hook', async () => {
    const result = await engine.preToolUse({
      toolName: 'Bash',
      toolParams: { command: 'ls -la' },
    });
    expect(result.shouldContinue).toBe(true);
    expect(result.decisions.map((d) => d.hookId)).toEqual(['pre-critical-tool-context']);
    expect(result.decisions[0].decision).toEqual({ allow: true });
  });

  it('does not fire the bridge callback when the hook is disabled', async () => {
    const bridge = vi.fn<(point: HookPoint, context: HookContext) => void>();
    const disabled = new HooksEngine(planManager, errorTracker, findingsManager, {
      hooks: { preToolUse: false },
      onBridgeEvent: bridge,
    });
    expect(await disabled.preToolUse({ toolName: 'Read' })).toEqual({
      shouldContinue: true,
      decisions: [],
      observerErrors: [],
    });
    expect(bridge).not.toHaveBeenCalled();
  });
});

describe('postToolUse error logging', () => {
  it('logs failed tool results to the error tracker with params', async () => {
    await engine.postToolUse({
      toolName: 'Bash',
      toolParams: { cmd: 'ls' },
      toolResult: { success: false, error: 'exit 1' },
    });
    const all = await errorTracker.getAll();
    expect(all).toHaveLength(1);
    expect(all[0].toolName).toBe('Bash');
    expect(all[0].message).toBe('exit 1');
    expect(all[0].params).toEqual({ cmd: 'ls' });
  });

  it('does not log successful results or failures without error text', async () => {
    await engine.postToolUse({ toolName: 'Bash', toolResult: { success: true } });
    await engine.postToolUse({ toolName: 'Bash', toolResult: { success: false } });
    expect(await errorTracker.getAll()).toHaveLength(0);
  });

  it('falls back to the "unknown" tool name when none is given', async () => {
    await engine.postToolUse({ toolResult: { success: false, error: 'nope' } });
    const all = await errorTracker.getAll();
    expect(all).toHaveLength(1);
    expect(all[0].toolName).toBe('unknown');
  });

  it('raises the 3-strike warning on the third identical failure', async () => {
    const failed = (): HookContext => ({
      toolName: 'Bash',
      toolResult: { success: false, error: 'boom' },
    });

    expect((await engine.postToolUse(failed())).injectContext).toBeUndefined();
    expect((await engine.postToolUse(failed())).injectContext).toBeUndefined();

    const third = await engine.postToolUse(failed());
    expect(third.injectContext).toContain('<three-strike-warning>');
    expect(third.notification).toBe('3-Strike Warning: Error occurred 3 times');
    expect(third.shouldContinue).toBe(true);
  });

  it('combines inject context from multiple decision hooks, trimmed', async () => {
    const tuned = new HooksEngine(planManager, errorTracker, findingsManager, {
      rules: { actionThreshold: 3 },
    });
    const failedRead = (): HookContext => ({
      toolName: 'Read',
      toolResult: { success: false, error: 'boom' },
    });

    await tuned.postToolUse(failedRead());
    await tuned.postToolUse(failedRead());
    const third = await tuned.postToolUse(failedRead());

    expect(third.decisions.map((d) => d.hookId)).toEqual(['three-strike-rule', 'two-action-rule']);
    expect(third.injectContext).toContain('<three-strike-warning>');
    expect(third.injectContext).toContain('STOP READING AND START ACTING');
    expect(third.injectContext?.startsWith('<three-strike-warning>')).toBe(true);
    expect(third.injectContext?.endsWith('</reminder>')).toBe(true);
  });

  it('reminds to update the plan after a successful write and resets the view counter', async () => {
    for (let i = 0; i < 3; i++) actionCounter.observe({ toolName: 'Read' });
    const result = await engine.postToolUse({ toolName: 'Write', toolResult: { success: true } });
    expect(result.decisions.map((d) => d.hookId)).toEqual(['write-operation-reminder']);
    expect(result.injectContext).toContain('File operation completed');
    expect(result.injectContext).toContain('plan_read');
    expect(getActionCount()).toBe(0);
  });

  it('raises the view-ops reminder once the default threshold of 5 is crossed', async () => {
    for (let i = 0; i < 4; i++) {
      expect((await engine.postToolUse({ toolName: 'Read' })).injectContext).toBeUndefined();
    }
    const fifth = await engine.postToolUse({ toolName: 'Read' });
    expect(fifth.injectContext).toContain('5 view operations without writing');
    expect(fifth.injectContext).toContain('STOP READING AND START ACTING');
  });
});

describe('onStop', () => {
  it('blocks the stop with the incomplete list while much work remains', async () => {
    await createPlan(blockingPlan());
    const result = await engine.onStop();
    expect(result.shouldContinue).toBe(false);
    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0].hookId).toBe('plan-completion-check');
    expect(result.decisions[0].decision.allow).toBe(false);
    expect(result.injectContext).toContain('<completion-check>');
    expect(result.injectContext).toContain('Phase: Alpha');
    expect(result.notification).toBe('Plan incomplete - verification required');
  });

  it('allows the stop when no plan exists', async () => {
    const result = await engine.onStop();
    expect(result.shouldContinue).toBe(true);
    expect(result.decisions).toEqual([{ hookId: 'plan-completion-check', decision: { allow: true } }]);
    expect(result.notification).toBeUndefined();
  });

  it('fail-open: a hung decision hook resolves allow after decisionTimeout', async () => {
    await createPlan(blockingPlan()); // would block if the hook could decide
    let release: (() => void) | undefined;
    const readSpy = vi.spyOn(planManager, 'read').mockImplementation(
      () => new Promise<TaskPlan | null>((resolve) => { release = () => resolve(null); })
    );
    const hung = new HooksEngine(planManager, errorTracker, findingsManager, {
      dualChannel: { decisionTimeout: 1 },
    });
    try {
      const result = await hung.onStop();
      expect(result.shouldContinue).toBe(true);
      expect(result.decisions).toEqual([
        {
          hookId: 'plan-completion-check',
          decision: { allow: true, reason: 'Decision hook timed out' },
        },
      ]);
      expect(result.injectContext).toBeUndefined();
    } finally {
      release?.();
      readSpy.mockRestore();
    }
  });
});

describe('onError', () => {
  it('logs the error with stack and params, then runs the on_error hooks', async () => {
    const boom = new Error('kaboom');
    const result = await engine.onError({ toolName: 'Bash', error: boom, toolParams: { p: 1 } });
    const all = await errorTracker.getAll();
    expect(all).toHaveLength(1);
    expect(all[0].toolName).toBe('Bash');
    expect(all[0].message).toBe('kaboom');
    expect(all[0].stack).toBe(boom.stack);
    expect(all[0].params).toEqual({ p: 1 });
    expect(result.decisions.map((d) => d.hookId)).toEqual(['three-strike-rule']);
    expect(result.decisions[0].decision).toEqual({ allow: true });
    expect(result.shouldContinue).toBe(true);
  });

  it('falls back to "Unknown error" and the "unknown" tool name', async () => {
    await engine.onError({ error: new Error('') });
    const all = await errorTracker.getAll();
    expect(all).toHaveLength(1);
    expect(all[0].toolName).toBe('unknown');
    expect(all[0].message).toBe('Unknown error');
  });

  it('short-circuits without logging when disabled', async () => {
    const disabled = new HooksEngine(planManager, errorTracker, findingsManager, {
      hooks: { onStop: false, onError: false, postToolUse: false },
    });
    const disabledResult = {
      shouldContinue: true,
      decisions: [],
      observerErrors: [],
    };
    expect(await disabled.onError({ error: new Error('kaboom') })).toEqual(disabledResult);
    expect(await disabled.onStop()).toEqual(disabledResult);
    expect(
      await disabled.postToolUse({ toolName: 'Bash', toolResult: { success: false, error: 'boom' } })
    ).toEqual(disabledResult);
    expect(await errorTracker.getAll()).toHaveLength(0);
  });
});

describe('dual-channel observer behavior', () => {
  it('skips the observer channel entirely when enableObservers is false', async () => {
    const noObservers = new HooksEngine(planManager, errorTracker, findingsManager, {
      dualChannel: { enableObservers: false },
    });
    const bridge = vi.fn<(point: HookPoint, context: HookContext) => void>();
    noObservers.setBridgeCallback(bridge);

    const result = await noObservers.postToolUse({ toolName: 'Read' });
    expect(getActionCount()).toBe(0); // action-counter observer never ran
    expect(result.observerErrors).toEqual([]);
    expect(result.decisions.map((d) => d.hookId)).toEqual(['two-action-rule']);
    expect(bridge).toHaveBeenCalledWith('post_tool_use', expect.objectContaining({ actionCount: 0 }));
  });

  it('runs observers sequentially when parallelObservers is false', async () => {
    const sequential = new HooksEngine(planManager, errorTracker, findingsManager, {
      dualChannel: { parallelObservers: false },
    });
    const result = await sequential.postToolUse({
      toolName: 'Read',
      toolResult: { success: false, error: 'boom' },
    });
    expect(getActionCount()).toBe(1);
    expect(result.observerErrors).toEqual([]);
    expect(result.decisions.map((d) => d.hookId)).toEqual(['three-strike-rule', 'two-action-rule']);
  });

  it('runs observers in parallel by default with the same outcomes', async () => {
    const result = await engine.postToolUse({
      toolName: 'Read',
      toolResult: { success: false, error: 'boom' },
    });
    expect(getActionCount()).toBe(1);
    expect(result.observerErrors).toEqual([]);
    expect(result.decisions.map((d) => d.hookId)).toEqual(['three-strike-rule', 'two-action-rule']);
  });

  it('injects the action count as of entry into the bridged context', async () => {
    // The enriched context snapshot is taken before this run's observers
    // increment the counter, so the bridge sees the pre-run count.
    const bridge = vi.fn<(point: HookPoint, context: HookContext) => void>();
    engine.setBridgeCallback(bridge);
    await engine.postToolUse({ toolName: 'Read' });
    expect(bridge).toHaveBeenCalledTimes(1);
    expect(bridge).toHaveBeenCalledWith('post_tool_use', expect.objectContaining({ actionCount: 0 }));
    await engine.postToolUse({ toolName: 'Read' });
    expect(bridge).toHaveBeenCalledWith('post_tool_use', expect.objectContaining({ actionCount: 1 }));
  });

  it('swallows bridge callback errors so planning never blocks on the bridge', async () => {
    engine.setBridgeCallback(() => {
      throw new Error('bridge exploded');
    });
    const result = await engine.preToolUse({ toolName: 'Bash', toolParams: { command: 'ls' } });
    expect(result.shouldContinue).toBe(true);
    expect(result.decisions.map((d) => d.hookId)).toEqual(['pre-critical-tool-context']);
  });

  it('replaces the constructor bridge callback with setBridgeCallback', async () => {
    const constructorBridge = vi.fn<(point: HookPoint, context: HookContext) => void>();
    const lateBridge = vi.fn<(point: HookPoint, context: HookContext) => void>();
    const lateBound = new HooksEngine(planManager, errorTracker, findingsManager, {
      onBridgeEvent: constructorBridge,
    });
    lateBound.setBridgeCallback(lateBridge);
    await lateBound.postToolUse({ toolName: 'Read' });
    expect(constructorBridge).not.toHaveBeenCalled();
    expect(lateBridge).toHaveBeenCalledTimes(1);
  });
});

describe('decision hook failure isolation', () => {
  it('logs a throwing decision hook and still runs the hooks after it', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(errorTracker, 'getErrorCount').mockRejectedValueOnce(new Error('tracker down'));

    const result = await engine.postToolUse({
      toolName: 'Read',
      toolResult: { success: false, error: 'boom' },
    });

    expect(consoleSpy).toHaveBeenCalledWith(
      'Decision hook three-strike-rule failed:',
      expect.any(Error)
    );
    expect(result.shouldContinue).toBe(true);
    expect(result.decisions.map((d) => d.hookId)).toEqual(['two-action-rule']);
    expect(result.injectContext).toBeUndefined();
  });
});

describe('observer channel failure isolation', () => {
  // Custom observers injected through the getObserversForPoint mock. The
  // healthy observer proves the channel keeps running alongside failures.
  const throwingObserver = (): ObserverHook => ({
    id: 'throwing-observer',
    name: 'Throwing Observer',
    matcher: () => true,
    observe: async () => {
      throw new Error('observer exploded');
    },
  });

  const hangingObserver = (): ObserverHook => ({
    id: 'hanging-observer',
    name: 'Hanging Observer',
    matcher: () => true,
    observe: () => new Promise<void>(() => {}),
  });

  const makeHealthyObserver = () => {
    const observe = vi.fn<(context: HookContext) => Promise<void>>(async () => {});
    const observer: ObserverHook = {
      id: 'healthy-observer',
      name: 'Healthy Observer',
      matcher: () => true,
      observe,
    };
    return { observer, observe };
  };

  it('parallel channel records thrown and timed-out observers while the healthy observer and decisions still run', async () => {
    const healthy = makeHealthyObserver();
    getObserversForPointMock.mockReturnValue([healthy.observer, throwingObserver(), hangingObserver()]);
    const timed = new HooksEngine(planManager, errorTracker, findingsManager, {
      dualChannel: { observerTimeout: 10 },
    });

    vi.useFakeTimers();
    try {
      const pending = timed.preToolUse({ toolName: 'Bash', toolParams: { command: 'ls -la' } });
      await vi.advanceTimersByTimeAsync(10);
      const result = await pending;

      // Promise.allSettled preserves input order, so the rejections land in order.
      expect(result.observerErrors.map((e) => e.hookId)).toEqual([
        'throwing-observer',
        'hanging-observer',
      ]);
      expect(result.observerErrors[0].error.message).toBe('observer exploded');
      expect(result.observerErrors[1].error.message).toBe('Observer hanging-observer timed out');
      expect(healthy.observe).toHaveBeenCalledOnce();
      expect(result.decisions.map((d) => d.hookId)).toEqual(['pre-critical-tool-context']);
      expect(result.shouldContinue).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('sequential channel records thrown and timed-out observers while the healthy observer and decisions still run', async () => {
    const healthy = makeHealthyObserver();
    getObserversForPointMock.mockReturnValue([healthy.observer, throwingObserver(), hangingObserver()]);
    const timed = new HooksEngine(planManager, errorTracker, findingsManager, {
      dualChannel: { observerTimeout: 10, parallelObservers: false },
    });

    vi.useFakeTimers();
    try {
      const pending = timed.preToolUse({ toolName: 'Bash', toolParams: { command: 'ls -la' } });
      await vi.advanceTimersByTimeAsync(10);
      const result = await pending;

      expect(result.observerErrors.map((e) => e.hookId)).toEqual([
        'throwing-observer',
        'hanging-observer',
      ]);
      expect(result.observerErrors[0].error.message).toBe('observer exploded');
      expect(result.observerErrors[1].error.message).toBe('Observer hanging-observer timed out');
      expect(healthy.observe).toHaveBeenCalledOnce();
      expect(result.decisions.map((d) => d.hookId)).toEqual(['pre-critical-tool-context']);
      expect(result.shouldContinue).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('observer errors never flip shouldContinue: a thrown observer is recorded and the run stays green', async () => {
    const healthy = makeHealthyObserver();
    getObserversForPointMock.mockReturnValue([throwingObserver(), healthy.observer]);

    const result = await engine.postToolUse({ toolName: 'Write', toolResult: { success: true } });

    expect(result.observerErrors).toHaveLength(1);
    expect(result.observerErrors[0].hookId).toBe('throwing-observer');
    expect(result.observerErrors[0].error.message).toBe('observer exploded');
    expect(healthy.observe).toHaveBeenCalledOnce();
    expect(result.decisions.map((d) => d.hookId)).toEqual(['write-operation-reminder']);
    expect(result.shouldContinue).toBe(true);
  });
});
