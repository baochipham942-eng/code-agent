import { createHash } from 'node:crypto';
import type { GraphCheckpoint } from '../orchestration/graphTypes';
import type { RunKernelAdapter } from '../runtime/durableRunKernel';
import type { AgentTeamDurableParentHost } from './agentTeamDurableTypes';
import { AUTO_AGENT_CURSOR_VERSION, type AutoAgentRecoveryState } from '../runtime/autoAgentRecoveryHost';

export interface AutoAgentDurableStartInput {
  parentRunId: string;
  sessionId: string;
  sourceMessageId: string;
  workspace: { root: string; cwd: string; fingerprint: string };
  graphId: string;
  sideEffect: boolean;
  now?: number;
}

export interface AutoAgentDurableController {
  readonly runId: string;
  persist(checkpoint: GraphCheckpoint): Promise<void>;
  terminal(status: 'completed' | 'failed' | 'cancelled', reason?: string, now?: number): Promise<void>;
}

function stableAutoAgentRunId(parentRunId: string, sourceMessageId: string): string {
  return `auto_${createHash('sha256').update(`auto-agent:v1:${parentRunId}:${sourceMessageId}`).digest('hex').slice(0, 32)}`;
}

export class AutoAgentDurableRuntime {
  constructor(
    private readonly kernel: RunKernelAdapter,
    private readonly parentHost: AgentTeamDurableParentHost,
  ) {}

  async start(input: AutoAgentDurableStartInput): Promise<AutoAgentDurableController> {
    const now = input.now ?? Date.now();
    const runId = stableAutoAgentRunId(input.parentRunId, input.sourceMessageId);
    const logicalOperationId = `auto-agent:${input.sourceMessageId}`;
    await this.parentHost.prepareAgentTeamChild({
      parentRunId: input.parentRunId,
      teamRunId: runId,
      treeId: input.graphId,
      logicalOperationId,
      sideEffect: input.sideEffect,
      now,
    });
    let operation = this.kernel.prepareOperation({
      runId,
      operationId: 'auto-agent-graph',
      logicalOperationId,
      attempt: 1,
      kind: 'child_run',
      sideEffect: input.sideEffect,
      canDeduplicate: false,
      now,
    });
    const cursor = {
      schemaVersion: AUTO_AGENT_CURSOR_VERSION,
      runtime: 'auto_agent' as const,
      sourceMessageId: input.sourceMessageId,
      graphId: input.graphId,
      workspaceFingerprint: input.workspace.fingerprint,
    };
    let state: Omit<AutoAgentRecoveryState, 'graphCheckpoint'> & { graphCheckpoint?: GraphCheckpoint } = {
      schemaVersion: AUTO_AGENT_CURSOR_VERSION,
      kind: 'auto_agent',
      sourceMessageId: input.sourceMessageId,
      workspace: input.workspace,
      cancelled: false,
    };
    const created = await this.kernel.createRun({
      runId,
      sessionId: input.sessionId,
      engine: { kind: 'agent_team', treeId: input.graphId },
      parentRunId: input.parentRunId,
      now,
      initialEngineCursor: cursor,
      initialPendingOperations: [operation],
    });
    await this.kernel.checkpoint({
      runId,
      attempt: created.attempt.attempt,
      owner: created.owner,
      now,
      status: 'running',
      state,
      engineCursor: cursor,
      pendingOperations: [operation],
      events: [{ type: 'auto_agent_prepared', payload: { graphId: input.graphId }, recordedAt: now }],
    });
    return {
      runId,
      persist: async (checkpoint) => {
        state = { ...state, graphCheckpoint: structuredClone(checkpoint) };
        operation = { ...operation, status: 'dispatched', updatedAt: checkpoint.updatedAt };
        await this.kernel.checkpoint({
          runId,
          attempt: created.attempt.attempt,
          owner: created.owner,
          now: checkpoint.updatedAt,
          status: checkpoint.status === 'waiting' || checkpoint.status === 'requires_review' ? 'waiting' : 'running',
          state,
          engineCursor: cursor,
          pendingOperations: [operation],
          events: [{ type: 'auto_agent_graph_checkpoint', payload: { graphId: input.graphId }, recordedAt: checkpoint.updatedAt }],
        });
      },
      terminal: async (status, reason, terminalAt = Date.now()) => {
        operation = {
          ...operation,
          status: status === 'completed' ? 'succeeded' : 'failed',
          resultRef: status === 'completed' ? `auto-agent:${input.graphId}:completed` : operation.resultRef,
          updatedAt: terminalAt,
        };
        await this.kernel.checkpoint({
          runId,
          attempt: created.attempt.attempt,
          owner: created.owner,
          now: terminalAt,
          status: 'running',
          state,
          engineCursor: cursor,
          pendingOperations: [operation],
          events: [{ type: 'auto_agent_result_committed', payload: { status }, recordedAt: terminalAt }],
        });
        await this.kernel.terminal({
          runId,
          attempt: created.attempt.attempt,
          owner: created.owner,
          now: terminalAt + 1,
          status,
          reason,
          event: { type: `agent_team_${status}`, payload: { runtime: 'auto_agent' }, recordedAt: terminalAt + 1 },
        });
        await this.parentHost.projectAgentTeamChildTerminal({
          parentRunId: input.parentRunId,
          teamRunId: runId,
          status,
          resultRef: operation.resultRef,
          now: terminalAt + 1,
        });
      },
    };
  }
}

let configuredRuntime: AutoAgentDurableRuntime | null = null;

export function configureAutoAgentDurableRuntime(runtime: AutoAgentDurableRuntime | null): void {
  configuredRuntime = runtime;
}

export function getAutoAgentDurableRuntime(): AutoAgentDurableRuntime | null {
  return configuredRuntime;
}
