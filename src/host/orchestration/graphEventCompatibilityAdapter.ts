import type { AgentEvent } from '../../shared/contract/agent';
import type { DAGVisualizationEvent } from '../../shared/contract/dagVisualization';
import type { TaskStatus } from '../../shared/contract/taskDAG';
import type { ScriptRunEvent } from '../../shared/contract/scriptRun';
import type { SwarmEvent } from '../../shared/contract/swarm';
import type { GraphEvent } from './graphEvents';

export interface GraphSessionEvidence {
  sessionId: string;
  eventType: `graph:${GraphEvent['type']}`;
  timestamp: number;
  data: {
    graphId: string;
    runId: string;
    attempt: number;
    sequence: number;
    nodeId?: string;
    nodeStatus?: string;
    graphStatus?: string;
    trace?: GraphEvent['trace'];
    payload?: GraphEvent['data'];
  };
}

export interface GraphCompatibilityProjection {
  agent: AgentEvent[];
  swarm: SwarmEvent[];
  script: ScriptRunEvent[];
  dag: DAGVisualizationEvent[];
  session: GraphSessionEvidence[];
}

export interface GraphEventCompatibilitySinks {
  graph?(event: GraphEvent): void | Promise<void>;
  agent?(event: AgentEvent): void | Promise<void>;
  swarm?(event: SwarmEvent): void | Promise<void>;
  script?(event: ScriptRunEvent): void | Promise<void>;
  dag?(event: DAGVisualizationEvent): void | Promise<void>;
  session?(event: GraphSessionEvidence): void | Promise<void>;
  diagnostic?(error: unknown, event: GraphEvent, target: keyof GraphCompatibilityProjection | 'graph'): void;
}

export interface GraphEventCompatibilityOptions {
  /** Hold Graph terminal until the facade has finished its legacy payload. */
  deferTerminals?: boolean;
}

/**
 * Single compatibility fan-out for migrated paths. Projection failures are
 * diagnostic-only and terminal delivery is fenced per Graph attempt.
 */
export class GraphEventCompatibilityAdapter {
  private readonly terminalAttempts = new Set<string>();
  private readonly pendingTerminals = new Map<string, GraphEvent>();
  private readonly sinkSets = new Set<GraphEventCompatibilitySinks>();

  constructor(sinks: GraphEventCompatibilitySinks, private readonly options: GraphEventCompatibilityOptions = {}) {
    this.sinkSets.add(sinks);
  }

  subscribe(sinks: GraphEventCompatibilitySinks): () => void {
    this.sinkSets.add(sinks);
    return () => this.sinkSets.delete(sinks);
  }

  async emit(event: GraphEvent): Promise<void> {
    const terminalKey = `${event.graphId}:${event.runId}:${event.attempt}`;
    const terminal = isTerminalGraphEvent(event);
    if (terminal && this.terminalAttempts.has(terminalKey)) return;
    if (terminal && this.options.deferTerminals) {
      if (!this.pendingTerminals.has(terminalKey)) this.pendingTerminals.set(terminalKey, event);
      return;
    }
    await this.deliver(event, terminalKey, terminal);
  }

  async flushTerminals(): Promise<void> {
    const pending = [...this.pendingTerminals.entries()];
    this.pendingTerminals.clear();
    for (const [terminalKey, event] of pending) {
      if (!this.terminalAttempts.has(terminalKey)) await this.deliver(event, terminalKey, true);
    }
  }

  private async deliver(event: GraphEvent, terminalKey: string, terminal: boolean): Promise<void> {
    if (terminal) this.terminalAttempts.add(terminalKey);
    const projection = projectGraphEvent(event);
    const sinks = [...this.sinkSets];
    await Promise.all([
      ...sinks.map(async (sinkSet) => {
        try {
          await sinkSet.graph?.(event);
        } catch (error) {
          this.reportDiagnostic(sinkSet, error, event, 'graph');
        }
      }),
      ...(Object.keys(projection) as Array<keyof GraphCompatibilityProjection>).flatMap((target) =>
        projection[target].flatMap((projected) => sinks.map(async (sinkSet) => {
          try {
            const sink = sinkSet[target] as ((value: typeof projected) => void | Promise<void>) | undefined;
            await sink?.(projected);
          } catch (error) {
            this.reportDiagnostic(sinkSet, error, event, target);
          }
        }))),
    ]);
  }

  private reportDiagnostic(
    sinks: GraphEventCompatibilitySinks,
    error: unknown,
    event: GraphEvent,
    target: keyof GraphCompatibilityProjection | 'graph',
  ): void {
    try {
      sinks.diagnostic?.(error, event, target);
    } catch {
      // Compatibility diagnostics cannot alter GraphRunner's authoritative result.
    }
  }
}

export function projectGraphEvent(event: GraphEvent): GraphCompatibilityProjection {
  return {
    agent: projectAgent(event),
    swarm: projectSwarm(event),
    script: projectScript(event),
    dag: projectDAG(event),
    session: [{
      sessionId: event.sessionId,
      eventType: `graph:${event.type}`,
      timestamp: event.timestamp,
      data: {
        graphId: event.graphId,
        runId: event.runId,
        attempt: event.attempt,
        sequence: event.sequence,
        nodeId: event.nodeId,
        nodeStatus: event.nodeStatus,
        graphStatus: event.graphStatus,
        trace: event.trace,
        payload: event.data,
      },
    }],
  };
}

