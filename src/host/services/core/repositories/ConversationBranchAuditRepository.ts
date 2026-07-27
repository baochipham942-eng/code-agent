import type BetterSqlite3 from 'better-sqlite3';

import {
  ConversationBranchError,
  type ConversationBoundary,
  type ConversationLineageAudit,
  type ConversationLineageIssue,
} from '../../../../shared/contract/conversationBranch';
import {
  canonicalConversationJson,
  canonicalConversationMessagePayload,
  conversationEventDigest,
  conversationLineageIssueDigest,
  conversationSha256,
} from '../database/schemaConversationBranch';
import { sanitizeConversationMessageSnapshot } from '../conversationMessageSnapshot';
import {
  ConversationBranchLedgerStore,
  conversationBoundaryEquals,
  parseConversationRecord,
  parseConversationStringArray,
  type ConversationBranchRow,
  type ConversationEventRow,
  type ConversationReferenceRow,
  type ConversationSQLiteRow,
} from './ConversationBranchLedgerStore';
import { rowToMessage } from './sessionRepositoryParsers';

export class ConversationBranchAuditRepository {
  constructor(
    private readonly db: BetterSqlite3.Database,
    private readonly store: ConversationBranchLedgerStore,
    private readonly auditCompatibilityProjection = true,
  ) {}

  auditLineage(
    sessionId: string,
    boundary: ConversationBoundary,
  ): ConversationLineageAudit {
    const branch = this.store.requireBranch(sessionId, boundary);
    const issues: ConversationLineageIssue[] = [];
    const references = this.store.readReferences(branch.id);
    const events = this.store.readEvents(branch.id);
    this.auditBranchIdentity(branch, issues);
    this.auditRoot(branch, issues);
    const parentBranch = this.auditParent(branch, issues);
    this.auditReferences(branch, references, issues);
    this.auditEvents(branch, events, issues);
    this.auditAncestry(branch, issues);
    this.auditFork(branch, parentBranch, references, events, issues);
    this.auditActiveProjectionAliases(branch, references, events, issues);
    return this.resolveAuditState(branch, events, issues);
  }

  auditAndQuarantine(input: {
    sessionId: string;
    boundary: ConversationBoundary;
    idempotencyKey: string;
    createdAt?: number;
  }): ConversationLineageAudit {
    const audit = this.auditLineage(input.sessionId, input.boundary);
    if (audit.issues.length === 0) return audit;
    const branch = this.store.requireBranch(input.sessionId, input.boundary);
    this.store.appendEvent({
      branch,
      eventType: 'quarantine',
      idempotencyKey: input.idempotencyKey,
      payload: {
        issueDigest: audit.issueDigest,
        issues: audit.issues,
      },
      createdAt: input.createdAt ?? Date.now(),
    });
    return this.auditLineage(input.sessionId, input.boundary);
  }

  recordRepairOverride(input: {
    sessionId: string;
    boundary: ConversationBoundary;
    issueDigest: string;
    reason: string;
    idempotencyKey: string;
    createdAt?: number;
  }): ConversationLineageAudit {
    const audit = this.auditLineage(input.sessionId, input.boundary);
    if (
      audit.status !== 'quarantined'
      || audit.issueDigest !== input.issueDigest
      || !audit.quarantineEventId
      || input.reason.trim().length < 16
    ) {
      throw new ConversationBranchError(
        'REPAIR_OVERRIDE_REJECTED',
        'repair override requires the exact quarantined issue digest and a substantive reason',
      );
    }
    const branch = this.store.requireBranch(input.sessionId, input.boundary);
    this.store.appendEvent({
      branch,
      eventType: 'repair_override',
      idempotencyKey: input.idempotencyKey,
      payload: {
        issueDigest: input.issueDigest,
        quarantineEventId: audit.quarantineEventId,
        reason: input.reason.trim(),
      },
      createdAt: input.createdAt ?? Date.now(),
    });
    return this.auditLineage(input.sessionId, input.boundary);
  }

