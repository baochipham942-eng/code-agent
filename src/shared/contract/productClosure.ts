import type { DecisionTrace } from './decisionTrace';
import {
  getReplayCompletenessReasons,
  type TelemetryCompleteness,
} from './evaluation';
import type { UnifiedTraceIdentity } from './reviewQueue';

export type ProductClosureAuditRole =
  | 'runtime_workflow'
  | 'product_ux'
  | 'safety_permission'
  | 'eval_observability'
  | 'anthropic_benchmark';

export type ProductClosurePhase =
  | 'agent_team_audit'
  | 'default_long_task_path'
  | 'safety_autonomy'
  | 'managed_long_task_runtime'
  | 'quality_release_loop';

export type ProductClosurePriority = 'P0' | 'P1' | 'P2';

export type LongTaskSurface =
  | 'chat'
  | 'workflow'
  | 'agent_team'
  | 'workflow_orchestrate'
  | 'spawn_agent'
  | 'background_task';

export type LongTaskProductLevel = 'default' | 'expert' | 'compatibility';

export type LongTaskUiStatus =
  | 'queued'
  | 'running'
  | 'waiting_approval'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'blocked';

export interface LongTaskSurfaceContract {
  surface: LongTaskSurface;
  productLevel: LongTaskProductLevel;
  primaryUse: string;
  entrypoint: string;
}

export const LONG_TASK_STATUS_VOCABULARY: readonly LongTaskUiStatus[] = [
  'queued',
  'running',
  'waiting_approval',
  'paused',
  'completed',
  'failed',
  'cancelled',
  'blocked',
];

export const LONG_TASK_SURFACE_CONTRACTS: Record<LongTaskSurface, LongTaskSurfaceContract> = {
  chat: {
    surface: 'chat',
    productLevel: 'default',
    primaryUse: 'ordinary interactive tasks',
    entrypoint: 'Chat',
  },
  workflow: {
    surface: 'workflow',
    productLevel: 'default',
    primaryUse: 'complex long tasks',
    entrypoint: '/workflow',
  },
  agent_team: {
    surface: 'agent_team',
    productLevel: 'expert',
    primaryUse: 'specialist parallel review and decomposition',
    entrypoint: 'Agent Team panel',
  },
  workflow_orchestrate: {
    surface: 'workflow_orchestrate',
    productLevel: 'compatibility',
    primaryUse: 'legacy scripted orchestration callers',
    entrypoint: 'workflow_orchestrate',
  },
  spawn_agent: {
    surface: 'spawn_agent',
    productLevel: 'compatibility',
    primaryUse: 'legacy single-agent and tool-call callers',
    entrypoint: 'spawn_agent',
  },
  background_task: {
    surface: 'background_task',
    productLevel: 'expert',
    primaryUse: 'managed external agent engines',
    entrypoint: 'Task Ledger',
  },
};

export function normalizeLongTaskStatus(status: unknown): LongTaskUiStatus {
  const normalized = String(status ?? '').trim().toLowerCase();
  switch (normalized) {
    case 'pending':
    case 'queued':
    case 'ready':
    case 'idle':
      return 'queued';
    case 'in_progress':
    case 'executing':
    case 'using_tools':
    case 'running':
      return 'running';
    case 'waiting_input':
    case 'waiting_approval':
    case 'waiting-approval':
      return 'waiting_approval';
    case 'paused':
      return 'paused';
    case 'done':
    case 'success':
    case 'succeeded':
    case 'completed':
    case 'cached':
      return 'completed';
    case 'error':
    case 'errored':
    case 'failed':
      return 'failed';
    case 'abort':
    case 'aborted':
    case 'cancel':
    case 'cancelled':
    case 'canceled':
      return 'cancelled';
    case 'blocked':
    case 'expired':
    case 'orphaned':
    case 'stalled':
      return 'blocked';
    default:
      return 'queued';
  }
}

export function getLongTaskStatusLabel(status: LongTaskUiStatus): string {
  switch (status) {
    case 'queued':
      return '等待启动';
    case 'running':
      return '执行中';
    case 'waiting_approval':
      return '等待确认';
    case 'paused':
      return '已暂停';
    case 'completed':
      return '已完成';
    case 'failed':
      return '执行失败';
    case 'cancelled':
      return '已取消';
    case 'blocked':
      return '阻塞中';
  }
}

export interface ProductClosureEvidenceRef {
  label: string;
  path?: string;
  url?: string;
  line?: number;
  note?: string;
}

