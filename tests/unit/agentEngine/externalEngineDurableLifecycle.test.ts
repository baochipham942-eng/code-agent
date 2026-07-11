import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import type { ExternalAgentEngineKind } from '../../../src/shared/contract/agentEngine';
import type { RunKernelAdapter } from '../../../src/host/runtime/durableRunKernel';
import type { RunRehydrationPlan } from '../../../src/host/runtime/durableRunStores';
import { RunRegistry, RunSessionConflictError } from '../../../src/host/runtime/runRegistry';
import {
  EXTERNAL_ENGINE_RESUME_CAPABILITIES,
  ExternalEngineDurableLifecycle,
  buildExternalEngineRecoveryDecision,
  canRecoverExternalEngine,
  extractExternalModelUsage,
  redactCommandSummary,
  resumeExternalEngine,
} from '../../../src/host/services/agentEngine/externalEngineDurableLifecycle';
import { getTelemetryService } from '../../../src/host/telemetry/telemetryService';

function createKernel() {
  const createRun = vi.fn(async (input: any) => {
    const owner = { ownerId: 'owner', processInstanceId: 'process', epoch: 1, leaseExpiresAt: input.now + 60_000 };
    return {
      owner,
      attempt: { runId: input.runId, attempt: 1, processInstanceId: 'process', ownerId: 'owner', ownerEpoch: 1, status: 'active', startedAt: input.now },
      envelope: {
        schemaVersion: 1, runId: input.runId, sessionId: input.sessionId, engine: input.engine,
        status: 'running', attempt: 1, cursor: { nextEventSeq: 1, checkpointSeq: 0, engineCursor: input.initialEngineCursor },
        owner, pendingOperations: input.initialPendingOperations ?? [], childRuns: [], createdAt: input.now, updatedAt: input.now,
      },
    };
  });
  const createNativeRun = vi.fn(async (input: any) => createRun({ ...input, engine: { kind: 'native' } }));
  const prepareOperation = vi.fn((input: any) => ({
    runId: input.runId, operationId: input.operationId, attempt: input.attempt, kind: input.kind,
    status: 'prepared', idempotencyKey: `stable:${input.runId}:${input.kind}:external-engine-launch`,
    sideEffect: input.sideEffect, preparedAt: input.now, updatedAt: input.now,
  }));
  const checkpoint = vi.fn(async (input: any) => ({
    runId: input.runId, checkpointSeq: 1, attempt: input.attempt, eventSeq: 1, status: input.status,
    cursor: { nextEventSeq: 2, checkpointSeq: 1, engineCursor: input.engineCursor }, state: input.state,
    checksum: 'checksum', createdAt: input.now,
  }));
  const terminal = vi.fn(async (input: any) => ({ runId: input.runId, status: input.status }));
  const recoverOnStartup = vi.fn(async () => []);
  const release = vi.fn(async () => true);
  const kernel = {
    createRun, createNativeRun, prepareOperation, checkpoint, terminal, recoverOnStartup,
    heartbeat: vi.fn(async (_runId: string, owner: any) => owner),
    release,
    prepareToolOperation: vi.fn(),
  } as unknown as RunKernelAdapter;
  return { kernel, createRun, prepareOperation, checkpoint, terminal, recoverOnStartup, release };
}

function fakeChild(pid = 4242): ChildProcess {
  return { pid, exitCode: null, kill: vi.fn(() => true) } as unknown as ChildProcess;
}

function recoveryPlan(engine: ExternalAgentEngineKind, externalSessionId?: string): RunRehydrationPlan {
  return {
    envelope: {
      schemaVersion: 1,
      runId: 'run-recovery',
      sessionId: 'session-recovery',
      engine: { kind: 'external_cli', engine, externalSessionId },
      status: 'recovering',
      attempt: 2,
      cursor: { nextEventSeq: 4, checkpointSeq: 1, engineCursor: { schemaVersion: 1, externalSessionId } },
      owner: { ownerId: 'owner', processInstanceId: 'process-2', epoch: 2, leaseExpiresAt: Date.now() + 10_000 },
      pendingOperations: [], childRuns: [], createdAt: 1, updatedAt: 2,
    },
    previousAttempt: { runId: 'run-recovery', attempt: 1, processInstanceId: 'process-1', ownerId: 'owner', ownerEpoch: 1, status: 'ended', startedAt: 1 },
    checkpoint: null,
    pendingOperations: [], childRuns: [], requiresHumanConfirmation: [],
  };
}

afterEach(() => vi.restoreAllMocks());

