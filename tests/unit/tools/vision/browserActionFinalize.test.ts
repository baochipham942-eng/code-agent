import { describe, expect, it, vi } from 'vitest';

const persist = vi.fn();
vi.mock('../../../../src/host/session/browserComputerProofStore', () => ({
  persistBrowserComputerProofFromResult: (...args: unknown[]) => persist(...args),
}));

import {
  finalizeBrowserActionResult,
  finalizeDeferredBrowserActionProof,
} from '../../../../src/host/tools/vision/browserActionFinalize';

describe('finalizeBrowserActionResult (ADR-041 M4)', () => {
  it('attaches proof + pointer and redacts binary-looking metadata for relay', () => {
    persist.mockClear();
    const result = finalizeBrowserActionResult({
      result: {
        success: true,
        output: 'Clicked button',
        metadata: {
          provider: 'browser-relay',
          data: 'A'.repeat(400),
          authToken: 'secret-token',
          selector: '#submit',
        },
      },
      action: 'click',
      params: { action: 'click', selector: '#submit', engine: 'relay' },
      provider: 'browser-relay',
      engineRoute: {
        selectedEngine: 'relay',
        requestedEngine: 'relay',
        reason: 'explicit_relay',
      },
      context: {
        sessionId: 'sess-1',
        currentToolCallId: 'tc-1',
      } as never,
    });

    expect(result.metadata?.provider).toBe('browser-relay');
    expect(result.metadata?.engine).toBe('relay');
    expect(result.metadata?.agentPointerEvent).toBeTruthy();
    expect(result.metadata?.browserComputerProof).toBeTruthy();
    expect(result.metadata?.authToken).toBe('[redacted]');
    expect(result.metadata?.data).toBe('[redacted-binary]');
    expect(persist).toHaveBeenCalledOnce();
    const persisted = persist.mock.calls[0]?.[0];
    expect(JSON.stringify(persisted)).not.toContain('secret-token');
  });

  it('includes structured recovery on failed engine routing', () => {
    const result = finalizeBrowserActionResult({
      result: {
        success: false,
        error: 'Relay not connected',
      },
      action: 'click',
      params: { action: 'click', engine: 'relay' },
      provider: 'browser-relay',
      recovery: {
        code: 'relay_not_connected',
        requestedEngine: 'relay',
        selectedEngine: null,
        recoverable: true,
        recommendedAction: 'start_browser_relay',
        availableEngines: ['auto', 'managed'],
        reason: 'Browser relay extension is not connected.',
      },
    });

    expect(result.success).toBe(false);
    expect(result.metadata?.recovery).toMatchObject({
      code: 'relay_not_connected',
      recommendedAction: 'start_browser_relay',
    });
    expect(result.metadata?.browserComputerProof).toBeTruthy();
  });

  it('uses the shared Surface proof finalizer when native owner identity is complete', () => {
    persist.mockClear();
    const result = finalizeBrowserActionResult({
      result: {
        success: true,
        metadata: {
          surfaceSessionId: 'surface-browser-1',
          surfaceExecutionSessionV1: {
            sessionId: 'surface-browser-1',
            conversationId: 'conversation-1',
            runId: 'run-1',
            agentId: 'agent-1',
            surface: 'browser',
          },
          surfaceExecutionActionResultV1: {
            predecessorStateId: 'before-1',
            delivery: 'confirmed',
            verification: 'satisfied',
            overall: 'succeeded',
            successorState: {
              stateId: 'after-1',
              observedAt: 20,
              elementRefs: [{ kind: 'browser-element' }],
              evidenceAssetIds: ['after.png'],
              redactionStatus: 'clean',
            },
          },
          surfaceExecutionEventsV1: [{
            version: 1,
            eventId: 'native-browser-terminal',
            sequence: 2,
            sessionId: 'surface-browser-1',
            conversationId: 'conversation-1',
            runId: 'run-1',
            agentId: 'agent-1',
            surface: 'browser',
            phase: 'verify',
            status: 'succeeded',
            userSummary: 'click succeeded',
            observation: { verdict: 'pass', findings: [] },
            evidenceRefs: [],
            artifactRefs: [],
            availableControls: ['end_session'],
            startedAt: 10,
            completedAt: 20,
          }],
        },
      },
      action: 'click',
      params: { action: 'click' },
      context: {
        sessionId: 'conversation-1',
        runId: 'run-1',
        turnId: 'turn-1',
        agentId: 'agent-1',
        currentToolCallId: 'operation-1',
      } as never,
    });

    expect(result.metadata?.surfaceEvidenceCardV1).toMatchObject({
      source: 'browser',
      inspection: {
        verificationState: 'verified',
        beforeEvidenceRef: expect.stringMatching(/^surface-state:/),
        afterEvidenceRef: expect.any(String),
      },
    });
    expect(result.metadata?.surfaceExecutionEventsV1).toEqual([
      expect.objectContaining({
        eventId: 'native-browser-terminal',
        evidence: [expect.objectContaining({ source: 'browser' })],
      }),
    ]);
    expect(persist).toHaveBeenCalledOnce();
    expect(persist.mock.calls[0]?.[0]).toMatchObject({
      metadata: { surfaceEvidenceCardV1: { source: 'browser' } },
    });
  });

  it('defers Relay screenshot proof until inline base64 is persisted and redacted', () => {
    persist.mockClear();
    const canary = 'SURFACE_REDACTION_CANARY_DO_NOT_PERSIST';
    const raw = finalizeBrowserActionResult({
      result: {
        success: true,
        output: 'Relay screenshot captured',
        metadata: {
          provider: 'browser-relay',
          imageBase64: Buffer.from(canary).toString('base64'),
          imageMimeType: 'image/png',
        },
      },
      action: 'screenshot',
      params: { action: 'screenshot', engine: 'relay' },
      context: { sessionId: 'sess-canary', currentToolCallId: 'tc-canary' } as never,
    });
    expect(raw.metadata?.browserComputerProofPersistenceDeferred).toBe(true);
    expect(raw.metadata?.browserComputerProof).toBeUndefined();
    expect(persist).not.toHaveBeenCalled();

    const { imageBase64: _removed, ...persistedMetadata } = raw.metadata || {};
    const finalized = finalizeDeferredBrowserActionProof({
      ...raw,
      metadata: {
        ...persistedMetadata,
        imagePath: '/tmp/relay-proof.png',
        imageBase64Omitted: true,
      },
    }, { sessionId: 'sess-canary', toolCallId: 'tc-canary' });
    expect(finalized.metadata?.browserComputerProof).toBeTruthy();
    expect(finalized.metadata?.browserComputerProofPersistenceDeferred).toBe(false);
    expect(persist).toHaveBeenCalledOnce();
    expect(JSON.stringify(persist.mock.calls[0]?.[0])).not.toContain(canary);
    expect(JSON.stringify(persist.mock.calls[0]?.[0])).toContain('/tmp/relay-proof.png');
  });
});
