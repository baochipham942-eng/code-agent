import { describe, expect, it } from 'vitest';
import {
  canTransitionSurfaceSessionV1,
  getSurfaceTargetRevisionV1,
  isSurfaceEvidenceCardV1,
  isSurfaceExecutionEventV1,
  isSurfaceOutputPayloadV1,
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

  it('keeps captured, analyzed, and verified Evidence states independent', () => {
    const evidence = {
      version: 1 as const,
      evidenceId: 'evidence-shot-1',
      kind: 'screenshot' as const,
      source: 'browser' as const,
      title: 'After save',
      capturedAt: 10,
      captureContext: {
        target: {
          kind: 'browser' as const,
          browserInstanceId: 'browser-a',
          windowRef: 'window-a',
          tabRef: 'tab-a',
          origin: 'https://example.test/result',
          documentRevision: 'document-a',
        },
        sourceUrl: 'https://example.test/result',
        viewport: { width: 1440, height: 900, deviceScaleFactor: 2 },
      },
      assetRef: 'artifact-shot-1',
      redactionStatus: 'clean' as const,
      inspection: {
        captureState: 'captured' as const,
        analysisState: 'analyzed' as const,
        verificationState: 'inconclusive' as const,
        inspectedBy: { kind: 'agent' as const, id: 'agent-a', method: 'vision' as const },
        inspectedAt: 20,
        supportsStepIds: ['step-observe'],
        checklist: [{ id: 'saved', label: 'Saved state visible', status: 'inconclusive' as const }],
      },
    };
    expect(isSurfaceEvidenceCardV1(evidence)).toBe(true);
    expect(isSurfaceExecutionEventV1({
      version: 1,
      eventId: 'evt-evidence',
      sequence: 2,
      sessionId: 'surface-1',
      conversationId: 'conversation-1',
      runId: 'run-1',
      agentId: 'agent-a',
      surface: 'browser',
      provider: 'system-chrome-cdp',
      sessionState: 'running',
      heartbeatAt: 20,
      phase: 'verify',
      status: 'ambiguous',
      userSummary: 'Screenshot captured and analyzed; verification remains inconclusive',
      evidenceRefs: ['evidence-shot-1'],
      evidence: [evidence],
      artifactRefs: [],
      availableControls: ['stop'],
      startedAt: 10,
      completedAt: 20,
    })).toBe(true);
    expect(isSurfaceEvidenceCardV1({
      ...evidence,
      inspection: { ...evidence.inspection, analysisState: 'analyzed', inspectedAt: undefined },
    })).toBe(true);
    expect(isSurfaceEvidenceCardV1({ ...evidence, inspection: undefined })).toBe(false);
    expect(isSurfaceEvidenceCardV1({
      ...evidence,
      captureContext: { ...evidence.captureContext, viewport: { width: 0, height: 900 } },
    })).toBe(false);
  });

  it('accepts only inert text previews or image data URLs for Surface outputs', () => {
    const base = {
      version: 1 as const,
      outputRef: 'surface-output://output-1',
      bytes: 12,
      sha256: 'a'.repeat(64),
      truncated: false,
    };
    expect(isSurfaceOutputPayloadV1({
      ...base,
      contentKind: 'text',
      mimeType: 'text/html',
      text: '<title>safe text</title>',
    })).toBe(true);
    expect(isSurfaceOutputPayloadV1({
      ...base,
      contentKind: 'image',
      mimeType: 'image/png',
      dataUrl: 'data:image/png;base64,iVBORw0KGgo=',
    })).toBe(true);
    expect(isSurfaceOutputPayloadV1({
      ...base,
      contentKind: 'text',
      mimeType: 'text/html',
      text: '<title>safe text</title>',
      dataUrl: 'file:///tmp/private.html',
    })).toBe(false);
    expect(isSurfaceOutputPayloadV1({
      ...base,
      outputRef: '/tmp/private.html',
      contentKind: 'text',
      mimeType: 'text/html',
      text: 'private',
    })).toBe(false);
    expect(isSurfaceOutputPayloadV1({
      ...base,
      contentKind: 'text',
      mimeType: 'text/html',
      text: 'private',
      rawPath: '/tmp/private.html',
    })).toBe(false);
  });
});
