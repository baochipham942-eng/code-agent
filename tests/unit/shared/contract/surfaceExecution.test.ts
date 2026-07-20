import { describe, expect, it } from 'vitest';
import {
  canTransitionSurfaceSessionV1,
  getSurfaceTargetRevisionV1,
  isSurfaceExecutionEventV1,
  sameSurfaceTargetV1,
  type SurfaceExecutionEventV1,
  type SurfaceTargetRefV1,
} from '../../../../src/shared/contract/surfaceExecution';

const browserTarget: SurfaceTargetRefV1 = {
  kind: 'browser',
  browserInstanceId: 'managed:agent-a',
  windowRef: 'window:1',
  tabRef: 'tab:opaque-a',
  documentRevision: 'doc:1',
};

describe('Surface Execution V1 contract', () => {
  it('allows only declared session transitions and keeps terminal states immutable', () => {
    expect(canTransitionSurfaceSessionV1('preparing', 'running')).toBe(true);
    expect(canTransitionSurfaceSessionV1('running', 'waiting_human')).toBe(true);
    expect(canTransitionSurfaceSessionV1('waiting_human', 'running')).toBe(true);
    expect(canTransitionSurfaceSessionV1('completed', 'running')).toBe(false);
    expect(canTransitionSurfaceSessionV1('failed', 'running')).toBe(false);
    expect(canTransitionSurfaceSessionV1('preparing', 'completed')).toBe(false);
  });

  it('binds target identity to opaque target refs and revision', () => {
    expect(sameSurfaceTargetV1(browserTarget, { ...browserTarget })).toBe(true);
    expect(sameSurfaceTargetV1(browserTarget, {
      ...browserTarget,
      documentRevision: 'doc:2',
    })).toBe(false);
    expect(getSurfaceTargetRevisionV1(browserTarget)).toBe('doc:1');
  });

  it('recognizes a complete V1 event without requiring provider-specific internals', () => {
    const event: SurfaceExecutionEventV1 = {
      version: 1,
      eventId: 'evt-1',
      sequence: 1,
      sessionId: 'surface-1',
      runId: 'run-1',
      agentId: 'agent-a',
      surface: 'browser',
      phase: 'observe',
      status: 'succeeded',
      userSummary: '已读取页面',
      evidenceRefs: ['evidence-1'],
      artifactRefs: [],
      availableControls: ['end_session'],
      startedAt: 1,
      completedAt: 2,
    };
    expect(isSurfaceExecutionEventV1(event)).toBe(true);
    expect(isSurfaceExecutionEventV1({ ...event, runId: undefined })).toBe(false);
    expect(isSurfaceExecutionEventV1({ ...event, sequence: Number.NaN })).toBe(false);
    expect(isSurfaceExecutionEventV1({ ...event, evidenceRefs: [42] })).toBe(false);
    expect(isSurfaceExecutionEventV1({
      ...event,
      target: { ...browserTarget, documentRevision: undefined },
    })).toBe(false);
  });
});
