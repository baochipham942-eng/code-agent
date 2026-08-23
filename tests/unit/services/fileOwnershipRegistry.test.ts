import { describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import { createScopedSwarmAgentId, type SwarmRunScope } from '../../../src/shared/contract/swarm';
import {
  bindFileOwnershipReleaseHook,
  createFileOwnershipActor,
  getFileOwnershipRegistry,
} from '../../../src/host/services/infra/fileOwnershipRegistry';
import { getSpawnGuard } from '../../../src/host/agent/spawnGuard';

describe('FileOwnershipRegistry', () => {
  let sequence = 0;

  function scope(): SwarmRunScope {
    sequence += 1;
    return { sessionId: `registry-session-${sequence}`, runId: `run-${sequence}`, treeId: `tree-${sequence}` };
  }

  function actor(runScope: SwarmRunScope, agentId: string) {
    const result = createFileOwnershipActor({
      sessionId: runScope.sessionId,
      agentId,
      swarmRunScope: runScope,
      workingDirectory: '/tmp/ownership-registry',
    });
    if (!result) throw new Error('expected actor');
    return result;
  }

  it('matches declared directories and globs without blocking the owner', () => {
    const runScope = scope();
    const registry = getFileOwnershipRegistry();
    const owner = actor(runScope, 'agent-a');
    const sibling = actor(runScope, 'agent-b');
    registry.declare(owner, ['src/owned', 'tests/**/*.test.ts']);

    expect(registry.checkAndClaim(owner, '/tmp/ownership-registry/src/owned/file.ts')).toEqual({ ok: true });
    expect(registry.checkAndClaim(sibling, '/tmp/ownership-registry/src/owned/file.ts')).toMatchObject({
      ok: false,
      conflict: { kind: 'declared', ownerAgentId: 'agent-a' },
    });
    expect(registry.checkAndClaim(sibling, '/tmp/ownership-registry/tests/a/x.test.ts')).toMatchObject({
      ok: false,
      conflict: { kind: 'declared', ownerAgentId: 'agent-a' },
    });

    registry.release(owner);
    registry.release(sibling);
  });

  it('releases a completed owner through the SpawnGuard terminal hook', async () => {
    const runScope = scope();
    const registry = getFileOwnershipRegistry();
    const guard = getSpawnGuard();
    bindFileOwnershipReleaseHook(guard);
    const ownerId = createScopedSwarmAgentId(runScope, 'agent-a');
    const siblingId = createScopedSwarmAgentId(runScope, 'agent-b');
    const owner = actor(runScope, ownerId);
    const sibling = actor(runScope, siblingId);
    const target = path.join('/tmp/ownership-registry', `handoff-${sequence}.txt`);
    registry.declare(owner, [target]);
    let finish!: (result: { success: boolean; output: string; toolsUsed: string[]; iterations: number }) => void;
    const promise = new Promise<{ success: boolean; output: string; toolsUsed: string[]; iterations: number }>((resolve) => { finish = resolve; });
    guard.register(ownerId, 'coder', 'owner task', promise, new AbortController(), {
      treeId: runScope.treeId,
      scope: runScope,
    });

    expect(registry.checkAndClaim(sibling, target).ok).toBe(false);
    finish({ success: true, output: 'done', toolsUsed: [], iterations: 1 });
    await promise;
    await vi.waitFor(() => {
      expect(registry.checkAndClaim(sibling, target)).toEqual({ ok: true });
    });
    expect(registry.snapshot(runScope).conflicts).toHaveLength(1);

    registry.release(sibling);
  });

  it('releases immediately when a live owner is cancelled and drops an empty run', () => {
    const runScope = scope();
    const registry = getFileOwnershipRegistry();
    const guard = getSpawnGuard();
    bindFileOwnershipReleaseHook(guard);
    const ownerId = createScopedSwarmAgentId(runScope, 'agent-a');
    const siblingId = createScopedSwarmAgentId(runScope, 'agent-b');
    const owner = actor(runScope, ownerId);
    const sibling = actor(runScope, siblingId);
    const target = path.join('/tmp/ownership-registry', `cancel-${sequence}.txt`);
    registry.declare(owner, [target]);
    const promise = new Promise<never>(() => {});
    guard.register(ownerId, 'coder', 'owner task', promise, new AbortController(), {
      treeId: runScope.treeId,
      scope: runScope,
    });

    expect(registry.checkAndClaim(sibling, target).ok).toBe(false);
    expect(guard.cancel(ownerId, runScope)).toBe(true);
    expect(registry.checkAndClaim(sibling, target)).toEqual({ ok: true });
    registry.release(sibling);
    expect(registry.snapshot(runScope)).toMatchObject({ actors: [], conflicts: [], uncertainCount: 0 });
  });

  it('deduplicates uncertain targets and emits one event per unique conflict', () => {
    const runScope = scope();
    const registry = getFileOwnershipRegistry();
    const owner = actor(runScope, 'agent-a');
    const sibling = actor(runScope, 'agent-b');
    const onConflict = vi.fn();
    registry.on('ownership:conflict', onConflict);
    registry.declare(owner, ['src/file.ts']);
    registry.recordUncertain(sibling, ['uncertain-redirection:$OUT', 'uncertain-redirection:$OUT']);
    const target = '/tmp/ownership-registry/src/file.ts';

    registry.checkAndClaim(sibling, target);
    registry.checkAndClaim(sibling, target);
    expect(registry.snapshot(runScope)).toMatchObject({ uncertainCount: 1 });
    expect(registry.listConflicts(runScope)).toHaveLength(1);
    expect(onConflict).toHaveBeenCalledOnce();

    registry.off('ownership:conflict', onConflict);
    registry.release(owner);
    registry.release(sibling);
  });
});
