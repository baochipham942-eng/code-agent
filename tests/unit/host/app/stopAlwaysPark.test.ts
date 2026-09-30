import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';

import { continueParkedDurableRun } from '../../../../src/host/app/durableRunContinuation';
import { finalizeOrParkDurableRun } from '../../../../src/host/agent/orchestrator/durableRunTerminal';
import {
  mapDurableRunView,
  projectDurableRunToSessionPayload,
} from '../../../../src/host/app/durableRunReadService';
import { DurableRunKernel } from '../../../../src/host/runtime/durableRunKernel';
import { RunRegistry } from '../../../../src/host/runtime/runRegistry';
import { DurableRunRepository } from '../../../../src/host/services/core/repositories/DurableRunRepository';
import {
  cancelDisconnectedAgentRouteRun,
  createAgentDurableRouteRunLifecycle,
} from '../../../../src/web/routes/agentDurableRouteLifecycle';

const logger = { info() {}, warn() {}, error() {} };

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
    leaseDurationMs: 60_000,
  });
}

describe('user stop parks a fresh resumable run', () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()?.();
  });

  function openRegistry(label: string) {
    const workspace = realpathSync(mkdtempSync(path.join(tmpdir(), `stop-always-park-${label}-`)));
    const { db, repository } = createRepository();
    const registry = new RunRegistry();
    registry.configureDurableKernel(kernel(repository, label));
    cleanups.push(() => {
      registry.clear();
      rmSync(workspace, { recursive: true, force: true });
      db.close();
    });
    return { workspace, repository, registry };
  }

  function lifecycle(registry: RunRegistry, sessionId: string, workspace: string) {
    return createAgentDurableRouteRunLifecycle({
      runRegistry: registry,
      sessionId,
      workspace,
      durableActivation: true,
      logger,
    });
  }

  async function checkpointModel(registry: RunRegistry, runId: string, sourceMessageId: string) {
    await registry.checkpointNativeModelOperation({
      runId,
      sourceMessageId,
      provider: 'provider',
      model: 'model',
      logicalOperationId: `turn-${sourceMessageId}`,
      phase: 'after_model_dispatch',
      status: 'dispatched',
    });
  }

  async function project(registry: RunRegistry, repository: DurableRunRepository, sessionId: string, runId: string) {
    const envelope = await repository.get(runId);
    const view = {
      ...mapDurableRunView('session_replay', envelope!),
      continuable: Boolean(registry.findRecoveredWaitingRun({ sessionId })),
    };
    return projectDurableRunToSessionPayload(view);
  }

  it('stops a fresh run into waiting/user_stop that Continue resumes on the same runId', async () => {
    const sessionId = 'session-fresh-stop';
    const sourceMessageId = 'message-fresh-stop';
    const { workspace, repository, registry } = openRegistry('fresh');
    const run = lifecycle(registry, sessionId, workspace);
    const { runHandle } = await run.start();
    const runId = runHandle.context.runId;
    await checkpointModel(registry, runId, sourceMessageId);

    await run.markSuccess({ finalStatus: 'interrupted' });
    await run.release();

    const parked = await repository.get(runId);
    expect(parked).toMatchObject({ status: 'waiting', interruptCause: 'user_stop' });
    expect(parked?.terminal).toBeUndefined();
    expect(registry.hasDurableOwner(runId)).toBe(true);
    expect(registry.get(runId)).toBeUndefined();
    expect(registry.findRecoveredWaitingRun({ sessionId })).toEqual({ runId, sessionId });

    const payload = await project(registry, repository, sessionId, runId);
    expect(payload.durableResume).toMatchObject({
      runId, mode: 'continue', interruptCause: 'user_stop', canContinue: true,
    });
    expect(payload.status).toBe('interrupted');
    expect(payload.status).not.toBe('running');

    const resumed: string[] = [];
    const result = await continueParkedDurableRun({
      sessionId,
      runRegistry: registry,
      taskManager: {
        getSessionState: () => undefined,
        resumeExistingDurableRun: async (_sessionId: string, resumedRunId: string) => {
          resumed.push(resumedRunId);
          registry.adoptRecoveredRun({ runId: resumedRunId, sessionId, workspace, cwd: workspace });
        },
      } as never,
      getMessages: async () => [{ id: sourceMessageId, role: 'user', content: 'go', timestamp: 1 } as never],
    });
    const continued = await repository.get(runId);
    expect({
      runId: result.runId,
      resumed,
      status: continued?.status,
      attempt: continued?.attempt,
      parkedAttempt: parked?.attempt,
    }).toEqual({
      runId,
      resumed: [runId],
      status: 'running',
      attempt: parked?.attempt,
      parkedAttempt: parked?.attempt,
    });
  });

  it('cancels a fresh run stopped before any native model checkpoint', async () => {
    const sessionId = 'session-no-checkpoint';
    const { repository, registry, workspace } = openRegistry('no-checkpoint');
    const run = lifecycle(registry, sessionId, workspace);
    const { runHandle } = await run.start();
    const runId = runHandle.context.runId;

    await run.markSuccess({ finalStatus: 'interrupted' });
    await run.release();

    expect(await repository.get(runId)).toMatchObject({ status: 'cancelled' });
    expect(registry.findRecoveredWaitingRun({ sessionId })).toBeUndefined();
    expect(registry.hasDurableOwner(runId)).toBe(false);
  });

  it('abandon via terminalRecoveredWaitingRun cancels the park and lets a new run start', async () => {
    const sessionId = 'session-abandon';
    const { workspace, repository, registry } = openRegistry('abandon');
    const run = lifecycle(registry, sessionId, workspace);
    const { runHandle } = await run.start();
    const runId = runHandle.context.runId;
    await checkpointModel(registry, runId, 'message-abandon');
    await run.markSuccess({ finalStatus: 'interrupted' });
    await run.release();

    await expect(registry.terminalRecoveredWaitingRun({ sessionId }))
      .resolves.toEqual({ runId, sessionId });
    expect(await repository.get(runId)).toMatchObject({ status: 'cancelled' });
    expect(registry.findRecoveredWaitingRun({ sessionId })).toBeUndefined();

    const next = await registry.startDurable({
      runId: 'run-after-abandon',
      sessionId,
      workspace,
      cwd: workspace,
    });
    expect(next.context.runId).toBe('run-after-abandon');
  });

  it('a new user message supersedes the parked run and starts another run on the session', async () => {
    const sessionId = 'session-supersede';
    const { workspace, repository, registry } = openRegistry('supersede');
    const parked = lifecycle(registry, sessionId, workspace);
    const { runHandle } = await parked.start();
    const runId = runHandle.context.runId;
    await checkpointModel(registry, runId, 'message-supersede');
    await parked.markSuccess({ finalStatus: 'interrupted' });
    await parked.release();
    expect(registry.findRecoveredWaitingRun({ sessionId })).toEqual({ runId, sessionId });

    const next = lifecycle(registry, sessionId, workspace);
    const started = await next.start();
    expect(started.runHandle.context.runId).not.toBe(runId);
    expect(await repository.get(runId)).toMatchObject({ status: 'cancelled' });
    expect(registry.findRecoveredWaitingRun({ sessionId })).toBeUndefined();
    await next.markSuccess({ finalStatus: 'completed' });
    await next.release();
  });

  it('keeps a disconnected run terminal even after a native checkpoint', async () => {
    const sessionId = 'session-disconnect';
    const { workspace, repository, registry } = openRegistry('disconnect');
    const run = lifecycle(registry, sessionId, workspace);
    const { runHandle } = await run.start();
    const runId = runHandle.context.runId;
    await checkpointModel(registry, runId, 'message-disconnect');

    await run.markFailure({ disconnected: true, message: 'client disconnected' });
    await run.release();

    expect(await repository.get(runId)).toMatchObject({ status: 'cancelled' });
    expect(registry.findRecoveredWaitingRun({ sessionId })).toBeUndefined();
  });

  it('cancelDisconnectedAgentRouteRun stays terminal after a native checkpoint', async () => {
    const sessionId = 'session-cancel-disconnect';
    const { workspace, repository, registry } = openRegistry('cancel-disconnect');
    const run = lifecycle(registry, sessionId, workspace);
    const { runHandle } = await run.start();
    const runId = runHandle.context.runId;
    await checkpointModel(registry, runId, 'message-cancel-disconnect');

    await cancelDisconnectedAgentRouteRun({
      runRegistry: registry,
      runHandle,
      sessionId,
      durableActivation: true,
    });

    expect(await repository.get(runId)).toMatchObject({ status: 'cancelled' });
    expect(registry.findRecoveredWaitingRun({ sessionId })).toBeUndefined();
    expect(registry.hasDurableOwner(runId)).toBe(false);
  });

  it('cancels an auxiliary child that already has a native descriptor instead of parking it', async () => {
    const sessionId = 'session-auxiliary-stop';
    const { workspace, repository, registry } = openRegistry('auxiliary');
    const parent = await registry.startDurable({
      runId: 'parent-run',
      sessionId,
      workspace,
      cwd: workspace,
    });
    const child = await registry.startAuxiliaryDurableChild({
      runId: 'child-run',
      sessionId,
      workspace,
      cwd: workspace,
    }, parent.context.runId);
    await checkpointModel(registry, child.context.runId, 'message-child');

    await finalizeOrParkDurableRun({
      registry,
      runId: child.context.runId,
      handle: child,
      sessionId,
      completed: false,
      cancelled: true,
      registration: 'auxiliary',
      parentRunId: parent.context.runId,
    });

    expect(await repository.get(child.context.runId)).toMatchObject({ status: 'cancelled' });
    expect(registry.hasDurableOwner(child.context.runId)).toBe(false);
    expect(registry.get(child.context.runId)).toBeUndefined();
    const timers = (registry as unknown as { heartbeatTimers: Map<string, unknown> }).heartbeatTimers;
    expect(timers.has(child.context.runId)).toBe(false);
    expect(await repository.listChildRuns(parent.context.runId)).toEqual([
      expect.objectContaining({ childRunId: child.context.runId, status: 'cancelled' }),
    ]);
    expect(registry.hasDurableOwner(parent.context.runId)).toBe(true);
    expect(timers.has(parent.context.runId)).toBe(true);
    expect(await repository.get(parent.context.runId)).toMatchObject({ status: 'running' });
  });
});
