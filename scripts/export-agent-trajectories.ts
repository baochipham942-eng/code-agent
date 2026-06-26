#!/usr/bin/env npx tsx

import { copyFile, mkdir, mkdtemp, rm, stat } from 'fs/promises';
import { homedir, tmpdir } from 'os';
import path from 'path';
import process from 'process';
import { pathToFileURL } from 'url';

import type {
  AgentTrajectoryCollectionSource,
  AgentTrajectoryQualityTier,
} from '../src/shared/contract/agentTrajectory';
import type { EvidenceControlSummaryProjection } from '../src/shared/contract/evaluation';

interface CliOptions {
  dataDir: string;
  liveDataDir: boolean;
  keepTmp: boolean;
  backupLiveDb: boolean;
  liveDbBackupDir?: string;
  out?: string;
  reviewManifestOut?: string;
  reviewPacketOut?: string;
  reportOut?: string;
  sessionIds: string[];
  limit: number;
  since?: number;
  until?: number;
  minTier: AgentTrajectoryQualityTier;
  includeRejected: boolean;
  datasetVersion: string;
  persistCollectionMetadata: boolean;
  exportCollectionSource?: AgentTrajectoryCollectionSource;
  minSessions?: number;
  minAgentCandidates?: number;
  minExported?: number;
  minManualReviewed?: number;
  minManualReviewedAgentCandidates?: number;
  maxPendingReview?: number;
  minG2Rate?: number;
  maxTopFailureRate?: number;
  maxDiagnosticRate?: number;
  maxExcludedRate?: number;
  allowGateFailure: boolean;
  json: boolean;
}

interface LiveDbBackup {
  dir: string;
  files: string[];
  createdAt: number;
}

function defaultDataDir(): string {
  if (process.env.CODE_AGENT_DATA_DIR?.trim()) {
    return process.env.CODE_AGENT_DATA_DIR.trim();
  }
  if (process.platform === 'darwin') {
    return path.join(homedir(), 'Library', 'Application Support', 'code-agent');
  }
  return path.join(homedir(), '.code-agent');
}

function readFlagValue(args: string[], name: string): string | undefined {
  const prefix = `${name}=`;
  for (let index = args.length - 1; index >= 0; index--) {
    const arg = args[index];
    if (arg.startsWith(prefix)) return arg.slice(prefix.length);
    if (arg === name && args[index + 1]) return args[index + 1];
  }
  return undefined;
}

function readRepeatedFlag(args: string[], name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index++) {
    if (args[index] === name && args[index + 1]) {
      values.push(args[index + 1]);
      index++;
    } else if (args[index].startsWith(`${name}=`)) {
      values.push(args[index].slice(name.length + 1));
    }
  }
  return values;
}

function parseTier(value: string | undefined): AgentTrajectoryQualityTier {
  if (value === 'G0' || value === 'G1' || value === 'G2') return value;
  return 'G2';
}

function parseCollectionSource(value: string | undefined): AgentTrajectoryCollectionSource | undefined {
  if (
    value === 'quality_gate' ||
    value === 'manual_review' ||
    value === 'audit_backfill' ||
    value === 'session_metadata'
  ) {
    return value;
  }
  return undefined;
}

function parseOptionalNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function parseTimestampFlag(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const numeric = Number(trimmed);
  if (Number.isFinite(numeric)) {
    return numeric < 10_000_000_000 ? Math.floor(numeric * 1000) : Math.floor(numeric);
  }
  const parsed = Date.parse(trimmed);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid timestamp: ${value}`);
  }
  return parsed;
}

function parseOptions(): CliOptions {
  const args = process.argv.slice(2);
  return {
    dataDir: readFlagValue(args, '--data-dir') || defaultDataDir(),
    liveDataDir: args.includes('--live-data-dir'),
    keepTmp: args.includes('--keep-tmp'),
    backupLiveDb: args.includes('--backup-live-db'),
    liveDbBackupDir: readFlagValue(args, '--live-db-backup-dir'),
    out: readFlagValue(args, '--out'),
    reviewManifestOut: readFlagValue(args, '--review-manifest-out'),
    reviewPacketOut: readFlagValue(args, '--review-packet-out'),
    reportOut: readFlagValue(args, '--report-out'),
    sessionIds: readRepeatedFlag(args, '--session-id'),
    limit: Number(readFlagValue(args, '--limit') || 200),
    since: parseTimestampFlag(readFlagValue(args, '--since')),
    until: parseTimestampFlag(readFlagValue(args, '--until')),
    minTier: parseTier(readFlagValue(args, '--min-tier')),
    includeRejected: args.includes('--include-rejected'),
    datasetVersion: readFlagValue(args, '--dataset-version') || 'agent-trajectory-v1',
    persistCollectionMetadata: args.includes('--persist-collection-metadata'),
    exportCollectionSource: parseCollectionSource(readFlagValue(args, '--export-collection-source')),
    minSessions: parseOptionalNumber(readFlagValue(args, '--min-sessions')),
    minAgentCandidates: parseOptionalNumber(readFlagValue(args, '--min-agent-candidates')),
    minExported: parseOptionalNumber(readFlagValue(args, '--min-exported')),
    minManualReviewed: parseOptionalNumber(readFlagValue(args, '--min-manual-reviewed')),
    minManualReviewedAgentCandidates: parseOptionalNumber(
      readFlagValue(args, '--min-manual-reviewed-agent-candidates'),
    ),
    maxPendingReview: parseOptionalNumber(readFlagValue(args, '--max-pending-review')),
    minG2Rate: parseOptionalNumber(readFlagValue(args, '--min-g2-rate')),
    maxTopFailureRate: parseOptionalNumber(readFlagValue(args, '--max-top-failure-rate')),
    maxDiagnosticRate: parseOptionalNumber(readFlagValue(args, '--max-diagnostic-rate')),
    maxExcludedRate: parseOptionalNumber(readFlagValue(args, '--max-excluded-rate')),
    allowGateFailure: args.includes('--allow-gate-failure'),
    json: args.includes('--json'),
  };
}

async function copyIfExists(source: string, target: string): Promise<void> {
  try {
    await stat(source);
  } catch {
    return;
  }
  await copyFile(source, target);
}

async function prepareRuntimeDataDir(sourceDataDir: string, liveDataDir: boolean): Promise<string> {
  if (liveDataDir) return sourceDataDir;

  const runtimeDataDir = await mkdtemp(path.join(tmpdir(), 'agent-trajectory-audit-'));
  const sourceDb = path.join(sourceDataDir, 'code-agent.db');
  const targetDb = path.join(runtimeDataDir, 'code-agent.db');
  await copyIfExists(sourceDb, targetDb);
  await copyIfExists(`${sourceDb}-wal`, `${targetDb}-wal`);
  await copyIfExists(`${sourceDb}-shm`, `${targetDb}-shm`);
  return runtimeDataDir;
}

async function backupLiveDatabaseIfNeeded(
  sourceDataDir: string,
  enabled: boolean,
  backupDir?: string,
): Promise<LiveDbBackup | undefined> {
  if (!enabled) return undefined;

  const sourceDb = path.join(sourceDataDir, 'code-agent.db');
  await stat(sourceDb);

  const createdAt = Date.now();
  const stamp = new Date(createdAt).toISOString().replace(/[:.]/g, '-');
  const targetDir =
    backupDir || path.join(sourceDataDir, 'backups', 'agent-trajectory-live-seed', stamp);
  await mkdir(targetDir, { recursive: true });

  const files: string[] = [];
  for (const suffix of ['', '-wal', '-shm']) {
    const source = `${sourceDb}${suffix}`;
    try {
      await stat(source);
    } catch {
      continue;
    }
    const target = path.join(targetDir, `code-agent.db${suffix}`);
    await copyFile(source, target);
    files.push(target);
  }

  return { dir: targetDir, files, createdAt };
}

async function writeJsonFile(outPath: string, value: unknown): Promise<void> {
  const { mkdir, writeFile } = await import('fs/promises');
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function writeTextFile(outPath: string, value: string): Promise<void> {
  const { mkdir, writeFile } = await import('fs/promises');
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, value.endsWith('\n') ? value : `${value}\n`, 'utf8');
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

function markdownCell(value: unknown): string {
  return String(value ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, '<br>');
}

function buildReviewAction(item: {
  datasetRole: string;
  tier: string;
  failures: string[];
}): 'verify_core_eval' | 'review_diagnostic' | 'confirm_excluded' {
  if (item.datasetRole === 'core_eval' && item.tier === 'G2' && item.failures.length === 0) {
    return 'verify_core_eval';
  }
  if (item.datasetRole === 'excluded') {
    return 'confirm_excluded';
  }
  return 'review_diagnostic';
}

function buildReviewPriority(item: {
  datasetRole: string;
  tier: string;
  failures: string[];
}): 'high' | 'medium' | 'low' {
  if (item.datasetRole === 'diagnostic' && item.tier === 'G1') return 'high';
  if (item.datasetRole === 'core_eval') return 'medium';
  if (item.failures.includes('ordinary_chat_no_tool')) return 'low';
  return 'medium';
}

type ReviewScope = 'agent_candidate' | 'excluded_control';

function buildReviewScope(item: { datasetRole: string }): ReviewScope {
  return item.datasetRole === 'excluded' ? 'excluded_control' : 'agent_candidate';
}

function buildEmptyReviewDecision(item: {
  datasetRole: string;
  taskKind: string;
  collectionSource: string;
}): {
  datasetRole: null;
  taskKind: null;
  reviewedBy: null;
  notes: null;
  instruction: string;
} {
  const action =
    item.collectionSource === 'manual_review'
      ? 'Already reviewed. Leave this object unchanged unless re-review is needed.'
      : `Fill datasetRole after Replay review. Gate suggestion: ${item.datasetRole}. Allowed: core_eval, diagnostic, excluded.`;
  return {
    datasetRole: null,
    taskKind: null,
    reviewedBy: null,
    notes: null,
    instruction: `${action} Fill taskKind only when overriding ${item.taskKind}.`,
  };
}

export type GateThresholdCalibrationStatus =
  | 'strict_gate_ready'
  | 'collect_more_sessions'
  | 'manual_review_required'
  | 'collection_quality_required'
  | 'threshold_review_required';

export interface GateThresholdCalibration {
  status: GateThresholdCalibrationStatus;
  recommendation: string;
  observed: {
    totalSessions: number;
    agentCandidateSessions: number;
    exported: number;
    manualReviewed: number;
    manualReviewedAgentCandidates: number;
    pendingReview: number;
    pendingAgentCandidateReview: number;
    g2Rate: number;
    topFailureRate: number;
    diagnosticRate: number;
    excludedRate: number;
  };
  thresholds: {
    minSessions?: number;
    minAgentCandidates?: number;
    minExported?: number;
    minManualReviewed?: number;
    minManualReviewedAgentCandidates?: number;
    maxPendingReview?: number;
    minG2Rate?: number;
    maxTopFailureRate?: number;
    maxDiagnosticRate?: number;
    maxExcludedRate?: number;
  };
  notes: string[];
}

export type P3RequirementAuditStatus = 'passed' | 'failed' | 'manual_review_required' | 'partial';

export interface P3RequirementAuditItem {
  requirement: string;
  status: P3RequirementAuditStatus;
  evidence: string;
  nextAction: string;
}

export type P3ActionPlanStatus = 'ready' | 'action_required';

export interface P3ActionPlanItem {
  priority: number;
  action: string;
  status: 'pending' | 'done';
  current: string;
  target: string;
  remaining: string;
  detail: string;
}

export interface P3ActionPlan {
  status: P3ActionPlanStatus;
  nextAction: string;
  items: P3ActionPlanItem[];
}

type ReviewPacketItem = {
  sessionId: string;
  reviewScope: ReviewScope;
  currentDatasetRole: string;
  suggestedAction: string;
  priority: string;
  tier: string;
  taskKind: string;
  collectionSource: string;
  failures: string[];
  evidenceControl?: EvidenceControlSummaryProjection;
};

export interface P3ReviewWorklistItem {
  sessionId: string;
  reviewScope: ReviewScope;
  suggestedAction: string;
  currentDatasetRole: string;
  priority: string;
  tier: string;
  taskKind: string;
  failures: string[];
}

export interface P3ReviewWorklist {
  status: 'ready' | 'review_required';
  nextReviewSessionId?: string;
  agentCandidateReviewCount: number;
  excludedControlReviewCount: number;
  agentCandidateReviewSessionIds: string[];
  excludedControlSessionIds: string[];
  verifyCoreEvalSessionIds: string[];
  reviewDiagnosticSessionIds: string[];
  confirmExcludedSessionIds: string[];
  topPendingFailure?: {
    failure: string;
    count: number;
    agentCandidateSessionIds: string[];
    excludedControlSessionIds: string[];
  };
  reviewOrder: P3ReviewWorklistItem[];
}

export interface P3CollectionBlocker {
  failure: string;
  count: number;
  agentCandidateCount: number;
  excludedControlCount: number;
  agentCandidateSessionIds: string[];
  excludedControlSessionIds: string[];
}

function countRemaining(current: number, target: number | undefined): number {
  return target === undefined ? 0 : Math.max(0, target - current);
}

function reviewPriorityRank(item: ReviewPacketItem): number {
  if (item.reviewScope === 'agent_candidate') {
    if (item.priority === 'high') return 0;
    if (item.priority === 'medium') return 1;
    return 2;
  }
  if (item.priority === 'high') return 3;
  if (item.priority === 'medium') return 4;
  return 5;
}

function sanitizeEvidenceControlText(value: string): string {
  return value
    .replace(/^data:[^\s]+/gi, '[redacted]')
    .replace(/base64[,=][^\s]+/gi, 'base64,[redacted]')
    .replace(
      /(?:\/Users\/[^\s"'`]+|\/private\/tmp\/[^\s"'`]+|\/tmp\/[^\s"'`]+|\/var\/folders\/[^\s"'`]+|\/Volumes\/[^\s"'`]+)(?:\/[^\s"'`]*)*/g,
      (match) => `.../${match.split('/').filter(Boolean).at(-1) || 'path'}`,
    )
    .replace(/\b(cookie|cookies|localStorage|sessionStorage|storageState)(\s*[:=]\s*)[^\s,;]+/gi, '$1$2[redacted]')
    .replace(/([?&](?:token|password|secret|credential)=)[^&\s]+/gi, '$1[redacted]');
}

function formatEvidenceControlForReviewPacket(
  evidenceControl: EvidenceControlSummaryProjection | undefined,
): string {
  if (!evidenceControl) return 'none';
  const gaps = evidenceControl.gaps.length > 0
    ? ` · gaps ${evidenceControl.gaps.slice(0, 3).map(sanitizeEvidenceControlText).join('<br>')}`
    : '';
  const conflicts = evidenceControl.conflicts.length > 0
    ? ` · conflicts ${evidenceControl.conflicts.slice(0, 3).map(sanitizeEvidenceControlText).join('<br>')}`
    : '';
  return [
    evidenceControl.trustLevel,
    `${evidenceControl.totalItems} items/${evidenceControl.totalEvidenceRefs} refs`,
    `blocked ${evidenceControl.blockedItems}`,
    `stale ${evidenceControl.staleItems}`,
    `conflicts ${evidenceControl.conflictItems}`,
  ].join(' · ') + gaps + conflicts;
}

function toWorklistItem(item: ReviewPacketItem): P3ReviewWorklistItem {
  return {
    sessionId: item.sessionId,
    reviewScope: item.reviewScope,
    suggestedAction: item.suggestedAction,
    currentDatasetRole: item.currentDatasetRole,
    priority: item.priority,
    tier: item.tier,
    taskKind: item.taskKind,
    failures: item.failures,
  };
}

