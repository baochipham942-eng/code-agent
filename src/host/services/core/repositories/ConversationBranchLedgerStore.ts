import type BetterSqlite3 from 'better-sqlite3';

import {
  ConversationBranchError,
  type ConversationBoundary,
  type ConversationBranchLineage,
  type ConversationEntryRecord,
  type ConversationEvaluationAttribution,
  type ConversationMessageSnapshot,
  type ConversationReplay,
  type ConversationReplayMessage,
} from '../../../../shared/contract/conversationBranch';
import {
  canonicalConversationJson,
  conversationEntryId,
  conversationEventDigest,
  conversationSha256,
} from '../database/schemaConversationBranch';

export type ConversationSQLiteRow = Record<string, unknown>;

export interface ConversationBranchRow {
  id: string;
  session_id: string;
  owner_user_id: string | null;
  project_id: string | null;
  root_branch_id: string;
  parent_branch_id: string | null;
  fork_id: string | null;
  anchor_entry_id: string | null;
  lineage_digest: string;
  schema_version: number;
  created_at: number;
}

export interface ConversationReferenceRow {
  branch_id: string;
  ordinal: number;
  entry_id: string;
  projected_session_id: string;
  projected_message_id: string;
  canonical_source_session_id: string;
  canonical_source_message_id: string;
  alias_kind: ConversationReplayMessage['aliasKind'];
  created_at: number;
  message_json: string;
  payload_digest: string;
  entry_owner_user_id: string | null;
  entry_project_id: string | null;
}

export interface ConversationEventRow {
  id: string;
  branch_id: string;
  sequence: number;
  event_type: string;
  idempotency_key: string;
  actor_user_id: string | null;
  payload_json: string;
  payload_digest: string;
  previous_event_digest: string | null;
  event_digest: string;
  created_at: number;
}

interface SessionBoundaryRow {
  id: string;
  user_id: string | null;
  project_id: string | null;
}

export interface AppendConversationEventResult {
  event: ConversationEventRow;
  inserted: boolean;
}

