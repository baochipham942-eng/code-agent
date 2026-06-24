#!/usr/bin/env npx tsx

import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'fs/promises';
import { homedir, tmpdir } from 'os';
import path from 'path';
import process from 'process';
import { pathToFileURL } from 'url';

import type { AgentTrajectoryDatasetRole } from '../src/shared/contract/agentTrajectory';
import type { AgentTrajectoryAuditItem } from '../src/main/evaluation/trajectory/trajectoryExporter';

type RequirementStatus = 'passed' | 'partial' | 'failed' | 'blocked';

interface CliOptions {
  dataDir: string;
  liveDataDir: boolean;
  keepTmp: boolean;
  limit: number;
  since?: number;
  until?: number;
  out: string;
  coreEvalPath: string;
  dossierPath: string;
  worksheetPath: string;
  json: boolean;
  minSessions: number;
  maxSessions: number;
  minAgentCandidates: number;
  minExported: number;
  minManualReviewed: number;
  minManualReviewedAgentCandidates: number;
  maxPendingReview: number;
  minG2Rate: number;
  maxTopFailureRate: number;
  maxDiagnosticRate: number;
  maxExcludedRate: number;
}

interface ArtifactStatus {
  path: string;
  exists: boolean;
  lineCount?: number;
  sizeBytes?: number;
}

