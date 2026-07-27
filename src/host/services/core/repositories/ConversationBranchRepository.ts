import type BetterSqlite3 from 'better-sqlite3';

import {
  ConversationBranchError,
  type ConversationBoundary,
  type ConversationBranchComparison,
  type ConversationBranchLineage,
  type ConversationEntryRecord,
  type ConversationEvaluationAttribution,
  type ConversationLineageAudit,
  type ConversationMessageSnapshot,
  type ConversationProvenanceTrace,
  type ConversationReplay,
  type ConversationReplayMessage,
} from '../../../../shared/contract/conversationBranch';
import {
  canonicalConversationJson,
  canonicalConversationMessagePayload,
  conversationBranchId,
  conversationSha256,
} from '../database/schemaConversationBranch';
import { ConversationBranchAuditRepository } from './ConversationBranchAuditRepository';
import {
  ConversationBranchLedgerStore,
  parseConversationRecord as parseRecord,
  parseConversationStringArray as parseStringArray,
} from './ConversationBranchLedgerStore';
import { ConversationProjectionRepairRepository } from './ConversationProjectionRepairRepository';

type SQLiteRow = Record<string, unknown>;

interface BranchRow {
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

interface ReferenceRow {
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

interface EventRow {
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

interface AppendEventResult {
  event: EventRow;
  inserted: boolean;
}

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

export interface InitializeConversationBranchInput {
  sessionId: string;
  boundary: ConversationBoundary;
  createdAt?: number;
}

export interface AppendConversationMessageInput {
  sessionId: string;
  boundary: ConversationBoundary;
  message: ConversationMessageSnapshot;
  idempotencyKey: string;
  provenance?: Record<string, unknown>;
  createdAt?: number;
}

export interface RecordConversationMessageRevisionInput {
  sessionId: string;
  boundary: ConversationBoundary;
  targetMessageId: string;
  revisedMessage: ConversationMessageSnapshot;
  idempotencyKey: string;
  reason: string;
  createdAt?: number;
}

export interface RecordConversationProjectionReplacementInput {
  sessionId: string;
  boundary: ConversationBoundary;
  messages: ConversationMessageSnapshot[];
  idempotencyKey: string;
  reason: string;
  createdAt?: number;
}

export interface CreateConversationForkBranchInput {
  sourceSessionId: string;
  childSessionId: string;
  sourceAnchorMessageId: string;
  childAnchorMessageId: string;
  forkId: string;
  boundary: ConversationBoundary;
  messageAliases: Array<{ sourceMessageId: string; childMessageId: string }>;
  idempotencyKey: string;
  createdAt?: number;
}

export interface RecordConversationRewindInput {
  sessionId: string;
  boundary: ConversationBoundary;
  anchorMessageId: string;
  /** Exact stable replay suffix, including the user anchor itself. */
  hiddenMessageIds: string[];
  rewindId: string;
  idempotencyKey: string;
  createdAt?: number;
}

export interface RecordConversationRewindRestoreInput {
  sessionId: string;
  boundary: ConversationBoundary;
  rewindId: string;
  idempotencyKey: string;
  createdAt?: number;
}

type ProjectionRepairFaultPhase = 'after_projection_write' | 'after_event_append';

export interface RepairCompatibilityProjectionInput {
  sessionId: string;
  boundary: ConversationBoundary;
  issueDigest: string;
  reason: string;
  idempotencyKey: string;
  createdAt?: number;
}

interface ConversationBranchRepositoryOptions {
  auditCompatibilityProjection?: boolean;
  projectionRepairFaultInjector?: (phase: ProjectionRepairFaultPhase) => void;
}

export class ConversationBranchRepository {
  private readonly store: ConversationBranchLedgerStore;
  private readonly auditRepository: ConversationBranchAuditRepository;
  private readonly projectionRepairRepository: ConversationProjectionRepairRepository;

  constructor(
    private readonly db: BetterSqlite3.Database,
    options: ConversationBranchRepositoryOptions = {},
  ) {
    this.store = new ConversationBranchLedgerStore(db);
    this.auditRepository = new ConversationBranchAuditRepository(
      db,
      this.store,
      options.auditCompatibilityProjection !== false,
    );
    this.projectionRepairRepository = new ConversationProjectionRepairRepository(
      db,
      this.store,
      this.auditRepository,
      options.projectionRepairFaultInjector,
    );
  }

