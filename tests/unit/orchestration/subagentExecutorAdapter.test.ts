import { describe, expect, it, vi } from 'vitest';
import {
  SubagentExecutorAdapter,
  createSubagentGraphNodeInput,
  type GraphExecutorContext,
  type GraphNode,
} from '../../../src/host/orchestration';
import type { SubagentExecutionRequest } from '../../../src/host/agent/subagentExecutorTypes';

function graphContext(signal: AbortSignal): GraphExecutorContext {
  return {
    graphId: 'graph',
    runId: 'run',
    sessionId: 'session',
    attempt: 2,
    nodeAttempt: 1,
    signal,
    dependencyResults: {},
    trace: { traceId: 'trace', spanId: 'node-span' },
    progress: async () => undefined,
  };
}

const node: GraphNode = {
  nodeId: 'child',
  kind: 'subagent',
  executorRef: 'subagent',
  input: createSubagentGraphNodeInput({
    prompt: 'do work',
    config: { name: 'worker', roleId: 'worker', systemPrompt: 'system', availableTools: ['Read'] },
  }),
  dependencies: [],
  sideEffect: 'read_only',
};

describe('SubagentExecutorAdapter', () => {
  it('preserves protocol-native run/session/workspace/cwd/trace and node cancel signal', async () => {
    const execute = vi.fn(async (_request: SubagentExecutionRequest) => ({
      success: true, output: 'done', toolsUsed: ['Read'], iterations: 1,
    }));
    const controller = new AbortController();
    const context = graphContext(controller.signal);
    const adapter = new SubagentExecutorAdapter({ execute }, {
      contextFactory: (_node, graph) => ({
        runId: graph.runId,
        sessionId: graph.sessionId,
        workspace: '/workspace',
        cwd: '/workspace/repo',
        modelConfig: { provider: 'mock', model: 'mock' },
        resolver: { getDefinition: vi.fn() },
        permission: { request: vi.fn(async () => true) },
        events: { emit: vi.fn() },
        abortSignal: graph.signal,
        traceContext: graph.trace ? {
          ...graph.trace,
          attempt: graph.attempt,
          ownerEpoch: 3,
          engine: 'agent_team',
          processInstanceId: 'process',
          sessionId: graph.sessionId,
          runId: graph.runId,
          workspaceFingerprint: 'fp',
          traceFlags: 1,
          traceState: undefined,
          parentRunId: undefined,
        } : undefined,
      }),
    });
    const result = await adapter.execute(node, context);
    expect(result.status).toBe('completed');
    expect(execute.mock.calls[0][0]).toMatchObject({
      prompt: 'do work',
      config: { roleId: 'worker', availableTools: ['Read'] },
      context: {
        runId: 'run', sessionId: 'session', workspace: '/workspace', cwd: '/workspace/repo',
        abortSignal: controller.signal,
      },
    });
  });

  it('fails closed when an adapter changes graph identity or cancel binding', async () => {
    const context = graphContext(new AbortController().signal);
    const base = {
      sessionId: 'wrong',
      cwd: '/tmp',
      modelConfig: { provider: 'mock', model: 'mock' },
      resolver: { getDefinition: vi.fn() },
      permission: { request: vi.fn(async () => true) },
      events: { emit: vi.fn() },
      abortSignal: context.signal,
    } as never;
    const adapter = new SubagentExecutorAdapter({ execute: vi.fn() }, { contextFactory: () => base });
    await expect(adapter.execute(node, context)).rejects.toThrow('session identity mismatch');
  });
});
