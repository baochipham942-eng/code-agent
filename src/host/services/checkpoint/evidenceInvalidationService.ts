import fs from 'node:fs/promises';
import path from 'node:path';
import type BetterSqlite3 from 'better-sqlite3';

import {
  applyEvidenceInvalidation,
  EVIDENCE_INVALIDATION_RECORD_TYPE,
  type EvidenceInvalidationRecord,
} from '../../../shared/contract/evidenceInvalidation';
import { getPath } from '../../platform/appPaths';
import { getBrowserComputerProofLedgerPath } from '../../session/browserComputerProofStore';
import { getCompletionSummaryPath } from '../../session/completionSummaryService';
import { SessionRepository } from '../core/repositories/SessionRepository';

export interface EvidenceInvalidationResult {
  staleRefCount: number;
  updatedRecordCount: number;
}

function updateJsonColumnRows(
  db: BetterSqlite3.Database,
  selectSql: string,
  updateTarget: string | ((value: unknown, rowKey: string | number) => void),
  params: unknown[],
  invalidation: EvidenceInvalidationRecord,
  staleIds: Set<string>,
): number {
  const rows = db.prepare(selectSql).all(...params) as Array<{
    row_key: string | number;
    payload: string | null;
  }>;
  let updated = 0;
  const update = typeof updateTarget === 'string' ? db.prepare(updateTarget) : null;
  const updateCallback = typeof updateTarget === 'function' ? updateTarget : null;
  for (const row of rows) {
    if (!row.payload) continue;
    try {
      const parsed = JSON.parse(row.payload) as unknown;
      const before = staleIds.size;
      const next = applyEvidenceInvalidation(parsed, invalidation, staleIds);
      if (staleIds.size !== before) {
        if (update) {
          update.run(JSON.stringify(next), row.row_key);
        } else {
          updateCallback?.(next, row.row_key);
        }
        updated += 1;
      }
    } catch {
      // Historical malformed JSON stays untouched; valid records still invalidate.
    }
  }
  return updated;
}

async function appendInvalidation(
  filePath: string,
  invalidation: EvidenceInvalidationRecord,
  traceLedger: boolean,
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const value = traceLedger
    ? {
        ts: invalidation.createdAt,
        sessionId: invalidation.sessionId,
        turnIndex: 0,
        type: 'evidence_invalidation',
        data: invalidation,
      }
    : invalidation;
  await fs.appendFile(filePath, `${JSON.stringify(value)}\n`, 'utf-8');
}

export async function invalidateSessionEvidence(
  db: BetterSqlite3.Database,
  sessionId: string,
  changedFilePaths: readonly string[],
  options: { ledgerPaths?: readonly string[] } = {},
): Promise<EvidenceInvalidationResult> {
  const invalidation: EvidenceInvalidationRecord = {
    schemaVersion: 1,
    recordType: EVIDENCE_INVALIDATION_RECORD_TYPE,
    sessionId,
    createdAt: Date.now(),
    changedFilePaths: changedFilePaths.map((filePath) => path.resolve(filePath)),
    invalidateRunEvidence: true,
  };
  const staleIds = new Set<string>();
  const sessions = new SessionRepository(db);
  const updateDatabase = db.transaction(() => {
    let updated = 0;
    updated += updateJsonColumnRows(
      db,
      'SELECT id AS row_key, event_data AS payload FROM session_events WHERE session_id = ?',
      'UPDATE session_events SET event_data = ? WHERE id = ?',
      [sessionId],
      invalidation,
      staleIds,
    );
    updated += updateJsonColumnRows(
      db,
      'SELECT id AS row_key, metadata AS payload FROM messages WHERE session_id = ?',
      (metadata, messageId) => sessions.updateMessage(
        String(messageId),
        { metadata: metadata as Record<string, unknown> },
        sessionId,
      ),
      [sessionId],
      invalidation,
      staleIds,
    );
    updated += updateJsonColumnRows(
      db,
      'SELECT id AS row_key, metadata AS payload FROM sessions WHERE id = ?',
      'UPDATE sessions SET metadata = ?, synced_at = NULL WHERE id = ?',
      [sessionId],
      invalidation,
      staleIds,
    );
    return updated;
  });
  const updatedRecordCount = updateDatabase.immediate();
  const tracePath = path.join(getPath('userData'), 'traces', `${sessionId}.jsonl`);
  const ledgerPaths = options.ledgerPaths ?? [
    tracePath,
    getBrowserComputerProofLedgerPath(),
    getCompletionSummaryPath(),
  ];
  for (const ledgerPath of ledgerPaths) {
    await appendInvalidation(ledgerPath, invalidation, ledgerPath === tracePath);
  }
  return { staleRefCount: staleIds.size, updatedRecordCount };
}