  initializeSessionBranch(input: InitializeConversationBranchInput): ConversationBranchLineage {
    const session = this.requireSessionBoundary(input.sessionId, input.boundary);
    const existing = this.readBranchBySession(input.sessionId);
    if (existing) {
      this.requireBranchBoundary(existing, input.boundary);
      return this.toLineage(existing);
    }
    const createdAt = input.createdAt ?? Date.now();
    const branchId = conversationBranchId(input.sessionId);
    const lineage = {
      sessionId: input.sessionId,
      ownerUserId: session.user_id,
      projectId: session.project_id,
      rootBranchId: branchId,
      parentBranchId: null,
      forkId: null,
      anchorEntryId: null,
      createdAt,
    };
    this.db.prepare(`
      INSERT INTO conversation_branches (
        id, session_id, owner_user_id, project_id, root_branch_id,
        parent_branch_id, fork_id, anchor_entry_id, lineage_digest,
        schema_version, created_at
      ) VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, ?, 1, ?)
    `).run(
      branchId,
      input.sessionId,
      session.user_id,
      session.project_id,
      branchId,
      conversationSha256(canonicalConversationJson(lineage)),
      createdAt,
    );
    return this.getBranch(input.sessionId, input.boundary);
  }

  getBranch(sessionId: string, boundary: ConversationBoundary): ConversationBranchLineage {
    this.requireSessionBoundary(sessionId, boundary);
    const branch = this.readBranchBySession(sessionId);
    if (!branch) {
      throw new ConversationBranchError('BRANCH_NOT_FOUND', `no immutable branch exists for ${sessionId}`);
    }
    this.requireBranchBoundary(branch, boundary);
    return this.toLineage(branch);
  }

  appendMessage(input: AppendConversationMessageInput): ConversationReplayMessage {
    ensureMessage(input.message);
    const branch = this.requireOrInitializeBranch(input.sessionId, input.boundary);
    const payload = canonicalConversationMessagePayload(input.message as unknown as Record<string, unknown>);
    const payloadJson = canonicalConversationJson(payload);
    const payloadDigest = conversationSha256(payloadJson);
    const eventPayloadBase = {
      projectedMessageId: input.message.id,
      payloadDigest,
    };
    const existingEvent = this.readIdempotentEvent(branch.id, input.idempotencyKey);
    if (existingEvent) {
      this.requireIdempotentEvent(existingEvent, 'append', eventPayloadBase);
      return this.referenceToReplayMessage(this.requireReference(
        branch.id,
        Number(parseRecord(existingEvent.payload_json).ordinal),
      ));
    }

    return this.db.transaction(() => {
      const duplicate = this.db.prepare(`
        SELECT ordinal
        FROM conversation_branch_entries
        WHERE branch_id = ? AND projected_message_id = ?
        ORDER BY ordinal DESC
        LIMIT 1
      `).get(branch.id, input.message.id) as { ordinal: number } | undefined;
      if (duplicate) {
        throw new ConversationBranchError(
          'IDEMPOTENCY_CONFLICT',
          `message alias ${input.message.id} already exists; record a revision instead`,
        );
      }
      const ordinal = this.nextOrdinal(branch.id);
      const entryId = this.insertEntry({
        branch,
        sourceSessionId: input.sessionId,
        sourceMessageId: input.message.id,
        payloadJson,
        payloadDigest,
        provenance: input.provenance ?? { kind: 'message_append' },
        createdAt: input.createdAt ?? input.message.timestamp,
      });
      this.insertReference({
        branchId: branch.id,
        ordinal,
        entryId,
        projectedSessionId: input.sessionId,
        projectedMessageId: input.message.id,
        canonicalSourceSessionId: input.sessionId,
        canonicalSourceMessageId: input.message.id,
        aliasKind: 'native',
        createdAt: input.createdAt ?? input.message.timestamp,
      });
      this.appendEvent({
        branch,
        eventType: 'append',
        idempotencyKey: input.idempotencyKey,
        payload: { ...eventPayloadBase, ordinal, entryId },
        createdAt: input.createdAt ?? input.message.timestamp,
      });
      return this.referenceToReplayMessage(this.requireReference(branch.id, ordinal));
    })();
  }

