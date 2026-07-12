import type { GraphCheckpoint, GraphRunResult } from '../orchestration/graphTypes';
import type { GraphEvent } from '../orchestration/graphEvents';
import { GraphEventCompatibilityAdapter, type GraphEventCompatibilitySinks } from '../orchestration/graphEventCompatibilityAdapter';
import type { DurableEngineRecoveryHandler } from './durableRecoveryDispatcher';
import type { RunRehydrationPlan } from './durableRunStores';
import type { RunRegistry } from './runRegistry';

export const AUTO_AGENT_CURSOR_VERSION = 1 as const;

export interface AutoAgentEngineCursor {
  schemaVersion: typeof AUTO_AGENT_CURSOR_VERSION;
  runtime: 'auto_agent';
  sourceMessageId: string;
  graphId: string;
  workspaceFingerprint: string;
}

export interface AutoAgentRecoveryState {
  schemaVersion: typeof AUTO_AGENT_CURSOR_VERSION;
  kind: 'auto_agent';
  sourceMessageId: string;
  workspace: { root: string; cwd: string; fingerprint: string };
  graphCheckpoint: GraphCheckpoint;
  cancelled: boolean;
}

export interface AutoAgentRecoveryRunner {
  resume(input: {
    plan: RunRehydrationPlan;
    state: AutoAgentRecoveryState;
    emit(event: GraphEvent): Promise<void>;
    persist(checkpoint: GraphCheckpoint): Promise<void>;
  }): Promise<GraphRunResult | { status: 'requires_review'; reason: string }>;
  shutdown?(): Promise<void> | void;
}

export function isAutoAgentCursor(value: unknown): value is AutoAgentEngineCursor {
  if (!value || typeof value !== 'object') return false;
  const cursor = value as Partial<AutoAgentEngineCursor>;
  return cursor.schemaVersion === AUTO_AGENT_CURSOR_VERSION
    && cursor.runtime === 'auto_agent'
    && typeof cursor.sourceMessageId === 'string'
    && typeof cursor.graphId === 'string'
    && typeof cursor.workspaceFingerprint === 'string';
}

export function isAutoAgentRecoveryState(value: unknown): value is AutoAgentRecoveryState {
  if (!value || typeof value !== 'object') return false;
  const state = value as Partial<AutoAgentRecoveryState>;
  return state.schemaVersion === AUTO_AGENT_CURSOR_VERSION
    && state.kind === 'auto_agent'
    && typeof state.sourceMessageId === 'string'
    && Boolean(state.workspace)
    && Boolean(state.graphCheckpoint)
    && typeof state.cancelled === 'boolean';
}

export class AutoAgentRecoveryHost {
  private active = false;

  constructor(
    private readonly registry: RunRegistry,
    private readonly runner: AutoAgentRecoveryRunner,
    private readonly compatibilitySinks: GraphEventCompatibilitySinks = {},
  ) {}

  handles(plan: RunRehydrationPlan): boolean {
    return isAutoAgentCursor(plan.checkpoint?.cursor.engineCursor ?? plan.envelope.cursor.engineCursor);
  }

  createHandler(): DurableEngineRecoveryHandler {
    return {
      name: 'agent_team_production',
      engineKind: 'agent_team',
      recover: (plan, now) => this.recover(plan, now),
      shutdown: () => this.shutdown(),
    };
  }

