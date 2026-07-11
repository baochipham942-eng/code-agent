import {
  CallToolResultSchema,
  CancelTaskResultSchema,
  CreateTaskResultSchema,
  GetTaskResultSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { McpTaskProtocol, McpTaskSnapshot } from './mcpDurableTask';
import {
  getActiveRunTraceContext,
  serializeRunTraceContext,
} from '../telemetry/runTraceContext';

function activeTraceMeta(): Record<string, string> | undefined {
  const active = getActiveRunTraceContext();
  if (!active) return undefined;
  const serialized = serializeRunTraceContext(active);
  return {
    traceparent: serialized.traceparent,
    ...(serialized.tracestate ? { tracestate: serialized.tracestate } : {}),
  };
}

/** SDK 1.29 protocol adapter. It intentionally uses the public request API so
 * W3C metadata is propagated on create/get/result/cancel, not only tools/call. */
export class McpSdkTaskProtocol implements McpTaskProtocol {
  constructor(
    private readonly client: Client,
    private readonly boundServerIdentity: string,
  ) {}

  async createTask(input: Parameters<McpTaskProtocol['createTask']>[0]): Promise<McpTaskSnapshot> {
    this.assertServer(input.serverIdentity);
    const result = await this.client.request({
      method: 'tools/call',
      params: {
        name: input.toolName,
        arguments: input.args,
        _meta: input.traceMeta ?? activeTraceMeta(),
      },
    }, CreateTaskResultSchema, { task: {}, signal: input.signal });
    return result.task;
  }

  async getTask(input: Parameters<McpTaskProtocol['getTask']>[0]): Promise<McpTaskSnapshot> {
    this.assertServer(input.serverIdentity);
    return this.client.request({
      method: 'tasks/get',
      params: { taskId: input.taskId, _meta: input.traceMeta ?? activeTraceMeta() },
    }, GetTaskResultSchema, { signal: input.signal });
  }

  async cancelTask(input: Parameters<McpTaskProtocol['cancelTask']>[0]): Promise<McpTaskSnapshot> {
    this.assertServer(input.serverIdentity);
    return this.client.request({
      method: 'tasks/cancel',
      params: { taskId: input.taskId, _meta: input.traceMeta ?? activeTraceMeta() },
    }, CancelTaskResultSchema, { signal: input.signal });
  }

  async resolveTaskResult(input: Parameters<McpTaskProtocol['resolveTaskResult']>[0]): Promise<unknown> {
    this.assertServer(input.serverIdentity);
    return this.client.request({
      method: 'tasks/result',
      params: { taskId: input.taskId, _meta: input.traceMeta ?? activeTraceMeta() },
    }, CallToolResultSchema, { signal: input.signal });
  }

  private assertServer(serverIdentity: string): void {
    if (serverIdentity !== this.boundServerIdentity) {
      throw new Error('MCP task protocol server identity mismatch');
    }
  }
}