  private auditBranchIdentity(
    branch: ConversationBranchRow,
    issues: ConversationLineageIssue[],
  ): void {
    const expectedLineageDigest = conversationSha256(canonicalConversationJson({
      sessionId: branch.session_id,
      ownerUserId: branch.owner_user_id,
      projectId: branch.project_id,
      rootBranchId: branch.root_branch_id,
      parentBranchId: branch.parent_branch_id,
      forkId: branch.fork_id,
      anchorEntryId: branch.anchor_entry_id,
      createdAt: branch.created_at,
    }));
    if (branch.lineage_digest !== expectedLineageDigest) {
      issues.push({
        code: 'BRANCH_LINEAGE_DIGEST_MISMATCH',
        detail: `branch ${branch.id} lineage digest does not match its immutable metadata`,
        branchId: branch.id,
      });
    }
  }

  private auditRoot(
    branch: ConversationBranchRow,
    issues: ConversationLineageIssue[],
  ): void {
    const rootBranch = this.store.readBranchById(branch.root_branch_id);
    if (!rootBranch) {
      issues.push({
        code: 'ROOT_BRANCH_MISSING',
        detail: `declared root branch ${branch.root_branch_id} does not exist`,
        branchId: branch.id,
      });
      return;
    }
    if (
      rootBranch.id !== rootBranch.root_branch_id
      || rootBranch.parent_branch_id !== null
      || rootBranch.fork_id !== null
      || rootBranch.anchor_entry_id !== null
    ) {
      issues.push({
        code: 'ROOT_BRANCH_MISMATCH',
        detail: `declared root branch ${rootBranch.id} is not a root lineage record`,
        branchId: branch.id,
      });
    }
    if (
      !conversationBoundaryEquals(rootBranch.owner_user_id, branch.owner_user_id)
      || !conversationBoundaryEquals(rootBranch.project_id, branch.project_id)
    ) {
      issues.push({
        code: 'BRANCH_BOUNDARY_MISMATCH',
        detail: `declared root branch ${rootBranch.id} crosses the owner or project boundary`,
        branchId: branch.id,
      });
    }
  }

  private auditParent(
    branch: ConversationBranchRow,
    issues: ConversationLineageIssue[],
  ): ConversationBranchRow | undefined {
    const parentBranch = branch.parent_branch_id
      ? this.store.readBranchById(branch.parent_branch_id)
      : undefined;
    if (branch.parent_branch_id && !parentBranch) {
      issues.push({
        code: 'PARENT_BRANCH_MISSING',
        detail: `declared parent branch ${branch.parent_branch_id} does not exist`,
        branchId: branch.id,
      });
    }
    return parentBranch;
  }

  private auditReferences(
    branch: ConversationBranchRow,
    references: ConversationReferenceRow[],
    issues: ConversationLineageIssue[],
  ): void {
    references.forEach((reference, index) => {
      if (reference.ordinal !== index) {
        issues.push({
          code: 'REFERENCE_SEQUENCE_GAP',
          detail: `reference ordinal ${reference.ordinal} was expected to be ${index}`,
          branchId: branch.id,
          ordinal: reference.ordinal,
          entryId: reference.entry_id,
        });
      }
      if (
        !conversationBoundaryEquals(reference.entry_owner_user_id, branch.owner_user_id)
        || !conversationBoundaryEquals(reference.entry_project_id, branch.project_id)
      ) {
        issues.push({
          code: 'ENTRY_BOUNDARY_MISMATCH',
          detail: `entry ${reference.entry_id} crosses the branch owner or project boundary`,
          branchId: branch.id,
          ordinal: reference.ordinal,
          entryId: reference.entry_id,
        });
      }
      if (conversationSha256(reference.message_json) !== reference.payload_digest) {
        issues.push({
          code: 'ENTRY_BOUNDARY_MISMATCH',
          detail: `entry ${reference.entry_id} payload digest does not match its immutable payload`,
          branchId: branch.id,
          ordinal: reference.ordinal,
          entryId: reference.entry_id,
        });
      }
    });
  }

