import { createHash } from 'node:crypto';
import type BetterSqlite3 from 'better-sqlite3';
import type { ConversationLineageIssue } from '../../../../shared/contract/conversationBranch';
import { sanitizeConversationMessageSnapshot } from '../conversationMessageSnapshot';
import { rowToMessage } from '../repositories/sessionRepositoryParsers';

type SQLiteRow = Record<string, unknown>;

export const CONVERSATION_BRANCH_SCHEMA_VERSION = 1;

export function conversationSha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalizeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeValue);
  if (!value || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => [key, canonicalizeValue(record[key])]),
  );
}

export function canonicalConversationJson(value: unknown): string {
  return JSON.stringify(canonicalizeValue(value));
}

export function canonicalConversationMessagePayload(
  message: Record<string, unknown>,
): Record<string, unknown> {
  const {
    id: _id,
    session_id: _sessionId,
    sessionId: _camelSessionId,
    visibility: _visibility,
    hidden_by_rewind_id: _hiddenByRewindId,
    hiddenByRewindId: _camelHiddenByRewindId,
    hidden_at: _hiddenAt,
    hiddenAt: _camelHiddenAt,
    synced_at: _syncedAt,
    syncedAt: _camelSyncedAt,
    __rowid: _rowId,
    ...payload
  } = message;

  const keyAliases: Record<string, string> = {
    tool_calls: 'toolCalls',
    tool_results: 'toolResults',
    content_parts: 'contentParts',
    is_meta: 'isMeta',
    effort_level: 'effortLevel',
  };
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (value === null || value === undefined) continue;
    normalized[keyAliases[key] ?? key] = parseLegacyJsonColumn(key, value);
  }
  return canonicalizeValue(normalized) as Record<string, unknown>;
}