interface RequirementRow {
  requirement: string;
  status: RequirementStatus;
  evidence: string;
  nextAction: string;
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

function parseTimestampFlag(value: string | undefined): number | undefined {
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

function readNumber(args: string[], name: string, fallback: number): number {
  const value = readFlagValue(args, name);
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseOptions(): CliOptions {
  const args = process.argv.slice(2);
  return {
    dataDir: readFlagValue(args, '--data-dir') || defaultDataDir(),
    liveDataDir: args.includes('--live-data-dir'),
    keepTmp: args.includes('--keep-tmp'),
    limit: readNumber(args, '--limit', 50),
    since: parseTimestampFlag(readFlagValue(args, '--since')),
    until: parseTimestampFlag(readFlagValue(args, '--until')),
    out: readFlagValue(args, '--out') || 'docs/audits/agent-trajectory-p3-acceptance-latest.md',
    coreEvalPath: readFlagValue(args, '--core-eval-path') || 'eval-datasets/agent-trajectory/core-eval.jsonl',
    dossierPath: readFlagValue(args, '--dossier-path') || 'docs/audits/agent-trajectory-review-dossier-latest.md',
    worksheetPath:
      readFlagValue(args, '--worksheet-path') ||
      'docs/audits/agent-trajectory-agent-candidate-review-worksheet-latest.md',
    json: args.includes('--json'),
    minSessions: readNumber(args, '--min-sessions', 20),
    maxSessions: readNumber(args, '--max-sessions', 50),
    minAgentCandidates: readNumber(args, '--min-agent-candidates', 20),
    minExported: readNumber(args, '--min-exported', 20),
    minManualReviewed: readNumber(args, '--min-manual-reviewed', 20),
    minManualReviewedAgentCandidates: readNumber(args, '--min-manual-reviewed-agent-candidates', 20),
    maxPendingReview: readNumber(args, '--max-pending-review', 0),
    minG2Rate: readNumber(args, '--min-g2-rate', 0.7),
    maxTopFailureRate: readNumber(args, '--max-top-failure-rate', 0.2),
    maxDiagnosticRate: readNumber(args, '--max-diagnostic-rate', 0.3),
    maxExcludedRate: readNumber(args, '--max-excluded-rate', 0.05),
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

  const runtimeDataDir = await mkdtemp(path.join(tmpdir(), 'agent-trajectory-p3-acceptance-'));
  const sourceDb = path.join(sourceDataDir, 'code-agent.db');
  const targetDb = path.join(runtimeDataDir, 'code-agent.db');
  await copyIfExists(sourceDb, targetDb);
  await copyIfExists(`${sourceDb}-wal`, `${targetDb}-wal`);
  await copyIfExists(`${sourceDb}-shm`, `${targetDb}-shm`);
  return runtimeDataDir;
}

function isAgentCandidate(role: AgentTrajectoryDatasetRole): boolean {
  return role === 'core_eval' || role === 'diagnostic';
}

function reviewPriorityRank(item: {
  datasetRole: AgentTrajectoryDatasetRole;
  tier: string;
  failures: string[];
}): number {
  const scopeOffset = isAgentCandidate(item.datasetRole) ? 0 : 3;
  if (item.datasetRole === 'diagnostic' && item.tier === 'G1') return scopeOffset;
  if (item.datasetRole === 'core_eval') return scopeOffset + 1;
  if (item.failures.includes('ordinary_chat_no_tool')) return scopeOffset + 2;
  return scopeOffset + 1;
}

function countAgentCandidates(audits: AgentTrajectoryAuditItem[]): number {
  return audits.filter((item) => isAgentCandidate(item.datasetRole)).length;
}

function pendingRows(audits: AgentTrajectoryAuditItem[]): AgentTrajectoryAuditItem[] {
  return audits
    .filter((item) => item.collectionSource !== 'manual_review')
    .slice()
    .sort(
      (left, right) =>
        reviewPriorityRank(left) - reviewPriorityRank(right) ||
        (right.startedAt ?? 0) - (left.startedAt ?? 0) ||
        left.sessionId.localeCompare(right.sessionId),
    );
}

function countManualReviewedAgentCandidates(audits: AgentTrajectoryAuditItem[]): number {
  return audits.filter((item) => item.collectionSource === 'manual_review' && isAgentCandidate(item.datasetRole)).length;
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

function countRemaining(current: number, target: number): number {
  return Math.max(0, target - current);
}

function markdownCell(value: unknown): string {
  return String(value ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, '<br>');
}

async function inspectArtifact(filePath: string, countLines = false): Promise<ArtifactStatus> {
  try {
    const fileStat = await stat(filePath);
    const artifact: ArtifactStatus = {
      path: filePath,
      exists: true,
      sizeBytes: fileStat.size,
    };
    if (countLines) {
      const text = await readFile(filePath, 'utf8');
      artifact.lineCount = text.trim().length === 0 ? 0 : text.trimEnd().split(/\r?\n/).length;
    }
    return artifact;
  } catch {
    return {
      path: filePath,
      exists: false,
      ...(countLines ? { lineCount: 0 } : {}),
    };
  }
}

function statusLabel(status: RequirementStatus): string {
  return status;
}

function buildRequirementRows(input: {
  options: CliOptions;
  totalSessions: number;
  agentCandidates: number;
  manualReviewed: number;
  manualReviewedAgentCandidates: number;
  pendingReview: number;
  pendingAgentCandidates: number;
  exported: number;
  coreEvalLines: number;
  byDatasetRole: Record<AgentTrajectoryDatasetRole, number>;
  byCollectionSource: Record<string, number>;
  g2Rate: number;
  diagnosticRate: number;
  excludedRate: number;
  topFailure?: { failure: string; count: number };
  topFailureRate: number;
  sampleGap?: {
    additionalHistoricalAgentCandidates: number;
    currentWindowNeedsNewAgentCandidates: number;
    allAvailableStillNeedsAgentCandidates: number;
  };
}): RequirementRow[] {
  const rows: RequirementRow[] = [];
  const sessionInRange = input.totalSessions >= input.options.minSessions && input.totalSessions <= input.options.maxSessions;
  const enoughAgentCandidates = input.agentCandidates >= input.options.minAgentCandidates;
  rows.push({
    requirement: '20-50 real agent sessions sampled',
    status: sessionInRange && enoughAgentCandidates ? 'passed' : 'partial',
    evidence: `${input.totalSessions} audited sessions, ${input.agentCandidates} non-excluded agent candidates. Current P3 window needs ${countRemaining(input.agentCandidates, input.options.minAgentCandidates)} more agent candidates.`,
    nextAction: enoughAgentCandidates
      ? 'Keep the current window and finish manual review.'
      : `Collect ${countRemaining(input.agentCandidates, input.options.minAgentCandidates)} more fresh non-excluded agent-task sessions in the P3 window.`,
  });

  const reviewComplete =
    input.manualReviewed >= input.options.minManualReviewed &&
    input.manualReviewedAgentCandidates >= input.options.minManualReviewedAgentCandidates &&
    input.pendingReview <= input.options.maxPendingReview;
  rows.push({
    requirement: 'Review Queue manual review complete',
    status: reviewComplete ? 'passed' : 'failed',
    evidence: `${input.manualReviewed} manual_review rows, ${input.manualReviewedAgentCandidates} reviewed agent candidates, ${input.pendingReview} total pending rows, ${input.pendingAgentCandidates} pending agent candidates.`,
    nextAction: reviewComplete
      ? 'Review queue is closed for this window.'
      : 'Open the review worksheet or dossier, verify each agent candidate in Replay, then apply explicit review decisions.',
  });

  const jsonlReady =
    input.exported >= input.options.minExported &&
    input.coreEvalLines >= input.options.minExported &&
    input.coreEvalLines === input.exported;
  rows.push({
    requirement: 'core_eval JSONL export ready',
    status: jsonlReady ? 'passed' : 'failed',
    evidence: `${input.exported} formal manual_review export rows, ${input.coreEvalLines} lines in core-eval JSONL.`,
    nextAction: jsonlReady
      ? 'JSONL export matches the formal reviewed rows.'
      : 'Run post-review check after manual review; only manual_review core_eval rows should enter the final JSONL.',
  });

  const segmentationTotal =
    input.byDatasetRole.core_eval + input.byDatasetRole.diagnostic + input.byDatasetRole.excluded;
  const segmentationReady = segmentationTotal === input.totalSessions && input.totalSessions > 0;
  rows.push({
    requirement: 'diagnostic/excluded segmentation available',
    status: segmentationReady ? 'passed' : 'failed',
    evidence: `core_eval=${input.byDatasetRole.core_eval}, diagnostic=${input.byDatasetRole.diagnostic}, excluded=${input.byDatasetRole.excluded}.`,
    nextAction: segmentationReady
      ? 'Use segmentation to separate eval promotion from capture-quality debugging.'
      : 'Rerun trajectory audit; segmentation counts do not match audited sessions.',
  });

  const enoughReviewedForCalibration =
    input.agentCandidates >= input.options.minAgentCandidates &&
    input.manualReviewedAgentCandidates >= input.options.minManualReviewedAgentCandidates;
  const qualityGatePassed =
    input.g2Rate >= input.options.minG2Rate &&
    input.topFailureRate <= input.options.maxTopFailureRate &&
    input.diagnosticRate <= input.options.maxDiagnosticRate &&
    input.excludedRate <= input.options.maxExcludedRate;
  rows.push({
    requirement: 'fresh-sample gate threshold calibration',
    status: !enoughReviewedForCalibration ? 'blocked' : qualityGatePassed ? 'passed' : 'failed',
    evidence: `G2=${formatPercent(input.g2Rate)}, top_failure=${input.topFailure ? `${input.topFailure.failure} ${formatPercent(input.topFailureRate)}` : 'none'}, diagnostic=${formatPercent(input.diagnosticRate)}, excluded=${formatPercent(input.excludedRate)}.`,
    nextAction: !enoughReviewedForCalibration
      ? 'Collect and manually review at least 20 non-excluded agent candidates before tuning thresholds.'
      : qualityGatePassed
        ? 'Keep current thresholds for this window.'
        : 'Tune only after reviewing whether failures are collection bugs or acceptable diagnostic rows.',
  });

  rows.push({
    requirement: 'P3 closeout decision',
    status: rows.every((row) => row.status === 'passed') ? 'passed' : 'failed',
    evidence: `collection_source manual_review=${input.byCollectionSource.manual_review ?? 0}, audit_backfill=${input.byCollectionSource.audit_backfill ?? 0}.`,
    nextAction: rows.every((row) => row.status === 'passed')
      ? 'P3 can be closed after final strict live-closeout rerun.'
      : 'Keep P3 open; current evidence does not prove the requested end state.',
  });

  return rows;
}

function renderMarkdown(input: {
  generatedAt: number;
  sourceDataDir: string;
  runtimeDataDir: string;
  liveDataDir: boolean;
  sampleWindow?: unknown;
  requirements: RequirementRow[];
  artifacts: ArtifactStatus[];
  nextReviewSessionId?: string;
  pendingAgentCandidateSessionIds: string[];
  failures: string[];
}): string {
  const requirementRows = input.requirements
    .map((row) =>
      [
        row.requirement,
        statusLabel(row.status),
        row.evidence,
        row.nextAction,
      ]
        .map(markdownCell)
        .join(' | '),
    )
    .map((row) => `| ${row} |`)
    .join('\n');
  const artifactRows = input.artifacts
    .map((artifact) =>
      [
        artifact.path,
        artifact.exists ? 'present' : 'missing',
        artifact.lineCount ?? '',
        artifact.sizeBytes ?? '',
      ]
        .map(markdownCell)
        .join(' | '),
    )
    .map((row) => `| ${row} |`)
    .join('\n');

  return [
    '# Agent Trajectory P3 Acceptance Snapshot',
    '',
    `Generated at: ${new Date(input.generatedAt).toISOString()}`,
    '',
    '## Scope',
    '',
    `- Source data dir: \`${input.sourceDataDir}\``,
    `- Runtime data dir: \`${input.runtimeDataDir}\``,
    `- Live DB read: ${input.liveDataDir ? 'yes' : 'no, copied DB'}`,
    `- Sample window: \`${input.sampleWindow ? JSON.stringify(input.sampleWindow) : 'latest sessions'}\``,
    `- Next review session: \`${input.nextReviewSessionId ?? 'none'}\``,
    `- Pending agent candidates: ${input.pendingAgentCandidateSessionIds.length}`,
    '',
    'This snapshot is read-only. It is an acceptance audit for the P3 data loop and does not write collection metadata, review decisions, or JSONL rows.',
    '',
    '## Requirement Matrix',
    '',
    '| Requirement | Status | Evidence | Next action |',
    '| ----------- | ------ | -------- | ----------- |',
    requirementRows,
    '',
    '## Artifacts',
    '',
    '| Artifact | Status | Lines | Bytes |',
    '| -------- | ------ | ----: | ----: |',
    artifactRows,
    '',
    '## Pending Agent Candidates',
    '',
    input.pendingAgentCandidateSessionIds.length > 0
      ? input.pendingAgentCandidateSessionIds.map((sessionId) => `- ${sessionId}`).join('\n')
      : '- none',
    '',
    '## Gate Failures',
    '',
    input.failures.length > 0 ? input.failures.map((failure) => `- ${failure}`).join('\n') : '- none',
    '',
  ].join('\n');
}

async function main(): Promise<void> {
  const options = parseOptions();
  const runtimeDataDir = await prepareRuntimeDataDir(options.dataDir, options.liveDataDir);
  process.env.CODE_AGENT_DATA_DIR = runtimeDataDir;

  const { getDatabase } = await import('../src/main/services/core/databaseService');
  const { exportAgentTrajectories } = await import('../src/main/evaluation/trajectory/trajectoryExporter');

  try {
    await getDatabase().initialize();
    const result = await exportAgentTrajectories({
      limit: options.limit,
      since: options.since,
      until: options.until,
      minTier: 'G2',
      includeRejected: false,
      persistCollectionMetadata: false,
      exportCollectionSource: 'manual_review',
    });
    const allAvailableResult =
      options.since !== undefined || options.until !== undefined
        ? await exportAgentTrajectories({
            limit: options.limit,
            minTier: 'G2',
            includeRejected: false,
            persistCollectionMetadata: false,
            exportCollectionSource: 'manual_review',
          })
        : result;
    const agentCandidates = countAgentCandidates(result.audits);
    const pending = pendingRows(result.audits);
    const pendingAgentCandidates = pending.filter((item) => isAgentCandidate(item.datasetRole));
    const manualReviewedAgentCandidates = countManualReviewedAgentCandidates(result.audits);
    const manualReviewed = result.byCollectionSource.manual_review ?? 0;
    const diagnosticRate =
      result.totalSessions > 0 ? (result.byDatasetRole.diagnostic ?? 0) / result.totalSessions : 0;
    const excludedRate =
      result.totalSessions > 0 ? (result.byDatasetRole.excluded ?? 0) / result.totalSessions : 0;
    const topFailure = result.failureCounts[0];
    const topFailureRate = topFailure && result.totalSessions > 0 ? topFailure.count / result.totalSessions : 0;
    const coreEvalArtifact = await inspectArtifact(options.coreEvalPath, true);
    const dossierArtifact = await inspectArtifact(options.dossierPath);
    const worksheetArtifact = await inspectArtifact(options.worksheetPath);
    const allAvailableAgentCandidates = countAgentCandidates(allAvailableResult.audits);
    const sampleGap = {
      additionalHistoricalAgentCandidates: Math.max(0, allAvailableAgentCandidates - agentCandidates),
      currentWindowNeedsNewAgentCandidates: countRemaining(agentCandidates, options.minAgentCandidates),
      allAvailableStillNeedsAgentCandidates: countRemaining(allAvailableAgentCandidates, options.minAgentCandidates),
    };
    const failures: string[] = [];
    if (result.totalSessions < options.minSessions) failures.push(`session_count_below_${options.minSessions}`);
    if (result.totalSessions > options.maxSessions) failures.push(`session_count_above_${options.maxSessions}`);
    if (agentCandidates < options.minAgentCandidates) {
      failures.push(`agent_candidate_count_below_${options.minAgentCandidates}`);
    }
    if (result.exported < options.minExported) failures.push(`exported_count_below_${options.minExported}`);
    if (manualReviewed < options.minManualReviewed) {
      failures.push(`manual_reviewed_count_below_${options.minManualReviewed}`);
    }
    if (manualReviewedAgentCandidates < options.minManualReviewedAgentCandidates) {
      failures.push(`manual_reviewed_agent_candidate_count_below_${options.minManualReviewedAgentCandidates}`);
    }
    if (pending.length > options.maxPendingReview) failures.push(`pending_review_above_${options.maxPendingReview}`);
    if (result.g2Rate < options.minG2Rate) failures.push(`g2_rate_below_${options.minG2Rate}`);
    if (topFailure && topFailureRate > options.maxTopFailureRate) {
      failures.push(`top_failure_rate_above_${options.maxTopFailureRate}`);
    }
    if (diagnosticRate > options.maxDiagnosticRate) {
      failures.push(`diagnostic_rate_above_${options.maxDiagnosticRate}`);
    }
    if (excludedRate > options.maxExcludedRate) {
      failures.push(`excluded_rate_above_${options.maxExcludedRate}`);
    }

    const requirements = buildRequirementRows({
      options,
      totalSessions: result.totalSessions,
      agentCandidates,
      manualReviewed,
      manualReviewedAgentCandidates,
      pendingReview: pending.length,
      pendingAgentCandidates: pendingAgentCandidates.length,
      exported: result.exported,
      coreEvalLines: coreEvalArtifact.lineCount ?? 0,
      byDatasetRole: result.byDatasetRole,
      byCollectionSource: result.byCollectionSource,
      g2Rate: result.g2Rate,
      diagnosticRate,
      excludedRate,
      topFailure,
      topFailureRate,
      sampleGap,
    });
    const summary = {
      ok: requirements.every((row) => row.status === 'passed'),
      out: options.out,
      sourceDataDir: options.dataDir,
      runtimeDataDir,
      copiedDataDir: !options.liveDataDir,
      sampleWindow: result.sampleWindow,
      totalSessions: result.totalSessions,
      agentCandidates,
      manualReviewed,
      manualReviewedAgentCandidates,
      pendingReview: pending.length,
      pendingAgentCandidates: pendingAgentCandidates.length,
      exported: result.exported,
      coreEvalLines: coreEvalArtifact.lineCount ?? 0,
      byDatasetRole: result.byDatasetRole,
      byCollectionSource: result.byCollectionSource,
      g2Rate: result.g2Rate,
      diagnosticRate,
      excludedRate,
      topFailure,
      topFailureRate,
      sampleGap,
      nextReviewSessionId: pendingAgentCandidates[0]?.sessionId,
      pendingAgentCandidateSessionIds: pendingAgentCandidates.map((item) => item.sessionId),
      requirements,
      artifacts: [coreEvalArtifact, dossierArtifact, worksheetArtifact],
      failures,
    };

    await mkdir(path.dirname(options.out), { recursive: true });
    await writeFile(
      options.out,
      renderMarkdown({
        generatedAt: result.generatedAt,
        sourceDataDir: options.dataDir,
        runtimeDataDir,
        liveDataDir: options.liveDataDir,
        sampleWindow: result.sampleWindow,
        requirements,
        artifacts: summary.artifacts,
        nextReviewSessionId: summary.nextReviewSessionId,
        pendingAgentCandidateSessionIds: summary.pendingAgentCandidateSessionIds,
        failures,
      }),
      'utf8',
    );

    if (options.json) {
      console.log(JSON.stringify(summary, null, 2));
    } else {
      console.log(`Agent trajectory P3 acceptance: ${summary.ok ? 'passed' : 'action_required'}`);
      console.log(`Acceptance snapshot: ${options.out}`);
      console.log(`Audited sessions: ${summary.totalSessions}`);
      console.log(`Agent candidates: ${summary.agentCandidates}/${options.minAgentCandidates}`);
      console.log(`Manual-reviewed agent candidates: ${summary.manualReviewedAgentCandidates}/${options.minManualReviewedAgentCandidates}`);
      console.log(`Formal exported rows: ${summary.exported}/${options.minExported}`);
      console.log(`core-eval JSONL lines: ${summary.coreEvalLines}`);
      console.log(`Next review session: ${summary.nextReviewSessionId ?? 'none'}`);
      console.log(`Failures: ${failures.length > 0 ? failures.join(', ') : 'none'}`);
    }

    if (!summary.ok) {
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
