import { afterEach, describe, expect, it } from 'vitest';

import { TeammateService } from '../../../src/host/agent/teammate/teammateService';
import { getEventBus, shutdownEventBus } from '../../../src/host/services/eventing/bus';
import {
  createScopedSwarmAgentId,
  createScopedSwarmMessageId,
  parseScopedSwarmMessageId,
  type SwarmEvent,
  type SwarmRunScope,
} from '../../../src/shared/contract/swarm';

const SCOPE_A: SwarmRunScope = {
  sessionId: 'session-a',
  runId: 'run-a',
  treeId: 'tree-a',
};

const SCOPE_B: SwarmRunScope = {
  sessionId: 'session-b',
  runId: 'run-b',
  treeId: 'tree-b',
};

const FOREIGN_TREE_SCOPE: SwarmRunScope = {
  ...SCOPE_A,
  treeId: 'tree-foreign',
};

const SAME_SESSION_OTHER_RUN_SCOPE: SwarmRunScope = {
  sessionId: SCOPE_A.sessionId,
  runId: 'run-other',
  treeId: 'tree-other',
};

describe('TeammateService run scope', () => {
  afterEach(() => {
    shutdownEventBus();
  });

  it('keeps same-role histories isolated and preserves message identity in SwarmEvent', () => {
    const service = new TeammateService();
    const agentA = createScopedSwarmAgentId(SCOPE_A, 'agent_reviewer_0');
    const agentB = createScopedSwarmAgentId(SCOPE_B, 'agent_reviewer_0');
    service.register(agentA, 'Reviewer', 'reviewer');
    service.register(agentB, 'Reviewer', 'reviewer');

    const events: SwarmEvent[] = [];
    getEventBus().subscribe<SwarmEvent>('swarm', (event) => { events.push(event.data); });

    const messageA = service.onUserMessage(SCOPE_A, agentA, 'message-a', {
      id: 'source-message',
      timestamp: 101,
    });
    const messageB = service.onUserMessage(SCOPE_B, agentB, 'message-b', {
      id: 'source-message',
      timestamp: 202,
    });

    expect(service.getHistory(SCOPE_A)).toEqual([messageA]);
    expect(service.getHistory(SCOPE_B)).toEqual([messageB]);
    expect(service.getInbox(agentA)).toEqual([messageA]);
    expect(service.getInbox(agentB)).toEqual([messageB]);
    expect(messageA.id).toBe(createScopedSwarmMessageId(SCOPE_A, 'source-message'));
    expect(messageB.id).toBe(createScopedSwarmMessageId(SCOPE_B, 'source-message'));
    expect(messageA.id).not.toBe(messageB.id);
    expect(parseScopedSwarmMessageId(messageA.id)?.scope).toEqual(SCOPE_A);
    expect(parseScopedSwarmMessageId(messageB.id)?.scope).toEqual(SCOPE_B);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      sessionId: SCOPE_A.sessionId,
      runId: SCOPE_A.runId,
      treeId: SCOPE_A.treeId,
      timestamp: 101,
      data: { message: { id: messageA.id, content: 'message-a' } },
    });
    expect(events[1]).toMatchObject({
      sessionId: SCOPE_B.sessionId,
      runId: SCOPE_B.runId,
      treeId: SCOPE_B.treeId,
      timestamp: 202,
      data: { message: { id: messageB.id, content: 'message-b' } },
    });
  });

  it('limits broadcast delivery to the sender run', () => {
    const service = new TeammateService();
    const senderA = createScopedSwarmAgentId(SCOPE_A, 'agent_reviewer_0');
    const peerA = createScopedSwarmAgentId(SCOPE_A, 'agent_coder_0');
    const sameRoleB = createScopedSwarmAgentId(SCOPE_B, 'agent_reviewer_0');
    service.register(senderA, 'Reviewer A', 'reviewer');
    service.register(peerA, 'Coder A', 'coder');
    service.register(sameRoleB, 'Reviewer B', 'reviewer');

    service.send({
      scope: SCOPE_A,
      from: senderA,
      to: 'all',
      type: 'broadcast',
      content: 'only-a',
      id: 'broadcast-a',
      timestamp: 303,
    });

    expect(service.getInbox(peerA).map((message) => message.content)).toEqual(['only-a']);
    expect(service.getInbox(sameRoleB)).toEqual([]);
    expect(service.getHistory(SCOPE_A).map((message) => message.id)).toEqual([
      createScopedSwarmMessageId(SCOPE_A, 'broadcast-a'),
    ]);
    expect(service.getHistory(SCOPE_B)).toEqual([]);
  });

  it('keeps an unscoped legacy broadcast out of every scoped Team mailbox', () => {
    const service = new TeammateService();
    const agentA = createScopedSwarmAgentId(SCOPE_A, 'agent_reviewer_0');
    const agentB = createScopedSwarmAgentId(SCOPE_B, 'agent_reviewer_0');
    service.register('legacy-sender', 'Legacy Sender', 'orchestrator');
    service.register('legacy-peer', 'Legacy Peer', 'worker');
    service.register(agentA, 'Reviewer A', 'reviewer');
    service.register(agentB, 'Reviewer B', 'reviewer');

    service.send({
      from: 'legacy-sender',
      to: 'all',
      type: 'broadcast',
      content: 'legacy-only',
    });

    expect(service.getInbox('legacy-peer').map((message) => message.content)).toEqual(['legacy-only']);
    expect(service.getInbox(agentA, SCOPE_A)).toEqual([]);
    expect(service.getInbox(agentB, SCOPE_B)).toEqual([]);
  });

  it('refuses a direct message whose composite identities belong to different runs', () => {
    const service = new TeammateService();
    const agentA = createScopedSwarmAgentId(SCOPE_A, 'agent_reviewer_0');
    const agentB = createScopedSwarmAgentId(SCOPE_B, 'agent_reviewer_0');

    expect(() => service.send({
      scope: SCOPE_A,
      from: agentA,
      to: agentB,
      type: 'coordination',
      content: 'cross-run',
    })).toThrow(/Cross-run teammate message refused/);
  });

  it('does not expose agents or history from a foreign tree in the same run', () => {
    const service = new TeammateService();
    const agentA = createScopedSwarmAgentId(SCOPE_A, 'agent_reviewer_0');
    const foreignTreeAgent = createScopedSwarmAgentId(FOREIGN_TREE_SCOPE, 'agent_reviewer_0');
    service.register(agentA, 'Reviewer A', 'reviewer');
    service.register(foreignTreeAgent, 'Reviewer Foreign', 'reviewer');

    service.onUserMessage(SCOPE_A, agentA, 'tree-a');
    service.onUserMessage(FOREIGN_TREE_SCOPE, foreignTreeAgent, 'tree-foreign');

    expect(service.listAgents(SCOPE_A).map((agent) => agent.id)).toEqual([agentA]);
    expect(service.getHistory(SCOPE_A).map((message) => message.content)).toEqual(['tree-a']);
    expect(service.getInbox(foreignTreeAgent, SCOPE_A)).toEqual([]);
    expect(() => service.send({
      scope: SCOPE_A,
      from: agentA,
      to: foreignTreeAgent,
      type: 'coordination',
      content: 'cross-tree',
    })).toThrow(/Cross-run teammate message refused/);
  });

  it('filters root discovery by session while full run discovery stays tree-strict', () => {
    const service = new TeammateService();
    const agentA = createScopedSwarmAgentId(SCOPE_A, 'agent_reviewer_0');
    const sameSessionOtherRun = createScopedSwarmAgentId(
      SAME_SESSION_OTHER_RUN_SCOPE,
      'agent_reviewer_0',
    );
    const foreignSession = createScopedSwarmAgentId(SCOPE_B, 'agent_reviewer_0');
    service.register(agentA, 'Reviewer A', 'reviewer');
    service.register(sameSessionOtherRun, 'Reviewer A2', 'reviewer');
    service.register(foreignSession, 'Reviewer B', 'reviewer');
    service.register('legacy-process-agent', 'Legacy', 'reviewer');

    expect(service.listAgents({ sessionId: SCOPE_A.sessionId }).map((agent) => agent.id)).toEqual([
      agentA,
      sameSessionOtherRun,
    ]);
    expect(service.listAgents(SCOPE_A).map((agent) => agent.id)).toEqual([agentA]);
  });
});