  recordMessageRevision(input: RecordConversationMessageRevisionInput): ConversationReplayMessage {
    ensureMessage(input.revisedMessage);
    const branch = this.requireBranch(input.sessionId, input.boundary);
    // SessionRepository updates the compatibility row in the same transaction
    // before recording its immutable revision. Reading the ledger directly here
    // avoids treating that intentional, uncommitted double-write window as
    // corruption; the final public replay still audits the converged projection.
    const replay = this.replayUnchecked(branch);
    const target = [...replay.messages].reverse()
      .find((message) => message.projectedMessageId === input.targetMessageId);
    if (!target) {
      throw new ConversationBranchError('MESSAGE_NOT_FOUND', `message ${input.targetMessageId} is not active`);
    }
    const payload = canonicalConversationMessagePayload(
      input.revisedMessage as unknown as Record<string, unknown>,
    );
    const payloadJson = canonicalConversationJson(payload);
    const payloadDigest = conversationSha256(payloadJson);
    const eventPayloadBase = {
      targetOrdinal: target.ordinal,
      targetEntryId: target.entryId,
      projectedMessageId: input.targetMessageId,
      payloadDigest,
      reason: input.reason,
    };
    const existingEvent = this.readIdempotentEvent(branch.id, input.idempotencyKey);
    if (existingEvent) {
      this.requireIdempotentEvent(existingEvent, 'message_revision', eventPayloadBase);
      return this.referenceToReplayMessage(this.requireReference(
        branch.id,
        Number(parseRecord(existingEvent.payload_json).replacementOrdinal),
      ));
    }

    return this.db.transaction(() => {
      const ordinal = this.nextOrdinal(branch.id);
      const entryId = this.insertEntry({
        branch,
        sourceSessionId: target.sourceSessionId,
        sourceMessageId: target.sourceMessageId,
        payloadJson,
        payloadDigest,
        provenance: {
          kind: 'message_revision',
          targetEntryId: target.entryId,
          reason: input.reason,
        },
        createdAt: input.createdAt ?? input.revisedMessage.timestamp,
      });
      this.insertReference({
        branchId: branch.id,
        ordinal,
        entryId,
        projectedSessionId: input.sessionId,
        projectedMessageId: input.targetMessageId,
        canonicalSourceSessionId: target.sourceSessionId,
        canonicalSourceMessageId: target.sourceMessageId,
        aliasKind: 'revision',
        createdAt: input.createdAt ?? input.revisedMessage.timestamp,
      });
      this.appendEvent({
        branch,
        eventType: 'message_revision',
        idempotencyKey: input.idempotencyKey,
        payload: { ...eventPayloadBase, replacementOrdinal: ordinal, replacementEntryId: entryId },
        createdAt: input.createdAt ?? input.revisedMessage.timestamp,
      });
      return this.referenceToReplayMessage(this.requireReference(branch.id, ordinal));
    })();
  }

