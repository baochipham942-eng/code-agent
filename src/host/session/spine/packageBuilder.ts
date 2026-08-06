import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import type BetterSqlite3 from 'better-sqlite3';
import type { SessionLedger } from '../../../shared/contract/sessionLedger';
import { TelemetryStorage } from '../../telemetry/telemetryStorage';
import { getAppVersion, getLogsPath, getUserDataPath } from '../../platform/appPaths';
import { getDatabase } from '../../services/core/databaseService';
import { SessionRepository } from '../../services/core/repositories/SessionRepository';
import { PermissionDecisionRepository } from '../../services/core/repositories/PermissionDecisionRepository';
import { ToolExecutionEventRepository } from '../../services/core/repositories/ToolExecutionEventRepository';
import { SwarmTraceRepository } from '../../services/core/repositories/SwarmTraceRepository';
import { buildSessionLedger } from '../../services/core/sessionLedgerProjection';
import { readSessionCost, readSwarmRunsForSession } from '../../services/core/sessionLedgerSources';
import { buildDiagnosticBundle, gatherEnvFingerprint, sanitizeDiagnosticBundle } from '../../telemetry/diagnosticBundleService';
import { exportSessionToMarkdown } from '../exportMarkdown';
import { shortSessionIdForFileName } from '../../../shared/utils/id';
import { extractLogWindow, sessionWindowDateKeys } from './logWindowExtractor';
import { sanitizePackageText, sanitizePackageValue, type SessionPackagePrivacyLevel } from './packageSanitizer';
import { projectSessionTranscript, transcriptToJsonl, type TranscriptProjectionResult } from './transcriptProjector';

export interface SessionPackageManifest {
  packageVersion: 2;
  sessionId: string;
  builtAt: number;
  privacyLevel: SessionPackagePrivacyLevel;
  includes: Record<string, boolean>;
  versions: { appVersion: string };
  timeRange: { start: number; end: number };
  stats: { messageCount: number; toolCallCount: number; errorCount: number };
  source: { hadTelemetrySession: boolean };
  files: Array<{ path: string; sha256: string; bytes: number }>;
}

export interface BuildSessionPackageOptions {
  /** CLI passes a readonly better-sqlite3 handle; app defaults to its live handle. */
  db?: BetterSqlite3.Database;
  storage?: TelemetryStorage;
  privacyLevel?: SessionPackagePrivacyLevel;
  builtAt?: number;
  homeDir?: string;
  logDir?: string;
  auditDir?: string;
  ledgerProvider?: (sessionId: string, generatedAt: number) => SessionLedger;
}

export interface SessionPackageResult {
  buffer: Buffer;
  suggestedFileName: string;
  manifest: SessionPackageManifest;
  files: ReadonlyMap<string, Buffer>;
}

function requiredDb(db?: BetterSqlite3.Database): BetterSqlite3.Database {
  const resolved = db ?? getDatabase().getDb();
  if (!resolved) throw new Error('Database is not initialized');
  return resolved;
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function jsonl(rows: unknown[]): string {
  return rows.length ? `${rows.map((row) => JSON.stringify(row)).join('\n')}\n` : '';
}

function tableExists(db: BetterSqlite3.Database, table: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
}

function rowsBySession(db: BetterSqlite3.Database, table: string, sessionId: string, order: string): Array<Record<string, unknown>> {
  if (!tableExists(db, table)) return [];
  return db.prepare(`SELECT * FROM ${table} WHERE session_id = ? ORDER BY ${order}`).all(sessionId) as Array<Record<string, unknown>>;
}

function readAuditWindow(options: {
  auditDir: string;
  sessionId: string;
  start: number;
  end: number;
  privacyLevel: SessionPackagePrivacyLevel;
  homeDir: string;
}): Array<Record<string, unknown>> {
  const output: Array<Record<string, unknown>> = [];
  for (const key of sessionWindowDateKeys(options.start, options.end)) {
    const file = path.join(options.auditDir, `${key}.jsonl`);
    let content: string;
    try { content = fs.readFileSync(file, 'utf8'); } catch { continue; }
    for (const line of content.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line) as Record<string, unknown>;
        const timestamp = Number(row.timestamp);
        if (row.sessionId === options.sessionId && timestamp >= options.start - 300_000 && timestamp <= options.end + 300_000) {
          output.push(row);
        }
      } catch { /* malformed audit lines do not block export */ }
    }
  }
  return sanitizePackageValue(output, options.privacyLevel, options.homeDir);
}

