import { describe, expect, it } from 'vitest';
import { makeEvidenceRef } from '../../../src/shared/contract/evidence';
import type { CachedSession } from '../../../src/host/session/localCache';
import type { BrowserComputerProofRecord } from '../../../src/host/session/browserComputerProofStore';
import type { Task } from '../../../src/shared/contract/backgroundTask';
import {
  attachEvidenceControlProjectionToReplay,
  buildEvidenceControlSummary,
  formatEvidenceControlSummaryForMarkdown,
} from '../../../src/host/session/evidenceControlSummary';
import type { StructuredReplay } from '../../../src/shared/contract/evaluation';

function session(overrides: Partial<CachedSession> = {}): CachedSession {
  return {
    sessionId: 'session-1',
    startedAt: 1,
    lastActivityAt: 2,
    totalTokens: 0,
    messages: [],
    ...overrides,
  };
}

function browserRecord(overrides: Partial<BrowserComputerProofRecord> = {}): BrowserComputerProofRecord {
  const evidence = makeEvidenceRef({
    id: 'evidence-browser',
    kind: 'screenshot',
    ref: '.../screen.png',
    source: 'browser_action.screenshot',
    capturedAtMs: 20,
    state: 'read',
    redactionStatus: 'redacted',
  });
  return {
    schemaVersion: 1,
    id: 'bc-1',
    sessionId: 'session-1',
    toolCallId: 'tool-browser',
    toolName: 'browser_action',
    traceId: 'trace-browser',
    createdAt: 20,
    status: 'observed',
    summary: 'Observed via dom',
    evidenceRefIds: [evidence.id],
    targetKind: 'browser',
    proof: {
      evidenceRefs: [evidence],
      visualObservation: { observed: true, source: 'dom' },
    },
    card: {
      status: 'observed',
      summary: 'Observed via dom',
      evidenceRefIds: [evidence.id],
    },
    ...overrides,
  };
}

function backgroundTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'shell:dev',
    kind: 'shell',
    sessionId: 'session-1',
    source: 'shell',
    title: 'npm run dev',
    command: 'npm run dev',
    status: 'running',
    createdAt: 10,
    updatedAt: 30,
    startedAt: 10,
    metadata: {
      recoveryStatus: 'running-recovered',
      recoveryPlan: {
        status: 'running-recovered',
        recoverable: true,
        summary: '应用重启后检测到进程仍在运行，可继续轮询并查看日志。',
        controlActions: ['poll', 'open_log', 'kill'],
      },
    },
    events: [],
    outputRefs: [],
    ...overrides,
  };
}

