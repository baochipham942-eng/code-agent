import { createHash } from 'node:crypto';
import type { ChildRunRef, PendingOperation, RunOwnerLease } from '../../shared/contract/durableRun';
import type { RunKernelAdapter } from '../runtime/durableRunKernel';
import type { RunRehydrationPlan } from '../runtime/durableRunStores';
import { getTelemetryService } from '../telemetry/telemetryService';

export type McpToolTaskSupport = 'optional' | 'required' | 'forbidden';
export type McpTaskStatus = 'working' | 'input_required' | 'completed' | 'failed' | 'cancelled';

export interface McpTaskCapability {
  /** Stable hash-bound identity. It must not contain headers, tokens, or raw credentials. */
  serverIdentity: string;
  /** Local allowlist decision. Server declarations cannot set this bit. */
  trusted: boolean;
  serverToolsCall: boolean;
  query: boolean;
  cancel: boolean;
  toolTaskSupport?: McpToolTaskSupport;
}

export interface McpTaskSnapshot {
  taskId: string;
  status: McpTaskStatus;
  ttl: number | null;
  createdAt: string;
  lastUpdatedAt: string;
  pollInterval?: number;
  statusMessage?: string;
}

export interface McpTaskProtocol {
  createTask(input: {
    serverIdentity: string;
    serverName: string;
    toolName: string;
    args: Record<string, unknown>;
    traceMeta?: Record<string, string>;
    signal?: AbortSignal;
  }): Promise<McpTaskSnapshot>;
  getTask(input: {
    serverIdentity: string;
    taskId: string;
    traceMeta?: Record<string, string>;
    signal?: AbortSignal;
  }): Promise<McpTaskSnapshot>;
  cancelTask(input: {
    serverIdentity: string;
    taskId: string;
    traceMeta?: Record<string, string>;
    signal?: AbortSignal;
  }): Promise<McpTaskSnapshot>;
  resolveTaskResult(input: {
    serverIdentity: string;
    taskId: string;
    traceMeta?: Record<string, string>;
    signal?: AbortSignal;
  }): Promise<unknown>;
}

export interface McpTaskResultStore {
  save(input: {
    runId: string;
    operationId: string;
    serverIdentity: string;
    taskId: string;
    result: unknown;
  }): Promise<string>;
  load(resultRef: string): Promise<unknown | null>;
}

export interface McpDurableCheckpointInput {
  operation: PendingOperation;
  runStatus: 'running' | 'waiting';
  event: {
    type: 'mcp_task_prepared' | 'mcp_task_waiting' | 'mcp_task_updated'
      | 'mcp_task_cancelled' | 'mcp_task_terminal' | 'mcp_task_requires_review';
    /** Metadata only. Raw arguments, task result, and authorization material are forbidden. */
    payload: Record<string, string | number | boolean | undefined>;
  };
  now: number;
}

export interface McpDurableCheckpointPort {
  commit(input: McpDurableCheckpointInput): Promise<void>;
}

export interface McpKernelCheckpointPort extends McpDurableCheckpointPort {
  getPendingOperations(): PendingOperation[];
}

interface McpBoundTaskHandle {
  version: 1;
  taskId: string;
  runId: string;
  operationId: string;
  serverIdentity: string;
  cancelRequested?: true;
}

export type McpTaskCreateResult =
  | { mode: 'synchronous'; reason: string }
  | { mode: 'task'; operation: PendingOperation; task: McpTaskSnapshot };

export interface McpTaskRecoveryDecision {
  action: 'reuse_result' | 'query' | 'observe' | 'requires_review' | 'ignore';
  retry: false;
  reason: string;
  operation: PendingOperation;
  /** Runtime display payload loaded through resultRef; never written into a checkpoint or span. */
  result?: unknown;
}

const TERMINAL_OPERATION_STATUSES = new Set(['succeeded', 'failed', 'abandoned']);
const HANDLE_PREFIX = 'mcp-task:v1:';

