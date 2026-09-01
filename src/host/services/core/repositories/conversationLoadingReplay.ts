import type BetterSqlite3 from 'better-sqlite3';

import {
  ConversationBranchError,
  type ConversationMessageSnapshot,
  type ConversationReplay,
  type ConversationReplayMessage,
} from '../../../../shared/contract/conversationBranch';
import {
  canonicalConversationJson,
  conversationSha256,
} from '../database/schemaConversationBranch';
import {
  ConversationBranchLedgerStore,
  foldConversationReplayEvents,
  type ConversationBranchRow,
  type ConversationReplayFoldState,
} from './ConversationBranchLedgerStore';

interface LoadingReplaySnapshotRow {
  branch_id: string;
  through_event_sequence: number;
  through_event_digest: string;
  through_ordinal: number;
  replay_payload_json: string;
  replay_payload_digest: string;
  schema_version: number;
  created_at: number;
}

interface LoadingReplaySnapshotPayload {
  references: ConversationReplayMessage[];
  state: ConversationReplayFoldState;
}

interface LoadingReplayInput {
  db: BetterSqlite3.Database;
  store: ConversationBranchLedgerStore;
  branch: ConversationBranchRow;
  auditReplay: () => ConversationReplay;
}

const SNAPSHOT_SCHEMA_VERSION = 1;

function ensureMessage(message: ConversationMessageSnapshot): void {
  if (
    !message
    || typeof message.id !== 'string'
    || message.id.trim().length === 0
    || !['user', 'assistant', 'system', 'tool'].includes(message.role)
    || typeof message.content !== 'string'
    || typeof message.timestamp !== 'number'
    || !Number.isFinite(message.timestamp)
  ) {
    throw new ConversationBranchError('LEDGER_CORRUPT', 'invalid conversation message snapshot');
  }
}

function parseSnapshotPayload(value: string): LoadingReplaySnapshotPayload | null {
  try {
    const parsed = JSON.parse(value) as Partial<LoadingReplaySnapshotPayload>;
    if (!Array.isArray(parsed.references) || !parsed.state || typeof parsed.state !== 'object') {
      return null;
    }
    const { activeOrdinals, openRewinds } = parsed.state;
    if (
      !Array.isArray(activeOrdinals)
      || activeOrdinals.some((ordinal) => !Number.isInteger(ordinal) || ordinal < 0)
      || !Array.isArray(openRewinds)
      || openRewinds.some((rewind) => (
        !rewind
        || typeof rewind !== 'object'
        || typeof rewind.rewindId !== 'string'
        || !Array.isArray(rewind.hiddenOrdinals)
        || rewind.hiddenOrdinals.some((ordinal) => !Number.isInteger(ordinal) || ordinal < 0)
      ))
    ) {
      return null;
    }
    for (const reference of parsed.references) {
      if (
        !reference
        || typeof reference !== 'object'
        || !Number.isInteger(reference.ordinal)
        || reference.ordinal < 0
        || typeof reference.entryId !== 'string'
        || typeof reference.projectedMessageId !== 'string'
        || typeof reference.sourceSessionId !== 'string'
        || typeof reference.sourceMessageId !== 'string'
        || !reference.message
      ) {
        return null;
      }
      ensureMessage(reference.message);
    }
    const ordinals = new Set(parsed.references.map((reference) => reference.ordinal));
    if (
      activeOrdinals.some((ordinal) => !ordinals.has(ordinal))
      || openRewinds.some((rewind) => rewind.hiddenOrdinals.some((ordinal) => !ordinals.has(ordinal)))
    ) {
      return null;
    }
    return parsed as LoadingReplaySnapshotPayload;
  } catch {
    return null;
  }
}

function readSnapshot(
  db: BetterSqlite3.Database,
  branchId: string,
): LoadingReplaySnapshotRow | undefined {
  return db.prepare(`
    SELECT *
    FROM conversation_branch_replay_snapshots
    WHERE branch_id = ?
    LIMIT 1
  `).get(branchId) as LoadingReplaySnapshotRow | undefined;
}

function validateSnapshot(
  db: BetterSqlite3.Database,
  branch: ConversationBranchRow,
  snapshot: LoadingReplaySnapshotRow,
): LoadingReplaySnapshotPayload | null {
  if (
    snapshot.schema_version !== SNAPSHOT_SCHEMA_VERSION
    || conversationSha256(snapshot.replay_payload_json) !== snapshot.replay_payload_digest
  ) {
    return null;
  }
  const payload = parseSnapshotPayload(snapshot.replay_payload_json);
  if (!payload) return null;

  // ADR-061 D2 step 2: both anchors are queried even when the suffix is empty.
  const anchorEvent = db.prepare(`
    SELECT event_digest
    FROM conversation_branch_events
    WHERE branch_id = ? AND sequence = ?
    LIMIT 1
  `).get(branch.id, snapshot.through_event_sequence) as { event_digest: string } | undefined;
  if (anchorEvent?.event_digest !== snapshot.through_event_digest) return null;

  const anchorReference = db.prepare(`
    SELECT 1 AS found
    FROM conversation_branch_entries
    WHERE branch_id = ? AND ordinal = ?
    LIMIT 1
  `).get(branch.id, snapshot.through_ordinal) as { found: number } | undefined;
  return anchorReference?.found === 1 ? payload : null;
}

