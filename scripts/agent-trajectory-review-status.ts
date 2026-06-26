#!/usr/bin/env npx tsx

import { copyFile, mkdir, mkdtemp, rm, stat, writeFile } from 'fs/promises';
import { homedir, tmpdir } from 'os';
import path from 'path';
import process from 'process';
import { pathToFileURL } from 'url';

import type { AgentTrajectoryDatasetRole } from '../src/shared/contract/agentTrajectory';
import type { AgentTrajectoryExportResult } from '../src/host/evaluation/trajectory/trajectoryExporter';

interface CliOptions {
  dataDir: string;
  liveDataDir: boolean;
  keepTmp: boolean;
  limit: number;
  since?: number;
  until?: number;
  worksheetOut?: string;
  includeExcludedControls: boolean;
  allowGateFailure: boolean;
  compareAll: boolean;
  json: boolean;
  minSessions: number;
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

interface ReviewStatusThresholds {
  minSessions: number;
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

interface WorksheetRow {
  sessionId: string;
  datasetRole: AgentTrajectoryDatasetRole;
  tier: string;
  taskKind: string;
  collectionSource: string;
  failures: string[];
}

interface SampleGapSnapshot {
  totalSessions: number;
  agentCandidates: number;
  exported: number;
  manualReviewed: number;
  pendingReview: number;
  remainingAgentCandidates: number;
}

interface SampleGapComparison {
  comparedTo: 'all_available';
  currentWindow: SampleGapSnapshot;
  allAvailable: SampleGapSnapshot;
  additionalHistoricalAgentCandidates: number;
  currentWindowNeedsNewAgentCandidates: number;
  allAvailableStillNeedsAgentCandidates: number;
  recommendation: string;
}

interface ReviewStatusSummary {
  ok: boolean;
  sampleWindow?: AgentTrajectoryExportResult['sampleWindow'];
  totalSessions: number;
  agentCandidates: number;
  exported: number;
  byDatasetRole: AgentTrajectoryExportResult['byDatasetRole'];
  byCollectionSource: AgentTrajectoryExportResult['byCollectionSource'];
  manualReviewed: number;
  manualReviewedAgentCandidates: number;
  pendingReview: number;
  pendingAgentCandidateReview: number;
  pendingExcludedControlReview: number;
  g2Rate: number;
  diagnosticRate: number;
  excludedRate: number;
  topFailure: AgentTrajectoryExportResult['failureCounts'][number] | undefined;
  topFailureRate: number;
  failures: string[];
  remaining: {
    agentCandidates: number;
    exported: number;
    manualReviewed: number;
    manualReviewedAgentCandidates: number;
  };
  nextReviewSessionId?: string;
  pendingAgentCandidateSessionIds: string[];
  pendingExcludedControlSessionIds: string[];
}

interface ReviewStatusBuildResult {
  summary: ReviewStatusSummary;
  worksheetRows: WorksheetRow[];
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
    worksheetOut: readFlagValue(args, '--worksheet-out'),
    includeExcludedControls: args.includes('--include-excluded-controls'),
    allowGateFailure: args.includes('--allow-gate-failure'),
    compareAll: args.includes('--compare-all'),
    json: args.includes('--json'),
    minSessions: readNumber(args, '--min-sessions', 20),
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