/** Adapts the frozen RunKernelAdapter checkpoint boundary without inventing an MCP store. */
export function createMcpKernelCheckpointPort(input: {
  kernel: RunKernelAdapter;
  runId: string;
  attempt: number;
  owner: RunOwnerLease;
  initialPendingOperations?: PendingOperation[];
  childRuns?: ChildRunRef[];
  getState: () => unknown;
  getEngineCursor?: () => unknown;
}): McpKernelCheckpointPort {
  let pendingOperations = [...(input.initialPendingOperations ?? [])];
  return {
    getPendingOperations: () => [...pendingOperations],
    commit: async (checkpointInput) => {
      if (checkpointInput.operation.runId !== input.runId) {
        throw new Error('MCP checkpoint operation runId mismatch');
      }
      const next = pendingOperations.filter((operation) =>
        operation.operationId !== checkpointInput.operation.operationId);
      next.push(checkpointInput.operation);
      await input.kernel.checkpoint({
        runId: input.runId,
        attempt: input.attempt,
        owner: input.owner,
        now: checkpointInput.now,
        status: checkpointInput.runStatus,
        state: input.getState(),
        engineCursor: input.getEngineCursor?.(),
        pendingOperations: next,
        childRuns: input.childRuns,
        events: [{
          type: checkpointInput.event.type,
          payload: checkpointInput.event.payload,
          recordedAt: checkpointInput.now,
        }],
      });
      pendingOperations = next;
    },
  };
}

export class McpDurableTaskController {
  private readonly kernel: RunKernelAdapter;
  private readonly checkpoint: McpDurableCheckpointPort;
  private readonly protocol: McpTaskProtocol;
  private readonly resultStore: McpTaskResultStore;

  constructor(input: {
    kernel: RunKernelAdapter;
    checkpoint: McpDurableCheckpointPort;
    protocol: McpTaskProtocol;
    resultStore: McpTaskResultStore;
  }) {
    this.kernel = input.kernel;
    this.checkpoint = input.checkpoint;
    this.protocol = input.protocol;
    this.resultStore = input.resultStore;
  }

  async createMcpTask(input: {
    runId: string;
    operationId: string;
    attempt: number;
    serverIdentity: string;
    serverName: string;
    toolName: string;
    args: Record<string, unknown>;
    sideEffect: boolean;
    capability: McpTaskCapability;
    now: number;
    signal?: AbortSignal;
  }): Promise<McpTaskCreateResult> {
    const admission = assessMcpTaskAdmission(input.capability, input.serverIdentity);
    if (!admission.allowed) return { mode: 'synchronous', reason: admission.reason };

    return withMcpTaskSpan('create', input.serverIdentity, input.operationId, async () => {
      const operation = this.kernel.prepareOperation({
        runId: input.runId,
        operationId: input.operationId,
        logicalOperationId: `mcp:${input.serverIdentity}:${input.toolName}:${input.operationId}`,
        attempt: input.attempt,
        kind: 'tool_call',
        sideEffect: input.sideEffect,
        // MCP creates the lookup handle only after dispatch. A crash in between is uncertain.
        canDeduplicate: false,
        now: input.now,
        inputDigest: digestValue(input.args),
      });
      await this.checkpoint.commit({
        operation,
        runStatus: 'running',
        event: {
          type: 'mcp_task_prepared',
          payload: safeEventPayload(input, operation, 'prepared'),
        },
        now: input.now,
      });

      try {
        const task = await this.protocol.createTask({
          serverIdentity: input.serverIdentity,
          serverName: input.serverName,
          toolName: input.toolName,
          args: input.args,
          signal: input.signal,
        });
        const handle = encodeHandle({
          version: 1,
          taskId: task.taskId,
          runId: input.runId,
          operationId: input.operationId,
          serverIdentity: input.serverIdentity,
        });
        const waiting: PendingOperation = {
          ...operation,
          status: 'waiting',
          providerOperationId: handle,
          // A persisted queryable handle resolves the uncertainty without blind replay.
          requiresHumanConfirmation: task.status === 'input_required',
          updatedAt: input.now,
        };
        await this.checkpoint.commit({
          operation: waiting,
          runStatus: 'waiting',
          event: {
            type: 'mcp_task_waiting',
            payload: safeEventPayload(input, waiting, task.status),
          },
          now: input.now,
        });
        return { mode: 'task', operation: waiting, task };
      } catch (error) {
        const uncertain: PendingOperation = {
          ...operation,
          status: 'unknown',
          requiresHumanConfirmation: true,
          updatedAt: input.now,
        };
        await this.checkpoint.commit({
          operation: uncertain,
          runStatus: 'waiting',
          event: {
            type: 'mcp_task_requires_review',
            payload: safeEventPayload(input, uncertain, 'dispatch_unknown'),
          },
          now: input.now,
        });
        throw error;
      }
    });
  }

