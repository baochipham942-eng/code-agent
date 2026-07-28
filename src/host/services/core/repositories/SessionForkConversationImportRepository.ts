import type BetterSqlite3 from 'better-sqlite3';

import type { Message } from '../../../../shared/contract/message';
import type {
  ConversationLineageAudit,
  ConversationLineageAuditStatus,
  ConversationLineageIssueCode,
} from '../../../../shared/contract/conversationBranch';
import type {
  SessionExportEnvelopeV2,
  SessionForkImportPlan,
} from '../../../../shared/contract/sessionForkPortability';
import {
  planPortableConversationHistoryImport,
} from '../../sessionFork/portability';
import type {
  PortableConversationProjectionRepairReplayAction,
  PortableConversationHistoryImportPlan,
  PortableConversationReplayAction,
} from '../../sessionFork/portability/conversationHistoryTypes';
import { sanitizeConversationMessageSnapshot } from '../conversationMessageSnapshot';
import {
  canonicalConversationJson,
  canonicalConversationMessagePayload,
  conversationSha256,
} from '../database/schemaConversationBranch';
import { ConversationBranchRepository } from './ConversationBranchRepository';
import {
  canonicalSessionForkStringify as canonicalStringify,
  failSessionForkPortability as fail,
  importedConversationSnapshot,
  parseSessionForkJson as parseJson,
  persistedSessionForkOwnerScope as persistedOwnerScope,
  sessionForkDigestHex as digestHex,
} from './SessionForkPortabilityInternals';
import { rowToMessage } from './sessionRepositoryParsers';

interface TargetQuarantineEvidence {
  issueDigest: string;
  quarantineEventId: string;
}

export class SessionForkConversationImportRepository {
  constructor(
    private readonly db: BetterSqlite3.Database,
    private readonly conversationBranchRepo: ConversationBranchRepository | null,
  ) {}

  integrateImportedConversationHistory(
    history: NonNullable<SessionExportEnvelopeV2['conversationHistory']>,
    plan: SessionForkImportPlan,
  ): PortableConversationHistoryImportPlan {
    if (!this.conversationBranchRepo) {
      fail('REFERENCE_NOT_CLOSED', 'immutable conversation ledger is required for Session Fork import');
    }
    const historyPlan = planPortableConversationHistoryImport({
      history,
      sessionIdMap: plan.sessionIdMap,
      messageIdMap: plan.messageIdMap,
      forkIdMap: plan.forkIdMap,
      targetOwnerUserId: persistedOwnerScope(plan.targetOwnerScopeId),
      targetProjectId: plan.targetProjectId,
    });
    // Compatibility rows are inserted in their final imported state before the
    // immutable event stream is reconstructed. Disable projection comparison
    // only for this enclosing import transaction, then audit the converged
    // public projection with the production repository below.
    const replayRepository = new ConversationBranchRepository(this.db, {
      auditCompatibilityProjection: false,
    });
    const targetQuarantines = new Map<string, TargetQuarantineEvidence>();
    for (const action of historyPlan.actions) {
      this.applyConversationHistoryAction(replayRepository, action, targetQuarantines);
    }
    return historyPlan;
  }

