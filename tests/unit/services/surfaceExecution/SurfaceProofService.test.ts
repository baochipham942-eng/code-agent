import { describe, expect, it } from 'vitest';
import {
  isSurfaceEvidenceCardV1,
  type SurfaceExecutionEventV1,
  type SurfaceKind,
} from '../../../../src/shared/contract/surfaceExecution';
import { SurfaceProofService } from '../../../../src/host/services/surfaceExecution/SurfaceProofService';

const service = new SurfaceProofService({ now: () => 500 });

function event(input: {
  surface: SurfaceKind;
  sessionId?: string;
  runId?: string;
  agentId?: string;
  status?: SurfaceExecutionEventV1['status'];
}): SurfaceExecutionEventV1 {
  return {
    version: 1,
    eventId: 'event-terminal',
    sequence: 2,
    sessionId: input.sessionId || `surface-${input.surface}`,
    conversationId: 'conversation-1',
    runId: input.runId || 'run-1',
    agentId: input.agentId || 'agent-1',
    surface: input.surface,
    phase: 'verify',
    status: input.status || 'succeeded',
    userSummary: 'Surface operation finished',
    observation: { verdict: 'inconclusive', findings: [] },
    evidenceRefs: [],
    artifactRefs: [],
    availableControls: ['end_session'],
    startedAt: 100,
    completedAt: 200,
  };
}

function identity(surface: SurfaceKind) {
  return {
    conversationId: 'conversation-1',
    runId: 'run-1',
    turnId: 'turn-1',
    agentId: 'agent-1',
    surfaceSessionId: `surface-${surface}`,
    operationId: `operation-${surface}`,
  };
}

