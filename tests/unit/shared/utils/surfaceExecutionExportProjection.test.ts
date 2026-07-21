import { describe, expect, it } from 'vitest';
import {
  collectSurfaceExecutionExportProjection,
  formatSurfaceExecutionProjectionForMarkdown,
  parseSurfaceExecutionExportProjectionV1,
  projectSurfaceExecutionMetadataForExport,
  projectSurfaceExecutionResultMetadataForExport,
} from '../../../../src/shared/utils/surfaceExecutionExportProjection';

function surfaceMetadata() {
  return {
    surfaceExecutionSessionV1: {
      version: 1,
      sessionId: 'surface-session-1',
      runId: 'run-1',
      conversationId: 'conversation-1',
      agentId: 'agent-1',
      surface: 'browser',
      provider: 'managed',
      state: 'waiting_human',
      grantId: 'grant-secret',
      startedAt: 100,
      heartbeatAt: 150,
    },
    surfaceExecutionEventsV1: [{
      version: 1,
      eventId: 'surface-event-1',
      sequence: 1,
      sessionId: 'surface-session-1',
      runId: 'run-1',
      turnId: 'turn-1',
      agentId: 'agent-1',
      surface: 'browser',
      provider: 'managed',
      sessionState: 'waiting_human',
      phase: 'verify',
      status: 'ambiguous',
      userSummary: '截图已读取，登录按钮仍被遮挡',
      target: {
        kind: 'browser',
        browserInstanceId: 'browser-1',
        windowRef: 'window-secret',
        tabRef: 'tab-secret',
        documentRevision: 'revision-1',
      },
      operation: {
        action: 'click',
        risk: 'write',
        expectedOutcome: '登录按钮可见',
      },
      observation: {
        verdict: 'inconclusive',
        findings: ['遮挡仍存在'],
      },
      evidenceRefs: ['evidence-after'],
      evidence: [{
        version: 1,
        evidenceId: 'evidence-after',
        kind: 'screenshot',
        source: 'browser',
        title: '调整后截图',
        summary: '右下角仍有遮挡',
        capturedAt: 140,
        captureContext: {
          target: {
            kind: 'browser',
            browserInstanceId: 'browser-evidence-1',
            windowRef: 'window-evidence-1',
            tabRef: 'tab-evidence-1',
            frameRef: 'frame-evidence-1',
            origin: 'https://example.test',
            documentRevision: 'revision-evidence-1',
            title: 'Account overview',
          },
          sourceUrl: 'https://alice:password@example.test/account?token=surface-secret-canary-url#private',
          viewport: { width: 1440, height: 900, deviceScaleFactor: 2 },
        },
        assetRef: '/Users/linchen/private/surface-secret-canary-asset.png',
        redactionStatus: 'redacted',
        inspection: {
          captureState: 'captured',
          analysisState: 'analyzed',
          verificationState: 'inconclusive',
          inspectedBy: {
            kind: 'agent',
            id: 'vision-1',
            method: 'vision',
          },
          inspectedAt: 145,
          supportsStepIds: ['step-verify'],
          checklist: [{
            id: 'check-login',
            label: '登录按钮无遮挡',
            status: 'failed',
            finding: '仍被浮层遮挡',
          }],
          beforeEvidenceRef: 'evidence-before',
          afterEvidenceRef: 'evidence-after',
        },
      }],
      artifactRefs: ['artifact:web-preview'],
      availableControls: ['takeover', 'stop', 'end_session'],
      startedAt: 120,
      completedAt: 150,
    }],
    surfaceExecutionActionResultV1: {
      version: 1,
      operationId: 'operation-1',
      predecessorStateId: 'state-1',
      delivery: 'confirmed',
      verification: 'inconclusive',
      overall: 'ambiguous',
      evidenceRefs: ['evidence-after'],
      artifactRefs: ['artifact:web-preview'],
      error: {
        version: 1,
        code: 'SURFACE_POSTCONDITION_FAILED',
        message: 'cookie=session-secret surface-secret-canary-alpha at /Users/linchen/private',
        phase: 'verify',
        retryable: true,
        userActionRequired: true,
        recommendedAction: 'Inspect successor state before retrying',
        surface: 'browser',
        provider: 'managed',
        sessionId: 'surface-session-1',
      },
    },
    selector: '#private-login',
    token: 'session-secret',
    targetRef: 'raw-target-ref-secret',
    imagePath: '/Users/linchen/private/raw-image.png',
    screenshotBase64: 'A'.repeat(512),
    browserComputerEvidenceCard: {
      title: 'Legacy proof remains readable',
      status: 'manual_takeover',
      summary: 'Login requires a human',
      evidenceRefIds: ['evidence-after'],
    },
  };
}