function markdownFor(projection: TranscriptProjectionResult, privacyLevel: SessionPackagePrivacyLevel, homeDir: string): string {
  const result = exportSessionToMarkdown({
    sessionId: projection.session.id,
    startedAt: projection.session.createdAt,
    lastActivityAt: projection.session.updatedAt,
    totalTokens: 0,
    metadata: { title: projection.session.title, workingDirectory: projection.session.workingDirectory },
    messages: projection.messages.map((message) => ({
      id: message.id,
      role: message.role === 'user' || message.role === 'system' ? message.role : 'assistant',
      content: message.content,
      timestamp: message.timestamp,
      metadata: message.metadata as Record<string, unknown> | undefined,
      toolCalls: message.toolCalls,
      toolResults: message.toolResults,
    })),
  }, {
    title: projection.session.title,
    includeMetadata: true,
    includeTimestamps: true,
    guardSensitiveData: true,
  });
  if (!result.success || !result.markdown) return '# Session transcript\n';
  return sanitizePackageText(result.markdown, privacyLevel, homeDir);
}

function projectedLedger(db: BetterSqlite3.Database, sessionId: string, builtAt: number): SessionLedger {
  const sessions = new SessionRepository(db);
  const swarmRuns = readSwarmRunsForSession(db, sessionId);
  const swarm = new SwarmTraceRepository(db);
  return buildSessionLedger(sessionId, {
    messages: sessions.getMessages(sessionId, undefined, undefined, { includeRewound: true }),
    taskEvents: sessions.getSessionTaskEvents(sessionId, { limit: 10_000 }),
    swarmRuns,
    swarmEvents: swarmRuns.flatMap((run) => swarm.getRunDetail(run.id)?.events ?? []),
    decisions: tableExists(db, 'permission_decisions')
      ? new PermissionDecisionRepository(db).getBySession(sessionId, 10_000)
      : [],
    executions: tableExists(db, 'tool_execution_events')
      ? new ToolExecutionEventRepository(db).getBySession(sessionId, 10_000)
      : [],
    cost: readSessionCost(db, sessionId),
  }, builtAt);
}

function readEnvironment(projection: TranscriptProjectionResult): Promise<unknown> {
  return gatherEnvFingerprint(projection.session.workingDirectory || process.cwd());
}

function readTelemetrySummary(bundle: Awaited<ReturnType<typeof buildDiagnosticBundle>>): unknown {
  if (!bundle) return null;
  return {
    session: {
      id: bundle.session.id,
      startTime: bundle.session.startTime,
      endTime: bundle.session.endTime,
      durationMs: bundle.session.durationMs,
      status: bundle.session.status,
      turnCount: bundle.session.turnCount,
      totalInputTokens: bundle.session.totalInputTokens,
      totalOutputTokens: bundle.session.totalOutputTokens,
      estimatedCost: bundle.session.estimatedCost,
      totalToolCalls: bundle.session.totalToolCalls,
      totalErrors: bundle.session.totalErrors,
    },
    turns: bundle.turns.map(({ turn, modelCalls, toolCalls }) => ({
      id: turn.id,
      turnNumber: turn.turnNumber,
      startTime: turn.startTime,
      endTime: turn.endTime,
      durationMs: turn.durationMs,
      totalInputTokens: turn.totalInputTokens,
      totalOutputTokens: turn.totalOutputTokens,
      modelCallCount: modelCalls.length,
      toolCallCount: toolCalls.length,
      errorCount: modelCalls.filter((call) => call.error).length + toolCalls.filter((call) => call.error).length,
    })),
  };
}

function fileName(sessionId: string, builtAt: number): string {
  const stamp = new Date(builtAt).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  return `neo-session-${shortSessionIdForFileName(sessionId)}-${stamp}.zip`;
}

