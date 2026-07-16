import { createHash } from 'node:crypto';
import {
  cancelRun,
  createNestedWorkflowIdentity,
  startRun,
  type NestedGraphEvent,
  type ScriptRunHostDeps,
  type ScriptRunSpec,
} from '../../agent/scriptRuntime';
import type { GraphExecutorContext, GraphExecutorPort } from '../graphExecutorPort';
import type { GraphJsonValue, GraphNode, GraphNodeResult } from '../graphTypes';

export interface DynamicWorkflowGraphInput {
  script: string;
  goal?: string;
  workingDir?: string;
  defaultProvider: string;
  defaultModel: string;
  budgetTokens?: number;
  workflowRunId?: string;
  journalRunId?: string;
  resumeFromRunId?: string;
}

export interface DynamicWorkflowGraphCheckpoint {
  version: 1;
  scriptHash: string;
  workflowRunId: string;
  nestedGraphId: string;
  journalRunId: string;
  latestNestedCheckpointRef?: string;
}

export interface DynamicWorkflowExecutorOptions {
  id?: string;
  dependenciesFactory(node: GraphNode, context: GraphExecutorContext): ScriptRunHostDeps;
}

/** Parent Graph owns one workflow node; the sandbox remains the nested scheduler. */
export class DynamicWorkflowExecutor implements GraphExecutorPort {
  readonly id: string;

  constructor(private readonly options: DynamicWorkflowExecutorOptions) {
    this.id = options.id ?? 'dynamic_workflow';
  }

  canExecute(node: GraphNode): boolean {
    return node.executorRef === this.id || node.kind === 'dynamic_workflow';
  }

  async execute(node: GraphNode, context: GraphExecutorContext): Promise<GraphNodeResult> {
    const input = parseDynamicWorkflowGraphInput(node.input);
    const scriptHash = createHash('sha256').update(input.script).digest('hex').slice(0, 16);
    const workflowRunId = input.workflowRunId ?? `${context.runId}:${node.nodeId}`;
    const identity = createNestedWorkflowIdentity({
      workflowRunId,
      parentGraphId: context.graphId,
      parentNodeId: node.nodeId,
      scriptHash,
    });
    const prior = readDynamicCheckpoint(context, node.nodeId);
    if (prior && (prior.scriptHash !== scriptHash || prior.workflowRunId !== workflowRunId || prior.nestedGraphId !== identity.nestedGraphId)) {
      return { status: 'requires_review', error: 'dynamic workflow recovery identity mismatch', sideEffectState: 'unknown' };
    }

    let latestNestedCheckpointRef = prior?.latestNestedCheckpointRef;
    let uncertainSideEffect = false;
    let progressQueue = Promise.resolve();
    const deps = this.options.dependenciesFactory(node, context);
    const emitNestedGraph = (event: NestedGraphEvent): void => {
      if (event.metadata.parentGraphId !== context.graphId || event.metadata.parentNodeId !== node.nodeId) {
        uncertainSideEffect = true;
        return;
      }
      latestNestedCheckpointRef = nestedEventRef(event);
      if (event.type === 'nested:node_failed' && event.metadata.sideEffect === 'unknown') uncertainSideEffect = true;
      const cursor: DynamicWorkflowGraphCheckpoint = {
        version: 1,
        scriptHash,
        workflowRunId,
        nestedGraphId: identity.nestedGraphId,
        journalRunId: input.journalRunId ?? workflowRunId,
        latestNestedCheckpointRef,
      };
      progressQueue = progressQueue
        .then(() => context.saveCheckpoint?.(cursor as unknown as GraphJsonValue))
        .then(() => context.progress({
        nestedEvent: event.type,
        nestedGraphId: event.metadata.nestedGraphId,
        nestedNodeId: event.metadata.nodeId,
        groupId: event.metadata.groupId,
        groupKind: event.metadata.groupKind,
        ...(event.metadata.itemId ? { itemId: event.metadata.itemId } : {}),
        ...(event.metadata.stageId ? { stageId: event.metadata.stageId } : {}),
        ...(latestNestedCheckpointRef ? { latestNestedCheckpointRef } : {}),
        }));
      deps.emitNestedGraph?.(event);
    };
    const spec: ScriptRunSpec = {
      runId: workflowRunId,
      sessionId: context.sessionId,
      workingDir: input.workingDir,
      script: input.script,
      goal: input.goal,
      defaultProvider: input.defaultProvider,
      defaultModel: input.defaultModel,
      budgetTokens: input.budgetTokens,
      ...(input.resumeFromRunId || context.nodeAttempt > 1 || prior
        ? { resumeFromRunId: input.resumeFromRunId ?? input.journalRunId ?? workflowRunId }
        : {}),
      nestedGraph: identity,
    };
    const state = await startRun(spec, {
      ...deps,
      signal: context.signal,
      emit: (event) => {
        if (!['run:start', 'run:done', 'run:error', 'run:cancelled'].includes(event.type)) {
          progressQueue = progressQueue.then(() => context.progress({
            scriptEventType: event.type,
            scriptEventTimestamp: event.ts,
            scriptEventData: toGraphJson(event.data),
          }));
        }
      },
      emitNestedGraph,
      traceContext: deps.traceContext,
    });
    await progressQueue;
    const checkpoint: DynamicWorkflowGraphCheckpoint = {
      version: 1,
      scriptHash,
      workflowRunId,
      nestedGraphId: identity.nestedGraphId,
      journalRunId: input.journalRunId ?? workflowRunId,
      ...(latestNestedCheckpointRef ? { latestNestedCheckpointRef } : {}),
    };
    if (uncertainSideEffect) {
      return {
        status: 'requires_review',
        output: toGraphJson(state),
        checkpoint: checkpoint as unknown as GraphJsonValue,
        sideEffectState: 'unknown',
      };
    }
    if (state.status === 'completed') {
      return {
        status: 'completed',
        output: toGraphJson(state),
        checkpoint: checkpoint as unknown as GraphJsonValue,
        sideEffectState: 'confirmed',
      };
    }
    return {
      status: state.status === 'cancelled' ? 'cancelled' : 'failed',
      output: toGraphJson(state),
      error: state.error,
      retryable: state.status === 'failed',
      checkpoint: checkpoint as unknown as GraphJsonValue,
      sideEffectState: node.sideEffect === 'unknown' ? 'unknown' : 'not_dispatched',
    };
  }

