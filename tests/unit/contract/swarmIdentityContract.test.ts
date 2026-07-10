import { describe, expect, it } from 'vitest';

import {
  createSwarmTraceStorageId,
  getSwarmRunScopeKey,
  type SwarmRunScope,
} from '../../../src/shared/contract/swarm';

describe('Native Run and Agent Team identity contract', () => {
  it('keeps Team scope keys independent from the Native parent while separating concurrent Teams', () => {
    const teamA: SwarmRunScope = {
      sessionId: 'session-a',
      runId: 'team-run-a',
      treeId: 'team-tree-a',
      parentNativeRunId: 'native-run-a',
    };
    const teamB: SwarmRunScope = {
      sessionId: 'session-a',
      runId: 'team-run-b',
      treeId: 'team-tree-b',
      parentNativeRunId: 'native-run-a',
    };
    const sameTeamDifferentParent: SwarmRunScope = {
      ...teamA,
      parentNativeRunId: 'native-run-b',
    };

    expect(getSwarmRunScopeKey(teamA)).not.toBe(getSwarmRunScopeKey(teamB));
    expect(getSwarmRunScopeKey(teamA)).toBe(getSwarmRunScopeKey(sameTeamDifferentParent));
    expect(createSwarmTraceStorageId(teamA)).toBe(
      createSwarmTraceStorageId(sameTeamDifferentParent),
    );
  });
});
