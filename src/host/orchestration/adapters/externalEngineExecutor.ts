import type { AgentEngineRunResult, ExternalAgentEngineKind } from '../../../shared/contract/agentEngine';
import {
  EXTERNAL_ENGINE_RESUME_CAPABILITIES,
  type ExternalEngineDurableLifecycle,
} from '../../services/agentEngine/externalEngineDurableLifecycle';
import type { GraphCheckpoint, GraphJsonValue, GraphNode, GraphNodeResult } from '../graphTypes';
import type { GraphExecutorContext, GraphExecutorPort } from '../graphExecutorPort';

export interface ExternalEngineGraphInput {
  engine: ExternalAgentEngineKind;
  externalSessionId?: string;
}

export interface ExternalEngineGraphCheckpoint {
  version: 1;
  engine: ExternalAgentEngineKind;
  externalSessionId?: string;
  runId: string;
  attempt: number;
}

export interface ExternalEngineGraphBinding {
  lifecycle: ExternalEngineDurableLifecycle;
  launch(): Promise<AgentEngineRunResult>;
  resume?(): Promise<AgentEngineRunResult>;
  externalSessionId?: string;
}

export interface ExternalEngineExecutorOptions {
  id?: string;
  resolve(node: GraphNode, context: GraphExecutorContext): ExternalEngineGraphBinding;
}

/** Maps one Graph node onto the existing S5 lifecycle; it never starts another Durable Run. */
export class ExternalEngineExecutor implements GraphExecutorPort {
  readonly id: string;
  private readonly active = new Map<string, ExternalEngineGraphBinding>();

  constructor(private readonly options: ExternalEngineExecutorOptions) {
    this.id = options.id ?? 'external_engine';
  }

  canExecute(node: GraphNode): boolean {
    return node.executorRef === this.id || node.kind === 'external_engine';
  }

  async execute(node: GraphNode, context: GraphExecutorContext): Promise<GraphNodeResult> {
    return this.runBound(node, context, false);
  }

  async recover(node: GraphNode, _checkpoint: GraphCheckpoint, context: GraphExecutorContext): Promise<GraphNodeResult> {
    return this.runBound(node, context, true);
  }

  async cancel(node: GraphNode, context: GraphExecutorContext): Promise<void> {
    await this.active.get(this.key(context, node))?.lifecycle.terminateProcess('SIGTERM');
  }

  private async runBound(node: GraphNode, context: GraphExecutorContext, recovering: boolean): Promise<GraphNodeResult> {
    const input = parseExternalEngineGraphInput(node.input);
    const capability = EXTERNAL_ENGINE_RESUME_CAPABILITIES[input.engine];
    if (recovering && capability !== 'resumable') {
      return { status: 'requires_review', error: `${input.engine} cannot resume safely`, sideEffectState: 'unknown' };
    }
    const binding = this.options.resolve(node, context);
    if (binding.lifecycle.runId !== context.runId || binding.lifecycle.sessionId !== context.sessionId) {
      throw new Error('external lifecycle identity does not match Graph node');
    }
    if (binding.lifecycle.attempt !== context.attempt) throw new Error('external lifecycle attempt is stale for Graph node');
    const key = this.key(context, node);
    this.active.set(key, binding);
    try {
      const result = recovering ? await requireResume(binding) : await binding.launch();
      if (result.runId !== context.runId || result.sessionId !== context.sessionId || result.engine !== input.engine) {
        throw new Error('external result identity does not match Graph node');
      }
      const checkpoint: ExternalEngineGraphCheckpoint = {
        version: 1,
        engine: input.engine,
        externalSessionId: binding.externalSessionId ?? input.externalSessionId,
        runId: context.runId,
        attempt: context.attempt,
      };
      return {
        status: result.status,
        output: toJson(result),
        error: result.error,
        retryable: false,
        checkpoint: checkpoint as unknown as GraphJsonValue,
        sideEffectState: 'confirmed',
      };
    } finally {
      this.active.delete(key);
    }
  }

  private key(context: GraphExecutorContext, node: GraphNode): string { return `${context.runId}:${node.nodeId}`; }
}

function parseExternalEngineGraphInput(value: GraphJsonValue): ExternalEngineGraphInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('external engine graph input must be an object');
  const input = value as unknown as ExternalEngineGraphInput;
  if (!['codex_cli', 'claude_code', 'mimo_code', 'kimi_code'].includes(input.engine)) throw new Error('unsupported external graph engine');
  return structuredClone(input);
}

function requireResume(binding: ExternalEngineGraphBinding): Promise<AgentEngineRunResult> {
  if (!binding.resume) throw new Error('external Graph binding has no resume builder');
  return binding.resume();
}

function toJson(value: unknown): GraphJsonValue { return JSON.parse(JSON.stringify(value)) as GraphJsonValue; }