  private auditEvents(
    branch: ConversationBranchRow,
    events: ConversationEventRow[],
    issues: ConversationLineageIssue[],
  ): void {
    let previousDigest: string | null = null;
    events.forEach((event, index) => {
      if (event.sequence !== index + 1) {
        issues.push({
          code: 'EVENT_SEQUENCE_GAP',
          detail: `event sequence ${event.sequence} was expected to be ${index + 1}`,
          branchId: branch.id,
          eventId: event.id,
        });
      }
      const payloadDigest = conversationSha256(event.payload_json);
      if (payloadDigest !== event.payload_digest) {
        issues.push({
          code: 'EVENT_PAYLOAD_DIGEST_MISMATCH',
          detail: `event ${event.id} payload digest is invalid`,
          branchId: branch.id,
          eventId: event.id,
        });
      }
      if (event.previous_event_digest !== previousDigest) {
        issues.push({
          code: 'EVENT_CHAIN_MISMATCH',
          detail: `event ${event.id} does not point to the prior immutable event`,
          branchId: branch.id,
          eventId: event.id,
        });
      }
      const expectedEventDigest = conversationEventDigest({
        id: event.id,
        branchId: event.branch_id,
        sequence: event.sequence,
        eventType: event.event_type,
        payloadDigest: event.payload_digest,
        previousEventDigest: event.previous_event_digest,
        createdAt: event.created_at,
      });
      if (expectedEventDigest !== event.event_digest) {
        issues.push({
          code: 'EVENT_DIGEST_MISMATCH',
          detail: `event ${event.id} hash is invalid`,
          branchId: branch.id,
          eventId: event.id,
        });
      }
      if (event.event_type === 'projection_repair') {
        this.auditProjectionRepairEvent(branch, event, events, issues);
      }
      previousDigest = event.event_digest;
    });
  }

  private auditProjectionRepairEvent(
    branch: ConversationBranchRow,
    event: ConversationEventRow,
    events: ConversationEventRow[],
    issues: ConversationLineageIssue[],
  ): void {
    const payload = parseConversationRecord(event.payload_json);
    const quarantineEvent = typeof payload.quarantineEventId === 'string'
      ? events.find((candidate) => candidate.id === payload.quarantineEventId)
      : undefined;
    const quarantinePayload = quarantineEvent
      ? parseConversationRecord(quarantineEvent.payload_json)
      : {};
    const countFields = [
      'expectedActiveCount',
      'previousActiveCount',
      'insertedCount',
      'updatedCount',
      'softHiddenCount',
      'reorderedCount',
      'recalibratedForkMappingCount',
    ];
    const invalidPayload = typeof payload.issueDigest !== 'string'
      || !/^[a-f0-9]{64}$/u.test(payload.issueDigest)
      || typeof payload.reason !== 'string'
      || payload.reason.trim().length < 16
      || typeof payload.previousProjectionDigest !== 'string'
      || !/^[a-f0-9]{64}$/u.test(payload.previousProjectionDigest)
      || typeof payload.repairedProjectionDigest !== 'string'
      || !/^[a-f0-9]{64}$/u.test(payload.repairedProjectionDigest)
      || countFields.some((field) => (
        !Number.isInteger(payload[field]) || Number(payload[field]) < 0
      ))
      || quarantineEvent?.event_type !== 'quarantine'
      || (quarantineEvent?.sequence ?? Number.MAX_SAFE_INTEGER) >= event.sequence
      || quarantinePayload.issueDigest !== payload.issueDigest;
    if (invalidPayload) {
      issues.push({
        code: 'EVENT_PAYLOAD_INVALID',
        detail: `projection repair event ${event.id} does not reference a valid prior quarantine and count-only repair payload`,
        branchId: branch.id,
        eventId: event.id,
      });
    }
  }

  private auditAncestry(
    branch: ConversationBranchRow,
    issues: ConversationLineageIssue[],
  ): void {
    const visited = new Set<string>();
    let cursor: ConversationBranchRow | undefined = branch;
    let terminalBranchId: string | null = null;
    while (cursor) {
      if (visited.has(cursor.id)) {
        issues.push({
          code: 'BRANCH_LINEAGE_CYCLE',
          detail: `branch ancestry contains a cycle at ${cursor.id}`,
          branchId: branch.id,
        });
        break;
      }
      visited.add(cursor.id);
      if (cursor.id !== branch.id) this.auditAncestorIdentity(branch, cursor, issues);
      if (cursor.root_branch_id !== branch.root_branch_id) {
        issues.push({
          code: 'ROOT_BRANCH_MISMATCH',
          detail: `ancestor branch ${cursor.id} declares root ${cursor.root_branch_id}`,
          branchId: branch.id,
        });
      }
      if (
        !conversationBoundaryEquals(cursor.owner_user_id, branch.owner_user_id)
        || !conversationBoundaryEquals(cursor.project_id, branch.project_id)
      ) {
        issues.push({
          code: 'BRANCH_BOUNDARY_MISMATCH',
          detail: `ancestor branch ${cursor.id} crosses the owner or project boundary`,
          branchId: branch.id,
        });
      }
      if (!cursor.parent_branch_id) {
        terminalBranchId = cursor.id;
        break;
      }
      cursor = this.store.readBranchById(cursor.parent_branch_id);
    }
    if (terminalBranchId !== branch.root_branch_id) {
      issues.push({
        code: 'ROOT_BRANCH_MISMATCH',
        detail: `branch ancestry terminates at ${terminalBranchId ?? 'missing parent'} instead of ${branch.root_branch_id}`,
        branchId: branch.id,
      });
    }
  }

