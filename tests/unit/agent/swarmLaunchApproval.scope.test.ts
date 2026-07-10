import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/host/platform', () => ({
  AppWindow: { getAllWindows: () => [{}] },
}));

import { SwarmLaunchApprovalGate } from '../../../src/host/agent/swarmLaunchApproval';
import { getEventBus, shutdownEventBus } from '../../../src/host/services/eventing/bus';
import type { SwarmEvent, SwarmRunScope } from '../../../src/shared/contract/swarm';

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

const TASK = {
  id: 'same-role-task',
  role: 'reviewer',
  task: 'review',
  tools: ['Read'],
  writeAccess: false,
};

describe('SwarmLaunchApprovalGate run scope', () => {
  afterEach(() => {
    vi.useRealTimers();
    shutdownEventBus();
  });

  it('validates approve scope and cancels only the selected run', async () => {
    vi.useFakeTimers();
    const gate = new SwarmLaunchApprovalGate({ approvalTimeoutMs: 60_000 });
    const events: SwarmEvent[] = [];
    getEventBus().subscribe<SwarmEvent>('swarm', (event) => events.push(event.data));

    const pendingA = gate.requestApproval({ scope: SCOPE_A, tasks: [TASK] });
    const pendingB = gate.requestApproval({ scope: SCOPE_B, tasks: [TASK] });
    await vi.advanceTimersByTimeAsync(0);

    const requestA = gate.getPendingRequests(SCOPE_A)[0];
    const requestB = gate.getPendingRequests(SCOPE_B)[0];
    expect(gate.approve(requestA.id, 'wrong', SCOPE_B)).toBe(false);
    expect(gate.cancelRun(SCOPE_A, 'targeted')).toBe(1);
    await expect(pendingA).resolves.toMatchObject({ approved: false, autoApproved: true });
    expect(gate.getPendingRequests(SCOPE_A)).toEqual([]);
    expect(gate.getPendingRequests(SCOPE_B).map((request) => request.id)).toEqual([requestB.id]);

    expect(gate.approve(requestB.id, 'ok', SCOPE_B)).toBe(true);
    await expect(pendingB).resolves.toMatchObject({ approved: true });

    const rejectedA = events.find((event) =>
      event.type === 'swarm:launch:rejected' && event.data.launchRequest?.id === requestA.id
    );
    const approvedB = events.find((event) =>
      event.type === 'swarm:launch:approved' && event.data.launchRequest?.id === requestB.id
    );
    expect(rejectedA).toMatchObject(SCOPE_A);
    expect(approvedB).toMatchObject(SCOPE_B);
  });

  it('session cancellation drains current launches without poisoning a future run', async () => {
    vi.useFakeTimers();
    const gate = new SwarmLaunchApprovalGate({ approvalTimeoutMs: 60_000 });
    const pendingA = gate.requestApproval({ scope: SCOPE_A, tasks: [TASK] });
    const pendingB = gate.requestApproval({ scope: SCOPE_B, tasks: [TASK] });
    await vi.advanceTimersByTimeAsync(0);
    expect(gate.cancelSession(SCOPE_A.sessionId, 'session-switch')).toBe(1);
    await expect(pendingA).resolves.toMatchObject({ approved: false, autoApproved: true });
    const requestB = gate.getPendingRequests(SCOPE_B)[0];
    expect(requestB).toBeDefined();
    expect(gate.approve(requestB.id, 'ok', SCOPE_B)).toBe(true);
    await expect(pendingB).resolves.toMatchObject({ approved: true });

    const futureScope: SwarmRunScope = { ...SCOPE_A, runId: 'run-future', treeId: 'tree-future' };
    const future = gate.requestApproval({ scope: futureScope, tasks: [TASK] });
    await vi.advanceTimersByTimeAsync(0);
    const futureRequest = gate.getPendingRequests(futureScope)[0];
    expect(futureRequest).toBeDefined();
    expect(gate.approve(futureRequest.id, 'ok', futureScope)).toBe(true);
    await expect(future).resolves.toMatchObject({ approved: true });
  });
});
