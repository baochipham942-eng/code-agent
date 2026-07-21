import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { StructuredReplay } from '../../../src/shared/contract/evaluation';
import type { SurfaceExecutionExportProjectionV1 } from '../../../src/shared/utils/surfaceExecutionExportProjection';
import {
  findRawSurfaceFields,
  reproducesFailureAdjustPass,
  surfaceReplaySemanticDigest,
  surfaceReplaySemanticsFromProjection,
  surfaceReplaySemanticsFromReplay,
} from '../../../scripts/acceptance/surface-execution-replay-import-child';

function projection(): SurfaceExecutionExportProjectionV1 {
  return {
    version: 1,
    sessions: [{
      sessionId: 'source-surface-session',
      surface: 'browser',
      provider: 'managed-playwright',
      state: 'completed',
      source: 'native',
      events: [
        {
          eventId: 'verify-failed',
          sequence: 1,
          surface: 'browser',
          phase: 'verify',
          status: 'failed',
          userSummary: 'Initial business verification failed',
          observation: { verdict: 'fail', findings: ['Expected state was absent'] },
          evidenceRefs: ['screenshot-before'],
          evidence: [{
            evidenceId: 'screenshot-before',
            kind: 'screenshot',
            source: 'browser',
            title: 'Initial verification screenshot metadata',
            capturedAt: 10,
            redactionStatus: 'clean',
            captureState: 'captured',
            analysisState: 'analyzed',
            verificationState: 'rejected',
            supportsStepIds: ['verify-before'],
            checklist: [],
          }],
          artifactRefs: [],
          availableControls: [],
          startedAt: 10,
          completedAt: 11,
        },
        {
          eventId: 'adjust-succeeded',
          sequence: 2,
          surface: 'browser',
          phase: 'act',
          status: 'succeeded',
          userSummary: 'Adjusted the generated business artifact',
          operation: { action: 'click', risk: 'write' },
          evidenceRefs: [],
          evidence: [],
          artifactRefs: [],
          availableControls: [],
          actionResult: {
            delivery: 'confirmed',
            verification: 'satisfied',
            overall: 'succeeded',
          },
          startedAt: 12,
          completedAt: 13,
        },
        {
          eventId: 'verify-passed',
          sequence: 3,
          surface: 'browser',
          phase: 'verify',
          status: 'succeeded',
          userSummary: 'Adjusted business state passed re-verification',
          observation: { verdict: 'pass', findings: ['Expected state is visible'] },
          evidenceRefs: ['screenshot-after'],
          evidence: [{
            evidenceId: 'screenshot-after',
            kind: 'screenshot',
            source: 'browser',
            title: 'Final verification screenshot metadata',
            capturedAt: 14,
            redactionStatus: 'clean',
            captureState: 'captured',
            analysisState: 'analyzed',
            verificationState: 'verified',
            supportsStepIds: ['verify-after'],
            checklist: [],
          }],
          artifactRefs: [],
          availableControls: [],
          startedAt: 14,
          completedAt: 15,
        },
      ],
    }],
  };
}

function replayFromProjection(source: SurfaceExecutionExportProjectionV1): StructuredReplay {
  const blocks = source.sessions[0].events.map((event) => ({
    type: 'event' as const,
    content: event.userSummary,
    timestamp: event.startedAt,
    event: {
      eventType: 'surface_execution_archive',
      summary: event.userSummary,
      data: {
        surface: source.sessions[0].surface,
        phase: event.phase,
        status: event.status,
        operation: event.operation,
        observation: event.observation,
        evidence: event.evidence,
        actionResult: event.actionResult,
      },
    },
  }));
  return {
    sessionId: 'imported-session',
    traceIdentity: {
      sessionId: 'imported-session',
      traceId: 'trace-imported-session',
      rootRunId: null,
      parentRunId: null,
    },
    traceSource: 'session_replay',
    dataSource: 'transcript_fallback',
    turns: [{
      turnNumber: 1,
      turnType: 'iteration',
      blocks,
      inputTokens: 0,
      outputTokens: 0,
      durationMs: 5,
      startTime: 10,
    }],
    summary: {
      totalTurns: 1,
      toolDistribution: {
        Read: 0,
        Edit: 0,
        Write: 0,
        Bash: 0,
        Search: 0,
        Web: 0,
        Agent: 0,
        Skill: 0,
        Other: 0,
      },
      thinkingRatio: 0,
      selfRepairChains: 1,
      totalDurationMs: 5,
    },
  };
}

describe('Surface Execution fresh-process replay import child', () => {
  it('uses production import, archive projection, and transcript replay APIs behind a guarded entrypoint', () => {
    const source = readFileSync(resolve(
      process.cwd(),
      'scripts/acceptance/surface-execution-replay-import-child.ts',
    ), 'utf8');

    expect(source).toContain('await initDatabase()');
    expect(source).toContain('await sessionManager.importSession(source)');
    expect(source).toContain('new SurfaceConversationProjectionService({');
    expect(source).toContain('const replay = buildTranscriptReplay(importedSessionId, emptyCompleteness)');
    expect(source).toContain('parseSurfaceExecutionExportProjectionV1(');
    expect(source).toContain('collectSurfaceExecutionExportProjection(session.messages, session.metadata)');
    expect(source).toContain("requireStringOption(args, 'source-export')");
    expect(source).toContain("requireStringOption(args, 'source-session-id')");
    expect(source).toContain("requireStringOption(args, 'out')");
    expect(source).toContain("entryPath === resolve(fileURLToPath(import.meta.url))");
    expect(source).not.toContain('snapshotConversation: () => live');
  });

  it('reproduces verify-fail, adjust, verify-pass semantics with a stable digest', () => {
    const source = projection();
    const replay = replayFromProjection(source);
    const sourceSemantics = surfaceReplaySemanticsFromProjection(source);
    const replaySemantics = surfaceReplaySemanticsFromReplay(replay);

    expect(reproducesFailureAdjustPass(sourceSemantics)).toBe(true);
    expect(reproducesFailureAdjustPass(replaySemantics)).toBe(true);
    expect(surfaceReplaySemanticDigest(replaySemantics)).toBe(
      surfaceReplaySemanticDigest(sourceSemantics),
    );
  });

  it('detects raw authority, target, path, and portable screenshot payload fields', () => {
    expect(findRawSurfaceFields({
      grantId: 'grant-secret',
      nested: {
        activeTarget: { tabRef: 'tab-secret' },
        evidence: { assetRef: '/private/proof.png', bytes: 1024 },
      },
    })).toEqual([
      'grantId',
      'nested.activeTarget',
      'nested.activeTarget.tabRef',
      'nested.evidence.assetRef',
      'nested.evidence.bytes',
    ]);
    expect(findRawSurfaceFields(projection())).toEqual([]);
  });
});