  async getMcpTask(input: BoundOperationInput): Promise<McpTaskSnapshot> {
    return withMcpTaskSpan('get', input.serverIdentity, input.operationId, async () => {
      const handle = assertBoundHandle(input);
      if (!input.capability.trusted || !input.capability.query) {
        throw new Error('MCP task query is not trusted or supported');
      }
      const task = await this.protocol.getTask({
        serverIdentity: input.serverIdentity,
        taskId: handle.taskId,
        signal: input.signal,
      });
      if (task.taskId !== handle.taskId) throw new Error('MCP task response has a stale task binding');
      return task;
    });
  }

  async updateMcpTask(input: BoundOperationInput & { now: number }): Promise<PendingOperation> {
    if (TERMINAL_OPERATION_STATUSES.has(input.operation.status)) return input.operation;
    return withMcpTaskSpan('update', input.serverIdentity, input.operationId, async () => {
      const task = await this.getMcpTask(input);
      if (task.status === 'completed') return this.resolveMcpTaskResult({ ...input, now: input.now });

      const nextStatus = task.status === 'failed' || task.status === 'cancelled' ? 'failed' : 'waiting';
      const updated = convergeOperation(input.operation, {
        status: nextStatus,
        requiresHumanConfirmation: task.status === 'input_required',
        now: input.now,
      });
      await this.checkpoint.commit({
        operation: updated,
        runStatus: nextStatus === 'waiting' ? 'waiting' : 'running',
        event: {
          type: nextStatus === 'failed' ? 'mcp_task_terminal' : 'mcp_task_updated',
          payload: safeBoundEventPayload(input, updated, task.status),
        },
        now: input.now,
      });
      return updated;
    });
  }

  async cancelMcpTask(input: BoundOperationInput & { now: number }): Promise<PendingOperation> {
    if (TERMINAL_OPERATION_STATUSES.has(input.operation.status)) return input.operation;
    return withMcpTaskSpan('cancel', input.serverIdentity, input.operationId, async () => {
      const handle = assertBoundHandle(input);
      if (handle.cancelRequested) return input.operation;
      if (!input.capability.trusted || !input.capability.cancel) {
        throw new Error('MCP task cancellation is not trusted or supported');
      }
      const cancelHandle = encodeHandle({ ...handle, cancelRequested: true });
      try {
        const task = await this.protocol.cancelTask({
          serverIdentity: input.serverIdentity,
          taskId: handle.taskId,
          signal: input.signal,
        });
        if (task.taskId !== handle.taskId) throw new Error('MCP cancel response has a stale task binding');
        const cancelled = convergeOperation(input.operation, {
          status: task.status === 'failed' || task.status === 'cancelled' ? 'failed' : 'waiting',
          providerOperationId: cancelHandle,
          now: input.now,
        });
        await this.checkpoint.commit({
          operation: cancelled,
          runStatus: cancelled.status === 'waiting' ? 'waiting' : 'running',
          event: {
            type: 'mcp_task_cancelled',
            payload: safeBoundEventPayload(input, cancelled, task.status),
          },
          now: input.now,
        });
        return cancelled;
      } catch (error) {
        const unknown = convergeOperation(input.operation, {
          status: 'unknown',
          providerOperationId: cancelHandle,
          requiresHumanConfirmation: true,
          now: input.now,
        });
        await this.checkpoint.commit({
          operation: unknown,
          runStatus: 'waiting',
          event: {
            type: 'mcp_task_requires_review',
            payload: safeBoundEventPayload(input, unknown, 'cancel_unknown'),
          },
          now: input.now,
        });
        throw error;
      }
    });
  }

