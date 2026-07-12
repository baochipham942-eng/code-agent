import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/host/agent/scriptRuntime/sandbox', () => ({
  runScriptInSandbox: vi.fn(async () => ({ ok: true, result: { ok: true } })),
}));

import { runScriptInSandbox } from '../../../src/host/agent/scriptRuntime/sandbox';
import { DynamicWorkflowExecutor, type GraphExecutorContext, type GraphNode } from '../../../src/host/orchestration';

const graphNode: GraphNode = {
  nodeId: 'workflow-node', kind: 'dynamic_workflow', executorRef: 'dynamic_workflow', dependencies: [], sideEffect: 'unknown',
  input: { script: 'return 1', defaultProvider: 'test', defaultModel: 'model', workflowRunId: 'logical-workflow' },
};

function context(nodeAttempt = 1): GraphExecutorContext {
  return {
    graphId: 'parent-graph', runId: 'durable-run', sessionId: 'session', attempt: 3, nodeAttempt,
    signal: new AbortController().signal, dependencyResults: {}, progress: vi.fn(async () => {}),
  };
}

describe('DynamicWorkflowExecutor', () => {
  beforeEach(() => vi.mocked(runScriptInSandbox).mockClear());

  it('wraps the sandbox run as one parent node with stable nested identity', async () => {
    const adapter = new DynamicWorkflowExecutor({
      dependenciesFactory: () => ({
        baseModelConfig: { provider: 'test', model: 'model', apiKey: 'secret' } as never,
        resolveModelConfig: () => ({ provider: 'test', model: 'model', apiKey: 'secret' }) as never,
        deriveSubagentContext: () => ({}) as never,
        resolveAgentTools: () => ({ tools: [], writeCapable: false }),
        useOsSandbox: false,
      }),
    });
    const first = await adapter.execute(graphNode, context(1));
    const second = await adapter.execute(graphNode, context(2));
    expect(first).toMatchObject({ status: 'completed', checkpoint: { workflowRunId: 'logical-workflow', journalRunId: 'logical-workflow' } });
    expect(second.checkpoint).toMatchObject({ nestedGraphId: (first.checkpoint as { nestedGraphId: string }).nestedGraphId });
    const calls = vi.mocked(runScriptInSandbox).mock.calls;
    expect(calls[0][0].nestedGraph?.parentNodeId).toBe('workflow-node');
    expect(calls[1][0].nestedGraph?.nestedGraphId).toBe(calls[0][0].nestedGraph?.nestedGraphId);
  });

  it('preserves an explicit journal resume source on the first Graph attempt', async () => {
    const loadPriorRun = vi.fn(() => null);
    const adapter = new DynamicWorkflowExecutor({
      dependenciesFactory: () => ({
        baseModelConfig: { provider: 'test', model: 'model' } as never,
        resolveModelConfig: () => ({ provider: 'test', model: 'model' }) as never,
        deriveSubagentContext: () => ({}) as never,
        resolveAgentTools: () => ({ tools: [], writeCapable: false }),
        useOsSandbox: false,
        journal: {
          loadPriorRun,
          loadPriorCalls: () => null,
          onRunStart: vi.fn(), onRunFinish: vi.fn(), onCallComplete: vi.fn(),
        },
      }),
    });
    await adapter.execute({
      ...graphNode,
      input: { ...(graphNode.input as Record<string, unknown>), resumeFromRunId: 'prior-workflow', journalRunId: 'logical-workflow' } as never,
    }, context(1));
    expect(loadPriorRun).toHaveBeenCalledWith('prior-workflow');
  });
});
