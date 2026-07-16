import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';

import { createApplicationNativeRecoveryPorts } from '../../../../src/host/app/nativeRecoveryHost';
import {
  createUnavailableNativeRecoveryPorts,
  NativeRecoveryHost,
  type NativeRecoveryDescriptor,
  type NativeRecoveryHostPorts,
} from '../../../../src/host/runtime/nativeRecoveryHost';
import { DurableRunKernel } from '../../../../src/host/runtime/durableRunKernel';
import type { RunRehydrationPlan } from '../../../../src/host/runtime/durableRunStores';
import { RunRegistry, RunSessionConflictError } from '../../../../src/host/runtime/runRegistry';
import { DurableRunRepository } from '../../../../src/host/services/core/repositories/DurableRunRepository';

function createRepository() {
  const db = new Database(':memory:');
  const repository = new DurableRunRepository(db);
  repository.migrate();
  return { db, repository };
}

function kernel(repository: DurableRunRepository, processInstanceId: string) {
  return new DurableRunKernel({
    stores: repository,
    ownerId: 'native-host',
    processInstanceId,
    leaseDurationMs: 100,
  });
}

function startForEngine(
  registry: RunRegistry,
  engine: 'native' | 'external',
  runId: string,
  sessionId: string,
) {
  const context = { runId, sessionId, workspace: '/repo', cwd: '/repo' };
  return engine === 'native'
    ? registry.startDurable(context, 2_000)
    : registry.startExternalDurable({ ...context, engine: 'codex_cli' }, 2_000);
}

function reviewPlan(): RunRehydrationPlan {
  const operation = {
    runId: 'run-review', operationId: 'model:review', attempt: 1, kind: 'model_call' as const,
    status: 'dispatched' as const, idempotencyKey: 'review-key', sideEffect: false,
    providerOperationId: 'provider-review', preparedAt: 1, updatedAt: 1,
  };
  const descriptor = {
    schemaVersion: 1 as const, kind: 'native' as const, sourceMessageId: 'message-review',
    provider: 'provider', model: 'model', workspace: { root: '/repo', cwd: '/repo', fingerprint: 'fp' },
    logicalOperationId: 'review', operationId: operation.operationId,
    phase: 'after_model_dispatch' as const, checkpointSequence: 1,
  };
  return {
    envelope: {
      schemaVersion: 1, runId: 'run-review', sessionId: 'session-review', engine: { kind: 'native' },
      status: 'recovering', attempt: 2, cursor: { nextEventSeq: 2, checkpointSeq: 1 },
      owner: { ownerId: 'owner', processInstanceId: 'process', epoch: 2, leaseExpiresAt: 100 },
      pendingOperations: [operation], childRuns: [], createdAt: 1, updatedAt: 2,
    },
    previousAttempt: {
      runId: 'run-review', attempt: 1, processInstanceId: 'old-process', ownerId: 'owner',
      ownerEpoch: 1, status: 'lost', startedAt: 1,
    },
    checkpoint: {
      runId: 'run-review', checkpointSeq: 1, attempt: 1, eventSeq: 1, status: 'running',
      cursor: { nextEventSeq: 2, checkpointSeq: 1 }, state: descriptor, checksum: 'checksum', createdAt: 1,
    },
    pendingOperations: [operation], childRuns: [], requiresHumanConfirmation: [],
  };
}

function planWith(input: {
  checkpointState?: unknown;
  kind?: RunRehydrationPlan['pendingOperations'][number]['kind'];
  status?: RunRehydrationPlan['pendingOperations'][number]['status'];
  providerOperationId?: string;
  sideEffect?: boolean;
  approvalId?: string;
}): RunRehydrationPlan {
  const base = reviewPlan();
  const descriptor = base.checkpoint?.state as NativeRecoveryDescriptor;
  const operation = {
    ...base.pendingOperations[0],
    kind: input.kind ?? base.pendingOperations[0].kind,
    status: input.status ?? base.pendingOperations[0].status,
    providerOperationId: input.providerOperationId,
    sideEffect: input.sideEffect ?? base.pendingOperations[0].sideEffect,
  };
  return {
    ...base,
    envelope: { ...base.envelope, pendingOperations: [operation] },
    checkpoint: base.checkpoint && {
      ...base.checkpoint,
      state: input.checkpointState ?? {
        ...descriptor,
        ...(input.approvalId ? { approvalId: input.approvalId } : {}),
      },
    },
    pendingOperations: [operation],
  };
}

function unavailablePorts(input: {
  workspace?: { ok: true; root: string; cwd: string; fingerprint: string };
  approval?: 'pending' | 'approved' | 'rejected' | 'missing' | 'conflict';
} = {}): NativeRecoveryHostPorts {
  const unavailable = createUnavailableNativeRecoveryPorts();
  return {
    ...unavailable,
    resolveWorkspace: vi.fn(async () => input.workspace
      ?? { ok: true as const, root: '/repo', cwd: '/repo', fingerprint: 'fp' }),
    model: {
      ...unavailable.model,
      queryResult: vi.fn(async () => null),
      canRetrySafely: vi.fn(async () => false),
    },
    approval: { read: vi.fn(async () => input.approval ?? 'pending') },
  };
}