  private auditAncestorIdentity(
    branch: ConversationBranchRow,
    cursor: ConversationBranchRow,
    issues: ConversationLineageIssue[],
  ): void {
    const ancestorLineageDigest = conversationSha256(canonicalConversationJson({
      sessionId: cursor.session_id,
      ownerUserId: cursor.owner_user_id,
      projectId: cursor.project_id,
      rootBranchId: cursor.root_branch_id,
      parentBranchId: cursor.parent_branch_id,
      forkId: cursor.fork_id,
      anchorEntryId: cursor.anchor_entry_id,
      createdAt: cursor.created_at,
    }));
    if (cursor.lineage_digest !== ancestorLineageDigest) {
      issues.push({
        code: 'BRANCH_LINEAGE_DIGEST_MISMATCH',
        detail: `ancestor branch ${cursor.id} lineage digest is invalid`,
        branchId: branch.id,
      });
    }
  }

  private auditFork(
    branch: ConversationBranchRow,
    parentBranch: ConversationBranchRow | undefined,
    references: ConversationReferenceRow[],
    events: ConversationEventRow[],
    issues: ConversationLineageIssue[],
  ): void {
    if (!branch.parent_branch_id) {
      if (branch.fork_id || branch.anchor_entry_id) {
        issues.push({
          code: 'FORK_ANCHOR_MISMATCH',
          detail: `root branch ${branch.id} carries fork or anchor metadata without a parent`,
          branchId: branch.id,
          entryId: branch.anchor_entry_id ?? undefined,
        });
      }
      return;
    }
    const parentReferences = parentBranch ? this.store.readReferences(parentBranch.id) : [];
    const parentEntryIds = new Set(parentReferences.map((reference) => reference.entry_id));
    const forkEvent = events.find((event) => event.event_type === 'fork');
    const forkEventPayload = forkEvent
      ? parseConversationRecord(forkEvent.payload_json)
      : {};
    const eventPrefixEntryIds = parseConversationStringArray(forkEventPayload.entryIds);
    const legacyAnchorIndex = branch.anchor_entry_id
      ? parentReferences.findIndex((reference) => reference.entry_id === branch.anchor_entry_id)
      : -1;
    const expectedPrefixEntryIds = eventPrefixEntryIds.length > 0
      ? eventPrefixEntryIds
      : legacyAnchorIndex >= 0
        ? parentReferences.slice(0, legacyAnchorIndex + 1)
          .map((reference) => reference.entry_id)
        : [];
    this.auditForkIdentity(branch, forkEvent, forkEventPayload, parentEntryIds, issues);
    this.auditForkPrefix(branch, parentBranch, references, expectedPrefixEntryIds, parentEntryIds, issues);
    this.auditLegacyForkAliases(branch, references, issues);
  }

  private auditForkIdentity(
    branch: ConversationBranchRow,
    forkEvent: ConversationEventRow | undefined,
    forkEventPayload: Record<string, unknown>,
    parentEntryIds: Set<string>,
    issues: ConversationLineageIssue[],
  ): void {
    if (!branch.fork_id) {
      issues.push({
        code: 'FORK_ANCHOR_MISMATCH',
        detail: `branch ${branch.id} has a parent but no explicit fork identity`,
        branchId: branch.id,
      });
    }
    if (
      forkEvent
      && typeof forkEventPayload.forkId === 'string'
      && forkEventPayload.forkId !== branch.fork_id
    ) {
      issues.push({
        code: 'EVENT_PAYLOAD_INVALID',
        detail: `fork event ${forkEvent.id} belongs to ${String(forkEventPayload.forkId)} instead of ${String(branch.fork_id)}`,
        branchId: branch.id,
        eventId: forkEvent.id,
      });
    }
    if (!branch.anchor_entry_id) {
      issues.push({
        code: 'FORK_ANCHOR_MISSING',
        detail: `fork branch ${branch.id} has no immutable anchor entry`,
        branchId: branch.id,
      });
    } else if (!parentEntryIds.has(branch.anchor_entry_id)) {
      issues.push({
        code: 'FORK_ANCHOR_MISMATCH',
        detail: `fork anchor ${branch.anchor_entry_id} is not present in the declared parent`,
        branchId: branch.id,
        entryId: branch.anchor_entry_id,
      });
    }
  }

