import type BetterSqlite3 from 'better-sqlite3';

import {
  ConversationBranchError,
  type ConversationLineageAudit,
  type ConversationMessageSnapshot,
  type ConversationProjectionRepairEventPayload,
  type ConversationReplayMessage,
} from '../../../../shared/contract/conversationBranch';
import {
  canonicalConversationJson,
  canonicalConversationMessagePayload,
  conversationSha256,
} from '../database/schemaConversationBranch';
import { sanitizeConversationMessageSnapshot } from '../conversationMessageSnapshot';
import { ConversationBranchAuditRepository } from './ConversationBranchAuditRepository';
import {
  ConversationBranchLedgerStore,
  parseConversationRecord,
  type ConversationSQLiteRow,
} from './ConversationBranchLedgerStore';
import { rowToMessage } from './sessionRepositoryParsers';

export type ProjectionRepairFaultPhase =
  | 'after_projection_write'
  | 'after_event_append';

export interface RepairCompatibilityProjectionInput {
  sessionId: string;
  boundary: {
    ownerUserId: string | null;
    projectId: string | null;
  };
  issueDigest: string;
  reason: string;
  idempotencyKey: string;
  createdAt?: number;
}

export class ConversationProjectionRepairRepository {
  constructor(
    private readonly db: BetterSqlite3.Database,
    private readonly store: ConversationBranchLedgerStore,
    private readonly auditRepository: ConversationBranchAuditRepository,
    private readonly faultInjector?: (phase: ProjectionRepairFaultPhase) => void,
  ) {}

