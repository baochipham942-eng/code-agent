import { describe, expect, it, vi } from 'vitest';
import type { PendingOperation, RunEnvelope, RunOwnerLease } from '../../../src/shared/contract/durableRun';
import type { RunKernelAdapter } from '../../../src/host/runtime/durableRunKernel';
import type { RunRehydrationPlan } from '../../../src/host/runtime/durableRunStores';
import { getTelemetryService } from '../../../src/host/telemetry/telemetryService';
import {
  McpDurableTaskController,
  buildMcpTaskRecoveryDecision,
  createMcpKernelCheckpointPort,
  createMcpTaskRecoveryHandler,
  type McpDurableCheckpointPort,
  type McpTaskCapability,
  type McpTaskProtocol,
} from '../../../src/host/mcp/mcpDurableTask';

const CAPABILITY: McpTaskCapability = {
  serverIdentity: 'github:server-fingerprint',
  trusted: true,
  serverToolsCall: true,
  query: true,
  cancel: true,
  toolTaskSupport: 'optional',
};

function fakeKernel(): RunKernelAdapter {
  return {
    prepareOperation: vi.fn((input) => ({
      runId: input.runId,
      operationId: input.operationId,
      attempt: input.attempt,
      kind: input.kind,
      status: 'prepared',
      idempotencyKey: `stable:${input.runId}:${input.logicalOperationId}`,
      sideEffect: input.sideEffect,
      requiresHumanConfirmation: input.sideEffect && !input.canDeduplicate,
      inputDigest: input.inputDigest,
      preparedAt: input.now,
      updatedAt: input.now,
    })),
  } as unknown as RunKernelAdapter;
}

function fixture() {
  const commits: Array<{ operation: PendingOperation; runStatus: string }> = [];
  const checkpoint: McpDurableCheckpointPort = {
    commit: vi.fn(async (input) => {
      commits.push({ operation: input.operation, runStatus: input.runStatus });
    }),
  };
  const protocol: McpTaskProtocol = {
    createTask: vi.fn(async () => ({
      taskId: 'task-provider-1', status: 'working', ttl: 60_000,
      createdAt: '2026-07-11T00:00:00Z', lastUpdatedAt: '2026-07-11T00:00:00Z',
    })),
    getTask: vi.fn(async () => ({
      taskId: 'task-provider-1', status: 'working', ttl: 60_000,
      createdAt: '2026-07-11T00:00:00Z', lastUpdatedAt: '2026-07-11T00:00:01Z',
    })),
    cancelTask: vi.fn(async () => ({
      taskId: 'task-provider-1', status: 'cancelled', ttl: 60_000,
      createdAt: '2026-07-11T00:00:00Z', lastUpdatedAt: '2026-07-11T00:00:02Z',
    })),
    resolveTaskResult: vi.fn(async () => ({ content: [{ type: 'text', text: 'done' }] })),
  };
  const storedResults = new Map<string, unknown>();
  const resultStore = {
    save: vi.fn(async (input: { result: unknown }) => {
      const ref = 'mcp-result:fixture-1';
      storedResults.set(ref, input.result);
      return ref;
    }),
    load: vi.fn(async (ref: string) => storedResults.get(ref) ?? null),
  };
  const controller = new McpDurableTaskController({
    kernel: fakeKernel(), checkpoint, protocol, resultStore,
  });
  return { controller, protocol, checkpoint, commits, resultStore, storedResults };
}