export function buildP3ReviewWorklist(input: { reviewItems: ReviewPacketItem[] }): P3ReviewWorklist {
  const pendingItems = input.reviewItems
    .filter((item) => item.collectionSource !== 'manual_review')
    .slice()
    .sort((left, right) => reviewPriorityRank(left) - reviewPriorityRank(right));
  const reviewOrder = pendingItems.map(toWorklistItem);
  const agentCandidateItems = reviewOrder.filter((item) => item.reviewScope === 'agent_candidate');
  const excludedControlItems = reviewOrder.filter((item) => item.reviewScope === 'excluded_control');
  const topFailureCounts = new Map<
    string,
    { count: number; agentCandidateSessionIds: string[]; excludedControlSessionIds: string[] }
  >();

  for (const item of reviewOrder) {
    for (const failure of item.failures) {
      const normalized = failure.trim();
      if (!normalized || normalized === 'none') continue;
      const current =
        topFailureCounts.get(normalized) ?? {
          count: 0,
          agentCandidateSessionIds: [],
          excludedControlSessionIds: [],
        };
      current.count++;
      if (item.reviewScope === 'agent_candidate') {
        current.agentCandidateSessionIds.push(item.sessionId);
      } else {
        current.excludedControlSessionIds.push(item.sessionId);
      }
      topFailureCounts.set(normalized, current);
    }
  }

  const topPendingFailure = [...topFailureCounts.entries()]
    .sort((left, right) => right[1].count - left[1].count || left[0].localeCompare(right[0]))
    .map(([failure, value]) => ({ failure, ...value }))[0];

  return {
    status: reviewOrder.length > 0 ? 'review_required' : 'ready',
    nextReviewSessionId: reviewOrder[0]?.sessionId,
    agentCandidateReviewCount: agentCandidateItems.length,
    excludedControlReviewCount: excludedControlItems.length,
    agentCandidateReviewSessionIds: agentCandidateItems.map((item) => item.sessionId),
    excludedControlSessionIds: excludedControlItems.map((item) => item.sessionId),
    verifyCoreEvalSessionIds: reviewOrder
      .filter((item) => item.suggestedAction === 'verify_core_eval')
      .map((item) => item.sessionId),
    reviewDiagnosticSessionIds: reviewOrder
      .filter((item) => item.suggestedAction === 'review_diagnostic')
      .map((item) => item.sessionId),
    confirmExcludedSessionIds: reviewOrder
      .filter((item) => item.suggestedAction === 'confirm_excluded')
      .map((item) => item.sessionId),
    topPendingFailure,
    reviewOrder,
  };
}

export function buildP3CollectionBlockers(input: {
  reviewItems: Array<{ sessionId: string; reviewScope: ReviewScope; failures: string[] }>;
  failureOrder?: string[];
  limit?: number;
}): P3CollectionBlocker[] {
  const failureRank = new Map((input.failureOrder ?? []).map((failure, index) => [failure, index]));
  const blockerCounts = new Map<
    string,
    { count: number; agentCandidateSessionIds: string[]; excludedControlSessionIds: string[] }
  >();

  for (const item of input.reviewItems) {
    for (const failure of item.failures) {
      const normalized = failure.trim();
      if (!normalized || normalized === 'none') continue;
      const current =
        blockerCounts.get(normalized) ?? {
          count: 0,
          agentCandidateSessionIds: [],
          excludedControlSessionIds: [],
        };
      current.count++;
      if (item.reviewScope === 'agent_candidate') {
        current.agentCandidateSessionIds.push(item.sessionId);
      } else {
        current.excludedControlSessionIds.push(item.sessionId);
      }
      blockerCounts.set(normalized, current);
    }
  }

  return [...blockerCounts.entries()]
    .sort(
      (left, right) =>
        right[1].count - left[1].count ||
        (failureRank.get(left[0]) ?? Number.MAX_SAFE_INTEGER) -
          (failureRank.get(right[0]) ?? Number.MAX_SAFE_INTEGER) ||
        left[0].localeCompare(right[0]),
    )
    .slice(0, input.limit ?? 10)
    .map(([failure, value]) => ({
      failure,
      count: value.count,
      agentCandidateCount: value.agentCandidateSessionIds.length,
      excludedControlCount: value.excludedControlSessionIds.length,
      agentCandidateSessionIds: value.agentCandidateSessionIds,
      excludedControlSessionIds: value.excludedControlSessionIds,
    }));
}

export function buildP3ActionPlan(input: {
  exported: number;
  byDatasetRole: Record<string, number>;
  reviewProgress: {
    manualReviewed: number;
    manualReviewedAgentCandidates?: number;
  };
  qualityGate: {
    passed: boolean;
    minSessions?: number;
    minAgentCandidates?: number;
    minExported?: number;
    minManualReviewed?: number;
    minManualReviewedAgentCandidates?: number;
    maxTopFailureRate?: number;
    maxDiagnosticRate?: number;
    maxExcludedRate?: number;
    topFailure?: { failure: string; count: number };
    topFailureRate: number;
  };
  thresholdCalibration: GateThresholdCalibration;
}): P3ActionPlan {
  const agentCandidateSessions = (input.byDatasetRole.core_eval ?? 0) + (input.byDatasetRole.diagnostic ?? 0);
  const targetAgentCandidates = input.qualityGate.minAgentCandidates ?? input.qualityGate.minSessions ?? 20;
  const targetExported = input.qualityGate.minExported ?? 20;
  const targetManualReviewedAgentCandidates =
    input.qualityGate.minManualReviewedAgentCandidates ?? targetAgentCandidates;
  const targetManualReviewed = input.qualityGate.minManualReviewed ?? targetAgentCandidates;
  const manualReviewedAgentCandidates =
    input.reviewProgress.manualReviewedAgentCandidates ?? input.reviewProgress.manualReviewed;
  const pendingItems: P3ActionPlanItem[] = [];

  const collectRemaining = countRemaining(agentCandidateSessions, targetAgentCandidates);
  if (collectRemaining > 0) {
    pendingItems.push({
      priority: 1,
      action: 'collect_agent_candidates',
      status: 'pending',
      current: `${agentCandidateSessions}`,
      target: `${targetAgentCandidates}`,
      remaining: `${collectRemaining}`,
      detail: 'Collect real Coding, Search, Data Analysis, or agent-task sessions; excluded rows do not count.',
    });
  }

  const manualReviewedAgentRemaining = countRemaining(
    manualReviewedAgentCandidates,
    targetManualReviewedAgentCandidates,
  );
  if (manualReviewedAgentRemaining > 0) {
    pendingItems.push({
      priority: 2,
      action: 'review_agent_candidates',
      status: 'pending',
      current: `${manualReviewedAgentCandidates}`,
      target: `${targetManualReviewedAgentCandidates}`,
      remaining: `${manualReviewedAgentRemaining}`,
      detail: 'Review agent_candidate rows first and persist collection.source = manual_review.',
    });
  }

  const manualReviewedRemaining = countRemaining(input.reviewProgress.manualReviewed, targetManualReviewed);
  if (manualReviewedRemaining > 0 && manualReviewedRemaining !== manualReviewedAgentRemaining) {
    pendingItems.push({
      priority: 3,
      action: 'review_all_sample_rows',
      status: 'pending',
      current: `${input.reviewProgress.manualReviewed}`,
      target: `${targetManualReviewed}`,
      remaining: `${manualReviewedRemaining}`,
      detail: 'Confirm any remaining sampled rows after agent_candidate review is complete.',
    });
  }

  const exportedRemaining = countRemaining(input.exported, targetExported);
  if (exportedRemaining > 0) {
    pendingItems.push({
      priority: 4,
      action: 'promote_core_eval_rows',
      status: 'pending',
      current: `${input.exported}`,
      target: `${targetExported}`,
      remaining: `${exportedRemaining}`,
      detail: 'Only reviewed G2 rows should become stable core_eval JSONL rows.',
    });
  }

  if (
    input.qualityGate.maxTopFailureRate !== undefined &&
    input.thresholdCalibration.observed.topFailureRate > input.qualityGate.maxTopFailureRate
  ) {
    const blocker = input.qualityGate.topFailure?.failure ?? 'top_failure';
    pendingItems.push({
      priority: 5,
      action: 'fix_top_collection_blocker',
      status: 'pending',
      current: formatPercent(input.thresholdCalibration.observed.topFailureRate),
      target: `<= ${formatPercent(input.qualityGate.maxTopFailureRate)}`,
      remaining: 'improve',
      detail: `Fix or explain ${blocker} before lowering thresholds.`,
    });
  }

  if (
    input.qualityGate.maxDiagnosticRate !== undefined &&
    input.thresholdCalibration.observed.diagnosticRate > input.qualityGate.maxDiagnosticRate
  ) {
    pendingItems.push({
      priority: 6,
      action: 'reduce_diagnostic_rate',
      status: 'pending',
      current: formatPercent(input.thresholdCalibration.observed.diagnosticRate),
      target: `<= ${formatPercent(input.qualityGate.maxDiagnosticRate)}`,
      remaining: 'improve',
      detail: 'Improve capture completeness so fewer agent candidates stay diagnostic.',
    });
  }

  if (
    input.qualityGate.maxExcludedRate !== undefined &&
    input.thresholdCalibration.observed.excludedRate > input.qualityGate.maxExcludedRate
  ) {
    pendingItems.push({
      priority: 7,
      action: 'reduce_excluded_rate',
      status: 'pending',
      current: formatPercent(input.thresholdCalibration.observed.excludedRate),
      target: `<= ${formatPercent(input.qualityGate.maxExcludedRate)}`,
      remaining: 'improve',
      detail: 'Keep ordinary chat out of the P3 collection window.',
    });
  }

  if (pendingItems.length === 0 && input.qualityGate.passed) {
    return {
      status: 'ready',
      nextAction: 'P3 closeout can be accepted after confirming this is fresh post-P2 live data.',
      items: [],
    };
  }

  return {
    status: 'action_required',
    nextAction: pendingItems[0]?.detail ?? 'Review the failed closeout gates before accepting P3.',
    items: pendingItems,
  };
}

