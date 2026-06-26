import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { getUserConfigDir } from '../config/configPaths';
import type { ToolExecutionResult } from '../tools/types';

const LEDGER_FILE = 'browser-computer-proof-ledger.jsonl';
const SCHEMA_VERSION = 1;

export interface BrowserComputerProofRecord {
  schemaVersion: 1;
  id: string;
  sessionId: string;
  toolCallId?: string;
  toolName: string;
  traceId?: string | null;
  createdAt: number;
  status: string;
  summary: string;
  evidenceRefIds: string[];
  targetKind: 'browser' | 'computer' | 'screenshot' | 'unknown';
  proof: unknown;
  card: unknown;
}

export interface PersistBrowserComputerProofInput {
  sessionId?: string;
  toolCallId?: string;
  toolName: string;
  now?: () => number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function targetKindForTool(toolName: string): BrowserComputerProofRecord['targetKind'] {
  if (toolName === 'browser_action') return 'browser';
  if (toolName === 'computer_use') return 'computer';
  if (toolName === 'screenshot') return 'screenshot';
  return 'unknown';
}

export function getBrowserComputerProofLedgerPath(): string {
  return path.join(getUserConfigDir(), 'sessions', LEDGER_FILE);
}

function buildRecordId(parts: {
  sessionId: string;
  toolCallId?: string;
  toolName: string;
  traceId?: string | null;
  summary: string;
  createdAt: number;
}): string {
  const hash = crypto
    .createHash('sha256')
    .update([
      parts.sessionId,
      parts.toolCallId || '',
      parts.toolName,
      parts.traceId || '',
      parts.summary,
      String(parts.createdAt),
    ].join('\0'))
    .digest('hex')
    .slice(0, 12);
  return `bc_proof_${parts.createdAt}_${hash}`;
}

function sanitizePathLikeString(value: string): string {
  if (/^data:/i.test(value) || /base64[,=]/i.test(value)) {
    return '[redacted]';
  }
  return value.replace(
    /(?:\/Users\/[^\s"'`]+|\/private\/tmp\/[^\s"'`]+|\/tmp\/[^\s"'`]+|\/var\/folders\/[^\s"'`]+|\/Volumes\/[^\s"'`]+)(?:\/[^\s"'`]*)*/g,
    (match) => `.../${path.basename(match) || 'path'}`,
  );
}

function sanitizeValue(value: unknown, keyHint = ''): unknown {
  if (typeof value === 'string') {
    if (/password|token|secret|credential|cookie|authorization/i.test(keyHint)) {
      return '[redacted]';
    }
    if (/path|dir|ref|file|image|screenshot|storage/i.test(keyHint)) {
      return sanitizePathLikeString(value);
    }
    return sanitizePathLikeString(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, keyHint));
  }
  if (!isRecord(value)) {
    return value;
  }
  const sanitized: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    sanitized[key] = sanitizeValue(child, key);
  }
  return sanitized;
}

function extractTraceId(metadata: Record<string, unknown>): string | null {
  const direct = stringValue(metadata.traceId);
  if (direct) return direct;
  const trace = isRecord(metadata.workbenchTrace) ? metadata.workbenchTrace : null;
  return stringValue(trace?.id) ?? null;
}

function evidenceRefIdsFromProof(proof: Record<string, unknown>): string[] {
  const refs = Array.isArray(proof.evidenceRefs) ? proof.evidenceRefs : [];
  return refs.flatMap((item) => {
    if (!isRecord(item)) return [];
    const id = stringValue(item.id);
    return id ? [id] : [];
  });
}

export function persistBrowserComputerProofFromResult(
  result: ToolExecutionResult,
  input: PersistBrowserComputerProofInput,
): BrowserComputerProofRecord | null {
  const sessionId = stringValue(input.sessionId);
  if (!sessionId) return null;
  const metadata = result.metadata || {};
  const proof = isRecord(metadata.browserComputerProof) ? metadata.browserComputerProof : null;
  const card = isRecord(metadata.browserComputerEvidenceCard) ? metadata.browserComputerEvidenceCard : null;
  if (!proof && !card) return null;

  const createdAt = input.now?.() ?? Date.now();
  const status = stringValue(card?.status) ?? 'captured';
  const summary = stringValue(card?.summary) ?? 'Browser/Computer proof captured';
  const traceId = extractTraceId(metadata);
  const evidenceRefIds = stringArray(card?.evidenceRefIds);
  const fallbackEvidenceRefIds = proof ? evidenceRefIdsFromProof(proof) : [];
  const record: BrowserComputerProofRecord = {
    schemaVersion: SCHEMA_VERSION,
    id: buildRecordId({
      sessionId,
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      traceId,
      summary,
      createdAt,
    }),
    sessionId,
    ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
    toolName: input.toolName,
    traceId,
    createdAt,
    status,
    summary,
    evidenceRefIds: evidenceRefIds.length > 0 ? evidenceRefIds : fallbackEvidenceRefIds,
    targetKind: targetKindForTool(input.toolName),
    proof: sanitizeValue(proof),
    card: sanitizeValue(card),
  };

  const ledgerPath = getBrowserComputerProofLedgerPath();
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  fs.appendFileSync(ledgerPath, `${JSON.stringify(record)}\n`, 'utf-8');
  return record;
}

export function readBrowserComputerProofRecordsBySession(
  sessionId: string,
  limit = 100,
): BrowserComputerProofRecord[] {
  const ledgerPath = getBrowserComputerProofLedgerPath();
  if (!sessionId || limit <= 0 || !fs.existsSync(ledgerPath)) return [];
  const lines = fs.readFileSync(ledgerPath, 'utf-8').split('\n').filter(Boolean);
  const records: BrowserComputerProofRecord[] = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as BrowserComputerProofRecord;
      if (parsed?.schemaVersion === SCHEMA_VERSION && parsed.sessionId === sessionId) {
        records.push(parsed);
      }
    } catch {
      // Ignore malformed historical lines; the ledger is append-only.
    }
  }
  return records.slice(-limit);
}
