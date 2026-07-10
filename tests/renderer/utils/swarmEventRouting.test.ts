import { describe, expect, it } from 'vitest';
import type { SwarmEvent } from '../../../src/shared/contract/swarm';
import {
  shouldActivateSwarmScopeFromRoot,
  shouldOpenSwarmWorkbench,
} from '../../../src/renderer/utils/swarmEventRouting';

function rootEvent(sessionId: string, runId: string): SwarmEvent {
  return {
    type: 'swarm:started',
    sessionId,
    runId,
    treeId: `tree-${runId}`,
    timestamp: 1,
    data: {},
  };
}

describe('swarm event UI routing', () => {
  it('opens the workbench only for a root event from the selected session', () => {
    expect(shouldOpenSwarmWorkbench(rootEvent('session-a', 'run-a'), 'session-a')).toBe(true);
    expect(shouldOpenSwarmWorkbench(rootEvent('session-b', 'run-b'), 'session-a')).toBe(false);
    expect(shouldOpenSwarmWorkbench(rootEvent('session-a', 'run-a'), null)).toBe(false);
  });

  it('does not auto-open for non-root events in the selected run', () => {
    expect(shouldOpenSwarmWorkbench({
      ...rootEvent('session-a', 'run-a'),
      type: 'swarm:agent:added',
    }, 'session-a')).toBe(false);
  });

  it('does not activate a delayed root over a newer run in the same session', () => {
    const projection = {
      activeSessionId: 'session-a',
      activeRunId: 'run-current',
      startTime: 200,
      lastEventAt: 250,
    };

    expect(shouldActivateSwarmScopeFromRoot(
      { ...rootEvent('session-a', 'run-late'), timestamp: 100 },
      'session-a',
      projection,
    )).toBe(false);
    expect(shouldActivateSwarmScopeFromRoot(
      { ...rootEvent('session-a', 'run-new'), timestamp: 300 },
      'session-a',
      projection,
    )).toBe(true);
  });

  it('activates the selected session when its projection is not bound to a run', () => {
    expect(shouldActivateSwarmScopeFromRoot(
      rootEvent('session-a', 'run-a'),
      'session-a',
      { activeSessionId: 'session-a' },
    )).toBe(true);
  });
});
