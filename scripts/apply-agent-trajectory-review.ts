#!/usr/bin/env npx tsx

import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'fs/promises';
import { homedir, tmpdir } from 'os';
import path from 'path';
import process from 'process';
import { pathToFileURL } from 'url';

import type {
  AgentTrajectoryCollectionMetadataPatch,
  AgentTrajectoryDatasetRole,
  AgentTrajectoryTaskKind,
} from '../src/shared/contract/agentTrajectory';
import {
  evaluateAgentTrajectoryReplay,
  mergeAgentTrajectoryCollectionMetadata,
  resolveAgentTrajectoryCollectionMetadata,
  writeAgentTrajectoryCollectionMetadata,
} from '../src/shared/contract/agentTrajectory';

export interface AgentTrajectoryReviewApplyOptions {
  dataDir: string;
  liveDataDir: boolean;
  keepTmp: boolean;
  backupLiveDb: boolean;
  liveDbBackupDir?: string;
  apply: boolean;
  manifestPath: string;
  reviewer?: string;
  out?: string;
  json: boolean;
}

interface LiveDbBackup {
  dir: string;
  files: string[];
  createdAt: number;
}

export interface AgentTrajectoryReviewDecision {
  sessionId: string;
  datasetRole: AgentTrajectoryDatasetRole;
  taskKind?: AgentTrajectoryTaskKind;
  reviewedBy?: string;
  notes?: string;
}

export interface AgentTrajectoryReviewApplySummary {
  ok: boolean;
  apply: boolean;
  sourceDataDir: string;
  runtimeDataDir: string;
  copiedDataDir: boolean;
  manifestPath: string;
  totalItems: number;
  decisions: number;
  applied: number;
  skipped: number;
  skippedItems: Array<{ sessionId?: string; reason: string }>;
  appliedItems: Array<{
    sessionId: string;
    datasetRole: AgentTrajectoryDatasetRole;
    taskKind?: AgentTrajectoryTaskKind;
    reviewedBy?: string;
    previousSource: string;
    previousDatasetRole: string;
  }>;
  liveDbBackup?: LiveDbBackup;
}

type ReviewManifestItem = Record<string, unknown>;

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