  private applyConversationHistoryAction(
    repository: ConversationBranchRepository,
    action: PortableConversationReplayAction,
    targetQuarantines: Map<string, TargetQuarantineEvidence>,
  ): void {
    switch (action.method) {
      case 'initializeSessionBranch':
        repository.initializeSessionBranch(action.input);
        return;
      case 'appendMessage':
        repository.appendMessage(action.input);
        return;
      case 'recordMessageRevision':
        repository.recordMessageRevision(action.input);
        return;
      case 'recordProjectionReplacement':
        repository.recordProjectionReplacement(action.input);
        return;
      case 'createForkBranch':
        repository.createForkBranch(action.input);
        return;
      case 'recordRewind':
        repository.recordRewind(action.input);
        return;
      case 'recordRewindRestore':
        repository.recordRewindRestore(action.input);
        return;
      case 'recordEvaluationAttribution':
        repository.recordEvaluationAttribution(action.input);
        return;
      case 'auditAndQuarantine': {
        const auditRepository = this.conversationBranchRepo ?? repository;
        const before = auditRepository.auditLineage(
          action.input.sessionId,
          action.input.boundary,
        );
        const actualIssueTypes = this.lineageIssueTypes(before.issues.map((issue) => issue.code));
        const expectedIssueTypes = this.lineageIssueTypes(action.expectedIssueTypes);
        if (
          before.issues.length === 0
          || canonicalStringify(actualIssueTypes) !== canonicalStringify(expectedIssueTypes)
          || before.issueDigest === action.expectedIssueDigest
        ) {
          fail(
            'DIGEST_MISMATCH',
            `quarantine ${action.sourceEventId} does not match remapped target lineage findings`,
          );
        }
        const after = auditRepository.auditAndQuarantine(action.input);
        if (
          after.issueDigest !== before.issueDigest
          || after.status !== 'quarantined'
          || !after.quarantineEventId
        ) {
          fail(
            'DIGEST_MISMATCH',
            `quarantine ${action.sourceEventId} changed while it was being reconstructed`,
          );
        }
        targetQuarantines.set(action.sourceEventId, {
          issueDigest: after.issueDigest,
          quarantineEventId: after.quarantineEventId,
        });
        return;
      }
      case 'recordRepairOverride': {
        const auditRepository = this.conversationBranchRepo ?? repository;
        const targetQuarantine = targetQuarantines.get(action.sourceQuarantineEventId);
        if (!targetQuarantine) {
          fail(
            'REFERENCE_NOT_CLOSED',
            `repair override ${action.sourceEventId} lost its target quarantine evidence`,
          );
        }
        const after = auditRepository.recordRepairOverride({
          ...action.input,
          issueDigest: targetQuarantine.issueDigest,
        });
        if (
          after.status !== 'override_active'
          || after.issueDigest !== targetQuarantine.issueDigest
          || after.quarantineEventId !== targetQuarantine.quarantineEventId
        ) {
          fail(
            'DIGEST_MISMATCH',
            `repair override ${action.sourceEventId} changed its target quarantine evidence`,
          );
        }
        return;
      }
      case 'repairCompatibilityProjection':
        this.applyPortableProjectionRepair(action);
        return;
    }
  }

  private lineageIssueTypes(
    issueTypes: readonly ConversationLineageIssueCode[],
  ): ConversationLineageIssueCode[] {
    return [...new Set(issueTypes)].sort();
  }

  private applyPortableProjectionRepair(
    action: PortableConversationProjectionRepairReplayAction,
  ): void {
    if (!this.conversationBranchRepo) {
      fail('REFERENCE_NOT_CLOSED', 'projection repair requires the production lineage repository');
    }
    const initialAudit = this.conversationBranchRepo.auditLineage(
      action.input.sessionId,
      action.input.boundary,
    );
    if (initialAudit.status !== 'healthy' || initialAudit.issues.length > 0) {
      fail(
        'DIGEST_MISMATCH',
        `projection repair ${action.sourceEventId} did not begin from a healthy target projection`,
      );
    }
    this.manufacturePortableProjectionMismatch(action);
    const mismatchAudit = this.conversationBranchRepo.auditLineage(
      action.input.sessionId,
      action.input.boundary,
    );
    const actualIssueTypes = this.lineageIssueTypes(
      mismatchAudit.issues.map((issue) => issue.code),
    );
    const expectedIssueTypes = this.lineageIssueTypes(action.sourceEvidence.issueTypes);
    if (
      mismatchAudit.issues.length === 0
      || canonicalStringify(actualIssueTypes) !== canonicalStringify(expectedIssueTypes)
      || mismatchAudit.issueDigest === action.sourceEvidence.sourceIssueDigest
    ) {
      fail(
        'DIGEST_MISMATCH',
        `projection repair ${action.sourceEventId} could not recreate exact target-native issue types`,
      );
    }
    const quarantine = this.conversationBranchRepo.auditAndQuarantine({
      sessionId: action.input.sessionId,
      boundary: action.input.boundary,
      idempotencyKey: action.sourceEvidence.quarantineIdempotencyKey,
      createdAt: action.sourceEvidence.quarantineCreatedAt,
    });
    if (
      quarantine.status !== 'quarantined'
      || !quarantine.quarantineEventId
      || quarantine.issueDigest !== mismatchAudit.issueDigest
    ) {
      fail(
        'DIGEST_MISMATCH',
        `projection repair ${action.sourceEventId} target quarantine was not stable`,
      );
    }
    const repaired = this.conversationBranchRepo.repairCompatibilityProjection({
      ...action.input,
      issueDigest: quarantine.issueDigest,
    });
    if (repaired.status !== 'healthy' || repaired.issues.length > 0) {
      fail(
        'DIGEST_MISMATCH',
        `projection repair ${action.sourceEventId} did not finish healthy`,
      );
    }
  }