  repairCompatibilityProjection(
    input: RepairCompatibilityProjectionInput,
  ): ConversationLineageAudit {
    const reason = input.reason.trim();
    const repair = this.db.transaction((): ConversationLineageAudit => {
      const branch = this.store.requireBranch(input.sessionId, input.boundary);
      const existingEvent = this.store.readIdempotentEvent(
        branch.id,
        input.idempotencyKey,
      );
      if (existingEvent) {
        this.store.requireIdempotentEvent(existingEvent, 'projection_repair', {
          issueDigest: input.issueDigest,
          reason,
        });
        const existingAudit = this.auditRepository.auditLineage(
          input.sessionId,
          input.boundary,
        );
        if (existingAudit.status !== 'healthy') {
          throw new ConversationBranchError(
            'LEDGER_CORRUPT',
            'an idempotent projection repair event exists without a healthy projection',
            { issueDigest: existingAudit.issueDigest, issues: existingAudit.issues },
          );
        }
        return existingAudit;
      }

      const audit = this.auditRepository.auditLineage(input.sessionId, input.boundary);
      const projectionIssueCodes = new Set([
        'PROJECTION_ALIAS_MISSING',
        'PROJECTION_ALIAS_EXTRA',
        'PROJECTION_ALIAS_ORDER_MISMATCH',
        'PROJECTION_ALIAS_PAYLOAD_MISMATCH',
      ]);
      const events = this.store.readEvents(branch.id);
      const quarantine = audit.quarantineEventId
        ? events.find((event) => event.id === audit.quarantineEventId)
        : undefined;
      const quarantinePayload = quarantine
        ? parseConversationRecord(quarantine.payload_json)
        : {};
      if (
        audit.status !== 'quarantined'
        || audit.issueDigest !== input.issueDigest
        || !quarantine
        || quarantinePayload.issueDigest !== input.issueDigest
        || reason.length < 16
        || audit.issues.length === 0
        || audit.issues.some((issue) => !projectionIssueCodes.has(issue.code))
      ) {
        throw new ConversationBranchError(
          'PROJECTION_REPAIR_REJECTED',
          'projection repair requires an exact quarantined projection-only issue digest and a substantive reason',
          {
            currentIssueDigest: audit.issueDigest,
            quarantineEventId: audit.quarantineEventId,
            issueCodes: audit.issues.map((issue) => issue.code),
          },
        );
      }

      const references = this.store.readReferences(branch.id);
      const replay = this.store.replayFromRows(branch, references, events);
      if (
        new Set(replay.messages.map((message) => message.projectedMessageId)).size
          !== replay.messages.length
      ) {
        throw new ConversationBranchError(
          'PROJECTION_REPAIR_REJECTED',
          'immutable replay contains duplicate projected message identifiers',
        );
      }
      for (let index = 1; index < replay.messages.length; index += 1) {
        if (
          replay.messages[index - 1].message.timestamp
            > replay.messages[index].message.timestamp
        ) {
          throw new ConversationBranchError(
            'PROJECTION_REPAIR_REJECTED',
            'immutable replay timestamps cannot be represented by the compatibility ordering',
          );
        }
      }

      const previousRows = this.readActiveProjectionRows(branch.session_id);
      const previousProjectionDigest = this.compatibilityProjectionDigest(previousRows);
      const expectedMessageIds = new Set(
        replay.messages.map((message) => message.projectedMessageId),
      );
      const repairMarker = `projection_repair:${conversationSha256(
        `${branch.id}:${input.idempotencyKey}`,
      ).slice(0, 24)}`;
      let insertedCount = 0;
      let updatedCount = 0;
      let softHiddenCount = 0;

      for (const replayMessage of replay.messages) {
        const anyOwner = this.db.prepare(`
          SELECT session_id
          FROM messages
          WHERE id = ?
          LIMIT 1
        `).get(replayMessage.projectedMessageId) as { session_id: string } | undefined;
        if (anyOwner && anyOwner.session_id !== branch.session_id) {
          throw new ConversationBranchError(
            'PROJECTION_REPAIR_REJECTED',
            `message id ${replayMessage.projectedMessageId} belongs to another session`,
          );
        }
        const values = this.compatibilityValuesFromReplay(replayMessage);
        if (anyOwner) {
          this.updateCompatibilityMessage(
            branch.session_id,
            replayMessage.projectedMessageId,
            values,
          );
          updatedCount += 1;
        } else {
          this.insertCompatibilityMessage(
            branch.session_id,
            replayMessage.projectedMessageId,
            values,
          );
          insertedCount += 1;
        }
      }

      for (const row of previousRows) {
        if (expectedMessageIds.has(String(row.id))) continue;
        const result = this.db.prepare(`
          UPDATE messages
          SET visibility = 'rewound',
              hidden_by_rewind_id = ?,
              hidden_at = ?,
              synced_at = NULL
          WHERE session_id = ?
            AND id = ?
            AND COALESCE(visibility, 'active') = 'active'
        `).run(
          repairMarker,
          input.createdAt ?? Date.now(),
          branch.session_id,
          String(row.id),
        );
        softHiddenCount += result.changes;
      }

      const reorderedCount = this.reorderProjectionIfNeeded(
        branch.session_id,
        replay.messages.map((message) => message.projectedMessageId),
      );
      const recalibratedForkMappingCount = this.recalibrateForkSourceMappings(
        branch.session_id,
      );
      this.faultInjector?.('after_projection_write');

      const repairedRows = this.readActiveProjectionRows(branch.session_id);
      const repairedProjectionDigest = this.compatibilityProjectionDigest(repairedRows);
      const eventPayload: ConversationProjectionRepairEventPayload = {
        issueDigest: input.issueDigest,
        quarantineEventId: quarantine.id,
        reason,
        previousProjectionDigest,
        repairedProjectionDigest,
        expectedActiveCount: replay.messages.length,
        previousActiveCount: previousRows.length,
        insertedCount,
        updatedCount,
        softHiddenCount,
        reorderedCount,
        recalibratedForkMappingCount,
      };
      this.store.appendEvent({
        branch,
        eventType: 'projection_repair',
        idempotencyKey: input.idempotencyKey,
        payload: eventPayload as unknown as Record<string, unknown>,
        createdAt: input.createdAt ?? Date.now(),
      });
      this.faultInjector?.('after_event_append');

      const repairedAudit = this.auditRepository.auditLineage(
        input.sessionId,
        input.boundary,
      );
      if (repairedAudit.status !== 'healthy' || repairedAudit.issues.length > 0) {
        throw new ConversationBranchError(
          'PROJECTION_REPAIR_REJECTED',
          'reconstructed compatibility projection did not pass lineage audit',
          {
            issueDigest: repairedAudit.issueDigest,
            issueCodes: repairedAudit.issues.map((issue) => issue.code),
          },
        );
      }
      return repairedAudit;
    });
    return repair();
  }

