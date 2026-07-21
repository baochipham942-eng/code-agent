import { describe, expect, it } from 'vitest';
import type { SurfaceTargetRefV1 } from '../../../../src/shared/contract/surfaceExecution';
import { SurfaceAccessGrantService } from '../../../../src/host/services/surfaceExecution/SurfaceAccessGrantService';
import { SurfaceCapabilityRegistry } from '../../../../src/host/services/surfaceExecution/SurfaceCapabilityRegistry';
import { SurfaceEventHub } from '../../../../src/host/services/surfaceExecution/SurfaceEventHub';
import { SurfaceHumanTakeoverService } from '../../../../src/host/services/surfaceExecution/SurfaceHumanTakeoverService';
import { SurfaceInterruptService } from '../../../../src/host/services/surfaceExecution/SurfaceInterruptService';
import { SurfaceObservationRegistry } from '../../../../src/host/services/surfaceExecution/SurfaceObservationRegistry';
import { SurfaceOperationCoordinator } from '../../../../src/host/services/surfaceExecution/SurfaceOperationCoordinator';
import { SurfaceSessionManager } from '../../../../src/host/services/surfaceExecution/SurfaceSessionManager';

const target: SurfaceTargetRefV1 = {
  kind: 'browser',
  browserInstanceId: 'managed:agent-a',
  windowRef: 'window:1',
  tabRef: 'tab:opaque-1',
  origin: 'https://example.test',
  documentRevision: 'doc:1',
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createHarness() {
  let id = 0;
  const capabilities = new SurfaceCapabilityRegistry();
  const sessions = new SurfaceSessionManager({ createId: () => `surface-${++id}` });
  const session = sessions.create({
    conversationId: 'conversation-1',
    runId: 'run-a',
    agentId: 'agent-a',
    surface: 'browser',
    provider: 'managed',
    activeTarget: target,
    capabilities: capabilities.buildManifest({
      surface: 'browser',
      provider: 'managed',
      operations: ['screenshot', 'click'],
      supports: { cancel: true, pause: true, takeover: true, cleanup: true, successorObservation: true },
    }),
  });
  const subject = { sessionId: session.sessionId, runId: 'run-a', agentId: 'agent-a' };
  sessions.transition(session.sessionId, subject, 'running');
  const grants = new SurfaceAccessGrantService(sessions, { createId: () => `grant-${++id}` });
  const observations = new SurfaceObservationRegistry(sessions, { createId: () => `state-${++id}` });
  const events = new SurfaceEventHub(sessions, { createId: () => `event-${++id}` });
  const interrupts = new SurfaceInterruptService(sessions);
  const coordinator = new SurfaceOperationCoordinator(
    sessions,
    capabilities,
    grants,
    observations,
    interrupts,
    events,
  );
  const takeover = new SurfaceHumanTakeoverService(sessions, observations, interrupts, events);
  return {
    sessions,
    subject,
    grants,
    observations,
    events,
    interrupts,
    coordinator,
    takeover,
  };
}

describe('Surface control plane', () => {
  it('publishes monotonic, owner-scoped, redacted events', () => {
    const { events, subject } = createHarness();
    events.publish(subject, {
      phase: 'prepare',
      status: 'running',
      userSummary: 'Authorization: Bearer surface-secret-canary-event',
      target,
      evidenceRefs: [],
      artifactRefs: [],
      availableControls: ['stop'],
    });
    events.publish(subject, {
      phase: 'observe',
      status: 'succeeded',
      userSummary: 'Observed page',
      target,
      evidenceRefs: ['evidence-1'],
      artifactRefs: [],
      availableControls: ['end_session'],
    });
    const stored = events.listOwned(subject);
    expect(stored.map((event) => event.sequence)).toEqual([1, 2]);
    expect(JSON.stringify(stored)).not.toContain('surface-secret-canary-event');
    expect(() => events.listOwned({ ...subject, agentId: 'agent-b' })).toThrow(/another run or agent/);
  });

  it('removes an aborted queued waiter before it can dispatch', async () => {
    const { grants, coordinator, subject } = createHarness();
    const grant = grants.issue({
      subject,
      target,
      capabilities: ['observe'],
      dataScopes: ['*'],
      actionClasses: ['managed_browser:screenshot'],
      ttlMs: 5_000,
    });
    const first = deferred<{ delivery: 'confirmed'; verification: 'not_requested' }>();
    let firstStarted = false;
    let secondStarted = false;
    const firstRun = coordinator.execute({
      subject,
      operationId: 'op-1',
      toolName: 'browser_action',
      action: 'screenshot',
      arguments: { action: 'screenshot' },
      target,
      grantId: grant.grantId,
      providerGeneration: 'provider:1',
      deadlineMs: 5_000,
      async dispatch() {
        firstStarted = true;
        return first.promise;
      },
    });
    const secondAbort = new AbortController();
    const secondRun = coordinator.execute({
      subject,
      operationId: 'op-2',
      toolName: 'browser_action',
      action: 'screenshot',
      arguments: { action: 'screenshot' },
      target,
      grantId: grant.grantId,
      providerGeneration: 'provider:1',
      deadlineMs: 5_000,
      parentSignal: secondAbort.signal,
      async dispatch() {
        secondStarted = true;
        return { delivery: 'confirmed', verification: 'not_requested' };
      },
    });
    await Promise.resolve();
    expect(firstStarted).toBe(true);
    expect(coordinator.queuedCount(subject)).toBe(1);
    secondAbort.abort('cancel queued operation');
    await expect(secondRun).rejects.toThrow(/cancel queued operation/);
    first.resolve({ delivery: 'confirmed', verification: 'not_requested' });
    await expect(firstRun).resolves.toMatchObject({ overall: 'delivered_unverified' });
    expect(secondStarted).toBe(false);
  });

  it('stops an active mutation, aborts provider input, and releases input exactly once', async () => {
    const { grants, observations, coordinator, interrupts, sessions, subject } = createHarness();
    const grant = grants.issue({
      subject,
      target,
      capabilities: ['input'],
      dataScopes: ['*'],
      actionClasses: ['managed_browser:click'],
      ttlMs: 5_000,
    });
    const observation = observations.register({
      subject,
      target,
      providerGeneration: 'provider:1',
    });
    let providerAborted = false;
    let releaseCount = 0;
    const run = coordinator.execute({
      subject,
      operationId: 'op-click',
      toolName: 'browser_action',
      action: 'click',
      arguments: { action: 'click', selector: '#save' },
      target,
      grantId: grant.grantId,
      predecessorStateId: observation.stateId,
      providerGeneration: 'provider:1',
      deadlineMs: 5_000,
      releaseInput() {
        releaseCount += 1;
      },
      dispatch(signal) {
        return new Promise((_, reject) => {
          signal.addEventListener('abort', () => {
            providerAborted = true;
            reject(new Error('provider aborted'));
          }, { once: true });
        });
      },
    });
    await Promise.resolve();
    await interrupts.stop(subject);
    await expect(run).rejects.toThrow(/surface-stopped/);
    expect(providerAborted).toBe(true);
    expect(releaseCount).toBe(1);
    expect(sessions.get(subject.sessionId)?.state).toBe('stopping');
  });

  it('preserves delivery/verification semantics and validates successor observations', async () => {
    const { grants, observations, coordinator, events, subject } = createHarness();
    const grant = grants.issue({
      subject,
      target,
      capabilities: ['input'],
      dataScopes: ['*'],
      actionClasses: ['managed_browser:click'],
      ttlMs: 5_000,
    });
    const predecessor = observations.register({
      subject,
      target,
      providerGeneration: 'provider:1',
    });
    const result = await coordinator.execute({
      subject,
      operationId: 'op-verified',
      toolName: 'browser_action',
      action: 'click',
      arguments: { action: 'click', selector: '#save' },
      target,
      grantId: grant.grantId,
      predecessorStateId: predecessor.stateId,
      providerGeneration: 'provider:1',
      expectation: { kind: 'text_present', text: 'Saved' },
      deadlineMs: 5_000,
      async dispatch() {
        const successor = observations.register({
          subject,
          target,
          providerGeneration: 'provider:1',
          evidenceAssetIds: ['evidence-after'],
        });
        return {
          delivery: 'confirmed',
          verification: 'satisfied',
          successorObservation: successor,
          evidenceRefs: ['evidence-after'],
        };
      },
    });
    expect(result).toMatchObject({
      delivery: 'confirmed',
      verification: 'satisfied',
      overall: 'succeeded',
      evidenceRefs: ['evidence-after'],
    });
    expect(result.successorState?.stateId).toBeTruthy();
    expect(events.listOwned(subject).map((event) => event.sequence)).toEqual([1, 2]);
  });

  it('awaits cleanup and fails closed when cleanup cannot restore the target', async () => {
    const success = createHarness();
    let cleaned = false;
    success.interrupts.registerCleanup(success.subject, async () => {
      await Promise.resolve();
      cleaned = true;
    });
    await success.interrupts.endSession(success.subject);
    expect(cleaned).toBe(true);
    expect(success.sessions.get(success.subject.sessionId)?.state).toBe('completed');

    const failure = createHarness();
    failure.interrupts.registerCleanup(failure.subject, () => {
      throw new Error('tab return failed');
    });
    await expect(failure.interrupts.endSession(failure.subject)).rejects.toThrow(/tab return failed/);
    expect(failure.sessions.get(failure.subject.sessionId)?.state).toBe('failed');
  });

  it('runs provider cleanup during stop before leaving the session in stopping', async () => {
    const harness = createHarness();
    let cleanupCount = 0;
    harness.interrupts.registerCleanup(harness.subject, async () => {
      await Promise.resolve();
      cleanupCount += 1;
    });

    await harness.interrupts.stop(harness.subject);
    expect(cleanupCount).toBe(1);
    expect(harness.sessions.get(harness.subject.sessionId)?.state).toBe('stopping');

    await harness.interrupts.endSession(harness.subject);
    expect(cleanupCount).toBe(1);
    expect(harness.sessions.get(harness.subject.sessionId)?.state).toBe('completed');
  });

  it('runs blocking takeover with owner response and forces a fresh observation on resume', async () => {
    const { observations, takeover, sessions, subject } = createHarness();
    const observation = observations.register({
      subject,
      target,
      providerGeneration: 'provider:1',
    });
    const request = await takeover.request({
      subject,
      reason: 'Complete MFA',
      timeoutMs: 5_000,
    });
    expect(sessions.get(subject.sessionId)?.state).toBe('waiting_human');
    expect(observations.getOwned(observation.stateId, subject)?.lifecycle).toBe('superseded');
    expect(() => takeover.respond(request.requestId, { ...subject, agentId: 'agent-b' }, 'continue'))
      .toThrow(/another run or agent/);
    expect(takeover.respond(request.requestId, subject, 'continue')).toBe(true);
    await expect(request.wait).resolves.toBe('continue');
    expect(sessions.get(subject.sessionId)?.state).toBe('running');
  });
});
