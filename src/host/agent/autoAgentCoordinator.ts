import * as fs from 'fs';
import * as path from 'path';
import type { SubagentResult, SubagentExecutionContext } from './subagentExecutorTypes';
import { getSubagentExecutor } from './subagentExecutor';
import { getSessionStateManager } from '../session/sessionStateManager';
import type { DynamicAgentDefinition } from './dynamicAgentFactory';
import type { AgentRequirements, ExecutionStrategy } from './agentRequirementsAnalyzer';
import { getUserConfigDir } from '../config/configPaths';
import { createLogger } from '../services/infra/logger';
import {
  DAGGraphSchedulerAdapter,
  GraphExecutorRegistry,
  GraphEventCompatibilityAdapter,
  GraphRunner,
  SubagentExecutorAdapter,
  createSubagentGraphNodeInput,
  type GraphCheckpoint,
  type GraphJsonValue,
  type GraphNode,
  type GraphNodeResult,
  type GraphRunSpec,
} from '../orchestration';

const logger = createLogger('AutoAgentCoordinator');
const LEGACY_CHECKPOINT_DIR = 'coordination-checkpoints';

export type AgentExecutionStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface AgentExecutionResult {
  agentId: string;
  agentName: string;
  status: AgentExecutionStatus;
  result?: SubagentResult;
  error?: string;
  startedAt: number;
  completedAt?: number;
  duration?: number;
}

export interface CoordinationResult {
  success: boolean;
  strategy: ExecutionStrategy;
  results: AgentExecutionResult[];
  aggregatedOutput: string;
  totalDuration: number;
  totalIterations: number;
  totalCost: number;
  errors: string[];
}

export interface CoordinatorContext {
  sessionId: string;
  executionContext: SubagentExecutionContext;
  graphCheckpoint?: GraphCheckpoint;
  onGraphCheckpoint?: (checkpoint: GraphCheckpoint) => void | Promise<void>;
  onProgress?: (agentId: string, status: AgentExecutionStatus, progress?: number) => void;
  compatibilitySink?: GraphEventCompatibilityAdapter;
}

interface LegacyExecutionCheckpoint {
  sessionId: string;
  agentIds: string[];
  completedNodes: Record<string, AgentExecutionResult>;
  createdAt: number;
  updatedAt: number;
}

function loadLegacyCheckpoint(sessionId: string, expectedAgentIds: string[]): LegacyExecutionCheckpoint | null {
  const filePath = path.join(getUserConfigDir(), LEGACY_CHECKPOINT_DIR, `${sessionId}.json`);
  try {
    if (!fs.existsSync(filePath)) return null;
    const checkpoint = JSON.parse(fs.readFileSync(filePath, 'utf8')) as LegacyExecutionCheckpoint;
    const matches = checkpoint.sessionId === sessionId
      && checkpoint.agentIds.length === expectedAgentIds.length
      && checkpoint.agentIds.every((id, index) => id === expectedAgentIds[index]);
    return matches ? checkpoint : null;
  } catch {
    return null;
  }
}

export class AutoAgentCoordinator {
  private readonly subagentExecutor = getSubagentExecutor();
  private readonly sessionStateManager = getSessionStateManager();
  private readonly activeRunners = new Map<string, GraphRunner>();