describe('SurfaceProofService', () => {
  it('projects verified Browser before/after evidence and checklist onto the owned event', () => {
    const result = service.finalizeToolResult({
      toolName: 'browser_action',
      action: 'click',
      surface: 'browser',
      identity: identity('browser'),
      result: {
        success: true,
        metadata: {
          surfaceSessionId: 'surface-browser',
          surfaceExecutionSessionV1: {
            sessionId: 'surface-browser',
            conversationId: 'conversation-1',
            runId: 'run-1',
            agentId: 'agent-1',
            surface: 'browser',
            activeTarget: {
              kind: 'browser',
              browserInstanceId: 'browser-managed-1',
              windowRef: 'window-managed-1',
              tabRef: 'tab-managed-1',
              origin: 'https://example.test/result',
              documentRevision: 'document-2',
              title: 'Generated result',
            },
          },
          viewport: { width: 1440, height: 900, deviceScaleFactor: 2 },
          surfaceExecutionActionResultV1: {
            predecessorStateId: 'browser-state-before',
            delivery: 'confirmed',
            verification: 'satisfied',
            overall: 'succeeded',
            successorState: {
              stateId: 'browser-state-after',
              observedAt: 400,
              elementRefs: [{ kind: 'browser-element' }],
              evidenceAssetIds: ['browser-after.png'],
              redactionStatus: 'clean',
            },
          },
          browserComputerProof: {
            evidenceRefs: [{
              id: 'legacy-dom-proof',
              kind: 'browser_dom',
              freshness: { capturedAtMs: 450 },
              redactionStatus: 'clean',
            }],
          },
          surfaceExecutionEventsV1: [event({ surface: 'browser' })],
        },
      },
    });

    const card = result.metadata?.surfaceEvidenceCardV1;
    expect(isSurfaceEvidenceCardV1(card)).toBe(true);
    expect(card).toMatchObject({
      source: 'browser',
      kind: 'screenshot',
      redactionStatus: 'clean',
      captureContext: {
        target: {
          kind: 'browser',
          browserInstanceId: 'browser-managed-1',
          windowRef: 'window-managed-1',
          tabRef: 'tab-managed-1',
          origin: 'https://example.test/result',
          documentRevision: 'document-2',
          title: 'Generated result',
        },
        sourceUrl: 'https://example.test/result',
        viewport: { width: 1440, height: 900, deviceScaleFactor: 2 },
      },
      inspection: {
        captureState: 'captured',
        analysisState: 'analyzed',
        verificationState: 'verified',
        inspectedBy: { method: 'dom' },
        supportsStepIds: ['operation-browser'],
        checklist: [
          { id: 'delivery', status: 'passed' },
          { id: 'verification', status: 'passed' },
          { id: 'redaction', status: 'passed' },
        ],
      },
    });
    expect((card as { inspection: { beforeEvidenceRef?: string; afterEvidenceRef?: string } })
      .inspection.beforeEvidenceRef).toMatch(/^surface-state:/);
    expect((card as { inspection: { afterEvidenceRef?: string } }).inspection.afterEvidenceRef)
      .toBe('browser-after.png');
    expect(result.metadata?.surfaceProofScopeV1).toMatchObject(identity('browser'));
    expect(result.metadata?.surfaceExecutionEventsV1).toEqual([
      expect.objectContaining({
        eventId: 'event-terminal',
        observation: { verdict: 'pass', findings: [] },
        evidence: [expect.objectContaining({ evidenceId: (card as { evidenceId: string }).evidenceId })],
      }),
    ]);
  });

  it('marks failed Computer verification for reverify and keeps a canary out of proof', () => {
    const canary = 'surface-secret-canary-proof-must-not-leak';
    const result = service.finalizeToolResult({
      toolName: 'computer_use',
      action: 'act',
      surface: 'computer',
      identity: identity('computer'),
      result: {
        success: false,
        output: `Provider output contained ${canary}`,
        error: canary,
        metadata: {
          surfaceSessionId: 'surface-computer',
          providerDiagnostic: {
            message: `Nested provider payload contained ${canary}`,
            reasoning: 'raw private chain of thought',
          },
          surfaceExecutionSessionV1: {
            sessionId: 'surface-computer',
            conversationId: 'conversation-1',
            runId: 'run-1',
            agentId: 'agent-1',
            surface: 'computer',
          },
          surfaceExecutionActionResultV1: {
            predecessorStateId: 'computer-state-before',
            delivery: 'confirmed',
            verification: 'unsatisfied',
            overall: 'failed',
            successorState: {
              stateId: 'computer-state-after',
              observedAt: 400,
              elementRefs: [{ kind: 'computer-element' }],
              evidenceAssetIds: ['computer-after.png'],
              redactionStatus: 'clean',
            },
          },
          surfaceExecutionEventsV1: [event({ surface: 'computer', status: 'failed' })],
        },
      },
    });

    const card = result.metadata?.surfaceEvidenceCardV1 as Record<string, unknown>;
    expect(card).toMatchObject({
      source: 'computer',
      redactionStatus: 'blocked',
      inspection: {
        captureState: 'blocked',
        analysisState: 'analyzed',
        verificationState: 'rejected',
        inspectedBy: { method: 'ax' },
        checklist: [
          { id: 'delivery', status: 'passed' },
          { id: 'verification', status: 'failed' },
          { id: 'redaction', status: 'failed' },
        ],
      },
    });
    expect(card.assetRef).toBeUndefined();
    expect(result.output).toContain('[redacted-canary]');
    expect(result.error).toBe('[redacted-canary]');
    expect(JSON.stringify(result)).not.toContain(canary);
    expect(JSON.stringify(result)).not.toContain('raw private chain of thought');
    expect(result.metadata?.surfaceProofReverifyV1).toMatchObject({
      required: true,
      operationId: 'operation-computer',
      reason: 'rejected',
    });
  });

  it('fails closed instead of projecting evidence across Surface owners', () => {
    const seeded = service.finalizeToolResult({
      toolName: 'browser_action',
      action: 'screenshot',
      identity: identity('browser'),
      result: {
        success: true,
        metadata: {
          surfaceSessionId: 'surface-browser',
          imagePath: 'artifact://owned-proof',
          surfaceExecutionEventsV1: [event({ surface: 'browser' })],
        },
      },
    });
    const seededCard = seeded.metadata?.surfaceEvidenceCardV1 as { evidenceId: string };
    const seededEvent = (seeded.metadata?.surfaceExecutionEventsV1 as SurfaceExecutionEventV1[])[0];
    const foreign = { ...seededEvent, agentId: 'agent-foreign' };
    const result = service.finalizeToolResult({
      toolName: 'browser_action',
      action: 'click',
      identity: identity('browser'),
      result: {
        success: true,
        metadata: {
          ...(seeded.metadata || {}),
          surfaceExecutionEventsV1: [foreign],
          surfaceExecutionEventV1: foreign,
        },
      },
    });

    expect(result.metadata?.surfaceEvidenceCardV1).toBeUndefined();
    expect(result.metadata?.surfaceProofRejectedV1).toEqual({
      version: 1,
      code: 'scope_identity_mismatch',
      field: 'event.agentId',
    });
    expect(result.metadata?.surfaceProofScopeV1).toBeUndefined();
    expect(result.metadata?.surfaceProofReverifyV1).toBeUndefined();
    expect(result.metadata?.surfaceExecutionEventsV1).toEqual([
      expect.objectContaining({ evidence: [], evidenceRefs: [] }),
    ]);
    expect(JSON.stringify(result.metadata)).not.toContain(seededCard.evidenceId);
  });

  it('keeps a screenshot capture unverified until it was actually inspected', () => {
    const result = service.finalizeToolResult({
      toolName: 'browser_action',
      action: 'screenshot',
      identity: identity('browser'),
      result: {
        success: true,
        metadata: {
          surfaceSessionId: 'surface-browser',
          imagePath: '/tmp/surface-proof.png',
          browserComputerProof: {
            evidenceRefs: [{
              id: 'screenshot-proof',
              kind: 'screenshot',
              freshness: { capturedAtMs: 450 },
              redactionStatus: 'clean',
            }],
          },
          surfaceExecutionEventsV1: [event({ surface: 'browser' })],
        },
      },
    });

    expect(result.metadata?.surfaceEvidenceCardV1).toMatchObject({
      kind: 'screenshot',
      inspection: {
        captureState: 'captured',
        analysisState: 'not_requested',
        verificationState: 'not_requested',
      },
    });
    expect((result.metadata?.surfaceEvidenceCardV1 as {
      inspection: { inspectedBy?: unknown };
    }).inspection.inspectedBy).toBeUndefined();
  });
});
