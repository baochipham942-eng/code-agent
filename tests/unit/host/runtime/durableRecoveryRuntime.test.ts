import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunKernelAdapter } from '../../../../src/host/runtime/durableRunKernel';
import type { RunRehydrationPlan } from '../../../../src/host/runtime/durableRunStores';
import { createDurableRecoveryRuntime } from '../../../../src/host/runtime/durableRecoveryRuntime';
import type { RunRegistry } from '../../../../src/host/runtime/runRegistry';

function nativePlan(): RunRehydrationPlan {
  return {
    envelope: {
      schemaVersion: 1, runId: 'native-recovery', sessionId: 'session-recovery', engine: { kind: 'native' },
      status: 'recovering', attempt: 2, cursor: { nextEventSeq: 2, checkpointSeq: 1 },
      owner: { ownerId: 'owner', processInstanceId: 'new', epoch: 2, leaseExpiresAt: 10_000 },
      pendingOperations: [], childRuns: [], createdAt: 1, updatedAt: 2,
    },
    previousAttempt: { runId: 'native-recovery', attempt: 1, processInstanceId: 'old', ownerId: 'owner', ownerEpoch: 1, status: 'ended', startedAt: 1 },
    checkpoint: null, pendingOperations: [], childRuns: [], requiresHumanConfirmation: [],
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('DurableRecoveryRuntime startup ordering', () => {
  it('has handlers registered before the first recovery plan is consumed', async () => {
    const recoverDurable = vi.fn(async () => [nativePlan()]);
    const checkpointDurable = vi.fn(async () => undefined);
    const runtime = createDurableRecoveryRuntime({
      registry: { recoverDurable, checkpointDurable } as unknown as RunRegistry,
      kernel: {} as RunKernelAdapter,
      dataDir: '/tmp/durable-runtime-test',
      getMcpClient: () => { throw new Error('MCP is not needed for this plan'); },
      externalRunners: { codex: vi.fn(), claude: vi.fn() } as never,
    });
    const results = await runtime.recoverAndDispatch(100);
    expect(recoverDurable).toHaveBeenCalledWith(100);
    expect(results[0]).toMatchObject({ handler: 'native_production', status: 'requires_review' });
    await runtime.shutdown();
  });

  it('runs delayed recovery through the same dispatcher and cancels its timer on shutdown', async () => {
    vi.useFakeTimers();
    const recoverDurable = vi.fn(async () => []);
    const runtime = createDurableRecoveryRuntime({
      registry: { recoverDurable } as unknown as RunRegistry,
      kernel: {} as RunKernelAdapter,
      dataDir: '/tmp/durable-runtime-test',
      getMcpClient: () => { throw new Error('unused'); },
      externalRunners: { codex: vi.fn(), claude: vi.fn() } as never,
    });
    const onResults = vi.fn();
    runtime.scheduleDelayedScan(100, { onResults });
    await vi.advanceTimersByTimeAsync(100);
    expect(recoverDurable).toHaveBeenCalledTimes(1);
    expect(onResults).toHaveBeenCalledWith([]);
    runtime.scheduleDelayedScan(100);
    await runtime.shutdown();
    await vi.advanceTimersByTimeAsync(100);
    expect(recoverDurable).toHaveBeenCalledTimes(1);
  });
});
