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

describe('McpSdkTaskProtocol trace propagation', () => {
  it('propagates traceparent/tracestate to create/get/result/cancel without sensitive material', async () => {
    const request = vi.fn(async (value: { method: string; params: Record<string, unknown> }) =>
      value.method === 'tools/call' ? { task: TASK }
        : value.method === 'tasks/result' ? { content: [{ type: 'text', text: 'done' }] }
          : TASK);
    const protocol = new McpSdkTaskProtocol({ request } as never, 'server:identity');
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
    for (const [rpc] of request.mock.calls) {
      const meta = rpc.params._meta;
      expect(meta).toEqual({
        traceparent: `00-${trace.traceId}-${trace.spanId}-01`,
        tracestate: 'vendor=value',
      });
      expect(JSON.stringify(meta)).not.toMatch(/authorization|secret|sensitive|query/i);
    }
  });
});
