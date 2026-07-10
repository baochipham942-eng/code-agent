import { describe, expect, it } from 'vitest';

import { resolveAgentTargetScope } from '../../../../../src/host/tools/modules/multiagent/agentRunScope';
import type { ToolContext } from '../../../../../src/host/protocol/tools';
import {
  createScopedSwarmAgentId,
  type SwarmRunScope,
} from '../../../../../src/shared/contract/swarm';

const scopeA: SwarmRunScope = {
  sessionId: 'shared-session',
  runId: 'run-a',
  treeId: 'tree-a',
};
const scopeB: SwarmRunScope = {
  sessionId: 'shared-session',
  runId: 'run-b',
  treeId: 'tree-b',
};

function context(scope?: SwarmRunScope): ToolContext {
  return {
    sessionId: 'shared-session',
    swarmRunScope: scope,
  } as ToolContext;
}

describe('multiagent target run scope', () => {
  it('allows the same local role only inside the caller Team run', () => {
    const agentA = createScopedSwarmAgentId(scopeA, 'agent_reviewer_0');
    const agentB = createScopedSwarmAgentId(scopeB, 'agent_reviewer_0');

    expect(resolveAgentTargetScope(context(scopeA), agentA)).toEqual({ scope: scopeA });
    expect(resolveAgentTargetScope(context(scopeA), agentB)).toEqual({
      error: 'Agent belongs to a different Team run.',
    });
  });

  it('rejects a foreign tree even when sessionId and runId match', () => {
    const foreignTreeAgent = createScopedSwarmAgentId(
      { ...scopeA, treeId: 'tree-foreign' },
      'agent_reviewer_0',
    );

    expect(resolveAgentTargetScope(context(scopeA), foreignTreeAgent)).toEqual({
      error: 'Agent belongs to a different Team run.',
    });
  });

  it('lets a session-level orchestrator address an exact composite identity', () => {
    const agentA = createScopedSwarmAgentId(scopeA, 'agent_reviewer_0');
    expect(resolveAgentTargetScope(context(), agentA)).toEqual({ scope: scopeA });
  });
});
