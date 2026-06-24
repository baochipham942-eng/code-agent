#!/usr/bin/env npx tsx

import { copyFile, mkdir, mkdtemp, rm, stat, writeFile } from 'fs/promises';
import { homedir, tmpdir } from 'os';
import path from 'path';
import process from 'process';
import { pathToFileURL } from 'url';

import type { AgentTrajectory, AgentTrajectoryDatasetRole } from '../src/shared/contract/agentTrajectory';
import type {
  AgentTrajectoryAuditItem,
  AgentTrajectoryExportResult,
} from '../src/main/evaluation/trajectory/trajectoryExporter';
import type { StructuredReplay } from '../src/shared/contract/evaluation';

interface CliOptions {
  dataDir: string;
  liveDataDir: boolean;
  keepTmp: boolean;
  limit: number;
  since?: number;
  until?: number;
  out: string;
  includeExcludedControls: boolean;
  json: boolean;
}

interface ReviewEvidence {
  item: AgentTrajectoryAuditItem;
  replay: StructuredReplay | null;
  trajectory: AgentTrajectory | null;
  firstUserPrompt: string;
  finalAnswer: string;
  toolChain: string;
  modelSummary: string;
  toolDefinitions: string;
  failedTools: string;
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
    out: readFlagValue(args, '--out') || 'docs/audits/agent-trajectory-review-dossier-latest.md',
    includeExcludedControls: args.includes('--include-excluded-controls'),
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