  async resolveMcpTaskResult(input: BoundOperationInput & { now: number }): Promise<PendingOperation> {
    if (input.operation.status === 'succeeded' && input.operation.resultRef) return input.operation;
    return withMcpTaskSpan('resolve', input.serverIdentity, input.operationId, async () => {
      const handle = assertBoundHandle(input);
      const result = await this.protocol.resolveTaskResult({
        serverIdentity: input.serverIdentity,
        taskId: handle.taskId,
        signal: input.signal,
      });
      const resultRef = await this.resultStore.save({
        runId: input.runId,
        operationId: input.operationId,
        serverIdentity: input.serverIdentity,
        taskId: handle.taskId,
        result,
      });
      if (!resultRef.trim()) throw new Error('MCP task result store returned an empty resultRef');
      const succeeded = convergeOperation(input.operation, {
        status: 'succeeded',
        resultRef,
        requiresHumanConfirmation: false,
        now: input.now,
      });
      await this.checkpoint.commit({
        operation: succeeded,
        runStatus: 'running',
        event: {
          type: 'mcp_task_terminal',
          payload: safeBoundEventPayload(input, succeeded, 'completed'),
        },
        now: input.now,
      });
      return succeeded;
    });
  }

  async loadMcpTaskResult(operation: PendingOperation): Promise<unknown> {
    if (operation.status !== 'succeeded' || !operation.resultRef) {
      throw new Error('MCP task has no terminal result reference');
    }
    const result = await this.resultStore.load(operation.resultRef);
    if (result === null) throw new Error('MCP task result reference is stale or unavailable');
    return result;
  }

  async failForReview(input: {
    operation: PendingOperation;
    now: number;
    reason: string;
  }): Promise<PendingOperation> {
    const failed = convergeOperation(input.operation, {
      status: 'failed', requiresHumanConfirmation: true, now: input.now,
    });
    await this.checkpoint.commit({
      operation: failed,
      runStatus: 'waiting',
      event: {
        type: 'mcp_task_requires_review',
        payload: {
          operationId: failed.operationId,
          status: failed.status,
          reason: input.reason,
        },
      },
      now: input.now,
    });
    return failed;
  }
}

interface BoundOperationInput {
  operation: PendingOperation;
  runId: string;
  operationId: string;
  serverIdentity: string;
  capability: McpTaskCapability;
  signal?: AbortSignal;
}

export function buildMcpTaskRecoveryDecision(
  plan: RunRehydrationPlan,
  operation: PendingOperation,
  resolveCapability: (serverIdentity: string) => McpTaskCapability | undefined,
): McpTaskRecoveryDecision {
  if (operation.kind !== 'tool_call') {
    return { action: 'ignore', retry: false, reason: 'not an MCP tool operation', operation };
  }
  if (operation.status === 'succeeded' && operation.resultRef) {
    return { action: 'reuse_result', retry: false, reason: 'terminal result is already durable', operation };
  }
  if (operation.status === 'failed' || operation.status === 'abandoned') {
    return { action: 'ignore', retry: false, reason: 'operation is terminal', operation };
  }
  if (!operation.providerOperationId) {
    return {
      action: 'requires_review', retry: false,
      reason: operation.sideEffect
        ? 'side-effect dispatch is uncertain and cannot be queried'
        : 'dispatch is uncertain and has no queryable task handle',
      operation,
    };
  }
  let handle: McpBoundTaskHandle;
  try {
    handle = decodeHandle(operation.providerOperationId);
  } catch {
    return { action: 'requires_review', retry: false, reason: 'task handle is invalid', operation };
  }
  if (handle.runId !== plan.envelope.runId || handle.operationId !== operation.operationId) {
    return { action: 'requires_review', retry: false, reason: 'task handle is stale for this run', operation };
  }
  const capability = resolveCapability(handle.serverIdentity);
  if (!capability?.trusted || !capability.query || capability.serverIdentity !== handle.serverIdentity) {
    return { action: 'requires_review', retry: false, reason: 'task server cannot be queried safely', operation };
  }
  return { action: 'query', retry: false, reason: 'query the existing provider task handle', operation };
}