  async execute(
    agents: DynamicAgentDefinition[],
    requirements: AgentRequirements,
    context: CoordinatorContext,
  ): Promise<CoordinationResult> {
    const startTime = Date.now();
    const graph = this.buildGraphSpec(agents, requirements.executionStrategy, context);
    const legacy = context.graphCheckpoint
      ? undefined
      : loadLegacyCheckpoint(context.sessionId, agents.map((agent) => agent.id));
    const checkpoint = context.graphCheckpoint ?? this.projectLegacyCheckpoint(graph, legacy);
    const byId = new Map(agents.map((agent) => [agent.id, agent]));
    const compatibility = context.compatibilitySink ?? new GraphEventCompatibilityAdapter({});
    const unsubscribe = compatibility.subscribe({
      graph: (event) => {
        if (!event.nodeId) return;
        const agent = byId.get(event.nodeId);
        if (!agent) return;
        if (event.type === 'node_queued') {
          this.sessionStateManager.addSubagent(context.sessionId, {
            id: agent.id, name: agent.name, status: 'pending', startedAt: event.timestamp,
          });
          context.onProgress?.(agent.id, 'pending');
        } else if (event.type === 'node_started') {
          this.sessionStateManager.updateSubagent(context.sessionId, agent.id, { status: 'running' });
          context.onProgress?.(agent.id, 'running');
        } else if (event.type === 'node_completed') {
          this.sessionStateManager.updateSubagent(context.sessionId, agent.id, { status: 'completed', completedAt: event.timestamp });
          context.onProgress?.(agent.id, 'completed');
        } else if (event.type === 'node_cancelled') {
          this.sessionStateManager.updateSubagent(context.sessionId, agent.id, {
            status: 'failed', error: 'Cancelled by user', completedAt: event.timestamp,
          });
          context.onProgress?.(agent.id, 'cancelled');
        } else if (event.type === 'node_failed' || event.type === 'node_skipped') {
          const error = typeof event.data?.error === 'string' ? event.data.error : 'Agent failed';
          this.sessionStateManager.updateSubagent(context.sessionId, agent.id, {
            status: 'failed', error, completedAt: event.timestamp,
          });
          context.onProgress?.(agent.id, 'failed');
        }
      },
      diagnostic: (error) => logger.warn('Auto Agent Graph compatibility projection failed', error),
    });
    const adapter = new SubagentExecutorAdapter(this.subagentExecutor, {
      id: 'auto-subagent',
      contextFactory: (node, graphContext) => ({
        ...context.executionContext,
        runId: graphContext.runId,
        sessionId: graphContext.sessionId,
        abortSignal: graphContext.signal,
        traceContext: context.executionContext.traceContext,
        agentId: node.nodeId,
        executionAgentId: node.nodeId,
        parentToolUseId: context.executionContext.currentToolCallId,
      }),
      requestFactory: (input, node, graphContext) => {
        const previous = node.dependencies
          .map((dependency) => graphContext.dependencyResults[dependency])
          .map((result) => this.subagentOutput(result))
          .filter((output): output is string => Boolean(output));
        return previous.length === 0 ? input : {
          ...input,
          prompt: `${input.prompt}\n\n**前置任务输出**：\n${previous.join('\n\n---\n\n')}`,
        };
      },
    });
    const runner = new GraphRunner({
      scheduler: new DAGGraphSchedulerAdapter(),
      executors: new GraphExecutorRegistry([adapter]),
      emit: (event) => compatibility.emit(event),
      persistCheckpoint: context.onGraphCheckpoint,
    });

    this.activeRunners.set(graph.runId, runner);
    let graphResult;
    try {
      graphResult = await runner.run(graph, checkpoint);
    } finally {
      this.activeRunners.delete(graph.runId);
      unsubscribe();
    }

    const results = agents.flatMap((agent) => {
      const nodeCheckpoint = graphResult.checkpoint.nodes.find((node) => node.nodeId === agent.id);
      return nodeCheckpoint?.status === 'skipped' ? [] : [this.toExecutionResult(
        agent,
        graphResult.results[agent.id],
        nodeCheckpoint,
      )];
    });
    const aggregated = this.aggregateResults(results);
    return {
      ...aggregated,
      strategy: requirements.executionStrategy,
      totalDuration: Date.now() - startTime,
    };
  }

  cancelAgents(sessionId: string): void {
    for (const [runId, runner] of this.activeRunners) {
      if (runId === sessionId || runId.endsWith(`:${sessionId}`)) void runner.cancel('user_cancelled');
    }
    const state = this.sessionStateManager.get(sessionId);
    if (state) {
      for (const [agentId] of state.activeSubagents) {
        this.sessionStateManager.updateSubagent(sessionId, agentId, {
          status: 'failed', error: 'Cancelled by user', completedAt: Date.now(),
        });
      }
    }
  }