function parseOptions(): AgentTrajectoryReviewApplyOptions {
  const args = process.argv.slice(2);
  const manifestPath = readFlagValue(args, '--manifest') || readFlagValue(args, '--review-manifest');
  if (!manifestPath) {
    throw new Error('Missing --manifest <path>');
  }
  return {
    dataDir: readFlagValue(args, '--data-dir') || defaultDataDir(),
    liveDataDir: args.includes('--live-data-dir'),
    keepTmp: args.includes('--keep-tmp'),
    backupLiveDb: args.includes('--backup-live-db'),
    liveDbBackupDir: readFlagValue(args, '--live-db-backup-dir'),
    apply: args.includes('--apply'),
    manifestPath,
    reviewer: readFlagValue(args, '--reviewer'),
    out: readFlagValue(args, '--out'),
    json: args.includes('--json'),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isDatasetRole(value: unknown): value is AgentTrajectoryDatasetRole {
  return value === 'core_eval' || value === 'diagnostic' || value === 'excluded';
}

function isTaskKind(value: unknown): value is AgentTrajectoryTaskKind {
  return (
    value === 'coding' ||
    value === 'search' ||
    value === 'data_analysis' ||
    value === 'agent_task' ||
    value === 'ordinary_chat' ||
    value === 'other'
  );
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function nestedRecord(item: ReviewManifestItem, key: string): Record<string, unknown> | undefined {
  const value = item[key];
  return isRecord(value) ? value : undefined;
}

function splitMarkdownRow(line: string): string[] {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) return [];
  const cells: string[] = [];
  let current = '';
  let escaping = false;
  for (let index = 1; index < trimmed.length - 1; index++) {
    const char = trimmed[index];
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === '\\') {
      escaping = true;
      continue;
    }
    if (char === '|') {
      cells.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  cells.push(current.trim());
  return cells;
}

function normalizeHeader(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

function normalizeDatasetRoleInput(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (!normalized) return undefined;
  if (normalized === 'core_eval' || normalized === 'diagnostic' || normalized === 'excluded') return normalized;
  return value?.trim();
}

export function parseAgentTrajectoryReviewPacketMarkdown(markdown: string): ReviewManifestItem[] {
  const lines = markdown.split(/\r?\n/);
  const headerIndex = lines.findIndex((line) => {
    const headers = splitMarkdownRow(line).map(normalizeHeader);
    return headers.includes('session') && headers.includes('final review.datasetrole');
  });
  if (headerIndex < 0) return [];

  const headers = splitMarkdownRow(lines[headerIndex]).map(normalizeHeader);
  const sessionIndex = headers.indexOf('session');
  const datasetRoleIndex = headers.indexOf('final review.datasetrole');
  const notesIndex = headers.indexOf('notes');
  const taskKindIndex = headers.indexOf('final review.taskkind');
  const items: ReviewManifestItem[] = [];

  for (const line of lines.slice(headerIndex + 2)) {
    const cells = splitMarkdownRow(line);
    if (cells.length === 0) continue;
    const sessionId = cells[sessionIndex]?.trim();
    if (!sessionId || sessionId === '-') continue;
    const datasetRole = normalizeDatasetRoleInput(cells[datasetRoleIndex]);
    const notes = notesIndex >= 0 ? cells[notesIndex]?.trim() : undefined;
    const taskKind = taskKindIndex >= 0 ? cells[taskKindIndex]?.trim() : undefined;
    items.push({
      sessionId,
      review: {
        datasetRole,
        taskKind: taskKind || undefined,
        notes: notes || undefined,
      },
    });
  }

  return items;
}

export function extractAgentTrajectoryReviewDecision(
  item: ReviewManifestItem,
): AgentTrajectoryReviewDecision | undefined {
  const sessionId = stringValue(item.sessionId);
  if (!sessionId) return undefined;

  const review = nestedRecord(item, 'review') ?? nestedRecord(item, 'reviewDecision') ?? nestedRecord(item, 'decision');
  const rawDatasetRole =
    item.reviewedDatasetRole ??
    item.finalDatasetRole ??
    item.approvedDatasetRole ??
    review?.datasetRole ??
    review?.reviewedDatasetRole;
  if (!isDatasetRole(rawDatasetRole)) return undefined;

  const rawTaskKind = item.reviewedTaskKind ?? review?.taskKind ?? review?.reviewedTaskKind;
  return {
    sessionId,
    datasetRole: rawDatasetRole,
    taskKind: isTaskKind(rawTaskKind) ? rawTaskKind : undefined,
    reviewedBy: stringValue(item.reviewedBy) ?? stringValue(review?.reviewedBy),
    notes: stringValue(item.reviewNotes) ?? stringValue(item.notes) ?? stringValue(review?.notes),
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

  const runtimeDataDir = await mkdtemp(path.join(tmpdir(), 'agent-trajectory-review-apply-'));
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
    backupDir || path.join(sourceDataDir, 'backups', 'agent-trajectory-review-apply', stamp);
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

function readReviewItems(value: unknown): ReviewManifestItem[] {
  if (isRecord(value) && Array.isArray(value.reviewItems)) {
    return value.reviewItems.filter(isRecord);
  }
  if (Array.isArray(value)) {
    return value.filter(isRecord);
  }
  return [];
}

function readReviewItemsFromText(text: string, manifestPath: string): ReviewManifestItem[] {
  const trimmed = text.trimStart();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return readReviewItems(JSON.parse(text) as unknown);
  }
  if (manifestPath.toLowerCase().endsWith('.md') || trimmed.startsWith('# Agent Trajectory Review Packet')) {
    return parseAgentTrajectoryReviewPacketMarkdown(text);
  }
  return readReviewItems(JSON.parse(text) as unknown);
}

async function writeJsonFile(outPath: string, value: unknown): Promise<void> {
  const { mkdir } = await import('fs/promises');
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export async function applyAgentTrajectoryReviewManifest(
  options: AgentTrajectoryReviewApplyOptions,
): Promise<AgentTrajectoryReviewApplySummary> {
  const liveDbBackup = await backupLiveDatabaseIfNeeded(
    options.dataDir,
    options.apply && options.liveDataDir && options.backupLiveDb,
    options.liveDbBackupDir,
  );
  const runtimeDataDir = await prepareRuntimeDataDir(options.dataDir, options.liveDataDir);
  process.env.CODE_AGENT_DATA_DIR = runtimeDataDir;

  const { getDatabase } = await import('../src/host/services/core/databaseService');
  const { getTelemetryQueryService } = await import('../src/host/evaluation/telemetryQueryService');

  const reviewItems = readReviewItemsFromText(await readFile(options.manifestPath, 'utf8'), options.manifestPath);
  const skippedItems: AgentTrajectoryReviewApplySummary['skippedItems'] = [];
  const appliedItems: AgentTrajectoryReviewApplySummary['appliedItems'] = [];
  let decisions = 0;

  try {
    await getDatabase().initialize();
    for (const item of reviewItems) {
      const decision = extractAgentTrajectoryReviewDecision(item);
      if (!decision) {
        skippedItems.push({
          sessionId: stringValue(item.sessionId),
          reason: 'missing_explicit_review_decision',
        });
        continue;
      }
      decisions++;

      const session = getDatabase().getSession(decision.sessionId, { includeDeleted: true });
      if (!session) {
        skippedItems.push({ sessionId: decision.sessionId, reason: 'missing_session' });
        continue;
      }

      const replay = await getTelemetryQueryService().getStructuredReplay(decision.sessionId);
      const quality = evaluateAgentTrajectoryReplay(replay);
      const baseCollection = resolveAgentTrajectoryCollectionMetadata(quality, session.metadata);
      const patch: AgentTrajectoryCollectionMetadataPatch = {
        datasetRole: decision.datasetRole,
        reviewedBy: decision.reviewedBy ?? options.reviewer,
        notes: decision.notes,
      };
      if (decision.taskKind) {
        patch.taskKind = decision.taskKind;
      }
      const collection = mergeAgentTrajectoryCollectionMetadata(baseCollection, patch, {
        source: 'manual_review',
      });

      if (options.apply) {
        getDatabase().updateSession(decision.sessionId, {
          metadata: writeAgentTrajectoryCollectionMetadata(session.metadata, collection),
          updatedAt: session.updatedAt,
        });
      }

      appliedItems.push({
        sessionId: decision.sessionId,
        datasetRole: collection.datasetRole,
        taskKind: collection.taskKind,
        reviewedBy: collection.reviewedBy,
        previousSource: baseCollection.source,
        previousDatasetRole: baseCollection.datasetRole,
      });
    }

    const summary: AgentTrajectoryReviewApplySummary = {
      ok: skippedItems.length === 0,
      apply: options.apply,
      sourceDataDir: options.dataDir,
      runtimeDataDir,
      copiedDataDir: !options.liveDataDir,
      manifestPath: options.manifestPath,
      totalItems: reviewItems.length,
      decisions,
      applied: appliedItems.length,
      skipped: skippedItems.length,
      skippedItems,
      appliedItems,
      liveDbBackup,
    };
    if (options.out) {
      await writeJsonFile(options.out, summary);
    }
    return summary;
  } finally {
    getDatabase().close();
    if (!options.liveDataDir && !options.keepTmp) {
      await rm(runtimeDataDir, { recursive: true, force: true });
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const options = parseOptions();
  applyAgentTrajectoryReviewManifest(options)
    .then((summary) => {
      if (options.json) {
        console.log(JSON.stringify(summary, null, 2));
      } else {
        if (summary.apply) {
          console.log(`Applied ${summary.applied}/${summary.totalItems} trajectory review decisions`);
        } else {
          console.log(`Dry-run ${summary.applied}/${summary.totalItems} trajectory review decisions`);
        }
        if (summary.apply && summary.copiedDataDir) {
          console.log('Applied to copied DB only. Use --live-data-dir --apply to write the live DB.');
        }
        if (summary.apply === false && summary.copiedDataDir === false) {
          console.log('Dry-run only. Add --apply to write changes.');
        }
        if (summary.liveDbBackup) {
          console.log(`Live DB backup: ${summary.liveDbBackup.dir}`);
        }
      }
      if (summary.skipped > 0) {
        process.exitCode = 2;
      }
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}