  private manufacturePortableProjectionMismatch(
    action: PortableConversationProjectionRepairReplayAction,
  ): void {
    if (!this.conversationBranchRepo) {
      fail('REFERENCE_NOT_CLOSED', 'projection repair lost its immutable replay repository');
    }
    const replay = this.conversationBranchRepo.replay(
      action.input.sessionId,
      action.input.boundary,
    );
    const messages = replay.messages;
    const issueTypes = new Set(action.sourceEvidence.issueTypes);
    const wantsMissing = issueTypes.has('PROJECTION_ALIAS_MISSING');
    const wantsExtra = issueTypes.has('PROJECTION_ALIAS_EXTRA');
    const wantsOrder = issueTypes.has('PROJECTION_ALIAS_ORDER_MISMATCH');
    const wantsPayload = issueTypes.has('PROJECTION_ALIAS_PAYLOAD_MISMATCH');
    if (wantsMissing && wantsExtra) {
      fail(
        'REFERENCE_NOT_CLOSED',
        `projection repair ${action.sourceEventId} has mutually exclusive missing and extra evidence`,
      );
    }

    let hiddenIndex: number | null = null;
    let orderCreatedByCardinality = false;
    if (wantsMissing) {
      if (messages.length === 0) {
        fail('REFERENCE_NOT_CLOSED', 'missing projection evidence has no replay message');
      }
      if (wantsOrder) {
        const minimum = wantsPayload ? 3 : 2;
        if (messages.length < minimum) {
          fail(
            'REFERENCE_NOT_CLOSED',
            'missing/order projection evidence cannot preserve its requested payload finding',
          );
        }
        hiddenIndex = wantsPayload ? 1 : 0;
        orderCreatedByCardinality = true;
      } else {
        if (wantsPayload && messages.length < 2) {
          fail(
            'REFERENCE_NOT_CLOSED',
            'missing/payload projection evidence needs two replay messages',
          );
        }
        hiddenIndex = messages.length - 1;
      }
      const hiddenMessage = messages[hiddenIndex];
      const hiddenMarker = `portable_projection_replay:${digestHex({
        sessionId: action.input.sessionId,
        sourceEventId: action.sourceEventId,
        kind: 'missing',
      }).slice(0, 24)}`;
      const hidden = this.db.prepare(`
        UPDATE messages
        SET visibility = 'rewound', hidden_by_rewind_id = ?, hidden_at = ?, synced_at = NULL
        WHERE session_id = ? AND id = ?
          AND COALESCE(visibility, 'active') = 'active'
      `).run(
        hiddenMarker,
        action.createdAt,
        action.input.sessionId,
        hiddenMessage.projectedMessageId,
      );
      if (hidden.changes !== 1) {
        fail('REFERENCE_NOT_CLOSED', 'projection repair could not hide its deterministic alias');
      }
    }

    const activeIndices = messages
      .map((_message, index) => index)
      .filter((index) => index !== hiddenIndex);
    let swappedIndices = new Set<number>();
    const needsExplicitSwap = wantsOrder
      && !orderCreatedByCardinality
      && !(wantsExtra && !wantsPayload);
    if (needsExplicitSwap) {
      if (activeIndices.length < (wantsPayload ? 3 : 2)) {
        fail(
          'REFERENCE_NOT_CLOSED',
          `projection repair ${action.sourceEventId} lacks deterministic order evidence`,
        );
      }
      const pair = activeIndices.slice(-2) as [number, number];
      const leftTimestamp = messages[pair[0]].message.timestamp;
      const rightTimestamp = messages[pair[1]].message.timestamp;
      const moveLeftAfterRight = Number.isSafeInteger(rightTimestamp + 1);
      const replacementTimestamp = moveLeftAfterRight
        ? rightTimestamp + 1
        : leftTimestamp - 1;
      if (!Number.isSafeInteger(replacementTimestamp)) {
        fail('REFERENCE_NOT_CLOSED', 'projection repair timestamp order is not safe');
      }
      const changed = this.db.prepare(`
        UPDATE messages SET timestamp = ?, synced_at = NULL
        WHERE session_id = ? AND id = ?
      `).run(
        replacementTimestamp,
        action.input.sessionId,
        messages[moveLeftAfterRight ? pair[0] : pair[1]].projectedMessageId,
      );
      if (changed.changes !== 1) {
        fail('REFERENCE_NOT_CLOSED', 'projection repair could not reorder deterministic aliases');
      }
      swappedIndices = new Set(pair);
    }

    if (wantsPayload) {
      const payloadIndex = activeIndices.find((index) => !swappedIndices.has(index));
      if (payloadIndex === undefined) {
        fail('REFERENCE_NOT_CLOSED', 'payload projection evidence has no aligned replay message');
      }
      const marker = `[portable projection mismatch ${digestHex({
        sessionId: action.input.sessionId,
        sourceEventId: action.sourceEventId,
        kind: 'payload',
      }).slice(0, 24)}]`;
      const updated = this.db.prepare(`
        UPDATE messages SET content = ?, synced_at = NULL
        WHERE session_id = ? AND id = ?
      `).run(
        marker,
        action.input.sessionId,
        messages[payloadIndex].projectedMessageId,
      );
      if (updated.changes !== 1) {
        fail('REFERENCE_NOT_CLOSED', 'projection repair could not alter deterministic payload');
      }
    }

    if (wantsExtra) {
      const insertBefore = wantsOrder && !wantsPayload;
      const bounds = this.db.prepare(`
        SELECT COALESCE(MIN(rowid), 0) AS minimum, COALESCE(MAX(rowid), 0) AS maximum
        FROM messages
      `).get() as { minimum: number; maximum: number };
      const rowId = insertBefore ? Number(bounds.minimum) - 1 : Number(bounds.maximum) + 1;
      if (!Number.isSafeInteger(rowId)) {
        fail('REFERENCE_NOT_CLOSED', 'extra projection evidence row order is not safe');
      }
      const edgeMessage = insertBefore ? messages[0] : messages[messages.length - 1];
      const timestamp = edgeMessage?.message.timestamp ?? 0;
      const digest = digestHex({
        sessionId: action.input.sessionId,
        sourceEventId: action.sourceEventId,
        kind: 'extra',
      });
      this.db.prepare(`
        INSERT INTO messages (
          rowid, id, session_id, role, content, timestamp,
          tool_calls, tool_results, attachments, thinking, effort_level,
          synced_at, content_parts, metadata, is_meta, compaction,
          visibility, hidden_by_rewind_id, hidden_at
        ) VALUES (
          ?, ?, ?, 'system', ?, ?,
          NULL, NULL, NULL, NULL, NULL,
          NULL, NULL, NULL, 1, NULL,
          'active', NULL, NULL
        )
      `).run(
        rowId,
        `portable_projection_extra_${digest.slice(0, 32)}`,
        action.input.sessionId,
        `[portable projection extra ${digest.slice(0, 24)}]`,
        timestamp,
      );
    }
  }