  getProgress(sessionId: string): { total: number; completed: number; running: number; failed: number; pending: number } {
    const state = this.sessionStateManager.get(sessionId);
    if (!state) return { total: 0, completed: 0, running: 0, failed: 0, pending: 0 };
    const values = [...state.activeSubagents.values()];
    return {
      total: values.length,
      completed: values.filter((agent) => agent.status === 'completed').length,
      running: values.filter((agent) => agent.status === 'running').length,
      failed: values.filter((agent) => agent.status === 'failed').length,
      pending: values.filter((agent) => agent.status === 'pending').length,
    };
  }

  private buildGraphSpec(
    agents: DynamicAgentDefinition[],
    strategy: ExecutionStrategy,
    context: CoordinatorContext,
  ): GraphRunSpec {
    const runId = context.executionContext.runId ?? `auto:${context.sessionId}`;
    const attempt = context.executionContext.traceContext?.attempt ?? 1;
    const primary = agents.filter((agent) => !agent.canRunParallel);
    const lastPrimaryId = primary.at(-1)?.id;
    const nodes: GraphNode[] = agents.map((agent, index) => {
      const declared = [...agent.dependencies];
      let dependencies = declared;
      if (strategy === 'direct' || strategy === 'sequential') {
        dependencies = index > 0 ? [...new Set([...declared, agents[index - 1].id])] : declared;
      } else if (!agent.canRunParallel) {
        const previousPrimary = primary[primary.indexOf(agent) - 1];
        dependencies = previousPrimary ? [...new Set([...declared, previousPrimary.id])] : declared;
      } else if (lastPrimaryId) {
        dependencies = [...new Set([...declared, lastPrimaryId])];
      }
      const required = strategy === 'parallel' ? !agent.canRunParallel : agent.priority === 1;
      return {
        nodeId: agent.id,
        kind: 'subagent',
        executorRef: 'auto-subagent',
        input: createSubagentGraphNodeInput({
          prompt: agent.taskDescription,
          config: {
            name: agent.name,
            roleId: agent.baseAgentId,
            systemPrompt: agent.systemPrompt,
            availableTools: [...agent.tools],
            maxIterations: agent.maxIterations,
            maxBudget: agent.maxBudget,
          },
        }),
        dependencies,
        capabilityProfile: { tools: [...agent.tools] },
        permissionProfile: { inherited: true },
        sideEffect: agent.tools.some((tool) => /(write|edit|bash|shell|browser|computer)/i.test(tool)) ? 'unknown' : 'read_only',
        idempotencyIdentity: `${runId}:node:${agent.id}`,
        timeoutMs: agent.timeout,
        retryPolicy: { maxAttempts: 1 },
        required,
        optional: !required,
        priority: agent.priority,
        metadata: { agentName: agent.name, strategy },
      };
    });
    const trace = context.executionContext.traceContext;
    return {
      graphId: `auto-agent:${context.sessionId}`,
      runId,
      sessionId: context.sessionId,
      attempt,
      nodes,
      schedulerPolicy: { maxConcurrency: strategy === 'parallel' ? Math.max(1, agents.length) : 1, failureStrategy: 'continue' },
      metadata: { engine: 'auto_agent', strategy },
      ...(trace ? { trace: { traceId: trace.traceId, spanId: trace.spanId } } : {}),
    };
  }

