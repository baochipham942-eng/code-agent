import { SdkErrorCode } from '@modelcontextprotocol/client';
import type { Client, Request } from '@modelcontextprotocol/client';
import { z } from 'zod';
import type { McpTaskProtocol, McpTaskSnapshot } from './mcpDurableTask';
import { MCPTaskUnavailableError } from './mcpErrors';
import { createLogger } from '../services/infra/logger';
import {
  getActiveRunTraceContext,
  serializeRunTraceContext,
} from '../telemetry/runTraceContext';

const logger = createLogger('MCPTaskProtocol');
const DEFAULT_MAX_POLL_ATTEMPTS = 8;
const DEFAULT_INITIAL_POLL_DELAY_MS = 250;
const DEFAULT_MAX_POLL_DELAY_MS = 4_000;

const taskSnapshotSchema = z.object({
  taskId: z.string(),
  status: z.enum(['working', 'input_required', 'completed', 'failed', 'cancelled']),
  ttl: z.number().nullable(),
  createdAt: z.string(),
  lastUpdatedAt: z.string(),
  pollInterval: z.number().optional(),
  statusMessage: z.string().optional(),
}).passthrough();

const taskEnvelopeSchema = z.object({
  task: taskSnapshotSchema,
  result: z.unknown().optional(),
}).passthrough();

const flatTaskEnvelopeSchema = taskSnapshotSchema.extend({
  result: z.unknown().optional(),
}).transform(({ result, ...task }) => ({ task, result }));

const taskGetResultSchema = z.union([taskEnvelopeSchema, flatTaskEnvelopeSchema]);

interface McpTaskProtocolOptions {
  maxPollAttempts?: number;
  initialPollDelayMs?: number;
  maxPollDelayMs?: number;
  sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
}

function activeTraceMeta(): Record<string, string> | undefined {
  const active = getActiveRunTraceContext();
  if (!active) return undefined;
  const serialized = serializeRunTraceContext(active);
  return {
    traceparent: serialized.traceparent,
    ...(serialized.tracestate ? { tracestate: serialized.tracestate } : {}),
  };
}

function sdkErrorCode(error: unknown): unknown {
  return error && typeof error === 'object'
    ? (error as { code?: unknown }).code
    : undefined;
}