export function parseConversationRecord(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function parseConversationNumberArray(value: unknown): number[] {
  return Array.isArray(value)
    ? value.filter((item): item is number => typeof item === 'number' && Number.isInteger(item))
    : [];
}

export function parseConversationStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function exactConversationNullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function conversationBoundaryEquals(
  left: string | null,
  right: string | null,
): boolean {
  return left === right;
}

export class ConversationBranchLedgerStore {
  constructor(private readonly db: BetterSqlite3.Database) {}

  requireBoundaryObject(boundary: ConversationBoundary): void {
    if (
      !boundary
      || !Object.prototype.hasOwnProperty.call(boundary, 'ownerUserId')
      || !Object.prototype.hasOwnProperty.call(boundary, 'projectId')
      || boundary.ownerUserId === undefined
      || boundary.projectId === undefined
    ) {
      throw new ConversationBranchError(
        'BOUNDARY_REQUIRED',
        'exact owner and project boundaries are required',
      );
    }
  }

  requireSessionBoundary(
    sessionId: string,
    boundary: ConversationBoundary,
  ): SessionBoundaryRow {
    this.requireBoundaryObject(boundary);
    const columns = this.db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>;
    const hasProject = columns.some((column) => column.name === 'project_id');
    const session = this.db.prepare(`
      SELECT id, user_id, ${hasProject ? 'project_id' : 'NULL AS project_id'}
      FROM sessions
      WHERE id = ?
        ${columns.some((column) => column.name === 'is_deleted') ? 'AND COALESCE(is_deleted, 0) = 0' : ''}
      LIMIT 1
    `).get(sessionId) as SessionBoundaryRow | undefined;
    if (!session) {
      throw new ConversationBranchError('SESSION_NOT_FOUND', `session ${sessionId} was not found`);
    }
    const owner = exactConversationNullableString(session.user_id);
    const project = exactConversationNullableString(session.project_id);
    if (!conversationBoundaryEquals(owner, boundary.ownerUserId)) {
      throw new ConversationBranchError(
        'OWNER_MISMATCH',
        `session ${sessionId} belongs to another owner`,
      );
    }
    if (!conversationBoundaryEquals(project, boundary.projectId)) {
      throw new ConversationBranchError(
        'PROJECT_MISMATCH',
        `session ${sessionId} belongs to another project`,
      );
    }
    return { id: session.id, user_id: owner, project_id: project };
  }

  requireBranch(
    sessionId: string,
    boundary: ConversationBoundary,
  ): ConversationBranchRow {
    this.requireSessionBoundary(sessionId, boundary);
    const branch = this.readBranchBySession(sessionId);
    if (!branch) {
      throw new ConversationBranchError(
        'BRANCH_NOT_FOUND',
        `branch for ${sessionId} was not found`,
      );
    }
    this.requireBranchBoundary(branch, boundary);
    return branch;
  }

  requireBranchBoundary(
    branch: ConversationBranchRow,
    boundary: ConversationBoundary,
  ): void {
    if (!conversationBoundaryEquals(branch.owner_user_id, boundary.ownerUserId)) {
      throw new ConversationBranchError(
        'OWNER_MISMATCH',
        `branch ${branch.id} belongs to another owner`,
      );
    }
    if (!conversationBoundaryEquals(branch.project_id, boundary.projectId)) {
      throw new ConversationBranchError(
        'PROJECT_MISMATCH',
        `branch ${branch.id} belongs to another project`,
      );
    }
  }

  readBranchBySession(sessionId: string): ConversationBranchRow | undefined {
    return this.db.prepare(`
      SELECT *
      FROM conversation_branches
      WHERE session_id = ?
      LIMIT 1
    `).get(sessionId) as ConversationBranchRow | undefined;
  }

  readBranchById(branchId: string): ConversationBranchRow | undefined {
    return this.db.prepare(`
      SELECT *
      FROM conversation_branches
      WHERE id = ?
      LIMIT 1
    `).get(branchId) as ConversationBranchRow | undefined;
  }

  toLineage(branch: ConversationBranchRow): ConversationBranchLineage {
    const parent = branch.parent_branch_id
      ? this.readBranchById(branch.parent_branch_id)
      : undefined;
    return {
      branchId: branch.id,
      sessionId: branch.session_id,
      ownerUserId: branch.owner_user_id,
      projectId: branch.project_id,
      rootBranchId: branch.root_branch_id,
      parentBranchId: branch.parent_branch_id,
      parentSessionId: parent?.session_id ?? null,
      forkId: branch.fork_id,
      anchorEntryId: branch.anchor_entry_id,
      createdAt: branch.created_at,
    };
  }

  readReferences(branchId: string): ConversationReferenceRow[] {
    return this.db.prepare(`
      SELECT r.*,
             e.message_json,
             e.payload_digest,
             e.owner_user_id AS entry_owner_user_id,
             e.project_id AS entry_project_id
      FROM conversation_branch_entries r
      JOIN conversation_entries e ON e.id = r.entry_id
      WHERE r.branch_id = ?
      ORDER BY r.ordinal ASC
    `).all(branchId) as ConversationReferenceRow[];
  }

  requireReference(branchId: string, ordinal: number): ConversationReferenceRow {
    const reference = this.db.prepare(`
      SELECT r.*,
             e.message_json,
             e.payload_digest,
             e.owner_user_id AS entry_owner_user_id,
             e.project_id AS entry_project_id
      FROM conversation_branch_entries r
      JOIN conversation_entries e ON e.id = r.entry_id
      WHERE r.branch_id = ? AND r.ordinal = ?
    `).get(branchId, ordinal) as ConversationReferenceRow | undefined;
    if (!reference) {
      throw new ConversationBranchError(
        'ENTRY_NOT_FOUND',
        `branch reference ${ordinal} is missing`,
      );
    }
    return reference;
  }

  referenceToReplayMessage(
    reference: ConversationReferenceRow,
  ): ConversationReplayMessage {
    const payload = parseConversationRecord(reference.message_json);
    return {
      ordinal: reference.ordinal,
      entryId: reference.entry_id,
      projectedMessageId: reference.projected_message_id,
      sourceSessionId: reference.canonical_source_session_id,
      sourceMessageId: reference.canonical_source_message_id,
      aliasKind: reference.alias_kind,
      message: {
        ...payload,
        id: reference.projected_message_id,
        role: String(payload.role ?? 'user') as ConversationMessageSnapshot['role'],
        content: String(payload.content ?? ''),
        timestamp: Number(payload.timestamp ?? reference.created_at),
        visibility: 'active',
      },
    };
  }

  nextOrdinal(branchId: string): number {
    const row = this.db.prepare(`
      SELECT COALESCE(MAX(ordinal), -1) AS ordinal
      FROM conversation_branch_entries
      WHERE branch_id = ?
    `).get(branchId) as { ordinal: number };
    return Number(row.ordinal) + 1;
  }

  insertEntry(input: {
    branch: ConversationBranchRow;
    sourceSessionId: string;
    sourceMessageId: string;
    payloadJson: string;
    payloadDigest: string;
    provenance: Record<string, unknown>;
    createdAt: number;
  }): string {
    const entryId = conversationEntryId({
      ownerUserId: input.branch.owner_user_id,
      projectId: input.branch.project_id,
      sourceSessionId: input.sourceSessionId,
      sourceMessageId: input.sourceMessageId,
      payloadDigest: input.payloadDigest,
    });
    this.db.prepare(`
      INSERT OR IGNORE INTO conversation_entries (
        id, owner_user_id, project_id, source_session_id, source_message_id,
        message_json, payload_digest, provenance_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      entryId,
      input.branch.owner_user_id,
      input.branch.project_id,
      input.sourceSessionId,
      input.sourceMessageId,
      input.payloadJson,
      input.payloadDigest,
      canonicalConversationJson(input.provenance),
      input.createdAt,
    );
    const stored = this.db.prepare(`
      SELECT owner_user_id, project_id, message_json, payload_digest
      FROM conversation_entries
      WHERE id = ?
    `).get(entryId) as ConversationSQLiteRow | undefined;
    if (
      !stored
      || exactConversationNullableString(stored.owner_user_id) !== input.branch.owner_user_id
      || exactConversationNullableString(stored.project_id) !== input.branch.project_id
      || stored.message_json !== input.payloadJson
      || stored.payload_digest !== input.payloadDigest
    ) {
      throw new ConversationBranchError('LEDGER_CORRUPT', `entry collision for ${entryId}`);
    }
    return entryId;
  }

  insertReference(input: {
    branchId: string;
    ordinal: number;
    entryId: string;
    projectedSessionId: string;
    projectedMessageId: string;
    canonicalSourceSessionId: string;
    canonicalSourceMessageId: string;
    aliasKind: ConversationReplayMessage['aliasKind'];
    createdAt: number;
  }): void {
    this.db.prepare(`
      INSERT INTO conversation_branch_entries (
        branch_id, ordinal, entry_id, projected_session_id,
        projected_message_id, canonical_source_session_id,
        canonical_source_message_id, alias_kind, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.branchId,
      input.ordinal,
      input.entryId,
      input.projectedSessionId,
      input.projectedMessageId,
      input.canonicalSourceSessionId,
      input.canonicalSourceMessageId,
      input.aliasKind,
      input.createdAt,
    );
  }

  readEvents(branchId: string): ConversationEventRow[] {
    return this.db.prepare(`
      SELECT *
      FROM conversation_branch_events
      WHERE branch_id = ?
      ORDER BY sequence ASC
    `).all(branchId) as ConversationEventRow[];
  }

  readIdempotentEvent(
    branchId: string,
    idempotencyKey: string,
  ): ConversationEventRow | undefined {
    if (!idempotencyKey.trim()) {
      throw new ConversationBranchError(
        'IDEMPOTENCY_CONFLICT',
        'idempotency key is required',
      );
    }
    return this.db.prepare(`
      SELECT *
      FROM conversation_branch_events
      WHERE branch_id = ? AND idempotency_key = ?
      LIMIT 1
    `).get(branchId, idempotencyKey) as ConversationEventRow | undefined;
  }

  requireIdempotentEvent(
    event: ConversationEventRow,
    eventType: string,
    payloadSubset: Record<string, unknown>,
  ): void {
    const payload = parseConversationRecord(event.payload_json);
    const mismatch = event.event_type !== eventType
      || Object.entries(payloadSubset).some(
        ([key, value]) => (
          canonicalConversationJson(payload[key]) !== canonicalConversationJson(value)
        ),
      );
    if (mismatch) {
      throw new ConversationBranchError(
        'IDEMPOTENCY_CONFLICT',
        `idempotency key ${event.idempotency_key} was used for a different ledger operation`,
      );
    }
  }

  appendEvent(input: {
    branch: ConversationBranchRow;
    eventType: string;
    idempotencyKey: string;
    payload: Record<string, unknown>;
    createdAt: number;
  }): AppendConversationEventResult {
    const existing = this.readIdempotentEvent(input.branch.id, input.idempotencyKey);
    if (existing) {
      this.requireIdempotentEvent(existing, input.eventType, input.payload);
      return { event: existing, inserted: false };
    }
    const prior = this.db.prepare(`
      SELECT sequence, event_digest
      FROM conversation_branch_events
      WHERE branch_id = ?
      ORDER BY sequence DESC
      LIMIT 1
    `).get(input.branch.id) as { sequence: number; event_digest: string } | undefined;
    const sequence = (prior?.sequence ?? 0) + 1;
    const previousEventDigest = prior?.event_digest ?? null;
    const payloadJson = canonicalConversationJson(input.payload);
    const payloadDigest = conversationSha256(payloadJson);
    const id = `cevent_${conversationSha256(
      `${input.branch.id}:${input.idempotencyKey}:${input.eventType}:${payloadDigest}`,
    ).slice(0, 32)}`;
    const eventDigest = conversationEventDigest({
      id,
      branchId: input.branch.id,
      sequence,
      eventType: input.eventType,
      payloadDigest,
      previousEventDigest,
      createdAt: input.createdAt,
    });
    this.db.prepare(`
      INSERT INTO conversation_branch_events (
        id, branch_id, sequence, event_type, idempotency_key, actor_user_id,
        payload_json, payload_digest, previous_event_digest, event_digest, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.branch.id,
      sequence,
      input.eventType,
      input.idempotencyKey,
      input.branch.owner_user_id,
      payloadJson,
      payloadDigest,
      previousEventDigest,
      eventDigest,
      input.createdAt,
    );
    const event = this.readIdempotentEvent(input.branch.id, input.idempotencyKey);
    if (!event) {
      throw new ConversationBranchError('LEDGER_CORRUPT', 'event insert disappeared');
    }
    return { event, inserted: true };
  }

  toEntryRecord(row: ConversationSQLiteRow): ConversationEntryRecord {
    const payload = parseConversationRecord(String(row.message_json));
    return {
      id: String(row.id),
      ownerUserId: exactConversationNullableString(row.owner_user_id),
      projectId: exactConversationNullableString(row.project_id),
      sourceSessionId: String(row.source_session_id),
      sourceMessageId: String(row.source_message_id),
      payloadDigest: String(row.payload_digest),
      message: {
        ...payload,
        id: String(row.source_message_id),
        role: String(payload.role ?? 'user') as ConversationMessageSnapshot['role'],
        content: String(payload.content ?? ''),
        timestamp: Number(payload.timestamp ?? row.created_at),
      },
      provenance: parseConversationRecord(String(row.provenance_json)),
      createdAt: Number(row.created_at),
    };
  }

  eventToEvaluation(event: ConversationEventRow): ConversationEvaluationAttribution {
    const payload = parseConversationRecord(event.payload_json);
    return {
      eventId: event.id,
      evaluationId: String(payload.evaluationId ?? ''),
      runId: typeof payload.runId === 'string' ? payload.runId : null,
      metric: String(payload.metric ?? ''),
      value: Number(payload.value),
      entryIds: parseConversationStringArray(payload.entryIds),
      createdAt: event.created_at,
    };
  }

  branchPath(
    branch: ConversationBranchRow,
    boundary: ConversationBoundary,
  ): ConversationBranchLineage[] {
    const path: ConversationBranchLineage[] = [];
    const seen = new Set<string>();
    let cursor: ConversationBranchRow | undefined = branch;
    while (cursor) {
      if (seen.has(cursor.id)) {
        throw new ConversationBranchError(
          'LEDGER_CORRUPT',
          'branch ancestry contains a cycle',
        );
      }
      seen.add(cursor.id);
      this.requireBranchBoundary(cursor, boundary);
      path.unshift(this.toLineage(cursor));
      cursor = cursor.parent_branch_id
        ? this.readBranchById(cursor.parent_branch_id)
        : undefined;
    }
    return path;
  }

  replayFromRows(
    branch: ConversationBranchRow,
    references: ConversationReferenceRow[],
    events: ConversationEventRow[],
    options: { includeRewound?: boolean } = {},
  ): ConversationReplay {
    const byOrdinal = new Map(references.map((reference) => [reference.ordinal, reference]));
    let activeOrdinals: number[] = [];
    const openRewinds: Array<{ rewindId: string; hiddenOrdinals: number[] }> = [];

    for (const event of events) {
      const payload = parseConversationRecord(event.payload_json);
      switch (event.event_type) {
        case 'legacy_backfill':
        case 'fork':
          activeOrdinals.push(...parseConversationNumberArray(payload.ordinals).filter(
            (ordinal) => !activeOrdinals.includes(ordinal),
          ));
          break;
        case 'append': {
          const ordinal = Number(payload.ordinal);
          if (Number.isInteger(ordinal) && !activeOrdinals.includes(ordinal)) {
            activeOrdinals.push(ordinal);
          }
          break;
        }
        case 'message_revision': {
          const targetOrdinal = Number(payload.targetOrdinal);
          const replacementOrdinal = Number(payload.replacementOrdinal);
          const index = activeOrdinals.indexOf(targetOrdinal);
          if (index >= 0 && Number.isInteger(replacementOrdinal)) {
            activeOrdinals[index] = replacementOrdinal;
          }
          break;
        }
        case 'projection_replace':
          activeOrdinals = parseConversationNumberArray(payload.replacementOrdinals);
          if (!options.includeRewound) {
            openRewinds.length = 0;
          }
          break;
        case 'projection_repair':
          break;
        case 'rewind': {
          if (!options.includeRewound) {
            const hiddenOrdinals = Array.isArray(payload.hidden)
              ? payload.hidden.flatMap((item) => (
                  item
                  && typeof item === 'object'
                  && Number.isInteger((item as { ordinal?: unknown }).ordinal)
                    ? [(item as { ordinal: number }).ordinal]
                    : []
                ))
              : [];
            const hidden = new Set(hiddenOrdinals);
            activeOrdinals = activeOrdinals.filter((ordinal) => !hidden.has(ordinal));
            openRewinds.push({
              rewindId: String(payload.rewindId ?? ''),
              hiddenOrdinals,
            });
          }
          break;
        }
        case 'rewind_restore': {
          if (!options.includeRewound) {
            const rewindId = String(payload.rewindId ?? '');
            const open = openRewinds[openRewinds.length - 1];
            if (open?.rewindId === rewindId) {
              activeOrdinals.push(...open.hiddenOrdinals);
              openRewinds.pop();
            }
          }
          break;
        }
        default:
          break;
      }
    }

    return {
      lineage: this.toLineage(branch),
      messages: activeOrdinals.flatMap((ordinal) => {
        const reference = byOrdinal.get(ordinal);
        return reference ? [this.referenceToReplayMessage(reference)] : [];
      }),
      openRewindIds: options.includeRewound
        ? []
        : openRewinds.map((rewind) => rewind.rewindId),
      ledgerEventCount: events.length,
    };
  }
}
