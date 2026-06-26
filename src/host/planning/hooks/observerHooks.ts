// ============================================================================
// Observer Hooks - Passive hooks for logging, metrics, and audit
// ============================================================================

import type { HookContext } from '../types';
import type { ObserverHook, HookPoint } from './types';
import { matchers } from '../matchers';

// ----------------------------------------------------------------------------
// Hook State (shared across observers)
// ----------------------------------------------------------------------------

interface ObserverState {
  actionCount: number;
  toolUsage: Map<string, number>;
  sessionStartTime: number;
  lastToolTime: number;
}

let state: ObserverState = {
  actionCount: 0,
  toolUsage: new Map(),
  sessionStartTime: Date.now(),
  lastToolTime: Date.now(),
};

/**
 * Reset observer state (called on session start)
 */
export function resetObserverState(): void {
  state = {
    actionCount: 0,
    toolUsage: new Map(),
    sessionStartTime: Date.now(),
    lastToolTime: Date.now(),
  };
}

/**
 * Get current action count
 */
export function getActionCount(): number {
  return state.actionCount;
}

/**
 * Get tool usage statistics
 */
export function getToolUsageStats(): Record<string, number> {
  return Object.fromEntries(state.toolUsage);
}

// ----------------------------------------------------------------------------
// Observer Hook Definitions
// ----------------------------------------------------------------------------

/**
 * Logs all tool usage for debugging and audit trails
 */
export const toolUsageLogger: ObserverHook = {
  id: 'tool-usage-logger',
  name: 'Tool Usage Logger',
  description: 'Logs all tool usage for debugging and audit',
  matcher: matchers.any(),
  observe: (context: HookContext) => {
    const toolName = context.toolName || 'unknown';
    const now = Date.now();
    const timeSinceLastTool = now - state.lastToolTime;
    state.lastToolTime = now;

    // Log tool usage (in development, this would go to a proper logging system)
    if (process.env.NODE_ENV === 'development') {
      console.log(
        `[Hook] Tool: ${toolName}, Time since last: ${timeSinceLastTool}ms`
      );
    }
  },
};

/**
 * Counts view actions for the 2-Action Rule
 */
export const actionCounter: ObserverHook = {
  id: 'action-counter',
  name: 'Action Counter',
  description: 'Counts consecutive view actions for 2-Action Rule',
  matcher: matchers.category('view'),
  observe: (context: HookContext) => {
    state.actionCount++;
    const count = state.toolUsage.get(context.toolName || 'unknown') || 0;
    state.toolUsage.set(context.toolName || 'unknown', count + 1);
  },
};

/**
 * Resets action counter after write operations
 */
export const actionCounterReset: ObserverHook = {
  id: 'action-counter-reset',
  name: 'Action Counter Reset',
  description: 'Resets action counter after write operations',
  matcher: matchers.category('write'),
  observe: () => {
    state.actionCount = 0;
  },
};

/**
 * Tracks error occurrences for statistics
 */
export const errorStatisticsObserver: ObserverHook = {
  id: 'error-statistics',
  name: 'Error Statistics Observer',
  description: 'Tracks error occurrences for analytics',
  matcher: (context: HookContext) => {
    return context.toolResult?.success === false || context.error !== undefined;
  },
  observe: (context: HookContext) => {
    const toolName = context.toolName || 'unknown';
    const errorKey = `${toolName}:errors`;
    const count = state.toolUsage.get(errorKey) || 0;
    state.toolUsage.set(errorKey, count + 1);
  },
};

/**
 * Monitors critical tool usage patterns
 */
export const criticalToolMonitor: ObserverHook = {
  id: 'critical-tool-monitor',
  name: 'Critical Tool Monitor',
  description: 'Monitors usage of critical tools like bash and file writes',
  matcher: matchers.category('critical'),
  observe: (context: HookContext) => {
    const toolName = context.toolName || 'unknown';
    const criticalKey = `${toolName}:critical`;
    const count = state.toolUsage.get(criticalKey) || 0;
    state.toolUsage.set(criticalKey, count + 1);

    // Log critical tool usage
    if (process.env.NODE_ENV === 'development') {
      console.log(
        `[Hook] Critical tool used: ${toolName}, Total: ${count + 1}`
      );
    }
  },
};

/**
 * Tracks session activity for timeout/idle detection
 */
export const sessionActivityTracker: ObserverHook = {
  id: 'session-activity-tracker',
  name: 'Session Activity Tracker',
  description: 'Tracks session activity for timeout detection',
  matcher: matchers.any(),
  observe: () => {
    state.lastToolTime = Date.now();
  },
};

// ----------------------------------------------------------------------------
// Hook Registry
// ----------------------------------------------------------------------------

/**
 * All observer hooks with their hook points
 */
export const observerHooks: Array<{ point: HookPoint; hook: ObserverHook }> = [
  { point: 'pre_tool_use', hook: toolUsageLogger },
  { point: 'post_tool_use', hook: actionCounter },
  { point: 'post_tool_use', hook: actionCounterReset },
  { point: 'post_tool_use', hook: errorStatisticsObserver },
  { point: 'pre_tool_use', hook: criticalToolMonitor },
  { point: 'post_tool_use', hook: sessionActivityTracker },
];

/**
 * Get all observers for a specific hook point
 */
export function getObserversForPoint(point: HookPoint): ObserverHook[] {
  return observerHooks
    .filter((registration) => registration.point === point)
    .map((registration) => registration.hook);
}