  private auditForkPrefix(
    branch: ConversationBranchRow,
    parentBranch: ConversationBranchRow | undefined,
    references: ConversationReferenceRow[],
    expectedPrefixEntryIds: string[],
    parentEntryIds: Set<string>,
    issues: ConversationLineageIssue[],
  ): void {
    const expectedPrefixLength = expectedPrefixEntryIds.length;
    const forkCopies = references.filter((reference) => reference.alias_kind === 'fork_copy');
    const prefixIsContiguous = Boolean(
      parentBranch
      && expectedPrefixLength > 0
      && forkCopies.length === expectedPrefixLength
      && references.slice(0, expectedPrefixLength).every(
        (reference, index) => (
          reference.ordinal === index && reference.alias_kind === 'fork_copy'
        ),
      )
      && references.slice(expectedPrefixLength).every(
        (reference) => reference.alias_kind !== 'fork_copy',
      )
    );
    if (!prefixIsContiguous) {
      issues.push({
        code: 'FORK_PREFIX_NOT_CONTIGUOUS',
        detail: `fork copies do not continuously cover the ${expectedPrefixLength} immutable entries captured at fork time`,
        branchId: branch.id,
      });
    }
    if (
      branch.anchor_entry_id
      && (
        forkCopies[forkCopies.length - 1]?.entry_id !== branch.anchor_entry_id
        || !parentBranch
      )
    ) {
      issues.push({
        code: 'FORK_ANCHOR_MISMATCH',
        detail: `fork copy prefix does not terminate at anchor ${branch.anchor_entry_id}`,
        branchId: branch.id,
        entryId: branch.anchor_entry_id,
      });
    }
    forkCopies.forEach((reference, index) => {
      if (
        expectedPrefixEntryIds[index] !== reference.entry_id
        || !parentEntryIds.has(reference.entry_id)
      ) {
        issues.push({
          code: 'FORK_PREFIX_ENTRY_MISMATCH',
          detail: `fork reference ${reference.ordinal} does not share its captured parent entry`,
          branchId: branch.id,
          ordinal: reference.ordinal,
          entryId: reference.entry_id,
        });
      }
    });
  }

  private auditActiveProjectionAliases(
    branch: ConversationBranchRow,
    references: ConversationReferenceRow[],
    events: ConversationEventRow[],
    issues: ConversationLineageIssue[],
  ): void {
    if (!this.auditCompatibilityProjection) return;
    const table = this.db.prepare(`
      SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'messages'
    `).get();
    if (!table) return;
    const replay = this.store.replayFromRows(branch, references, events);
    const activeRows = this.db.prepare(`
      SELECT rowid AS __rowid, *
      FROM messages
      WHERE session_id = ? AND COALESCE(visibility, 'active') = 'active'
      ORDER BY timestamp ASC, rowid ASC
    `).all(branch.session_id) as ConversationSQLiteRow[];
    const byOrdinal = new Map(references.map((reference) => [reference.ordinal, reference]));
    for (const [index, replayMessage] of replay.messages.entries()) {
      const reference = byOrdinal.get(replayMessage.ordinal);
      if (!reference) {
        issues.push({
          code: 'EVENT_PAYLOAD_INVALID',
          detail: `active ordinal ${replayMessage.ordinal} has no immutable reference`,
          branchId: branch.id,
          ordinal: replayMessage.ordinal,
        });
        continue;
      }
      const projected = activeRows[index];
      if (!projected) {
        issues.push({
          code: 'PROJECTION_ALIAS_MISSING',
          detail: `active message alias ${reference.projected_message_id} is missing`,
          branchId: branch.id,
          ordinal: reference.ordinal,
          entryId: reference.entry_id,
        });
        continue;
      }
      if (String(projected.id) !== reference.projected_message_id) {
        issues.push({
          code: 'PROJECTION_ALIAS_ORDER_MISMATCH',
          detail: `active projection index ${index} is ${String(projected.id)} instead of ${reference.projected_message_id}`,
          branchId: branch.id,
          ordinal: reference.ordinal,
          entryId: reference.entry_id,
        });
        continue;
      }
      const payloadDigest = conversationSha256(canonicalConversationJson(
        canonicalConversationMessagePayload(
          sanitizeConversationMessageSnapshot(rowToMessage(projected)) as unknown as Record<string, unknown>,
        ),
      ));
      if (payloadDigest !== reference.payload_digest) {
        issues.push({
          code: 'PROJECTION_ALIAS_PAYLOAD_MISMATCH',
          detail: `active message alias ${reference.projected_message_id} diverges from its canonical entry`,
          branchId: branch.id,
          ordinal: reference.ordinal,
          entryId: reference.entry_id,
        });
      }
    }
    for (const extra of activeRows.slice(replay.messages.length)) {
      issues.push({
        code: 'PROJECTION_ALIAS_EXTRA',
        detail: `active compatibility message ${String(extra.id)} has no active immutable alias`,
        branchId: branch.id,
      });
    }
  }

