import { SdkError, SdkErrorCode } from '@modelcontextprotocol/client';
import { describe, expect, it, vi } from 'vitest';
import { McpSdkTaskProtocol } from '../../../src/host/mcp/mcpTaskProtocol';
import {
  createRunTraceContext,
  withRunTraceContext,
} from '../../../src/host/telemetry/runTraceContext';

const TASK = {
  taskId: 'task-1', status: 'working' as const, ttl: 60_000,
  createdAt: '2026-07-11T00:00:00Z', lastUpdatedAt: '2026-07-11T00:00:01Z',
};

describe('McpSdkTaskProtocol', () => {
  it('propagates trace metadata and accepts a task handle without per-request opt-in', async () => {
    let getCalls = 0;
    const request = vi.fn(async (value: { method: string; params: Record<string, unknown> }) => {
      if (value.method === 'tools/call') return { task: TASK };
      if (value.method === 'tasks/get') {
        getCalls += 1;
        return getCalls === 1
          ? { task: TASK }
          : { task: { ...TASK, status: 'completed' }, result: { content: [{ type: 'text', text: 'done' }] } };
      }
      return { task: { ...TASK, status: 'cancelled' } };
    });
    const protocol = new McpSdkTaskProtocol(
      { request } as never,
      'server:identity',
      { sleep: async () => {} },
    );
    const trace = createRunTraceContext({
      runId: 'run-trace', sessionId: 'session-trace', attempt: 1, ownerEpoch: 1,
      engine: 'native', workspace: '/tmp/workspace', processInstanceId: 'process-trace',
      traceState: 'vendor=value',
    });

    await withRunTraceContext(trace, async () => {
      await protocol.createTask({
        serverIdentity: 'server:identity', serverName: 'docs', toolName: 'long_read',
        args: { authorization: 'Bearer secret', query: 'sensitive input' },
      });
      await protocol.getTask({ serverIdentity: 'server:identity', taskId: 'task-1' });
      await protocol.resolveTaskResult({ serverIdentity: 'server:identity', taskId: 'task-1' });
      await protocol.cancelTask({ serverIdentity: 'server:identity', taskId: 'task-1' });
    });

    expect(request).toHaveBeenCalledTimes(4);
    expect(request.mock.calls.map(([rpc]) => rpc.method)).toEqual([
      'tools/call', 'tasks/get', 'tasks/get', 'tasks/cancel',
    ]);
    expect(request.mock.calls[0]?.[0].params).not.toHaveProperty('task');
    for (const [rpc] of request.mock.calls) {
      const meta = rpc.params._meta;
      expect(meta).toEqual({
        traceparent: `00-${trace.traceId}-${trace.spanId}-01`,
        tracestate: 'vendor=value',
      });
      expect(JSON.stringify(meta)).not.toMatch(/authorization|secret|sensitive|query/i);
    }
  });

  it('polls tasks/get with bounded backoff until the terminal result arrives', async () => {
    const statuses = ['working', 'working', 'completed'] as const;
    const request = vi.fn(async () => {
      const status = statuses[Math.min(request.mock.calls.length - 1, statuses.length - 1)]!;
      return {
        task: { ...TASK, status },
        ...(status === 'completed' ? { result: { content: [{ type: 'text', text: 'done' }] } } : {}),
      };
    });
    const sleep = vi.fn(async (_delayMs: number) => {});
    const protocol = new McpSdkTaskProtocol(
      { request } as never,
      'server:identity',
      { maxPollAttempts: 4, initialPollDelayMs: 10, maxPollDelayMs: 20, sleep },
    );

    await expect(protocol.resolveTaskResult({
      serverIdentity: 'server:identity',
      taskId: 'task-1',
    })).resolves.toEqual({ content: [{ type: 'text', text: 'done' }] });

    expect(request).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([10, 20]);
  });

  it('fails through a recognizable bounded-timeout path instead of polling forever', async () => {
    const request = vi.fn(async () => ({ task: TASK }));
    const protocol = new McpSdkTaskProtocol(
      { request } as never,
      'server:identity',
      { maxPollAttempts: 3, sleep: async () => {} },
    );

    await expect(protocol.resolveTaskResult({
      serverIdentity: 'server:identity',
      taskId: 'task-1',
    })).rejects.toMatchObject({
      code: 'MCP_TASK_UNAVAILABLE',
      reason: 'timeout',
      taskId: 'task-1',
    });
    expect(request).toHaveBeenCalledTimes(3);
  });

  it('maps unsupported task methods to the recognizable unavailable path', async () => {
    const request = vi.fn(async () => {
      throw new SdkError(
        SdkErrorCode.MethodNotSupportedByProtocolVersion,
        'tasks/get is unavailable',
      );
    });
    const protocol = new McpSdkTaskProtocol({ request } as never, 'server:identity');

    await expect(protocol.getTask({
      serverIdentity: 'server:identity',
      taskId: 'task-1',
    })).rejects.toMatchObject({
      code: 'MCP_TASK_UNAVAILABLE',
      reason: 'unsupported',
    });
  });

  it('sends supplemental input through tasks/update', async () => {
    const request = vi.fn(async () => ({ task: { ...TASK, status: 'working' } }));
    const protocol = new McpSdkTaskProtocol({ request } as never, 'server:identity');

    await protocol.updateTask({
      serverIdentity: 'server:identity',
      taskId: 'task-1',
      input: { approval: true },
    });

    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'tasks/update',
        params: expect.objectContaining({ taskId: 'task-1', input: { approval: true } }),
      }),
      expect.anything(),
      expect.anything(),
    );
  });
});