  private readActiveProjectionRows(sessionId: string): ConversationSQLiteRow[] {
    return this.db.prepare(`
      SELECT rowid AS __rowid, *
      FROM messages
      WHERE session_id = ?
        AND COALESCE(visibility, 'active') = 'active'
      ORDER BY timestamp ASC, rowid ASC
    `).all(sessionId) as ConversationSQLiteRow[];
  }

  private compatibilityProjectionDigest(rows: ConversationSQLiteRow[]): string {
    return conversationSha256(canonicalConversationJson(rows.map((row, index) => ({
      index,
      rowId: Number(row.__rowid),
      messageId: String(row.id),
      payloadDigest: conversationSha256(canonicalConversationJson(
        canonicalConversationMessagePayload(
          sanitizeConversationMessageSnapshot(rowToMessage(row)) as unknown as Record<string, unknown>,
        ),
      )),
    }))));
  }

  private compatibilityValuesFromReplay(replayMessage: ConversationReplayMessage): {
    role: ConversationMessageSnapshot['role'];
    content: string;
    timestamp: number;
    toolCalls: string | null;
    toolResults: string | null;
    attachments: string | null;
    thinking: string | null;
    effortLevel: string | null;
    contentParts: string | null;
    metadata: string | null;
    isMeta: number;
    compaction: string | null;
  } {
    const snapshot = replayMessage.message as Record<string, unknown>;
    const jsonValue = (value: unknown): string | null =>
      value === undefined || value === null ? null : JSON.stringify(value);
    const baseMetadata = snapshot.metadata
      && typeof snapshot.metadata === 'object'
      && !Array.isArray(snapshot.metadata)
      ? { ...snapshot.metadata as Record<string, unknown> }
      : {};
    if (
      Array.isArray(snapshot.readOnlyArtifactProvenance)
      && snapshot.readOnlyArtifactProvenance.length > 0
    ) {
      baseMetadata.readOnlyArtifactProvenanceV2 = snapshot.readOnlyArtifactProvenance;
    }
    const thinking = typeof snapshot.thinking === 'string'
      ? snapshot.thinking
      : typeof snapshot.reasoning === 'string'
        ? snapshot.reasoning
        : null;
    return {
      role: replayMessage.message.role,
      content: replayMessage.message.content,
      timestamp: replayMessage.message.timestamp,
      toolCalls: jsonValue(snapshot.toolCalls),
      toolResults: jsonValue(snapshot.toolResults),
      attachments: jsonValue(snapshot.readOnlyAttachmentProvenance),
      thinking,
      effortLevel: typeof snapshot.effortLevel === 'string' ? snapshot.effortLevel : null,
      contentParts: jsonValue(snapshot.contentParts),
      metadata: Object.keys(baseMetadata).length > 0 ? JSON.stringify(baseMetadata) : null,
      isMeta: snapshot.isMeta === true ? 1 : 0,
      compaction: jsonValue(snapshot.compaction),
    };
  }

  private updateCompatibilityMessage(
    sessionId: string,
    messageId: string,
    values: ReturnType<ConversationProjectionRepairRepository['compatibilityValuesFromReplay']>,
  ): void {
    this.db.prepare(`
      UPDATE messages
      SET role = ?, content = ?, timestamp = ?,
          tool_calls = ?, tool_results = ?, attachments = ?,
          thinking = ?, effort_level = ?, synced_at = NULL,
          content_parts = ?, metadata = ?, is_meta = ?, compaction = ?,
          visibility = 'active', hidden_by_rewind_id = NULL, hidden_at = NULL
      WHERE session_id = ? AND id = ?
    `).run(
      values.role,
      values.content,
      values.timestamp,
      values.toolCalls,
      values.toolResults,
      values.attachments,
      values.thinking,
      values.effortLevel,
      values.contentParts,
      values.metadata,
      values.isMeta,
      values.compaction,
      sessionId,
      messageId,
    );
  }