  verifyImportedConversationHistory(
    history: NonNullable<SessionExportEnvelopeV2['conversationHistory']>,
    historyPlan: PortableConversationHistoryImportPlan,
    plan: SessionForkImportPlan,
  ): void {
    if (!this.conversationBranchRepo) {
      fail('REFERENCE_NOT_CLOSED', 'immutable conversation ledger disappeared during import');
    }
    const expectedStatusBySession = this.expectedConversationStatusBySession(history, plan);
    for (const branch of history.branches) {
      const targetSessionId = plan.sessionIdMap[branch.sessionId];
      if (!targetSessionId) {
        fail('REFERENCE_NOT_CLOSED', `imported history lost session mapping ${branch.sessionId}`);
      }
      const audit = this.conversationBranchRepo.auditLineage(
        targetSessionId,
        historyPlan.targetBoundary,
      );
      const expectedStatus = expectedStatusBySession[targetSessionId] ?? 'healthy';
      try {
        this.assertConversationAuditClosure(targetSessionId, audit, expectedStatus);
      } catch (error) {
        const projectionDetails = audit.issues.flatMap((issue) => (
          issue.code === 'PROJECTION_ALIAS_PAYLOAD_MISMATCH'
          && typeof issue.ordinal === 'number'
            ? [this.describeProjectionPayloadMismatch(targetSessionId, issue.ordinal)]
            : []
        ));
        fail(
          'DIGEST_MISMATCH',
          `imported history ${targetSessionId} is ${audit.status}; expected ${expectedStatus}: ${audit.issues
            .map((issue) => `${issue.code}(${issue.detail})`)
            .join(', ')}${projectionDetails.length > 0 ? `; ${projectionDetails.join('; ')}` : ''}; ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  expectedConversationStatusBySession(
    history: SessionExportEnvelopeV2['conversationHistory'] | undefined,
    plan: SessionForkImportPlan,
  ): Record<string, ConversationLineageAuditStatus> {
    const result: Record<string, ConversationLineageAuditStatus> = {};
    for (const targetSessionId of Object.values(plan.sessionIdMap)) {
      result[targetSessionId] = 'healthy';
    }
    if (!history) return result;
    const sourceSessionByBranch = new Map(
      history.branches.map((branch) => [branch.id, branch.sessionId]),
    );
    for (const event of history.events) {
      const sourceSessionId = sourceSessionByBranch.get(event.branchId);
      const targetSessionId = sourceSessionId ? plan.sessionIdMap[sourceSessionId] : undefined;
      if (!targetSessionId) {
        fail('REFERENCE_NOT_CLOSED', `history event ${event.id} lost its session mapping`);
      }
      if (event.eventType === 'quarantine') {
        result[targetSessionId] = 'quarantined';
      } else if (event.eventType === 'repair_override') {
        result[targetSessionId] = 'override_active';
      } else if (event.eventType === 'projection_repair') {
        result[targetSessionId] = 'healthy';
      }
    }
    return result;
  }

  assertConversationAuditClosure(
    sessionId: string,
    audit: ConversationLineageAudit,
    expectedStatus: ConversationLineageAuditStatus,
  ): void {
    if (audit.status !== expectedStatus) {
      throw new Error(`audit status ${audit.status} does not match ${expectedStatus}`);
    }
    if (expectedStatus === 'healthy') {
      if (audit.issues.length !== 0) throw new Error('healthy audit still has lineage issues');
      return;
    }
    if (audit.issues.length === 0 || !audit.quarantineEventId) {
      throw new Error(`${expectedStatus} audit has no exact quarantine closure`);
    }
    const quarantine = this.db.prepare(`
      SELECT event_type, payload_json
      FROM conversation_branch_events
      WHERE id = ?
        AND branch_id = (SELECT id FROM conversation_branches WHERE session_id = ?)
      LIMIT 1
    `).get(audit.quarantineEventId, sessionId) as {
      event_type: string;
      payload_json: string;
    } | undefined;
    const quarantinePayload = quarantine
      ? parseJson<Record<string, unknown>>(
        quarantine.payload_json,
        `quarantine ${audit.quarantineEventId}`,
      )
      : {};
    if (
      quarantine?.event_type !== 'quarantine'
      || quarantinePayload.issueDigest !== audit.issueDigest
    ) {
      throw new Error(`${expectedStatus} audit digest is not closed by its quarantine event`);
    }
    if (expectedStatus === 'quarantined') return;
    if (!audit.repairOverrideEventId) {
      throw new Error('override audit has no exact repair override closure');
    }
    const repair = this.db.prepare(`
      SELECT event_type, payload_json
      FROM conversation_branch_events
      WHERE id = ?
        AND branch_id = (SELECT id FROM conversation_branches WHERE session_id = ?)
      LIMIT 1
    `).get(audit.repairOverrideEventId, sessionId) as {
      event_type: string;
      payload_json: string;
    } | undefined;
    const repairPayload = repair
      ? parseJson<Record<string, unknown>>(
        repair.payload_json,
        `repair override ${audit.repairOverrideEventId}`,
      )
      : {};
    if (
      repair?.event_type !== 'repair_override'
      || repairPayload.issueDigest !== audit.issueDigest
      || repairPayload.quarantineEventId !== audit.quarantineEventId
    ) {
      throw new Error('override audit is not closed by its repair event');
    }
  }

  private describeProjectionPayloadMismatch(
    sessionId: string,
    ordinal: number,
  ): string {
    const immutable = this.db.prepare(`
      SELECT reference.projected_message_id, entry.message_json, entry.payload_digest
      FROM conversation_branches AS branch
      JOIN conversation_branch_entries AS reference ON reference.branch_id = branch.id
      JOIN conversation_entries AS entry ON entry.id = reference.entry_id
      WHERE branch.session_id = ? AND reference.ordinal = ?
      LIMIT 1
    `).get(sessionId, ordinal) as {
      projected_message_id: string;
      message_json: string;
      payload_digest: string;
    } | undefined;
    if (!immutable) return `ordinal ${ordinal} immutable payload missing`;
    const projected = this.db.prepare(`
      SELECT rowid AS __rowid, *
      FROM messages
      WHERE session_id = ? AND id = ?
      LIMIT 1
    `).get(sessionId, immutable.projected_message_id) as Record<string, unknown> | undefined;
    if (!projected) return `ordinal ${ordinal} compatibility payload missing`;
    const expected = parseJson<Record<string, unknown>>(
      immutable.message_json,
      `entry at ${sessionId}:${ordinal}`,
    );
    const actual = canonicalConversationMessagePayload(
      sanitizeConversationMessageSnapshot(rowToMessage(projected)) as unknown as Record<string, unknown>,
    );
    const differingFields = [...new Set([
      ...Object.keys(expected),
      ...Object.keys(actual),
    ])].filter((key) => (
      canonicalConversationJson(expected[key]) !== canonicalConversationJson(actual[key])
    )).sort();
    return `ordinal ${ordinal} differs at [${differingFields.join(',')}], expected ${immutable.payload_digest}, actual ${conversationSha256(canonicalConversationJson(actual))}`;
  }

  integrateImportedConversationLedger(
    plan: SessionForkImportPlan,
    nodes: SessionExportEnvelopeV2['lineage']['nodes'],
    importedAt: number,
  ): void {
    if (!this.conversationBranchRepo) {
      fail('REFERENCE_NOT_CLOSED', 'immutable conversation ledger is required for Session Fork import');
    }
    const boundary = {
      ownerUserId: persistedOwnerScope(plan.targetOwnerScopeId),
      projectId: plan.targetProjectId,
    };
    const mappingsByFork = new Map<string, SessionExportEnvelopeV2['lineage']['messageMappings']>();
    for (const mapping of plan.envelope.lineage.messageMappings) {
      const grouped = mappingsByFork.get(mapping.forkId) ?? [];
      grouped.push(mapping);
      mappingsByFork.set(mapping.forkId, grouped);
    }
    for (const mappings of mappingsByFork.values()) {
      mappings.sort((left, right) => left.ordinal - right.ordinal);
    }

    for (const node of nodes) {
      const messages = this.readImportedConversationMessages(node.sessionId);
      if (!node.parentSessionId || !node.forkId) {
        this.conversationBranchRepo.initializeSessionBranch({
          sessionId: node.sessionId,
          boundary,
          createdAt: node.createdAt,
        });
        for (const message of messages) {
          this.conversationBranchRepo.appendMessage({
            sessionId: node.sessionId,
            boundary,
            message: importedConversationSnapshot(message),
            idempotencyKey: `portability:${plan.sourceExportId}:append:${message.id}`,
            provenance: {
              kind: 'portability_import',
              sourceExportId: plan.sourceExportId,
              importedAt,
            },
            createdAt: message.timestamp,
          });
        }
        continue;
      }

      const mappings = mappingsByFork.get(node.forkId) ?? [];
      this.conversationBranchRepo.createForkBranch({
        sourceSessionId: node.parentSessionId,
        childSessionId: node.sessionId,
        sourceAnchorMessageId: node.sourceAnchorMessageId ?? '',
        childAnchorMessageId: node.anchorChildMessageId ?? '',
        forkId: node.forkId,
        boundary,
        messageAliases: mappings.map((mapping) => ({
          sourceMessageId: mapping.sourceMessageId,
          childMessageId: mapping.childMessageId,
        })),
        idempotencyKey: `portability:${plan.sourceExportId}:fork:${node.forkId}`,
        createdAt: node.createdAt,
      });
      const copiedMessageIds = new Set(mappings.map((mapping) => mapping.childMessageId));
      for (const message of messages) {
        if (copiedMessageIds.has(message.id)) continue;
        this.conversationBranchRepo.appendMessage({
          sessionId: node.sessionId,
          boundary,
          message: importedConversationSnapshot(message),
          idempotencyKey: `portability:${plan.sourceExportId}:append:${message.id}`,
          provenance: {
            kind: 'portability_import',
            sourceExportId: plan.sourceExportId,
            importedAt,
          },
          createdAt: message.timestamp,
        });
      }
    }

    for (const node of nodes) {
      const messages = this.readImportedConversationMessages(node.sessionId);
      if (!messages.some((message) => message.visibility === 'rewound')) continue;
      this.conversationBranchRepo.recordProjectionReplacement({
        sessionId: node.sessionId,
        boundary,
        messages: messages
          .filter((message) => message.visibility !== 'rewound')
          .map(importedConversationSnapshot),
        idempotencyKey: `portability:${plan.sourceExportId}:visibility:${node.sessionId}`,
        reason: 'portability_import_visibility',
        createdAt: importedAt,
      });
    }
  }

  private readImportedConversationMessages(sessionId: string): Message[] {
    return (this.db.prepare(`
      SELECT rowid AS __rowid, *
      FROM messages
      WHERE session_id = ?
      ORDER BY timestamp ASC, rowid ASC
    `).all(sessionId) as Array<Record<string, unknown>>).map((row) => rowToMessage(row));
  }

  importedCompatibilityProjectionDigest(sessionId: string): string {
    const rows = this.db.prepare(`
      SELECT rowid AS __rowid, *
      FROM messages
      WHERE session_id = ?
      ORDER BY timestamp ASC, rowid ASC
    `).all(sessionId) as Array<Record<string, unknown>>;
    return conversationSha256(canonicalConversationJson(rows.map((row, index) => ({
      index,
      messageId: String(row.id),
      payload: canonicalConversationMessagePayload(
        sanitizeConversationMessageSnapshot(rowToMessage(row)) as unknown as Record<string, unknown>,
      ),
    }))));
  }

}