  recordProjectionReplacement(input: RecordConversationProjectionReplacementInput): ConversationReplay {
    for (const message of input.messages) ensureMessage(message);
    const branch = this.requireBranch(input.sessionId, input.boundary);
    const current = this.replayUnchecked(branch);
    const payloadDigests = input.messages.map((message) => conversationSha256(canonicalConversationJson(
      canonicalConversationMessagePayload(message as unknown as Record<string, unknown>),
    )));
    const eventPayloadBase = {
      previousActiveOrdinals: current.messages.map((message) => message.ordinal),
      projectedMessageIds: input.messages.map((message) => message.id),
      payloadDigests,
      reason: input.reason,
    };
    const existingEvent = this.readIdempotentEvent(branch.id, input.idempotencyKey);
    if (existingEvent) {
      this.requireIdempotentEvent(existingEvent, 'projection_replace', eventPayloadBase);
      return this.replay(input.sessionId, input.boundary);
    }

    this.db.transaction(() => {
      const ordinals: number[] = [];
      for (const [index, message] of input.messages.entries()) {
        const existingAlias = [...current.messages].reverse()
          .find((candidate) => candidate.projectedMessageId === message.id);
        const payload = canonicalConversationMessagePayload(message as unknown as Record<string, unknown>);
        const payloadJson = canonicalConversationJson(payload);
        const payloadDigest = payloadDigests[index];
        const ordinal = this.nextOrdinal(branch.id);
        const entryId = this.insertEntry({
          branch,
          sourceSessionId: existingAlias?.sourceSessionId ?? input.sessionId,
          sourceMessageId: existingAlias?.sourceMessageId ?? message.id,
          payloadJson,
          payloadDigest,
          provenance: {
            kind: 'projection_replace',
            priorEntryId: existingAlias?.entryId ?? null,
            reason: input.reason,
          },
          createdAt: input.createdAt ?? message.timestamp,
        });
        this.insertReference({
          branchId: branch.id,
          ordinal,
          entryId,
          projectedSessionId: input.sessionId,
          projectedMessageId: message.id,
          canonicalSourceSessionId: existingAlias?.sourceSessionId ?? input.sessionId,
          canonicalSourceMessageId: existingAlias?.sourceMessageId ?? message.id,
          aliasKind: 'replacement',
          createdAt: input.createdAt ?? message.timestamp,
        });
        ordinals.push(ordinal);
      }
      this.appendEvent({
        branch,
        eventType: 'projection_replace',
        idempotencyKey: input.idempotencyKey,
        payload: { ...eventPayloadBase, replacementOrdinals: ordinals },
        createdAt: input.createdAt ?? Date.now(),
      });
    })();
    return this.replay(input.sessionId, input.boundary);
  }

  createForkBranch(input: CreateConversationForkBranchInput): ConversationBranchLineage {
    const sourceBranch = this.requireBranch(input.sourceSessionId, input.boundary);
    this.requireSessionBoundary(input.childSessionId, input.boundary);
    const existingChild = this.readBranchBySession(input.childSessionId);
    if (existingChild) {
      this.requireBranchBoundary(existingChild, input.boundary);
      if (existingChild.fork_id !== input.forkId || existingChild.parent_branch_id !== sourceBranch.id) {
        throw new ConversationBranchError('INVALID_FORK', 'child session is already bound to another immutable branch');
      }
      const event = this.readIdempotentEvent(existingChild.id, input.idempotencyKey);
      if (!event) {
        throw new ConversationBranchError('IDEMPOTENCY_CONFLICT', 'fork branch exists without the requested idempotency record');
      }
      return this.toLineage(existingChild);
    }

    const source = this.replay(input.sourceSessionId, input.boundary);
    const anchorIndex = source.messages.findIndex(
      (message) => message.projectedMessageId === input.sourceAnchorMessageId,
    );
    if (anchorIndex < 0) {
      throw new ConversationBranchError('INVALID_FORK', 'fork anchor is not in the active source branch');
    }
    const prefix = source.messages.slice(0, anchorIndex + 1);
    if (
      input.messageAliases.length !== prefix.length
      || input.messageAliases.some((alias, index) => (
        alias.sourceMessageId !== prefix[index].projectedMessageId
        || !alias.childMessageId.trim()
      ))
      || input.messageAliases[input.messageAliases.length - 1]?.childMessageId !== input.childAnchorMessageId
    ) {
      throw new ConversationBranchError('INVALID_FORK', 'fork message aliases do not exactly cover the source prefix');
    }

    return this.db.transaction(() => {
      const createdAt = input.createdAt ?? Date.now();
      const branchId = conversationBranchId(input.childSessionId);
      const anchorEntryId = prefix[prefix.length - 1].entryId;
      const lineage = {
        sessionId: input.childSessionId,
        ownerUserId: input.boundary.ownerUserId,
        projectId: input.boundary.projectId,
        rootBranchId: source.lineage.rootBranchId,
        parentBranchId: sourceBranch.id,
        forkId: input.forkId,
        anchorEntryId,
        createdAt,
      };
      this.db.prepare(`
        INSERT INTO conversation_branches (
          id, session_id, owner_user_id, project_id, root_branch_id,
          parent_branch_id, fork_id, anchor_entry_id, lineage_digest,
          schema_version, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
      `).run(
        branchId,
        input.childSessionId,
        input.boundary.ownerUserId,
        input.boundary.projectId,
        source.lineage.rootBranchId,
        sourceBranch.id,
        input.forkId,
        anchorEntryId,
        conversationSha256(canonicalConversationJson(lineage)),
        createdAt,
      );
      for (const [index, sourceMessage] of prefix.entries()) {
        const alias = input.messageAliases[index];
        this.insertReference({
          branchId,
          ordinal: index,
          entryId: sourceMessage.entryId,
          projectedSessionId: input.childSessionId,
          projectedMessageId: alias.childMessageId,
          canonicalSourceSessionId: sourceMessage.sourceSessionId,
          canonicalSourceMessageId: sourceMessage.sourceMessageId,
          aliasKind: 'fork_copy',
          createdAt,
        });
      }
      const branch = this.readBranchBySession(input.childSessionId);
      if (!branch) throw new ConversationBranchError('LEDGER_CORRUPT', 'fork branch insert disappeared');
      this.appendEvent({
        branch,
        eventType: 'fork',
        idempotencyKey: input.idempotencyKey,
        payload: {
          forkId: input.forkId,
          parentSessionId: input.sourceSessionId,
          sourceAnchorMessageId: input.sourceAnchorMessageId,
          childAnchorMessageId: input.childAnchorMessageId,
          ordinals: prefix.map((_message, index) => index),
          entryIds: prefix.map((message) => message.entryId),
          aliases: input.messageAliases,
        },
        createdAt,
      });
      return this.toLineage(branch);
    })();
  }

