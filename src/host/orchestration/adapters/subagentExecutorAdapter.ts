import type { SubagentExecutorPort } from '../../agent/subagentExecutorPort';
import type {
  SubagentConfig,
  SubagentExecutionContext,
  SubagentResult,
} from '../../agent/subagentExecutorTypes';
import type { GraphExecutorContext, GraphExecutorPort } from '../graphExecutorPort';
import type { GraphJsonValue, GraphNode, GraphNodeResult } from '../graphTypes';

export interface SubagentGraphNodeInput {
  prompt: string;
  config: SubagentConfig;
}

export interface SubagentExecutorAdapterOptions {
  id?: string;
  contextFactory(node: GraphNode, context: GraphExecutorContext): SubagentExecutionContext;
  cancelTarget?(node: GraphNode, context: GraphExecutorContext): void | Promise<void>;
}

/** Protocol-native Graph adapter. It never reconstructs legacy ToolContext. */
export class SubagentExecutorAdapter implements GraphExecutorPort {
  readonly id: string;

  constructor(
    private readonly executor: SubagentExecutorPort,
    private readonly options: SubagentExecutorAdapterOptions,
  ) {
    this.id = options.id ?? 'subagent';
  }

  canExecute(node: GraphNode): boolean {
    return node.executorRef === this.id || node.kind === 'subagent';
  }

  async execute(node: GraphNode, context: GraphExecutorContext): Promise<GraphNodeResult> {
    const input = parseSubagentInput(node.input);
    const executionContext = this.options.contextFactory(node, context);
    if (executionContext.sessionId !== context.sessionId) {
      throw new Error(`Subagent session identity mismatch for node ${node.nodeId}`);
    }
    if (executionContext.runId && executionContext.runId !== context.runId) {
      throw new Error(`Subagent run identity mismatch for node ${node.nodeId}`);
    }
    if (executionContext.abortSignal !== context.signal) {
      throw new Error(`Subagent cancel signal must be bound to Graph node ${node.nodeId}`);
    }
    const result = await this.executor.execute({
      prompt: input.prompt,
      config: input.config,
      context: executionContext,
    });
    return subagentResultToGraphResult(result);
  }

  async cancel(node: GraphNode, context: GraphExecutorContext): Promise<void> {
    await this.options.cancelTarget?.(node, context);
  }
}

export function createSubagentGraphNodeInput(input: SubagentGraphNodeInput): GraphJsonValue {
  return structuredClone(input) as unknown as GraphJsonValue;
}

export function parseSubagentInput(value: GraphJsonValue): SubagentGraphNodeInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Subagent graph node input must be an object');
  }
  const candidate = value as unknown as Partial<SubagentGraphNodeInput>;
  if (typeof candidate.prompt !== 'string' || !candidate.config || typeof candidate.config !== 'object') {
    throw new Error('Subagent graph node input is incomplete');
  }
  if (typeof candidate.config.name !== 'string' || typeof candidate.config.systemPrompt !== 'string') {
    throw new Error('Subagent graph node config is incomplete');
  }
  if (!Array.isArray(candidate.config.availableTools)) {
    throw new Error('Subagent graph node availableTools must be an array');
  }
  return structuredClone(candidate as SubagentGraphNodeInput);
}

function subagentResultToGraphResult(result: SubagentResult): GraphNodeResult {
  const output = {
    success: result.success,
    output: result.output,
    toolsUsed: [...result.toolsUsed],
    iterations: result.iterations,
    ...(result.error ? { error: result.error } : {}),
    ...(typeof result.cost === 'number' ? { cost: result.cost } : {}),
    ...(typeof result.tokensUsed === 'number' ? { tokensUsed: result.tokensUsed } : {}),
    ...(result.cancellationReason ? { cancellationReason: result.cancellationReason } : {}),
    ...(result.failureCode ? { failureCode: result.failureCode } : {}),
  } as GraphJsonValue;
  if (result.cancellationReason) {
    return { status: 'cancelled', output, error: result.error, sideEffectState: 'confirmed' };
  }
  return {
    status: result.success ? 'completed' : 'failed',
    output,
    error: result.error,
    retryable: false,
    sideEffectState: 'confirmed',
  };
}