/** Reusable app/CLI entry point: one readonly DB input, one in-memory ZIP output. */
export async function buildSessionPackage(
  sessionId: string,
  options: BuildSessionPackageOptions = {},
): Promise<SessionPackageResult> {
  const db = requiredDb(options.db);
  const builtAt = options.builtAt ?? Date.now();
  const privacyLevel = options.privacyLevel ?? 'shareable';
  const homeDir = options.homeDir ?? os.homedir();
  const appVersion = getAppVersion();
  const projection = projectSessionTranscript(db, sessionId, { privacyLevel, homeDir, appVersion });
  const start = Math.min(projection.session.createdAt, ...projection.messages.map((message) => message.timestamp));
  const end = Math.max(projection.session.updatedAt, ...projection.messages.map((message) => message.timestamp));
  const telemetryStorage = options.storage ?? (options.db ? new TelemetryStorage(db) : undefined);
  const rawBundle = await buildDiagnosticBundle(sessionId, { storage: telemetryStorage });
  const bundle = rawBundle
    ? (privacyLevel === 'shareable' ? sanitizeDiagnosticBundle(rawBundle, { homeDir }) : rawBundle)
    : null;
  const logRows = extractLogWindow({
    logDir: options.logDir ?? getLogsPath(), sessionId, sessionStart: start, sessionEnd: end, privacyLevel, homeDir,
  });
  const auditRows = readAuditWindow({
    auditDir: options.auditDir ?? path.join(getUserDataPath(), 'audit'),
    sessionId, start, end, privacyLevel, homeDir,
  });
  const decisions = sanitizePackageValue(rowsBySession(db, 'permission_decisions', sessionId, 'recorded_at ASC, id ASC'), privacyLevel, homeDir);
  const executions = sanitizePackageValue(rowsBySession(db, 'tool_execution_events', sessionId, 'recorded_at ASC, id ASC'), privacyLevel, homeDir);
  const ledger = sanitizePackageValue(
    options.ledgerProvider?.(sessionId, builtAt) ?? projectedLedger(db, sessionId, builtAt),
    privacyLevel,
    homeDir,
  );
  const environment = sanitizePackageValue(await readEnvironment(projection), privacyLevel, homeDir);

  const files = new Map<string, Buffer>();
  const add = (name: string, content: string): void => { files.set(name, Buffer.from(content, 'utf8')); };
  add('README.txt', [
    'Neo session diagnostics package v2',
    `Session: ${sessionId}`,
    `Privacy: ${privacyLevel}`,
    '',
    'Start with transcript.md for a readable conversation or transcript.jsonl for tooling.',
    'ledger.json, audit.jsonl, decisions.jsonl, executions.jsonl and logs/window.jsonl provide diagnostics.',
    privacyLevel === 'shareable'
      ? 'Shareable mode redacts credential-like strings and replaces the local home path with ~.'
      : 'Full-local mode may contain sensitive prompts, commands, paths and credentials. Do not share it.',
  ].join('\n'));
  add('transcript.jsonl', transcriptToJsonl(projection.lines));
  add('transcript.md', markdownFor(projection, privacyLevel, homeDir));
  add('ledger.json', json(ledger));
  add('audit.jsonl', jsonl(auditRows));
  add('decisions.jsonl', jsonl(decisions));
  add('executions.jsonl', jsonl(executions));
  add('telemetry/summary.json', json(readTelemetrySummary(bundle)));
  if (bundle) add('telemetry/bundle.sanitized.json', json(bundle));
  add('logs/window.jsonl', jsonl(logRows));
  add('environment.json', json(environment));

  const manifest: SessionPackageManifest = {
    packageVersion: 2,
    sessionId,
    builtAt,
    privacyLevel,
    includes: {
      transcript: true,
      ledger: true,
      audit: true,
      decisions: true,
      executions: true,
      logs: true,
      environment: true,
      telemetrySummary: true,
      telemetryBundle: Boolean(bundle),
    },
    versions: { appVersion },
    timeRange: { start, end },
    stats: {
      messageCount: projection.messageCount,
      toolCallCount: projection.toolCallCount,
      errorCount: projection.errorCount,
    },
    source: { hadTelemetrySession: Boolean(rawBundle) },
    files: [...files.entries()].map(([name, content]) => ({
      path: name,
      sha256: createHash('sha256').update(content).digest('hex'),
      bytes: content.byteLength,
    })),
  };
  add('manifest.json', json(manifest));

  const zip = new JSZip();
  for (const [name, content] of files) zip.file(name, content);
  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  return { buffer, suggestedFileName: fileName(sessionId, builtAt), manifest, files };
}

/** Fast CLI path for `neo session export --jsonl`; it never creates a temporary ZIP. */
export function buildSessionTranscriptJsonl(
  sessionId: string,
  options: Pick<BuildSessionPackageOptions, 'db' | 'privacyLevel' | 'homeDir'> = {},
): string {
  const projection = projectSessionTranscript(requiredDb(options.db), sessionId, {
    privacyLevel: options.privacyLevel ?? 'shareable',
    homeDir: options.homeDir,
    appVersion: getAppVersion(),
  });
  return transcriptToJsonl(projection.lines);
}
