import { afterEach, describe, expect, it, vi } from 'vitest';

import { PlanApprovalGate } from '../../../src/host/agent/planApproval';
import { resetTeammateService } from '../../../src/host/agent/teammate/teammateService';
import { getEventBus, shutdownEventBus } from '../../../src/host/services/eventing/bus';
import {
  createScopedSwarmAgentId,
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

describe('PlanApprovalGate run scope', () => {
  afterEach(() => {
    vi.useRealTimers();
    resetTeammateService();
    shutdownEventBus();
  });

  it('runs queues independently and cancelRun settles only its target run', async () => {
    vi.useFakeTimers();
    const gate = new PlanApprovalGate({ approvalTimeoutMs: 60_000 });
    const agentA = createScopedSwarmAgentId(SCOPE_A, 'agent_reviewer_0');
    const agentB = createScopedSwarmAgentId(SCOPE_B, 'agent_reviewer_0');
    const events: SwarmEvent[] = [];
    getEventBus().subscribe<SwarmEvent>('swarm', (event) => { events.push(event.data); });

    const pendingA = gate.submitForApproval({
      scope: SCOPE_A,
      agentId: agentA,
      agentName: 'Reviewer',
      coordinatorId: 'coordinator',
      plan: 'plan-a',
      risk: { level: 'medium', reasons: ['risk-a'] },
    });
    const pendingB = gate.submitForApproval({
      scope: SCOPE_B,
      agentId: agentB,
      agentName: 'Reviewer',
      coordinatorId: 'coordinator',
      plan: 'plan-b',
      risk: { level: 'medium', reasons: ['risk-b'] },
    });
    await vi.advanceTimersByTimeAsync(0);

    const planA = gate.getPendingPlans(SCOPE_A)[0];
    const planB = gate.getPendingPlans(SCOPE_B)[0];
    expect(planA).toBeDefined();
    expect(planB).toBeDefined();
    expect(gate.approve(planA.id, 'wrong run', {
      sessionId: SCOPE_B.sessionId,
      runId: SCOPE_B.runId,
      agentId: agentA,
    })).toBe(false);

    expect(gate.cancelRun(SCOPE_A, 'targeted')).toBe(1);
    await expect(pendingA).resolves.toMatchObject({ approved: false, autoApproved: true });
    expect(gate.getPendingPlans(SCOPE_A)).toEqual([]);
    expect(gate.getPendingPlans(SCOPE_B).map((plan) => plan.id)).toEqual([planB.id]);

    expect(gate.approve(planB.id, 'ok', {
      sessionId: SCOPE_B.sessionId,
      runId: SCOPE_B.runId,
      agentId: agentB,
    })).toBe(true);
    await expect(pendingB).resolves.toMatchObject({ approved: true });

    const rejected = events.find((event) =>
      event.type === 'swarm:agent:plan_rejected' && event.data.plan?.id === planA.id
    );
    const approved = events.find((event) =>
      event.type === 'swarm:agent:plan_approved' && event.data.plan?.id === planB.id
    );
    expect(rejected).toMatchObject(SCOPE_A);
    expect(approved).toMatchObject(SCOPE_B);
  });

  it('rejects a late plan after the run was cancelled before a queue existed', async () => {
    const gate = new PlanApprovalGate({ approvalTimeoutMs: 60_000 });
    const agentA = createScopedSwarmAgentId(SCOPE_A, 'agent_reviewer_0');

    expect(gate.cancelRun(SCOPE_A, 'cancelled-before-submit')).toBe(0);

    await expect(gate.submitForApproval({
      scope: SCOPE_A,
      agentId: agentA,
      agentName: 'Reviewer',
      coordinatorId: 'coordinator',
      plan: 'late-plan',
      risk: { level: 'medium', reasons: ['late'] },
    })).resolves.toEqual({
      approved: false,
      feedback: 'Cancelled: cancelled-before-submit',
      autoApproved: true,
    });
    expect(gate.getPendingPlans(SCOPE_A)).toEqual([]);
  });

  it('cancels one approval-blocked agent without touching the same role in another Team', async () => {
    vi.useFakeTimers();
    const gate = new PlanApprovalGate({ approvalTimeoutMs: 60_000 });
    const agentA = createScopedSwarmAgentId(SCOPE_A, 'agent_reviewer_0');
    const agentB = createScopedSwarmAgentId(SCOPE_B, 'agent_reviewer_0');
    const pendingA = gate.submitForApproval({
      scope: SCOPE_A,
      agentId: agentA,
      agentName: 'Reviewer A',
      coordinatorId: 'coordinator',
      plan: 'plan-a',
      risk: { level: 'medium', reasons: ['review'] },
    });
    const pendingB = gate.submitForApproval({
      scope: SCOPE_B,
      agentId: agentB,
      agentName: 'Reviewer B',
      coordinatorId: 'coordinator',
      plan: 'plan-b',
      risk: { level: 'medium', reasons: ['review'] },
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(gate.cancelAgent({ ...SCOPE_A, agentId: agentA }, 'user-cancel')).toBe(1);
    await expect(pendingA).resolves.toMatchObject({
      approved: false,
      feedback: 'Cancelled: user-cancel',
    });
    expect(gate.getPendingPlans(SCOPE_B)).toHaveLength(1);

    const retryA = gate.submitForApproval({
      scope: SCOPE_A,
      agentId: agentA,
      agentName: 'Reviewer A retry',
      coordinatorId: 'coordinator',
      plan: 'retry-plan-a',
      risk: { level: 'medium', reasons: ['review'] },
    });
    await vi.advanceTimersByTimeAsync(0);
    const retryPlanA = gate.getPendingPlans(SCOPE_A)[0];
    expect(retryPlanA).toBeDefined();
    expect(gate.approve(retryPlanA.id, 'retry-ok', { ...SCOPE_A, agentId: agentA })).toBe(true);
    await expect(retryA).resolves.toMatchObject({ approved: true });

    const planB = gate.getPendingPlans(SCOPE_B)[0];
    expect(gate.approve(planB.id, 'ok', { ...SCOPE_B, agentId: agentB })).toBe(true);
    await expect(pendingB).resolves.toMatchObject({ approved: true });
  });

  it('cancels a queued agent before its plan is created', async () => {
    vi.useFakeTimers();
    const gate = new PlanApprovalGate({ approvalTimeoutMs: 60_000 });
    const agentA = createScopedSwarmAgentId(SCOPE_A, 'agent_reviewer_0');
    const agentB = createScopedSwarmAgentId(SCOPE_A, 'agent_writer_1');
    const controllerB = new AbortController();
    const pendingA = gate.submitForApproval({
      scope: SCOPE_A,
      agentId: agentA,
      agentName: 'Reviewer A',
      coordinatorId: 'coordinator',
      plan: 'plan-a',
      risk: { level: 'medium', reasons: ['review'] },
    });
    const pendingB = gate.submitForApproval({
      scope: SCOPE_A,
      agentId: agentB,
      agentName: 'Writer B',
      coordinatorId: 'coordinator',
      plan: 'plan-b',
      risk: { level: 'medium', reasons: ['write'] },
      signal: controllerB.signal,
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(gate.getPendingPlans(SCOPE_A).map((plan) => plan.agentId)).toEqual([agentA]);
    expect(gate.cancelAgent({ ...SCOPE_A, agentId: agentB }, 'user-cancel')).toBe(0);
    controllerB.abort('user-cancel');
    const planA = gate.getPendingPlans(SCOPE_A)[0];
    expect(gate.approve(planA.id, 'ok', { ...SCOPE_A, agentId: agentA })).toBe(true);
    await expect(pendingA).resolves.toMatchObject({ approved: true });
    await expect(pendingB).resolves.toMatchObject({
      approved: false,
      feedback: 'Cancelled: user-cancel',
    });
    expect(gate.getPendingPlans(SCOPE_A)).toEqual([]);

    const retryB = gate.submitForApproval({
      scope: SCOPE_A,
      agentId: agentB,
      agentName: 'Writer B retry',
      coordinatorId: 'coordinator',
      plan: 'retry-plan-b',
      risk: { level: 'medium', reasons: ['write'] },
    });
    await vi.advanceTimersByTimeAsync(0);
    const retryPlanB = gate.getPendingPlans(SCOPE_A)[0];
    expect(retryPlanB).toBeDefined();
    expect(gate.approve(retryPlanB.id, 'retry-ok', { ...SCOPE_A, agentId: agentB })).toBe(true);
    await expect(retryB).resolves.toMatchObject({ approved: true });
  });

  it('AbortSignal drains a pending descendant plan immediately', async () => {
    vi.useFakeTimers();
    const gate = new PlanApprovalGate({ approvalTimeoutMs: 60_000 });
    const controller = new AbortController();
    const agentA = createScopedSwarmAgentId(SCOPE_A, 'agent_nested_0');
    const pending = gate.submitForApproval({
      scope: SCOPE_A,
      agentId: agentA,
      agentName: 'Nested Agent',
      coordinatorId: 'coordinator',
      plan: 'nested-plan',
      risk: { level: 'medium', reasons: ['write'] },
      signal: controller.signal,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(gate.getPendingPlans(SCOPE_A)).toHaveLength(1);

    controller.abort('parent-cancel');
    await expect(pending).resolves.toMatchObject({
      approved: false,
      feedback: 'Cancelled: parent-cancel',
    });
    expect(gate.getPendingPlans(SCOPE_A)).toEqual([]);
  });

  it('session cancellation drains current plans without poisoning a future run', async () => {
    vi.useFakeTimers();
    const gate = new PlanApprovalGate({ approvalTimeoutMs: 60_000 });
    const agentA = createScopedSwarmAgentId(SCOPE_A, 'agent_reviewer_0');
    const agentB = createScopedSwarmAgentId(SCOPE_B, 'agent_reviewer_0');
    const pendingA = gate.submitForApproval({
      scope: SCOPE_A,
      agentId: agentA,
      agentName: 'Reviewer A',
      coordinatorId: 'coordinator',
      plan: 'active-a',
      risk: { level: 'medium', reasons: ['review'] },
    });
    const pendingB = gate.submitForApproval({
      scope: SCOPE_B,
      agentId: agentB,
      agentName: 'Reviewer B',
      coordinatorId: 'coordinator',
      plan: 'active-b',
      risk: { level: 'medium', reasons: ['review'] },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(gate.cancelSession(SCOPE_A.sessionId, 'session-switch')).toBe(1);
    await expect(pendingA).resolves.toMatchObject({ approved: false, autoApproved: true });
    const planB = gate.getPendingPlans(SCOPE_B)[0];
    expect(planB).toBeDefined();
    expect(gate.approve(planB.id, 'ok', {
      sessionId: SCOPE_B.sessionId,
      runId: SCOPE_B.runId,
      agentId: agentB,
    })).toBe(true);
    await expect(pendingB).resolves.toMatchObject({ approved: true });

    const futureScope: SwarmRunScope = { ...SCOPE_A, runId: 'run-future', treeId: 'tree-future' };
    const futureAgent = createScopedSwarmAgentId(futureScope, 'agent_reviewer_0');
    const future = gate.submitForApproval({
      scope: futureScope,
      agentId: futureAgent,
      agentName: 'Reviewer Future',
      coordinatorId: 'coordinator',
      plan: 'future-plan',
      risk: { level: 'medium', reasons: ['review'] },
    });
    await vi.advanceTimersByTimeAsync(0);
    const futurePlan = gate.getPendingPlans(futureScope)[0];
    expect(futurePlan).toBeDefined();
    expect(gate.approve(futurePlan.id, 'ok', {
      sessionId: futureScope.sessionId,
      runId: futureScope.runId,
      agentId: futureAgent,
    })).toBe(true);
    await expect(future).resolves.toMatchObject({ approved: true });
  });
});
