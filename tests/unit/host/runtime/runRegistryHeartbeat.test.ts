import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunKernelAdapter } from '../../../../src/host/runtime/durableRunKernel';
import { RunRegistry } from '../../../../src/host/runtime/runRegistry';
import type { RunEnvelope, RunOwnerLease } from '../../../../src/shared/contract/durableRun';

const HEARTBEAT_INTERVAL_MS = 10_000;

function sqliteBusyError(): Error & { code: string } {
  return Object.assign(new Error('database is busy'), { code: 'SQLITE_BUSY' });
}

function createHarness(heartbeat: ReturnType<typeof vi.fn>) {
  const runId = 'run-heartbeat';
  const sessionId = 'session-heartbeat';
  const owner: RunOwnerLease = {
    ownerId: 'host',
    processInstanceId: 'process-1',
    epoch: 1,
    leaseExpiresAt: HEARTBEAT_INTERVAL_MS * 3,
  };
  const envelope: RunEnvelope = {
    schemaVersion: 1,
    runId,
    sessionId,
    engine: { kind: 'native' },
    status: 'running',
    attempt: 1,
    cursor: { nextEventSeq: 1, checkpointSeq: 0 },
    owner,
    pendingOperations: [],
    childRuns: [],
    createdAt: 0,
    updatedAt: 0,
  };
  const kernel = {
    createNativeRun: vi.fn(async () => ({
      envelope,
      owner,
      attempt: {
        runId,
        attempt: 1,
        processInstanceId: owner.processInstanceId,
        ownerId: owner.ownerId,
        ownerEpoch: owner.epoch,
        status: 'active' as const,
        startedAt: 0,
      },
    })),
    heartbeat,
    checkpoint: vi.fn(async () => ({
      cursor: { nextEventSeq: 1, checkpointSeq: 1 },
    })),
  } as unknown as RunKernelAdapter;
  const registry = new RunRegistry();
  registry.configureDurableKernel(kernel);
  return { registry, runId, sessionId, owner };
}

function cachedDurableState(registry: RunRegistry, runId: string) {
  const internals = registry as unknown as {
    durableEnvelopes: Map<string, RunEnvelope>;
    durableCheckpointStates: Map<string, unknown>;
  };
  return {
    hasEnvelope: internals.durableEnvelopes.has(runId),
    hasCheckpointState: internals.durableCheckpointStates.has(runId),
  };
}

describe('RunRegistry durable heartbeat', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps a healthy run alive across SQLITE_BUSY renewals and resets the retry budget after success', async () => {
    const heartbeat = vi.fn()
      .mockRejectedValueOnce(sqliteBusyError())
      .mockResolvedValueOnce({
        ownerId: 'host', processInstanceId: 'process-1', epoch: 1, leaseExpiresAt: 40_000,
      })
      .mockRejectedValueOnce(sqliteBusyError())
      .mockRejectedValueOnce(sqliteBusyError())
      .mockResolvedValueOnce({
        ownerId: 'host', processInstanceId: 'process-1', epoch: 1, leaseExpiresAt: 70_000,
      });
    const { registry, runId } = createHarness(heartbeat);
    const handle = await registry.startDurable({
      runId,
      sessionId: 'session-heartbeat',
      workspace: '/tmp/run-registry-heartbeat',
    }, 0);
    const cancel = vi.fn();
    await handle.attach({ cancel });

    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
    expect(cancel).not.toHaveBeenCalled();
    expect(registry.hasDurableOwner(runId)).toBe(true);

    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS * 4);
    expect(heartbeat).toHaveBeenCalledTimes(5);
    expect(cancel).not.toHaveBeenCalled();
    expect(registry.hasDurableOwner(runId)).toBe(true);
    registry.clear();
  });

  it('stands down immediately on an explicit owner fence with the lease-lost reason', async () => {
    const heartbeat = vi.fn().mockRejectedValue(
      new Error('Heartbeat fenced by stale owner: run-heartbeat'),
    );
    const { registry, runId } = createHarness(heartbeat);
    const handle = await registry.startDurable({
      runId,
      sessionId: 'session-heartbeat',
      workspace: '/tmp/run-registry-heartbeat',
    }, 0);
    const cancel = vi.fn();
    await handle.attach({ cancel });

    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);

    expect(cancel).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledWith('lease-lost');
    expect(registry.hasDurableOwner(runId)).toBe(false);
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS * 2);
    expect(heartbeat).toHaveBeenCalledOnce();
  });

  it('cleans every cached durable entry through the shared stand-down seam', async () => {
    const heartbeat = vi.fn().mockRejectedValue(
      new Error('Heartbeat fenced by stale owner: run-heartbeat'),
    );
    const { registry, runId, sessionId } = createHarness(heartbeat);
    await registry.startDurable({
      runId,
      sessionId,
      workspace: '/tmp/run-registry-heartbeat',
    }, 0);
    await registry.checkpointDurable(runId, {
      now: 1,
      status: 'running',
      state: { phase: 'before-heartbeat-loss' },
      pendingOperations: [],
      events: [],
    });
    expect(cachedDurableState(registry, runId)).toEqual({
      hasEnvelope: true,
      hasCheckpointState: true,
    });

    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);

    expect(registry.hasDurableOwner(runId)).toBe(false);
    expect(cachedDurableState(registry, runId)).toEqual({
      hasEnvelope: false,
      hasCheckpointState: false,
    });
    expect(registry.get(runId)).toBeUndefined();
    expect(registry.getBySessionId(sessionId)).toBeUndefined();
  });

  it('stands down only after all two SQLITE_BUSY retry windows are exhausted', async () => {
    const heartbeat = vi.fn().mockRejectedValue(sqliteBusyError());
    const { registry, runId } = createHarness(heartbeat);
    const handle = await registry.startDurable({
      runId,
      sessionId: 'session-heartbeat',
      workspace: '/tmp/run-registry-heartbeat',
    }, 0);
    const cancel = vi.fn();
    await handle.attach({ cancel });

    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS * 2);
    expect(cancel).not.toHaveBeenCalled();
    expect(registry.hasDurableOwner(runId)).toBe(true);

    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
    expect(heartbeat).toHaveBeenCalledTimes(3);
    expect(cancel).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledWith('lease-lost');
    expect(registry.hasDurableOwner(runId)).toBe(false);
  });
});