export interface ProductClosureFinding {
  id: string;
  role: ProductClosureAuditRole;
  phase: ProductClosurePhase;
  priority: ProductClosurePriority;
  title: string;
  currentState: string;
  gap: string;
  recommendation: string;
  evidence: ProductClosureEvidenceRef[];
}

export interface ProductClosureAuditReport {
  reportId: string;
  createdAt: number;
  title: string;
  sourceAgents: Array<{
    role: ProductClosureAuditRole;
    agentId: string;
    nickname?: string;
  }>;
  liveContracts: string[];
  legacyOrAdvancedPaths: string[];
  findings: ProductClosureFinding[];
}

export type ArtifactIssueSeverity = 'info' | 'low' | 'medium' | 'high' | 'critical';

export type ArtifactIssueStatus =
  | 'open'
  | 'accepted'
  | 'in_progress'
  | 'fixed'
  | 'resolved'
  | 'dismissed'
  | 'regression_created';

export type ArtifactIssueSource =
  | 'artifact_verifier'
  | 'review_queue'
  | 'eval_replay'
  | 'manual_review'
  | 'user_feedback'
  | 'admin'
  | 'eval_gate'
  | 'sentry';

export type ArtifactEvidenceKind =
  | 'artifact_snapshot'
  | 'browser_probe'
  | 'console_error'
  | 'eval_case'
  | 'feedback'
  | 'manual_note'
  | 'model_call'
  | 'replay_event'
  | 'sentry_issue'
  | 'telemetry_turn'
  | 'tool_call'
  | 'tool_result'
  | 'verifier_check';

export type EvidenceSensitivity = 'public' | 'metadata_only' | 'guarded_content' | 'secret_redacted';

export interface ArtifactAnchor {
  label: string;
  selector?: string;
  path?: string;
  line?: number;
  column?: number;
}

export interface ArtifactEvidenceRef {
  evidenceId: string;
  kind: ArtifactEvidenceKind;
  ref: string;
  summary: string;
  dataSource?: string;
  sensitivity: EvidenceSensitivity;
  createdAt: number;
}

export interface ArtifactIssue {
  issueId: string;
  artifactId: string;
  artifactKind: string;
  traceIdentity: UnifiedTraceIdentity;
  source: ArtifactIssueSource;
  code: string;
  severity: ArtifactIssueSeverity;
  status: ArtifactIssueStatus;
  title: string;
  message: string;
  createdAt: number;
  updatedAt: number;
  runId?: string;
  caseId?: string;
  owner?: string;
  repairInstruction?: string;
  anchors?: ArtifactAnchor[];
  evidenceRefs: ArtifactEvidenceRef[];
  decisionTrace?: DecisionTrace;
  adminReview?: ArtifactIssueAdminReview;
  relatedIssueIds?: string[];
}

export type AdminReviewDecision = 'allow_release' | 'request_changes';

export interface ArtifactIssueAdminReview {
  decision: AdminReviewDecision;
  reviewer: string;
  reviewedAt: number;
  note?: string;
  statusAfter: ArtifactIssueStatus;
}

export type AdminReviewQueueStatus = 'pending' | 'approved' | 'rejected';

export interface AdminReviewQueueItem {
  itemId: string;
  issueId: string;
  traceIdentity: UnifiedTraceIdentity;
  artifactId: string;
  artifactKind: string;
  source: ArtifactIssueSource;
  code: string;
  severity: ArtifactIssueSeverity;
  issueStatus: ArtifactIssueStatus;
  reviewStatus: AdminReviewQueueStatus;
  title: string;
  message: string;
  reason: string;
  evidenceRefs: ArtifactEvidenceRef[];
  decisionTrace?: DecisionTrace;
  adminReview?: ArtifactIssueAdminReview;
  recommendedDecision: AdminReviewDecision;
  updatedAt: number;
}

export interface ApplyArtifactIssueAdminReviewInput {
  decision: AdminReviewDecision;
  reviewer: string;
  note?: string;
  reviewedAt?: number;
  repairInstruction?: string;
}

export type QualityGateStatus = 'passed' | 'failed' | 'degraded' | 'skipped';

export type EvalReplayQualityStatus = 'passed' | 'needs_review' | 'failed' | 'degraded';

export interface EvalReplayQualityGate {
  gateId: string;
  name: string;
  status: QualityGateStatus;
  summary: string;
  failures?: string[];
  telemetryCompleteness?: TelemetryCompleteness;
  evidenceRefs?: ArtifactEvidenceRef[];
}

