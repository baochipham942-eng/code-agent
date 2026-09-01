import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import Database from 'better-sqlite3';

import {
  canonicalConversationJson,
  canonicalConversationMessagePayload,
} from '../../src/host/services/core/database/schemaConversationBranch';
import { sanitizeConversationMessageSnapshot } from '../../src/host/services/core/conversationMessageSnapshot';
import { ConversationBranchRepository } from '../../src/host/services/core/repositories/ConversationBranchRepository';
import { ConversationBranchLedgerStore } from '../../src/host/services/core/repositories/ConversationBranchLedgerStore';
import { rowToMessage } from '../../src/host/services/core/repositories/sessionRepositoryParsers';
import type { Message } from '../../src/shared/contract';
import type { ConversationMessageSnapshot } from '../../src/shared/contract/conversationBranch';

type SQLiteRow = Record<string, unknown>;

export const N_READFLIP_ORDER_REPAIR_SESSION_IDS = [
  'session_1785507608383_a94592bc',
  'session_1785817007068_bb5753c3',
  'test-1787703537221',
  'test-1787707900469',
  'test-1787712580100',
  'test-1787714186368',
  'test-1787714198780',
  'test-1787715240622',
] as const;

interface SessionBoundaryRow {
  id: string;
  user_id: string | null;
  project_id: string | null;
}

interface RepairTargetReport {
  sessionId: string;
  beforeIssueCount: number;
  beforeIssueDigest: string;
  beforeEventSequence: number;
  afterEventSequence: number;
  replacementEventId: string | null;
  replacementMessageCount: number;
  changed: boolean;
}

export interface ProjectionOrderRepairReport {
  mode: 'n-readflip-projection-order-repair';
  applied: boolean;
  sessionCount: number;
  targetCount: number;
  repairedCount: number;
  alreadyHealthyCount: number;
  changedSessionCount: number;
  unchangedNonTargetSessionCount: number;
  unexpectedChangedSessions: string[];
  targets: RepairTargetReport[];
}

function digest(value: unknown): string {
  return createHash('sha256').update(canonicalConversationJson(value)).digest('hex');
}

function canonicalMessage(message: ConversationMessageSnapshot | Message): string {
  return canonicalConversationJson({
    id: message.id,
    payload: canonicalConversationMessagePayload(message as unknown as Record<string, unknown>),
  });
}

function readRows(
  db: InstanceType<typeof Database>,
  sql: string,
  ...params: unknown[]
): SQLiteRow[] {
  return db.prepare(sql).all(...params) as SQLiteRow[];
}

function sessionFingerprint(db: InstanceType<typeof Database>, sessionId: string): string {
  const branches = readRows(db, `
    SELECT * FROM conversation_branches WHERE session_id = ? ORDER BY id ASC
  `, sessionId);
  const branchIds = branches.map((branch) => String(branch.id));
  const placeholders = branchIds.map(() => '?').join(', ');
  const branchRows = (table: string, orderBy: string): SQLiteRow[] => (
    branchIds.length === 0
      ? []
      : readRows(db, `SELECT * FROM ${table} WHERE branch_id IN (${placeholders}) ORDER BY ${orderBy}`, ...branchIds)
  );
  return digest({
    session: readRows(db, 'SELECT * FROM sessions WHERE id = ?', sessionId),
    messages: readRows(db, `
      SELECT rowid AS __rowid, * FROM messages WHERE session_id = ? ORDER BY rowid ASC
    `, sessionId),
    branches,
    entries: branchRows('conversation_branch_entries', 'branch_id ASC, ordinal ASC'),
    events: branchRows('conversation_branch_events', 'branch_id ASC, sequence ASC'),
    snapshots: branchRows('conversation_branch_replay_snapshots', 'branch_id ASC'),
  });
}

function latestEventSequence(db: InstanceType<typeof Database>, sessionId: string): number {
  const row = db.prepare(`
    SELECT COALESCE(MAX(event.sequence), 0) AS sequence
    FROM conversation_branches branch
    LEFT JOIN conversation_branch_events event ON event.branch_id = branch.id
    WHERE branch.session_id = ?
  `).get(sessionId) as { sequence: number };
  return Number(row.sequence);
}