  recordRewind(input: RecordConversationRewindInput): {
    rewindId: string;
    hiddenMessageIds: string[];
  } {
    const branch = this.requireBranch(input.sessionId, input.boundary);
    const existingEvent = this.readIdempotentEvent(branch.id, input.idempotencyKey);
    if (existingEvent) {
      const existingPayload = parseRecord(existingEvent.payload_json);
      const storedHiddenMessageIds = parseStringArray(existingPayload.hiddenMessageIds);
      this.requireIdempotentEvent(existingEvent, 'rewind', {
        rewindId: input.rewindId,
        anchorMessageId: input.anchorMessageId,
        hiddenMessageIds: input.hiddenMessageIds,
      });
      return { rewindId: input.rewindId, hiddenMessageIds: storedHiddenMessageIds };
    }
    const current = this.replayUnchecked(branch);
    const anchorIndex = current.messages.findIndex(
      (message) => message.projectedMessageId === input.anchorMessageId,
    );
    if (anchorIndex < 0 || current.messages[anchorIndex].message.role !== 'user') {
      throw new ConversationBranchError(
        'INVALID_REWIND',
        'rewind anchor must be a currently visible user message',
      );
    }
    const hidden = current.messages.slice(anchorIndex);
    const exactHiddenMessageIds = hidden.map((message) => message.projectedMessageId);
    if (
      input.hiddenMessageIds.length !== exactHiddenMessageIds.length
      || input.hiddenMessageIds.some((messageId, index) => messageId !== exactHiddenMessageIds[index])
    ) {
      throw new ConversationBranchError(
        'INVALID_REWIND',
        'hiddenMessageIds must exactly equal the stable replay suffix including the user anchor',
        { expectedHiddenMessageIds: exactHiddenMessageIds },
      );
    }
    const payload = {
      rewindId: input.rewindId,
      anchorOrdinal: current.messages[anchorIndex].ordinal,
      anchorEntryId: current.messages[anchorIndex].entryId,
      anchorMessageId: input.anchorMessageId,
      hiddenMessageIds: exactHiddenMessageIds,
      hidden: hidden.map((message) => ({
        ordinal: message.ordinal,
        entryId: message.entryId,
        projectedMessageId: message.projectedMessageId,
      })),
    };
    this.appendEvent({
      branch,
      eventType: 'rewind',
      idempotencyKey: input.idempotencyKey,
      payload,
      createdAt: input.createdAt ?? Date.now(),
    });
    return {
      rewindId: input.rewindId,
      hiddenMessageIds: exactHiddenMessageIds,
    };
  }

