import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../src/host/agent/scriptRuntime/sandbox', () => ({
  runScriptInSandbox: vi.fn(async () => ({ ok: true, result: 'recovered' })),
}));

import { runScriptInSandbox } from '../../../../src/host/agent/scriptRuntime/sandbox';
import { fingerprintRunWorkspace } from '../../../../src/host/telemetry/runTraceContext';
import {
  createDynamicWorkflowDurableState,
  createDynamicWorkflowGraphRecoveryHandler,
  type DynamicWorkflowDurableState,
  type DynamicWorkflowRecoveryHost,
} from '../../../../src/host/runtime/dynamicWorkflowRecovery';
import type { RunRehydrationPlan } from '../../../../src/host/runtime/durableRunStores';
import type { RunRegistry } from '../../../../src/host/runtime/runRegistry';
import { validateDynamicWorkflowRecoveryWorkspace } from '../../../../src/host/app/dynamicWorkflowRecoveryHost';
import { resolveCanonicalRunPath } from '../../../../src/host/runtime/runContext';

const graphSpec = {
  graphId: 'dynamic-graph', runId: 'run-dynamic', sessionId: 'session-dynamic', attempt: 1,
  schedulerPolicy: { maxConcurrency: 1 },
  nodes: [{
    nodeId: 'workflow-node', kind: 'dynamic_workflow', executorRef: 'dynamic_workflow', dependencies: [],
    sideEffect: 'read_only',
    input: {
      script: 'return 1', defaultProvider: 'test', defaultModel: 'model',
      workflowRunId: 'logical-workflow', journalRunId: 'logical-workflow',
    },
  }],
} as const;

function state(status: 'running' | 'completed' = 'running'): DynamicWorkflowDurableState {
  const result = status === 'completed'
    ? { status: 'completed' as const, output: { status: 'completed' }, sideEffectState: 'confirmed' as const }
    : undefined;
  return createDynamicWorkflowDurableState({
    runId: graphSpec.runId,
    sessionId: graphSpec.sessionId,
    workspace: { root: '/tmp', cwd: '/tmp', fingerprint: fingerprintRunWorkspace('/tmp') },
    model: { provider: 'test', model: 'model' },
    toolProfile: 'readonly',
    graphSpec: structuredClone(graphSpec),
    graphCheckpoint: {
      version: 1, graphId: graphSpec.graphId, runId: graphSpec.runId, sessionId: graphSpec.sessionId,
      attempt: 1, status, eventSequence: 4,
      scheduler: { version: 1, nodes: [{ nodeId: 'workflow-node', status, attempts: 1 }], cancelled: false },
      nodes: [{ nodeId: 'workflow-node', status, attempts: 1, ...(result ? { result } : {}) }],
      createdAt: 1, updatedAt: 2,
      ...(status === 'completed' ? { terminalEventType: 'graph_completed' as const } : {}),
    },
  });
}

function plan(durableState: DynamicWorkflowDurableState): RunRehydrationPlan {
  return {
    envelope: {
      schemaVersion: 1, runId: 'run-dynamic', sessionId: 'session-dynamic',
      engine: { kind: 'dynamic_workflow', workflowId: 'dynamic-graph' }, status: 'recovering', attempt: 2,
      cursor: { nextEventSeq: 5, checkpointSeq: 1 },
      owner: { ownerId: 'owner', processInstanceId: 'new-process', epoch: 2, leaseExpiresAt: 10_000 },
      pendingOperations: [], childRuns: [], createdAt: 1, updatedAt: 2,
    },
    previousAttempt: {
      runId: 'run-dynamic', attempt: 1, processInstanceId: 'old-process', ownerId: 'owner',
      ownerEpoch: 1, status: 'ended', startedAt: 1,
    },
    checkpoint: {
      runId: 'run-dynamic', attempt: 1, checkpointSeq: 1, status: 'running', state: durableState,
      cursor: { nextEventSeq: 5, checkpointSeq: 1 }, pendingOperations: [], childRuns: [], recordedAt: 2,
    },
    pendingOperations: [], childRuns: [], requiresHumanConfirmation: [],
  };
}

function registry(overrides: Partial<RunRegistry> = {}) {
  const handle = {
    context: { runId: 'run-dynamic', sessionId: 'session-dynamic', workspace: '/tmp', cwd: '/tmp', createdAt: 1 },
    traceContext: {
      traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), runId: 'run-dynamic', sessionId: 'session-dynamic',
      attempt: 2, ownerEpoch: 2, engine: 'dynamic_workflow', workspaceFingerprint: fingerprintRunWorkspace('/tmp'),
    },
    attach: vi.fn(),
  };
  return {
    value: {
      bindRecoveredHandle: vi.fn(() => handle),
      getTraceContext: vi.fn(() => handle.traceContext),
      checkpointDurable: vi.fn(async () => undefined),
      terminalDurable: vi.fn(async () => undefined),
      ...overrides,
    } as unknown as RunRegistry,
    handle,
  };
}

const deps = {
  baseModelConfig: { provider: 'test', model: 'model' },
  resolveModelConfig: () => ({ provider: 'test', model: 'model' }),
  deriveSubagentContext: () => ({}),
  resolveAgentTools: () => ({ tools: [], writeCapable: false }),
  useOsSandbox: false,
} as never;

function host(resolution: Awaited<ReturnType<DynamicWorkflowRecoveryHost['resolve']>> = { ok: true, workspace: '/tmp', cwd: '/tmp', deps }): DynamicWorkflowRecoveryHost {
  return { resolve: vi.fn(async () => resolution) };
}