  const runtimeDataDir = await mkdtemp(path.join(tmpdir(), 'agent-trajectory-review-status-'));
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

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

function countRemaining(current: number, target: number): number {
  return Math.max(0, target - current);
}

function buildReviewStatus(
  result: AgentTrajectoryExportResult,
  thresholds: ReviewStatusThresholds,
  includeExcludedControls: boolean,
): ReviewStatusBuildResult {
  const agentCandidates = result.audits.filter((item) => isAgentCandidate(item.datasetRole));
  const pendingRows = result.audits
    .filter((item) => item.collectionSource !== 'manual_review')
    .slice()
    .sort(
      (left, right) =>
        reviewPriorityRank(left) - reviewPriorityRank(right) ||
        (right.startedAt ?? 0) - (left.startedAt ?? 0) ||
        left.sessionId.localeCompare(right.sessionId),
    );
  const pendingAgentCandidates = pendingRows.filter((item) => isAgentCandidate(item.datasetRole));
  const manualReviewed = result.byCollectionSource.manual_review ?? 0;
  const manualReviewedAgentCandidates = agentCandidates.length - pendingAgentCandidates.length;
  const diagnosticRate =
    result.totalSessions > 0 ? (result.byDatasetRole.diagnostic ?? 0) / result.totalSessions : 0;
  const excludedRate =
    result.totalSessions > 0 ? (result.byDatasetRole.excluded ?? 0) / result.totalSessions : 0;
  const topFailure = result.failureCounts[0];
  const topFailureRate = topFailure && result.totalSessions > 0 ? topFailure.count / result.totalSessions : 0;
  const failures: string[] = [];

  if (result.totalSessions < thresholds.minSessions) failures.push(`session_count_below_${thresholds.minSessions}`);
  if (agentCandidates.length < thresholds.minAgentCandidates) {
    failures.push(`agent_candidate_count_below_${thresholds.minAgentCandidates}`);
  }
  if (result.exported < thresholds.minExported) failures.push(`exported_count_below_${thresholds.minExported}`);
  if (manualReviewed < thresholds.minManualReviewed) {
    failures.push(`manual_reviewed_count_below_${thresholds.minManualReviewed}`);
  }
  if (manualReviewedAgentCandidates < thresholds.minManualReviewedAgentCandidates) {
    failures.push(
      `manual_reviewed_agent_candidate_count_below_${thresholds.minManualReviewedAgentCandidates}`,
    );
  }
  if (pendingRows.length > thresholds.maxPendingReview) {
    failures.push(`pending_review_above_${thresholds.maxPendingReview}`);
  }
  if (result.g2Rate < thresholds.minG2Rate) failures.push(`g2_rate_below_${thresholds.minG2Rate}`);
  if (topFailure && topFailureRate > thresholds.maxTopFailureRate) {
    failures.push(`top_failure_rate_above_${thresholds.maxTopFailureRate}`);
  }
  if (diagnosticRate > thresholds.maxDiagnosticRate) {
    failures.push(`diagnostic_rate_above_${thresholds.maxDiagnosticRate}`);
  }
  if (excludedRate > thresholds.maxExcludedRate) {
    failures.push(`excluded_rate_above_${thresholds.maxExcludedRate}`);
  }

  const pendingAgentCandidateIds = pendingAgentCandidates.map((item) => item.sessionId);
  const pendingExcludedIds = pendingRows.filter((item) => item.datasetRole === 'excluded').map((item) => item.sessionId);
  const worksheetRows = (
    includeExcludedControls ? pendingRows : pendingRows.filter((item) => isAgentCandidate(item.datasetRole))
  ).map((item) => ({
    sessionId: item.sessionId,
    datasetRole: item.datasetRole,
    tier: item.tier,
    taskKind: item.taskKind,
    collectionSource: item.collectionSource,
    failures: item.failures,
  }));

  return {
    summary: {
      ok: failures.length === 0,
      sampleWindow: result.sampleWindow,
      totalSessions: result.totalSessions,
      agentCandidates: agentCandidates.length,
      exported: result.exported,
      byDatasetRole: result.byDatasetRole,
      byCollectionSource: result.byCollectionSource,
      manualReviewed,
      manualReviewedAgentCandidates,
      pendingReview: pendingRows.length,
      pendingAgentCandidateReview: pendingAgentCandidates.length,
      pendingExcludedControlReview: pendingExcludedIds.length,
      g2Rate: result.g2Rate,
      diagnosticRate,
      excludedRate,
      topFailure,
      topFailureRate,
      failures,
      remaining: {
        agentCandidates: countRemaining(agentCandidates.length, thresholds.minAgentCandidates),
        exported: countRemaining(result.exported, thresholds.minExported),
        manualReviewed: countRemaining(manualReviewed, thresholds.minManualReviewed),
        manualReviewedAgentCandidates: countRemaining(
          manualReviewedAgentCandidates,
          thresholds.minManualReviewedAgentCandidates,
        ),
      },
      nextReviewSessionId: pendingAgentCandidateIds[0] ?? pendingExcludedIds[0],
      pendingAgentCandidateSessionIds: pendingAgentCandidateIds,
      pendingExcludedControlSessionIds: pendingExcludedIds,
    },
    worksheetRows,
  };
}

function sampleGapSnapshot(summary: ReviewStatusSummary): SampleGapSnapshot {
  return {
    totalSessions: summary.totalSessions,
    agentCandidates: summary.agentCandidates,
    exported: summary.exported,
    manualReviewed: summary.manualReviewed,
    pendingReview: summary.pendingReview,
    remainingAgentCandidates: summary.remaining.agentCandidates,
  };
}

function buildSampleGapComparison(
  currentWindow: ReviewStatusSummary,
  allAvailable: ReviewStatusSummary,
): SampleGapComparison {
  const additionalHistoricalAgentCandidates = Math.max(
    0,
    allAvailable.agentCandidates - currentWindow.agentCandidates,
  );
  const currentWindowNeedsNewAgentCandidates = currentWindow.remaining.agentCandidates;
  const allAvailableStillNeedsAgentCandidates = allAvailable.remaining.agentCandidates;
  const recommendation =
    currentWindowNeedsNewAgentCandidates > 0
      ? `Collect ${currentWindowNeedsNewAgentCandidates} more fresh non-excluded agent-task sessions for the P3 window. Historical backfill adds ${additionalHistoricalAgentCandidates} candidates but all available data still misses ${allAvailableStillNeedsAgentCandidates}.`
      : 'Current window has enough agent candidates; continue manual review and core_eval promotion.';

  return {
    comparedTo: 'all_available',
    currentWindow: sampleGapSnapshot(currentWindow),
    allAvailable: sampleGapSnapshot(allAvailable),
    additionalHistoricalAgentCandidates,
    currentWindowNeedsNewAgentCandidates,
    allAvailableStillNeedsAgentCandidates,
    recommendation,
  };
}

function markdownCell(value: unknown): string {
  return String(value ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, '<br>');
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

async function writeWorksheet(
  outPath: string,
  input: {
    generatedAt: number;
    sourceDataDir: string;
    sampleWindow?: unknown;
    totalSessions: number;
    agentCandidates: number;
    pendingRows: WorksheetRow[];
    includeExcludedControls: boolean;
  },
): Promise<void> {
  await mkdir(path.dirname(outPath), { recursive: true });
  const sampleWindow = input.sampleWindow ? JSON.stringify(input.sampleWindow) : 'latest sessions';
  const rows = input.pendingRows
    .map((item, index) =>
      [
        index + 1,
        item.datasetRole === 'excluded' ? 'excluded_control' : 'agent_candidate',
        item.sessionId,
        item.datasetRole,
        item.tier,
        item.taskKind,
        item.collectionSource,
        item.failures.length > 0 ? item.failures.join('<br>') : 'none',
        '',
        '',
      ]
        .map(markdownCell)
        .join(' | '),
    )
    .map((row) => `| ${row} |`)
    .join('\n');
  const markdown = [
    '# Agent Trajectory Manual Review Worksheet',
    '',
    `Generated at: ${new Date(input.generatedAt).toISOString()}`,
    '',
    '## Scope',
    '',
    `- Source data dir: \`${input.sourceDataDir}\``,
    `- Sample window: \`${sampleWindow}\``,
    `- Audited sessions: ${input.totalSessions}`,
    `- Pending agent candidates: ${input.agentCandidates}`,
    `- Includes excluded controls: ${input.includeExcludedControls ? 'yes' : 'no'}`,
    '',
    '## Instructions',
    '',
    'Open each session in Replay before filling the final role. Leave undecided rows blank.',
    '',
    'Accepted final roles are `core_eval`, `diagnostic`, and `excluded`. The apply script reads only `Session`, `Final review.datasetRole`, `Final review.taskKind`, and `Notes`.',
    '',
    'Dry-run before live apply:',
    '',
    '```bash',
    `npm run trajectory:apply-review -- --manifest ${outPath} --reviewer human-reviewer`,
    '```',
    '',
    '## Review Items',
    '',
    '| # | P3 scope | Session | Current role | Tier | Task | Source | Failures | Final review.datasetRole | Notes |',
    '| -: | -------- | ------- | ------------ | ---- | ---- | ------ | -------- | ------------------------ | ----- |',
    rows || '| | | | | | | | | | |',
    '',
  ].join('\n');
  await writeFile(outPath, markdown, 'utf8');
}

async function main(): Promise<void> {
  const options = parseOptions();
  const runtimeDataDir = await prepareRuntimeDataDir(options.dataDir, options.liveDataDir);
  process.env.CODE_AGENT_DATA_DIR = runtimeDataDir;

  const { getDatabase } = await import('../src/host/services/core/databaseService');
  const { exportAgentTrajectories } = await import('../src/host/evaluation/trajectory/trajectoryExporter');

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

    const status = buildReviewStatus(result, options, options.includeExcludedControls);
    let sampleGapComparison: SampleGapComparison | undefined;
    if (options.compareAll && (options.since !== undefined || options.until !== undefined)) {
      const allAvailableResult = await exportAgentTrajectories({
        limit: options.limit,
        minTier: 'G2',
        includeRejected: false,
        persistCollectionMetadata: false,
        exportCollectionSource: 'manual_review',
      });
      const allAvailableStatus = buildReviewStatus(
        allAvailableResult,
        options,
        options.includeExcludedControls,
      ).summary;
      sampleGapComparison = buildSampleGapComparison(status.summary, allAvailableStatus);
    }

    if (options.worksheetOut) {
      await writeWorksheet(options.worksheetOut, {
        generatedAt: result.generatedAt,
        sourceDataDir: options.dataDir,
        sampleWindow: result.sampleWindow,
        totalSessions: result.totalSessions,
        agentCandidates: status.summary.pendingAgentCandidateReview,
        pendingRows: status.worksheetRows,
        includeExcludedControls: options.includeExcludedControls,
      });
    }
    const summary = {
      ...status.summary,
      sourceDataDir: options.dataDir,
      runtimeDataDir,
      copiedDataDir: !options.liveDataDir,
      worksheetOut: options.worksheetOut,
      worksheetRows: status.worksheetRows.length,
      sampleGapComparison,
    };

    if (options.json) {
      console.log(JSON.stringify(summary, null, 2));
    } else {
      console.log(`Agent trajectory review status: ${summary.ok ? 'passed' : 'action_required'}`);
      console.log(`Audited sessions: ${summary.totalSessions}`);
      console.log(`Agent candidates: ${summary.agentCandidates}/${options.minAgentCandidates}`);
      console.log(`Exported core_eval rows: ${summary.exported}/${options.minExported}`);
      console.log(
        `Manual reviewed agent candidates: ${summary.manualReviewedAgentCandidates}/${options.minManualReviewedAgentCandidates}`,
      );
      console.log(`Pending review: ${summary.pendingReview}`);
      console.log(`Pending agent candidates: ${summary.pendingAgentCandidateReview}`);
      console.log(`Pending excluded controls: ${summary.pendingExcludedControlReview}`);
      console.log(`G2 rate: ${formatPercent(summary.g2Rate)}`);
      console.log(
        `Top failure: ${
          summary.topFailure
            ? `${summary.topFailure.failure} (${summary.topFailure.count}, ${formatPercent(summary.topFailureRate)})`
            : 'none'
        }`,
      );
      console.log(`Next review session: ${summary.nextReviewSessionId ?? 'none'}`);
      if (summary.worksheetOut) {
        console.log(`Review worksheet: ${summary.worksheetOut} (${summary.worksheetRows} rows)`);
      }
      if (summary.sampleGapComparison) {
        console.log(
          `All-window agent candidates: ${summary.sampleGapComparison.allAvailable.agentCandidates}/${options.minAgentCandidates}`,
        );
        console.log(
          `Additional historical agent candidates outside current window: ${summary.sampleGapComparison.additionalHistoricalAgentCandidates}`,
        );
        console.log(`Fresh-window collection gap: ${summary.sampleGapComparison.currentWindowNeedsNewAgentCandidates}`);
        console.log(`Sample gap recommendation: ${summary.sampleGapComparison.recommendation}`);
      }
      console.log(`Failures: ${summary.failures.length > 0 ? summary.failures.join(', ') : 'none'}`);
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