  recordRewindRestore(input: RecordConversationRewindRestoreInput): ConversationReplay {
    const branch = this.requireBranch(input.sessionId, input.boundary);
    const existingEvent = this.readIdempotentEvent(branch.id, input.idempotencyKey);
    if (existingEvent) {
      this.requireIdempotentEvent(existingEvent, 'rewind_restore', { rewindId: input.rewindId });
      return this.replay(input.sessionId, input.boundary);
    }
    const current = this.replayUnchecked(branch);
    if (current.openRewindIds[current.openRewindIds.length - 1] !== input.rewindId) {
      throw new ConversationBranchError(
        'REWIND_ORDER_CONFLICT',
        'only the most recent open rewind can be restored',
      );
    }
    this.appendEvent({
      branch,
      eventType: 'rewind_restore',
      idempotencyKey: input.idempotencyKey,
      payload: { rewindId: input.rewindId },
      createdAt: input.createdAt ?? Date.now(),
    });
    return this.replayUnchecked(branch);
  }

  replay(
    sessionId: string,
    boundary: ConversationBoundary,
    options: { includeRewound?: boolean; allowRepairOverride?: boolean } = {},
  ): ConversationReplay {
    const branch = this.requireBranch(sessionId, boundary);
    const audit = this.auditLineage(sessionId, boundary);
    if (
      audit.status === 'quarantined'
      || (audit.status === 'override_active' && !options.allowRepairOverride)
    ) {
      throw new ConversationBranchError(
        'BRANCH_QUARANTINED',
        `branch ${branch.id} has unresolved lineage findings: ${audit.issues
          .map((issue) => issue.code)
          .join(', ')}`,
        { issueDigest: audit.issueDigest, status: audit.status, issues: audit.issues },
      );
    }
    return this.replayUnchecked(branch, options);
  }

  private replayUnchecked(
    branch: BranchRow,
    options: { includeRewound?: boolean } = {},
  ): ConversationReplay {
    const references = this.readReferences(branch.id);
    const events = this.readEvents(branch.id);
    return this.replayFromRows(branch, references, events, options);
  }

  compareBranches(input: {
    leftSessionId: string;
    rightSessionId: string;
    boundary: ConversationBoundary;
  }): ConversationBranchComparison {
    const left = this.replay(input.leftSessionId, input.boundary);
    const right = this.replay(input.rightSessionId, input.boundary);
    let sharedPrefixLength = 0;
    while (
      sharedPrefixLength < left.messages.length
      && sharedPrefixLength < right.messages.length
      && left.messages[sharedPrefixLength].entryId === right.messages[sharedPrefixLength].entryId
    ) {
      sharedPrefixLength += 1;
    }
    return {
      left: left.lineage,
      right: right.lineage,
      sharedPrefixLength,
      sharedEntryIds: left.messages.slice(0, sharedPrefixLength).map((message) => message.entryId),
      leftOnly: left.messages.slice(sharedPrefixLength),
      rightOnly: right.messages.slice(sharedPrefixLength),
    };
  }

