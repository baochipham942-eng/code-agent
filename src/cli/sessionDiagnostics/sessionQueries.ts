import fs from 'fs';
import path from 'path';
import { buildSessionLedger } from '../../host/services/core/sessionLedgerProjection';
import type { SessionLedger } from '../../shared/contract/sessionLedger';
import { ReadOnlySessionDatabase, type TelemetryTurnBoundary } from './readOnlySessionDb';

interface CorrelatedLine {
  timestamp?: number;
  timestampISO?: string;
  sessionId?: string;
  turnId?: string;
  traceId?: string;
  toolCallId?: string;
  level?: string;
  message?: string;
  context?: string;
  lane?: string;
  success?: boolean;
  error?: string;
  toolName?: string;
}

export interface SessionTimeline extends SessionLedger {
  telemetryTurns: TelemetryTurnBoundary[];
}

export interface FailureDigest {
  sessionId: string;
  turnId?: string;
  happenedAt: number | null;
  errorSummary: string | null;
  lastTools: Array<{ name: string; success: boolean; error?: string }>;
  permissionDenies: number;
  versions: Record<string, string | null>;
  logExcerpt: Array<{
    timestamp: string | number | null;
    level: string;
    lane?: string;
    context?: string;
    message: string;
  }>;
}

export function buildTimeline(
  db: ReadOnlySessionDatabase,
  sessionId: string,
  generatedAt: number,
): SessionTimeline {
  const swarmRuns = db.getSwarmRuns(sessionId);
  const ledger = buildSessionLedger(sessionId, {
    messages: db.getMessages(sessionId),
    taskEvents: db.getTaskEvents(sessionId),
    swarmRuns,
    swarmEvents: db.getSwarmEvents(swarmRuns.map((run) => run.id)),
    decisions: db.getPermissionDecisions(sessionId),
    executions: db.getExecutionEvents(sessionId),
    cost: db.getCost(sessionId),
  }, generatedAt);
  return { ...ledger, telemetryTurns: db.getTelemetryTurns(sessionId) };
}

function readJsonLines(directory: string, suffix: string): CorrelatedLine[] {
  if (!fs.existsSync(directory)) return [];
  const rows: CorrelatedLine[] = [];
  for (const name of fs.readdirSync(directory).filter((file) => file.endsWith(suffix)).sort()) {
    let content = '';
    try {
      content = fs.readFileSync(path.join(directory, name), 'utf8');
    } catch {
      continue;
    }
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const value = JSON.parse(line) as CorrelatedLine;
        if (value && typeof value === 'object') rows.push(value);
      } catch {
        // A single interrupted JSONL line must not hide the rest of the evidence.
      }
    }
  }
  return rows;
}

function lineTime(row: CorrelatedLine): number {
  if (typeof row.timestamp === 'number') return row.timestamp;
  if (typeof row.timestampISO === 'string') return Date.parse(row.timestampISO) || 0;
  if (typeof row.timestamp === 'string') return Date.parse(row.timestamp) || 0;
  return 0;
}

function matches(row: CorrelatedLine, sessionId: string, turnId?: string): boolean {
  if (row.sessionId !== sessionId) return false;
  return !turnId || row.turnId === turnId;
}

function rowError(row: CorrelatedLine): string | null {
  if (typeof row.error === 'string' && row.error.trim()) return row.error.trim();
  if (row.success === false && typeof row.message === 'string') return row.message.trim();
  if (row.level?.toUpperCase() === 'ERROR' && typeof row.message === 'string') return row.message.trim();
  return null;
}

export function buildFailureDigest(options: {
  db: ReadOnlySessionDatabase;
  dataDir: string;
  sessionId: string;
  turnId?: string;
}): FailureDigest {
  const { db, dataDir, sessionId, turnId } = options;
  const telemetryTools = db.getTelemetryTools(sessionId, turnId);
  const telemetryTurns = db.getTelemetryTurns(sessionId)
    .filter((turn) => !turnId || turn.turnId === turnId);
  const audit = readJsonLines(path.join(dataDir, 'audit'), '.jsonl')
    .filter((row) => matches(row, sessionId, turnId));
  const logs = readJsonLines(path.join(dataDir, 'logs'), '.log')
    .filter((row) => matches(row, sessionId, turnId));
  const messages = db.getMessages(sessionId, 2_000)
    .filter((message) => !turnId || message.metadata?.correlation?.turnId === turnId);
  const decisions = db.getPermissionDecisions(sessionId, 2_000);

  const candidates: Array<{ at: number; summary: string }> = [];
  for (const tool of telemetryTools) {
    if (!tool.success && tool.error) candidates.push({ at: tool.timestamp, summary: tool.error });
  }
  for (const row of [...audit, ...logs]) {
    const error = rowError(row);
    if (error) candidates.push({ at: lineTime(row), summary: error });
  }
  for (const message of messages) {
    const agentError = message.metadata?.agentError;
    if (agentError?.rawMessage) candidates.push({ at: message.timestamp, summary: agentError.rawMessage });
    for (const result of message.toolResults ?? []) {
      if (!result.success && result.error) candidates.push({ at: message.timestamp, summary: result.error });
    }
  }
  for (const turn of telemetryTurns) {
    if (['error', 'failed', 'failure'].includes(turn.outcomeStatus.toLowerCase())) {
      candidates.push({ at: turn.endTime, summary: `turn ${turn.turnNumber}: ${turn.outcomeStatus}` });
    }
  }
  candidates.sort((a, b) => b.at - a.at);

  const logExcerpt = logs
    .filter((row) => row.level?.toUpperCase() === 'ERROR' || rowError(row))
    .sort((a, b) => lineTime(b) - lineTime(a))
    .slice(0, 20)
    .map((row) => ({
      timestamp: row.timestampISO ?? row.timestamp ?? null,
      level: String(row.level ?? 'ERROR'),
      ...(row.lane ? { lane: row.lane } : {}),
      ...(row.context ? { context: row.context } : {}),
      message: String(row.message ?? row.error ?? 'unknown error'),
    }));

  return {
    sessionId,
    ...(turnId ? { turnId } : {}),
    happenedAt: candidates[0]?.at ?? null,
    errorSummary: candidates[0]?.summary ?? null,
    lastTools: telemetryTools.slice(0, 10).map((tool) => ({
      name: tool.name, success: tool.success, ...(tool.error ? { error: tool.error } : {}),
    })),
    permissionDenies: decisions.filter((decision) => {
      if (decision.finalOutcome !== 'deny') return false;
      if (!turnId) return true;
      const trace = decision.trace as { turnId?: string } | null;
      return trace?.turnId === turnId;
    }).length,
    versions: db.getVersions(sessionId),
    logExcerpt,
  };
}