export function buildP3RequirementAudit(input: {
  totalSessions: number;
  exported: number;
  sampleWindow?: unknown;
  byDatasetRole: Record<string, number>;
  reviewProgress: {
    manualReviewed: number;
    pendingReview: number;
    manualReviewedAgentCandidates?: number;
    pendingAgentCandidateReview?: number;
  };
  qualityGate: {
    passed: boolean;
    minSessions?: number;
    minAgentCandidates?: number;
    minExported?: number;
    minManualReviewed?: number;
    minManualReviewedAgentCandidates?: number;
    maxPendingReview?: number;
  };
  thresholdCalibration: GateThresholdCalibration;
}): P3RequirementAuditItem[] {
  const targetMinSessions = input.qualityGate.minAgentCandidates ?? input.qualityGate.minSessions ?? 20;
  const agentCandidateSessions = (input.byDatasetRole.core_eval ?? 0) + (input.byDatasetRole.diagnostic ?? 0);
  const sampledWindowSizeOk = input.totalSessions >= targetMinSessions && input.totalSessions <= 50;
  const agentSampleSizeOk = agentCandidateSessions >= targetMinSessions && input.totalSessions <= 50;
  const exportedOk =
    input.qualityGate.minExported === undefined || input.exported >= input.qualityGate.minExported;
  const manualReviewOk =
    (input.qualityGate.minManualReviewed === undefined ||
      input.reviewProgress.manualReviewed >= input.qualityGate.minManualReviewed) &&
    (input.qualityGate.minManualReviewedAgentCandidates === undefined ||
      (input.reviewProgress.manualReviewedAgentCandidates ?? input.reviewProgress.manualReviewed) >=
        input.qualityGate.minManualReviewedAgentCandidates) &&
    (input.qualityGate.maxPendingReview === undefined ||
      input.reviewProgress.pendingReview <= input.qualityGate.maxPendingReview);
  const hasSegmentation =
    input.totalSessions > 0 &&
    Number.isFinite(input.byDatasetRole.core_eval ?? 0) &&
    Number.isFinite(input.byDatasetRole.diagnostic ?? 0) &&
    Number.isFinite(input.byDatasetRole.excluded ?? 0);
  const sampleWindow = input.sampleWindow ? JSON.stringify(input.sampleWindow) : 'latest sessions';

  return [
    {
      requirement: '20-50 live agent sessions sampled',
      status: agentSampleSizeOk ? 'passed' : sampledWindowSizeOk ? 'partial' : 'failed',
      evidence: `${input.totalSessions} sessions audited from ${sampleWindow}; ${agentCandidateSessions} are non-excluded agent candidates.`,
      nextAction: agentSampleSizeOk
        ? 'Keep using the same --since window for this P3 closeout sample.'
        : `Collect at least ${targetMinSessions} post-P2 agent-task sessions; excluded ordinary chat rows do not count toward P3.`,
    },
    {
      requirement: 'Review Queue manual review complete',
      status: manualReviewOk ? 'passed' : 'manual_review_required',
      evidence: `${input.reviewProgress.manualReviewedAgentCandidates ?? input.reviewProgress.manualReviewed} manually reviewed agent candidates; ${
        input.reviewProgress.pendingAgentCandidateReview ?? input.reviewProgress.pendingReview
      } agent candidates pending. Total pending rows: ${input.reviewProgress.pendingReview}.`,
      nextAction: manualReviewOk
        ? 'No manual review gap remains for this sample.'
        : 'Open each sampled session in Replay review and persist an explicit dataset role decision.',
    },
    {
      requirement: 'core_eval JSONL export ready',
      status: exportedOk ? 'passed' : 'failed',
      evidence: `${input.exported} core_eval rows exported; target is ${input.qualityGate.minExported ?? 20}.`,
      nextAction: exportedOk
        ? 'Use the exported JSONL as the first stable core_eval slice.'
        : 'Do not publish core_eval yet; promote only reviewed G2 rows after quality gaps are resolved.',
    },
    {
      requirement: 'diagnostic/excluded segmentation available',
      status: hasSegmentation ? 'passed' : 'failed',
      evidence: `core_eval=${input.byDatasetRole.core_eval ?? 0}, diagnostic=${
        input.byDatasetRole.diagnostic ?? 0
      }, excluded=${input.byDatasetRole.excluded ?? 0}.`,
      nextAction: hasSegmentation
        ? 'Use diagnostic/excluded rates to decide whether collection quality is improving.'
        : 'Regenerate the audit after collection metadata can be resolved for every sampled session.',
    },
    {
      requirement: 'fresh-sample gate threshold calibration',
      status: input.thresholdCalibration.status === 'strict_gate_ready' ? 'passed' : 'partial',
      evidence: `${input.thresholdCalibration.status}: ${input.thresholdCalibration.recommendation}`,
      nextAction:
        input.thresholdCalibration.status === 'strict_gate_ready'
          ? 'Keep the strict P3 gate for this sample.'
          : input.thresholdCalibration.recommendation,
    },
    {
      requirement: 'P3 closeout decision',
      status: input.qualityGate.passed ? 'passed' : 'failed',
      evidence: input.qualityGate.passed ? 'All configured closeout gates passed.' : 'One or more closeout gates failed.',
      nextAction: input.qualityGate.passed
        ? 'P3 can close after confirming the sample is fresh post-P2 live data.'
        : 'Keep the P3 goal active until live closeout passes on reviewed fresh data.',
    },
  ];
}