  async recover(node: GraphNode, _checkpoint: import('../graphTypes').GraphCheckpoint, context: GraphExecutorContext): Promise<GraphNodeResult> {
    return this.execute(node, context);
  }

  cancel(node: GraphNode, context: GraphExecutorContext): void {
    const input = parseDynamicWorkflowGraphInput(node.input);
    cancelRun(input.workflowRunId ?? `${context.runId}:${node.nodeId}`, { sessionId: context.sessionId });
  }
}

export function parseDynamicWorkflowGraphInput(value: GraphJsonValue): DynamicWorkflowGraphInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('dynamic workflow graph input must be an object');
  const input = value as unknown as DynamicWorkflowGraphInput;
  if (typeof input.script !== 'string' || !input.script.trim()) throw new Error('dynamic workflow script is required');
  if (typeof input.defaultProvider !== 'string' || typeof input.defaultModel !== 'string') throw new Error('dynamic workflow model identity is required');
  return structuredClone(input);
}

function readDynamicCheckpoint(context: GraphExecutorContext, nodeId: string): DynamicWorkflowGraphCheckpoint | undefined {
  const value = context.checkpoint?.nodes.find((candidate) => candidate.nodeId === nodeId)?.result?.checkpoint;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = value as unknown as DynamicWorkflowGraphCheckpoint;
  return candidate.version === 1 ? candidate : undefined;
}

function nestedEventRef(event: NestedGraphEvent): string {
  return `nested-checkpoint:${createHash('sha256').update(JSON.stringify(event)).digest('hex').slice(0, 24)}`;
}

function toGraphJson(value: unknown): GraphJsonValue {
  if (value === undefined) return null;
  const seen = new WeakSet<object>();
  return JSON.parse(JSON.stringify(value, (_key, candidate: unknown) => {
    if (typeof candidate === 'bigint') return candidate.toString();
    if (candidate && typeof candidate === 'object') {
      if (seen.has(candidate)) return '[Circular]';
      seen.add(candidate);
    }
    return candidate;
  })) as GraphJsonValue;
}
