import { describe, expect, it } from 'vitest';
import type { AgentEvent, ToolResult } from '../../../src/shared/contract';
import { extractEventData } from '../../../src/host/telemetry/telemetryCollectorInternal';
import {
  attachSurfaceExecutionReplayBlocks,
  buildSurfaceExecutionReplayBlocks,
  projectTranscriptToolResultForReplay,
} from '../../../src/host/evaluation/transcriptReplayBuilder';

function metadata() {
  return {
    surfaceExecutionSessionV1: {
      version: 1,
      sessionId: 'surface-replay',
      runId: 'run-replay',
      conversationId: 'conversation-replay',
      agentId: 'agent-replay',
      surface: 'computer',
      provider: 'stateful-cua',
      state: 'completed',
      grantId: 'grant-replay-secret',
      startedAt: 10,
      heartbeatAt: 20,
    },
    surfaceExecutionEventsV1: [{
      version: 1,
      eventId: 'event-replay',
      sequence: 2,
      sessionId: 'surface-replay',
      runId: 'run-replay',
      turnId: 'turn-replay',
      agentId: 'agent-replay',
      surface: 'computer',
      provider: 'stateful-cua',
      sessionState: 'completed',
      phase: 'verify',
      status: 'succeeded',
      userSummary: '桌面修改已由截图复验通过',
      operation: { action: 'click', risk: 'write' },
      observation: { verdict: 'pass', findings: ['目标窗口状态正确'] },
      evidenceRefs: ['evidence-replay'],
      evidence: [{
        version: 1,
        evidenceId: 'evidence-replay',
        kind: 'screenshot',
        source: 'computer',
        title: '桌面复验截图',
        capturedAt: 18,
        captureContext: {
          target: {
            kind: 'computer',
            deviceId: 'local-mac',
            appName: 'Preview',
            bundleId: 'com.apple.Preview',
            pid: 4242,
            windowRef: 'preview-window-1',
            spaceId: 'space-1',
            windowRevision: 'window-revision-1',
            title: 'Final proof.png',
          },
          viewport: { width: 1512, height: 982, deviceScaleFactor: 2 },
        },
        redactionStatus: 'clean',
        inspection: {
          captureState: 'captured',
          analysisState: 'analyzed',
          verificationState: 'verified',
          inspectedBy: { kind: 'service', id: 'vision-check', method: 'vision' },
          inspectedAt: 19,
          supportsStepIds: ['step-replay'],
          checklist: [{ id: 'window', label: '目标窗口正确', status: 'passed' }],
        },
      }],
      artifactRefs: ['artifact:desktop-proof'],
      availableControls: ['end_session'],
      startedAt: 15,
      completedAt: 20,
    }],
    surfaceExecutionActionResultV1: {
      version: 1,
      operationId: 'operation-replay',
      predecessorStateId: 'state-replay',
      delivery: 'confirmed',
      verification: 'satisfied',
      overall: 'succeeded',
      evidenceRefs: ['evidence-replay'],
      artifactRefs: ['artifact:desktop-proof'],
    },
    selector: '#private-target',
    cookie: 'surface-secret-canary-replay',
  };
}