export function buildGateThresholdCalibration(input: {
  totalSessions: number;
  exported: number;
  manualReviewed: number;
  manualReviewedAgentCandidates?: number;
  pendingReview: number;
  pendingAgentCandidateReview?: number;
  g2Rate: number;
  topFailureRate: number;
  diagnosticRate: number;
  excludedRate: number;
  agentCandidateSessions?: number;
  topFailure?: { failure: string; count: number };
  qualityGatePassed: boolean;
  thresholds: GateThresholdCalibration['thresholds'];
}): GateThresholdCalibration {
  const notes: string[] = [];
  const {
    totalSessions,
    exported,
    manualReviewed,
    pendingReview,
    g2Rate,
    topFailureRate,
    diagnosticRate,
    excludedRate,
    topFailure,
    thresholds,
  } = input;
  const agentCandidateSessions = input.agentCandidateSessions ?? totalSessions;
  const manualReviewedAgentCandidates = input.manualReviewedAgentCandidates ?? manualReviewed;
  const pendingAgentCandidateReview =
    input.pendingAgentCandidateReview ?? Math.max(0, agentCandidateSessions - manualReviewedAgentCandidates);
  const observed = {
    totalSessions,
    agentCandidateSessions,
    exported,
    manualReviewed,
    manualReviewedAgentCandidates,
    pendingReview,
    pendingAgentCandidateReview,
    g2Rate,
    topFailureRate,
    diagnosticRate,
    excludedRate,
  };
  if (thresholds.minSessions !== undefined && totalSessions < thresholds.minSessions) {
    return {
      status: 'collect_more_sessions',
      recommendation: `Collect at least ${thresholds.minSessions} fresh sessions before tuning thresholds.`,
      observed,
      thresholds,
      notes: [`Current sample has ${totalSessions} sessions.`],
    };
  }
  if (
    thresholds.minAgentCandidates !== undefined &&
    agentCandidateSessions < thresholds.minAgentCandidates
  ) {
    return {
      status: 'collect_more_sessions',
      recommendation: `Collect at least ${thresholds.minAgentCandidates} non-excluded agent-task sessions before tuning thresholds.`,
      observed,
      thresholds,
      notes: [`Current sample has ${agentCandidateSessions} non-excluded agent candidates.`],
    };
  }
  if (
    (thresholds.minManualReviewed !== undefined && manualReviewed < thresholds.minManualReviewed) ||
    (thresholds.minManualReviewedAgentCandidates !== undefined &&
      manualReviewedAgentCandidates < thresholds.minManualReviewedAgentCandidates) ||
    (thresholds.maxPendingReview !== undefined && pendingReview > thresholds.maxPendingReview)
  ) {
    notes.push('Do not tune thresholds before manual Replay review is complete.');
    if (topFailure) {
      notes.push(`Top quality blocker is ${topFailure.failure} at ${formatPercent(topFailureRate)}.`);
    }
    return {
      status: 'manual_review_required',
      recommendation: 'Keep the strict P3 gate and finish manual review before threshold tuning.',
      observed,
      thresholds,
      notes,
    };
  }
  if (
    (thresholds.minG2Rate !== undefined && g2Rate < thresholds.minG2Rate) ||
    (thresholds.maxTopFailureRate !== undefined && topFailureRate > thresholds.maxTopFailureRate) ||
    (thresholds.maxDiagnosticRate !== undefined && diagnosticRate > thresholds.maxDiagnosticRate) ||
    (thresholds.maxExcludedRate !== undefined && excludedRate > thresholds.maxExcludedRate)
  ) {
    if (topFailure) {
      notes.push(`Fix or explain ${topFailure.failure} before lowering the gate.`);
    }
    return {
      status: 'collection_quality_required',
      recommendation: 'Keep the strict P3 gate and fix the dominant collection-quality bucket before tuning.',
      observed,
      thresholds,
      notes,
    };
  }
  if (input.qualityGatePassed) {
    return {
      status: 'strict_gate_ready',
      recommendation: 'Keep the strict P3 gate for this sample.',
      observed,
      thresholds,
      notes: ['Observed sample satisfies the configured closeout thresholds.'],
    };
  }
  return {
    status: 'threshold_review_required',
    recommendation: 'Review gate failures manually before changing thresholds.',
    observed,
    thresholds,
    notes,
  };
}

