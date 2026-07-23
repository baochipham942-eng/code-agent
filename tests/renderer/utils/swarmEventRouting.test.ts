import { describe, expect, it } from 'vitest';
import type { SwarmEvent } from '../../../src/shared/contract/swarm';
import {
  isSwarmSurfaceArtifact,
  shouldActivateSwarmScopeFromRoot,
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
  it('only root events represent a swarm surface artifact', () => {
    expect(isSwarmSurfaceArtifact(rootEvent('session-a', 'run-a'))).toBe(true);
    expect(isSwarmSurfaceArtifact(rootEvent('session-b', 'run-b'))).toBe(true);
  });

  it('does not classify non-root events as surface artifacts', () => {
    expect(isSwarmSurfaceArtifact({
      ...rootEvent('session-a', 'run-a'),
      type: 'swarm:agent:added',
    })).toBe(false);
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