  private auditLegacyForkAliases(
    branch: ConversationBranchRow,
    references: ConversationReferenceRow[],
    issues: ConversationLineageIssue[],
  ): void {
    const tables = this.db.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table' AND name IN ('session_forks', 'session_fork_message_map')
    `).all() as Array<{ name: string }>;
    if (tables.length !== 2 || !branch.fork_id) return;
    const mappings = this.db.prepare(`
      SELECT ordinal, source_message_id, child_message_id
      FROM session_fork_message_map
      WHERE fork_id = ?
      ORDER BY ordinal ASC
    `).all(branch.fork_id) as Array<{
      ordinal: number;
      source_message_id: string;
      child_message_id: string;
    }>;
    for (const mapping of mappings) {
      const reference = references[mapping.ordinal];
      if (
        reference?.projected_message_id !== mapping.child_message_id
        || reference?.canonical_source_message_id !== mapping.source_message_id
      ) {
        issues.push({
          code: 'FORK_ALIAS_MISMATCH',
          detail: `fork alias mapping at ordinal ${mapping.ordinal} diverges from the compatibility mapping`,
          branchId: branch.id,
          ordinal: mapping.ordinal,
          entryId: reference?.entry_id,
        });
      }
    }
  }

  private resolveAuditState(
    branch: ConversationBranchRow,
    events: ConversationEventRow[],
    issues: ConversationLineageIssue[],
  ): ConversationLineageAudit {
    const quarantineEvents = events.filter((event) => event.event_type === 'quarantine');
    const repairEvents = events.filter((event) => event.event_type === 'repair_override');
    const quarantine = quarantineEvents[quarantineEvents.length - 1];
    if (quarantine) {
      const quarantinePayload = parseConversationRecord(quarantine.payload_json);
      if (quarantinePayload.sticky === true && Array.isArray(quarantinePayload.issues)) {
        for (const item of quarantinePayload.issues) {
          if (!item || typeof item !== 'object') continue;
          const issue = item as ConversationLineageIssue;
          if (
            typeof issue.code === 'string'
            && typeof issue.detail === 'string'
            && issue.branchId === branch.id
            && !issues.some((existing) => (
              canonicalConversationJson(existing) === canonicalConversationJson(issue)
            ))
          ) {
            issues.push(issue);
          }
        }
      }
    }
    const issueDigest = conversationLineageIssueDigest(issues);
    const repair = repairEvents[repairEvents.length - 1];
    const repairPayload = repair ? parseConversationRecord(repair.payload_json) : {};
    const overrideActive = Boolean(
      issues.length > 0
      && quarantine
      && repair
      && repair.sequence > quarantine.sequence
      && repairPayload.issueDigest === issueDigest
    );
    return {
      branch: this.store.toLineage(branch),
      status: issues.length === 0
        ? 'healthy'
        : overrideActive
          ? 'override_active'
          : 'quarantined',
      issueDigest,
      issues,
      quarantineEventId: quarantine?.id ?? null,
      repairOverrideEventId: overrideActive ? repair?.id ?? null : null,
    };
  }
}
