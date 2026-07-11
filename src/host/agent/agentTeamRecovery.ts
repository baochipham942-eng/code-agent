import type { PendingOperation } from '../../shared/contract/durableRun';
import type { RunRehydrationPlan } from '../runtime/durableRunStores';
import type { ParallelAgentCoordinator } from './parallelAgentCoordinator';
import {
  isAgentTeamCheckpointState,
  type AgentTeamCheckpointNode,
  type AgentTeamCheckpointState,
} from './agentTeamDurableTypes';

export type AgentTeamRecoveryClassification =
  | 'reuse_completed'
  | 'retry_safe'
  | 'waiting_for_approval'
  | 'requires_review'
  | 'failed'
  | 'cancelled';

export interface AgentTeamNodeRecoveryDecision {
  nodeId: string;
  classification: AgentTeamRecoveryClassification;
  reason: string;
  operationId?: string;
  resultRef?: string;
}

export interface AgentTeamRecoveryDecision {
  runId: string;
  treeId?: string;
  classification: AgentTeamRecoveryClassification;
  nodes: AgentTeamNodeRecoveryDecision[];
  orphanChildRefs: string[];
  checkpoint: AgentTeamCheckpointState | null;
}

export function canRecoverAgentTeam(plan: RunRehydrationPlan): boolean {
  return plan.envelope.engine.kind === 'agent_team' && isAgentTeamCheckpointState(plan.checkpoint?.state);
}

function operationFor(plan: RunRehydrationPlan, node: AgentTeamCheckpointNode): PendingOperation | undefined {
  return plan.pendingOperations.find((operation) => operation.operationId === node.operationId);
}

function classifyNode(plan: RunRehydrationPlan, state: AgentTeamCheckpointState, node: AgentTeamCheckpointNode): AgentTeamNodeRecoveryDecision {
  const operation = operationFor(plan, node);
  if (state.cancelled || plan.envelope.status === 'cancelled' || node.status === 'cancelled') {
    return { nodeId: node.id, classification: 'cancelled', reason: 'Parent Team is cancelled', operationId: node.operationId };
  }
  if (node.status === 'completed' && node.resultRef) {
    return { nodeId: node.id, classification: 'reuse_completed', reason: 'Durable result evidence is complete', operationId: node.operationId, resultRef: node.resultRef };
  }
  const waitingApproval = state.pendingApprovalRefs.find((approval) => approval.status === 'waiting');
  if (waitingApproval) {
    return { nodeId: node.id, classification: 'waiting_for_approval', reason: `Preserve approval ${waitingApproval.approvalId}`, operationId: node.operationId };
  }
  if (node.status === 'failed' || node.status === 'blocked') {
    return { nodeId: node.id, classification: 'failed', reason: node.error ?? `Node is ${node.status}`, operationId: node.operationId };
  }
  const dispatched = node.status === 'dispatched' || operation?.status === 'dispatched' || operation?.status === 'unknown';
  if (dispatched && node.sideEffect) {
    if (operation?.providerOperationId && operation.requiresHumanConfirmation !== true) {
      return { nodeId: node.id, classification: 'retry_safe', reason: 'Provider operation can be queried or deduplicated', operationId: node.operationId };
    }
    return { nodeId: node.id, classification: 'requires_review', reason: 'Side-effecting dispatch has no terminal evidence', operationId: node.operationId };
  }
  return { nodeId: node.id, classification: 'retry_safe', reason: 'Node is read-only or was not dispatched', operationId: node.operationId };
}

function rollup(nodes: AgentTeamNodeRecoveryDecision[], orphanChildRefs: string[]): AgentTeamRecoveryClassification {
  if (orphanChildRefs.length > 0 || nodes.some((node) => node.classification === 'requires_review')) return 'requires_review';
  if (nodes.some((node) => node.classification === 'waiting_for_approval')) return 'waiting_for_approval';
  if (nodes.length > 0 && nodes.every((node) => node.classification === 'cancelled')) return 'cancelled';
  if (nodes.some((node) => node.classification === 'failed')) return 'failed';
  if (nodes.some((node) => node.classification === 'retry_safe')) return 'retry_safe';
  return 'reuse_completed';
}

export function buildAgentTeamRecoveryDecision(plan: RunRehydrationPlan): AgentTeamRecoveryDecision {
  if (plan.envelope.engine.kind !== 'agent_team') {
    throw new Error(`Run ${plan.envelope.runId} is not an Agent Team run`);
  }
  const state = isAgentTeamCheckpointState(plan.checkpoint?.state) ? plan.checkpoint.state : null;
  if (!state) {
    return {
      runId: plan.envelope.runId,
      treeId: plan.envelope.engine.treeId,
      classification: 'requires_review',
      nodes: [],
      orphanChildRefs: plan.childRuns.map((child) => child.childRunId),
      checkpoint: null,
    };
  }
  const known = new Set(state.taskGraph.map((node) => node.id));
  const orphanChildRefs = [...new Set([
    ...state.runningChildRefs,
    ...plan.childRuns.map((child) => child.childRunId),
  ])].filter((childRef) => !known.has(childRef));
  const nodes = state.taskGraph.map((node) => classifyNode(plan, state, node));
  return {
    runId: plan.envelope.runId,
    treeId: state.treeId,
    classification: rollup(nodes, orphanChildRefs),
    nodes,
    orphanChildRefs,
    checkpoint: state,
  };
}

export interface AgentTeamRehydrateDeps {
  createCoordinator(state: AgentTeamCheckpointState, ownerEpoch: number): ParallelAgentCoordinator;
}

export async function rehydrateAgentTeam(
  plan: RunRehydrationPlan,
  deps: AgentTeamRehydrateDeps,
): Promise<{ decision: AgentTeamRecoveryDecision; coordinator?: ParallelAgentCoordinator }> {
  const decision = buildAgentTeamRecoveryDecision(plan);
  if (!decision.checkpoint || decision.classification === 'requires_review' || decision.classification === 'failed') {
    return { decision };
  }
  const coordinator = deps.createCoordinator(decision.checkpoint, plan.envelope.owner?.epoch ?? 0);
  coordinator.restoreDurableState(decision.checkpoint, decision, plan.envelope.owner?.epoch);
  if (decision.classification === 'cancelled') coordinator.abortAllRunning('parent-cancel');
  return { decision, coordinator };
}