describe('Dynamic Workflow startup recovery', () => {
  beforeEach(() => vi.mocked(runScriptInSandbox).mockClear());

  it('rebuilds Host deps after a simulated process restart and resumes the same logical workflow', async () => {
    const currentRegistry = registry();
    const currentHost = host();
    const result = await createDynamicWorkflowGraphRecoveryHandler({ registry: currentRegistry.value, host: currentHost }).recover(plan(state()));
    expect(result.status).toBe('recovered');
    expect(currentHost.resolve).toHaveBeenCalledOnce();
    expect(runScriptInSandbox).toHaveBeenCalledOnce();
    expect(vi.mocked(runScriptInSandbox).mock.calls[0][0]).toMatchObject({
      nestedGraph: { workflowRunId: 'logical-workflow', parentGraphId: 'dynamic-graph', parentNodeId: 'workflow-node' },
    });
    expect((currentRegistry.value.terminalDurable as ReturnType<typeof vi.fn>)).toHaveBeenCalledOnce();
  });

  it('does not execute an already completed Graph node or manufacture a second Graph terminal', async () => {
    const currentRegistry = registry();
    const result = await createDynamicWorkflowGraphRecoveryHandler({ registry: currentRegistry.value, host: host() }).recover(plan(state('completed')));
    expect(result.status).toBe('recovered');
    expect(runScriptInSandbox).not.toHaveBeenCalled();
    expect((currentRegistry.value.checkpointDurable as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it('fails closed when a required Host dependency cannot be reconstructed', async () => {
    const result = await createDynamicWorkflowGraphRecoveryHandler({
      registry: registry().value,
      host: host({ ok: false, reason: 'readonly tool dependency is unavailable' }),
    }).recover(plan(state()));
    expect(result).toMatchObject({ status: 'requires_review', reason: expect.stringContaining('dependency') });
    expect(runScriptInSandbox).not.toHaveBeenCalled();
  });

  it('converts a Host resolver exception into requires_review', async () => {
    const throwingHost: DynamicWorkflowRecoveryHost = { resolve: vi.fn(async () => { throw new Error('model registry offline'); }) };
    const result = await createDynamicWorkflowGraphRecoveryHandler({ registry: registry().value, host: throwingHost }).recover(plan(state()));
    expect(result).toMatchObject({ status: 'requires_review', reason: expect.stringContaining('model registry offline') });
    expect(runScriptInSandbox).not.toHaveBeenCalled();
  });

  it('fails closed when the owner/attempt binding is stale', async () => {
    const currentRegistry = registry({ bindRecoveredHandle: vi.fn(() => { throw new Error('stale owner epoch'); }) as never });
    const result = await createDynamicWorkflowGraphRecoveryHandler({ registry: currentRegistry.value, host: host() }).recover(plan(state()));
    expect(result).toMatchObject({ status: 'requires_review', reason: expect.stringContaining('stale owner') });
    expect(runScriptInSandbox).not.toHaveBeenCalled();
  });

  it('fences checkpoint writes after the recovered owner attempt becomes stale', async () => {
    const currentRegistry = registry();
    (currentRegistry.value.getTraceContext as ReturnType<typeof vi.fn>)
      .mockReturnValue({ ...currentRegistry.handle.traceContext, attempt: 1 });
    const result = await createDynamicWorkflowGraphRecoveryHandler({
      registry: currentRegistry.value,
      host: host(),
    }).recover(plan(state()));
    expect(result).toMatchObject({ status: 'requires_review', reason: expect.stringContaining('Graph attempt is stale') });
    expect((currentRegistry.value.checkpointDurable as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it('requires review instead of replaying an unknown side effect', async () => {
    const unsafe = state();
    unsafe.graphSpec.nodes[0].sideEffect = 'unknown';
    const result = await createDynamicWorkflowGraphRecoveryHandler({ registry: registry().value, host: host() }).recover(plan(unsafe));
    expect(result).toMatchObject({ status: 'requires_review', reason: expect.stringContaining('uncertain') });
    expect(runScriptInSandbox).not.toHaveBeenCalled();
  });

  it('rejects workspace drift and cwd escape after canonicalization', () => {
    const workspace = mkdtempSync(path.join(tmpdir(), 'dynamic-recovery-'));
    const canonicalWorkspace = resolveCanonicalRunPath(workspace);
    const safe = state();
    safe.workspace = { root: canonicalWorkspace, cwd: canonicalWorkspace, fingerprint: fingerprintRunWorkspace(canonicalWorkspace) };
    expect(validateDynamicWorkflowRecoveryWorkspace(safe, workspace)).toMatchObject({ ok: true, workspace: canonicalWorkspace });
    safe.workspace.cwd = path.dirname(canonicalWorkspace);
    expect(validateDynamicWorkflowRecoveryWorkspace(safe, workspace)).toMatchObject({ ok: false, reason: expect.stringContaining('drifted') });
  });

  it('never accepts executable functions or credential material in the checkpoint descriptor', () => {
    expect(() => createDynamicWorkflowDurableState({
      ...state(),
      graphSpec: { ...graphSpec, metadata: { apiKey: 'secret' } } as never,
    })).toThrow();
    expect(() => createDynamicWorkflowDurableState({
      ...state(),
      graphSpec: { ...graphSpec, metadata: { execute: (() => undefined) as never } } as never,
    })).toThrow();
    expect(JSON.stringify(state())).not.toMatch(/apiKey|credential|secret|function/i);
  });
});