export function createMcpTaskRecoveryHandler(
  controller: McpDurableTaskController,
  routing: {
    resolveCapability: (serverIdentity: string) => McpTaskCapability | undefined;
    /** Required because MCP deliberately shares kind=tool_call with every other provider. */
    isMcpOperation: (operation: PendingOperation) => boolean;
  },
): (plan: RunRehydrationPlan, now: number) => Promise<McpTaskRecoveryDecision[]> {
  return async (plan, now) => {
    const results: McpTaskRecoveryDecision[] = [];
    for (const operation of plan.pendingOperations) {
      if (!routing.isMcpOperation(operation)) continue;
      let decision = buildMcpTaskRecoveryDecision(plan, operation, routing.resolveCapability);
      if (decision.action === 'reuse_result' || decision.action === 'ignore') {
        if (decision.action === 'reuse_result') {
          try {
            decision = { ...decision, result: await controller.loadMcpTaskResult(operation) };
          } catch {
            const failed = await controller.failForReview({
              operation, now, reason: 'terminal MCP task result is unavailable',
            });
            decision = {
              action: 'requires_review', retry: false,
              reason: 'terminal MCP task result is unavailable', operation: failed,
            };
          }
        }
        results.push(decision);
        continue;
      }
      if (decision.action === 'requires_review') {
        const failed = await controller.failForReview({ operation, now, reason: decision.reason });
        results.push({ ...decision, operation: failed });
        continue;
      }
      const handle = decodeHandle(operation.providerOperationId!);
      const capability = routing.resolveCapability(handle.serverIdentity)!;
      try {
        const updated = await controller.updateMcpTask({
          operation,
          runId: plan.envelope.runId,
          operationId: operation.operationId,
          serverIdentity: handle.serverIdentity,
          capability,
          now,
        });
        decision = {
          action: updated.status === 'succeeded' ? 'reuse_result'
            : updated.status === 'waiting' ? 'observe' : 'requires_review',
          retry: false,
          reason: updated.status === 'waiting'
            ? 'provider task remains active'
            : 'provider task converged to a terminal state',
          operation: updated,
        };
        if (decision.action === 'reuse_result') {
          decision = { ...decision, result: await controller.loadMcpTaskResult(updated) };
        }
      } catch {
        // Transport loss preserves the queryable waiting/unknown fact. It never becomes a retry.
        decision = { ...decision, action: 'observe', reason: 'task query transport is unavailable' };
      }
      results.push(decision);
    }
    return results;
  };
}

export function digestMcpArguments(args: Record<string, unknown>): string {
  return digestValue(args);
}

function assessMcpTaskAdmission(
  capability: McpTaskCapability,
  serverIdentity: string,
): { allowed: boolean; reason: string } {
  if (capability.serverIdentity !== serverIdentity) return { allowed: false, reason: 'server identity mismatch' };
  if (!capability.trusted) return { allowed: false, reason: 'server is not in the durable-task trust allowlist' };
  if (!capability.serverToolsCall) return { allowed: false, reason: 'server did not declare tasks.requests.tools.call' };
  if (!capability.query) return { allowed: false, reason: 'server task results are not queryable' };
  if (!capability.toolTaskSupport || capability.toolTaskSupport === 'forbidden') {
    return { allowed: false, reason: 'tool did not declare task-augmented execution' };
  }
  return { allowed: true, reason: 'trusted task capability' };
}

function assertBoundHandle(input: BoundOperationInput): McpBoundTaskHandle {
  if (input.operation.runId !== input.runId || input.operation.operationId !== input.operationId) {
    throw new Error('MCP task operation has a stale run binding');
  }
  if (!input.operation.providerOperationId) throw new Error('MCP task operation has no provider handle');
  const handle = decodeHandle(input.operation.providerOperationId);
  if (
    handle.runId !== input.runId
    || handle.operationId !== input.operationId
    || handle.serverIdentity !== input.serverIdentity
    || input.capability.serverIdentity !== input.serverIdentity
  ) {
    throw new Error('MCP task handle binding is stale or mismatched');
  }
  return handle;
}

