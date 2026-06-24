import { describe, expect, it } from 'vitest';

import { buildSessionTraceIdentity } from '../../../../src/shared/contract/reviewQueue';
import type { StructuredReplay } from '../../../../src/shared/contract/evaluation';
import {
  INCOMPLETE_TOOL_RESULT_MARKER,
  buildAgentTrajectoryCollectionMetadata,
  mergeAgentTrajectoryCollectionMetadata,
  resolveAgentTrajectoryCollectionMetadata,
} from '../../../../src/shared/contract/agentTrajectory';
import { evaluateAgentTrajectoryReplay } from '../../../../src/main/evaluation/trajectory/trajectoryGate';
import {
  buildAgentTrajectoryFromReplay,
  normalizeAgentTrajectorySampleWindow,
  shouldExportTrajectory,
} from '../../../../src/main/evaluation/trajectory/trajectoryExporter';
import {
  buildGateThresholdCalibration,
  buildP3ActionPlan,
  buildP3CollectionBlockers,
  buildP3RequirementAudit,
  buildP3ReviewWorklist,
  buildReviewPacketMarkdown,
  parseTimestampFlag,
} from '../../../../scripts/export-agent-trajectories';

function toolDistribution(): StructuredReplay['summary']['toolDistribution'] {
  return {
    Read: 1,
    Edit: 0,
    Write: 0,
    Bash: 0,
    Search: 0,
    Web: 0,
    Agent: 0,
    Skill: 0,
    Other: 0,
  };
}

function replay(overrides: Partial<StructuredReplay> = {}): StructuredReplay {
  const sessionId = overrides.sessionId ?? 'session-agent-trajectory';
  const traceIdentity = buildSessionTraceIdentity(sessionId);
  const base: StructuredReplay = {
    sessionId,
    traceIdentity,
    traceSource: 'session_replay',
    dataSource: 'telemetry',
    turns: [
      {
        turnNumber: 1,
        startTime: 100,
        durationMs: 80,
        inputTokens: 10,
        outputTokens: 12,
        blocks: [
          {
            type: 'user',
            content: 'Read package.json',
            timestamp: 100,
          },
          {
            type: 'model_call',
            content: 'mock/model: tool_use',
            timestamp: 110,
            modelDecision: {
              id: 'model-1',
              provider: 'mock',
              model: 'model',
              responseType: 'tool_use',
              toolCallCount: 1,
              inputTokens: 10,
              outputTokens: 12,
              latencyMs: 20,
              prompt: 'Read package.json',
              completion: 'Calling Read',
              toolSchemas: [
                {
                  name: 'Read',
                  inputSchema: { type: 'object' },
                  requiresPermission: false,
                  permissionLevel: 'read',
                },
              ],
            },
          },
          {
            type: 'tool_call',
            content: 'Read',
            timestamp: 130,
            toolCall: {
              id: 'tool-1',
              name: 'Read',
              args: { file_path: 'package.json' },
              actualArgs: { file_path: 'package.json' },
              argsSource: 'telemetry_actual',
              toolSchema: {
                name: 'Read',
                inputSchema: { type: 'object' },
              },
              result: '{"name":"code-agent"}',
              success: true,
              successKnown: true,
              duration: 12,
              category: 'Read',
            },
          },
          {
            type: 'event',
            content: '1 tool schemas available',
            timestamp: 105,
            event: {
              eventType: 'tool_schema_snapshot',
              summary: '1 tool schemas available',
            },
          },
          {
            type: 'text',
            content: 'package.json says code-agent.',
            timestamp: 180,
          },
        ],
      },
    ],
    summary: {
      totalTurns: 1,
      toolDistribution: toolDistribution(),
      thinkingRatio: 0,
      selfRepairChains: 0,
      totalDurationMs: 80,
      metricAvailability: {
        dataSource: 'telemetry',
        replaySource: 'telemetry',
        toolDistribution: 'telemetry',
        selfRepair: 'telemetry',
        actualArgs: 'telemetry',
      },
      telemetryCompleteness: {
        sessionId,
        replayKey: traceIdentity.replayKey,
        turnCount: 1,
        modelCallCount: 1,
        toolCallCount: 1,
        eventCount: 1,
        hasSessionId: true,
        hasModelDecisions: true,
        hasToolSchemas: true,
        hasPermissionTrace: false,
        hasContextCompressionEvents: false,
        hasSubagentTelemetry: false,
        hasRealAgentTrace: true,
        dataSource: 'telemetry',
        incompleteReasons: [],
      },
    },
  };
  return { ...base, ...overrides };
}