describe('ExternalEngineDurableLifecycle', () => {
  it.each(['codex_cli', 'claude_code', 'mimo_code', 'kimi_code'] as const)(
    'creates a durable external_cli envelope for %s with a stable launch operation',
    async (engine) => {
      const mocks = createKernel();
      const registry = new RunRegistry();
      registry.configureDurableKernel(mocks.kernel);
      const lifecycle = await ExternalEngineDurableLifecycle.start({
        registry, engine, sessionId: `session-${engine}`, workspace: '/tmp', cwd: '/tmp',
      });

      expect(mocks.createRun).toHaveBeenCalledWith(expect.objectContaining({
        runId: lifecycle.runId,
        sessionId: `session-${engine}`,
        engine: { kind: 'external_cli', engine },
        initialEngineCursor: expect.objectContaining({ schemaVersion: 1, engine }),
      }));
      expect(mocks.prepareOperation).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'external_engine', logicalOperationId: 'external-engine-launch', attempt: 1,
        sideEffect: true, canDeduplicate: false,
      }));
      await lifecycle.release();
      registry.clear();
    },
  );

  it('shares Native session conflict and keeps Native/external trace authority isolated', async () => {
    const mocks = createKernel();
    const registry = new RunRegistry();
    registry.configureDurableKernel(mocks.kernel);
    const native = await registry.startDurable({ sessionId: 'native-session', workspace: '/tmp' });
    const external = await ExternalEngineDurableLifecycle.start({ registry, engine: 'codex_cli', sessionId: 'external-session', workspace: '/tmp', cwd: '/tmp' });
    expect(native.traceContext?.traceId).not.toBe(external.handle.traceContext?.traceId);
    await expect(ExternalEngineDurableLifecycle.start({ registry, engine: 'claude_code', sessionId: 'external-session', workspace: '/tmp', cwd: '/tmp' }))
      .rejects.toBeInstanceOf(RunSessionConflictError);
    registry.clear();
  });

  it('cancels only the attached process group and disconnect-style handle cancellation is exact', async () => {
    const mocks = createKernel();
    const registry = new RunRegistry();
    registry.configureDurableKernel(mocks.kernel);
    const lifecycle = await ExternalEngineDurableLifecycle.start({ registry, engine: 'codex_cli', sessionId: 'session-cancel', workspace: '/tmp', cwd: '/tmp' });
    const child = fakeChild(4242);
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
    await lifecycle.attachProcess(child, { binary: '/bin/codex', version: '1.2.3', commandSummary: 'codex exec <prompt:redacted>', permissionProfile: 'read_only' });
    await lifecycle.handle.cancel('user');
    if (process.platform === 'win32') expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    else expect(kill).toHaveBeenCalledWith(-4242, 'SIGTERM');
    expect(kill).not.toHaveBeenCalledWith(expect.anything(), 'SIGKILL');
    await lifecycle.terminateProcess('SIGKILL');
    if (process.platform !== 'win32') expect(kill).toHaveBeenCalledWith(-4242, 'SIGKILL');
    await lifecycle.release();
  });

  it('persists external session cursor and a credential-free checkpoint', async () => {
    const mocks = createKernel();
    const registry = new RunRegistry();
    registry.configureDurableKernel(mocks.kernel);
    const lifecycle = await ExternalEngineDurableLifecycle.start({ registry, engine: 'claude_code', sessionId: 'session-checkpoint', workspace: '/tmp', cwd: '/tmp' });
    await lifecycle.attachProcess(fakeChild(), {
      binary: '/bin/claude', version: '2.1.207',
      commandSummary: 'claude --api-key sk-secret-value --token token-secret-value prompt=private',
      logPath: '/tmp/run.log', model: 'sonnet', permissionProfile: 'read_only',
    });
    lifecycle.observeStdout(12);
    lifecycle.observeStderr(7);
    lifecycle.observeNormalizedEvent('tool_call', 'Read package.json');
    lifecycle.persistExternalSessionId('claude-session-1');
    await lifecycle.finish({ runId: lifecycle.runId, sessionId: lifecycle.sessionId, engine: 'claude_code', status: 'completed', outputText: 'done', exitCode: 0 }, true);

    const serialized = JSON.stringify(mocks.checkpoint.mock.calls.map((call) => call[0]));
    expect(serialized).toContain('claude-session-1');
    expect(mocks.checkpoint).toHaveBeenCalledWith(expect.objectContaining({
      pendingOperations: [expect.objectContaining({
        idempotencyKey: `stable:${lifecycle.runId}:external_engine:external-engine-launch`,
        providerOperationId: 'external-session:claude-session-1',
        requiresHumanConfirmation: false,
      })],
    }));
    expect(serialized).toContain('resumable');
    expect(serialized).not.toContain('sk-secret-value');
    expect(serialized).not.toContain('token-secret-value');
    expect(serialized).not.toContain('private');
    expect(mocks.terminal).toHaveBeenCalledWith(expect.objectContaining({ status: 'completed' }));
  });

  it('does not call a clean process exit completed without parsed terminal evidence', async () => {
    const mocks = createKernel();
    const registry = new RunRegistry();
    registry.configureDurableKernel(mocks.kernel);
    const lifecycle = await ExternalEngineDurableLifecycle.start({ registry, engine: 'codex_cli', sessionId: 'session-honest', workspace: '/tmp', cwd: '/tmp' });
    await lifecycle.attachProcess(fakeChild(), { binary: '/bin/codex', commandSummary: 'codex exec <prompt:redacted>', permissionProfile: 'read_only' });
    await lifecycle.finish({ runId: lifecycle.runId, sessionId: lifecycle.sessionId, engine: 'codex_cli', status: 'completed', exitCode: 0 }, false);
    expect(mocks.terminal).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed', reason: 'external_process_exited_without_terminal_evidence' }));
  });

  it('fences an old process terminal after recovery claimed a new attempt', async () => {
    const mocks = createKernel();
    const registry = new RunRegistry();
    registry.configureDurableKernel(mocks.kernel);
    const lifecycle = await ExternalEngineDurableLifecycle.start({ registry, engine: 'codex_cli', sessionId: 'session-stale', workspace: '/tmp', cwd: '/tmp' });
    const plan = recoveryPlan('codex_cli', 'thread-1');
    plan.envelope.runId = lifecycle.runId;
    plan.envelope.sessionId = lifecycle.sessionId;
    plan.previousAttempt.runId = lifecycle.runId;
    mocks.recoverOnStartup.mockResolvedValueOnce([plan]);
    await registry.recoverDurable();
    await expect(registry.terminalDurable(lifecycle.runId, {
      now: Date.now(), status: 'completed', event: { type: 'late_terminal', payload: {}, recordedAt: Date.now() },
    }, lifecycle.handle)).rejects.toThrow(/stale handle/);
    await lifecycle.release();
    expect(mocks.release).not.toHaveBeenCalled();
    registry.clear();
  });

  it('keeps exporter failures diagnostic-only', async () => {
    vi.spyOn(getTelemetryService(), 'startSpan').mockImplementation(() => { throw new Error('exporter down'); });
    const mocks = createKernel();
    const registry = new RunRegistry();
    registry.configureDurableKernel(mocks.kernel);
    const lifecycle = await ExternalEngineDurableLifecycle.start({ registry, engine: 'mimo_code', sessionId: 'session-trace', workspace: '/tmp', cwd: '/tmp' });
    await expect(lifecycle.attachProcess(fakeChild(), { binary: '/bin/mimo', commandSummary: 'mimo run <prompt:redacted>', permissionProfile: 'read_only' })).resolves.toBeUndefined();
    await expect(lifecycle.finish({ runId: lifecycle.runId, sessionId: lifecycle.sessionId, engine: 'mimo_code', status: 'completed', outputText: 'done', exitCode: 0 }, true)).resolves.toBeUndefined();
  });
});

