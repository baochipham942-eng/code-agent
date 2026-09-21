import { describe, expect, it, vi } from 'vitest';
import type { RunKernelAdapter } from '../../../../src/host/runtime/durableRunKernel';
import type { RunRehydrationPlan } from '../../../../src/host/runtime/durableRunStores';
import { createMcpOperationRecoveryHandler } from '../../../../src/host/runtime/durableRecoveryHandlers';
import {
  McpDurableTaskController,
  type McpDurableCheckpointPort,
  type McpTaskCapability,
  type McpTaskProtocol,
} from '../../../../src/host/mcp/mcpDurableTask';
import type { MCPClient } from '../../../../src/host/mcp/mcpClient';

const SERVER_NAME = 'local';
const SERVER_IDENTITY = 'server-fingerprint:local';

const CAPABILITY: McpTaskCapability = {
  serverIdentity: SERVER_IDENTITY,
  trusted: true,
  serverToolsCall: true,
  query: true,
  cancel: true,
  update: true,
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
      requiresHumanConfirmation: false,
      inputDigest: input.inputDigest,
      preparedAt: input.now,
      updatedAt: input.now,
    })),
    checkpoint: vi.fn(async () => undefined),
  } as unknown as RunKernelAdapter;
}

/**
 * Mints a real, decodable MCP task handle by driving the production
 * McpDurableTaskController.createMcpTask against a minimal task-only stub
 * protocol — reusing the real encodeHandle path instead of duplicating it.
 */
async function createRealTaskOperation() {
  const checkpoint: McpDurableCheckpointPort = { commit: vi.fn(async () => undefined) };
  const stubProtocol: McpTaskProtocol = {
    createTask: vi.fn(async () => ({
      taskId: 'task-1', status: 'working' as const, ttl: 10_000,
      createdAt: '2026-09-20T00:00:00Z', lastUpdatedAt: '2026-09-20T00:00:00Z',
    })),
    getTask: vi.fn(async () => { throw new Error('unused'); }),
    cancelTask: vi.fn(async () => { throw new Error('unused'); }),
    resolveTaskResult: vi.fn(async () => 'unused'),
  };
  const controller = new McpDurableTaskController({
    kernel: fakeKernel(),
    checkpoint,
    protocol: stubProtocol,
    resultStore: { save: vi.fn(async () => 'ref'), load: vi.fn(async () => undefined) },
  });
  const result = await controller.createMcpTask({
    runId: 'run-a', operationId: 'call-a', attempt: 1, serverIdentity: SERVER_IDENTITY,
    serverName: SERVER_NAME, toolName: 'search', args: {}, sideEffect: false,
    capability: CAPABILITY, now: 0,
  });
  if (result.mode !== 'task') throw new Error('expected a task-backed dispatch');
  return result.operation;
}

function fakeMcpClient() {
  const acquireConnectionLease = vi.fn();
  const releaseConnectionLease = vi.fn();
  const taskProtocol: McpTaskProtocol = {
    createTask: vi.fn(async () => { throw new Error('recovery never creates a task'); }),
    getTask: vi.fn(async () => ({
      taskId: 'task-1', status: 'working' as const, ttl: 10_000,
      createdAt: '2026-09-20T00:00:00Z', lastUpdatedAt: '2026-09-20T00:00:01Z',
    })),
    cancelTask: vi.fn(async () => { throw new Error('unused'); }),
    resolveTaskResult: vi.fn(async () => 'unused'),
  };
  const client = {
    getServerStates: () => [{
      config: { name: SERVER_NAME, type: 'stdio', command: 'echo', enabled: true },
      status: 'connected', toolCount: 1, resourceCount: 0,
    }],
    getServerIdentity: (name: string) => (name === SERVER_NAME ? SERVER_IDENTITY : undefined),
    getTools: () => [{ serverName: SERVER_NAME, name: 'search' }],
    buildTaskCapability: () => CAPABILITY,
    createTaskProtocol: () => taskProtocol,
    acquireConnectionLease,
    releaseConnectionLease,
  };
  return { client: client as unknown as MCPClient, acquireConnectionLease, releaseConnectionLease, taskProtocol };
}

function planFor(operation: Awaited<ReturnType<typeof createRealTaskOperation>>): RunRehydrationPlan {
  return {
    envelope: {
      schemaVersion: 1, runId: 'run-a', sessionId: 'session-a', engine: { kind: 'native' },
      status: 'recovering', attempt: 2, cursor: { nextEventSeq: 2, checkpointSeq: 1 },
      owner: { ownerId: 'owner', processInstanceId: 'new', epoch: 2, leaseExpiresAt: 10_000 },
      pendingOperations: [operation], childRuns: [], createdAt: 0, updatedAt: 0,
    },
    previousAttempt: { runId: 'run-a', attempt: 1, processInstanceId: 'old', ownerId: 'owner', ownerEpoch: 1, status: 'ended', startedAt: 0 },
    checkpoint: null, pendingOperations: [operation], childRuns: [], requiresHumanConfirmation: [],
  };
}

describe('createMcpOperationRecoveryHandler durable task lease', () => {
  it('forwards acquire/release connection lease calls to the MCP client, not a no-op optional chain', async () => {
    const operation = await createRealTaskOperation();
    const { client, acquireConnectionLease, releaseConnectionLease } = fakeMcpClient();
    const handler = createMcpOperationRecoveryHandler({
      kernel: fakeKernel(),
      resultStore: { save: vi.fn(async () => 'ref'), load: vi.fn(async () => undefined) },
      getClient: () => client,
      trustedServerIdentities: new Set([SERVER_IDENTITY]),
    });

    const [decision] = await Promise.all([
      handler.recover(planFor(operation), operation, 100),
    ]);

    expect(decision.status).toBe('observing');
    // The production facade must resolve serverIdentity -> serverName and call
    // through to the real MCPClient lease API — this used to be swallowed by
    // an optional-chain no-op because the facade never implemented these two
    // methods at all.
    // Task remains 'working': the durable task-level lease is acquired (kept alive)...
    expect(acquireConnectionLease).toHaveBeenCalledWith(SERVER_NAME, 'mcp-task:run-a:call-a', expect.anything());
    // ...and the short-lived per-request lease taken around the tasks/get call is released again.
    expect(releaseConnectionLease).toHaveBeenCalledWith(SERVER_NAME, 'mcp-task:run-a:call-a:request');
  });
});
