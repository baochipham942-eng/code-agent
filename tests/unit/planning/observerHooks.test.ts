import { beforeEach, describe, expect, it } from 'vitest';
import {
  resetObserverState,
  getActionCount,
  getToolUsageStats,
  toolUsageLogger,
  actionCounter,
  actionCounterReset,
  errorStatisticsObserver,
  criticalToolMonitor,
  sessionActivityTracker,
  observerHooks,
  getObserversForPoint,
} from '../../../src/main/planning/hooks/observerHooks';
import type { HookContext } from '../../../src/main/planning/types';

const ctx = (over: Partial<HookContext> = {}): HookContext => ({ ...over });

beforeEach(() => {
  resetObserverState();
});

describe('observer state helpers', () => {
  it('starts with a zero action count and empty usage stats', () => {
    expect(getActionCount()).toBe(0);
    expect(getToolUsageStats()).toEqual({});
  });

  it('resetObserverState clears accumulated counts', () => {
    actionCounter.observe!(ctx({ toolName: 'Read' }));
    expect(getActionCount()).toBe(1);
    resetObserverState();
    expect(getActionCount()).toBe(0);
    expect(getToolUsageStats()).toEqual({});
  });
});

describe('actionCounter + actionCounterReset (2-action rule)', () => {
  it('increments the action count for view tools and tracks per-tool usage', () => {
    expect(actionCounter.matcher(ctx({ toolName: 'Read' }))).toBe(true);
    actionCounter.observe!(ctx({ toolName: 'Read' }));
    actionCounter.observe!(ctx({ toolName: 'Read' }));
    actionCounter.observe!(ctx({ toolName: 'Grep' }));

    expect(getActionCount()).toBe(3);
    expect(getToolUsageStats()).toMatchObject({ Read: 2, Grep: 1 });
  });

  it('does not match a non-view tool', () => {
    expect(actionCounter.matcher(ctx({ toolName: 'Bash' }))).toBe(false);
  });

  it('reset observer matches write tools and zeroes the count', () => {
    actionCounter.observe!(ctx({ toolName: 'Read' }));
    expect(getActionCount()).toBe(1);

    expect(actionCounterReset.matcher(ctx({ toolName: 'Write' }))).toBe(true);
    actionCounterReset.observe!(ctx({ toolName: 'Write' }));
    expect(getActionCount()).toBe(0);
  });
});

describe('errorStatisticsObserver', () => {
  it('matches failed results and thrown errors only', () => {
    expect(errorStatisticsObserver.matcher(ctx({ toolResult: { success: false } }))).toBe(true);
    expect(errorStatisticsObserver.matcher(ctx({ error: new Error('x') }))).toBe(true);
    expect(errorStatisticsObserver.matcher(ctx({ toolResult: { success: true } }))).toBe(false);
    expect(errorStatisticsObserver.matcher(ctx())).toBe(false);
  });

  it('tallies errors under a per-tool error key', () => {
    errorStatisticsObserver.observe!(ctx({ toolName: 'Bash', toolResult: { success: false } }));
    errorStatisticsObserver.observe!(ctx({ toolName: 'Bash', toolResult: { success: false } }));
    expect(getToolUsageStats()['Bash:errors']).toBe(2);
  });

  it('falls back to "unknown" when the tool name is absent', () => {
    errorStatisticsObserver.observe!(ctx({ error: new Error('x') }));
    expect(getToolUsageStats()['unknown:errors']).toBe(1);
  });
});

describe('criticalToolMonitor', () => {
  it('matches critical tools and counts usage', () => {
    expect(criticalToolMonitor.matcher(ctx({ toolName: 'Bash' }))).toBe(true);
    expect(criticalToolMonitor.matcher(ctx({ toolName: 'Read' }))).toBe(false);

    criticalToolMonitor.observe!(ctx({ toolName: 'Bash' }));
    expect(getToolUsageStats()['Bash:critical']).toBe(1);
  });
});

describe('passive observers do not throw', () => {
  it('toolUsageLogger and sessionActivityTracker run cleanly', () => {
    expect(toolUsageLogger.matcher(ctx({ toolName: 'anything' }))).toBe(true);
    expect(() => toolUsageLogger.observe!(ctx({ toolName: 'Read' }))).not.toThrow();
    expect(() => toolUsageLogger.observe!(ctx())).not.toThrow(); // unknown tool name path
    expect(() => sessionActivityTracker.observe!(ctx())).not.toThrow();
  });
});

describe('observer registry', () => {
  it('getObserversForPoint returns the hooks registered at that point', () => {
    const pre = getObserversForPoint('pre_tool_use');
    const post = getObserversForPoint('post_tool_use');
    expect(pre).toContain(toolUsageLogger);
    expect(pre).toContain(criticalToolMonitor);
    expect(post).toContain(actionCounter);
    expect(post).toContain(sessionActivityTracker);
  });

  it('every registration points at a valid hook', () => {
    expect(observerHooks.length).toBeGreaterThan(0);
    for (const { point, hook } of observerHooks) {
      expect(['pre_tool_use', 'post_tool_use']).toContain(point);
      expect(typeof hook.observe).toBe('function');
    }
  });
});