  private insertCompatibilityMessage(
    sessionId: string,
    messageId: string,
    values: ReturnType<ConversationProjectionRepairRepository['compatibilityValuesFromReplay']>,
  ): void {
    this.db.prepare(`
      INSERT INTO messages (
        id, session_id, role, content, timestamp, tool_calls, tool_results,
        attachments, thinking, effort_level, synced_at, content_parts, metadata,
        is_meta, compaction, visibility, hidden_by_rewind_id, hidden_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, 'active', NULL, NULL)
    `).run(
      messageId,
      sessionId,
      values.role,
      values.content,
      values.timestamp,
      values.toolCalls,
      values.toolResults,
      values.attachments,
      values.thinking,
      values.effortLevel,
      values.contentParts,
      values.metadata,
      values.isMeta,
      values.compaction,
    );
  }

  private reorderProjectionIfNeeded(
    sessionId: string,
    expectedOrder: string[],
  ): number {
    const currentOrder = this.readActiveProjectionRows(sessionId)
      .map((row) => String(row.id));
    if (
      currentOrder.length === expectedOrder.length
      && currentOrder.every((messageId, index) => messageId === expectedOrder[index])
    ) {
      return 0;
    }
    const maximum = this.db.prepare(`
      SELECT COALESCE(MAX(rowid), 0) AS maximum FROM messages
    `).get() as { maximum: number };
    const baseRowId = Number(maximum.maximum);
    if (!Number.isSafeInteger(baseRowId + expectedOrder.length + 1)) {
      throw new ConversationBranchError(
        'PROJECTION_REPAIR_REJECTED',
        'compatibility row identifiers cannot be safely reordered',
      );
    }
    let reorderedCount = 0;
    expectedOrder.forEach((messageId, index) => {
      const result = this.db.prepare(`
        UPDATE messages SET rowid = ?
        WHERE session_id = ? AND id = ?
      `).run(baseRowId + index + 1, sessionId, messageId);
      if (result.changes !== 1) {
        throw new ConversationBranchError(
          'LEDGER_CORRUPT',
          `message ${messageId} disappeared during projection reorder`,
        );
      }
      reorderedCount += 1;
    });
    return reorderedCount;
  }

  private recalibrateForkSourceMappings(sourceSessionId: string): number {
    const tableNames = new Set((this.db.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table'
        AND name IN ('session_forks', 'session_fork_message_map')
    `).all() as Array<{ name: string }>).map((row) => row.name));
    if (
      !tableNames.has('session_forks')
      || !tableNames.has('session_fork_message_map')
    ) {
      return 0;
    }
    const mappingColumns = new Set((this.db.prepare(`
      PRAGMA table_info(session_fork_message_map)
    `).all() as Array<{ name: string }>).map((column) => column.name));
    if (
      !mappingColumns.has('source_order_key')
      || !mappingColumns.has('source_row_digest')
    ) {
      return 0;
    }
    const expected = this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM session_fork_message_map AS map
      JOIN session_forks AS fork ON fork.id = map.fork_id
      WHERE fork.source_session_id = ?
    `).get(sourceSessionId) as { count: number };
    const rows = this.db.prepare(`
      SELECT map.rowid AS __map_rowid, source.rowid AS __rowid, source.*
      FROM session_fork_message_map AS map
      JOIN session_forks AS fork ON fork.id = map.fork_id
      JOIN messages AS source
        ON source.session_id = fork.source_session_id
       AND source.id = map.source_message_id
      WHERE fork.source_session_id = ?
      ORDER BY map.fork_id ASC, map.ordinal ASC
    `).all(sourceSessionId) as ConversationSQLiteRow[];
    if (rows.length !== Number(expected.count)) {
      throw new ConversationBranchError(
        'PROJECTION_REPAIR_REJECTED',
        'fork source evidence cannot be recalibrated because a mapped row is missing',
      );
    }
    const update = this.db.prepare(`
      UPDATE session_fork_message_map
      SET source_order_key = ?, source_row_digest = ?
      WHERE rowid = ?
    `);
    for (const row of rows) {
      const { __map_rowid: mapRowId, ...sourceRow } = row;
      update.run(
        `${Number(sourceRow.timestamp)}:${Number(sourceRow.__rowid)}`,
        conversationSha256(JSON.stringify(sourceRow)),
        Number(mapRowId),
      );
    }
    return rows.length;
  }
}
