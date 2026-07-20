import { describe, expect, it } from 'vitest';
import type { SurfaceTargetRefV1 } from '../../../../src/shared/contract/surfaceExecution';
import { SurfaceAccessGrantService } from '../../../../src/host/services/surfaceExecution/SurfaceAccessGrantService';
import { SurfaceCapabilityRegistry } from '../../../../src/host/services/surfaceExecution/SurfaceCapabilityRegistry';
import { SurfaceObservationRegistry } from '../../../../src/host/services/surfaceExecution/SurfaceObservationRegistry';
import { SurfaceSessionManager } from '../../../../src/host/services/surfaceExecution/SurfaceSessionManager';

const target: SurfaceTargetRefV1 = {
  kind: 'browser',
  browserInstanceId: 'managed:agent-a',
  windowRef: 'window:1',
  tabRef: 'tab:opaque-1',
  origin: 'https://example.test',
  documentRevision: 'doc:1',
};

function createHarness() {
  let now = 1_000;
  let id = 0;
  const clock = () => now;
  const sessions = new SurfaceSessionManager({
    now: clock,
    createId: () => `surface-${++id}`,
  });
  const registry = new SurfaceCapabilityRegistry();
  const session = sessions.create({
    conversationId: 'conversation-1',
    runId: 'run-a',
    agentId: 'agent-a',
    surface: 'browser',
    provider: 'managed',
    activeTarget: target,
    capabilities: registry.buildManifest({
      surface: 'browser',
      provider: 'managed',
      operations: ['navigate', 'click', 'screenshot'],
      supports: { cancel: true, cleanup: true, successorObservation: true },
    }),
  });
  const subject = { sessionId: session.sessionId, runId: 'run-a', agentId: 'agent-a' };
  const grants = new SurfaceAccessGrantService(sessions, {
    now: clock,
    createId: () => `grant-${++id}`,
  });
  const observations = new SurfaceObservationRegistry(sessions, {
    now: clock,
    createId: () => `state-${++id}`,
    defaultTtlMs: 100,
  });
  return {
    sessions,
    session,
    subject,
    grants,
    observations,
    tick(ms: number) { now += ms; },
  };
}

describe('Surface owner/grant/observation stores', () => {
  it('fences sessions by run and agent and keeps terminal states immutable', () => {
    const { sessions, session, subject } = createHarness();
    expect(() => sessions.requireOwned(session.sessionId, {
      runId: 'run-b',
      agentId: 'agent-a',
    })).toThrow(/another run or agent/);
    sessions.transition(session.sessionId, subject, 'running');
    sessions.transition(session.sessionId, subject, 'completed');
    expect(() => sessions.transition(session.sessionId, subject, 'running'))
      .toThrow(/Invalid Surface session transition/);
  });

  it('validates grant owner, target revision, capability, action class, data scope, and single-use', () => {
    const { grants, subject } = createHarness();
    const grant = grants.issue({
      subject,
      target,
      capabilities: ['observe', 'input'],
      dataScopes: ['origin:https://example.test'],
      actionClasses: ['managed_browser:click'],
      ttlMs: 1_000,
      singleUse: true,
    });
    expect(grants.validate({
      grantId: grant.grantId,
      subject,
      target,
      requiredCapabilities: ['input'],
      actionClass: 'managed_browser:click',
      consume: true,
    }).consumedAt).toBe(1_000);
    expect(() => grants.validate({
      grantId: grant.grantId,
      subject,
      target,
      requiredCapabilities: ['input'],
      actionClass: 'managed_browser:click',
    })).toThrow(/expired, revoked, consumed, or owned/);
  });

  it('rejects cross-agent grant reuse and target revision drift', () => {
    const { grants, subject } = createHarness();
    const grant = grants.issue({
      subject,
      target,
      capabilities: ['observe'],
      dataScopes: [`tab:${target.kind === 'browser' ? target.tabRef : ''}`],
      actionClasses: ['managed_browser:screenshot'],
      ttlMs: 1_000,
    });
    expect(() => grants.validate({
      grantId: grant.grantId,
      subject: { ...subject, agentId: 'agent-b' },
      target,
      requiredCapabilities: ['observe'],
      actionClass: 'managed_browser:screenshot',
    })).toThrow(/another run or agent/);
    expect(() => grants.validate({
      grantId: grant.grantId,
      subject,
      target: { ...target, documentRevision: 'doc:2' },
      requiredCapabilities: ['observe'],
      actionClass: 'managed_browser:screenshot',
    })).toThrow(/does not cover this target revision/);
  });

  it('supersedes old observations, enforces provider generation, and expires state', () => {
    const { observations, subject, tick } = createHarness();
    const first = observations.register({
      subject,
      target,
      providerGeneration: 'provider:1',
      elementRefs: [{
        kind: 'browser-element',
        ref: 'element:1',
        stateId: 'placeholder',
        tabRef: 'tab:opaque-1',
        documentRevision: 'doc:1',
        backendNodeId: 42,
      }],
    });
    const second = observations.register({
      subject,
      target,
      providerGeneration: 'provider:1',
    });
    expect(observations.getOwned(first.stateId, subject)?.lifecycle).toBe('superseded');
    expect(() => observations.requireFresh({
      stateId: first.stateId,
      subject,
      target,
      providerGeneration: 'provider:1',
    })).toThrow(/consumed, superseded, or expired/);
    expect(() => observations.requireFresh({
      stateId: second.stateId,
      subject,
      target,
      providerGeneration: 'provider:2',
    })).toThrow(/Provider generation changed/);
    tick(101);
    expect(() => observations.requireFresh({
      stateId: second.stateId,
      subject,
      target,
      providerGeneration: 'provider:1',
    })).toThrow(/consumed, superseded, or expired/);
  });

  it('rejects invalid TTL, blocked evidence, and cross-target element refs', () => {
    const { grants, observations, subject } = createHarness();
    expect(() => grants.issue({
      subject,
      target,
      capabilities: ['observe'],
      dataScopes: ['*'],
      actionClasses: ['*'],
      ttlMs: Number.NaN,
    })).toThrow(/TTL must be a positive finite/);
    expect(() => observations.register({
      subject,
      target,
      providerGeneration: 'provider:1',
      redactionStatus: 'blocked',
    })).toThrow(/Blocked evidence/);
    expect(() => observations.register({
      subject,
      target,
      providerGeneration: 'provider:1',
      elementRefs: [{
        kind: 'browser-element',
        ref: 'element:wrong-tab',
        stateId: 'placeholder',
        tabRef: 'tab:other',
        documentRevision: 'doc:1',
        backendNodeId: 1,
      }],
    })).toThrow(/does not match the observation target revision/);
  });
});
