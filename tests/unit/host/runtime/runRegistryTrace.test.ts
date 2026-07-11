import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RunRegistry } from '../../../../src/host/runtime/runRegistry';
import type { RunKernelAdapter } from '../../../../src/host/runtime/durableRunKernel';
import type { RunEnvelope, RunOwnerLease } from '../../../../src/shared/contract/durableRun';
import { getTelemetryService } from '../../../../src/host/telemetry/telemetryService';

function envelope(runId: string, sessionId: string, attempt: number, owner: RunOwnerLease): RunEnvelope {
  return {
    schemaVersion: 1,
    runId,
    sessionId,
    engine: { kind: 'native' },
    status: attempt === 1 ? 'running' : 'recovering',
    attempt,
    cursor: { nextEventSeq: 1, checkpointSeq: 0 },
    owner,
    pendingOperations: [],
    childRuns: [],
    createdAt: 1,
    updatedAt: attempt,
  };
}

describe('RunRegistry attempt trace ownership', () => {
  beforeEach(() => getTelemetryService().reset());

  it('keeps logical trace across recovery, creates a new attempt span, and fences the stale handle', async () => {
    const owner1: RunOwnerLease = {
      ownerId: 'host', processInstanceId: 'process-1', epoch: 1, leaseExpiresAt: 10_000,
    };
    const owner2: RunOwnerLease = {
      ownerId: 'host', processInstanceId: 'process-2', epoch: 2, leaseExpiresAt: 20_000,
    };
    let runId = '';
    let sessionId = '';
    const terminal = vi.fn();
    const kernel = {
      createNativeRun: vi.fn(async (input) => {
        runId = input.runId;
        sessionId = input.sessionId;
        return {
          envelope: envelope(runId, sessionId, 1, owner1),
          owner: owner1,
          attempt: {
            runId, attempt: 1, processInstanceId: owner1.processInstanceId,
            ownerId: owner1.ownerId, ownerEpoch: 1, status: 'active', startedAt: 1,
          },
        };
      }),
      recoverOnStartup: vi.fn(async () => [{
        envelope: envelope(runId, sessionId, 2, owner2),
        previousAttempt: {
          runId, attempt: 1, processInstanceId: owner1.processInstanceId,
          ownerId: owner1.ownerId, ownerEpoch: 1, status: 'lost', startedAt: 1,
          endedAt: 2, recoveryReason: 'lease_expired',
        },
        checkpoint: null,
        pendingOperations: [],
        childRuns: [],
        requiresHumanConfirmation: [],
      }]),
      terminal,
      heartbeat: vi.fn(),
      checkpoint: vi.fn(),
      release: vi.fn(),
      prepareToolOperation: vi.fn(),
    } as unknown as RunKernelAdapter;

    const registry = new RunRegistry();
    registry.configureDurableKernel(kernel);
    const staleHandle = await registry.startDurable({
      runId: 'run-recovery-trace',
      sessionId: 'session-recovery-trace',
      workspace: '/tmp/recovery-trace',
    }, 1);
    const first = registry.getTraceContext(staleHandle.context.runId)!;

    await registry.recoverDurable(11_000);
    const recovered = registry.getTraceContext(staleHandle.context.runId)!;
    expect(recovered.traceId).toBe(first.traceId);
    expect(recovered.spanId).not.toBe(first.spanId);
    expect(recovered.attempt).toBe(2);

    await expect(registry.terminalDurable(staleHandle.context.runId, {
      now: 12_000,
      status: 'completed',
      event: { type: 'run_completed', recordedAt: 12_000 },
    }, staleHandle)).rejects.toThrow(/stale handle/);
    expect(terminal).not.toHaveBeenCalled();
    expect(getTelemetryService().getActiveSpans().some((span) => span.spanId === recovered.spanId)).toBe(true);
    registry.clear();
  });
});