  traceProvenance(input: {
    sessionId: string;
    messageId: string;
    boundary: ConversationBoundary;
  }): ConversationProvenanceTrace {
    const replay = this.replay(input.sessionId, input.boundary, {
      includeRewound: true,
      allowRepairOverride: true,
    });
    const message = [...replay.messages].reverse()
      .find((candidate) => candidate.projectedMessageId === input.messageId);
    if (!message) {
      throw new ConversationBranchError('MESSAGE_NOT_FOUND', `message ${input.messageId} is not in the branch`);
    }
    const entryRow = this.db.prepare(`
      SELECT *
      FROM conversation_entries
      WHERE id = ?
    `).get(message.entryId) as SQLiteRow | undefined;
    if (!entryRow) {
      throw new ConversationBranchError('ENTRY_NOT_FOUND', `entry ${message.entryId} is missing`);
    }
    const aliases = this.db.prepare(`
      SELECT r.branch_id, b.session_id, r.projected_message_id, r.ordinal, r.alias_kind
      FROM conversation_branch_entries r
      JOIN conversation_branches b ON b.id = r.branch_id
      WHERE r.entry_id = ?
        AND b.owner_user_id IS ?
        AND b.project_id IS ?
      ORDER BY b.created_at ASC, r.ordinal ASC
    `).all(message.entryId, input.boundary.ownerUserId, input.boundary.projectId) as SQLiteRow[];
    return {
      entry: this.toEntryRecord(entryRow),
      canonicalSource: {
        sessionId: message.sourceSessionId,
        messageId: message.sourceMessageId,
      },
      aliases: aliases.map((alias) => ({
        branchId: String(alias.branch_id),
        sessionId: String(alias.session_id),
        messageId: String(alias.projected_message_id),
        ordinal: Number(alias.ordinal),
        aliasKind: String(alias.alias_kind) as ConversationReplayMessage['aliasKind'],
      })),
      branchPath: this.branchPath(this.requireBranch(input.sessionId, input.boundary), input.boundary),
    };
  }

  recordEvaluationAttribution(input: {
    sessionId: string;
    boundary: ConversationBoundary;
    evaluationId: string;
    runId?: string | null;
    metric: string;
    value: number;
    attributedMessageIds: string[];
    idempotencyKey: string;
    createdAt?: number;
  }): ConversationEvaluationAttribution {
    if (!Number.isFinite(input.value) || !input.evaluationId.trim() || !input.metric.trim()) {
      throw new ConversationBranchError('LEDGER_CORRUPT', 'invalid evaluation attribution');
    }
    const branch = this.requireBranch(input.sessionId, input.boundary);
    const replay = this.replay(input.sessionId, input.boundary, { allowRepairOverride: true });
    const entryIds = input.attributedMessageIds.map((messageId) => {
      const message = [...replay.messages].reverse()
        .find((candidate) => candidate.projectedMessageId === messageId);
      if (!message) throw new ConversationBranchError('MESSAGE_NOT_FOUND', `message ${messageId} is not active`);
      return message.entryId;
    });
    const result = this.appendEvent({
      branch,
      eventType: 'evaluation_attribution',
      idempotencyKey: input.idempotencyKey,
      payload: {
        evaluationId: input.evaluationId,
        runId: input.runId ?? null,
        metric: input.metric,
        value: input.value,
        entryIds,
      },
      createdAt: input.createdAt ?? Date.now(),
    });
    return this.eventToEvaluation(result.event);
  }

  listEvaluationAttributions(
    sessionId: string,
    boundary: ConversationBoundary,
  ): ConversationEvaluationAttribution[] {
    const branch = this.requireBranch(sessionId, boundary);
    return this.readEvents(branch.id)
      .filter((event) => event.event_type === 'evaluation_attribution')
      .map((event) => this.eventToEvaluation(event));
  }

  auditLineage(
    sessionId: string,
    boundary: ConversationBoundary,
  ): ConversationLineageAudit {
    return this.auditRepository.auditLineage(sessionId, boundary);
  }

  auditAndQuarantine(input: {
    sessionId: string;
    boundary: ConversationBoundary;
    idempotencyKey: string;
    createdAt?: number;
  }): ConversationLineageAudit {
    return this.auditRepository.auditAndQuarantine(input);
  }

  recordRepairOverride(input: {
    sessionId: string;
    boundary: ConversationBoundary;
    issueDigest: string;
    reason: string;
    idempotencyKey: string;
    createdAt?: number;
  }): ConversationLineageAudit {
    return this.auditRepository.recordRepairOverride(input);
  }

  repairCompatibilityProjection(
    input: RepairCompatibilityProjectionInput,
  ): ConversationLineageAudit {
    return this.projectionRepairRepository.repairCompatibilityProjection(input);
  }