export interface EvalReplayQualityReport {
  reportId: string;
  traceIdentity: UnifiedTraceIdentity;
  status: EvalReplayQualityStatus;
  gates: EvalReplayQualityGate[];
  createdAt: number;
  updatedAt?: number;
  runId?: string;
  caseId?: string;
  artifactIssues?: ArtifactIssue[];
  decisionTraces?: DecisionTrace[];
}

export interface BuildEvalReplayQualityReportInput {
  reportId?: string;
  traceIdentity: UnifiedTraceIdentity;
  telemetryCompleteness?: TelemetryCompleteness;
  gateFailures?: string[];
  artifactIssues?: ArtifactIssue[];
  decisionTraces?: DecisionTrace[];
  createdAt?: number;
  updatedAt?: number;
  runId?: string;
  caseId?: string;
}

export function normalizeQualityReportStatus(
  gates: EvalReplayQualityGate[],
): EvalReplayQualityStatus {
  if (gates.length === 0) {
    return 'needs_review';
  }
  if (gates.some((gate) => gate.status === 'failed')) {
    return 'failed';
  }
  if (gates.some((gate) => gate.status === 'degraded')) {
    return 'degraded';
  }
  if (gates.some((gate) => gate.status === 'skipped')) {
    return 'needs_review';
  }
  return 'passed';
}

const ACTIVE_ARTIFACT_ISSUE_STATUSES = new Set<ArtifactIssueStatus>([
  'open',
  'accepted',
  'in_progress',
]);

function getAdminReviewQueueStatus(issue: ArtifactIssue): AdminReviewQueueStatus {
  if (issue.adminReview?.decision === 'allow_release') return 'approved';
  if (issue.adminReview?.decision === 'request_changes') return 'rejected';
  return 'pending';
}

function buildAdminReviewReason(issue: ArtifactIssue): string {
  const reasons: string[] = [];
  if (severityRank(issue.severity) >= 4) {
    reasons.push(`${issue.severity} severity issue blocks release`);
  }
  if (issue.decisionTrace) {
    reasons.push(`permission decision trace ended with ${issue.decisionTrace.finalOutcome}`);
  }
  if (issue.source === 'eval_gate' || issue.source === 'review_queue' || issue.source === 'admin') {
    reasons.push(`${issue.source} source requires admin disposition`);
  }
  return reasons.length > 0
    ? reasons.join('; ')
    : 'active artifact issue needs admin disposition';
}

export function artifactIssueNeedsAdminReview(issue: ArtifactIssue): boolean {
  if (!ACTIVE_ARTIFACT_ISSUE_STATUSES.has(issue.status)) return false;
  return (
    severityRank(issue.severity) >= 4
    || Boolean(issue.decisionTrace)
    || issue.source === 'eval_gate'
    || issue.source === 'review_queue'
    || issue.source === 'admin'
  );
}

export function buildAdminReviewQueueItem(issue: ArtifactIssue): AdminReviewQueueItem | null {
  if (!artifactIssueNeedsAdminReview(issue) && !issue.adminReview) return null;

  const reviewStatus = getAdminReviewQueueStatus(issue);
  return {
    itemId: `artifact_issue:${issue.issueId}`,
    issueId: issue.issueId,
    traceIdentity: issue.traceIdentity,
    artifactId: issue.artifactId,
    artifactKind: issue.artifactKind,
    source: issue.source,
    code: issue.code,
    severity: issue.severity,
    issueStatus: issue.status,
    reviewStatus,
    title: issue.title,
    message: issue.message,
    reason: buildAdminReviewReason(issue),
    evidenceRefs: issue.evidenceRefs,
    decisionTrace: issue.decisionTrace,
    adminReview: issue.adminReview,
    recommendedDecision: severityRank(issue.severity) >= 4 ? 'request_changes' : 'allow_release',
    updatedAt: issue.updatedAt,
  };
}