describe('Agent trajectory G0/G1/G2 gate', () => {
  it('passes G2 when replay has model provenance, schemas, tool result, and final answer', () => {
    const gate = evaluateAgentTrajectoryReplay(replay());

    expect(gate).toMatchObject({
      tier: 'G2',
      exportReady: true,
      failures: [],
      classification: {
        taskKind: 'coding',
        datasetRole: 'core_eval',
        reason: 'g2_agent_task',
      },
      metrics: {
        turnCount: 1,
        modelCallCount: 1,
        toolCallCount: 1,
        toolResultCount: 1,
        toolDefinitionCount: 1,
        finalAnswerPresent: true,
      },
    });
  });

  it('builds versioned collection metadata from quality and supports manual role overrides', () => {
    const gate = evaluateAgentTrajectoryReplay(replay());
    const generated = buildAgentTrajectoryCollectionMetadata(gate, {
      now: 1234,
      datasetVersion: 'agent-trajectory-v2',
    });

    expect(generated).toMatchObject({
      schemaVersion: 1,
      intent: 'new_core_eval_candidate',
      datasetRole: 'core_eval',
      taskKind: 'coding',
      datasetVersion: 'agent-trajectory-v2',
      source: 'quality_gate',
      createdAt: 1234,
      updatedAt: 1234,
    });

    const overridden = mergeAgentTrajectoryCollectionMetadata(
      generated,
      {
        datasetRole: 'diagnostic',
        notes: 'keep for regression debugging',
      },
      { now: 1500, source: 'manual_review' },
    );

    expect(overridden).toMatchObject({
      intent: 'historical_diagnostic',
      datasetRole: 'diagnostic',
      source: 'manual_review',
      reason: 'manual_review_override',
      reviewedAt: 1500,
      updatedAt: 1500,
      notes: 'keep for regression debugging',
    });
  });

  it('normalizes fresh sample windows and timestamp CLI flags', () => {
    expect(parseTimestampFlag('1772260856')).toBe(1772260856000);
    expect(parseTimestampFlag('1772260856000')).toBe(1772260856000);
    expect(parseTimestampFlag('2026-06-24T00:00:00+08:00')).toBe(Date.parse('2026-06-24T00:00:00+08:00'));

    expect(
      normalizeAgentTrajectorySampleWindow({
        since: 1772260856000,
        until: 1772260956000,
      }),
    ).toEqual({
      since: 1772260856000,
      until: 1772260956000,
    });
    expect(() =>
      normalizeAgentTrajectorySampleWindow({
        since: 2000,
        until: 1000,
      }),
    ).toThrow('trajectory sample since must be before until');
  });

  it('builds a human review packet with session decisions and failure context', () => {
    const packet = buildReviewPacketMarkdown({
      generatedAt: 1000,
      sourceDataDir: '/tmp/code-agent',
      copiedDataDir: true,
      sampleWindow: { since: 1 },
      totalSessions: 1,
      exported: 0,
      reviewManifestOut: 'eval-datasets/agent-trajectory/fresh-sample-review.json',
      reviewProgress: {
        manualReviewed: 0,
        pendingReview: 1,
      },
      qualityGate: {
        passed: false,
        failures: ['manual_reviewed_count_below_20'],
      },
      reviewItems: [
        {
          sessionId: 'session-review-packet',
          reviewScope: 'agent_candidate',
          currentDatasetRole: 'diagnostic',
          suggestedAction: 'review_diagnostic',
          priority: 'high',
          tier: 'G1',
          taskKind: 'search',
          collectionSource: 'audit_backfill',
          failures: ['missing_tool_definition'],
        },
      ],
    });

    expect(packet).toContain('# Agent Trajectory Review Packet');
    expect(packet).toContain('Pending review: 1');
    expect(packet).toContain('P3 agent candidate rows: 1');
    expect(packet).toContain('P3 scope');
    expect(packet).toContain('agent_candidate');
    expect(packet).toContain('session-review-packet');
    expect(packet).toContain('review_diagnostic');
    expect(packet).toContain('missing_tool_definition');
    expect(packet).toContain('Final review.datasetRole');
    expect(packet).toContain('collection.source = manual_review');
  });

  it('keeps threshold tuning blocked until manual review and collection quality are satisfied', () => {
    const thresholds = {
      minSessions: 20,
      minExported: 20,
      minManualReviewed: 20,
      maxPendingReview: 0,
      minG2Rate: 0.7,
      maxTopFailureRate: 0.2,
      maxDiagnosticRate: 0.3,
      maxExcludedRate: 0.05,
    };

    expect(
      buildGateThresholdCalibration({
        totalSessions: 20,
        agentCandidateSessions: 10,
        exported: 2,
        manualReviewed: 0,
        manualReviewedAgentCandidates: 0,
        pendingReview: 20,
        pendingAgentCandidateReview: 10,
        g2Rate: 0.1,
        topFailureRate: 0.6,
        diagnosticRate: 0.4,
        excludedRate: 0.5,
        topFailure: { failure: 'missing_tool_schemas', count: 12 },
        qualityGatePassed: false,
        thresholds: {
          ...thresholds,
          minAgentCandidates: 20,
        },
      }),
    ).toMatchObject({
      status: 'collect_more_sessions',
      recommendation: 'Collect at least 20 non-excluded agent-task sessions before tuning thresholds.',
      notes: ['Current sample has 10 non-excluded agent candidates.'],
    });

    expect(
      buildGateThresholdCalibration({
        totalSessions: 20,
        agentCandidateSessions: 20,
        exported: 2,
        manualReviewed: 20,
        manualReviewedAgentCandidates: 10,
        pendingReview: 0,
        pendingAgentCandidateReview: 10,
        g2Rate: 0.1,
        topFailureRate: 0.6,
        diagnosticRate: 0.4,
        excludedRate: 0.5,
        topFailure: { failure: 'missing_tool_schemas', count: 12 },
        qualityGatePassed: false,
        thresholds: {
          ...thresholds,
          minManualReviewedAgentCandidates: 20,
        },
      }),
    ).toMatchObject({
      status: 'manual_review_required',
      recommendation: 'Keep the strict P3 gate and finish manual review before threshold tuning.',
      notes: expect.arrayContaining([
        'Do not tune thresholds before manual Replay review is complete.',
        'Top quality blocker is missing_tool_schemas at 60.00%.',
      ]),
    });

    expect(
      buildGateThresholdCalibration({
        totalSessions: 20,
        agentCandidateSessions: 20,
        exported: 12,
        manualReviewed: 20,
        manualReviewedAgentCandidates: 20,
        pendingReview: 0,
        pendingAgentCandidateReview: 0,
        g2Rate: 0.6,
        topFailureRate: 0.25,
        diagnosticRate: 0.25,
        excludedRate: 0,
        topFailure: { failure: 'missing_tool_definition', count: 5 },
        qualityGatePassed: false,
        thresholds,
      }),
    ).toMatchObject({
      status: 'collection_quality_required',
      recommendation: 'Keep the strict P3 gate and fix the dominant collection-quality bucket before tuning.',
      notes: ['Fix or explain missing_tool_definition before lowering the gate.'],
    });
  });

  it('builds a requirement-by-requirement P3 closeout audit', () => {
    const thresholdCalibration = buildGateThresholdCalibration({
      totalSessions: 20,
      agentCandidateSessions: 10,
      exported: 2,
      manualReviewed: 0,
      manualReviewedAgentCandidates: 0,
      pendingReview: 20,
      pendingAgentCandidateReview: 10,
      g2Rate: 0.1,
      topFailureRate: 0.6,
      diagnosticRate: 0.4,
      excludedRate: 0.5,
      topFailure: { failure: 'missing_tool_schemas', count: 12 },
      qualityGatePassed: false,
      thresholds: {
        minSessions: 20,
        minAgentCandidates: 20,
        minExported: 20,
        minManualReviewed: 20,
        minManualReviewedAgentCandidates: 20,
        maxPendingReview: 0,
        minG2Rate: 0.7,
        maxTopFailureRate: 0.2,
        maxDiagnosticRate: 0.3,
        maxExcludedRate: 0.05,
      },
    });

    const audit = buildP3RequirementAudit({
      totalSessions: 20,
      exported: 2,
      sampleWindow: { since: 1772294400000 },
      byDatasetRole: {
        core_eval: 2,
        diagnostic: 8,
        excluded: 10,
      },
      reviewProgress: {
        manualReviewed: 0,
        manualReviewedAgentCandidates: 0,
        pendingReview: 20,
        pendingAgentCandidateReview: 10,
      },
      qualityGate: {
        passed: false,
        minSessions: 20,
        minAgentCandidates: 20,
        minExported: 20,
        minManualReviewed: 20,
        minManualReviewedAgentCandidates: 20,
        maxPendingReview: 0,
      },
      thresholdCalibration,
    });

    expect(audit).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          requirement: '20-50 live agent sessions sampled',
          status: 'partial',
          evidence:
            '20 sessions audited from {"since":1772294400000}; 10 are non-excluded agent candidates.',
        }),
        expect.objectContaining({
          requirement: 'Review Queue manual review complete',
          status: 'manual_review_required',
          evidence: '0 manually reviewed agent candidates; 10 agent candidates pending. Total pending rows: 20.',
        }),
        expect.objectContaining({
          requirement: 'core_eval JSONL export ready',
          status: 'failed',
          evidence: '2 core_eval rows exported; target is 20.',
        }),
        expect.objectContaining({
          requirement: 'diagnostic/excluded segmentation available',
          status: 'passed',
        }),
        expect.objectContaining({
          requirement: 'fresh-sample gate threshold calibration',
          status: 'partial',
        }),
        expect.objectContaining({
          requirement: 'P3 closeout decision',
          status: 'failed',
        }),
      ]),
    );
  });

  it('builds an ordered P3 action plan from live closeout gaps', () => {
    const thresholdCalibration = buildGateThresholdCalibration({
      totalSessions: 20,
      agentCandidateSessions: 10,
      exported: 2,
      manualReviewed: 0,
      manualReviewedAgentCandidates: 0,
      pendingReview: 20,
      pendingAgentCandidateReview: 10,
      g2Rate: 0.1,
      topFailureRate: 0.6,
      diagnosticRate: 0.4,
      excludedRate: 0.5,
      topFailure: { failure: 'missing_tool_schemas', count: 12 },
      qualityGatePassed: false,
      thresholds: {
        minSessions: 20,
        minAgentCandidates: 20,
        minExported: 20,
        minManualReviewed: 20,
        minManualReviewedAgentCandidates: 20,
        maxPendingReview: 0,
        minG2Rate: 0.7,
        maxTopFailureRate: 0.2,
        maxDiagnosticRate: 0.3,
        maxExcludedRate: 0.05,
      },
    });

    const actionPlan = buildP3ActionPlan({
      exported: 2,
      byDatasetRole: {
        core_eval: 2,
        diagnostic: 8,
        excluded: 10,
      },
      reviewProgress: {
        manualReviewed: 0,
        manualReviewedAgentCandidates: 0,
      },
      qualityGate: {
        passed: false,
        minSessions: 20,
        minAgentCandidates: 20,
        minExported: 20,
        minManualReviewed: 20,
        minManualReviewedAgentCandidates: 20,
        maxTopFailureRate: 0.2,
        maxDiagnosticRate: 0.3,
        maxExcludedRate: 0.05,
        topFailure: { failure: 'missing_tool_schemas', count: 12 },
        topFailureRate: 0.6,
      },
      thresholdCalibration,
    });

    expect(actionPlan.status).toBe('action_required');
    expect(actionPlan.items.slice(0, 3)).toEqual([
      expect.objectContaining({
        priority: 1,
        action: 'collect_agent_candidates',
        current: '10',
        target: '20',
        remaining: '10',
      }),
      expect.objectContaining({
        priority: 2,
        action: 'review_agent_candidates',
        current: '0',
        target: '20',
        remaining: '20',
      }),
      expect.objectContaining({
        priority: 4,
        action: 'promote_core_eval_rows',
        current: '2',
        target: '20',
        remaining: '18',
      }),
    ]);
    expect(actionPlan.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'fix_top_collection_blocker',
          current: '60.00%',
          target: '<= 20.00%',
        }),
      ]),
    );
  });

  it('builds an agent-candidate-first P3 review worklist', () => {
    const worklist = buildP3ReviewWorklist({
      reviewItems: [
        {
          sessionId: 'session-excluded',
          reviewScope: 'excluded_control',
          currentDatasetRole: 'excluded',
          suggestedAction: 'confirm_excluded',
          priority: 'high',
          tier: 'G0',
          taskKind: 'ordinary_chat',
          collectionSource: 'audit_backfill',
          failures: ['ordinary_chat_no_tool'],
        },
        {
          sessionId: 'session-diagnostic',
          reviewScope: 'agent_candidate',
          currentDatasetRole: 'diagnostic',
          suggestedAction: 'review_diagnostic',
          priority: 'high',
          tier: 'G1',
          taskKind: 'search',
          collectionSource: 'audit_backfill',
          failures: ['missing_tool_definition'],
        },
        {
          sessionId: 'session-reviewed',
          reviewScope: 'agent_candidate',
          currentDatasetRole: 'core_eval',
          suggestedAction: 'verify_core_eval',
          priority: 'medium',
          tier: 'G2',
          taskKind: 'coding',
          collectionSource: 'manual_review',
          failures: [],
        },
        {
          sessionId: 'session-core',
          reviewScope: 'agent_candidate',
          currentDatasetRole: 'core_eval',
          suggestedAction: 'verify_core_eval',
          priority: 'medium',
          tier: 'G2',
          taskKind: 'coding',
          collectionSource: 'audit_backfill',
          failures: [],
        },
      ],
    });

    expect(worklist.status).toBe('review_required');
    expect(worklist.nextReviewSessionId).toBe('session-diagnostic');
    expect(worklist.agentCandidateReviewCount).toBe(2);
    expect(worklist.excludedControlReviewCount).toBe(1);
    expect(worklist.reviewOrder.map((item) => item.sessionId)).toEqual([
      'session-diagnostic',
      'session-core',
      'session-excluded',
    ]);
    expect(worklist.agentCandidateReviewSessionIds).toEqual(['session-diagnostic', 'session-core']);
    expect(worklist.verifyCoreEvalSessionIds).toEqual(['session-core']);
    expect(worklist.reviewDiagnosticSessionIds).toEqual(['session-diagnostic']);
    expect(worklist.confirmExcludedSessionIds).toEqual(['session-excluded']);
    expect(worklist.topPendingFailure).toMatchObject({
      failure: 'missing_tool_definition',
      count: 1,
      agentCandidateSessionIds: ['session-diagnostic'],
    });
  });

  it('builds P3 collection blockers with affected session ids by scope', () => {
    const blockers = buildP3CollectionBlockers({
      reviewItems: [
        {
          sessionId: 'session-agent-1',
          reviewScope: 'agent_candidate',
          currentDatasetRole: 'diagnostic',
          suggestedAction: 'review_diagnostic',
          priority: 'high',
          tier: 'G1',
          taskKind: 'search',
          collectionSource: 'audit_backfill',
          failures: ['missing_tool_schemas', 'missing_tool_definition'],
        },
        {
          sessionId: 'session-agent-2',
          reviewScope: 'agent_candidate',
          currentDatasetRole: 'core_eval',
          suggestedAction: 'verify_core_eval',
          priority: 'medium',
          tier: 'G2',
          taskKind: 'coding',
          collectionSource: 'audit_backfill',
          failures: ['missing_tool_schemas'],
        },
        {
          sessionId: 'session-excluded',
          reviewScope: 'excluded_control',
          currentDatasetRole: 'excluded',
          suggestedAction: 'confirm_excluded',
          priority: 'low',
          tier: 'G0',
          taskKind: 'ordinary_chat',
          collectionSource: 'audit_backfill',
          failures: ['missing_tool_schemas', 'ordinary_chat_no_tool'],
        },
      ],
    });

    expect(blockers[0]).toMatchObject({
      failure: 'missing_tool_schemas',
      count: 3,
      agentCandidateCount: 2,
      excludedControlCount: 1,
      agentCandidateSessionIds: ['session-agent-1', 'session-agent-2'],
      excludedControlSessionIds: ['session-excluded'],
    });
    expect(blockers[1]).toMatchObject({
      failure: 'missing_tool_definition',
      count: 1,
      agentCandidateSessionIds: ['session-agent-1'],
      excludedControlSessionIds: [],
    });
  });

  it('marks transcript fallback as G0 review-only data', () => {
    const gate = evaluateAgentTrajectoryReplay(
      replay({
        dataSource: 'transcript_fallback',
        summary: {
          ...replay().summary,
          telemetryCompleteness: {
            ...replay().summary.telemetryCompleteness!,
            dataSource: 'transcript_fallback',
            hasRealAgentTrace: false,
            hasModelDecisions: false,
            hasToolSchemas: false,
            eventCount: 0,
          },
        },
      }),
    );

    expect(gate.tier).toBe('G0');
    expect(gate.exportReady).toBe(false);
    expect(gate.classification).toMatchObject({
      taskKind: 'coding',
      datasetRole: 'diagnostic',
    });
    expect(gate.failures).toEqual(
      expect.arrayContaining([
        'transcript_fallback_replay',
        'missing_model_decisions',
        'missing_tool_schemas',
        'missing_real_agent_trace',
      ]),
    );
  });

  it('keeps telemetry replay at G1 when tool schemas are missing', () => {
    const source = replay();
    const next = replay({
      turns: [
        {
          ...source.turns[0],
          blocks: source.turns[0]!.blocks.map((block) => {
            if (block.type === 'model_call' && block.modelDecision) {
              return {
                ...block,
                modelDecision: {
                  ...block.modelDecision,
                  toolSchemas: undefined,
                },
              };
            }
            if (block.type === 'tool_call' && block.toolCall) {
              return {
                ...block,
                toolCall: {
                  ...block.toolCall,
                  toolSchema: undefined,
                },
              };
            }
            return block;
          }),
        },
      ],
      summary: {
        ...source.summary,
        telemetryCompleteness: {
          ...source.summary.telemetryCompleteness!,
          hasToolSchemas: false,
          hasRealAgentTrace: false,
        },
      },
    });

    const gate = evaluateAgentTrajectoryReplay(next);

    expect(gate.tier).toBe('G1');
    expect(gate.classification.datasetRole).toBe('diagnostic');
    expect(gate.failures).toEqual(expect.arrayContaining(['missing_tool_schemas', 'missing_tool_definition']));
  });

  it('rejects pending tool result closeouts from G2 export', () => {
    const source = replay();
    const next = replay({
      turns: [
        {
          ...source.turns[0],
          blocks: source.turns[0]!.blocks.map((block) =>
            block.type === 'tool_call' && block.toolCall
              ? {
                  ...block,
                  toolCall: {
                    ...block.toolCall,
                    result: `${INCOMPLETE_TOOL_RESULT_MARKER} Tool call ended without a result.`,
                    success: false,
                  },
                }
              : block,
          ),
        },
      ],
    });

    const gate = evaluateAgentTrajectoryReplay(next);

    expect(gate.tier).toBe('G1');
    expect(gate.classification.datasetRole).toBe('diagnostic');
    expect(gate.failures).toContain('pending_tool_result');
    expect(gate.metrics.pendingToolResultCount).toBe(1);
  });

  it('marks ordinary chat as excluded data', () => {
    const source = replay();
    const next = replay({
      turns: [
        {
          ...source.turns[0],
          blocks: [
            {
              type: 'user',
              content: 'hello',
              timestamp: 100,
            },
            {
              type: 'model_call',
              content: 'mock/model: text',
              timestamp: 110,
              modelDecision: {
                id: 'model-1',
                provider: 'mock',
                model: 'model',
                responseType: 'text',
                toolCallCount: 0,
                inputTokens: 10,
                outputTokens: 12,
                latencyMs: 20,
                prompt: 'hello',
                completion: 'hi',
                toolSchemas: [],
              },
            },
            {
              type: 'text',
              content: 'hi',
              timestamp: 180,
            },
          ],
        },
      ],
      summary: {
        ...source.summary,
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
        telemetryCompleteness: {
          ...source.summary.telemetryCompleteness!,
          toolCallCount: 0,
          eventCount: 0,
          hasToolSchemas: false,
        },
      },
    });

    const gate = evaluateAgentTrajectoryReplay(next);

    expect(gate.classification).toMatchObject({
      taskKind: 'ordinary_chat',
      datasetRole: 'excluded',
      reason: 'ordinary_chat_excluded',
    });
    expect(gate.failures).toContain('ordinary_chat_no_tool');
  });

  it('builds canonical tool call and tool result steps from replay', () => {
    const collection = resolveAgentTrajectoryCollectionMetadata(evaluateAgentTrajectoryReplay(replay()), undefined, {
      datasetVersion: 'agent-trajectory-v2',
    });
    const trajectory = buildAgentTrajectoryFromReplay(replay(), { collection });

    expect(trajectory.quality.tier).toBe('G2');
    expect(trajectory.collection).toMatchObject({
      datasetRole: 'core_eval',
      datasetVersion: 'agent-trajectory-v2',
    });
    expect(trajectory.toolDefinitions).toEqual([expect.objectContaining({ name: 'Read' })]);
    expect(trajectory.steps.map((step) => step.role)).toEqual([
      'user',
      'model_call',
      'tool_call',
      'tool_result',
      'event',
      'assistant_final',
    ]);
    expect(trajectory.summary.toolCallCount).toBe(1);
    expect(trajectory.summary.toolResultCount).toBe(1);
  });

  it('keeps final core_eval export limited to manual review source when required', () => {
    const generated = resolveAgentTrajectoryCollectionMetadata(evaluateAgentTrajectoryReplay(replay()), undefined, {
      datasetVersion: 'agent-trajectory-v2',
      source: 'audit_backfill',
    });
    const reviewed = mergeAgentTrajectoryCollectionMetadata(
      generated,
      { datasetRole: 'core_eval', reviewedBy: 'dad' },
      { source: 'manual_review' },
    );
    const draftTrajectory = buildAgentTrajectoryFromReplay(replay(), { collection: generated });
    const reviewedTrajectory = buildAgentTrajectoryFromReplay(replay(), { collection: reviewed });

    expect(shouldExportTrajectory(draftTrajectory, 'G2', false)).toBe(true);
    expect(shouldExportTrajectory(draftTrajectory, 'G2', false, 'manual_review')).toBe(false);
    expect(shouldExportTrajectory(reviewedTrajectory, 'G2', false, 'manual_review')).toBe(true);
  });
});