function buildMarkdownReport(summary: {
  ok: boolean;
  generatedAt: number;
  sourceDataDir: string;
  copiedDataDir: boolean;
  out?: string;
  reviewManifestOut?: string;
  reviewPacketOut?: string;
  reportOut?: string;
  allowGateFailure: boolean;
  liveDbBackup?: LiveDbBackup;
  sampleWindow?: unknown;
  exportCollectionSource?: AgentTrajectoryCollectionSource;
  totalSessions: number;
  exported: number;
  byTier: Record<string, number>;
  g2Rate: number;
  diagnosticRate: number;
  excludedRate: number;
  byDatasetRole: Record<string, number>;
  byCollectionSource: Record<string, number>;
  failureTop: Array<{ failure: string; count: number }>;
  qualityGate: {
    passed: boolean;
    failures: string[];
    minSessions?: number;
    minAgentCandidates?: number;
    minExported?: number;
    minManualReviewed?: number;
    minManualReviewedAgentCandidates?: number;
    maxPendingReview?: number;
    minG2Rate?: number;
    maxTopFailureRate?: number;
    maxDiagnosticRate?: number;
    maxExcludedRate?: number;
    topFailure?: { failure: string; count: number };
    topFailureRate: number;
  };
  reviewProgress: {
    manualReviewed: number;
    pendingReview: number;
    manualReviewedAgentCandidates: number;
    pendingAgentCandidateReview: number;
    manualReviewedCoreEval: number;
    manualReviewedDiagnostic: number;
    manualReviewedExcluded: number;
  };
  thresholdCalibration: GateThresholdCalibration;
  p3RequirementAudit: P3RequirementAuditItem[];
  p3ActionPlan: P3ActionPlan;
  p3ReviewWorklist: P3ReviewWorklist;
  p3CollectionBlockers: P3CollectionBlocker[];
}): string {
  const generatedAt = new Date(summary.generatedAt).toISOString();
  const status = summary.ok ? 'passed' : 'failed';
  const failures = summary.qualityGate.failures.length > 0 ? summary.qualityGate.failures.join(', ') : 'none';
  const topFailure = summary.qualityGate.topFailure
    ? `${summary.qualityGate.topFailure.failure} (${summary.qualityGate.topFailure.count}, ${formatPercent(
        summary.qualityGate.topFailureRate,
      )})`
    : 'none';
  const sampleWindow = summary.sampleWindow ? JSON.stringify(summary.sampleWindow) : 'latest sessions';
  const failureRows = summary.failureTop
    .slice(0, 10)
    .map((item) => `| ${item.failure} | ${item.count} |`)
    .join('\n');
  const calibrationRows = [
    ['Agent candidates', `${summary.thresholdCalibration.observed.agentCandidateSessions}`],
    ['G2 rate', formatPercent(summary.thresholdCalibration.observed.g2Rate)],
    ['Top failure rate', formatPercent(summary.thresholdCalibration.observed.topFailureRate)],
    ['Diagnostic rate', formatPercent(summary.thresholdCalibration.observed.diagnosticRate)],
    ['Excluded rate', formatPercent(summary.thresholdCalibration.observed.excludedRate)],
    ['Manual reviewed', `${summary.thresholdCalibration.observed.manualReviewed}`],
    ['Manual reviewed agent candidates', `${summary.thresholdCalibration.observed.manualReviewedAgentCandidates}`],
    ['Pending review', `${summary.thresholdCalibration.observed.pendingReview}`],
    ['Pending agent candidate review', `${summary.thresholdCalibration.observed.pendingAgentCandidateReview}`],
  ]
    .map(([metric, value]) => `| ${metric} | ${value} |`)
    .join('\n');
  const calibrationNotes =
    summary.thresholdCalibration.notes.length > 0
      ? summary.thresholdCalibration.notes.map((note) => `- ${note}`).join('\n')
      : '- none';
  const requirementRows = summary.p3RequirementAudit
    .map(
      (item) =>
        `| ${markdownCell(item.requirement)} | ${item.status} | ${markdownCell(item.evidence)} | ${markdownCell(
          item.nextAction,
        )} |`,
    )
    .join('\n');
  const actionRows = summary.p3ActionPlan.items
    .map(
      (item) =>
        `| ${item.priority} | ${item.action} | ${item.status} | ${markdownCell(item.current)} | ${markdownCell(
          item.target,
        )} | ${markdownCell(item.remaining)} | ${markdownCell(item.detail)} |`,
    )
    .join('\n');
  const reviewWorklistRows = summary.p3ReviewWorklist.reviewOrder
    .slice(0, 20)
    .map(
      (item, index) =>
        `| ${index + 1} | ${markdownCell(item.sessionId)} | ${item.reviewScope} | ${item.suggestedAction} | ${
          item.currentDatasetRole
        } | ${item.tier} | ${item.taskKind} | ${
          item.failures.length > 0 ? markdownCell(item.failures.join('<br>')) : 'none'
        } |`,
    )
    .join('\n');
  const topPendingFailure = summary.p3ReviewWorklist.topPendingFailure
    ? `${summary.p3ReviewWorklist.topPendingFailure.failure} (${summary.p3ReviewWorklist.topPendingFailure.count})`
    : 'none';
  const collectionBlockerRows = summary.p3CollectionBlockers
    .map(
      (item) =>
        `| ${markdownCell(item.failure)} | ${item.count} | ${item.agentCandidateCount} | ${markdownCell(
          item.agentCandidateSessionIds.join('<br>'),
        )} | ${item.excludedControlCount} | ${markdownCell(item.excludedControlSessionIds.join('<br>'))} |`,
    )
    .join('\n');

  return [
    '# Agent Trajectory Live Sample Closeout',
    '',
    `Generated at: ${generatedAt}`,
    '',
    `Status: ${status}`,
    '',
    '## Scope',
    '',
    `- Source data dir: \`${summary.sourceDataDir}\``,
    `- Copied DB dry-run: ${summary.copiedDataDir ? 'yes' : 'no'}`,
    `- Sample window: \`${sampleWindow}\``,
    `- Export collection source: ${summary.exportCollectionSource ?? 'any'}`,
    `- Core eval JSONL: ${summary.out ? `\`${summary.out}\`` : 'not written'}`,
    `- Review manifest: ${summary.reviewManifestOut ? `\`${summary.reviewManifestOut}\`` : 'not written'}`,
    `- Review packet: ${summary.reviewPacketOut ? `\`${summary.reviewPacketOut}\`` : 'not written'}`,
    `- Allow gate failure exit zero: ${summary.allowGateFailure ? 'yes' : 'no'}`,
    `- Live DB backup: ${summary.liveDbBackup ? `\`${summary.liveDbBackup.dir}\`` : 'not created'}`,
    '',
    '## Metrics',
    '',
    '| Metric | Value |',
    '| ------ | ----: |',
    `| Audited sessions | ${summary.totalSessions} |`,
    `| Exported core_eval rows | ${summary.exported} |`,
    `| G2 | ${summary.byTier.G2 ?? 0} |`,
    `| G1 | ${summary.byTier.G1 ?? 0} |`,
    `| G0 | ${summary.byTier.G0 ?? 0} |`,
    `| G2 rate | ${formatPercent(summary.g2Rate)} |`,
    `| Diagnostic rate | ${formatPercent(summary.diagnosticRate)} |`,
    `| Excluded rate | ${formatPercent(summary.excludedRate)} |`,
    `| Core eval | ${summary.byDatasetRole.core_eval ?? 0} |`,
    `| Diagnostic | ${summary.byDatasetRole.diagnostic ?? 0} |`,
    `| Excluded | ${summary.byDatasetRole.excluded ?? 0} |`,
    `| Manual reviewed | ${summary.reviewProgress.manualReviewed} |`,
    `| Manual reviewed agent candidates | ${summary.reviewProgress.manualReviewedAgentCandidates} |`,
    `| Pending review | ${summary.reviewProgress.pendingReview} |`,
    `| Pending agent candidate review | ${summary.reviewProgress.pendingAgentCandidateReview} |`,
    '',
    '## Gate',
    '',
    `- Gate status: ${summary.qualityGate.passed ? 'passed' : 'failed'}`,
    `- Gate failures: ${failures}`,
    `- Top failure: ${topFailure}`,
    `- Min sessions: ${summary.qualityGate.minSessions ?? 'not set'}`,
    `- Min agent candidates: ${summary.qualityGate.minAgentCandidates ?? 'not set'}`,
    `- Min exported: ${summary.qualityGate.minExported ?? 'not set'}`,
    `- Min manual reviewed: ${summary.qualityGate.minManualReviewed ?? 'not set'}`,
    `- Min manual reviewed agent candidates: ${
      summary.qualityGate.minManualReviewedAgentCandidates ?? 'not set'
    }`,
    `- Max pending review: ${summary.qualityGate.maxPendingReview ?? 'not set'}`,
    `- Min G2 rate: ${summary.qualityGate.minG2Rate ?? 'not set'}`,
    `- Max top failure rate: ${summary.qualityGate.maxTopFailureRate ?? 'not set'}`,
    `- Max diagnostic rate: ${summary.qualityGate.maxDiagnosticRate ?? 'not set'}`,
    `- Max excluded rate: ${summary.qualityGate.maxExcludedRate ?? 'not set'}`,
    '',
    '## Failure Top',
    '',
    failureRows ? ['| Failure | Count |', '| ------- | ----: |', failureRows].join('\n') : 'none',
    '',
    '## P3 Collection Blockers',
    '',
    collectionBlockerRows
      ? [
          '| Failure | Total | Agent candidates | Agent candidate sessions | Excluded controls | Excluded control sessions |',
          '| ------- | ----: | ---------------: | ------------------------ | ----------------: | ------------------------- |',
          collectionBlockerRows,
        ].join('\n')
      : 'none',
    '',
    '## Threshold Calibration',
    '',
    `- Status: ${summary.thresholdCalibration.status}`,
    `- Recommendation: ${summary.thresholdCalibration.recommendation}`,
    '',
    '| Metric | Observed |',
    '| ------ | -------: |',
    calibrationRows,
    '',
    'Notes:',
    calibrationNotes,
    '',
    '## P3 Requirement Audit',
    '',
    '| Requirement | Status | Evidence | Next action |',
    '| ----------- | ------ | -------- | ----------- |',
    requirementRows,
    '',
    '## P3 Action Plan',
    '',
    `- Status: ${summary.p3ActionPlan.status}`,
    `- Next action: ${summary.p3ActionPlan.nextAction}`,
    '',
    actionRows
      ? [
          '| Priority | Action | Status | Current | Target | Remaining | Detail |',
          '| -------: | ------ | ------ | ------- | ------ | --------- | ------ |',
          actionRows,
        ].join('\n')
      : 'No pending P3 actions.',
    '',
    '## P3 Review Worklist',
    '',
    `- Status: ${summary.p3ReviewWorklist.status}`,
    `- Next review session: ${summary.p3ReviewWorklist.nextReviewSessionId ?? 'none'}`,
    `- Pending agent candidates: ${summary.p3ReviewWorklist.agentCandidateReviewCount}`,
    `- Pending excluded controls: ${summary.p3ReviewWorklist.excludedControlReviewCount}`,
    `- Top pending failure: ${topPendingFailure}`,
    '',
    reviewWorklistRows
      ? [
          '| Order | Session | P3 scope | Action | Current role | Tier | Task | Failures |',
          '| ----: | ------- | -------- | ------ | ------------ | ---- | ---- | -------- |',
          reviewWorklistRows,
        ].join('\n')
      : 'No pending review rows.',
    '',
    '## Closeout Rule',
    '',
    'P3 can close only when this report passes on a fresh post-P2 live sample and the review manifest has been manually reviewed through the Replay dialog.',
    '',
  ].join('\n');
}

export function buildReviewPacketMarkdown(summary: {
  generatedAt: number;
  sourceDataDir: string;
  copiedDataDir: boolean;
  sampleWindow?: unknown;
  totalSessions: number;
  exported: number;
  reviewManifestOut?: string;
  reviewProgress: {
    manualReviewed: number;
    pendingReview: number;
    manualReviewedAgentCandidates?: number;
    pendingAgentCandidateReview?: number;
  };
  qualityGate: {
    passed: boolean;
    failures: string[];
  };
  reviewItems: ReviewPacketItem[];
}): string {
  const generatedAt = new Date(summary.generatedAt).toISOString();
  const sampleWindow = summary.sampleWindow ? JSON.stringify(summary.sampleWindow) : 'latest sessions';
  const agentCandidateRows = summary.reviewItems.filter((item) => item.reviewScope === 'agent_candidate').length;
  const excludedControlRows = summary.reviewItems.filter((item) => item.reviewScope === 'excluded_control').length;
  const rows = summary.reviewItems
    .map((item, index) =>
      [
        index + 1,
        item.priority,
        item.reviewScope,
        item.sessionId,
        item.suggestedAction,
        item.currentDatasetRole,
        item.tier,
        item.taskKind,
        item.collectionSource,
        item.failures.length > 0 ? item.failures.join('<br>') : 'none',
        formatEvidenceControlForReviewPacket(item.evidenceControl),
        '',
        '',
      ]
        .map(markdownCell)
        .join(' | '),
    )
    .map((row) => `| ${row} |`)
    .join('\n');

  return [
    '# Agent Trajectory Review Packet',
    '',
    `Generated at: ${generatedAt}`,
    '',
    '## Scope',
    '',
    `- Source data dir: \`${summary.sourceDataDir}\``,
    `- Copied DB dry-run: ${summary.copiedDataDir ? 'yes' : 'no'}`,
    `- Sample window: \`${sampleWindow}\``,
    `- Review manifest: ${summary.reviewManifestOut ? `\`${summary.reviewManifestOut}\`` : 'not written'}`,
    `- Audited sessions: ${summary.totalSessions}`,
    `- Exported core_eval rows: ${summary.exported}`,
    `- Manual reviewed: ${summary.reviewProgress.manualReviewed}`,
    `- Manual reviewed agent candidates: ${summary.reviewProgress.manualReviewedAgentCandidates ?? 'not tracked'}`,
    `- Pending review: ${summary.reviewProgress.pendingReview}`,
    `- Pending agent candidate review: ${summary.reviewProgress.pendingAgentCandidateReview ?? 'not tracked'}`,
    `- P3 agent candidate rows: ${agentCandidateRows}`,
    `- Excluded control rows: ${excludedControlRows}`,
    `- Gate status: ${summary.qualityGate.passed ? 'passed' : 'failed'}`,
    `- Gate failures: ${summary.qualityGate.failures.length > 0 ? summary.qualityGate.failures.join(', ') : 'none'}`,
    '',
    '## Review Instructions',
    '',
    'Use Sidebar `待审 -> Review Queue Trajectory -> 待复核` or search each session id, open the Replay dialog, then confirm or change the dataset role. A confirmed row should persist with `collection.source = manual_review`.',
    '',
    'For offline batch review, copy the final decision into `fresh-sample-review.json` under `review.datasetRole`. The apply script ignores `suggestedAction`, so this packet is guidance only.',
    '',
    '## Review Items',
    '',
    '| # | Priority | P3 scope | Session | Suggested action | Current role | Tier | Task | Source | Failures | Evidence Control | Final review.datasetRole | Notes |',
    '| -: | -------- | -------- | ------- | ---------------- | ------------ | ---- | ---- | ------ | -------- | ---------------- | ------------------------ | ----- |',
    rows || '| | | | | | | | | | | | |',
    '',
  ].join('\n');
}

async function main(): Promise<void> {
  const options = parseOptions();
  const liveDbBackup = await backupLiveDatabaseIfNeeded(
    options.dataDir,
    options.liveDataDir && options.persistCollectionMetadata && options.backupLiveDb,
    options.liveDbBackupDir,
  );
  const runtimeDataDir = await prepareRuntimeDataDir(options.dataDir, options.liveDataDir);
  process.env.CODE_AGENT_DATA_DIR = runtimeDataDir;

  const { getDatabase } = await import('../src/host/services/core/databaseService');
  const { exportAgentTrajectories, writeAgentTrajectoryJsonl } =
    await import('../src/host/evaluation/trajectory/trajectoryExporter');

  try {
    await getDatabase().initialize();
    const result = await exportAgentTrajectories({
      sessionIds: options.sessionIds,
      limit: options.limit,
      since: options.since,
      until: options.until,
      minTier: options.minTier,
      includeRejected: options.includeRejected,
      datasetVersion: options.datasetVersion,
      persistCollectionMetadata: options.persistCollectionMetadata,
      exportCollectionSource: options.exportCollectionSource,
    });

    if (options.out) {
      await writeAgentTrajectoryJsonl(options.out, result.trajectories);
    }

    const topFailure = result.failureCounts[0];
    const topFailureRate = topFailure && result.totalSessions > 0 ? topFailure.count / result.totalSessions : 0;
    const diagnosticRate =
      result.totalSessions > 0 ? result.byDatasetRole.diagnostic / result.totalSessions : 0;
    const excludedRate = result.totalSessions > 0 ? result.byDatasetRole.excluded / result.totalSessions : 0;
    const agentCandidateSessions = (result.byDatasetRole.core_eval ?? 0) + (result.byDatasetRole.diagnostic ?? 0);
    const manualReviewed = result.byCollectionSource.manual_review ?? 0;
    const manualReviewedAgentCandidates = result.audits.filter(
      (item) =>
        item.collectionSource === 'manual_review' &&
        (item.datasetRole === 'core_eval' || item.datasetRole === 'diagnostic'),
    ).length;
    const pendingReview = Math.max(0, result.totalSessions - manualReviewed);
    const pendingAgentCandidateReview = Math.max(0, agentCandidateSessions - manualReviewedAgentCandidates);
    const qualityGateFailures: string[] = [];
    if (options.minSessions !== undefined && result.totalSessions < options.minSessions) {
      qualityGateFailures.push(`session_count_below_${options.minSessions}`);
    }
    if (
      options.minAgentCandidates !== undefined &&
      agentCandidateSessions < options.minAgentCandidates
    ) {
      qualityGateFailures.push(`agent_candidate_count_below_${options.minAgentCandidates}`);
    }
    if (options.minExported !== undefined && result.exported < options.minExported) {
      qualityGateFailures.push(`exported_count_below_${options.minExported}`);
    }
    if (options.minManualReviewed !== undefined && manualReviewed < options.minManualReviewed) {
      qualityGateFailures.push(`manual_reviewed_count_below_${options.minManualReviewed}`);
    }
    if (
      options.minManualReviewedAgentCandidates !== undefined &&
      manualReviewedAgentCandidates < options.minManualReviewedAgentCandidates
    ) {
      qualityGateFailures.push(
        `manual_reviewed_agent_candidate_count_below_${options.minManualReviewedAgentCandidates}`,
      );
    }
    if (options.maxPendingReview !== undefined && pendingReview > options.maxPendingReview) {
      qualityGateFailures.push(`pending_review_above_${options.maxPendingReview}`);
    }
    if (options.minG2Rate !== undefined && result.g2Rate < options.minG2Rate) {
      qualityGateFailures.push(`g2_rate_below_${options.minG2Rate}`);
    }
    if (options.maxTopFailureRate !== undefined && topFailure && topFailureRate > options.maxTopFailureRate) {
      qualityGateFailures.push(`top_failure_rate_above_${options.maxTopFailureRate}`);
    }
    if (options.maxDiagnosticRate !== undefined && diagnosticRate > options.maxDiagnosticRate) {
      qualityGateFailures.push(`diagnostic_rate_above_${options.maxDiagnosticRate}`);
    }
    if (options.maxExcludedRate !== undefined && excludedRate > options.maxExcludedRate) {
      qualityGateFailures.push(`excluded_rate_above_${options.maxExcludedRate}`);
    }
    const thresholdCalibration = buildGateThresholdCalibration({
      totalSessions: result.totalSessions,
      exported: result.exported,
      manualReviewed,
      manualReviewedAgentCandidates,
      pendingReview,
      pendingAgentCandidateReview,
      g2Rate: result.g2Rate,
      topFailureRate,
      diagnosticRate,
      excludedRate,
      agentCandidateSessions,
      topFailure,
      qualityGatePassed: qualityGateFailures.length === 0,
      thresholds: {
        minSessions: options.minSessions,
        minAgentCandidates: options.minAgentCandidates,
        minExported: options.minExported,
        minManualReviewed: options.minManualReviewed,
        minManualReviewedAgentCandidates: options.minManualReviewedAgentCandidates,
        maxPendingReview: options.maxPendingReview,
        minG2Rate: options.minG2Rate,
        maxTopFailureRate: options.maxTopFailureRate,
        maxDiagnosticRate: options.maxDiagnosticRate,
        maxExcludedRate: options.maxExcludedRate,
      },
    });
    const reviewProgress = {
      manualReviewed,
      pendingReview,
      manualReviewedAgentCandidates,
      pendingAgentCandidateReview,
      manualReviewedCoreEval: result.audits.filter(
        (item) => item.collectionSource === 'manual_review' && item.datasetRole === 'core_eval',
      ).length,
      manualReviewedDiagnostic: result.audits.filter(
        (item) => item.collectionSource === 'manual_review' && item.datasetRole === 'diagnostic',
      ).length,
      manualReviewedExcluded: result.audits.filter(
        (item) => item.collectionSource === 'manual_review' && item.datasetRole === 'excluded',
      ).length,
    };
    const qualityGate = {
      passed: qualityGateFailures.length === 0,
      failures: qualityGateFailures,
      minSessions: options.minSessions,
      minAgentCandidates: options.minAgentCandidates,
      minExported: options.minExported,
      minManualReviewed: options.minManualReviewed,
      minManualReviewedAgentCandidates: options.minManualReviewedAgentCandidates,
      maxPendingReview: options.maxPendingReview,
      minG2Rate: options.minG2Rate,
      maxTopFailureRate: options.maxTopFailureRate,
      maxDiagnosticRate: options.maxDiagnosticRate,
      maxExcludedRate: options.maxExcludedRate,
      topFailure,
      topFailureRate,
    };
    const p3RequirementAudit = buildP3RequirementAudit({
      totalSessions: result.totalSessions,
      exported: result.exported,
      sampleWindow: result.sampleWindow,
      byDatasetRole: result.byDatasetRole,
      reviewProgress,
      qualityGate,
      thresholdCalibration,
    });
    const p3ActionPlan = buildP3ActionPlan({
      exported: result.exported,
      byDatasetRole: result.byDatasetRole,
      reviewProgress,
      qualityGate,
      thresholdCalibration,
    });
    const reviewItems = result.audits
      .map((item) => ({
        sessionId: item.sessionId,
        reviewScope: buildReviewScope(item),
        currentDatasetRole: item.datasetRole,
        suggestedAction: buildReviewAction(item),
        priority: buildReviewPriority(item),
        tier: item.tier,
        taskKind: item.taskKind,
        datasetVersion: item.datasetVersion,
        collectionSource: item.collectionSource,
        failures: item.failures.slice(0, 8),
        evidenceControl: item.evidenceControl,
        metrics: item.metrics,
        review: buildEmptyReviewDecision(item),
      }))
      .sort((left, right) => {
        const priorityRank = { high: 0, medium: 1, low: 2 };
        return priorityRank[left.priority] - priorityRank[right.priority];
      });
    const p3ReviewWorklist = buildP3ReviewWorklist({ reviewItems });
    const p3CollectionBlockers = buildP3CollectionBlockers({
      reviewItems: result.audits.map((item) => ({
        sessionId: item.sessionId,
        reviewScope: buildReviewScope(item),
        failures: item.failures,
      })),
      failureOrder: result.failureCounts.map((item) => item.failure),
      limit: 10,
    });

    const summary = {
      ok: qualityGateFailures.length === 0,
      generatedAt: result.generatedAt,
      sourceDataDir: options.dataDir,
      runtimeDataDir,
      copiedDataDir: !options.liveDataDir,
      out: options.out,
      reviewManifestOut: options.reviewManifestOut,
      reviewPacketOut: options.reviewPacketOut,
      reportOut: options.reportOut,
      minTier: options.minTier,
      includeRejected: options.includeRejected,
      exportCollectionSource: options.exportCollectionSource,
      datasetVersion: result.datasetVersion,
      sampleWindow: result.sampleWindow,
      persistCollectionMetadata: options.persistCollectionMetadata,
      allowGateFailure: options.allowGateFailure,
      liveDbBackup,
      totalSessions: result.totalSessions,
      exported: result.exported,
      rejected: result.rejected,
      byTier: result.byTier,
      g2Rate: result.g2Rate,
      diagnosticRate,
      excludedRate,
      byDatasetRole: result.byDatasetRole,
      byTaskKind: result.byTaskKind,
      byDatasetVersion: result.byDatasetVersion,
      byCollectionSource: result.byCollectionSource,
      byCollectionIntent: result.byCollectionIntent,
      reviewProgress,
      failureTop: result.failureCounts.slice(0, 20),
      failureComparison: result.failureComparison,
      trendBuckets: result.trendBuckets.slice(-14),
      qualityGate,
      thresholdCalibration,
      p3RequirementAudit,
      p3ActionPlan,
      p3ReviewWorklist,
      p3CollectionBlockers,
      reviewSample: {
        coreEval: result.audits
          .filter((item) => item.datasetRole === 'core_eval')
          .slice(0, 20)
          .map((item) => ({
            sessionId: item.sessionId,
            tier: item.tier,
            taskKind: item.taskKind,
            failures: item.failures,
          })),
        diagnostic: result.audits
          .filter((item) => item.datasetRole === 'diagnostic')
          .slice(0, 20)
          .map((item) => ({
            sessionId: item.sessionId,
            tier: item.tier,
            taskKind: item.taskKind,
            failures: item.failures.slice(0, 8),
          })),
        excluded: result.audits
          .filter((item) => item.datasetRole === 'excluded')
          .slice(0, 20)
          .map((item) => ({
            sessionId: item.sessionId,
            tier: item.tier,
            taskKind: item.taskKind,
            failures: item.failures.slice(0, 8),
          })),
      },
      reviewItems,
      sampleRejected: result.audits
        .filter((item) => !item.exportReady)
        .slice(0, 10)
        .map((item) => ({
          sessionId: item.sessionId,
          tier: item.tier,
          datasetRole: item.datasetRole,
          datasetVersion: item.datasetVersion,
          collectionSource: item.collectionSource,
          taskKind: item.taskKind,
          failures: item.failures.slice(0, 8),
        })),
    };

    if (options.reviewManifestOut) {
      await writeJsonFile(options.reviewManifestOut, {
        generatedAt: summary.generatedAt,
        sourceDataDir: summary.sourceDataDir,
        copiedDataDir: summary.copiedDataDir,
        sampleWindow: summary.sampleWindow,
        exportCollectionSource: summary.exportCollectionSource,
        datasetVersion: summary.datasetVersion,
        totalSessions: summary.totalSessions,
        exported: summary.exported,
        byTier: summary.byTier,
        g2Rate: summary.g2Rate,
        byDatasetRole: summary.byDatasetRole,
        byTaskKind: summary.byTaskKind,
        byCollectionSource: summary.byCollectionSource,
        byCollectionIntent: summary.byCollectionIntent,
        diagnosticRate: summary.diagnosticRate,
        excludedRate: summary.excludedRate,
        failureTop: summary.failureTop,
        failureComparison: summary.failureComparison,
        reviewProgress: summary.reviewProgress,
        qualityGate: summary.qualityGate,
        liveDbBackup: summary.liveDbBackup,
        thresholdCalibration: summary.thresholdCalibration,
        p3RequirementAudit: summary.p3RequirementAudit,
        p3ActionPlan: summary.p3ActionPlan,
        p3ReviewWorklist: summary.p3ReviewWorklist,
        p3CollectionBlockers: summary.p3CollectionBlockers,
        reviewSample: summary.reviewSample,
        reviewItems: summary.reviewItems,
      });
    }

    if (options.reportOut) {
      await writeTextFile(options.reportOut, buildMarkdownReport(summary));
    }

    if (options.reviewPacketOut) {
      await writeTextFile(options.reviewPacketOut, buildReviewPacketMarkdown(summary));
    }

    if (options.json) {
      console.log(JSON.stringify(summary, null, 2));
    } else {
      console.log(`Agent trajectory audit: ${summary.exported}/${summary.totalSessions} exported`);
      console.log(JSON.stringify(summary, null, 2));
    }
    if (!summary.ok && !options.allowGateFailure) {
      process.exitCode = 2;
    }
  } finally {
    getDatabase().close();
    if (!options.liveDataDir && !options.keepTmp) {
      await rm(runtimeDataDir, { recursive: true, force: true });
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