function durableLedgerMetadata() {
  return {
    surfaceExecutionLedgerV1: {
      version: 1,
      conversationId: 'conversation-ledger',
      updatedAt: 300,
      reasoning: 'raw ledger chain of thought',
      sessions: [{
        version: 1,
        session: {
          version: 1,
          sessionId: 'surface-ledger',
          runId: 'run-ledger',
          conversationId: 'conversation-ledger',
          agentId: 'agent-ledger',
          surface: 'browser',
          provider: 'relay',
          capabilities: {
            version: 1,
            surface: 'browser',
            provider: 'relay',
            protocolVersion: 'surface-execution-v1',
            operations: ['raw-action-payload-secret'],
            observationKinds: ['screenshot'],
            supports: {
              cancel: true,
              pause: true,
              takeover: true,
              cleanup: true,
              successorObservation: true,
            },
          },
          state: 'completed',
          activeTarget: {
            kind: 'browser',
            browserInstanceId: 'browser-ledger-secret',
            windowRef: 'window-ledger-secret',
            tabRef: 'tab-ledger-secret',
            documentRevision: 'revision-ledger-secret',
          },
          startedAt: 100,
          heartbeatAt: 300,
        },
        grant: {
          state: 'revoked',
          capabilities: ['observe', 'input'],
          actionClasses: ['private-action-class'],
          dataScopes: ['cookie:surface-secret-canary-ledger'],
          grantId: 'grant-ledger-secret',
        },
        events: [{
          version: 1,
          eventId: 'event-takeover',
          sequence: 10,
          sessionId: 'surface-ledger',
          conversationId: 'conversation-ledger',
          runId: 'run-ledger',
          agentId: 'agent-ledger',
          surface: 'browser',
          provider: 'relay',
          sessionState: 'waiting_human',
          phase: 'human',
          status: 'succeeded',
          userSummary: '用户已接管当前页面',
          operation: { action: 'takeover', risk: 'control' },
          evidenceRefs: [],
          artifactRefs: [],
          availableControls: ['stop', 'end_session'],
          startedAt: 200,
          completedAt: 210,
          selector: '#private-ledger-selector',
        }, {
          version: 1,
          eventId: 'event-stop',
          sequence: 11,
          sessionId: 'surface-ledger',
          conversationId: 'conversation-ledger',
          runId: 'run-ledger',
          agentId: 'agent-ledger',
          surface: 'browser',
          provider: 'relay',
          sessionState: 'stopping',
          phase: 'human',
          status: 'succeeded',
          userSummary: '执行已停止',
          operation: { action: 'stop', risk: 'control' },
          evidenceRefs: [],
          artifactRefs: [],
          availableControls: ['end_session'],
          startedAt: 220,
          completedAt: 230,
        }, {
          version: 1,
          eventId: 'event-cleanup',
          sequence: 12,
          sessionId: 'surface-ledger',
          conversationId: 'conversation-ledger',
          runId: 'run-ledger',
          agentId: 'agent-ledger',
          surface: 'browser',
          provider: 'relay',
          sessionState: 'completed',
          phase: 'cleanup',
          status: 'succeeded',
          userSummary: '借用标签页已归还',
          observation: { verdict: 'pass', findings: ['标签页控制权已归还'] },
          evidenceRefs: ['evidence-cleanup'],
          artifactRefs: [],
          availableControls: [],
          startedAt: 240,
          completedAt: 300,
        }],
        evidence: [{
          version: 1,
          evidenceId: 'evidence-cleanup',
          kind: 'screenshot',
          source: 'browser',
          title: '归还状态截图',
          capturedAt: 290,
          assetRef: '/Users/linchen/private/surface-secret-canary-ledger.png',
          redactionStatus: 'redacted',
          inspection: {
            captureState: 'captured',
            analysisState: 'analyzed',
            verificationState: 'verified',
            supportsStepIds: ['cleanup'],
            checklist: [{ id: 'returned', label: '标签页已归还', status: 'passed' }],
          },
        }],
        outputs: [{
          ref: 'artifact:tab-return-proof',
          kind: 'artifact',
          label: 'Tab return proof',
          createdAt: 300,
        }],
        availableControls: [],
        source: 'persisted',
        writable: false,
        updatedAt: 300,
        surfaceActionRequestV1: {
          mutation: { kind: 'type', text: 'surface-secret-canary-raw-action' },
        },
      }],
    },
  };
}