  const runtimeDataDir = await mkdtemp(path.join(tmpdir(), 'agent-trajectory-review-dossier-'));
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

function pendingReviewItems(
  result: AgentTrajectoryExportResult,
  includeExcludedControls: boolean,
): AgentTrajectoryAuditItem[] {
  return result.audits
    .filter((item) => item.collectionSource !== 'manual_review')
    .filter((item) => includeExcludedControls || isAgentCandidate(item.datasetRole))
    .slice()
    .sort(
      (left, right) =>
        reviewPriorityRank(left) - reviewPriorityRank(right) ||
        (right.startedAt ?? 0) - (left.startedAt ?? 0) ||
        left.sessionId.localeCompare(right.sessionId),
    );
}

function compactText(value: string | undefined, limit = 240): string {
  const text = (value ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return 'none';
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 3)).trimEnd()}...`;
}

function markdownCell(value: unknown): string {
  return compactText(String(value ?? ''), 260)
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, '<br>');
}

function formatIso(timestamp: number | undefined): string {
  if (!timestamp || !Number.isFinite(timestamp)) return 'unknown';
  return new Date(timestamp).toISOString();
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

function formatFailures(failures: string[]): string {
  return failures.length > 0 ? failures.join(', ') : 'none';
}

function firstUserPrompt(replay: StructuredReplay | null): string {
  const block = replay?.turns
    .flatMap((turn) => turn.blocks)
    .find((candidate) => candidate.type === 'user' && candidate.content.trim().length > 0);
  return compactText(block?.content, 500);
}

function summarizeToolChain(trajectory: AgentTrajectory | null): string {
  if (!trajectory) return 'replay unavailable';
  const calls = trajectory.steps
    .filter((step) => step.role === 'tool_call' && step.toolCall)
    .map((step) => {
      const call = step.toolCall!;
      return `${call.category}:${call.name}${call.hasDefinition ? '' : ' (missing schema)'}`;
    });
  return calls.length > 0 ? compactText(calls.join(' -> '), 500) : 'none';
}

function summarizeFailedTools(trajectory: AgentTrajectory | null): string {
  if (!trajectory) return 'replay unavailable';
  const failed = trajectory.steps
    .filter((step) => step.role === 'tool_result' && step.toolResult && !step.toolResult.success)
    .map((step) => step.toolResult!.name);
  return failed.length > 0 ? [...new Set(failed)].join(', ') : 'none';
}

function summarizeModels(trajectory: AgentTrajectory | null): string {
  if (!trajectory) return 'replay unavailable';
  const models = trajectory.summary.models.map((model) => `${model.provider}/${model.model} x${model.count}`);
  return models.length > 0 ? models.join(', ') : 'none';
}

function summarizeToolDefinitions(trajectory: AgentTrajectory | null): string {
  if (!trajectory) return 'replay unavailable';
  const names = trajectory.toolDefinitions.map((tool) => tool.name).sort((left, right) => left.localeCompare(right));
  return names.length > 0 ? names.join(', ') : 'none';
}

function p3Scope(item: AgentTrajectoryAuditItem): 'agent_candidate' | 'excluded_control' {
  return isAgentCandidate(item.datasetRole) ? 'agent_candidate' : 'excluded_control';
}

function buildEvidence(
  item: AgentTrajectoryAuditItem,
  replay: StructuredReplay | null,
  trajectory: AgentTrajectory | null,
): ReviewEvidence {
  return {
    item,
    replay,
    trajectory,
    firstUserPrompt: firstUserPrompt(replay),
    finalAnswer: compactText(trajectory?.summary.finalAnswer, 500),
    toolChain: summarizeToolChain(trajectory),
    modelSummary: summarizeModels(trajectory),
    toolDefinitions: summarizeToolDefinitions(trajectory),
    failedTools: summarizeFailedTools(trajectory),
  };
}

function renderSummaryRows(evidence: ReviewEvidence[]): string {
  if (evidence.length === 0) {
    return '| | | | | | | | | | | |';
  }
  return evidence
    .map((entry, index) => {
      const item = entry.item;
      return [
        index + 1,
        p3Scope(item),
        item.sessionId,
        item.datasetRole,
        item.tier,
        item.taskKind,
        item.collectionSource,
        formatFailures(item.failures),
        entry.toolChain,
        entry.finalAnswer,
        '',
      ]
        .map(markdownCell)
        .join(' | ');
    })
    .map((row) => `| ${row} |`)
    .join('\n');
}

function renderMetricLines(item: AgentTrajectoryAuditItem): string[] {
  const metrics = item.metrics;
  return [
    `- Metrics: turns=${metrics.turnCount}, model_calls=${metrics.modelCallCount}, tool_calls=${metrics.toolCallCount}, tool_results=${metrics.toolResultCount}, tool_definitions=${metrics.toolDefinitionCount}, final_answer=${metrics.finalAnswerPresent ? 'yes' : 'no'}, pending_tool_results=${metrics.pendingToolResultCount}`,
    `- Failures: ${formatFailures(item.failures)}`,
  ];
}

function renderDetail(entry: ReviewEvidence, index: number): string {
  const item = entry.item;
  const replay = entry.replay;
  const trajectory = entry.trajectory;
  const lines = [
    `## ${index + 1}. ${item.sessionId}`,
    '',
    `- P3 scope: ${p3Scope(item)}`,
    `- Current classification: ${item.datasetRole} / ${item.tier} / ${item.taskKind}`,
    `- Collection source: ${item.collectionSource}, intent: ${item.collectionIntent}, version: ${item.datasetVersion}`,
    `- Started at: ${formatIso(item.startedAt)}`,
    `- Data source: ${item.dataSource ?? replay?.dataSource ?? 'unknown'}`,
    `- Trace id: ${replay?.traceIdentity.traceId ?? 'replay unavailable'}`,
    ...renderMetricLines(item),
    `- Replay summary: turns=${replay?.summary.totalTurns ?? 'unknown'}, data_source=${replay?.dataSource ?? 'unknown'}`,
    `- Trajectory summary: duration_ms=${trajectory?.durationMs ?? 'unknown'}, events=${trajectory?.summary.eventCount ?? 'unknown'}`,
    `- Models: ${entry.modelSummary}`,
    `- Tool definitions: ${entry.toolDefinitions}`,
    `- Tool chain: ${entry.toolChain}`,
    `- Failed tools: ${entry.failedTools}`,
    `- First user prompt: ${entry.firstUserPrompt}`,
    `- Final answer preview: ${entry.finalAnswer}`,
    '',
    'Review fields:',
    '',
    '- Final review.datasetRole:',
    '- Final review.taskKind:',
    '- Notes:',
    '',
  ];
  return lines.join('\n');
}

