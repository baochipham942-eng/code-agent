import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import {
  buildActiveAgentContext,
  drainCompletionNotifications,
  resolveActiveAgentScopeFilter,
} from '../../../src/host/agent/activeAgentContext';
import { getSpawnGuard, resetSpawnGuard } from '../../../src/host/agent/spawnGuard';
import type { SubagentResult } from '../../../src/host/agent/subagentExecutorTypes';
import {
  createScopedSwarmAgentId,
  type SwarmRunScope,
} from '../../../src/shared/contract/swarm';

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

function makeResult(output: string): SubagentResult {
  return {
    success: true,
    output,
    iterations: 1,
    toolsUsed: [],
    cost: 0,
  };
}

describe('activeAgentContext run scope', () => {
  beforeEach(() => resetSpawnGuard());
  afterEach(() => resetSpawnGuard());

  it('shows only agents from the requested session/run/tree', () => {
    const guard = getSpawnGuard();
    const agentA = createScopedSwarmAgentId(scopeA, 'agent_coder_0');
    const agentB = createScopedSwarmAgentId(scopeB, 'agent_coder_0');
    const pending = new Promise<SubagentResult>(() => {});
    guard.register(agentA, 'coder', 'task only A', pending, new AbortController(), { scope: scopeA });
    guard.register(agentB, 'coder', 'task only B', pending, new AbortController(), { scope: scopeB });

    const blockA = buildActiveAgentContext(scopeA);
    expect(blockA).toContain('task only A');
    expect(blockA).not.toContain('task only B');

    const sessionBlock = buildActiveAgentContext({ sessionId: scopeA.sessionId });
    expect(sessionBlock).toContain('task only A');
    expect(sessionBlock).toContain('task only B');
  });

  it('drains completion notifications without consuming another run', async () => {
    const guard = getSpawnGuard();
    const agentA = createScopedSwarmAgentId(scopeA, 'agent_coder_0');
    const agentB = createScopedSwarmAgentId(scopeB, 'agent_coder_0');
    let resolveA!: (result: SubagentResult) => void;
    let resolveB!: (result: SubagentResult) => void;
    const pendingA = new Promise<SubagentResult>((resolve) => { resolveA = resolve; });
    const pendingB = new Promise<SubagentResult>((resolve) => { resolveB = resolve; });
    guard.register(agentA, 'coder', 'Team A', pendingA, new AbortController(), { scope: scopeA });
    guard.register(agentB, 'coder', 'Team B', pendingB, new AbortController(), { scope: scopeB });

    resolveA(makeResult('A done'));
    resolveB(makeResult('B done'));
    await Promise.resolve();
    await Promise.resolve();

    const notificationsA = drainCompletionNotifications(scopeA);
    expect(notificationsA).toHaveLength(1);
    expect(notificationsA[0]).toContain(agentA);
    expect(notificationsA[0]).not.toContain(agentB);

    const notificationsB = drainCompletionNotifications(scopeB);
    expect(notificationsB).toHaveLength(1);
    expect(notificationsB[0]).toContain(agentB);
  });

  it('derives exact run scope from a scoped subagent id and otherwise falls back to session', () => {
    const agentA = createScopedSwarmAgentId(scopeA, 'agent_coder_0');
    expect(resolveActiveAgentScopeFilter(scopeA.sessionId, agentA)).toEqual(scopeA);
    expect(resolveActiveAgentScopeFilter(scopeA.sessionId, 'legacy-agent')).toEqual({
      sessionId: scopeA.sessionId,
    });
    expect(resolveActiveAgentScopeFilter('other-session', agentA)).toEqual({
      sessionId: 'other-session',
    });
  });

  it('keeps legacy single-spawn records visible through their session tree id', () => {
    const guard = getSpawnGuard();
    guard.register(
      'legacy-agent',
      'coder',
      'legacy session task',
      new Promise<SubagentResult>(() => {}),
      new AbortController(),
      { treeId: 'legacy-session' },
    );

    expect(buildActiveAgentContext({ sessionId: 'legacy-session' })).toContain('legacy session task');
    expect(buildActiveAgentContext({ sessionId: 'other-session' })).toBe('');
  });
});