  private projectLegacyCheckpoint(
    spec: GraphRunSpec,
    legacy: LegacyExecutionCheckpoint | null | undefined,
  ): GraphCheckpoint | undefined {
    if (!legacy || Object.keys(legacy.completedNodes).length === 0) return undefined;
    const scheduler = new DAGGraphSchedulerAdapter();
    scheduler.initialize(spec);
    const results = new Map<string, GraphNodeResult>();
    for (const [nodeId, cached] of Object.entries(legacy.completedNodes)) {
      if (cached.status !== 'completed') continue;
      scheduler.applyResult({
        nodeId,
        status: 'completed',
        attempts: 1,
        startedAt: cached.startedAt,
        completedAt: cached.completedAt,
      });
      results.set(nodeId, {
        status: 'completed',
        output: this.serializeSubagentResult(cached.result),
        sideEffectState: 'confirmed',
      });
    }
    const snapshot = scheduler.snapshot();
    return {
      version: 1,
      graphId: spec.graphId,
      runId: spec.runId,
      sessionId: spec.sessionId,
      attempt: spec.attempt,
      status: 'running',
      eventSequence: 0,
      scheduler: snapshot as unknown as GraphJsonValue,
      nodes: snapshot.nodes.map((node) => ({ ...node, result: results.get(node.nodeId) })),
      createdAt: legacy.createdAt,
      updatedAt: legacy.updatedAt,
    };
  }

  private toExecutionResult(
    agent: DynamicAgentDefinition,
    graphResult: GraphNodeResult | undefined,
    checkpoint: GraphCheckpoint['nodes'][number] | undefined,
  ): AgentExecutionResult {
    const result = this.parseSubagentResult(graphResult?.output);
    const status: AgentExecutionStatus = graphResult?.status === 'completed'
      ? 'completed'
      : graphResult?.status === 'cancelled' ? 'cancelled' : 'failed';
    const startedAt = checkpoint?.startedAt ?? Date.now();
    const completedAt = checkpoint?.completedAt;
    return {
      agentId: agent.id,
      agentName: agent.name,
      status,
      ...(result ? { result } : {}),
      ...(graphResult?.error ? { error: graphResult.error } : {}),
      startedAt,
      ...(completedAt !== undefined ? { completedAt, duration: completedAt - startedAt } : {}),
    };
  }

  private aggregateResults(results: AgentExecutionResult[]): Omit<CoordinationResult, 'strategy' | 'totalDuration'> {
    const errors = results.flatMap((result) => result.error ? [`[${result.agentName}] ${result.error}`] : []);
    const totalIterations = results.reduce((sum, result) => sum + (result.result?.iterations ?? 0), 0);
    const totalCost = results.reduce((sum, result) => sum + (result.result?.cost ?? 0), 0);
    const aggregatedOutput = results.flatMap((result) => result.result?.output
      ? [`## ${result.agentName}\n\n${result.result.output}`]
      : []).join('\n\n---\n\n');
    return {
      success: results.some((result) => result.status === 'completed'),
      results,
      aggregatedOutput,
      totalIterations,
      totalCost,
      errors,
    };
  }

  private subagentOutput(result?: GraphNodeResult): string | undefined {
    const parsed = this.parseSubagentResult(result?.output);
    return parsed?.output;
  }

  private serializeSubagentResult(result?: SubagentResult): GraphJsonValue | undefined {
    return result ? structuredClone(result) as unknown as GraphJsonValue : undefined;
  }

  private parseSubagentResult(value: GraphJsonValue | undefined): SubagentResult | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const result = value as unknown as Partial<SubagentResult>;
    if (typeof result.success !== 'boolean' || typeof result.output !== 'string') return undefined;
    return {
      success: result.success,
      output: result.output,
      toolsUsed: Array.isArray(result.toolsUsed) ? [...result.toolsUsed] : [],
      iterations: typeof result.iterations === 'number' ? result.iterations : 0,
      ...(result.error ? { error: result.error } : {}),
      ...(typeof result.cost === 'number' ? { cost: result.cost } : {}),
      ...(typeof result.tokensUsed === 'number' ? { tokensUsed: result.tokensUsed } : {}),
      ...(result.cancellationReason ? { cancellationReason: result.cancellationReason } : {}),
      ...(result.failureCode ? { failureCode: result.failureCode } : {}),
    };
  }
}

/** Compatibility factory. It deliberately returns a run-local facade, not a singleton. */
export function getAutoAgentCoordinator(): AutoAgentCoordinator {
  return new AutoAgentCoordinator();
}