  private async recover(plan: RunRehydrationPlan, now: number) {
    const cursor = plan.checkpoint?.cursor.engineCursor ?? plan.envelope.cursor.engineCursor;
    const state = plan.checkpoint?.state;
    if (!isAutoAgentCursor(cursor) || !isAutoAgentRecoveryState(state)) {
      return { status: 'requires_review' as const, reason: 'auto_agent_cursor_or_checkpoint_missing' };
    }
    if (cursor.sourceMessageId !== state.sourceMessageId
      || cursor.graphId !== state.graphCheckpoint.graphId
      || cursor.workspaceFingerprint !== state.workspace.fingerprint
      || state.graphCheckpoint.runId !== plan.envelope.runId
      || state.graphCheckpoint.sessionId !== plan.envelope.sessionId) {
      return this.review(plan, state, now, 'auto_agent_identity_or_workspace_drift');
    }
    if (state.cancelled || state.graphCheckpoint.status === 'cancelled') {
      return this.review(plan, state, now, 'auto_agent_cancelled_checkpoint');
    }
    const uncertain = state.graphCheckpoint.nodes.find((node) =>
      (node.status === 'running' || node.status === 'waiting')
      && node.result?.sideEffectState === 'unknown');
    if (uncertain) return this.review(plan, state, now, 'auto_agent_uncertain_side_effect');

    const compatibility = new GraphEventCompatibilityAdapter(this.compatibilitySinks);
    this.active = true;
    try {
      const result = await this.runner.resume({
        plan,
        state,
        emit: (event) => compatibility.emit(event),
        persist: async (checkpoint) => {
          await this.registry.checkpointDurable(plan.envelope.runId, {
            now: checkpoint.updatedAt,
            status: checkpoint.status === 'waiting' || checkpoint.status === 'requires_review' ? 'waiting' : 'running',
            state: { ...state, graphCheckpoint: checkpoint },
            engineCursor: cursor,
            pendingOperations: plan.pendingOperations,
            childRuns: plan.childRuns,
            events: [{ type: 'auto_agent_graph_checkpoint', payload: { graphId: checkpoint.graphId }, recordedAt: checkpoint.updatedAt }],
          });
        },
      });
      if (result.status === 'requires_review') {
        return this.review(plan, state, now, 'reason' in result ? result.reason : 'auto_agent_graph_requires_review');
      }
      if (result.status === 'waiting') return { status: 'observing' as const, reason: 'auto_agent_waiting' };
      if (result.status === 'cancelled') return this.review(plan, state, now, 'auto_agent_cancelled_during_recovery');
      const terminalStatus = result.status === 'completed' ? 'completed' as const : 'failed' as const;
      const terminalOperations = plan.pendingOperations.map((operation) => ({
        ...operation,
        status: terminalStatus === 'completed' ? 'succeeded' as const : 'failed' as const,
        resultRef: terminalStatus === 'completed' ? `auto-agent:${result.checkpoint.graphId}:completed` : operation.resultRef,
        updatedAt: result.checkpoint.updatedAt,
      }));
      await this.registry.checkpointDurable(plan.envelope.runId, {
        now: result.checkpoint.updatedAt,
        status: 'running',
        state: { ...state, graphCheckpoint: result.checkpoint },
        engineCursor: cursor,
        pendingOperations: terminalOperations,
        childRuns: plan.childRuns,
        events: [{
          type: 'auto_agent_graph_result_committed',
          payload: { graphId: result.checkpoint.graphId, status: result.status },
          recordedAt: result.checkpoint.updatedAt,
        }],
      });
      await this.registry.terminalDurable(plan.envelope.runId, {
        now: result.checkpoint.updatedAt + 1,
        status: terminalStatus,
        reason: `auto_agent_${result.status}`,
        event: {
          type: `agent_team_${terminalStatus}`,
          payload: { runtime: 'auto_agent', graphId: result.checkpoint.graphId },
          recordedAt: result.checkpoint.updatedAt + 1,
        },
      });
      return {
        status: result.status === 'completed' ? 'recovered' as const : 'failed' as const,
        reason: result.status === 'completed' ? 'resume_via_graph_compatibility_sink' : 'auto_agent_graph_failed',
      };
    } finally {
      this.active = false;
    }
  }

  private async review(plan: RunRehydrationPlan, state: AutoAgentRecoveryState, now: number, reason: string) {
    await this.registry.checkpointDurable(plan.envelope.runId, {
      now,
      status: 'waiting',
      state,
      engineCursor: plan.checkpoint?.cursor.engineCursor ?? plan.envelope.cursor.engineCursor,
      pendingOperations: plan.pendingOperations,
      childRuns: plan.childRuns,
      events: [{ type: 'auto_agent_requires_review', payload: { reason }, recordedAt: now }],
    });
    return { status: 'requires_review' as const, reason };
  }

  private async shutdown(): Promise<void> {
    if (this.active) await this.runner.shutdown?.();
    this.active = false;
  }
}