function writeSnapshot(
  db: BetterSqlite3.Database,
  branchId: string,
  throughEventSequence: number,
  throughEventDigest: string,
  throughOrdinal: number,
  payload: LoadingReplaySnapshotPayload,
): void {
  const payloadJson = canonicalConversationJson(payload);
  db.prepare(`
    INSERT INTO conversation_branch_replay_snapshots (
      branch_id, through_event_sequence, through_event_digest, through_ordinal,
      replay_payload_json, replay_payload_digest, schema_version, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(branch_id) DO UPDATE SET
      through_event_sequence = excluded.through_event_sequence,
      through_event_digest = excluded.through_event_digest,
      through_ordinal = excluded.through_ordinal,
      replay_payload_json = excluded.replay_payload_json,
      replay_payload_digest = excluded.replay_payload_digest,
      schema_version = excluded.schema_version,
      created_at = excluded.created_at
  `).run(
    branchId,
    throughEventSequence,
    throughEventDigest,
    throughOrdinal,
    payloadJson,
    conversationSha256(payloadJson),
    SNAPSHOT_SCHEMA_VERSION,
    Date.now(),
  );
}

function refreshSnapshot(
  db: BetterSqlite3.Database,
  store: ConversationBranchLedgerStore,
  branch: ConversationBranchRow,
): void {
  const references = store.readReferences(branch.id);
  const events = store.readEvents(branch.id);
  const latestReference = references.at(-1);
  const latestEvent = events.at(-1);
  if (!latestReference || !latestEvent) {
    db.prepare(`DELETE FROM conversation_branch_replay_snapshots WHERE branch_id = ?`).run(branch.id);
    return;
  }
  writeSnapshot(
    db,
    branch.id,
    latestEvent.sequence,
    latestEvent.event_digest,
    latestReference.ordinal,
    {
      references: references.map((reference) => store.referenceToReplayMessage(reference)),
      state: foldConversationReplayEvents(events),
    },
  );
}

function replayFromSnapshotState(
  store: ConversationBranchLedgerStore,
  branch: ConversationBranchRow,
  references: ConversationReplayMessage[],
  state: ConversationReplayFoldState,
  ledgerEventCount: number,
): ConversationReplay {
  const byOrdinal = new Map(references.map((reference) => [reference.ordinal, reference]));
  return {
    lineage: store.toLineage(branch),
    messages: state.activeOrdinals.flatMap((ordinal) => {
      const reference = byOrdinal.get(ordinal);
      return reference ? [reference] : [];
    }),
    openRewindIds: state.openRewinds.map((rewind) => rewind.rewindId),
    ledgerEventCount,
  };
}

/** Production loading replay backed by a disposable, fully validated snapshot cache. */
export function replayConversationBranchForLoad(input: LoadingReplayInput): ConversationReplay {
  const { db, store, branch } = input;
  const snapshot = readSnapshot(db, branch.id);
  if (snapshot) {
    const payload = validateSnapshot(db, branch, snapshot);
    if (payload) {
      const suffixEvents = store.readEventsAfter(branch.id, snapshot.through_event_sequence);
      const suffixConnected = suffixEvents.length === 0
        || suffixEvents[0].previous_event_digest === snapshot.through_event_digest;
      if (suffixConnected) {
        const suffixReferences = store.readReferencesAfter(branch.id, snapshot.through_ordinal);
        const references = [
          ...payload.references,
          ...suffixReferences.map((reference) => store.referenceToReplayMessage(reference)),
        ];
        const state = foldConversationReplayEvents(suffixEvents, {}, payload.state);
        const latestEvent = suffixEvents.at(-1);
        const latestEventSequence = latestEvent?.sequence ?? snapshot.through_event_sequence;
        const latestEventDigest = latestEvent?.event_digest ?? snapshot.through_event_digest;
        const latestOrdinal = suffixReferences.at(-1)?.ordinal ?? snapshot.through_ordinal;
        const replay = replayFromSnapshotState(
          store,
          branch,
          references,
          state,
          latestEventSequence,
        );
        if (suffixEvents.length > 0 || suffixReferences.length > 0) {
          writeSnapshot(
            db,
            branch.id,
            latestEventSequence,
            latestEventDigest,
            latestOrdinal,
            { references, state },
          );
        }
        return replay;
      }
    }
  }

  const auditedReplay = input.auditReplay();
  refreshSnapshot(db, store, branch);
  return auditedReplay;
}