  getRawLedgerCounts(
    sessionId: string,
    boundary: ConversationBoundary,
  ): { entries: number; references: number; events: number } {
    const branch = this.requireBranch(sessionId, boundary);
    const row = this.db.prepare(`
      SELECT
        (SELECT COUNT(DISTINCT entry_id) FROM conversation_branch_entries WHERE branch_id = ?) AS entries,
        (SELECT COUNT(*) FROM conversation_branch_entries WHERE branch_id = ?) AS refs,
        (SELECT COUNT(*) FROM conversation_branch_events WHERE branch_id = ?) AS events
    `).get(branch.id, branch.id, branch.id) as {
      entries: number;
      refs: number;
      events: number;
    };
    return { entries: Number(row.entries), references: Number(row.refs), events: Number(row.events) };
  }

  private requireSessionBoundary(
    sessionId: string,
    boundary: ConversationBoundary,
  ): SessionBoundaryRow {
    return this.store.requireSessionBoundary(sessionId, boundary);
  }

  private requireBranch(
    sessionId: string,
    boundary: ConversationBoundary,
  ): BranchRow {
    return this.store.requireBranch(sessionId, boundary);
  }

  private requireOrInitializeBranch(
    sessionId: string,
    boundary: ConversationBoundary,
  ): BranchRow {
    this.store.requireSessionBoundary(sessionId, boundary);
    let branch = this.store.readBranchBySession(sessionId);
    if (!branch) {
      this.initializeSessionBranch({ sessionId, boundary });
      branch = this.store.readBranchBySession(sessionId);
    }
    if (!branch) {
      throw new ConversationBranchError(
        'BRANCH_NOT_FOUND',
        `branch for ${sessionId} was not created`,
      );
    }
    this.store.requireBranchBoundary(branch, boundary);
    return branch;
  }

  private requireBranchBoundary(
    branch: BranchRow,
    boundary: ConversationBoundary,
  ): void {
    this.store.requireBranchBoundary(branch, boundary);
  }

  private readBranchBySession(sessionId: string): BranchRow | undefined {
    return this.store.readBranchBySession(sessionId);
  }

  private toLineage(branch: BranchRow): ConversationBranchLineage {
    return this.store.toLineage(branch);
  }

  private readReferences(branchId: string): ReferenceRow[] {
    return this.store.readReferences(branchId);
  }

  private requireReference(branchId: string, ordinal: number): ReferenceRow {
    return this.store.requireReference(branchId, ordinal);
  }

  private referenceToReplayMessage(
    reference: ReferenceRow,
  ): ConversationReplayMessage {
    return this.store.referenceToReplayMessage(reference);
  }

  private nextOrdinal(branchId: string): number {
    return this.store.nextOrdinal(branchId);
  }

  private insertEntry(
    input: Parameters<ConversationBranchLedgerStore['insertEntry']>[0],
  ): string {
    return this.store.insertEntry(input);
  }

  private insertReference(
    input: Parameters<ConversationBranchLedgerStore['insertReference']>[0],
  ): void {
    this.store.insertReference(input);
  }

  private readEvents(branchId: string): EventRow[] {
    return this.store.readEvents(branchId);
  }

  private readIdempotentEvent(
    branchId: string,
    idempotencyKey: string,
  ): EventRow | undefined {
    return this.store.readIdempotentEvent(branchId, idempotencyKey);
  }

  private requireIdempotentEvent(
    event: EventRow,
    eventType: string,
    payloadSubset: Record<string, unknown>,
  ): void {
    this.store.requireIdempotentEvent(event, eventType, payloadSubset);
  }

  private appendEvent(
    input: Parameters<ConversationBranchLedgerStore['appendEvent']>[0],
  ): AppendEventResult {
    return this.store.appendEvent(input);
  }

  private toEntryRecord(row: SQLiteRow): ConversationEntryRecord {
    return this.store.toEntryRecord(row);
  }

  private eventToEvaluation(
    event: EventRow,
  ): ConversationEvaluationAttribution {
    return this.store.eventToEvaluation(event);
  }

  private branchPath(
    branch: BranchRow,
    boundary: ConversationBoundary,
  ): ConversationBranchLineage[] {
    return this.store.branchPath(branch, boundary);
  }

  private replayFromRows(
    branch: BranchRow,
    references: ReferenceRow[],
    events: EventRow[],
    options: { includeRewound?: boolean } = {},
  ): ConversationReplay {
    return this.store.replayFromRows(branch, references, events, options);
  }
}

export { ConversationBranchError };