function encodeHandle(handle: McpBoundTaskHandle): string {
  const payload = Buffer.from(stableStringify(handle), 'utf8').toString('base64url');
  const checksum = createHash('sha256').update(`${HANDLE_PREFIX}${payload}`).digest('hex').slice(0, 32);
  return `${HANDLE_PREFIX}${payload}.${checksum}`;
}

function decodeHandle(value: string): McpBoundTaskHandle {
  if (!value.startsWith(HANDLE_PREFIX)) throw new Error('Invalid MCP task handle prefix');
  const encoded = value.slice(HANDLE_PREFIX.length);
  const [payload, checksum, extra] = encoded.split('.');
  if (!payload || !checksum || extra) throw new Error('Invalid MCP task handle encoding');
  const expected = createHash('sha256').update(`${HANDLE_PREFIX}${payload}`).digest('hex').slice(0, 32);
  if (checksum !== expected) throw new Error('Invalid MCP task handle checksum');
  const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Partial<McpBoundTaskHandle>;
  if (
    parsed.version !== 1 || !parsed.taskId || !parsed.runId
    || !parsed.operationId || !parsed.serverIdentity
  ) throw new Error('Invalid MCP task handle binding');
  return parsed as McpBoundTaskHandle;
}

function convergeOperation(
  operation: PendingOperation,
  update: {
    status: PendingOperation['status'];
    now: number;
    providerOperationId?: string;
    resultRef?: string;
    requiresHumanConfirmation?: boolean;
  },
): PendingOperation {
  if (TERMINAL_OPERATION_STATUSES.has(operation.status)) return operation;
  const allowed: Record<string, Set<string>> = {
    prepared: new Set(['dispatched', 'waiting', 'unknown', 'succeeded', 'failed']),
    dispatched: new Set(['waiting', 'unknown', 'succeeded', 'failed']),
    waiting: new Set(['waiting', 'unknown', 'succeeded', 'failed']),
    unknown: new Set(['unknown', 'waiting', 'succeeded', 'failed']),
  };
  if (!allowed[operation.status]?.has(update.status)) {
    throw new Error(`MCP task status cannot regress from ${operation.status} to ${update.status}`);
  }
  return {
    ...operation,
    status: update.status,
    updatedAt: update.now,
    ...(update.providerOperationId ? { providerOperationId: update.providerOperationId } : {}),
    ...(update.resultRef ? { resultRef: update.resultRef } : {}),
    ...(update.requiresHumanConfirmation !== undefined
      ? { requiresHumanConfirmation: update.requiresHumanConfirmation }
      : {}),
  };
}

function safeEventPayload(
  input: { operationId: string; serverIdentity: string; toolName: string },
  operation: PendingOperation,
  providerStatus: string,
): Record<string, string | boolean> {
  return {
    operationId: input.operationId,
    serverIdentity: input.serverIdentity,
    toolName: input.toolName,
    status: operation.status,
    providerStatus,
    inputDigest: operation.inputDigest ?? '',
  };
}

function safeBoundEventPayload(
  input: BoundOperationInput,
  operation: PendingOperation,
  providerStatus: string,
): Record<string, string | boolean> {
  return {
    operationId: input.operationId,
    serverIdentity: input.serverIdentity,
    status: operation.status,
    providerStatus,
    taskHandleDigest: digestValue(operation.providerOperationId ?? ''),
  };
}

function stableStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)]));
  }
  return value;
}

function digestValue(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

async function withMcpTaskSpan<T>(
  action: 'create' | 'get' | 'update' | 'cancel' | 'resolve',
  serverIdentity: string,
  operationId: string,
  callback: () => Promise<T>,
): Promise<T> {
  let spanId: string | undefined;
  try {
    spanId = getTelemetryService().startSpan(`mcp task ${action}`, 'mcp', {
      'mcp.task.operation': action,
      'mcp.server_identity': serverIdentity,
      'mcp.operation_id_digest': digestValue(operationId).slice(0, 24),
    }).spanId;
  } catch {
    // Task state is independent from local trace storage.
  }
  try {
    const result = await callback();
    if (spanId) getTelemetryService().endSpan(spanId, 'ok');
    return result;
  } catch (error) {
    if (spanId) getTelemetryService().endSpan(spanId, 'error');
    throw error;
  }
}
