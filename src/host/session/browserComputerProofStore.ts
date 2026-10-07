import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { getUserConfigDir } from '../config/configPaths';
import type { ToolExecutionResult } from '../tools/types';
import {
  isEvidenceInvalidationRecord,
  markDurableRecordInvalidated,
} from '../../shared/contract/evidenceInvalidation';
import { PROOF_LEDGER } from '@shared/constants';

const LEDGER_FILE = 'browser-computer-proof-ledger.jsonl';
const SCHEMA_VERSION = 1;
const CANARY_PATTERN = /surface(?:[_-](?:secret|redaction))?[_-]canary[a-z0-9_-]*/gi;

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
  /** V1 semantic card/scope are additive; legacy proof/card readers remain compatible. */
  surfaceEvidenceCard?: unknown;
  surfaceScope?: unknown;
  /** Projection of an append-only turn-checkout invalidation record. */
  evidenceInvalidatedAt?: number;
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

/** Highest rotated suffix: KEPT_SHARDS total = active file plus suffixes 1..MAX_ROTATED_SUFFIX. */
const MAX_ROTATED_SUFFIX = PROOF_LEDGER.KEPT_SHARDS - 1;

function rotatedShardPath(activePath: string, suffix: number): string {
  return `${activePath}.${suffix}`;
}

/** All shard paths in time order, oldest (highest suffix) first and the active file last. */
function listProofLedgerShardPaths(activePath: string): string[] {
  const shards: string[] = [];
  for (let suffix = MAX_ROTATED_SUFFIX; suffix >= 1; suffix -= 1) {
    shards.push(rotatedShardPath(activePath, suffix));
  }
  shards.push(activePath);
  return shards;
}

/**
 * Rotation-aware append for the proof ledger: keeps the append-only file bounded
 * (FB-307). Before appending, if the active shard plus the new line would exceed
 * MAX_SHARD_BYTES, the shards are rotated (`.jsonl` -> `.jsonl.1`, `.1` -> `.2`, ...)
 * and shards beyond KEPT_SHARDS are deleted, then the line lands in a fresh active
 * file. Every step is synchronous so a single process cannot interleave a rotation
 * with a partial line: a line is never split across shards and never written to a
 * file that is about to be deleted.
 */
export function appendBrowserComputerProofLedgerLine(line: string): void {
  const ledgerPath = getBrowserComputerProofLedgerPath();
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  const lineBytes = Buffer.byteLength(line, 'utf-8');
  const activeBytes = fs.existsSync(ledgerPath) ? fs.statSync(ledgerPath).size : 0;
  if (activeBytes > 0 && activeBytes + lineBytes > PROOF_LEDGER.MAX_SHARD_BYTES) {
    fs.rmSync(rotatedShardPath(ledgerPath, MAX_ROTATED_SUFFIX), { force: true });
    for (let suffix = MAX_ROTATED_SUFFIX - 1; suffix >= 1; suffix -= 1) {
      const from = rotatedShardPath(ledgerPath, suffix);
      if (fs.existsSync(from)) {
        fs.renameSync(from, rotatedShardPath(ledgerPath, suffix + 1));
      }
    }
    fs.renameSync(ledgerPath, rotatedShardPath(ledgerPath, 1));
  }
  fs.appendFileSync(ledgerPath, line, 'utf-8');
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
  return value.replace(CANARY_PATTERN, '[redacted-canary]').replace(
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
  const surfaceCard = isRecord(metadata.surfaceEvidenceCardV1) ? metadata.surfaceEvidenceCardV1 : null;
  const surfaceScope = isRecord(metadata.surfaceProofScopeV1) ? metadata.surfaceProofScopeV1 : null;
  if (!proof && !card && !surfaceCard) return null;

  const createdAt = input.now?.() ?? Date.now();
  const inspection = isRecord(surfaceCard?.inspection) ? surfaceCard.inspection : null;
  const surfaceStatus = stringValue(inspection?.verificationState);
  const status = surfaceStatus && surfaceStatus !== 'not_requested'
    ? surfaceStatus
    : stringValue(card?.status)
    ?? surfaceStatus
    ?? 'captured';
  const summary = sanitizePathLikeString(stringValue(surfaceCard?.summary)
    ?? stringValue(card?.summary)
    ?? 'Browser/Computer proof captured');
  const traceId = extractTraceId(metadata);
  const evidenceRefIds = stringArray(card?.evidenceRefIds);
  const fallbackEvidenceRefIds = proof ? evidenceRefIdsFromProof(proof) : [];
  const surfaceEvidenceId = stringValue(surfaceCard?.evidenceId);
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
    evidenceRefIds: (evidenceRefIds.length > 0
      ? evidenceRefIds
      : fallbackEvidenceRefIds.length > 0
        ? fallbackEvidenceRefIds
        : surfaceEvidenceId ? [surfaceEvidenceId] : [])
      .map(sanitizePathLikeString),
    targetKind: targetKindForTool(input.toolName),
    proof: sanitizeValue(proof),
    card: sanitizeValue(card),
    ...(surfaceCard ? { surfaceEvidenceCard: sanitizeValue(surfaceCard) } : {}),
    ...(surfaceScope ? { surfaceScope: sanitizeValue(surfaceScope) } : {}),
  };

  appendBrowserComputerProofLedgerLine(`${JSON.stringify(record)}\n`);
  return record;
}

export function readBrowserComputerProofRecordsBySession(
  sessionId: string,
  limit = 100,
): BrowserComputerProofRecord[] {
  const ledgerPath = getBrowserComputerProofLedgerPath();
  if (!sessionId || limit <= 0) return [];
  // Shards are read oldest to newest so invalidation records keep landing after
  // the records they invalidate, regardless of which shard either lives in.
  // Missing shards are skipped; malformed lines are still ignored below.
  const lines: string[] = [];
  for (const shardPath of listProofLedgerShardPaths(ledgerPath)) {
    if (!fs.existsSync(shardPath)) continue;
    lines.push(...fs.readFileSync(shardPath, 'utf-8').split('\n').filter(Boolean));
  }
  const records: BrowserComputerProofRecord[] = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as unknown;
      if (isEvidenceInvalidationRecord(parsed)) {
        if (parsed.sessionId === sessionId) {
          for (let index = 0; index < records.length; index += 1) {
            records[index] = markDurableRecordInvalidated(records[index], parsed);
          }
        }
      } else if (
        isRecord(parsed)
        && parsed.schemaVersion === SCHEMA_VERSION
        && parsed.sessionId === sessionId
      ) {
        records.push(parsed as unknown as BrowserComputerProofRecord);
      }
    } catch {
      // Ignore malformed historical lines; the ledger is append-only.
    }
  }
  return records.slice(-limit);
}