function projectAgent(event: GraphEvent): AgentEvent[] {
  if (event.type === 'graph_completed') return [{ type: 'agent_complete', data: null }];
  if (event.type === 'graph_cancelled') return [{ type: 'agent_cancelled', data: null }];
  if (event.type === 'graph_failed') return [{ type: 'error', data: { message: errorText(event, 'Graph run failed'), details: correlation(event) } }];
  if (event.nodeId && event.nodeStatus) {
    return [{ type: 'agent_thinking', data: { message: `${event.nodeId ?? 'graph node'}: ${event.nodeStatus ?? event.type}`, agentId: event.nodeId } }];
  }
  return [];
}

function projectSwarm(event: GraphEvent): SwarmEvent[] {
  const base = {
    timestamp: event.timestamp,
    runId: event.runId,
    sessionId: event.sessionId,
    treeId: event.graphId,
  };
  if (event.type === 'graph_started') return [{ ...base, type: 'swarm:started', data: {} }];
  if (event.type === 'graph_completed') return [{ ...base, type: 'swarm:completed', data: { result: { success: true, totalTime: 0 } } }];
  if (event.type === 'graph_cancelled') return [{ ...base, type: 'swarm:cancelled', data: {} }];
  if (event.type === 'graph_failed') return [{ ...base, type: 'swarm:completed', data: { result: { success: false, totalTime: 0 } } }];
  if (event.type === 'node_started') return [{ ...base, type: 'swarm:agent:updated', data: { agentId: event.nodeId } }];
  if (event.type === 'node_completed') return [{ ...base, type: 'swarm:agent:completed', data: { agentId: event.nodeId } }];
  if (event.type === 'node_failed') return [{ ...base, type: 'swarm:agent:failed', data: { agentId: event.nodeId } }];
  return [];
}

function projectScript(event: GraphEvent): ScriptRunEvent[] {
  const base = { runId: event.runId, sessionId: event.sessionId, ts: event.timestamp };
  if (event.type === 'node_progress' && typeof event.data?.scriptEventType === 'string') {
    const type = event.data.scriptEventType as ScriptRunEvent['type'];
    if (['run:phase', 'run:log', 'agent:start', 'agent:done', 'agent:error'].includes(type)) {
      const data = event.data.scriptEventData;
      return [{
        ...base,
        type,
        ts: typeof event.data.scriptEventTimestamp === 'number' ? event.data.scriptEventTimestamp : event.timestamp,
        data: data && typeof data === 'object' && !Array.isArray(data) ? data as Record<string, unknown> : undefined,
      } as ScriptRunEvent];
    }
  }
  if (event.type === 'graph_started') return [{ ...base, type: 'run:start', data: { graphId: event.graphId, attempt: event.attempt } }];
  if (event.type === 'node_started') return [{ ...base, type: 'agent:start', data: { agentId: event.nodeId, label: event.nodeId ?? 'node' } }];
  if (event.type === 'node_completed') return [{ ...base, type: 'agent:done', data: { agentId: event.nodeId, label: event.nodeId ?? 'node' } }];
  if (event.type === 'node_failed') return [{ ...base, type: 'agent:error', data: { agentId: event.nodeId, label: event.nodeId ?? 'node', error: errorText(event, 'Graph node failed') } }];
  if (event.type === 'node_progress') return [];
  if (event.type === 'graph_completed') return [{ ...base, type: 'run:done', data: { graphId: event.graphId } }];
  if (event.type === 'graph_cancelled') return [{ ...base, type: 'run:cancelled', data: { reason: errorText(event, 'Graph cancelled') } }];
  if (event.type === 'graph_failed') return [{ ...base, type: 'run:error', data: { error: errorText(event, 'Graph run failed') } }];
  if (event.type === 'graph_waiting' && event.graphStatus === 'requires_review') {
    return [{ ...base, type: 'run:error', data: { error: 'Graph run requires review before it can continue' } }];
  }
  return [];
}

function projectDAG(event: GraphEvent): DAGVisualizationEvent[] {
  if (event.nodeId && event.nodeStatus) {
    return [{
      type: 'task:status',
      dagId: event.graphId,
      timestamp: event.timestamp,
      data: {
        type: 'task:status',
        taskId: event.nodeId,
        status: toTaskStatus(event.nodeStatus),
        ...(event.type === 'node_started' ? { startedAt: event.timestamp } : {}),
        ...(['node_completed', 'node_failed', 'node_cancelled', 'node_skipped'].includes(event.type) ? { completedAt: event.timestamp } : {}),
      },
    }];
  }
  const terminalType = event.type === 'graph_completed' ? 'dag:complete'
    : event.type === 'graph_failed' ? 'dag:failed'
      : event.type === 'graph_cancelled' ? 'dag:cancelled'
        : event.type === 'graph_started' ? 'dag:start' : undefined;
  if (!terminalType) return [];
  const status = terminalType === 'dag:complete' ? 'completed'
    : terminalType === 'dag:failed' ? 'failed'
      : terminalType === 'dag:cancelled' ? 'cancelled' : 'running';
  return [{ type: terminalType, dagId: event.graphId, timestamp: event.timestamp, data: { type: terminalType, status } }];
}

function toTaskStatus(status: NonNullable<GraphEvent['nodeStatus']>): TaskStatus {
  if (status === 'queued' || status === 'waiting' || status === 'requires_review') return 'pending';
  return status;
}

function correlation(event: GraphEvent): Record<string, unknown> {
  return { graphId: event.graphId, runId: event.runId, sessionId: event.sessionId, attempt: event.attempt, trace: event.trace };
}

function errorText(event: GraphEvent, fallback: string): string {
  const error = event.data?.error;
  return typeof error === 'string' ? error : fallback;
}

function isTerminalGraphEvent(event: GraphEvent): boolean {
  return event.type === 'graph_completed' || event.type === 'graph_failed' || event.type === 'graph_cancelled';
}