describe('external engine recovery handler', () => {
  it('never restarts a terminal run', async () => {
    const plan = recoveryPlan('codex_cli', 'thread-1');
    plan.envelope.status = 'completed';
    plan.envelope.cursor.nextEventSeq = 5;
    plan.envelope.terminal = { status: 'completed', eventSeq: 4, at: 10 };
    const resume = vi.fn();
    await expect(resumeExternalEngine(plan, { resume })).resolves.toMatchObject({ action: 'already_terminal' });
    expect(resume).not.toHaveBeenCalled();
  });

  it('resumes supported engines only with a stable external session id', async () => {
    const plan = recoveryPlan('codex_cli', 'thread-1');
    expect(canRecoverExternalEngine(plan)).toBe(true);
    expect(buildExternalEngineRecoveryDecision(plan)).toMatchObject({ action: 'resume', capability: 'resumable', externalSessionId: 'thread-1' });
    const resume = vi.fn(async () => ({ runId: plan.envelope.runId, sessionId: plan.envelope.sessionId, engine: 'codex_cli' as const, status: 'completed' as const }));
    await expect(resumeExternalEngine(plan, { resume })).resolves.toMatchObject({ status: 'completed' });
    expect(resume).toHaveBeenCalledOnce();
    await expect(resumeExternalEngine(plan, {
      resume: async () => ({ runId: 'new-run', sessionId: plan.envelope.sessionId, engine: 'codex_cli', status: 'completed' }),
    })).rejects.toThrow(/preserve logical runId/);
  });

  it.each([
    ['mimo_code', 'non_resumable'],
    ['kimi_code', 'unknown'],
  ] as const)('returns requires_review for %s (%s) without pretending to resume', async (engine, capability) => {
    const decision = buildExternalEngineRecoveryDecision(recoveryPlan(engine));
    expect(decision).toMatchObject({ action: 'requires_review', capability });
    const resume = vi.fn();
    await expect(resumeExternalEngine(recoveryPlan(engine), { resume })).resolves.toMatchObject({ action: 'requires_review' });
    expect(resume).not.toHaveBeenCalled();
  });

  it('keeps the audited capability matrix explicit', () => {
    expect(EXTERNAL_ENGINE_RESUME_CAPABILITIES).toEqual({
      codex_cli: 'resumable', claude_code: 'resumable', mimo_code: 'non_resumable', kimi_code: 'unknown',
    });
    expect(redactCommandSummary('cmd --token abcdefgh private prompt=secret')).not.toContain('abcdefgh');
    expect(extractExternalModelUsage('{"usage":{"input_tokens":12,"output_tokens":7}}')).toEqual({ inputTokens: 12, outputTokens: 7 });
  });
});