async function abortableSleep(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
      reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    const timeout = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Official tasks-extension adapter. Task handles are accepted without a per-call opt-in. */
export class McpSdkTaskProtocol implements McpTaskProtocol {
  private readonly maxPollAttempts: number;
  private readonly initialPollDelayMs: number;
  private readonly maxPollDelayMs: number;
  private readonly sleep: (delayMs: number, signal?: AbortSignal) => Promise<void>;

  constructor(
    private readonly client: Client,
    private readonly boundServerIdentity: string,
    options: McpTaskProtocolOptions = {},
  ) {
    this.maxPollAttempts = Math.max(1, options.maxPollAttempts ?? DEFAULT_MAX_POLL_ATTEMPTS);
    this.initialPollDelayMs = Math.max(0, options.initialPollDelayMs ?? DEFAULT_INITIAL_POLL_DELAY_MS);
    this.maxPollDelayMs = Math.max(
      this.initialPollDelayMs,
      options.maxPollDelayMs ?? DEFAULT_MAX_POLL_DELAY_MS,
    );
    this.sleep = options.sleep ?? abortableSleep;
  }

  async createTask(input: Parameters<McpTaskProtocol['createTask']>[0]): Promise<McpTaskSnapshot> {
    this.assertServer(input.serverIdentity);
    const request: Request = {
      method: 'tools/call',
      params: {
        name: input.toolName,
        arguments: input.args,
        _meta: input.traceMeta ?? activeTraceMeta(),
      },
    };
    const result = await this.client.request(request, taskEnvelopeSchema, { signal: input.signal });
    return result.task;
  }

  async getTask(input: Parameters<McpTaskProtocol['getTask']>[0]): Promise<McpTaskSnapshot> {
    this.assertServer(input.serverIdentity);
    return (await this.queryTask(input)).task;
  }

  async cancelTask(input: Parameters<McpTaskProtocol['cancelTask']>[0]): Promise<McpTaskSnapshot> {
    this.assertServer(input.serverIdentity);
    try {
      return (await this.client.request({
        method: 'tasks/cancel',
        params: { taskId: input.taskId, _meta: input.traceMeta ?? activeTraceMeta() },
      }, taskGetResultSchema, { signal: input.signal })).task;
    } catch (error) {
      throw this.wrapUnsupported(input.taskId, 'cancel', error);
    }
  }

  async updateTask(
    input: Parameters<NonNullable<McpTaskProtocol['updateTask']>>[0],
  ): Promise<McpTaskSnapshot> {
    this.assertServer(input.serverIdentity);
    try {
      return (await this.client.request({
        method: 'tasks/update',
        params: {
          taskId: input.taskId,
          input: input.input,
          _meta: input.traceMeta ?? activeTraceMeta(),
        },
      }, taskGetResultSchema, { signal: input.signal })).task;
    } catch (error) {
      throw this.wrapUnsupported(input.taskId, 'update', error);
    }
  }

  async resolveTaskResult(input: Parameters<McpTaskProtocol['resolveTaskResult']>[0]): Promise<unknown> {
    this.assertServer(input.serverIdentity);
    let delayMs = this.initialPollDelayMs;
    let lastTask: McpTaskSnapshot | undefined;

    for (let attempt = 1; attempt <= this.maxPollAttempts; attempt += 1) {
      const envelope = await this.queryTask(input);
      lastTask = envelope.task;
      if (envelope.task.status === 'completed' && envelope.result !== undefined) {
        return envelope.result;
      }
      if (envelope.task.status === 'failed' || envelope.task.status === 'cancelled') {
        const error = new MCPTaskUnavailableError({
          serverIdentity: this.boundServerIdentity,
          taskId: input.taskId,
          reason: 'terminal_failure',
          message: `MCP task ${input.taskId} ended with status ${envelope.task.status}`,
        });
        logger.warn('MCP task polling reached a failed terminal state', {
          serverIdentity: this.boundServerIdentity,
          taskId: input.taskId,
          status: envelope.task.status,
        });
        throw error;
      }
      if (attempt < this.maxPollAttempts) {
        const requestedDelay = envelope.task.pollInterval ?? delayMs;
        await this.sleep(Math.min(this.maxPollDelayMs, Math.max(0, requestedDelay)), input.signal);
        delayMs = Math.min(this.maxPollDelayMs, Math.max(1, delayMs * 2));
      }
    }

    const reason = lastTask?.status === 'completed' ? 'missing_result' : 'timeout';
    const error = new MCPTaskUnavailableError({
      serverIdentity: this.boundServerIdentity,
      taskId: input.taskId,
      reason,
      message: reason === 'missing_result'
        ? `MCP task ${input.taskId} completed without a result`
        : `MCP task ${input.taskId} did not reach a terminal state after ${this.maxPollAttempts} polls`,
    });
    logger.warn('MCP task polling did not converge', {
      serverIdentity: this.boundServerIdentity,
      taskId: input.taskId,
      polls: this.maxPollAttempts,
      lastStatus: lastTask?.status,
      reason,
    });
    throw error;
  }

  private async queryTask(input: {
    taskId: string;
    traceMeta?: Record<string, string>;
    signal?: AbortSignal;
  }): Promise<z.infer<typeof taskGetResultSchema>> {
    try {
      return await this.client.request({
        method: 'tasks/get',
        params: { taskId: input.taskId, _meta: input.traceMeta ?? activeTraceMeta() },
      }, taskGetResultSchema, { signal: input.signal });
    } catch (error) {
      throw this.wrapUnsupported(input.taskId, 'get', error);
    }
  }

  private wrapUnsupported(taskId: string, action: string, error: unknown): unknown {
    if (
      sdkErrorCode(error) !== SdkErrorCode.MethodNotSupportedByProtocolVersion
      && sdkErrorCode(error) !== SdkErrorCode.CapabilityNotSupported
    ) {
      return error;
    }
    logger.warn('MCP tasks extension is unavailable', {
      serverIdentity: this.boundServerIdentity,
      taskId,
      action,
      code: sdkErrorCode(error),
    });
    return new MCPTaskUnavailableError({
      serverIdentity: this.boundServerIdentity,
      taskId,
      reason: 'unsupported',
      message: `MCP tasks extension does not support tasks/${action}`,
      originalError: error,
    });
  }

  private assertServer(serverIdentity: string): void {
    if (serverIdentity !== this.boundServerIdentity) {
      throw new Error('MCP task protocol server identity mismatch');
    }
  }
}