describe('MCP Durable Task', () => {
  it('commits MCP operations through the existing RunKernelAdapter checkpoint boundary', async () => {
    const checkpoint = vi.fn(async () => ({}));
    const owner: RunOwnerLease = {
      ownerId: 'owner', processInstanceId: 'process', epoch: 2, leaseExpiresAt: 999,
    };
    const port = createMcpKernelCheckpointPort({
      kernel: { checkpoint } as unknown as RunKernelAdapter,
      runId: 'run-a', attempt: 2, owner, getState: () => ({ cursor: 'safe' }),
    });
    const operation = {
      runId: 'run-a', operationId: 'call-a', attempt: 2, kind: 'tool_call', status: 'prepared',
      idempotencyKey: 'stable', sideEffect: false, inputDigest: 'digest', preparedAt: 1, updatedAt: 1,
    } satisfies PendingOperation;

    await port.commit({
      operation, runStatus: 'running', now: 10,
      event: { type: 'mcp_task_prepared', payload: { operationId: 'call-a', inputDigest: 'digest' } },
    });

    expect(checkpoint).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'run-a', attempt: 2, owner, pendingOperations: [operation],
      events: [expect.objectContaining({ type: 'mcp_task_prepared' })],
    }));
  });

  it('creates a waiting tool_call PendingOperation for a trusted task-capable tool', async () => {
    const { controller, commits } = fixture();
    const result = await controller.createMcpTask({
      runId: 'run-a', operationId: 'call-a', attempt: 1, serverIdentity: CAPABILITY.serverIdentity,
      serverName: 'github', toolName: 'search_code', args: { query: 'secret source text' },
      sideEffect: false, capability: CAPABILITY, now: 100,
    });

    expect(result.mode).toBe('task');
    if (result.mode !== 'task') throw new Error('expected task');
    expect(result.operation).toMatchObject({
      runId: 'run-a', operationId: 'call-a', kind: 'tool_call', status: 'waiting',
    });
    expect(result.operation.providerOperationId).toContain('mcp-task:v1:');
    expect(result.operation.inputDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(commits)).not.toContain('secret source text');
    expect(commits.map((entry) => entry.operation.status)).toEqual(['prepared', 'waiting']);
  });

  it('keeps tools synchronous when task execution is not declared or not trusted', async () => {
    const { controller, protocol, commits } = fixture();
    const missing = await controller.createMcpTask({
      runId: 'run-a', operationId: 'call-a', attempt: 1, serverIdentity: CAPABILITY.serverIdentity,
      serverName: 'github', toolName: 'search_code', args: {}, sideEffect: false,
      capability: { ...CAPABILITY, toolTaskSupport: undefined }, now: 100,
    });
    const untrusted = await controller.createMcpTask({
      runId: 'run-a', operationId: 'call-b', attempt: 1, serverIdentity: CAPABILITY.serverIdentity,
      serverName: 'github', toolName: 'search_code', args: {}, sideEffect: false,
      capability: { ...CAPABILITY, trusted: false }, now: 100,
    });

    expect(missing.mode).toBe('synchronous');
    expect(untrusted.mode).toBe('synchronous');
    expect(protocol.createTask).not.toHaveBeenCalled();
    expect(commits).toHaveLength(0);
  });

  it('fails closed when server and tool task declarations conflict', async () => {
    const { controller, protocol } = fixture();
    const result = await controller.createMcpTask({
      runId: 'run-a', operationId: 'call-a', attempt: 1, serverIdentity: CAPABILITY.serverIdentity,
      serverName: 'github', toolName: 'search_code', args: {}, sideEffect: true,
      capability: { ...CAPABILITY, serverToolsCall: false, toolTaskSupport: 'required' }, now: 100,
    });
    expect(result).toMatchObject({ mode: 'synchronous' });
    expect(protocol.createTask).not.toHaveBeenCalled();
  });

  it('binds task handles to run, operation, and server and rejects stale updates', async () => {
    const { controller } = fixture();
    const created = await controller.createMcpTask({
      runId: 'run-a', operationId: 'call-a', attempt: 1, serverIdentity: CAPABILITY.serverIdentity,
      serverName: 'github', toolName: 'search_code', args: {}, sideEffect: false,
      capability: CAPABILITY, now: 100,
    });
    if (created.mode !== 'task') throw new Error('expected task');

    await expect(controller.updateMcpTask({
      operation: { ...created.operation, runId: 'run-new' },
      runId: 'run-new', operationId: 'call-a', serverIdentity: CAPABILITY.serverIdentity,
      capability: CAPABILITY, now: 200,
    })).rejects.toThrow(/stale|binding/i);
  });

  it('cancels idempotently and only the bound task', async () => {
    const { controller, protocol } = fixture();
    const created = await controller.createMcpTask({
      runId: 'run-a', operationId: 'call-a', attempt: 1, serverIdentity: CAPABILITY.serverIdentity,
      serverName: 'github', toolName: 'search_code', args: {}, sideEffect: false,
      capability: CAPABILITY, now: 100,
    });
    if (created.mode !== 'task') throw new Error('expected task');

    const first = await controller.cancelMcpTask({
      operation: created.operation, runId: 'run-a', operationId: 'call-a',
      serverIdentity: CAPABILITY.serverIdentity, capability: CAPABILITY, now: 200,
    });
    await controller.cancelMcpTask({
      operation: first, runId: 'run-a', operationId: 'call-a',
      serverIdentity: CAPABILITY.serverIdentity, capability: CAPABILITY, now: 300,
    });

    expect(protocol.cancelTask).toHaveBeenCalledTimes(1);
    expect(protocol.cancelTask).toHaveBeenCalledWith(expect.objectContaining({ taskId: 'task-provider-1' }));
  });

  it('reuses terminal results after recovery without polling or executing again', async () => {
    const { controller, protocol } = fixture();
    const operation = {
      runId: 'run-a', operationId: 'call-a', attempt: 1, kind: 'tool_call', status: 'succeeded',
      idempotencyKey: 'stable', sideEffect: false, providerOperationId: 'unused', resultRef: 'sha256:result',
      preparedAt: 1, updatedAt: 2,
    } satisfies PendingOperation;

    const updated = await controller.updateMcpTask({
      operation, runId: 'run-a', operationId: 'call-a', serverIdentity: CAPABILITY.serverIdentity,
      capability: CAPABILITY, now: 300,
    });

    expect(updated).toBe(operation);
    expect(protocol.getTask).not.toHaveBeenCalled();
    expect(protocol.resolveTaskResult).not.toHaveBeenCalled();
  });

  it('resolves a completed task once and then reuses the terminal result', async () => {
    const { controller, protocol } = fixture();
    vi.mocked(protocol.getTask).mockResolvedValue({
      taskId: 'task-provider-1', status: 'completed', ttl: 60_000,
      createdAt: '2026-07-11T00:00:00Z', lastUpdatedAt: '2026-07-11T00:00:03Z',
    });
    const created = await controller.createMcpTask({
      runId: 'run-a', operationId: 'call-a', attempt: 1, serverIdentity: CAPABILITY.serverIdentity,
      serverName: 'github', toolName: 'search_code', args: {}, sideEffect: false,
      capability: CAPABILITY, now: 100,
    });
    if (created.mode !== 'task') throw new Error('expected task');

    const terminal = await controller.updateMcpTask({
      operation: created.operation, runId: 'run-a', operationId: 'call-a',
      serverIdentity: CAPABILITY.serverIdentity, capability: CAPABILITY, now: 200,
    });
    await controller.updateMcpTask({
      operation: terminal, runId: 'run-a', operationId: 'call-a',
      serverIdentity: CAPABILITY.serverIdentity, capability: CAPABILITY, now: 300,
    });

    expect(terminal).toMatchObject({ status: 'succeeded', resultRef: 'mcp-result:fixture-1' });
    expect(protocol.getTask).toHaveBeenCalledTimes(1);
    expect(protocol.resolveTaskResult).toHaveBeenCalledTimes(1);
  });

  it('records separate safe client spans for create/get/update/cancel', async () => {
    const telemetry = getTelemetryService();
    telemetry.reset();
    const { controller } = fixture();
    const created = await controller.createMcpTask({
      runId: 'run-a', operationId: 'call-secret', attempt: 1, serverIdentity: CAPABILITY.serverIdentity,
      serverName: 'github', toolName: 'search_code', args: { authorization: 'Bearer secret' },
      sideEffect: false, capability: CAPABILITY, now: 100,
    });
    if (created.mode !== 'task') throw new Error('expected task');
    await controller.updateMcpTask({
      operation: created.operation, runId: 'run-a', operationId: 'call-secret',
      serverIdentity: CAPABILITY.serverIdentity, capability: CAPABILITY, now: 200,
    });
    await controller.cancelMcpTask({
      operation: created.operation, runId: 'run-a', operationId: 'call-secret',
      serverIdentity: CAPABILITY.serverIdentity, capability: CAPABILITY, now: 300,
    });

    const spans = telemetry.getRecentSpans(10).filter((span) => span.name.startsWith('mcp task'));
    expect(spans.map((span) => span.attributes['mcp.task.operation'])).toEqual(expect.arrayContaining([
      'create', 'get', 'update', 'cancel',
    ]));
    expect(JSON.stringify(spans)).not.toMatch(/Bearer secret|authorization/i);
  });

  it('preserves the durable waiting fact when task query transport disconnects', async () => {
    const { controller, protocol, commits } = fixture();
    const created = await controller.createMcpTask({
      runId: 'run-a', operationId: 'call-a', attempt: 1, serverIdentity: CAPABILITY.serverIdentity,
      serverName: 'github', toolName: 'search_code', args: {}, sideEffect: true,
      capability: CAPABILITY, now: 100,
    });
    if (created.mode !== 'task') throw new Error('expected task');
    vi.mocked(protocol.getTask).mockRejectedValue(new Error('Connection closed'));

    await expect(controller.updateMcpTask({
      operation: created.operation, runId: 'run-a', operationId: 'call-a',
      serverIdentity: CAPABILITY.serverIdentity, capability: CAPABILITY, now: 200,
    })).rejects.toThrow('Connection closed');

    expect(created.operation.status).toBe('waiting');
    expect(commits.at(-1)?.operation.status).toBe('waiting');
    expect(protocol.createTask).toHaveBeenCalledTimes(1);
  });

  it('requires review for unknown dispatch without a queryable handle and never blind-retries side effects', () => {
    const operation = {
      runId: 'run-a', operationId: 'call-a', attempt: 2, kind: 'tool_call', status: 'unknown',
      idempotencyKey: 'stable', sideEffect: true, requiresHumanConfirmation: true,
      preparedAt: 1, updatedAt: 2,
    } satisfies PendingOperation;
    const plan = {
      envelope: { runId: 'run-a' } as RunEnvelope,
      previousAttempt: {} as never,
      checkpoint: null,
      pendingOperations: [operation], childRuns: [], requiresHumanConfirmation: [operation],
    } satisfies RunRehydrationPlan;

    expect(buildMcpTaskRecoveryDecision(plan, operation, () => undefined)).toMatchObject({
      action: 'requires_review', retry: false,
    });
  });

  it('exports a recovery handler that rejects invalid handles as failed/requires_review', async () => {
    const { controller } = fixture();
    const invalid = {
      runId: 'run-a', operationId: 'call-a', attempt: 2, kind: 'tool_call', status: 'waiting',
      idempotencyKey: 'stable', sideEffect: false, providerOperationId: 'stale-handle',
      preparedAt: 1, updatedAt: 2,
    } satisfies PendingOperation;
    const handler = createMcpTaskRecoveryHandler(controller, {
      resolveCapability: () => CAPABILITY,
      isMcpOperation: () => true,
    });
    const result = await handler({
      envelope: { runId: 'run-a' } as RunEnvelope,
      previousAttempt: {} as never,
      checkpoint: null,
      pendingOperations: [invalid], childRuns: [], requiresHumanConfirmation: [],
    } as RunRehydrationPlan, 300);

    expect(result[0]).toMatchObject({ action: 'requires_review' });
    expect(result[0]?.operation).toMatchObject({ status: 'failed', requiresHumanConfirmation: true });
  });

  it('loads the durable result for recovery display without querying or re-executing the task', async () => {
    const { controller, protocol, resultStore, storedResults } = fixture();
    storedResults.set('mcp-result:existing', { content: 'restored display' });
    const operation = {
      runId: 'run-a', operationId: 'call-a', attempt: 2, kind: 'tool_call', status: 'succeeded',
      idempotencyKey: 'stable', sideEffect: false, resultRef: 'mcp-result:existing',
      preparedAt: 1, updatedAt: 2,
    } satisfies PendingOperation;
    const handler = createMcpTaskRecoveryHandler(controller, {
      resolveCapability: () => CAPABILITY,
      isMcpOperation: () => true,
    });
    const result = await handler({
      envelope: { runId: 'run-a' } as RunEnvelope,
      previousAttempt: {} as never,
      checkpoint: null,
      pendingOperations: [operation], childRuns: [], requiresHumanConfirmation: [],
    } as RunRehydrationPlan, 300);

    expect(result[0]).toMatchObject({
      action: 'reuse_result', result: { content: 'restored display' },
    });
    expect(resultStore.load).toHaveBeenCalledWith('mcp-result:existing');
    expect(protocol.getTask).not.toHaveBeenCalled();
    expect(protocol.resolveTaskResult).not.toHaveBeenCalled();
  });

  it('does not claim non-MCP tool_call operations during recovery', async () => {
    const { controller } = fixture();
    const otherProviderOperation = {
      runId: 'run-a', operationId: 'native-call', attempt: 2, kind: 'tool_call', status: 'unknown',
      idempotencyKey: 'stable', sideEffect: true, preparedAt: 1, updatedAt: 2,
    } satisfies PendingOperation;
    const handler = createMcpTaskRecoveryHandler(controller, {
      resolveCapability: () => CAPABILITY,
      isMcpOperation: () => false,
    });
    const result = await handler({
      envelope: { runId: 'run-a' } as RunEnvelope,
      previousAttempt: {} as never,
      checkpoint: null,
      pendingOperations: [otherProviderOperation], childRuns: [], requiresHumanConfirmation: [],
    } as RunRehydrationPlan, 300);

    expect(result).toEqual([]);
  });
});