describe('evidenceControlSummary', () => {
  it('builds a session-level summary across verification, browser proof, and background recovery', () => {
    const verificationRef = makeEvidenceRef({
      id: 'evidence-typecheck',
      kind: 'typecheck',
      ref: 'verification:typecheck',
      source: 'goalCompletionGate',
      capturedAtMs: 10,
      state: 'read',
    });
    const summary = buildEvidenceControlSummary({
      session: session({
        metadata: {
          goalGate: {
            verificationStatus: 'passed',
            verificationCard: {
              status: 'passed',
              summary: 'required checks passed',
              counts: { passed: 1, failed: 0, notRun: 0, total: 1 },
              requiredStatus: 'passed',
              commands: [],
              evidenceRefIds: [verificationRef.id],
              skippedChecks: [],
            },
            evidenceRefs: [verificationRef],
          },
        },
      }),
      browserComputerProofRecords: [browserRecord()],
      backgroundTasks: [backgroundTask()],
      now: () => 100,
    });

    expect(summary.counts.bySource).toMatchObject({
      verification: 1,
      browser_computer: 1,
      background_recovery: 1,
    });
    expect(summary.counts.totalEvidenceRefs).toBe(3);
    expect(summary.trustLevel).toBe('strong');
    expect(summary.gaps).toEqual([]);
    expect(summary.items.map((item) => item.status).sort()).toEqual(['observed', 'passed', 'recovered']);
  });

  it('tracks stale and export-blocked evidence without treating it as trustworthy', () => {
    const blockedRef = makeEvidenceRef({
      id: 'evidence-blocked',
      kind: 'screenshot',
      ref: '[redacted]',
      source: 'screenshot',
      capturedAtMs: 10,
      state: 'stale',
      redactionStatus: 'contains_secret_blocked',
    });

    const summary = buildEvidenceControlSummary({
      session: session(),
      browserComputerProofRecords: [browserRecord({
        status: 'not_observed',
        summary: 'Screenshot path only',
        proof: { evidenceRefs: [blockedRef] },
        card: {
          status: 'not_observed',
          summary: 'Screenshot path only',
          evidenceRefIds: [blockedRef.id],
        },
      })],
      now: () => 100,
    });

    expect(summary.trustLevel).toBe('weak');
    expect(summary.counts.blockedItems).toBe(1);
    expect(summary.counts.staleItems).toBe(1);
    expect(summary.gaps).toEqual(expect.arrayContaining([
      'missing verification evidence',
      'missing background recovery evidence',
      'export-blocked evidence present',
      'stale evidence present',
    ]));
  });

  it('includes persisted completion-summary verification evidence', () => {
    const summary = buildEvidenceControlSummary({
      session: session(),
      completionSummaries: [{
        schemaVersion: 1,
        id: 'completion-1',
        sessionId: 'session-1',
        objective: 'Ship evidence summary',
        status: 'goal_met',
        startedAt: 1,
        endedAt: 50,
        durationMs: 49,
        iterations: 1,
        tokenUsage: { input: 1, output: 2, total: 3 },
        toolCallCount: 1,
        changedFiles: [],
        commands: [],
        verificationEvidence: [{
          kind: 'command',
          toolCallId: 'bash-1',
          command: 'npm run typecheck',
          success: true,
          exitCode: 0,
        }],
        commitIds: [],
        risks: [],
        blockers: [],
        artifactRefs: [],
      }],
      now: () => 100,
    });

    expect(summary.counts.bySource.verification).toBe(1);
    expect(summary.items[0]).toMatchObject({
      source: 'verification',
      status: 'passed',
      evidenceRefIds: [expect.stringMatching(/^evidence_/)],
    });
    expect(summary.items[0].evidenceRefs[0]).toMatchObject({
      kind: 'typecheck',
      source: 'completionSummary.verification',
      freshness: expect.objectContaining({ state: 'read' }),
    });
  });

  it('includes browser/computer trajectory proof timeline entries', () => {
    const summary = buildEvidenceControlSummary({
      session: session(),
      browserComputerProofTimeline: [{
        turnNumber: 2,
        toolCallId: 'tool-trajectory',
        toolName: 'computer_use',
        status: 'manual_takeover',
        summary: 'Manual takeover required: login_required',
        evidenceRefIds: ['evidence-trajectory'],
        timestamp: 80,
        traceId: 'trace-trajectory',
        visualSource: 'ax',
        manualTakeoverStatus: 'login_required',
      }],
      now: () => 100,
    });

    expect(summary.counts.bySource.trajectory).toBe(1);
    expect(summary.items[0]).toMatchObject({
      source: 'trajectory',
      status: 'manual_takeover',
      summary: 'Manual takeover required: login_required',
      metadata: expect.objectContaining({
        turnNumber: 2,
        visualSource: 'ax',
        manualTakeoverStatus: 'login_required',
      }),
    });
  });

  it('marks conflicting statuses on the same evidence id', () => {
    const sharedRef = makeEvidenceRef({
      id: 'evidence-conflict',
      kind: 'screenshot',
      ref: 'trace:conflict',
      source: 'browser_action',
      capturedAtMs: 10,
      state: 'read',
    });
    const summary = buildEvidenceControlSummary({
      session: session(),
      browserComputerProofRecords: [
        browserRecord({
          id: 'observed-record',
          status: 'observed',
          proof: { evidenceRefs: [sharedRef] },
          card: { status: 'observed', summary: 'Observed via dom', evidenceRefIds: [sharedRef.id] },
        }),
        browserRecord({
          id: 'not-observed-record',
          status: 'not_observed',
          summary: 'Screenshot path only',
          proof: { evidenceRefs: [sharedRef] },
          card: { status: 'not_observed', summary: 'Screenshot path only', evidenceRefIds: [sharedRef.id] },
        }),
      ],
      now: () => 100,
    });

    expect(summary.trustLevel).toBe('weak');
    expect(summary.counts.conflictItems).toBe(2);
    expect(summary.conflicts).toHaveLength(1);
    expect(summary.conflicts[0]).toContain('evidence-conflict');
    expect(summary.conflicts[0]).toContain('observed');
    expect(summary.conflicts[0]).toContain('not_observed');
    expect(summary.gaps).toContain('conflicting evidence statuses present');
  });

  it('formats a sanitized markdown control summary', () => {
    const summary = buildEvidenceControlSummary({
      session: session({
        metadata: {
          goalGate: {
            verificationStatus: 'passed',
            verificationCard: {
              status: 'passed',
              summary: 'log at /Users/linchen/Desktop/private.log?token=secret-token cookie=cookie-secret',
              counts: { passed: 1, failed: 0, notRun: 0, total: 1 },
              requiredStatus: 'passed',
              commands: [],
              evidenceRefIds: [],
              skippedChecks: [],
            },
          },
        },
      }),
      browserComputerProofRecords: [browserRecord({
        summary: 'raw image data:image/png;base64,abcdef and /tmp/private.png localStorage=local-secret',
      })],
      now: () => 100,
    });

    const markdown = formatEvidenceControlSummaryForMarkdown(summary);
    expect(markdown).toContain('## Evidence Control Summary');
    expect(markdown).toContain('verification 1');
    expect(markdown).toContain('browser/computer 1');
    expect(markdown).not.toContain('/Users/linchen');
    expect(markdown).not.toContain('/tmp/private.png');
    expect(markdown).not.toContain('secret-token');
    expect(markdown).not.toContain('base64,abcdef');
    expect(markdown).not.toContain('cookie-secret');
    expect(markdown).not.toContain('local-secret');
  });

  it('projects a sanitized evidence control summary onto structured replay', () => {
    const sharedRef = makeEvidenceRef({
      id: '/Users/linchen/private.png?token=secret-token-data:image/png;base64,abcdef-cookie=cookie-secret',
      kind: 'screenshot',
      ref: 'trace:conflict',
      source: 'browser_action',
      capturedAtMs: 10,
      state: 'read',
    });
    const summary = buildEvidenceControlSummary({
      session: session(),
      browserComputerProofRecords: [
        browserRecord({
          id: 'observed-record',
          status: 'observed',
          proof: { evidenceRefs: [sharedRef] },
          card: { status: 'observed', summary: 'Observed via dom', evidenceRefIds: [sharedRef.id] },
        }),
        browserRecord({
          id: 'not-observed-record',
          status: 'not_observed',
          summary: 'Screenshot path only',
          proof: { evidenceRefs: [sharedRef] },
          card: { status: 'not_observed', summary: 'Screenshot path only', evidenceRefIds: [sharedRef.id] },
        }),
      ],
      now: () => 100,
    });
    const replay: StructuredReplay = {
      sessionId: 'session-1',
      traceIdentity: {
        traceId: 'trace-session-1',
        traceSource: 'session_replay',
        source: 'session_replay',
        sessionId: 'session-1',
        replayKey: 'session-1',
      },
      traceSource: 'session_replay',
      dataSource: 'transcript_fallback',
      turns: [],
      summary: {
        totalTurns: 0,
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
        selfRepairChains: 0,
        totalDurationMs: 0,
      },
    };

    const withProjection = attachEvidenceControlProjectionToReplay(replay, summary);

    expect(withProjection.summary.evidenceControl).toMatchObject({
      trustLevel: 'weak',
      totalItems: 2,
      conflictItems: 2,
    });
    expect(JSON.stringify(withProjection.summary.evidenceControl)).not.toContain('/Users/linchen');
    expect(JSON.stringify(withProjection.summary.evidenceControl)).not.toContain('secret-token');
    expect(JSON.stringify(withProjection.summary.evidenceControl)).not.toContain('base64,abcdef');
    expect(JSON.stringify(withProjection.summary.evidenceControl)).not.toContain('cookie-secret');
  });
});
