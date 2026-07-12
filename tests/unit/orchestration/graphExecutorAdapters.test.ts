import { describe, expect, it, vi } from 'vitest';
import {
  ExternalEngineExecutor,
  McpTaskExecutor,
  NativeConversationExecutor,
  type GraphExecutorContext,
  type GraphJsonValue,
  type GraphNode,
} from '../../../src/host/orchestration';
import type { PendingOperation } from '../../../src/shared/contract/durableRun';

function node(kind: string, input: GraphJsonValue): GraphNode {
  return { nodeId: `${kind}-node`, kind, executorRef: kind, input, dependencies: [], sideEffect: 'unknown' };
}

function context(over: Partial<GraphExecutorContext> = {}): GraphExecutorContext {
  return {
    graphId: 'graph', runId: 'run', sessionId: 'session', attempt: 1, nodeAttempt: 1,
    signal: new AbortController().signal, dependencyResults: {}, progress: vi.fn(async () => {}), ...over,
  };
}

describe('remaining Graph executor adapters', () => {
  it('uses ConversationRuntime as the sole native loop and forwards controls', async () => {
    let resolveRun!: () => void;
    const runtime = {
      run: vi.fn(() => new Promise<void>((resolve) => { resolveRun = resolve; })),
      cancel: vi.fn(async () => {}), pause: vi.fn(), resume: vi.fn(), steer: vi.fn(),
    };
    const adapter = new NativeConversationExecutor({ runtimeFactory: () => runtime as never });
    const graphNode = node('native_conversation', { message: 'hello' });
    const running = adapter.execute(graphNode, context());
    await vi.waitFor(() => expect(runtime.run).toHaveBeenCalledWith('hello'));
    adapter.pause('run', graphNode.nodeId);
    adapter.steer('run', graphNode.nodeId, 'new direction');
    adapter.resume('run', graphNode.nodeId);
    expect(runtime.pause).toHaveBeenCalledOnce();
    expect(runtime.steer).toHaveBeenCalledWith('new direction');
    expect(runtime.resume).toHaveBeenCalledOnce();
    resolveRun();
    await expect(running).resolves.toMatchObject({ status: 'completed' });
  });

  it('maps external lifecycle identity and refuses unsafe recovery', async () => {
    const lifecycle = { runId: 'run', sessionId: 'session', attempt: 1, terminateProcess: vi.fn(async () => {}) };
    const launch = vi.fn(async () => ({ runId: 'run', sessionId: 'session', engine: 'codex_cli', status: 'completed', outputText: 'ok' }));
    const adapter = new ExternalEngineExecutor({ resolve: () => ({ lifecycle: lifecycle as never, launch }) });
    await expect(adapter.execute(node('external_engine', { engine: 'codex_cli' }), context())).resolves.toMatchObject({
      status: 'completed', checkpoint: { engine: 'codex_cli', runId: 'run', attempt: 1 },
    });
    await expect(adapter.recover(node('external_engine', { engine: 'kimi_code' }), {} as never, context())).resolves.toMatchObject({
      status: 'requires_review', sideEffectState: 'unknown',
    });
  });

  it('maps MCP durable waiting/result reuse and excludes synchronous tools', async () => {
    const waiting: PendingOperation = {
      runId: 'run', operationId: 'op', attempt: 1, kind: 'tool_call', status: 'waiting',
      idempotencyKey: 'key', sideEffect: false, providerOperationId: 'mcp-task:v1:handle', preparedAt: 1, updatedAt: 1,
    };
    const controller = {
      createMcpTask: vi.fn(async () => ({ mode: 'task' as const, operation: waiting, task: { taskId: 'task', status: 'working', ttl: null, createdAt: '', lastUpdatedAt: '' } })),
      updateMcpTask: vi.fn(async () => ({ ...waiting, status: 'succeeded', resultRef: 'result:1' })),
      loadMcpTaskResult: vi.fn(async () => ({ answer: 42 })),
      cancelMcpTask: vi.fn(async () => waiting),
    };
    const capability = { serverIdentity: 'server-id', trusted: true, serverToolsCall: true, query: true, cancel: true, toolTaskSupport: 'required' as const };
    const adapter = new McpTaskExecutor({ resolve: () => ({ controller: controller as never, capability }) });
    const graphNode = node('mcp_durable_task', {
      durableTask: true, operationId: 'op', serverIdentity: 'server-id', serverName: 'server', toolName: 'slow', args: {}, sideEffect: false,
    });
    await expect(adapter.execute(graphNode, context())).resolves.toMatchObject({ status: 'waiting' });

    const recovered = new McpTaskExecutor({ resolve: () => ({ controller: controller as never, capability, operation: { ...waiting, status: 'succeeded', resultRef: 'result:1' } }) });
    await expect(recovered.recover(graphNode, {} as never, context())).resolves.toMatchObject({ status: 'completed', output: { answer: 42 } });
    expect(recovered.canExecute(node('mcp_durable_task', { durableTask: false }))).toBe(false);
  });
});
