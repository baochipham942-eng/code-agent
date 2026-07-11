import { describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';

import { DurableRunRepository } from '../../../../src/host/services/core/repositories/DurableRunRepository';
import {
  DurableRunKernel,
  DurableRunPersistenceUnavailableError,
} from '../../../../src/host/runtime/durableRunKernel';
import { createRunTraceContext } from '../../../../src/host/telemetry/runTraceContext';
import { createChildRunRef, projectChildRunTerminal } from '../../../../src/shared/contract/durableRun';

function createKernel(processInstanceId = 'process-1') {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  const repository = new DurableRunRepository(db);
  repository.migrate();
  const kernel = new DurableRunKernel({
    stores: repository,
    ownerId: 'native-host',
    processInstanceId,
    leaseDurationMs: 1_000,
  });
  return { db, kernel, repository };
}

describe('DurableRunKernel', () => {
  it.each([
    ['agent-team', { kind: 'agent_team', treeId: 'tree-1' } as const],
    ['dynamic-workflow', { kind: 'dynamic_workflow', workflowId: 'workflow-1' } as const],
    ['external-cli', { kind: 'external_cli', engine: 'codex_cli', externalSessionId: 'ext-1' } as const],
  ])('creates a shared envelope for %s without changing its engine reference', async (runId, engine) => {
    const { db, kernel, repository } = createKernel();

    const created = await kernel.createRun({
      runId: `run-${runId}`,
      sessionId: `session-${runId}`,
      engine,
      now: 1_000,
      initialEngineCursor: { version: 1, offset: 4 },
    });

    expect(created.envelope).toMatchObject({
      runId: `run-${runId}`,
      sessionId: `session-${runId}`,
      engine,
      status: 'running',
      attempt: 1,
      cursor: { nextEventSeq: 1, checkpointSeq: 0, engineCursor: { version: 1, offset: 4 } },
      owner: { ownerId: 'native-host', processInstanceId: 'process-1', epoch: 1, leaseExpiresAt: 2_000 },
    });
    expect(await repository.get(`run-${runId}`)).toEqual(created.envelope);

    const traceContext = createRunTraceContext({
      runId: created.envelope.runId,
      sessionId: created.envelope.sessionId,
      attempt: created.attempt.attempt,
      ownerEpoch: created.owner.epoch,
      engine: created.envelope.engine.kind,
      processInstanceId: created.owner.processInstanceId,
    });
    expect(traceContext).toMatchObject({
      runId: created.envelope.runId,
      attempt: 1,
      engine: engine.kind,
    });
    db.close();
  });

  it('keeps createNativeRun as a compatibility wrapper over the shared creation rules', async () => {
    const { db, kernel } = createKernel();
    const native = await kernel.createNativeRun({
      runId: 'run-native-wrapper', sessionId: 'session-native-wrapper', parentRunId: 'run-parent', now: 10,
    });

    expect(native.envelope).toEqual({
      schemaVersion: 1,
      runId: 'run-native-wrapper',
      sessionId: 'session-native-wrapper',
      engine: { kind: 'native' },
      status: 'running',
      attempt: 1,
      cursor: { nextEventSeq: 1, checkpointSeq: 0 },
      owner: {
        ownerId: 'native-host', processInstanceId: 'process-1', epoch: 1, leaseExpiresAt: 1_010,
      },
      parentRunId: 'run-parent',
      pendingOperations: [],
      childRuns: [],
      createdAt: 10,
      updatedAt: 10,
    });
    db.close();
  });

  it('uses the same initial owner lease, attempt, and event cursor rules for every engine', async () => {
    const engines = [
      { kind: 'native' } as const,
      { kind: 'agent_team' } as const,
      { kind: 'dynamic_workflow' } as const,
      { kind: 'external_cli', engine: 'claude_code' } as const,
    ];

    for (const [index, engine] of engines.entries()) {
      const { db, kernel } = createKernel(`process-${index}`);
      const created = await kernel.createRun({
        runId: `run-engine-${index}`,
        sessionId: `session-engine-${index}`,
        engine,
        now: 100,
      });
      expect(created.envelope.attempt).toBe(1);
      expect(created.attempt).toMatchObject({ attempt: 1, ownerEpoch: 1, status: 'active', startedAt: 100 });
      expect(created.owner).toMatchObject({ epoch: 1, leaseExpiresAt: 1_100 });
      expect(created.envelope.cursor).toEqual({ nextEventSeq: 1, checkpointSeq: 0 });
      db.close();
    }
  });

  it('creates the run and first attempt in one store transaction', async () => {
    const { db, kernel, repository } = createKernel();
    db.exec(`CREATE TRIGGER fail_initial_attempt BEFORE INSERT ON durable_run_attempts
      BEGIN SELECT RAISE(ABORT, 'attempt insert failed'); END`);

    await expect(kernel.createRun({
      runId: 'run-transaction', sessionId: 'session-transaction', engine: { kind: 'agent_team' }, now: 10,
    })).rejects.toThrow(/attempt insert failed/);
    expect(await repository.get('run-transaction')).toBeNull();
    db.close();
  });

  it('accepts validated initial status, pending operations, and child projections', async () => {
    const { db, kernel } = createKernel();
    const pending = kernel.prepareOperation({
      runId: 'run-initial-projection', operationId: 'approval-1', attempt: 1,
      kind: 'approval', sideEffect: false, canDeduplicate: true, now: 10,
    });
    const created = await kernel.createRun({
      runId: 'run-initial-projection', sessionId: 'session-initial-projection',
      engine: { kind: 'agent_team', treeId: 'tree-initial' }, now: 10, initialStatus: 'waiting',
      initialPendingOperations: [{ ...pending, status: 'waiting' }],
      initialChildRuns: [{
        parentRunId: 'run-initial-projection', childRunId: 'run-child', relation: 'agent',
        status: 'running', createdAt: 10,
      }],
    });

    expect(created.envelope).toMatchObject({
      status: 'waiting',
      pendingOperations: [{ operationId: 'approval-1', status: 'waiting' }],
      childRuns: [{ childRunId: 'run-child', status: 'running' }],
    });
    db.close();
  });

  it('persists child terminal projection through the fenced checkpoint without changing parent identity', async () => {
    const { db, kernel, repository } = createKernel();
    const child = createChildRunRef({
      parentRunId: 'run-parent-team', childRunId: 'run-child-team', relation: 'agent',
      now: 10, initialStatus: 'running',
    });
    const created = await kernel.createRun({
      runId: 'run-parent-team', sessionId: 'session-parent-team',
      engine: { kind: 'agent_team', treeId: 'tree-1' }, now: 10,
      initialChildRuns: [child],
    });
    const projected = projectChildRunTerminal(created.envelope, {
      childRunId: 'run-child-team', status: 'completed', terminalAt: 20,
    });

    await kernel.checkpoint({
      runId: created.envelope.runId, attempt: created.attempt.attempt, owner: created.owner,
      now: 20, status: 'running', state: { version: 1 }, pendingOperations: [],
      childRuns: projected.childRuns,
      events: [{ type: 'child_completed', payload: { childRunId: 'run-child-team' }, recordedAt: 20 }],
    });

    expect(await repository.get(created.envelope.runId)).toMatchObject({
      runId: created.envelope.runId,
      sessionId: created.envelope.sessionId,
      engine: created.envelope.engine,
      childRuns: [{ childRunId: 'run-child-team', status: 'completed', terminalAt: 20 }],
    });
    expect(await repository.listChildRuns(created.envelope.runId)).toEqual([
      expect.objectContaining({ childRunId: 'run-child-team', status: 'completed', terminalAt: 20 }),
    ]);
    db.close();
  });

  it('prepares stable, kind-scoped operation keys and preserves uncertainty controls', () => {
    const { db, kernel } = createKernel();
    const firstAttempt = kernel.prepareOperation({
      runId: 'run-operations', operationId: 'tool-attempt-1', logicalOperationId: 'logical-1',
      attempt: 1, kind: 'tool_call', sideEffect: true, canDeduplicate: false, now: 10,
    });
    const retryAttempt = kernel.prepareOperation({
      runId: 'run-operations', operationId: 'tool-attempt-2', logicalOperationId: 'logical-1',
      attempt: 2, kind: 'tool_call', sideEffect: true, canDeduplicate: false, now: 20,
    });
    const approval = kernel.prepareOperation({
      runId: 'run-operations', operationId: 'approval-1', logicalOperationId: 'logical-1',
      attempt: 1, kind: 'approval', sideEffect: false, canDeduplicate: true, now: 10,
    });

    expect(retryAttempt.idempotencyKey).toBe(firstAttempt.idempotencyKey);
    expect(approval.idempotencyKey).not.toBe(firstAttempt.idempotencyKey);
    expect(firstAttempt).toMatchObject({
      kind: 'tool_call', status: 'prepared', requiresHumanConfirmation: true,
    });
    db.close();
  });

  it.each(['tool_call', 'approval', 'child_run', 'external_engine'] as const)(
    'prepares %s operations through the shared interface',
    (kind) => {
      const { db, kernel } = createKernel();
      const operation = kernel.prepareOperation({
        runId: 'run-kinds', operationId: `operation-${kind}`, attempt: 1, kind,
        sideEffect: kind !== 'approval', canDeduplicate: true, now: 10,
        providerOperationId: kind === 'tool_call' ? 'mcp-provider-operation' : undefined,
      });
      expect(operation).toMatchObject({
        runId: 'run-kinds', operationId: `operation-${kind}`, kind, status: 'prepared',
      });
      if (kind === 'tool_call') expect(operation.providerOperationId).toBe('mcp-provider-operation');
      db.close();
    },
  );

  it('keeps prepareToolOperation compatible with its existing logical-call contract', () => {
    const { db, kernel } = createKernel();
    const legacy = kernel.prepareToolOperation({
      runId: 'run-tool-wrapper', logicalCallId: 'call-1', attempt: 2,
      sideEffect: false, canDeduplicate: false, now: 25, inputDigest: 'digest-1',
    });
    expect(legacy).toMatchObject({
      runId: 'run-tool-wrapper', operationId: 'call-1', attempt: 2, kind: 'tool_call',
      status: 'prepared', sideEffect: false, inputDigest: 'digest-1', preparedAt: 25, updatedAt: 25,
    });
    expect(legacy.requiresHumanConfirmation).toBe(false);
    db.close();
  });

  it('recovers a Native run after the owning process is killed', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'durable-run-kill-'));
    const dbPath = join(directory, 'run.db');
    const child = spawn(process.execPath, [
      join(process.cwd(), 'node_modules/tsx/dist/cli.mjs'),
      join(process.cwd(), 'tests/fixtures/durableRunKillChild.ts'),
      dbPath,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise<void>((resolve, reject) => {
      child.stdout.once('data', (chunk) => String(chunk).includes('READY') && resolve());
      child.once('error', reject);
      child.once('exit', (code, signal) => reject(new Error(`child exited before READY (${code ?? signal})`)));
    });
    child.kill('SIGKILL');
    await new Promise<void>((resolve) => child.once('exit', () => resolve()));
    await new Promise((resolve) => setTimeout(resolve, 120));

    const db = new Database(dbPath);
    db.pragma('foreign_keys = ON');
    const repository = new DurableRunRepository(db);
    const kernel = new DurableRunKernel({
      stores: repository, ownerId: 'native-host', processInstanceId: 'parent-process', leaseDurationMs: 100,
    });
    const plans = await kernel.recoverOnStartup(Date.now());
    expect(plans).toHaveLength(1);
    expect(plans[0].envelope).toMatchObject({ runId: 'run-killed', status: 'recovering', attempt: 2 });
    db.close();
    await rm(directory, { recursive: true, force: true });
  });

  it('rehydrates an expired Native run as a new recovering attempt and fences the old owner', async () => {
    const { db, kernel, repository } = createKernel();
    const created = await kernel.createNativeRun({
      runId: 'run-1',
      sessionId: 'session-1',
      now: 1_000,
    });

    const recovered = await new DurableRunKernel({
      stores: repository,
      ownerId: 'native-host',
      processInstanceId: 'process-2',
      leaseDurationMs: 1_000,
    }).recoverOnStartup(2_001);

    expect(recovered).toHaveLength(1);
    expect(recovered[0].envelope).toMatchObject({
      runId: 'run-1',
      status: 'recovering',
      attempt: 2,
      owner: { epoch: 2, processInstanceId: 'process-2' },
    });
    await expect(repository.append({
      runId: 'run-1',
      attempt: 1,
      expectedOwnerEpoch: created.owner.epoch,
      expectedNextSeq: 1,
      events: [{ type: 'stale_write', payload: {}, recordedAt: 2_002 }],
    })).rejects.toThrow(/stale owner|fenced/i);
    db.close();
  });

  it('persists approval wait, turn cursor, and attempt across restart', async () => {
    const { db, kernel, repository } = createKernel();
    const created = await kernel.createNativeRun({ runId: 'run-approval', sessionId: 'session-1', now: 10 });
    await kernel.checkpoint({
      runId: 'run-approval',
      attempt: created.envelope.attempt,
      owner: created.owner,
      now: 20,
      status: 'waiting',
      state: { pendingApproval: { id: 'approval-1', question: 'Ship?' } },
      engineCursor: { version: 1, turn: 4 },
      pendingOperations: [{
        runId: 'run-approval', operationId: 'approval-1', attempt: 1,
        kind: 'approval', status: 'waiting', idempotencyKey: 'run-approval:approval-1',
        sideEffect: false, preparedAt: 15, updatedAt: 20,
      }],
      events: [{ type: 'approval_waiting', payload: { approvalId: 'approval-1' }, recordedAt: 20 }],
    });

    const [plan] = await new DurableRunKernel({
      stores: repository, ownerId: 'native-host', processInstanceId: 'process-2', leaseDurationMs: 100,
    }).recoverOnStartup(1_011);

    expect(plan.checkpoint?.cursor.engineCursor).toEqual({ version: 1, turn: 4 });
    expect(plan.pendingOperations).toEqual(expect.arrayContaining([
      expect.objectContaining({ operationId: 'approval-1', status: 'waiting' }),
    ]));
    expect(plan.envelope.attempt).toBe(2);
    db.close();
  });

  it('routes an uncertain side effect to review but retries a deduplicated tool with the same key', async () => {
    const { db, kernel, repository } = createKernel();
    const created = await kernel.createNativeRun({ runId: 'run-tools', sessionId: 'session-1', now: 10 });
    await kernel.checkpoint({
      runId: 'run-tools', attempt: 1, owner: created.owner, now: 20, status: 'running', state: {},
      pendingOperations: [
        {
          runId: 'run-tools', operationId: 'unsafe', attempt: 1, kind: 'tool_call', status: 'dispatched',
          idempotencyKey: 'stable:unsafe', sideEffect: true, requiresHumanConfirmation: true,
          preparedAt: 15, updatedAt: 20,
        },
        {
          runId: 'run-tools', operationId: 'deduped', attempt: 1, kind: 'tool_call', status: 'dispatched',
          idempotencyKey: 'stable:deduped', sideEffect: true, requiresHumanConfirmation: false,
          providerOperationId: 'provider-op-1', preparedAt: 15, updatedAt: 20,
        },
      ],
      events: [{ type: 'tool_begin', payload: {}, recordedAt: 20 }],
    });

    const [plan] = await new DurableRunKernel({
      stores: repository, ownerId: 'native-host', processInstanceId: 'process-2', leaseDurationMs: 100,
    }).recoverOnStartup(1_011);

    expect(plan.envelope.status).toBe('waiting');
    expect(plan.requiresHumanConfirmation).toEqual([
      expect.objectContaining({ operationId: 'unsafe', status: 'unknown', idempotencyKey: 'stable:unsafe' }),
    ]);
    expect(plan.pendingOperations).toEqual(expect.arrayContaining([
      expect.objectContaining({ operationId: 'deduped', status: 'prepared', idempotencyKey: 'stable:deduped' }),
    ]));
    db.close();
  });

  it('never returns a terminal run from startup recovery', async () => {
    const { db, kernel } = createKernel();
    const created = await kernel.createNativeRun({ runId: 'run-terminal', sessionId: 'session-1', now: 10 });
    await kernel.terminal({
      runId: 'run-terminal', attempt: 1, owner: created.owner, now: 20,
      status: 'completed', reason: 'done', event: { type: 'run_completed', payload: {}, recordedAt: 20 },
    });
    expect(await kernel.recoverOnStartup(2_000)).toEqual([]);
    db.close();
  });

  it('fails closed when durable storage is unavailable', async () => {
    const kernel = new DurableRunKernel({
      stores: null,
      ownerId: 'native-host',
      processInstanceId: 'process-1',
      leaseDurationMs: 100,
    });
    await expect(kernel.createNativeRun({ runId: 'run-1', sessionId: 'session-1', now: 1 }))
      .rejects.toBeInstanceOf(DurableRunPersistenceUnavailableError);
    await expect(kernel.recoverOnStartup(1)).rejects.toBeInstanceOf(DurableRunPersistenceUnavailableError);
  });
});
