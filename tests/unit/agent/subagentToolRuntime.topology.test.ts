import { beforeEach, describe, expect, it, vi } from 'vitest';

const resolverState = vi.hoisted(() => ({
  getDefinition: vi.fn(),
  execute: vi.fn(),
}));

const classificationState = vi.hoisted(() => ({
  resolveToolPermissionClassification: vi.fn(),
}));

vi.mock('../../../src/host/tools/dispatch/toolResolver', () => ({
  getToolResolver: () => ({
    getDefinition: resolverState.getDefinition,
    execute: resolverState.execute,
  }),
}));

vi.mock('../../../src/host/tools/toolPermissionClassification', async () => {
  const actual = await vi.importActual<typeof import('../../../src/host/tools/toolPermissionClassification')>(
    '../../../src/host/tools/toolPermissionClassification',
  );
  return {
    ...actual,
    resolveToolPermissionClassification: classificationState.resolveToolPermissionClassification,
  };
});

vi.mock('../../../src/host/services/infra/toolCache', () => ({
  getToolCache: () => ({
    isCacheable: () => false,
    get: () => null,
    set: vi.fn(),
    invalidateForPath: vi.fn(),
    invalidateForWorkspace: vi.fn(),
  }),
}));

vi.mock('../../../src/host/tools/middleware/fileCheckpointMiddleware', () => ({
  createFileCheckpointIfNeeded: vi.fn(),
}));

vi.mock('../../../src/host/services/infra/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { resetGuardFabric } from '../../../src/host/permissions';
import { createSubagentToolRuntime } from '../../../src/host/agent/subagentToolRuntime';
import type { SubagentExecutionContext } from '../../../src/host/agent/subagentExecutorTypes';

function defineAgentSpawn(): void {
  resolverState.getDefinition.mockImplementation((name: string) => {
    if (name !== 'AgentSpawn' && name !== 'spawn_agent') return undefined;
    return {
      name: 'AgentSpawn',
      description: 'Spawn teammate agent',
      inputSchema: {
        type: 'object',
        properties: { prompt: { type: 'string' } },
        required: ['prompt'],
      },
      requiresPermission: true,
      permissionLevel: 'execute',
    };
  });
}

function makeContext(overrides: Partial<SubagentExecutionContext> = {}): SubagentExecutionContext {
  return {
    sessionId: 's1',
    cwd: '/tmp/workbench',
    permission: { request: vi.fn(async () => true) },
    resolver: { getDefinition: () => undefined },
    ...overrides,
  } as unknown as SubagentExecutionContext;
}

function makeRuntime(context: SubagentExecutionContext) {
  return createSubagentToolRuntime({
    context,
    sessionId: 's1',
    effectiveMode: 'default',
    allowedToolNames: new Set(['AgentSpawn']),
    checkToolExecution: () => true,
  });
}

describe('createSubagentToolRuntime execution topology pipe', () => {
  beforeEach(() => {
    resetGuardFabric();
    resolverState.getDefinition.mockReset();
    resolverState.execute.mockReset();
    classificationState.resolveToolPermissionClassification.mockReset();
    resolverState.execute.mockResolvedValue({ success: true, output: 'ok' });
    classificationState.resolveToolPermissionClassification.mockResolvedValue({
      decision: 'ask',
      reason: 'test classifier ask',
      confidence: 0.5,
      cached: false,
      traceStep: {
        layer: 'permission_classifier',
        rule: 'test-ask',
        result: 'ask',
        reason: 'test classifier ask',
        durationMs: 0,
        timestamp: Date.now(),
      },
    });
  });

  it('passes context.executionTopology to the ToolExecutor (teammate denies spawn_agent)', async () => {
    defineAgentSpawn();
    const { executor } = makeRuntime(makeContext({ executionTopology: 'teammate' } as Partial<SubagentExecutionContext>));

    const result = await executor.execute('AgentSpawn', { prompt: 'nested spawn' }, { sessionId: 's1' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('topology rule');
    expect(resolverState.execute).not.toHaveBeenCalled();
  });

  it('defaults to main when context has no executionTopology (behavior unchanged)', async () => {
    defineAgentSpawn();
    const { executor } = makeRuntime(makeContext());

    const result = await executor.execute('AgentSpawn', { prompt: 'nested spawn' }, { sessionId: 's1' });

    expect(result.success).toBe(true);
    expect(resolverState.execute).toHaveBeenCalledTimes(1);
  });
});