function parseLegacyJsonColumn(key: string, value: unknown): unknown {
  if (
    typeof value !== 'string'
    || ![
      'tool_calls',
      'tool_results',
      'attachments',
      'content_parts',
      'metadata',
      'compaction',
    ].includes(key)
  ) {
    return value;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

export function conversationBranchId(sessionId: string): string {
  return `cbranch_${conversationSha256(sessionId).slice(0, 32)}`;
}

export function conversationEntryId(input: {
  ownerUserId: string | null;
  projectId: string | null;
  sourceSessionId: string;
  sourceMessageId: string;
  payloadDigest: string;
}): string {
  return `centry_${conversationSha256(canonicalConversationJson(input)).slice(0, 32)}`;
}

export function conversationEventDigest(input: {
  id: string;
  branchId: string;
  sequence: number;
  eventType: string;
  payloadDigest: string;
  previousEventDigest: string | null;
  createdAt: number;
}): string {
  return conversationSha256(canonicalConversationJson(input));
}

export function conversationLineageIssueDigest(issues: ConversationLineageIssue[]): string {
  return conversationSha256(canonicalConversationJson(
    issues.map((issue) => ({
      code: issue.code,
      detail: issue.detail,
      branchId: issue.branchId,
      ordinal: issue.ordinal ?? null,
      eventId: issue.eventId ?? null,
      entryId: issue.entryId ?? null,
    })),
  ));
}

function tableExists(db: BetterSqlite3.Database, name: string): boolean {
  return Boolean(db.prepare(`
    SELECT 1
    FROM sqlite_master
    WHERE type = 'table' AND name = ?
    LIMIT 1
  `).get(name));
}

function tableColumns(db: BetterSqlite3.Database, tableName: string): Set<string> {
  if (!tableExists(db, tableName)) return new Set();
  return new Set(
    (db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>)
      .map((column) => column.name),
  );
}

function readNullableString(row: SQLiteRow, key: string): string | null {
  const value = row[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function insertEvent(
  db: BetterSqlite3.Database,
  input: {
    id: string;
    branchId: string;
    eventType: string;
    idempotencyKey: string;
    actorUserId: string | null;
    payload: Record<string, unknown>;
    createdAt: number;
  },
): void {
  const existing = db.prepare(`
    SELECT id
    FROM conversation_branch_events
    WHERE branch_id = ? AND idempotency_key = ?
  `).get(input.branchId, input.idempotencyKey);
  if (existing) return;

  const prior = db.prepare(`
    SELECT sequence, event_digest
    FROM conversation_branch_events
    WHERE branch_id = ?
    ORDER BY sequence DESC
    LIMIT 1
  `).get(input.branchId) as { sequence: number; event_digest: string } | undefined;
  const sequence = (prior?.sequence ?? 0) + 1;
  const previousEventDigest = prior?.event_digest ?? null;
  const payloadJson = canonicalConversationJson(input.payload);
  const payloadDigest = conversationSha256(payloadJson);
  const eventDigest = conversationEventDigest({
    id: input.id,
    branchId: input.branchId,
    sequence,
    eventType: input.eventType,
    payloadDigest,
    previousEventDigest,
    createdAt: input.createdAt,
  });
  db.prepare(`
    INSERT INTO conversation_branch_events (
      id, branch_id, sequence, event_type, idempotency_key, actor_user_id,
      payload_json, payload_digest, previous_event_digest, event_digest, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.id,
    input.branchId,
    sequence,
    input.eventType,
    input.idempotencyKey,
    input.actorUserId,
    payloadJson,
    payloadDigest,
    previousEventDigest,
    eventDigest,
    input.createdAt,
  );
}

function legacyMessageRows(db: BetterSqlite3.Database, sessionId: string): SQLiteRow[] {
  return db.prepare(`
    SELECT rowid AS __rowid, *
    FROM messages
    WHERE session_id = ?
    ORDER BY timestamp ASC, rowid ASC
  `).all(sessionId) as SQLiteRow[];
}

interface LegacyForkValidation {
  fork: SQLiteRow;
  mappings: SQLiteRow[];
  issues: Array<{
    code:
      | 'LEGACY_FORK_MAPPING_MISSING'
      | 'LEGACY_FORK_MAPPING_GAP'
      | 'LEGACY_FORK_MAPPING_NOT_CLOSED'
      | 'LEGACY_FORK_ANCHOR_MISMATCH'
      | 'LEGACY_FORK_PAYLOAD_MISMATCH';
    detail: string;
    ordinal?: number;
  }>;
}

function validateLegacyFork(
  db: BetterSqlite3.Database,
  fork: SQLiteRow,
  mappings: SQLiteRow[],
  sessionsById: Map<string, SQLiteRow>,
): LegacyForkValidation {
  const forkId = String(fork.id);
  const sourceSessionId = String(fork.source_session_id);
  const childSessionId = String(fork.child_session_id);
  const issues: LegacyForkValidation['issues'] = [];
  if (mappings.length === 0) {
    issues.push({
      code: 'LEGACY_FORK_MAPPING_MISSING',
      detail: `legacy fork ${forkId} has no message mapping evidence`,
    });
    return { fork, mappings, issues };
  }
  mappings.forEach((mapping, index) => {
    if (Number(mapping.ordinal) !== index) {
      issues.push({
        code: 'LEGACY_FORK_MAPPING_GAP',
        detail: `legacy fork ${forkId} mapping ordinal ${String(mapping.ordinal)} was expected to be ${index}`,
        ordinal: Number(mapping.ordinal),
      });
    }
  });

  const sourceSession = sessionsById.get(sourceSessionId);
  const childSession = sessionsById.get(childSessionId);
  if (
    !sourceSession
    || !childSession
    || readNullableString(sourceSession, 'user_id') !== readNullableString(childSession, 'user_id')
    || readNullableString(sourceSession, 'project_id') !== readNullableString(childSession, 'project_id')
    || !sessionsById.has(String(fork.root_session_id))
  ) {
    issues.push({
      code: 'LEGACY_FORK_MAPPING_NOT_CLOSED',
      detail: `legacy fork ${forkId} does not close within one owner, project, and root lineage`,
    });
  }

  const sourceRows = legacyMessageRows(db, sourceSessionId);
  const childRows = legacyMessageRows(db, childSessionId);
  const sourceIds = sourceRows.map((row) => String(row.id));
  const childIds = childRows.map((row) => String(row.id));
  const mappedSourceIds = mappings.map((mapping) => String(mapping.source_message_id));
  const mappedChildIds = mappings.map((mapping) => String(mapping.child_message_id));
  const sourceAnchorId = String(fork.anchor_message_id);
  const childAnchorId = String(fork.anchor_child_message_id);
  const sourceAnchorIndex = sourceIds.indexOf(sourceAnchorId);
  const childAnchorIndex = childIds.indexOf(childAnchorId);
  const expectedSourcePrefix = sourceAnchorIndex >= 0
    ? sourceIds.slice(0, sourceAnchorIndex + 1)
    : [];
  const expectedChildPrefix = childAnchorIndex >= 0
    ? childIds.slice(0, childAnchorIndex + 1)
    : [];
  const uniqueSourceIds = new Set(mappedSourceIds);
  const uniqueChildIds = new Set(mappedChildIds);
  if (
    sourceAnchorIndex < 0
    || childAnchorIndex < 0
    || mappedSourceIds.length !== expectedSourcePrefix.length
    || mappedChildIds.length !== expectedChildPrefix.length
    || mappedSourceIds.some((id, index) => id !== expectedSourcePrefix[index])
    || mappedChildIds.some((id, index) => id !== expectedChildPrefix[index])
    || uniqueSourceIds.size !== mappedSourceIds.length
    || uniqueChildIds.size !== mappedChildIds.length
  ) {
    issues.push({
      code: 'LEGACY_FORK_MAPPING_NOT_CLOSED',
      detail: `legacy fork ${forkId} mapping is not an exact source and child prefix`,
    });
  }
  if (
    mappedSourceIds[mappedSourceIds.length - 1] !== sourceAnchorId
    || mappedChildIds[mappedChildIds.length - 1] !== childAnchorId
  ) {
    issues.push({
      code: 'LEGACY_FORK_ANCHOR_MISMATCH',
      detail: `legacy fork ${forkId} mapping does not terminate at both declared anchors`,
    });
  }

  const sourceById = new Map(sourceRows.map((row) => [String(row.id), row]));
  const childById = new Map(childRows.map((row) => [String(row.id), row]));
  mappings.forEach((mapping, index) => {
    const source = sourceById.get(String(mapping.source_message_id));
    const child = childById.get(String(mapping.child_message_id));
    if (!source || !child) {
      if (!issues.some((issue) => issue.code === 'LEGACY_FORK_MAPPING_NOT_CLOSED')) {
        issues.push({
          code: 'LEGACY_FORK_MAPPING_NOT_CLOSED',
          detail: `legacy fork ${forkId} mapping ${index} references a missing source or child message`,
          ordinal: Number(mapping.ordinal),
        });
      }
      return;
    }
    const sourceDigest = conversationSha256(canonicalConversationJson(
      canonicalConversationMessagePayload(source),
    ));
    const childDigest = conversationSha256(canonicalConversationJson(
      canonicalConversationMessagePayload(child),
    ));
    if (sourceDigest !== childDigest) {
      issues.push({
        code: 'LEGACY_FORK_PAYLOAD_MISMATCH',
        detail: `legacy fork ${forkId} mapping ${index} has divergent source and child payloads`,
        ordinal: Number(mapping.ordinal),
      });
    }
  });
  return { fork, mappings, issues };
}

function backfillLegacyConversations(db: BetterSqlite3.Database): void {
  if (!tableExists(db, 'sessions') || !tableExists(db, 'messages')) return;

  const sessionColumns = tableColumns(db, 'sessions');
  const projectExpression = sessionColumns.has('project_id') ? 'project_id' : 'NULL AS project_id';
  const createdExpression = sessionColumns.has('created_at') ? 'created_at' : '0 AS created_at';
  const deletedExpression = sessionColumns.has('is_deleted') ? 'is_deleted' : '0 AS is_deleted';
  const sessions = db.prepare(`
    SELECT id, user_id, ${projectExpression}, ${createdExpression}, ${deletedExpression}
    FROM sessions
    ORDER BY created_at ASC, id ASC
  `).all() as SQLiteRow[];
  if (sessions.length === 0) return;

  const forkByChild = new Map<string, SQLiteRow>();
  const mappingsByFork = new Map<string, SQLiteRow[]>();
  if (tableExists(db, 'session_forks')) {
    const forks = db.prepare(`
      SELECT *
      FROM session_forks
      WHERE status = 'completed'
      ORDER BY depth ASC, created_at ASC, id ASC
    `).all() as SQLiteRow[];
    for (const fork of forks) {
      forkByChild.set(String(fork.child_session_id), fork);
      if (tableExists(db, 'session_fork_message_map')) {
        mappingsByFork.set(String(fork.id), db.prepare(`
          SELECT *
          FROM session_fork_message_map
          WHERE fork_id = ?
          ORDER BY ordinal ASC
        `).all(String(fork.id)) as SQLiteRow[]);
      }
    }
  }
  const sessionsById = new Map(sessions.map((session) => [String(session.id), session]));
  const forkValidationByChild = new Map<string, LegacyForkValidation>();
  for (const [childSessionId, fork] of forkByChild) {
    forkValidationByChild.set(
      childSessionId,
      validateLegacyFork(
        db,
        fork,
        mappingsByFork.get(String(fork.id)) ?? [],
        sessionsById,
      ),
    );
  }

  const orderedSessions = [...sessions].sort((left, right) => {
    const leftDepth = Number(forkByChild.get(String(left.id))?.depth ?? 0);
    const rightDepth = Number(forkByChild.get(String(right.id))?.depth ?? 0);
    if (leftDepth !== rightDepth) return leftDepth - rightDepth;
    const leftCreated = Number(left.created_at ?? 0);
    const rightCreated = Number(right.created_at ?? 0);
    if (leftCreated !== rightCreated) return leftCreated - rightCreated;
    return String(left.id).localeCompare(String(right.id));
  });

  for (const session of orderedSessions) {
    const sessionId = String(session.id);
    const ownerUserId = readNullableString(session, 'user_id');
    const projectId = readNullableString(session, 'project_id');
    const forkValidation = forkValidationByChild.get(sessionId);
    const fork = forkValidation?.issues.length === 0 ? forkValidation.fork : undefined;
    const parentSessionId = fork ? String(fork.source_session_id) : null;
    const rootSessionId = fork ? String(fork.root_session_id) : sessionId;
    const parentBranchId = parentSessionId ? conversationBranchId(parentSessionId) : null;
    const rootBranchId = conversationBranchId(rootSessionId);
    const branchId = conversationBranchId(sessionId);
    const forkId = fork ? String(fork.id) : null;
    const existingAnchorEntry = fork
      ? db.prepare(`
          SELECT r.entry_id
          FROM conversation_branch_entries r
          WHERE r.branch_id = ? AND r.projected_message_id = ?
          ORDER BY r.ordinal DESC
          LIMIT 1
        `).get(parentBranchId, String(fork.anchor_message_id)) as { entry_id: string } | undefined
      : undefined;
    const sourceSession = parentSessionId
      ? sessions.find((candidate) => String(candidate.id) === parentSessionId)
      : undefined;
    const legacyAnchor = fork && !existingAnchorEntry
      ? db.prepare(`
          SELECT rowid AS __rowid, *
          FROM messages
          WHERE session_id = ? AND id = ?
          LIMIT 1
        `).get(parentSessionId, String(fork.anchor_message_id)) as SQLiteRow | undefined
      : undefined;
    const legacyAnchorPayloadDigest = legacyAnchor
      ? conversationSha256(canonicalConversationJson(canonicalConversationMessagePayload(
        sanitizeConversationMessageSnapshot(rowToMessage(legacyAnchor)) as unknown as Record<string, unknown>,
      )))
      : null;
    const anchorEntryId = existingAnchorEntry?.entry_id ?? (
      legacyAnchor && legacyAnchorPayloadDigest
        ? conversationEntryId({
            ownerUserId: readNullableString(sourceSession ?? {}, 'user_id'),
            projectId: readNullableString(sourceSession ?? {}, 'project_id'),
            sourceSessionId: parentSessionId ?? sessionId,
            sourceMessageId: String(fork?.anchor_message_id),
            payloadDigest: legacyAnchorPayloadDigest,
          })
        : null
    );
    const createdAt = Number(fork?.created_at ?? session.created_at ?? 0);
    const lineageDigest = conversationSha256(canonicalConversationJson({
      sessionId,
      ownerUserId,
      projectId,
      rootBranchId,
      parentBranchId,
      forkId,
      anchorEntryId,
      createdAt,
    }));

    db.prepare(`
      INSERT OR IGNORE INTO conversation_branches (
        id, session_id, owner_user_id, project_id, root_branch_id,
        parent_branch_id, fork_id, anchor_entry_id, lineage_digest,
        schema_version, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      branchId,
      sessionId,
      ownerUserId,
      projectId,
      rootBranchId,
      parentBranchId,
      forkId,
      anchorEntryId,
      lineageDigest,
      CONVERSATION_BRANCH_SCHEMA_VERSION,
      createdAt,
    );
  }

  for (const session of orderedSessions) {
    const sessionId = String(session.id);
    const ownerUserId = readNullableString(session, 'user_id');
    const projectId = readNullableString(session, 'project_id');
    const branchId = conversationBranchId(sessionId);
    const forkValidation = forkValidationByChild.get(sessionId);
    const fork = forkValidation?.issues.length === 0 ? forkValidation.fork : undefined;
    const mappings = fork ? mappingsByFork.get(String(fork.id)) ?? [] : [];
    const sourceByChild = new Map(
      mappings.map((mapping) => [String(mapping.child_message_id), mapping]),
    );
    const insertedOrdinals: number[] = [];
    let nextOrdinal = Number((db.prepare(`
      SELECT COALESCE(MAX(ordinal), -1) AS max_ordinal
      FROM conversation_branch_entries
      WHERE branch_id = ?
    `).get(branchId) as { max_ordinal: number }).max_ordinal) + 1;

    for (const row of legacyMessageRows(db, sessionId)) {
      const messageId = String(row.id);
      const existing = db.prepare(`
        SELECT 1
        FROM conversation_branch_entries
        WHERE branch_id = ? AND projected_message_id = ?
        LIMIT 1
      `).get(branchId, messageId);
      if (existing) continue;

      const mapping = sourceByChild.get(messageId);
      const sourceSessionId = mapping ? String(fork?.source_session_id) : sessionId;
      const sourceMessageId = mapping ? String(mapping.source_message_id) : messageId;
      const sourceReference = mapping
        ? db.prepare(`
            SELECT entry_id, canonical_source_session_id, canonical_source_message_id
            FROM conversation_branch_entries
            WHERE branch_id = ? AND projected_message_id = ?
            ORDER BY ordinal DESC
            LIMIT 1
          `).get(conversationBranchId(sourceSessionId), sourceMessageId) as {
            entry_id: string;
            canonical_source_session_id: string;
            canonical_source_message_id: string;
          } | undefined
        : undefined;

      let entryId: string;
      let canonicalSourceSessionId: string;
      let canonicalSourceMessageId: string;
      if (sourceReference) {
        entryId = sourceReference.entry_id;
        canonicalSourceSessionId = sourceReference.canonical_source_session_id;
        canonicalSourceMessageId = sourceReference.canonical_source_message_id;
      } else {
        const payload = canonicalConversationMessagePayload(
          sanitizeConversationMessageSnapshot(rowToMessage(row)) as unknown as Record<string, unknown>,
        );
        const messageJson = canonicalConversationJson(payload);
        const payloadDigest = conversationSha256(messageJson);
        canonicalSourceSessionId = sourceSessionId;
        canonicalSourceMessageId = sourceMessageId;
        entryId = conversationEntryId({
          ownerUserId,
          projectId,
          sourceSessionId: canonicalSourceSessionId,
          sourceMessageId: canonicalSourceMessageId,
          payloadDigest,
        });
        db.prepare(`
          INSERT OR IGNORE INTO conversation_entries (
            id, owner_user_id, project_id, source_session_id, source_message_id,
            message_json, payload_digest, provenance_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          entryId,
          ownerUserId,
          projectId,
          canonicalSourceSessionId,
          canonicalSourceMessageId,
          messageJson,
          payloadDigest,
          canonicalConversationJson({
            kind: 'legacy_backfill',
            projectedSessionId: sessionId,
            projectedMessageId: messageId,
            legacyRowId: Number(row.__rowid),
          }),
          Number(row.timestamp ?? session.created_at ?? 0),
        );
      }

      db.prepare(`
        INSERT INTO conversation_branch_entries (
          branch_id, ordinal, entry_id, projected_session_id,
          projected_message_id, canonical_source_session_id,
          canonical_source_message_id, alias_kind, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        branchId,
        nextOrdinal,
        entryId,
        sessionId,
        messageId,
        canonicalSourceSessionId,
        canonicalSourceMessageId,
        mapping ? 'fork_copy' : 'legacy_backfill',
        Number(row.timestamp ?? session.created_at ?? 0),
      );
      insertedOrdinals.push(nextOrdinal);
      nextOrdinal += 1;
    }

    if (insertedOrdinals.length > 0) {
      const eventType = fork ? 'fork' : 'legacy_backfill';
      const digest = conversationSha256(canonicalConversationJson(insertedOrdinals));
      insertEvent(db, {
        id: `cevent_${conversationSha256(`${branchId}:${eventType}:${digest}`).slice(0, 32)}`,
        branchId,
        eventType,
        idempotencyKey: `${eventType}:${digest}`,
        actorUserId: ownerUserId,
        payload: {
          ordinals: insertedOrdinals,
          forkId: fork ? String(fork.id) : null,
          parentSessionId: fork ? String(fork.source_session_id) : null,
          anchorMessageId: fork ? String(fork.anchor_message_id) : null,
        },
        createdAt: Number(fork?.created_at ?? session.created_at ?? 0),
      });
    }
    if (forkValidation && forkValidation.issues.length > 0) {
      const issues: ConversationLineageIssue[] = forkValidation.issues.map((issue) => ({
        ...issue,
        branchId,
      }));
      const issueDigest = conversationLineageIssueDigest(issues);
      const candidateFork = forkValidation.fork;
      insertEvent(db, {
        id: `cevent_${conversationSha256(`legacy-fork-quarantine:${String(candidateFork.id)}:${issueDigest}`).slice(0, 32)}`,
        branchId,
        eventType: 'quarantine',
        idempotencyKey: `legacy-fork-quarantine:${String(candidateFork.id)}:${issueDigest}`,
        actorUserId: ownerUserId,
        payload: {
          sticky: true,
          issueDigest,
          issues,
          candidateFork: {
            forkId: String(candidateFork.id),
            sourceSessionId: String(candidateFork.source_session_id),
            childSessionId: String(candidateFork.child_session_id),
            rootSessionId: String(candidateFork.root_session_id),
            anchorMessageId: String(candidateFork.anchor_message_id),
            anchorChildMessageId: String(candidateFork.anchor_child_message_id),
          },
        },
        createdAt: Number(candidateFork.created_at ?? session.created_at ?? 0),
      });
    }
  }

  if (!tableExists(db, 'session_rewinds')) return;
  const rewinds = db.prepare(`
    SELECT *
    FROM session_rewinds
    WHERE status IN ('completed', 'restored')
    ORDER BY created_at ASC, id ASC
  `).all() as SQLiteRow[];
  for (const rewind of rewinds) {
    const sessionId = String(rewind.session_id);
    const branchId = conversationBranchId(sessionId);
    const branch = db.prepare(`
      SELECT owner_user_id
      FROM conversation_branches
      WHERE id = ?
    `).get(branchId) as { owner_user_id: string | null } | undefined;
    if (!branch) continue;
    const anchor = db.prepare(`
      SELECT ordinal, entry_id
      FROM conversation_branch_entries
      WHERE branch_id = ? AND projected_message_id = ?
      ORDER BY ordinal DESC
      LIMIT 1
    `).get(branchId, String(rewind.anchor_message_id)) as {
      ordinal: number;
      entry_id: string;
    } | undefined;
    if (!anchor) continue;
    const hiddenMessageIds = parseStringArray(rewind.hidden_message_ids);
    const hidden = hiddenMessageIds.flatMap((messageId) => {
      const reference = db.prepare(`
        SELECT ordinal, entry_id
        FROM conversation_branch_entries
        WHERE branch_id = ? AND projected_message_id = ?
        ORDER BY ordinal DESC
        LIMIT 1
      `).get(branchId, messageId) as { ordinal: number; entry_id: string } | undefined;
      return reference ? [{
        ordinal: reference.ordinal,
        entryId: reference.entry_id,
        projectedMessageId: messageId,
      }] : [];
    });
    const rewindId = String(rewind.id);
    insertEvent(db, {
      id: `cevent_${conversationSha256(`legacy-rewind:${rewindId}`).slice(0, 32)}`,
      branchId,
      eventType: 'rewind',
      idempotencyKey: `legacy-rewind:${rewindId}`,
      actorUserId: branch.owner_user_id,
      payload: {
        rewindId,
        anchorOrdinal: anchor.ordinal,
        anchorEntryId: anchor.entry_id,
        anchorMessageId: String(rewind.anchor_message_id),
        hidden,
      },
      createdAt: Number(rewind.created_at ?? 0),
    });
    if (rewind.restored_at !== null && rewind.restored_at !== undefined) {
      insertEvent(db, {
        id: `cevent_${conversationSha256(`legacy-rewind-restore:${rewindId}`).slice(0, 32)}`,
        branchId,
        eventType: 'rewind_restore',
        idempotencyKey: `legacy-rewind-restore:${rewindId}`,
        actorUserId: branch.owner_user_id,
        payload: { rewindId },
        createdAt: Number(rewind.restored_at),
      });
    }
  }
}

function parseStringArray(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function installImmutabilityTriggers(db: BetterSqlite3.Database): void {
  for (const table of [
    'conversation_entries',
    'conversation_branches',
    'conversation_branch_entries',
    'conversation_branch_events',
  ]) {
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS ${table}_immutable_update
      BEFORE UPDATE ON ${table}
      BEGIN
        SELECT RAISE(ABORT, '${table} is immutable');
      END;
      CREATE TRIGGER IF NOT EXISTS ${table}_immutable_delete
      BEFORE DELETE ON ${table}
      BEGIN
        SELECT RAISE(ABORT, '${table} is immutable');
      END;
    `);
  }
}

function ensureProjectionRepairEventType(db: BetterSqlite3.Database): void {
  const row = db.prepare(`
    SELECT sql
    FROM sqlite_master
    WHERE type = 'table' AND name = 'conversation_branch_events'
  `).get() as { sql: string | null } | undefined;
  if (!row?.sql || row.sql.includes("'projection_repair'")) return;

  db.transaction(() => {
    db.exec(`
      DROP TRIGGER IF EXISTS conversation_branch_events_immutable_update;
      DROP TRIGGER IF EXISTS conversation_branch_events_immutable_delete;
      ALTER TABLE conversation_branch_events
        RENAME TO conversation_branch_events_before_projection_repair;
      CREATE TABLE conversation_branch_events (
        id TEXT PRIMARY KEY,
        branch_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        actor_user_id TEXT,
        payload_json TEXT NOT NULL,
        payload_digest TEXT NOT NULL,
        previous_event_digest TEXT,
        event_digest TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE (branch_id, sequence),
        UNIQUE (branch_id, idempotency_key),
        FOREIGN KEY (branch_id) REFERENCES conversation_branches(id) ON DELETE RESTRICT,
        CHECK (sequence > 0),
        CHECK (event_type IN (
          'legacy_backfill', 'append', 'message_revision', 'projection_replace',
          'fork', 'rewind', 'rewind_restore', 'evaluation_attribution',
          'quarantine', 'repair_override', 'projection_repair'
        )),
        CHECK (length(payload_digest) = 64),
        CHECK (length(event_digest) = 64)
      );
      INSERT INTO conversation_branch_events (
        id, branch_id, sequence, event_type, idempotency_key, actor_user_id,
        payload_json, payload_digest, previous_event_digest, event_digest, created_at
      )
      SELECT
        id, branch_id, sequence, event_type, idempotency_key, actor_user_id,
        payload_json, payload_digest, previous_event_digest, event_digest, created_at
      FROM conversation_branch_events_before_projection_repair
      ORDER BY branch_id ASC, sequence ASC;
      DROP TABLE conversation_branch_events_before_projection_repair;
      CREATE INDEX IF NOT EXISTS idx_conversation_branch_events_type
        ON conversation_branch_events(branch_id, event_type, sequence);
    `);
  })();
}

/**
 * Installs the append-only conversation ledger and backfills existing sessions.
 *
 * The fragment intentionally has no dependency on the monolithic schema file,
 * so callers can apply it after legacy tables/migrations are available. It is
 * safe to call repeatedly: immutable rows are only inserted when absent.
 */
export function applyConversationBranchSchema(
  db: BetterSqlite3.Database,
  options: { backfillLegacy?: boolean } = {},
): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversation_entries (
      id TEXT PRIMARY KEY,
      owner_user_id TEXT,
      project_id TEXT,
      source_session_id TEXT NOT NULL,
      source_message_id TEXT NOT NULL,
      message_json TEXT NOT NULL,
      payload_digest TEXT NOT NULL,
      provenance_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      CHECK (length(payload_digest) = 64)
    );

    CREATE TABLE IF NOT EXISTS conversation_branches (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL UNIQUE,
      owner_user_id TEXT,
      project_id TEXT,
      root_branch_id TEXT NOT NULL,
      parent_branch_id TEXT,
      fork_id TEXT,
      anchor_entry_id TEXT,
      lineage_digest TEXT NOT NULL,
      schema_version INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      CHECK (schema_version = 1),
      CHECK (length(lineage_digest) = 64)
    );

    CREATE TABLE IF NOT EXISTS conversation_branch_entries (
      branch_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      entry_id TEXT NOT NULL,
      projected_session_id TEXT NOT NULL,
      projected_message_id TEXT NOT NULL,
      canonical_source_session_id TEXT NOT NULL,
      canonical_source_message_id TEXT NOT NULL,
      alias_kind TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (branch_id, ordinal),
      FOREIGN KEY (branch_id) REFERENCES conversation_branches(id) ON DELETE RESTRICT,
      FOREIGN KEY (entry_id) REFERENCES conversation_entries(id) ON DELETE RESTRICT,
      CHECK (ordinal >= 0),
      CHECK (alias_kind IN ('native', 'fork_copy', 'legacy_backfill', 'revision', 'replacement'))
    );

    CREATE TABLE IF NOT EXISTS conversation_branch_events (
      id TEXT PRIMARY KEY,
      branch_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      actor_user_id TEXT,
      payload_json TEXT NOT NULL,
      payload_digest TEXT NOT NULL,
      previous_event_digest TEXT,
      event_digest TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE (branch_id, sequence),
      UNIQUE (branch_id, idempotency_key),
      FOREIGN KEY (branch_id) REFERENCES conversation_branches(id) ON DELETE RESTRICT,
      CHECK (sequence > 0),
      CHECK (event_type IN (
        'legacy_backfill', 'append', 'message_revision', 'projection_replace',
        'fork', 'rewind', 'rewind_restore', 'evaluation_attribution',
        'quarantine', 'repair_override', 'projection_repair'
      )),
      CHECK (length(payload_digest) = 64),
      CHECK (length(event_digest) = 64)
    );

    CREATE INDEX IF NOT EXISTS idx_conversation_entries_source
      ON conversation_entries(source_session_id, source_message_id);
    CREATE INDEX IF NOT EXISTS idx_conversation_branch_entries_entry
      ON conversation_branch_entries(entry_id);
    CREATE INDEX IF NOT EXISTS idx_conversation_branch_entries_alias
      ON conversation_branch_entries(branch_id, projected_message_id, ordinal);
    CREATE INDEX IF NOT EXISTS idx_conversation_branch_events_type
      ON conversation_branch_events(branch_id, event_type, sequence);
  `);
  ensureProjectionRepairEventType(db);

  if (options.backfillLegacy !== false) {
    db.transaction(() => backfillLegacyConversations(db))();
  }
  installImmutabilityTriggers(db);
}