describe('Surface Execution export projection', () => {
  it('strictly parses imported V1 projections with enum and field allowlists', () => {
    const projected = projectSurfaceExecutionMetadataForExport(surfaceMetadata());
    const session = projected!.sessions[0];
    const event = session.events[0];
    const evidence = event.evidence[0];
    const parsed = parseSurfaceExecutionExportProjectionV1({
      version: 1,
      rootAuthority: 'grant-root-secret',
      sessions: [{
        ...session,
        grant: { grantId: 'grant-session-secret' },
        target: { tabRef: 'tab-session-secret' },
        events: [{
          ...event,
          userSummary: 'token=surface-secret-value surface-secret-canary-parser',
          targetRef: 'tab-event-secret',
          availableControls: [...event.availableControls, 'escalate'],
          evidence: [{
            ...evidence,
            cookie: 'cookie-evidence-secret',
            captureContext: {
              ...evidence.captureContext,
              grantRef: 'grant-context-secret',
              sourceUrl: 'https://example.test/account?access_token=surface-secret-canary-parser#private',
              viewport: {
                ...evidence.captureContext?.viewport,
                authority: 'raw-context-authority',
              },
            },
            supportsStepIds: Array.from({ length: 205 }, (_, index) => `step-${index}`),
            checklist: [
              ...evidence.checklist,
              { id: 'invalid', label: 'invalid', status: 'approved' },
            ],
          }, {
            ...evidence,
            evidenceId: 'invalid-evidence',
            kind: 'video',
          }],
          actionResult: {
            operationId: 'operation-imported',
            delivery: 'forged',
            verification: 'satisfied',
            overall: 'succeeded',
            grantId: 'grant-result-secret',
            error: {
              code: 'SURFACE_POSTCONDITION_FAILED',
              message: 'cookie=surface-secret-value',
              phase: 'authorize',
              retryable: true,
              userActionRequired: false,
              targetRef: 'tab-error-secret',
            },
          },
        }, {
          ...event,
          eventId: 'invalid-event',
          status: 'approved',
        }],
      }, {
        ...session,
        sessionId: 'invalid-session',
        source: 'remote',
      }],
    });

    expect(parsed?.sessions).toHaveLength(1);
    expect(parsed?.sessions[0].events).toHaveLength(1);
    expect(parsed?.sessions[0].events[0]).toMatchObject({
      actionResult: {
        operationId: 'operation-imported',
        verification: 'satisfied',
        overall: 'succeeded',
        error: {
          code: 'SURFACE_POSTCONDITION_FAILED',
          retryable: true,
          userActionRequired: false,
        },
      },
      availableControls: ['takeover', 'stop', 'end_session'],
      evidence: [{
        captureContext: {
          target: {
            kind: 'browser',
            browserInstanceId: 'browser-evidence-1',
            windowRef: 'window-evidence-1',
            tabRef: 'tab-evidence-1',
            frameRef: 'frame-evidence-1',
            origin: 'https://example.test/',
            documentRevision: 'revision-evidence-1',
            title: 'Account overview',
          },
          sourceUrl: 'https://example.test/account',
          viewport: { width: 1440, height: 900, deviceScaleFactor: 2 },
        },
        supportsStepIds: expect.any(Array),
        checklist: [{ status: 'failed' }],
      }],
    });
    expect(parsed?.sessions[0].events[0].actionResult?.delivery).toBeUndefined();
    expect(parsed?.sessions[0].events[0].actionResult?.error?.phase).toBeUndefined();
    expect(parsed?.sessions[0].events[0].evidence[0].supportsStepIds).toHaveLength(200);
    const serialized = JSON.stringify(parsed);
    expect(serialized).not.toContain('rootAuthority');
    expect(serialized).not.toContain('grant-session-secret');
    expect(serialized).not.toContain('tab-event-secret');
    expect(serialized).not.toContain('cookie-evidence-secret');
    expect(serialized).not.toContain('grant-context-secret');
    expect(serialized).not.toContain('raw-context-authority');
    expect(serialized).not.toContain('access_token');
    expect(serialized).not.toContain('surface-secret-value');
    expect(serialized).not.toContain('surface-secret-canary-parser');
  });

  it('bounds imported sessions and rejects projections without a valid V1 session', () => {
    const session = projectSurfaceExecutionMetadataForExport(surfaceMetadata())!.sessions[0];
    const parsed = parseSurfaceExecutionExportProjectionV1({
      version: 1,
      sessions: Array.from({ length: 205 }, (_, index) => ({
        ...session,
        sessionId: `surface-${index}`,
        events: [],
      })),
    });

    expect(parsed?.sessions).toHaveLength(200);
    expect(parseSurfaceExecutionExportProjectionV1({ version: 2, sessions: [] })).toBeNull();
    expect(parseSurfaceExecutionExportProjectionV1({
      version: 1,
      sessions: [{ sessionId: 'bad', surface: 'browser', source: 'native' }],
    })).toBeNull();
  });

  it('keeps semantic execution, independent evidence states, verdict, error, controls, and outputs', () => {
    const projection = projectSurfaceExecutionMetadataForExport(surfaceMetadata());

    expect(projection).toMatchObject({
      version: 1,
      sessions: [{
        sessionId: 'surface-session-1',
        surface: 'browser',
        provider: 'managed',
        state: 'waiting_human',
        events: [{
          phase: 'verify',
          status: 'ambiguous',
          observation: {
            verdict: 'inconclusive',
            findings: ['遮挡仍存在'],
          },
          evidence: [{
            captureContext: {
              target: {
                kind: 'browser',
                browserInstanceId: 'browser-evidence-1',
                windowRef: 'window-evidence-1',
                tabRef: 'tab-evidence-1',
                documentRevision: 'revision-evidence-1',
              },
              sourceUrl: 'https://example.test/account',
              viewport: { width: 1440, height: 900, deviceScaleFactor: 2 },
            },
            captureState: 'captured',
            analysisState: 'analyzed',
            verificationState: 'inconclusive',
            supportsStepIds: ['step-verify'],
            checklist: [{ status: 'failed' }],
          }],
          artifactRefs: ['artifact:web-preview'],
          availableControls: ['takeover', 'stop', 'end_session'],
          actionResult: {
            delivery: 'confirmed',
            verification: 'inconclusive',
            overall: 'ambiguous',
            error: {
              code: 'SURFACE_POSTCONDITION_FAILED',
              phase: 'verify',
              retryable: true,
              userActionRequired: true,
            },
          },
        }],
      }],
    });

    const serialized = JSON.stringify(projection);
    expect(serialized).not.toContain('grant-secret');
    expect(serialized).not.toContain('#private-login');
    expect(serialized).not.toContain('window-secret');
    expect(serialized).not.toContain('tab-secret');
    expect(serialized).not.toContain('session-secret');
    expect(serialized).not.toContain('raw-target-ref-secret');
    expect(serialized).not.toContain('raw-image.png');
    expect(serialized).not.toContain('A'.repeat(128));
    expect(serialized).not.toContain('surface-secret-canary-alpha');
    expect(serialized).not.toContain('alice:password');
    expect(serialized).not.toContain('?token=');
    expect(serialized).not.toContain('/Users/linchen');
  });

  it('replaces raw Surface authority payloads while retaining legacy proof metadata', () => {
    const metadata = projectSurfaceExecutionResultMetadataForExport(surfaceMetadata());
    const serialized = JSON.stringify(metadata);

    expect(metadata?.surfaceExecutionExportV1).toBeDefined();
    expect(metadata?.browserComputerEvidenceCard).toMatchObject({
      status: 'manual_takeover',
    });
    expect(serialized).not.toContain('surfaceExecutionSessionV1');
    expect(serialized).not.toContain('surfaceExecutionEventsV1');
    expect(serialized).not.toContain('surfaceExecutionActionResultV1');
    expect(serialized).not.toContain('grant-secret');
    expect(serialized).not.toContain('#private-login');
    expect(serialized).not.toContain('session-secret');
    expect(serialized).not.toContain('raw-target-ref-secret');
    expect(serialized).not.toContain('raw-image.png');
    expect(serialized).not.toContain('A'.repeat(128));
  });

  it('deduplicates ToolCall and ToolResult projections and renders semantic Markdown only', () => {
    const metadata = surfaceMetadata();
    const projection = collectSurfaceExecutionExportProjection([{
      timestamp: 150,
      toolCalls: [{
        id: 'tool-1',
        name: 'browser_action',
        arguments: { action: 'click', selector: '#private-login' },
        result: { success: false, error: 'surface-secret-canary-beta', metadata },
      }],
      toolResults: [{
        toolCallId: 'tool-1',
        success: false,
        error: 'surface-secret-canary-beta',
        metadata,
      }],
    }]);
    const markdown = formatSurfaceExecutionProjectionForMarkdown(projection);

    expect(projection?.sessions[0].events).toHaveLength(1);
    expect(markdown).toContain('## Surface Execution');
    expect(markdown).toContain('capture=captured');
    expect(markdown).toContain('analysis=analyzed');
    expect(markdown).toContain('verification=inconclusive');
    expect(markdown).toContain('Controls: takeover, stop, end_session');
    expect(markdown).toContain('Outputs: artifact:web-preview');
    expect(markdown).not.toContain('#private-login');
    expect(markdown).not.toContain('surface-secret-canary');
    expect(markdown).not.toContain('grant-secret');
  });

  it('projects durable ledger-only takeover, stop, cleanup, evidence, and outputs without raw authority', () => {
    const projection = projectSurfaceExecutionMetadataForExport(durableLedgerMetadata());
    const serialized = JSON.stringify(projection);

    expect(projection).toMatchObject({
      sessions: [{
        sessionId: 'surface-ledger',
        state: 'completed',
        events: [{
          eventId: 'event-takeover',
          operation: { action: 'takeover' },
        }, {
          eventId: 'event-stop',
          operation: { action: 'stop' },
        }, {
          eventId: 'event-cleanup',
          phase: 'cleanup',
          status: 'succeeded',
          observation: { verdict: 'pass' },
          evidence: [{
            evidenceId: 'evidence-cleanup',
            captureState: 'captured',
            analysisState: 'analyzed',
            verificationState: 'verified',
          }],
          artifactRefs: ['artifact:tab-return-proof'],
        }],
      }],
    });
    expect(serialized).not.toContain('surfaceExecutionLedgerV1');
    expect(serialized).not.toContain('grant-ledger-secret');
    expect(serialized).not.toContain('#private-ledger-selector');
    expect(serialized).not.toContain('surface-secret-canary');
    expect(serialized).not.toContain('raw-action-payload-secret');
    expect(serialized).not.toContain('browser-ledger-secret');
    expect(serialized).not.toContain('tab-ledger-secret');
    expect(serialized).not.toContain('raw ledger chain of thought');
  });
});