function renderDossier(input: {
  result: AgentTrajectoryExportResult;
  sourceDataDir: string;
  runtimeDataDir: string;
  liveDataDir: boolean;
  includeExcludedControls: boolean;
  evidence: ReviewEvidence[];
}): string {
  const pendingAgentCandidates = input.result.audits.filter(
    (item) => item.collectionSource !== 'manual_review' && isAgentCandidate(item.datasetRole),
  );
  const pendingExcludedControls = input.result.audits.filter(
    (item) => item.collectionSource !== 'manual_review' && item.datasetRole === 'excluded',
  );
  const manualReviewed = input.result.byCollectionSource.manual_review ?? 0;
  const topFailure = input.result.failureCounts[0];
  const sampleWindow = input.result.sampleWindow ? JSON.stringify(input.result.sampleWindow) : 'latest sessions';
  const details = input.evidence.map(renderDetail).join('\n');

  return [
    '# Agent Trajectory Review Dossier',
    '',
    `Generated at: ${new Date(input.result.generatedAt).toISOString()}`,
    '',
    '## Scope',
    '',
    `- Source data dir: \`${input.sourceDataDir}\``,
    `- Runtime data dir: \`${input.runtimeDataDir}\``,
    `- Live DB read: ${input.liveDataDir ? 'yes' : 'no, copied DB'}`,
    `- Sample window: \`${sampleWindow}\``,
    `- Audited sessions: ${input.result.totalSessions}`,
    `- Included review rows: ${input.evidence.length}`,
    `- Pending agent candidates: ${pendingAgentCandidates.length}`,
    `- Pending excluded controls: ${pendingExcludedControls.length}`,
    `- Manual-reviewed rows currently in window: ${manualReviewed}`,
    `- Formal manual_review export rows currently in window: ${input.result.exported}`,
    `- G2 rate: ${formatPercent(input.result.g2Rate)}`,
    `- Top failure: ${topFailure ? `${topFailure.failure} (${topFailure.count})` : 'none'}`,
    '',
    'This dossier is read-only. It does not write collection metadata, does not apply review decisions, and does not replace opening Replay before saving a final role.',
    '',
    '## Summary',
    '',
    '| # | P3 scope | Session | Current role | Tier | Task | Source | Failures | Tool chain | Final answer preview | Notes |',
    '| -: | -------- | ------- | ------------ | ---- | ---- | ------ | -------- | ---------- | -------------------- | ----- |',
    renderSummaryRows(input.evidence),
    '',
    '## Session Evidence',
    '',
    details || 'No pending rows matched the requested scope.',
    '',
  ].join('\n');
}

async function main(): Promise<void> {
  const options = parseOptions();
  const runtimeDataDir = await prepareRuntimeDataDir(options.dataDir, options.liveDataDir);
  process.env.CODE_AGENT_DATA_DIR = runtimeDataDir;

  const { getDatabase } = await import('../src/main/services/core/databaseService');
  const { getTelemetryQueryService } = await import('../src/main/evaluation/telemetryQueryService');
  const { buildAgentTrajectoryFromReplay, exportAgentTrajectories } = await import(
    '../src/main/evaluation/trajectory/trajectoryExporter'
  );

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
    const pending = pendingReviewItems(result, options.includeExcludedControls);
    const evidence: ReviewEvidence[] = [];
    for (const item of pending) {
      const replay = await getTelemetryQueryService().getStructuredReplay(item.sessionId);
      const trajectory = replay ? buildAgentTrajectoryFromReplay(replay) : null;
      evidence.push(buildEvidence(item, replay, trajectory));
    }

    await mkdir(path.dirname(options.out), { recursive: true });
    await writeFile(
      options.out,
      renderDossier({
        result,
        sourceDataDir: options.dataDir,
        runtimeDataDir,
        liveDataDir: options.liveDataDir,
        includeExcludedControls: options.includeExcludedControls,
        evidence,
      }),
      'utf8',
    );

    const summary = {
      out: options.out,
      sourceDataDir: options.dataDir,
      runtimeDataDir,
      copiedDataDir: !options.liveDataDir,
      sampleWindow: result.sampleWindow,
      auditedSessions: result.totalSessions,
      includedRows: evidence.length,
      pendingAgentCandidates: result.audits.filter(
        (item) => item.collectionSource !== 'manual_review' && isAgentCandidate(item.datasetRole),
      ).length,
      pendingExcludedControls: result.audits.filter(
        (item) => item.collectionSource !== 'manual_review' && item.datasetRole === 'excluded',
      ).length,
      manualReviewed: result.byCollectionSource.manual_review ?? 0,
      exported: result.exported,
      sessionIds: evidence.map((entry) => entry.item.sessionId),
    };

    if (options.json) {
      console.log(JSON.stringify(summary, null, 2));
    } else {
      console.log(`Agent trajectory review dossier: ${options.out}`);
      console.log(`Audited sessions: ${summary.auditedSessions}`);
      console.log(`Included review rows: ${summary.includedRows}`);
      console.log(`Pending agent candidates: ${summary.pendingAgentCandidates}`);
      console.log(`Pending excluded controls: ${summary.pendingExcludedControls}`);
      console.log(`Formal exported rows: ${summary.exported}`);
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