function replacementMessages(
  db: InstanceType<typeof Database>,
  store: ConversationBranchLedgerStore,
  session: SessionBoundaryRow,
): ConversationMessageSnapshot[] {
  const branch = store.readBranchBySession(session.id);
  if (!branch) throw new Error(`Missing immutable branch for ${session.id}`);
  const replay = store.replayFromRows(
    branch,
    store.readReferences(branch.id),
    store.readEvents(branch.id),
  );
  const replayById = new Map(replay.messages.map((entry) => [
    entry.projectedMessageId,
    entry.message as ConversationMessageSnapshot,
  ]));
  const projection = readRows(db, `
    SELECT rowid AS __rowid, *
    FROM messages
    WHERE session_id = ? AND COALESCE(visibility, 'active') = 'active'
    ORDER BY timestamp ASC, rowid ASC
  `, session.id).map((row) => sanitizeConversationMessageSnapshot(rowToMessage(row)));
  if (projection.length !== replay.messages.length || replayById.size !== replay.messages.length) {
    throw new Error(`Target ${session.id} does not have a one-to-one message set`);
  }
  return projection.map((projected) => {
    const authoritative = replayById.get(projected.id);
    if (!authoritative || canonicalMessage(authoritative) !== canonicalMessage(projected)) {
      throw new Error(`Target ${session.id} has a non-order payload difference at ${projected.id}`);
    }
    return authoritative;
  });
}

function requireOrderOnlyFindings(
  ledger: ConversationBranchRepository,
  session: SessionBoundaryRow,
): ReturnType<ConversationBranchRepository['auditLineage']> {
  const audit = ledger.auditLineage(session.id, {
    ownerUserId: session.user_id,
    projectId: session.project_id,
  });
  if (audit.issues.some((issue) => issue.code !== 'PROJECTION_ALIAS_ORDER_MISMATCH')) {
    throw new Error(
      `Target ${session.id} has non-order findings: ${audit.issues.map((issue) => issue.code).join(', ')}`,
    );
  }
  return audit;
}

