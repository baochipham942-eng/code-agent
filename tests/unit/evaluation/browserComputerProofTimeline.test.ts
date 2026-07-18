import { describe, expect, it } from 'vitest';
import type { StructuredReplay } from '../../../src/shared/contract/evaluation';
import { attachBrowserComputerProofTimeline } from '../../../src/shared/utils/browserComputerProofTimeline';
import { buildAgentTrajectoryFromReplay } from '../../../src/host/evaluation/trajectory/trajectoryExporter';
import { evaluateAgentTrajectoryReplay, resolveAgentTrajectoryCollectionMetadata } from '../../../src/shared/contract/agentTrajectory';
import { attachEvidenceControlProjectionToReplay, buildEvidenceControlSummary } from '../../../src/host/session/evidenceControlSummary';

function replay(): StructuredReplay {
  return {
    sessionId: 'session-proof',
    traceIdentity: {
      traceId: 'trace-proof',
      traceSource: 'session_replay',
      source: 'session_replay',
      sessionId: 'session-proof',
      replayKey: 'session-proof',
    },
    traceSource: 'session_replay',
    dataSource: 'transcript_fallback',
    turns: [{
      turnNumber: 1,
      blocks: [{
        type: 'tool_call',
        content: 'browser_action',
        timestamp: 100,
        toolCall: {
          id: 'tool-1',
          name: 'browser_action',
          args: { action: 'get_dom_snapshot' },
          success: true,
          successKnown: true,
          duration: 12,
          category: 'Other',
          resultMetadata: {
            traceId: 'trace-browser',
            browserComputerEvidenceCard: {
              title: 'Browser/Computer Evidence',
              status: 'manual_takeover',
              summary: 'Manual takeover required: login_required',
              evidenceRefIds: ['evidence_dom'],
            },
            browserComputerProof: {
              manualTakeover: { status: 'login_required' },
              visualObservation: { observed: true, source: 'dom' },
            },
          },
        },
      }],
      inputTokens: 0,
      outputTokens: 0,
      durationMs: 12,
      startTime: 100,
    }],
    summary: {
      totalTurns: 1,
      toolDistribution: {
        Read: 0,
        Write: 0,
        Edit: 0,
        Bash: 0,
        Search: 0,
        Web: 0,
        Agent: 0,
        Skill: 0,
        Other: 1,
      },
      thinkingRatio: 0,
      selfRepairChains: 0,
      totalDurationMs: 12,
    },
  };
}

describe('Browser/Computer proof timeline', () => {
  it('attaches proof card entries to structured replay and trajectory summary', () => {
    const withTimeline = attachBrowserComputerProofTimeline(replay());
    const withEvidenceControl = attachEvidenceControlProjectionToReplay(
      withTimeline,
      buildEvidenceControlSummary({
        session: {
          sessionId: 'session-proof',
          startedAt: 1,
          lastActivityAt: 2,
          totalTokens: 0,
          messages: [],
        },
        browserComputerProofTimeline: withTimeline.summary.browserComputerProofTimeline,
        now: () => 200,
      }),
    );

    expect(withEvidenceControl.summary.browserComputerProofTimeline).toEqual([
      expect.objectContaining({
        turnNumber: 1,
        toolCallId: 'tool-1',
        toolName: 'browser_action',
        status: 'manual_takeover',
        summary: 'Manual takeover required: login_required',
        evidenceRefIds: ['evidence_dom'],
        traceId: 'trace-browser',
        visualSource: 'dom',
        manualTakeoverStatus: 'login_required',
      }),
    ]);
    expect(withEvidenceControl.summary.evidenceControl).toMatchObject({
      trustLevel: 'partial',
      totalItems: 1,
      bySource: expect.objectContaining({ trajectory: 1 }),
    });

    const quality = evaluateAgentTrajectoryReplay(withEvidenceControl);
    const collection = resolveAgentTrajectoryCollectionMetadata(quality, undefined, {
      datasetVersion: 'agent-trajectory-v2',
    });
    const trajectory = buildAgentTrajectoryFromReplay(withEvidenceControl, { collection });

    expect(trajectory.summary.browserComputerProofCount).toBe(1);
    expect(trajectory.summary.browserComputerProofTimeline?.[0]).toMatchObject({
      toolCallId: 'tool-1',
      status: 'manual_takeover',
    });
    expect(trajectory.summary.evidenceControl).toMatchObject({
      trustLevel: 'partial',
      totalItems: 1,
    });
  });
});