describe('durable Native recovery lifecycle', () => {
  it('fails an unrecoverable production run and lets the same session start again', async () => {
    const workspace = realpathSync(mkdtempSync(path.join(tmpdir(), 'durable-native-recovery-')));
    const { db, repository } = createRepository();
    const firstRegistry = new RunRegistry();
    const firstKernel = kernel(repository, 'process-before-crash');
    firstRegistry.configureDurableKernel(firstKernel);

    try {
      const original = await firstRegistry.startDurable({
        runId: 'run-before-crash',
        sessionId: 'session-reused-after-recovery',
        workspace,
        cwd: workspace,
      }, 1_000);
      const pending = {
        ...firstKernel.prepareOperation({
          runId: original.context.runId,
          operationId: 'model:model-call-before-crash',
          logicalOperationId: 'model-call-before-crash',
          attempt: 1,
          kind: 'model_call',
          sideEffect: false,
          canDeduplicate: true,
          providerOperationId: 'provider-operation-before-crash',
          now: 1_010,
        }),
        status: 'dispatched' as const,
      };
      await firstRegistry.checkpointDurable(original.context.runId, {
        now: 1_010,
        status: 'running',
        state: {
          schemaVersion: 1,
          kind: 'native',
          sourceMessageId: 'message-before-crash',
          provider: 'provider-without-recovery-executor',
          model: 'model-before-crash',
          workspace: {
            root: workspace,
            cwd: workspace,
            fingerprint: createHash('sha256').update(workspace).digest('hex'),
          },
          logicalOperationId: 'model-call-before-crash',
          operationId: pending.operationId,
          phase: 'after_model_dispatch',
          checkpointSequence: 1,
        },
        engineCursor: { schemaVersion: 1, runtime: 'native' },
        pendingOperations: [pending],
        childRuns: [],
        events: [{ type: 'native_model_operation', payload: {}, recordedAt: 1_010 }],
      });
      firstRegistry.clear();

      const recoveredRegistry = new RunRegistry();
      recoveredRegistry.configureDurableKernel(kernel(repository, 'process-after-crash'));
      const [plan] = await recoveredRegistry.recoverDurable(2_000);
      const recovery = await new NativeRecoveryHost(
        recoveredRegistry,
        createApplicationNativeRecoveryPorts(),
      ).createHandler().recover(plan, 2_000);
      const persisted = await repository.get(original.context.runId);

      let nextRun: Awaited<ReturnType<RunRegistry['startDurable']>> | undefined;
      let nextRunError: unknown;
      try {
        nextRun = await recoveredRegistry.startDurable({
          runId: 'run-after-recovery',
          sessionId: original.context.sessionId,
          workspace,
          cwd: workspace,
        }, 2_010);
      } catch (error) {
        nextRunError = error;
      }

      expect.soft(recovery.status).toBe('failed');
      expect.soft(persisted?.status).toBe('failed');
      expect.soft(recoveredRegistry.hasDurableOwner(original.context.runId)).toBe(false);
      expect(nextRunError).toBeUndefined();
      expect(nextRun?.context.runId).toBe('run-after-recovery');
      recoveredRegistry.clear();
    } finally {
      firstRegistry.clear();
      db.close();
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('keeps a genuinely review-capable host waiting for review', async () => {
    const registry = {
      checkpointDurable: vi.fn(),
      terminalDurable: vi.fn(),
    } as unknown as RunRegistry;
    const ports: NativeRecoveryHostPorts = {
      continuationExecutor: 'available',
      resolveWorkspace: vi.fn(async () => ({ ok: true, root: '/repo', cwd: '/repo', fingerprint: 'fp' })),
      model: {
        dispatchPrepared: vi.fn(async () => ({ resultRef: 'unused' })),
        queryResult: vi.fn(async () => null),
        canRetrySafely: vi.fn(async () => false),
        retrySafe: vi.fn(async () => ({ resultRef: 'unused' })),
      },
      tool: { queryResult: vi.fn(async () => null) },
      approval: { read: vi.fn(async () => 'pending') },
    };

    await expect(new NativeRecoveryHost(registry, ports).createHandler().recover(reviewPlan(), 10))
      .resolves.toMatchObject({ status: 'requires_review', reason: 'model_result_handle_not_queryable' });
    expect(registry.checkpointDurable).toHaveBeenCalledWith('run-review', expect.objectContaining({ status: 'waiting' }));
    expect(registry.terminalDurable).not.toHaveBeenCalled();
  });

  it.each([
    {
      branch: 'prepared model dispatch',
      plan: () => planWith({ status: 'prepared' }),
      ports: () => unavailablePorts(),
      reason: 'native_model_continuation_executor_unavailable',
    },
    {
      branch: 'unqueryable dispatched model result',
      plan: () => reviewPlan(),
      ports: () => unavailablePorts(),
      reason: 'model_result_handle_not_queryable',
    },
    {
      branch: 'model retry without safe-retry proof',
      plan: () => planWith({ status: 'dispatched', providerOperationId: undefined }),
      ports: () => unavailablePorts(),
      reason: 'model_safe_retry_unproven',
    },
    {
      branch: 'approved operation without post-approval continuation',
      plan: () => planWith({
        kind: 'approval',
        status: 'waiting',
        providerOperationId: 'approval:approval-review',
        approvalId: 'approval-review',
      }),
      ports: () => unavailablePorts({ approval: 'approved' }),
      reason: 'approval_approved_continuation_requires_application_resume',
    },
  ])('fails closed for $branch when fallback Native ports have no continuation executor', async ({ plan, ports, reason }) => {
    const registry = {
      checkpointDurable: vi.fn(),
      terminalDurable: vi.fn(),
    } as unknown as RunRegistry;

    await expect(new NativeRecoveryHost(registry, ports()).createHandler().recover(plan(), 10)).resolves.toMatchObject({
      status: 'failed',
      reason,
    });
    expect(registry.terminalDurable).toHaveBeenCalledWith('run-review', expect.objectContaining({ status: 'failed' }));
    expect(registry.checkpointDurable).not.toHaveBeenCalled();
  });

  it.each([
    {
      branch: 'missing recovery descriptor',
      plan: () => ({ ...reviewPlan(), checkpoint: null }),
      ports: () => unavailablePorts(),
      reason: 'native_recovery_descriptor_missing',
    },
    {
      branch: 'workspace drift',
      plan: () => reviewPlan(),
      ports: () => unavailablePorts({
        workspace: { ok: true, root: '/different', cwd: '/repo', fingerprint: 'fp' },
      }),
      reason: 'native_workspace_drift',
    },
    {
      branch: 'unknown write side effect',
      plan: () => planWith({
        kind: 'tool_call',
        status: 'dispatched',
        providerOperationId: undefined,
        sideEffect: true,
      }),
      ports: () => unavailablePorts(),
      reason: 'unknown_write_side_effect',
    },
  ])('keeps $branch waiting for genuine human review', async ({ plan, ports, reason }) => {
    const registry = {
      checkpointDurable: vi.fn(),
      terminalDurable: vi.fn(),
    } as unknown as RunRegistry;

    await expect(new NativeRecoveryHost(registry, ports()).createHandler().recover(plan(), 10)).resolves.toMatchObject({
      status: 'requires_review',
      reason,
    });
    expect(registry.checkpointDurable).toHaveBeenCalledWith('run-review', expect.objectContaining({ status: 'waiting' }));
    expect(registry.terminalDurable).not.toHaveBeenCalled();
  });

  it.each(['native', 'external'] as const)(
    'maps only the durable active-session unique violation for %s starts',
    async (engine) => {
      const { db, repository } = createRepository();
      await kernel(repository, 'blocking-process').createNativeRun({
        runId: `blocking-${engine}`,
        sessionId: `shared-session-${engine}`,
        now: 1_000,
      });
      const registry = new RunRegistry();
      registry.configureDurableKernel(kernel(repository, `new-${engine}-process`));

      try {
        const error = await startForEngine(
          registry,
          engine,
          `new-${engine}-run`,
          `shared-session-${engine}`,
        ).then(() => undefined, (caught: unknown) => caught);
        expect(error).toBeInstanceOf(RunSessionConflictError);
        expect(error).toMatchObject({
          code: 'RUN_SESSION_CONFLICT',
          sessionId: `shared-session-${engine}`,
          cause: {
            code: 'SQLITE_CONSTRAINT_UNIQUE',
            message: 'UNIQUE constraint failed: durable_runs.session_id',
          },
        });
      } finally {
        registry.clear();
        db.close();
      }
    },
  );

  it.each(['native', 'external'] as const)(
    'leaves unrelated SQLite unique violations untouched for %s starts',
    async (engine) => {
      const { db, repository } = createRepository();
      await kernel(repository, 'blocking-process').createNativeRun({
        runId: `duplicate-run-id-${engine}`,
        sessionId: `original-session-${engine}`,
        now: 1_000,
      });
      const registry = new RunRegistry();
      registry.configureDurableKernel(kernel(repository, `new-${engine}-process`));

      try {
        const error = await startForEngine(
          registry,
          engine,
          `duplicate-run-id-${engine}`,
          `different-session-${engine}`,
        ).then(() => undefined, (caught: unknown) => caught);
        expect(error).not.toBeInstanceOf(RunSessionConflictError);
        expect(error).toMatchObject({
          name: 'SqliteError',
          code: 'SQLITE_CONSTRAINT_PRIMARYKEY',
          message: 'UNIQUE constraint failed: durable_runs.run_id',
        });
      } finally {
        registry.clear();
        db.close();
      }
    },
  );
});
