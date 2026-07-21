import { describe, expect, it } from 'vitest';
import { attachSurfaceExecutionResultProjection } from '../../../../src/host/services/surfaceExecution/surfaceExecutionResultProjection';

describe('SurfaceExecution tool-result projection', () => {
  it('projects persisted artifact and proof refs for an ambiguous computer result', () => {
    const result = attachSurfaceExecutionResultProjection({
      toolName: 'computer_use',
      arguments: { action: 'click', x: 24, y: 40 },
      result: {
        success: true,
        metadata: {
          surfaceSessionId: 'surface-computer-1',
          computerUseActionResultV1: { overall: 'ambiguous' },
          browserComputerProof: { evidenceRefs: [{ id: 'proof-after-click' }] },
          artifact: { artifactId: 'artifact-screenshot-1', kind: 'image' },
          artifacts: [{ id: 'artifact-log-1' }],
        },
      },
      conversationId: 'conversation-1',
      runId: 'run-1',
      agentId: 'agent-1',
      toolCallId: 'tool-call-1',
      startedAt: 10,
      completedAt: 20,
    });

    expect(result.metadata).toMatchObject({
      surfaceProjectionMode: 'compatibility',
      conversationId: 'conversation-1',
      surfaceExecutionEventV1: {
        sessionId: 'surface-computer-1',
        runId: 'run-1',
        agentId: 'agent-1',
        surface: 'computer',
        status: 'ambiguous',
        evidenceRefs: ['proof-after-click'],
        artifactRefs: ['artifact-screenshot-1', 'artifact-log-1'],
      },
    });
  });

  it('merges post-persistence proof into the native terminal event without replacing its identity', () => {
    const result = attachSurfaceExecutionResultProjection({
      toolName: 'browser_action',
      arguments: { action: 'screenshot' },
      result: {
        success: true,
        metadata: {
          browserComputerProof: { evidenceRefs: [{ id: 'proof-persisted' }] },
          artifact: { id: 'artifact-persisted' },
          surfaceExecutionEventsV1: [{
            version: 1,
            eventId: 'native-terminal',
            sequence: 4,
            sessionId: 'surface-browser-native',
            runId: 'run-native',
            agentId: 'agent-native',
            surface: 'browser',
            phase: 'verify',
            status: 'succeeded',
            userSummary: '页面结果已验证',
            observation: { verdict: 'pass', findings: ['页面标题已出现'] },
            evidenceRefs: ['proof-native'],
            artifactRefs: [],
            availableControls: ['end_session'],
            startedAt: 10,
            completedAt: 20,
          }],
        },
      },
      conversationId: 'conversation-native',
      runId: 'run-native',
      agentId: 'agent-native',
      toolCallId: 'tool-native',
      startedAt: 10,
      completedAt: 20,
    });

    expect(result.metadata?.surfaceProjectionMode).toBe('native');
    expect(result.metadata?.surfaceExecutionEventV1).toMatchObject({
      eventId: 'native-terminal',
      sessionId: 'surface-browser-native',
      userSummary: '页面结果已验证',
      evidenceRefs: ['proof-native', 'proof-persisted'],
      artifactRefs: ['artifact-persisted'],
    });
  });

  it('fails closed when durable owner identity is incomplete', () => {
    const original = {
      success: false,
      error: 'surface-secret-canary-do-not-leak',
      metadata: { artifact: { id: 'artifact-1' } },
    };
    expect(attachSurfaceExecutionResultProjection({
      toolName: 'computer_use',
      arguments: { action: 'screenshot' },
      result: original,
      conversationId: 'conversation-1',
      runId: 'run-1',
      toolCallId: 'tool-1',
      startedAt: 10,
      completedAt: 20,
    })).toBe(original);
  });
});
