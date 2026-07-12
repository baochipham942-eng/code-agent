import type { PendingOperation } from '../../../shared/contract/durableRun';
import {
  type McpDurableTaskController,
  type McpTaskCapability,
} from '../../mcp/mcpDurableTask';
import type { GraphCheckpoint, GraphJsonValue, GraphNode, GraphNodeResult } from '../graphTypes';
import type { GraphExecutorContext, GraphExecutorPort } from '../graphExecutorPort';

export interface McpTaskGraphInput {
  durableTask: true;
  operationId: string;
  serverIdentity: string;
  serverName: string;
  toolName: string;
  args: Record<string, GraphJsonValue>;
  sideEffect: boolean;
}

export interface McpTaskGraphBinding {
  controller: McpDurableTaskController;
  capability: McpTaskCapability;
  operation?: PendingOperation;
}

export interface McpTaskExecutorOptions {
  id?: string;
  resolve(node: GraphNode, context: GraphExecutorContext): McpTaskGraphBinding;
  now?: () => number;
}

/** Durable MCP tasks only. Synchronous tools remain in ToolExecutor. */
export class McpTaskExecutor implements GraphExecutorPort {
  readonly id: string;
  private readonly active = new Map<string, { binding: McpTaskGraphBinding; operation: PendingOperation; input: McpTaskGraphInput }>();

  constructor(private readonly options: McpTaskExecutorOptions) {
    this.id = options.id ?? 'mcp_durable_task';
  }

  canExecute(node: GraphNode): boolean {
    if (node.executorRef !== this.id && node.kind !== 'mcp_durable_task') return false;
    try { return parseMcpTaskGraphInput(node.input).durableTask === true; } catch { return false; }
  }

  async execute(node: GraphNode, context: GraphExecutorContext): Promise<GraphNodeResult> {
    const input = parseMcpTaskGraphInput(node.input);
    const binding = this.options.resolve(node, context);
    if (binding.capability.toolTaskSupport === 'forbidden' || !binding.capability.serverToolsCall) {
      return { status: 'failed', error: 'MCP tool is synchronous and must use ToolExecutor', retryable: false, sideEffectState: 'not_dispatched' };
    }
    const created = await binding.controller.createMcpTask({
      runId: context.runId,
      operationId: input.operationId,
      attempt: context.attempt,
      serverIdentity: input.serverIdentity,
      serverName: input.serverName,
      toolName: input.toolName,
      args: input.args,
      sideEffect: input.sideEffect,
      capability: binding.capability,
      now: this.now(),
      signal: context.signal,
    });
    if (created.mode === 'synchronous') {
      return { status: 'failed', error: created.reason, retryable: false, sideEffectState: 'not_dispatched' };
    }
    let operation = created.operation;
    if (created.task.status === 'completed') {
      operation = await binding.controller.resolveMcpTaskResult(this.bound(input, binding, operation, context));
      return this.terminalResult(binding, operation);
    }
    this.active.set(this.key(context, node), { binding, operation, input });
    return {
      status: created.task.status === 'input_required' ? 'requires_review' : 'waiting',
      checkpoint: toJson({ version: 1, operation }),
      sideEffectState: 'dispatched',
      metadata: { providerOperationId: operation.providerOperationId ?? null },
    };
  }

  async recover(node: GraphNode, _checkpoint: GraphCheckpoint, context: GraphExecutorContext): Promise<GraphNodeResult> {
    const input = parseMcpTaskGraphInput(node.input);
    const binding = this.options.resolve(node, context);
    const operation = binding.operation ?? readOperation(context, node.nodeId);
    if (!operation) return { status: 'requires_review', error: 'MCP recovery has no durable task handle', sideEffectState: 'unknown' };
    if (operation.runId !== context.runId || operation.operationId !== input.operationId) {
      return { status: 'requires_review', error: 'MCP task handle is stale for Graph node', sideEffectState: 'unknown' };
    }
    if (operation.status === 'succeeded' && operation.resultRef) return this.terminalResult(binding, operation);
    if (operation.status === 'unknown' || !operation.providerOperationId) {
      return { status: 'requires_review', error: 'MCP side effect is uncertain', checkpoint: toJson({ version: 1, operation }), sideEffectState: 'unknown' };
    }
    const updated = await binding.controller.updateMcpTask({ ...this.bound(input, binding, operation, context), now: this.now() });
    if (updated.status === 'succeeded') return this.terminalResult(binding, updated);
    if (updated.status === 'waiting') {
      this.active.set(this.key(context, node), { binding, operation: updated, input });
      return { status: 'waiting', checkpoint: toJson({ version: 1, operation: updated }), sideEffectState: 'dispatched' };
    }
    return { status: 'requires_review', checkpoint: toJson({ version: 1, operation: updated }), sideEffectState: 'unknown' };
  }

  async cancel(node: GraphNode, context: GraphExecutorContext): Promise<void> {
    const active = this.active.get(this.key(context, node));
    if (!active) return;
    await active.binding.controller.cancelMcpTask({
      ...this.bound(active.input, active.binding, active.operation, context),
      now: this.now(),
    });
  }

  private async terminalResult(binding: McpTaskGraphBinding, operation: PendingOperation): Promise<GraphNodeResult> {
    const result = await binding.controller.loadMcpTaskResult(operation);
    return { status: 'completed', output: toJson(result), checkpoint: toJson({ version: 1, operation }), sideEffectState: 'confirmed' };
  }

  private bound(input: McpTaskGraphInput, binding: McpTaskGraphBinding, operation: PendingOperation, context: GraphExecutorContext) {
    return {
      operation,
      runId: context.runId,
      operationId: input.operationId,
      serverIdentity: input.serverIdentity,
      capability: binding.capability,
      signal: context.signal,
      now: this.now(),
    };
  }

  private now(): number { return this.options.now?.() ?? Date.now(); }
  private key(context: GraphExecutorContext, node: GraphNode): string { return `${context.runId}:${node.nodeId}`; }
}

function parseMcpTaskGraphInput(value: GraphJsonValue): McpTaskGraphInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('MCP task graph input must be an object');
  const input = value as unknown as McpTaskGraphInput;
  if (input.durableTask !== true || !input.operationId || !input.serverIdentity || !input.serverName || !input.toolName || !input.args || Array.isArray(input.args)) {
    throw new Error('MCP durable task graph input is incomplete');
  }
  return structuredClone(input);
}

function readOperation(context: GraphExecutorContext, nodeId: string): PendingOperation | undefined {
  const value = context.checkpoint?.nodes.find((candidate) => candidate.nodeId === nodeId)?.result?.checkpoint;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const operation = (value as unknown as { operation?: PendingOperation }).operation;
  return operation;
}

function toJson(value: unknown): GraphJsonValue { return JSON.parse(JSON.stringify(value)) as GraphJsonValue; }