export function repairProjectionOrderMismatches(
  db: InstanceType<typeof Database>,
  options: { apply: boolean; targetSessionIds?: readonly string[] },
): ProjectionOrderRepairReport {
  const targetIds = [...(options.targetSessionIds ?? N_READFLIP_ORDER_REPAIR_SESSION_IDS)];
  if (new Set(targetIds).size !== targetIds.length) throw new Error('Duplicate repair target session IDs');
  const targetSet = new Set(targetIds);
  const sessions = db.prepare(`
    SELECT session.id, session.user_id, session.project_id
    FROM sessions session
    JOIN conversation_branches branch ON branch.session_id = session.id
    WHERE COALESCE(session.is_deleted, 0) = 0
    ORDER BY session.id ASC
  `).all() as SessionBoundaryRow[];
  const sessionsById = new Map(sessions.map((session) => [session.id, session]));
  const missingTargets = targetIds.filter((sessionId) => !sessionsById.has(sessionId));
  if (missingTargets.length > 0) throw new Error(`Missing repair targets: ${missingTargets.join(', ')}`);

  const ledger = new ConversationBranchRepository(db);
  const store = new ConversationBranchLedgerStore(db);
  for (const session of sessions) {
    const audit = ledger.auditLineage(session.id, {
      ownerUserId: session.user_id,
      projectId: session.project_id,
    });
    if (audit.issues.length > 0 && !targetSet.has(session.id)) {
      throw new Error(
        `Unexpected unhealthy non-target ${session.id}: ${audit.issues.map((issue) => issue.code).join(', ')}`,
      );
    }
  }

  const fingerprintsBefore = new Map(sessions.map((session) => [
    session.id,
    sessionFingerprint(db, session.id),
  ]));
  const targets: RepairTargetReport[] = [];
  const run = db.transaction((): string[] => {
    for (const sessionId of targetIds) {
      const session = sessionsById.get(sessionId)!;
      const audit = requireOrderOnlyFindings(ledger, session);
      const beforeEventSequence = latestEventSequence(db, sessionId);
      if (audit.issues.length === 0) {
        targets.push({
          sessionId,
          beforeIssueCount: 0,
          beforeIssueDigest: audit.issueDigest,
          beforeEventSequence,
          afterEventSequence: beforeEventSequence,
          replacementEventId: null,
          replacementMessageCount: 0,
          changed: false,
        });
        continue;
      }
      const messages = replacementMessages(db, store, session);
      const messageDigest = digest(messages.map(canonicalMessage));
      const idempotencyKey = `n-readflip-order-repair:${messageDigest}`;
      if (options.apply) {
        ledger.recordProjectionReplacement({
          sessionId,
          boundary: { ownerUserId: session.user_id, projectId: session.project_id },
          messages,
          idempotencyKey,
          reason: 'N-READFLIP one-time chronological reconciliation from immutable replay payloads',
          createdAt: Date.now(),
        });
      }
      const afterEventSequence = latestEventSequence(db, sessionId);
      const replacementEvent = options.apply
        ? db.prepare(`
            SELECT id FROM conversation_branch_events
            WHERE branch_id = ? AND idempotency_key = ?
          `).get(audit.branch.branchId, idempotencyKey) as { id: string } | undefined
        : undefined;
      targets.push({
        sessionId,
        beforeIssueCount: audit.issues.length,
        beforeIssueDigest: audit.issueDigest,
        beforeEventSequence,
        afterEventSequence,
        replacementEventId: replacementEvent?.id ?? null,
        replacementMessageCount: messages.length,
        changed: options.apply,
      });
    }
    if (options.apply) {
      for (const sessionId of targetIds) {
        const session = sessionsById.get(sessionId)!;
        const audit = ledger.auditLineage(sessionId, {
          ownerUserId: session.user_id,
          projectId: session.project_id,
        });
        if (audit.status !== 'healthy' || audit.issues.length > 0) {
          throw new Error(`Repair did not make ${sessionId} healthy`);
        }
      }
    }
    const changed = sessions
      .filter((session) => fingerprintsBefore.get(session.id) !== sessionFingerprint(db, session.id))
      .map((session) => session.id);
    const changedOutsideTargets = changed.filter((sessionId) => !targetSet.has(sessionId));
    if (changedOutsideTargets.length > 0) {
      throw new Error(`Repair changed non-target sessions: ${changedOutsideTargets.join(', ')}`);
    }
    return changed;
  });
  const changedSessions = run();
  const unexpectedChangedSessions = changedSessions.filter((sessionId) => !targetSet.has(sessionId));
  const repairedCount = targets.filter((target) => target.changed).length;
  return {
    mode: 'n-readflip-projection-order-repair',
    applied: options.apply,
    sessionCount: sessions.length,
    targetCount: targetIds.length,
    repairedCount,
    alreadyHealthyCount: targets.length - repairedCount,
    changedSessionCount: changedSessions.length,
    unchangedNonTargetSessionCount: sessions.length - targetIds.length,
    unexpectedChangedSessions,
    targets,
  };
}

function parseCli(argv: string[]): { dbPath: string; apply: boolean } {
  const dbIndex = argv.indexOf('--db');
  const dbValue = dbIndex >= 0 ? argv[dbIndex + 1] : undefined;
  if (!dbValue || dbValue.startsWith('--')) throw new Error('--db PATH is required');
  const unknown = argv.filter((arg, index) => (
    arg !== '--apply' && arg !== '--db' && index !== dbIndex + 1
  ));
  if (unknown.length > 0) throw new Error(`Unknown arguments: ${unknown.join(', ')}`);
  const dbPath = path.resolve(dbValue);
  if (!fs.existsSync(dbPath)) throw new Error(`Database does not exist: ${dbPath}`);
  return { dbPath, apply: argv.includes('--apply') };
}

function main(): void {
  const options = parseCli(process.argv.slice(2));
  const db = new Database(options.dbPath, {
    readonly: !options.apply,
    fileMustExist: true,
  });
  try {
    const report = repairProjectionOrderMismatches(db, { apply: options.apply });
    process.stdout.write(`${JSON.stringify({ ...report, dbPath: options.dbPath }, null, 2)}\n`);
  } finally {
    db.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
