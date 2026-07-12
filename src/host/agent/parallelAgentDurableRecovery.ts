import type { AgentMessage } from './spawnGuard';
import type { AgentTeamCheckpointState } from './agentTeamDurableTypes';
import type { AgentTeamRecoveryDecision } from './agentTeamRecovery';
import {
  isSameRunScope,
  type AgentTask,
  type AgentTaskResult,
} from './parallelAgentCoordinatorTypes';
import type { SwarmRunScope } from '../../shared/contract/swarm';

export function restoreParallelAgentDurableState(input: {
  scope?: SwarmRunScope;
  state: AgentTeamCheckpointState;
  decision: AgentTeamRecoveryDecision;
}) {
  if (!input.scope || !isSameRunScope(input.scope, input.state.scope)) {
    throw new Error('Durable Agent Team checkpoint scope does not match coordinator scope');
  }
  const taskDefinitions = new Map<string, AgentTask>();
  const completedTasks = new Map<string, AgentTaskResult>();
  const messageQueues = new Map<string, AgentMessage[]>();
  for (const node of input.state.taskGraph) {
    taskDefinitions.set(node.id, {
      id: node.id,
      role: node.role,
      task: node.task,
      tools: [...node.tools],
      dependsOn: [...node.dependsOn],
    });
    const pendingMessages = input.state.mailbox.pending
      .filter((message) => message.agentId === node.id && message.treeId === input.state.treeId)
      .filter((message) => !input.state.mailbox.consumedMessageIds.includes(message.id))
      .sort((left, right) => left.seq - right.seq);
    messageQueues.set(node.id, pendingMessages.map((message) => ({
      id: message.id,
      seq: message.seq,
      type: message.type as AgentMessage['type'],
      from: message.from,
      payload: message.body,
      timestamp: message.createdAt,
    })));
    const nodeDecision = input.decision.nodes.find((candidate) => candidate.nodeId === node.id);
    if (nodeDecision?.classification === 'reuse_completed' && node.result) {
      completedTasks.set(node.id, { ...node.result, toolsUsed: [...node.result.toolsUsed] });
    }
  }
  return {
    taskDefinitions,
    completedTasks,
    messageQueues,
    sharedContext: {
      findings: input.state.findings,
      decisions: input.state.decisions,
      errors: input.state.errors,
    },
    cancelled: input.state.cancelled,
    cancelReason: input.state.cancelled ? 'parent-cancel' : 'cancelled',
    graphCheckpoint: input.state.graphCheckpoint
      ? structuredClone(input.state.graphCheckpoint)
      : undefined,
  };
}
