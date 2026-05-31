import { describe, expect, it } from 'vitest';
import { buildSessionTraceIdentity } from '@shared/contract/reviewQueue';
import {
  buildEvalReplayQualityReport,
  normalizeQualityReportStatus,
  type ArtifactIssue,
  type EvalReplayQualityGate,
  type ProductClosureAuditReport,
  type ProductClosureAuditRole,
} from '@shared/contract/productClosure';

describe('product closure contracts', () => {
  it('records the five read-only Agent Team audit roles with evidence', () => {
    const roles: ProductClosureAuditRole[] = [
      'runtime_workflow',
      'product_ux',
      'safety_permission',
      'eval_observability',
      'anthropic_benchmark',
    ];

    const report: ProductClosureAuditReport = {
      reportId: 'neo-product-closure-2026-05-31',
      createdAt: 1_780_252_800_000,
      title: 'Agent Neo product closure audit',
      sourceAgents: roles.map((role, index) => ({
        role,
        agentId: `agent-${index + 1}`,
      })),
      liveContracts: ['ScriptRunEvent', 'WorkflowLaunchEvent', 'UnifiedTraceIdentity'],
      legacyOrAdvancedPaths: ['workflow_orchestrate', 'scenarioAcceptance'],
      findings: roles.map((role) => ({
        id: `${role}-p0`,
        role,
        phase: 'agent_team_audit',
        priority: 'P0',
        title: `${role} gap`,
        currentState: 'Read-only evidence exists.',
        gap: 'The default product path is not closed.',
        recommendation: 'Promote the evidence into the product closure roadmap.',
        evidence: [{ label: role, path: `src/${role}.ts`, line: 1 }],
      })),
    };

    expect(report.sourceAgents.map((agent) => agent.role).sort()).toEqual([...roles].sort());
    expect(report.findings).toHaveLength(5);
    expect(report.findings.every((finding) => finding.evidence.length > 0)).toBe(true);
  });

  it('keeps artifact issues tied to the unified replay identity', () => {
    const traceIdentity = buildSessionTraceIdentity('session-1');
    const issue: ArtifactIssue = {
      issueId: 'issue-1',
      artifactId: 'artifact-1',
      artifactKind: 'dashboard',
      traceIdentity,
      source: 'artifact_verifier',
      code: 'console_error',
      severity: 'high',
      status: 'open',
      title: 'Dashboard renders with a console error',
      message: 'The generated dashboard logs an uncaught runtime error.',
      createdAt: 1_780_252_800_000,
      updatedAt: 1_780_252_800_000,
      evidenceRefs: [
        {
          evidenceId: 'evidence-1',
          kind: 'console_error',
          ref: 'telemetry:turn-1',
          summary: 'Uncaught TypeError while rendering chart.',
          sensitivity: 'metadata_only',
          createdAt: 1_780_252_800_000,
        },
      ],
    };

    expect(issue.traceIdentity.traceId).toBe('session:session-1');
    expect(issue.traceIdentity.replayKey).toBe('session-1');
    expect(issue.evidenceRefs[0].kind).toBe('console_error');
  });

  it('derives quality report status from gates by product risk', () => {
    const gate = (status: EvalReplayQualityGate['status']): EvalReplayQualityGate => ({
      gateId: status,
      name: status,
      status,
      summary: `${status} gate`,
    });

    expect(normalizeQualityReportStatus([])).toBe('needs_review');
    expect(normalizeQualityReportStatus([gate('passed')])).toBe('passed');
    expect(normalizeQualityReportStatus([gate('passed'), gate('skipped')])).toBe('needs_review');
    expect(normalizeQualityReportStatus([gate('passed'), gate('degraded')])).toBe('degraded');
    expect(normalizeQualityReportStatus([gate('degraded'), gate('failed')])).toBe('failed');
  });

  it('builds eval/replay quality reports from telemetry gates and artifact issues', () => {
    const traceIdentity = buildSessionTraceIdentity('session-2');
    const report = buildEvalReplayQualityReport({
      reportId: 'quality-1',
      traceIdentity,
      createdAt: 1_780_252_800_000,
      runId: 'run-1',
      caseId: 'case-1',
      telemetryCompleteness: {
        sessionId: 'session-2',
        replayKey: 'session-2',
        turnCount: 1,
        modelCallCount: 0,
        toolCallCount: 1,
        eventCount: 0,
        hasModelDecisions: false,
        hasToolSchemas: false,
        hasPermissionTrace: false,
        hasContextCompressionEvents: false,
        hasSubagentTelemetry: false,
        hasRealAgentTrace: false,
        dataSource: 'telemetry',
      },
      artifactIssues: [{
        issueId: 'issue-2',
        artifactId: 'artifact-2',
        artifactKind: 'dashboard',
        traceIdentity,
        source: 'eval_gate',
        code: 'runtime_error',
        severity: 'high',
        status: 'open',
        title: 'Runtime error',
        message: 'Artifact throws during review.',
        createdAt: 1_780_252_800_000,
        updatedAt: 1_780_252_800_000,
        evidenceRefs: [{
          evidenceId: 'evidence-2',
          kind: 'eval_case',
          ref: 'case-1',
          summary: 'Eval case failed.',
          sensitivity: 'metadata_only',
          createdAt: 1_780_252_800_000,
        }],
      }],
    });

    expect(report).toMatchObject({
      reportId: 'quality-1',
      status: 'failed',
      runId: 'run-1',
      caseId: 'case-1',
      traceIdentity: { traceId: 'session:session-2', replayKey: 'session-2' },
    });
    expect(report.gates.map((gate) => gate.gateId)).toEqual(['telemetry_replay', 'artifact_issues']);
    expect(report.gates[0]).toMatchObject({
      status: 'failed',
      failures: expect.arrayContaining(['missing_model_decisions', 'missing_event_trace', 'missing_tool_schemas', 'missing_real_agent_trace']),
    });
    expect(report.gates[1]).toMatchObject({
      status: 'failed',
      failures: ['runtime_error:issue-2'],
    });
  });
});