export function listAdminReviewQueueItems(
  issues: ArtifactIssue[],
  options: { includeReviewed?: boolean } = {},
): AdminReviewQueueItem[] {
  return issues
    .map((issue) => buildAdminReviewQueueItem(issue))
    .filter((item): item is AdminReviewQueueItem => Boolean(item))
    .filter((item) => options.includeReviewed || item.reviewStatus === 'pending')
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function applyArtifactIssueAdminReview(
  issue: ArtifactIssue,
  input: ApplyArtifactIssueAdminReviewInput,
): ArtifactIssue {
  const reviewedAt = input.reviewedAt ?? Date.now();
  const statusAfter: ArtifactIssueStatus = input.decision === 'allow_release'
    ? 'dismissed'
    : 'in_progress';

  return {
    ...issue,
    status: statusAfter,
    updatedAt: reviewedAt,
    repairInstruction: input.repairInstruction ?? issue.repairInstruction,
    adminReview: {
      decision: input.decision,
      reviewer: input.reviewer,
      reviewedAt,
      note: input.note,
      statusAfter,
    },
  };
}

function severityRank(severity: ArtifactIssueSeverity): number {
  switch (severity) {
    case 'critical':
      return 5;
    case 'high':
      return 4;
    case 'medium':
      return 3;
    case 'low':
      return 2;
    default:
      return 1;
  }
}

function buildTelemetryGate(input: BuildEvalReplayQualityReportInput): EvalReplayQualityGate {
  const completeness = input.telemetryCompleteness;
  const failures = new Set<string>(input.gateFailures || []);
  if (!completeness) {
    failures.add('missing_telemetry_completeness');
    failures.add('missing_replay_key');
  } else {
    for (const reason of completeness.incompleteReasons || getReplayCompletenessReasons({
      sessionId: completeness.sessionId ?? input.traceIdentity.sessionId,
      replayKey: completeness.replayKey ?? input.traceIdentity.replayKey,
      dataSource: completeness.dataSource,
      turnCount: completeness.turnCount,
      modelCallCount: completeness.modelCallCount,
      toolCallCount: completeness.toolCallCount,
      eventCount: completeness.eventCount,
      hasModelDecisions: completeness.hasModelDecisions,
      hasToolSchemas: completeness.hasToolSchemas,
    })) {
      failures.add(reason);
    }
    if (completeness.hasRealAgentTrace === false) {
      failures.add('missing_real_agent_trace');
    }
  }

  const failureList = Array.from(failures);
  return {
    gateId: 'telemetry_replay',
    name: 'Telemetry replay completeness',
    status: failureList.length > 0 ? 'failed' : 'passed',
    summary: failureList.length > 0
      ? `Replay evidence is incomplete: ${failureList.join(', ')}`
      : 'Replay evidence is complete enough for product review.',
    failures: failureList.length > 0 ? failureList : undefined,
    telemetryCompleteness: completeness,
  };
}

function buildArtifactIssueGate(issues: ArtifactIssue[]): EvalReplayQualityGate | null {
  const activeIssues = issues.filter((issue) => ACTIVE_ARTIFACT_ISSUE_STATUSES.has(issue.status));
  if (activeIssues.length === 0) return null;

  const blockingIssues = activeIssues.filter((issue) => severityRank(issue.severity) >= 4);
  return {
    gateId: 'artifact_issues',
    name: 'Artifact issue review',
    status: blockingIssues.length > 0 ? 'failed' : 'degraded',
    summary: blockingIssues.length > 0
      ? `${blockingIssues.length} active high-severity artifact issue(s) need review.`
      : `${activeIssues.length} active artifact issue(s) are tracked for follow-up.`,
    failures: blockingIssues.length > 0
      ? blockingIssues.map((issue) => `${issue.code}:${issue.issueId}`)
      : undefined,
    evidenceRefs: activeIssues.flatMap((issue) => issue.evidenceRefs),
  };
}

export function buildEvalReplayQualityReport(
  input: BuildEvalReplayQualityReportInput,
): EvalReplayQualityReport {
  const createdAt = input.createdAt ?? Date.now();
  const artifactIssues = input.artifactIssues || [];
  const gates = [
    buildTelemetryGate(input),
    buildArtifactIssueGate(artifactIssues),
  ].filter((gate): gate is EvalReplayQualityGate => Boolean(gate));

  return {
    reportId: input.reportId ?? `quality:${input.traceIdentity.traceId}:${input.caseId ?? input.runId ?? createdAt}`,
    traceIdentity: input.traceIdentity,
    status: normalizeQualityReportStatus(gates),
    gates,
    createdAt,
    updatedAt: input.updatedAt,
    runId: input.runId,
    caseId: input.caseId,
    artifactIssues: artifactIssues.length > 0 ? artifactIssues : undefined,
    decisionTraces: input.decisionTraces && input.decisionTraces.length > 0 ? input.decisionTraces : undefined,
  };
}