describe('Surface Execution replay projection', () => {
  it('persists a safe semantic projection in telemetry tool_call_end event data', () => {
    const event = {
      type: 'tool_call_end',
      data: {
        toolCallId: 'tool-replay',
        success: true,
        error: 'surface-secret-canary-event-error',
        duration: 10,
        metadata: metadata(),
      },
    } as AgentEvent;

    const serialized = extractEventData(event) || '{}';
    const parsed = JSON.parse(serialized) as {
      metadata: { surfaceExecutionExportV1: { sessions: Array<{ events: Array<Record<string, unknown>> }> } };
    };

    expect(parsed.metadata.surfaceExecutionExportV1.sessions[0].events[0]).toMatchObject({
      phase: 'verify',
      status: 'succeeded',
      observation: { verdict: 'pass' },
      evidence: [{
        captureContext: {
          target: {
            kind: 'computer',
            deviceId: 'local-mac',
            appName: 'Preview',
            bundleId: 'com.apple.Preview',
            pid: 4242,
            windowRef: 'preview-window-1',
            spaceId: 'space-1',
            windowRevision: 'window-revision-1',
            title: 'Final proof.png',
          },
          viewport: { width: 1512, height: 982, deviceScaleFactor: 2 },
        },
        captureState: 'captured',
        analysisState: 'analyzed',
        verificationState: 'verified',
      }],
      artifactRefs: ['artifact:desktop-proof'],
      actionResult: {
        delivery: 'confirmed',
        verification: 'satisfied',
        overall: 'succeeded',
      },
    });
    expect(serialized).not.toContain('surfaceExecutionSessionV1');
    expect(serialized).not.toContain('grant-replay-secret');
    expect(serialized).not.toContain('#private-target');
    expect(serialized).not.toContain('surface-secret-canary-replay');
  });

  it('projects transcript ToolResult metadata without emitting raw metadata as replay content', () => {
    const result: ToolResult = {
      toolCallId: 'tool-replay',
      success: true,
      metadata: metadata(),
    };

    const projected = projectTranscriptToolResultForReplay({
      toolName: 'computer_use',
      toolCallId: 'tool-replay',
      result,
      timestamp: 20,
    });
    const serialized = JSON.stringify(projected);

    expect(projected.resultContent).toBe('桌面修改已由截图复验通过 (succeeded)');
    expect(projected.resultMetadata?.surfaceExecutionExportV1).toBeDefined();
    expect(serialized).not.toContain('surfaceExecutionSessionV1');
    expect(serialized).not.toContain('grant-replay-secret');
    expect(serialized).not.toContain('#private-target');
    expect(serialized).not.toContain('surface-secret-canary-replay');
  });

  it('emits explicit archive-only Surface event blocks without reviving targets or screenshot bytes', () => {
    const result: ToolResult = {
      toolCallId: 'tool-replay',
      success: true,
      metadata: metadata(),
    };
    const projected = projectTranscriptToolResultForReplay({
      toolName: 'computer_use',
      toolCallId: 'tool-replay',
      result,
      timestamp: 20,
    });
    const projection = projected.resultMetadata?.surfaceExecutionExportV1 as never;
    const blocks = buildSurfaceExecutionReplayBlocks(projection);
    const turns: import('../../../src/shared/contract/evaluation').ReplayTurn[] = [];
    attachSurfaceExecutionReplayBlocks(turns, projection);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      type: 'event',
      content: '桌面修改已由截图复验通过',
      event: {
        eventType: 'surface_execution_archive',
        data: {
          archiveOnly: true,
          writable: false,
          authority: 'none',
          phase: 'verify',
          status: 'succeeded',
          observation: { verdict: 'pass' },
          evidence: [{
            captureContext: {
              target: {
                kind: 'computer',
                deviceId: 'local-mac',
                appName: 'Preview',
                bundleId: 'com.apple.Preview',
                pid: 4242,
                windowRef: 'preview-window-1',
                spaceId: 'space-1',
                windowRevision: 'window-revision-1',
                title: 'Final proof.png',
              },
              viewport: { width: 1512, height: 982, deviceScaleFactor: 2 },
            },
            captureState: 'captured',
            analysisState: 'analyzed',
            verificationState: 'verified',
          }],
          actionResult: {
            delivery: 'confirmed',
            verification: 'satisfied',
            overall: 'succeeded',
          },
          evidencePortability: 'metadata_only',
        },
      },
    });
    expect(turns).toHaveLength(1);
    expect(turns[0].blocks).toEqual(blocks);
    const serialized = JSON.stringify(blocks);
    expect(serialized).not.toContain('grant-replay-secret');
    expect(serialized).not.toContain('#private-target');
    expect(serialized).not.toContain('surface-secret-canary-replay');
    expect(serialized).not.toContain('assetRef');
  });
});
