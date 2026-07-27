import { createHash } from 'node:crypto';
import type BetterSqlite3 from 'better-sqlite3';

import type { Message } from '../../../../shared/contract/message';
import type {
  ConversationLineageAudit,
  ConversationLineageAuditStatus,
  ConversationLineageIssueCode,
  ConversationMessageSnapshot,
} from '../../../../shared/contract/conversationBranch';
import type {
  ForkNeighborhoodProjection,
  ForkSearchDocument,
  ForkTreeNodeProjection,
  PortableSessionV2,
  SessionExportEnvelopeV2,
  SessionExportModeV2,
  SessionForkImportPlan,
  SessionForkSyncEnvelopeRecord,
  SessionForkSyncTransport,
  SessionForkSyncWireEnvelope,
} from '../../../../shared/contract/sessionForkPortability';
import {
  LOCAL_SESSION_FORK_OWNER_SCOPE_ID,
  SessionForkPortabilityError,
} from '../../../../shared/contract/sessionForkPortability';
import {
  buildForkNeighborhoodProjection,
  buildForkSearchDocuments,
  buildForkTreeProjection,
  decodeSessionExportEnvelopeV2,
  encodeSessionExportEnvelopeV2,
  planPortableConversationHistoryImport,
  planSessionForkImport,
  searchForkDocuments,
  validateSessionExportEnvelopeV2,
} from '../../sessionFork/portability';
import type {
  PortableConversationProjectionRepairReplayAction,
  PortableConversationHistoryImportPlan,
  PortableConversationReplayAction,
} from '../../sessionFork/portability/conversationHistoryTypes';
import {
  deepPortableClone,
} from '../../sessionFork/portability/canonical';
import { SessionForkPortabilitySourceReader } from './SessionForkPortabilitySourceReader';
import { ConversationBranchRepository } from './ConversationBranchRepository';
import { rowToMessage } from './sessionRepositoryParsers';
import { sanitizeConversationMessageSnapshot } from '../conversationMessageSnapshot';
import {
  canonicalConversationJson,
  canonicalConversationMessagePayload,
  conversationSha256,
} from '../database/schemaConversationBranch';

export interface ExportSessionForkInput {
  exportId: string;
  rootSessionId: string;
  ownerScopeId: string;
  projectId: string;
  mode: SessionExportModeV2;
  exportedAt?: number;
}

export interface ImportSessionForkInput {
  envelope: SessionExportEnvelopeV2;
  targetOwnerScopeId: string;
  targetProjectId: string;
  namespace: string;
  allowProjectRemap?: boolean;
  importedAt?: number;
}

export interface ImportSessionForkResult {
  importId: string;
  sourceExportId: string;
  rootSessionId: string;
  sessionIdMap: Record<string, string>;
  messageIdMap: Record<string, string>;
  forkIdMap: Record<string, string>;
  importedAt: number;
}

export interface EnqueueSessionForkOutboundInput {
  syncEnvelopeId: string;
  envelope: SessionExportEnvelopeV2;
  dependencyIds: string[];
  ownerScopeId: string;
  projectId: string;
  now?: number;
}

export interface IngestSessionForkInboundInput {
  wire: SessionForkSyncWireEnvelope;
  ownerScopeId: string;
  projectId: string;
  now?: number;
}

export interface FlushSessionForkOutboundOptions {
  transport?: SessionForkSyncTransport;
  remoteUploadEnabled?: boolean;
  now?: number;
}

interface StoredImportRow {
  import_id: string;
  source_export_id: string;
  source_payload_digest: string;
  target_owner_scope_id: string;
  target_project_id: string;
  import_namespace: string;
  imported_root_session_id: string;
  plan_json: string;
  created_at: number;
}

interface StoredSyncRow {
  direction: 'outbox' | 'inbox';
  sync_envelope_id: string;
  owner_scope_id: string;
  project_id: string;
  payload_digest: string;
  dependency_ids_json: string;
  envelope_json: string;
  state: SessionForkSyncEnvelopeRecord['state'];
  reason: string | null;
  attempt_count: number;
  created_at: number;
  updated_at: number;
}

interface StoredImportPlanV1 {
  schema: 'neo.session-fork-import-plan';
  version: 1;
  result: ImportSessionForkResult;
  expectedConversationStatusBySession: Record<string, ConversationLineageAuditStatus>;
  compatibilityProjectionDigestBySession: Record<string, string>;
}

interface TargetQuarantineEvidence {
  issueDigest: string;
  quarantineEventId: string;
}

function fail(
  code: ConstructorParameters<typeof SessionForkPortabilityError>[0],
  message: string,
): never {
  throw new SessionForkPortabilityError(code, message);
}

function parseJson<T>(value: unknown, label: string): T {
  if (typeof value !== 'string') fail('INVALID_ENVELOPE', `${label} is not JSON text`);
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    fail(
      'INVALID_ENVELOPE',
      `${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function parseStringArray(value: unknown, label: string): string[] {
  const parsed = parseJson<unknown>(value, label);
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== 'string')) {
    fail('INVALID_ENVELOPE', `${label} must be a string array`);
  }
  return parsed as string[];
}

function canonicalStringify(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalStringify(record[key])}`)
    .join(',')}}`;
}

function digestHex(value: unknown): string {
  return createHash('sha256').update(canonicalStringify(value)).digest('hex');
}

function requireNonEmpty(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) fail('INVALID_ENVELOPE', `${label} is required`);
  return trimmed;
}

function sanitizeImportedEngine(session: PortableSessionV2): Record<string, unknown> {
  const kind = session.engine?.kind ?? 'native';
  const engine: Record<string, unknown> = {
    kind,
    permissionProfile: kind === 'native' ? 'default' : 'read_only',
    origin: 'import',
  };
  if (session.engine?.model) engine.model = session.engine.model;
  return engine;
}

function persistedOwnerScope(ownerScopeId: string): string | null {
  return ownerScopeId === LOCAL_SESSION_FORK_OWNER_SCOPE_ID ? null : ownerScopeId;
}

function importedConversationSnapshot(message: Message): ConversationMessageSnapshot {
  return sanitizeConversationMessageSnapshot(message);
}

function importResultFromPlan(
  plan: SessionForkImportPlan,
  importId: string,
  importedAt: number,
): ImportSessionForkResult {
  return {
    importId,
    sourceExportId: plan.sourceExportId,
    rootSessionId: plan.envelope.rootSessionId,
    sessionIdMap: { ...plan.sessionIdMap },
    messageIdMap: { ...plan.messageIdMap },
    forkIdMap: { ...plan.forkIdMap },
    importedAt,
  };
}

function importIdFor(
  sourceExportId: string,
  payloadDigest: string,
  ownerScopeId: string,
  projectId: string,
  namespace: string,
): string {
  return `session-fork-import:${digestHex({
    sourceExportId,
    payloadDigest,
    ownerScopeId,
    projectId,
    namespace,
  }).slice(0, 32)}`;
}

export class SessionForkPortabilityRepository {
  private readonly conversationBranchRepo: ConversationBranchRepository | null;

  constructor(
    private readonly db: BetterSqlite3.Database,
    conversationBranchRepo?: ConversationBranchRepository,
  ) {
    const hasConversationLedger = Boolean(this.db.prepare(`
      SELECT 1
      FROM sqlite_master
      WHERE type = 'table' AND name = 'conversation_branches'
      LIMIT 1
    `).get());
    this.conversationBranchRepo = conversationBranchRepo
      ?? (hasConversationLedger ? new ConversationBranchRepository(this.db) : null);
  }

  exportSessionFork(input: ExportSessionForkInput): SessionExportEnvelopeV2 {
    const exportId = requireNonEmpty(input.exportId, 'exportId');
    const rootSessionId = requireNonEmpty(input.rootSessionId, 'rootSessionId');
    const ownerScopeId = requireNonEmpty(input.ownerScopeId, 'ownerScopeId');
    const projectId = requireNonEmpty(input.projectId, 'projectId');
    const existing = this.readStoredEnvelopeById(exportId);
    if (existing) {
      if (
        existing.ownerScopeId !== ownerScopeId
        || existing.projectId !== projectId
        || existing.rootSessionId !== rootSessionId
        || existing.mode !== input.mode
      ) {
        fail('SYNC_ID_DIGEST_CONFLICT', `exportId ${exportId} is already bound to another export`);
      }
      return existing;
    }

    const apply = this.db.transaction(() => {
      const raced = this.readStoredEnvelopeById(exportId);
      if (raced) {
        if (
          raced.ownerScopeId !== ownerScopeId
          || raced.projectId !== projectId
          || raced.rootSessionId !== rootSessionId
          || raced.mode !== input.mode
        ) {
          fail('SYNC_ID_DIGEST_CONFLICT', `exportId ${exportId} is already bound to another export`);
        }
        return raced;
      }
      const envelope = new SessionForkPortabilitySourceReader(this.db).buildEnvelope({
        ...input,
        exportId,
        rootSessionId,
        ownerScopeId,
        projectId,
        exportedAt: input.exportedAt ?? Date.now(),
      });
      this.insertDurableEnvelope(envelope);
      return envelope;
    });
    return apply.immediate();
  }

  getDurableEnvelope(
    exportId: string,
    ownerScopeId: string,
    projectId: string,
  ): SessionExportEnvelopeV2 | null {
    const envelope = this.readStoredEnvelopeById(exportId);
    if (!envelope) return null;
    this.requireEnvelopeScope(envelope, ownerScopeId, projectId);
    return envelope;
  }

  importSessionFork(input: ImportSessionForkInput): ImportSessionForkResult {
    const importedAt = input.importedAt ?? Date.now();
    const sourceConversationHistory = input.envelope.conversationHistory;
    const plan = planSessionForkImport({
      envelope: input.envelope,
      targetOwnerScopeId: input.targetOwnerScopeId,
      targetProjectId: input.targetProjectId,
      namespace: input.namespace,
      allowProjectRemap: input.allowProjectRemap,
    });
    const importId = importIdFor(
      plan.sourceExportId,
      input.envelope.payloadDigest,
      input.targetOwnerScopeId,
      input.targetProjectId,
      input.namespace,
    );
    const existing = this.readImportRecord(
      plan.sourceExportId,
      input.targetOwnerScopeId,
      input.targetProjectId,
      input.namespace,
    );
    if (existing) return this.resolveExistingImport(existing, input.envelope.payloadDigest);

    const apply = this.db.transaction(() => {
      const raced = this.readImportRecord(
        plan.sourceExportId,
        input.targetOwnerScopeId,
        input.targetProjectId,
        input.namespace,
      );
      if (raced) return this.resolveExistingImport(raced, input.envelope.payloadDigest);

      const nodes = [...plan.envelope.lineage.nodes].sort((left, right) => (
        left.depth - right.depth
        || left.ordinal - right.ordinal
        || left.createdAt - right.createdAt
        || left.sessionId.localeCompare(right.sessionId)
      ));
      const sessions = new Map(plan.envelope.sessions.map((session) => [session.id, session]));
      for (const node of nodes) {
        const session = sessions.get(node.sessionId);
        if (!session) {
          fail('REFERENCE_NOT_CLOSED', `import session ${node.sessionId} is missing`);
        }
        this.insertImportedSession(session, plan, importedAt);
      }

      const messagesBySession = new Map<string, typeof plan.envelope.messages>();
      for (const message of plan.envelope.messages) {
        const grouped = messagesBySession.get(message.sessionId) ?? [];
        grouped.push(message);
        messagesBySession.set(message.sessionId, grouped);
      }
      for (const node of nodes) {
        const messages = [...(messagesBySession.get(node.sessionId) ?? [])]
          .sort((left, right) => left.ordinal - right.ordinal);
        for (const message of messages) this.insertImportedMessage(message);
      }

      const nodeBySession = new Map(nodes.map((node) => [node.sessionId, node]));
      for (const node of nodes) {
        if (!node.parentSessionId || !node.forkId) continue;
        const parentNode = nodeBySession.get(node.parentSessionId);
        if (!parentNode) {
          fail('REFERENCE_NOT_CLOSED', `import parent ${node.parentSessionId} is missing`);
        }
        const mappings = plan.envelope.lineage.messageMappings
          .filter((mapping) => mapping.forkId === node.forkId)
          .sort((left, right) => left.ordinal - right.ordinal);
        this.insertImportedFork(node, parentNode.forkId, mappings, plan, importedAt);
      }

      const importedHistoryPlan = sourceConversationHistory
        ? this.integrateImportedConversationHistory(
          sourceConversationHistory,
          plan,
        )
        : null;
      if (!sourceConversationHistory) {
        this.integrateImportedConversationLedger(plan, nodes, importedAt);
      }

      // Compatibility projections are deliberately last. Until every fork and
      // mapping is durable, imported sessions cannot claim user-visible lineage.
      for (const node of nodes) {
        if (!node.parentSessionId || !node.forkId) continue;
        const session = sessions.get(node.sessionId);
        if (!session) {
          fail('REFERENCE_NOT_CLOSED', `import session ${node.sessionId} disappeared`);
        }
        this.finalizeImportedLineageProjection(node, session, plan);
      }
      if (sourceConversationHistory && importedHistoryPlan) {
        this.verifyImportedConversationHistory(
          sourceConversationHistory,
          importedHistoryPlan,
          plan,
        );
      }

      const result = importResultFromPlan(plan, importId, importedAt);
      const storedPlan: StoredImportPlanV1 = {
        schema: 'neo.session-fork-import-plan',
        version: 1,
        result,
        expectedConversationStatusBySession: this.expectedConversationStatusBySession(
          sourceConversationHistory,
          plan,
        ),
        compatibilityProjectionDigestBySession: Object.fromEntries(
          Object.values(result.sessionIdMap).map((sessionId) => [
            sessionId,
            this.importedCompatibilityProjectionDigest(sessionId),
          ]),
        ),
      };
      this.db.prepare(`
        INSERT INTO session_fork_portability_imports (
          import_id, source_export_id, source_payload_digest,
          target_owner_scope_id, target_project_id, import_namespace,
          imported_root_session_id, plan_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        importId,
        plan.sourceExportId,
        input.envelope.payloadDigest,
        input.targetOwnerScopeId,
        input.targetProjectId,
        input.namespace,
        plan.envelope.rootSessionId,
        canonicalStringify(storedPlan),
        importedAt,
      );
      return result;
    });
    return apply.immediate();
  }

  private integrateImportedConversationHistory(
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

  private verifyImportedConversationHistory(
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

  private expectedConversationStatusBySession(
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

  private assertConversationAuditClosure(
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

  private integrateImportedConversationLedger(
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

  private importedCompatibilityProjectionDigest(sessionId: string): string {
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

  enqueueOutbound(
    input: EnqueueSessionForkOutboundInput,
  ): SessionForkSyncEnvelopeRecord {
    this.requireEnvelopeScope(input.envelope, input.ownerScopeId, input.projectId);
    this.assertDependencies(input.syncEnvelopeId, input.dependencyIds);
    const existing = this.readSyncRow('outbox', input.syncEnvelopeId);
    if (existing) {
      return this.resolveSyncDuplicate(
        existing,
        input.envelope.payloadDigest,
        input.ownerScopeId,
        input.projectId,
      );
    }
    const now = input.now ?? Date.now();
    const apply = this.db.transaction(() => {
      this.persistEnvelopeIfAbsent(input.envelope);
      this.db.prepare(`
        INSERT INTO session_fork_portability_sync (
          direction, sync_envelope_id, owner_scope_id, project_id,
          payload_digest, dependency_ids_json, envelope_json, state,
          reason, attempt_count, created_at, updated_at
        ) VALUES ('outbox', ?, ?, ?, ?, ?, ?, 'local_only', NULL, 0, ?, ?)
      `).run(
        input.syncEnvelopeId,
        input.ownerScopeId,
        input.projectId,
        input.envelope.payloadDigest,
        canonicalStringify(input.dependencyIds),
        encodeSessionExportEnvelopeV2(input.envelope),
        now,
        now,
      );
      return this.requireSyncRecord(
        'outbox',
        input.syncEnvelopeId,
        input.ownerScopeId,
        input.projectId,
      );
    });
    return apply.immediate();
  }

  async flushOutbound(
    syncEnvelopeId: string,
    ownerScopeId: string,
    projectId: string,
    options: FlushSessionForkOutboundOptions = {},
  ): Promise<SessionForkSyncEnvelopeRecord> {
    const current = this.requireSyncRecord(
      'outbox',
      syncEnvelopeId,
      ownerScopeId,
      projectId,
    );
    if (current.state === 'applied') return current;
    if (current.state === 'blocked' && current.reason === 'SYNC_ID_DIGEST_CONFLICT') {
      fail('SYNC_ID_DIGEST_CONFLICT', `${syncEnvelopeId} is blocked by a digest conflict`);
    }
    if (options.remoteUploadEnabled !== true) {
      fail('REMOTE_UPLOAD_DISABLED', 'remote lineage upload requires explicit enablement');
    }
    if (!options.transport) {
      fail('INVALID_ENVELOPE', 'remote upload was enabled without an explicit transport');
    }
    const now = options.now ?? Date.now();
    this.db.prepare(`
      UPDATE session_fork_portability_sync
      SET state = 'pending', reason = NULL, attempt_count = attempt_count + 1,
          updated_at = ?
      WHERE direction = 'outbox' AND sync_envelope_id = ?
        AND owner_scope_id = ? AND project_id = ?
    `).run(now, syncEnvelopeId, ownerScopeId, projectId);
    const pending = this.requireSyncRecord(
      'outbox',
      syncEnvelopeId,
      ownerScopeId,
      projectId,
    );
    try {
      await options.transport.upload({
        syncEnvelopeId,
        payloadDigest: pending.payloadDigest,
        dependencyIds: [...pending.dependencyIds],
        envelope: deepPortableClone(pending.envelope),
      });
      this.db.prepare(`
        UPDATE session_fork_portability_sync
        SET state = 'applied', reason = NULL, updated_at = ?
        WHERE direction = 'outbox' AND sync_envelope_id = ?
          AND owner_scope_id = ? AND project_id = ? AND state = 'pending'
      `).run(now + 1, syncEnvelopeId, ownerScopeId, projectId);
      return this.requireSyncRecord(
        'outbox',
        syncEnvelopeId,
        ownerScopeId,
        projectId,
      );
    } catch (error) {
      const reason = error instanceof SessionForkPortabilityError
        ? error.code
        : 'TRANSPORT_UPLOAD_FAILED';
      this.db.prepare(`
        UPDATE session_fork_portability_sync
        SET state = 'blocked', reason = ?, updated_at = ?
        WHERE direction = 'outbox' AND sync_envelope_id = ?
          AND owner_scope_id = ? AND project_id = ?
      `).run(reason, now + 1, syncEnvelopeId, ownerScopeId, projectId);
      throw error;
    }
  }

  ingestInbound(input: IngestSessionForkInboundInput): SessionForkSyncEnvelopeRecord {
    const {
      wire,
      ownerScopeId,
      projectId,
    } = input;
    const existing = this.readSyncRow('inbox', wire.syncEnvelopeId);
    if (existing) {
      return this.resolveSyncDuplicate(
        existing,
        wire.payloadDigest,
        ownerScopeId,
        projectId,
      );
    }
    this.assertDependencies(wire.syncEnvelopeId, wire.dependencyIds);
    if (wire.payloadDigest !== wire.envelope.payloadDigest) {
      fail('DIGEST_MISMATCH', 'sync wrapper digest differs from its envelope');
    }
    this.requireEnvelopeScope(wire.envelope, ownerScopeId, projectId);
    const now = input.now ?? Date.now();
    const apply = this.db.transaction(() => {
      this.persistEnvelopeIfAbsent(wire.envelope);
      const missing = this.unappliedInboundDependencies(
        wire.dependencyIds,
        ownerScopeId,
        projectId,
      );
      this.db.prepare(`
        INSERT INTO session_fork_portability_sync (
          direction, sync_envelope_id, owner_scope_id, project_id,
          payload_digest, dependency_ids_json, envelope_json, state,
          reason, attempt_count, created_at, updated_at
        ) VALUES ('inbox', ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
      `).run(
        wire.syncEnvelopeId,
        ownerScopeId,
        projectId,
        wire.payloadDigest,
        canonicalStringify(wire.dependencyIds),
        encodeSessionExportEnvelopeV2(wire.envelope),
        missing.length > 0 ? 'quarantined' : 'ready',
        missing.length > 0 ? 'DEPENDENCY_NOT_APPLIED' : null,
        now,
        now,
      );
      return this.requireSyncRecord(
        'inbox',
        wire.syncEnvelopeId,
        ownerScopeId,
        projectId,
      );
    });
    return apply.immediate();
  }

  applyInbound(
    syncEnvelopeId: string,
    ownerScopeId: string,
    projectId: string,
    now = Date.now(),
  ): SessionForkSyncEnvelopeRecord {
    const apply = this.db.transaction(() => {
      const current = this.requireSyncRecord(
        'inbox',
        syncEnvelopeId,
        ownerScopeId,
        projectId,
      );
      if (current.state === 'applied') return current;
      if (current.state !== 'ready') {
        fail('ENVELOPE_NOT_READY', `${syncEnvelopeId} is ${current.state}`);
      }
      this.db.prepare(`
        UPDATE session_fork_portability_sync
        SET state = 'applied', reason = NULL, updated_at = ?
        WHERE direction = 'inbox' AND sync_envelope_id = ?
          AND owner_scope_id = ? AND project_id = ? AND state = 'ready'
      `).run(now, syncEnvelopeId, ownerScopeId, projectId);
      this.promoteQuarantinedInbound(now, ownerScopeId, projectId);
      return this.requireSyncRecord(
        'inbox',
        syncEnvelopeId,
        ownerScopeId,
        projectId,
      );
    });
    return apply.immediate();
  }

  recoverInterruptedSync(now = Date.now()): number {
    return this.db.prepare(`
      UPDATE session_fork_portability_sync
      SET state = 'local_only', reason = 'RECOVERED_PENDING_UPLOAD',
          updated_at = ?
      WHERE direction = 'outbox' AND state = 'pending'
    `).run(now).changes;
  }

  getSyncRecord(
    direction: 'outbox' | 'inbox',
    syncEnvelopeId: string,
    ownerScopeId: string,
    projectId: string,
  ): SessionForkSyncEnvelopeRecord | null {
    const row = this.readSyncRow(direction, syncEnvelopeId);
    if (!row) return null;
    if (row.owner_scope_id !== ownerScopeId) {
      fail('OWNER_SCOPE_MISMATCH', `sync envelope ${syncEnvelopeId} belongs to another owner`);
    }
    if (row.project_id !== projectId) {
      fail('PROJECT_SCOPE_MISMATCH', `sync envelope ${syncEnvelopeId} belongs to another project`);
    }
    return this.syncRowToRecord(row);
  }

  searchDurableForks(
    exportId: string,
    ownerScopeId: string,
    projectId: string,
    query: string,
  ): ForkSearchDocument[] {
    const envelope = this.requireDurableEnvelope(exportId, ownerScopeId, projectId);
    return searchForkDocuments(buildForkSearchDocuments(envelope), query);
  }

  getDurableForkTree(
    exportId: string,
    ownerScopeId: string,
    projectId: string,
  ): ForkTreeNodeProjection {
    const envelope = this.requireDurableEnvelope(exportId, ownerScopeId, projectId);
    return buildForkTreeProjection(envelope.lineage);
  }

  getDurableForkNeighborhood(
    exportId: string,
    ownerScopeId: string,
    projectId: string,
    centerSessionId: string,
    radius = 1,
  ): ForkNeighborhoodProjection {
    const envelope = this.requireDurableEnvelope(exportId, ownerScopeId, projectId);
    return buildForkNeighborhoodProjection(envelope.lineage, centerSessionId, radius);
  }

  private insertDurableEnvelope(envelope: SessionExportEnvelopeV2): void {
    this.db.prepare(`
      INSERT INTO session_fork_portability_exports (
        export_id, owner_scope_id, project_id, root_session_id, mode,
        payload_digest, envelope_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      envelope.exportId,
      envelope.ownerScopeId,
      envelope.projectId,
      envelope.rootSessionId,
      envelope.mode,
      envelope.payloadDigest,
      encodeSessionExportEnvelopeV2(envelope),
      envelope.exportedAt,
    );
  }

  private persistEnvelopeIfAbsent(envelope: SessionExportEnvelopeV2): void {
    const existing = this.readStoredEnvelopeById(envelope.exportId);
    if (existing) {
      if (existing.payloadDigest !== envelope.payloadDigest) {
        fail('SYNC_ID_DIGEST_CONFLICT', `export ${envelope.exportId} has another digest`);
      }
      return;
    }
    this.insertDurableEnvelope(envelope);
  }

  private readStoredEnvelopeById(exportId: string): SessionExportEnvelopeV2 | null {
    const row = this.db.prepare(`
      SELECT envelope_json
      FROM session_fork_portability_exports
      WHERE export_id = ?
      LIMIT 1
    `).get(exportId) as { envelope_json: string } | undefined;
    return row ? decodeSessionExportEnvelopeV2(row.envelope_json) : null;
  }

  private requireDurableEnvelope(
    exportId: string,
    ownerScopeId: string,
    projectId: string,
  ): SessionExportEnvelopeV2 {
    const envelope = this.getDurableEnvelope(exportId, ownerScopeId, projectId);
    if (!envelope) fail('SYNC_ENVELOPE_NOT_FOUND', `export ${exportId} does not exist`);
    return envelope;
  }

  private requireEnvelopeScope(
    envelope: SessionExportEnvelopeV2,
    ownerScopeId: string,
    projectId: string,
  ): void {
    validateSessionExportEnvelopeV2(envelope, { ownerScopeId, projectId });
  }

  private insertImportedSession(
    session: PortableSessionV2,
    plan: SessionForkImportPlan,
    importedAt: number,
  ): void {
    const metadata = {
      portabilityImportV2: {
        sourceExportId: plan.sourceExportId,
        sourcePayloadDigest: plan.envelope.payloadDigest,
        importedAt,
      },
      ...(session.workspace ? { portableWorkspaceV2: session.workspace } : {}),
      ...(session.id === plan.envelope.rootSessionId && plan.envelope.detachedProvenance
        ? { portableDetachedForkProvenanceV1: plan.envelope.detachedProvenance }
        : {}),
      portableModelConfigV2: session.modelConfig,
    };
    this.db.prepare(`
      INSERT INTO sessions (
        id, user_id, title, model_provider, model_name, working_directory,
        project_id, session_type, origin, metadata, parent_session_id,
        source_run_id, agent_engine, memory_mode, suppressed_memory_entry_ids,
        read_only, retry_of_session_id, created_at, updated_at,
        workbench_provenance, is_deleted, synced_at, status, workspace,
        last_token_usage, git_branch
      ) VALUES (
        ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?,
        NULL, ?, ?, NULL, 0, NULL, 'idle', NULL, NULL, NULL
      )
    `).run(
      session.id,
      persistedOwnerScope(plan.targetOwnerScopeId),
      session.title,
      session.modelConfig.provider,
      session.modelConfig.model,
      plan.targetProjectId,
      session.type ?? 'chat',
      canonicalStringify({
        kind: 'import',
        ...(session.origin?.name ? { name: session.origin.name } : {}),
        metadata: {
          sourceExportId: plan.sourceExportId,
          sourceOriginKind: session.origin?.kind ?? null,
        },
      }),
      canonicalStringify(metadata),
      canonicalStringify(sanitizeImportedEngine(session)),
      session.memoryMode === 'off' ? 'off' : 'auto',
      canonicalStringify(session.suppressedMemoryEntryIds ?? []),
      session.readOnly || session.workspace?.mode === 'isolated_at_anchor' ? 1 : 0,
      session.createdAt,
      session.updatedAt,
    );
  }

  private insertImportedMessage(
    message: SessionExportEnvelopeV2['messages'][number],
  ): void {
    const provenance: Record<string, unknown> = {};
    if (message.source !== undefined) provenance.source = message.source;
    if (message.subtype !== undefined) provenance.subtype = message.subtype;
    if (message.artifacts?.length) {
      provenance.readOnlyArtifactProvenanceV2 = message.artifacts;
    }
    this.db.prepare(`
      INSERT INTO messages (
        id, session_id, role, content, timestamp, tool_calls, tool_results,
        attachments, thinking, effort_level, synced_at, content_parts, metadata,
        is_meta, compaction, visibility, hidden_by_rewind_id, hidden_at
      ) VALUES (
        ?, ?, ?, ?, ?, NULL, NULL, ?, NULL, NULL, NULL, NULL, ?, ?,
        NULL, ?, NULL, NULL
      )
    `).run(
      message.id,
      message.sessionId,
      message.role,
      message.content,
      message.timestamp,
      message.attachments?.length ? canonicalStringify(message.attachments) : null,
      Object.keys(provenance).length > 0 ? canonicalStringify(provenance) : null,
      message.isMeta ? 1 : 0,
      message.visibility ?? 'active',
    );
  }

  private insertImportedFork(
    node: SessionExportEnvelopeV2['lineage']['nodes'][number],
    parentForkId: string | null,
    mappings: SessionExportEnvelopeV2['lineage']['messageMappings'],
    plan: SessionForkImportPlan,
    importedAt: number,
  ): void {
    if (
      !node.forkId
      || !node.parentSessionId
      || !node.sourceAnchorMessageId
      || !node.anchorChildMessageId
      || mappings.length === 0
      || mappings.some((mapping, index) => mapping.ordinal !== index)
    ) {
      fail('REFERENCE_NOT_CLOSED', `fork node ${node.sessionId} is incomplete`);
    }
    const idempotencyKey = `import:${plan.sourceExportId}:${node.forkId}`;
    this.db.prepare(`
      INSERT INTO session_forks (
        id, source_session_id, child_session_id, root_session_id,
        parent_fork_id, anchor_message_id, anchor_child_message_id,
        workspace_mode, context_delivery_mode, idempotency_key,
        request_digest, source_prefix_digest, status, depth, sync_state,
        workspace_snapshot_id, error_json, created_at, updated_at, committed_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?, 'local_only',
        NULL, NULL, ?, ?, ?
      )
    `).run(
      node.forkId,
      node.parentSessionId,
      node.sessionId,
      plan.envelope.rootSessionId,
      parentForkId,
      node.sourceAnchorMessageId,
      node.anchorChildMessageId,
      node.workspaceMode,
      node.contextDeliveryMode,
      idempotencyKey,
      digestHex({
        sourceExportId: plan.sourceExportId,
        forkId: node.forkId,
        sourceAnchorMessageId: node.sourceAnchorMessageId,
        workspaceMode: node.workspaceMode,
        contextDeliveryMode: node.contextDeliveryMode,
      }),
      digestHex(mappings.map((mapping) => ({
        ordinal: mapping.ordinal,
        sourceMessageId: mapping.sourceMessageId,
        sourceRowDigest: mapping.sourceRowDigest,
      }))),
      node.depth,
      node.createdAt,
      importedAt,
      importedAt,
    );
    const insertMapping = this.db.prepare(`
      INSERT INTO session_fork_message_map (
        fork_id, ordinal, source_message_id, child_message_id,
        source_timestamp, source_order_key, source_row_digest
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const mapping of mappings) {
      const importedSource = this.db.prepare(`
        SELECT rowid AS source_rowid, timestamp
        FROM messages
        WHERE session_id = ? AND id = ?
        LIMIT 1
      `).get(node.parentSessionId, mapping.sourceMessageId) as {
        source_rowid: number;
        timestamp: number;
      } | undefined;
      if (!importedSource) {
        fail(
          'REFERENCE_NOT_CLOSED',
          `import fork ${node.forkId} lost source message ${mapping.sourceMessageId}`,
        );
      }
      insertMapping.run(
        mapping.forkId,
        mapping.ordinal,
        mapping.sourceMessageId,
        mapping.childMessageId,
        Number(importedSource.timestamp),
        `${Number(importedSource.timestamp)}:${Number(importedSource.source_rowid)}`,
        mapping.sourceRowDigest.replace(/^sha256:/u, ''),
      );
    }
  }

  private finalizeImportedLineageProjection(
    node: SessionExportEnvelopeV2['lineage']['nodes'][number],
    session: PortableSessionV2,
    plan: SessionForkImportPlan,
  ): void {
    const row = this.db.prepare(`
      SELECT metadata
      FROM sessions
      WHERE id = ?
      LIMIT 1
    `).get(node.sessionId) as { metadata: string | null } | undefined;
    if (!row) fail('REFERENCE_NOT_CLOSED', `imported session ${node.sessionId} is missing`);
    const metadata = row.metadata
      ? parseJson<Record<string, unknown>>(row.metadata, `session ${node.sessionId} metadata`)
      : {};
    metadata.forkLineage = {
      forkId: node.forkId,
      rootSessionId: plan.envelope.rootSessionId,
      parentSessionId: node.parentSessionId,
      childSessionId: node.sessionId,
      sourceAnchorMessageId: node.sourceAnchorMessageId,
      anchorChildMessageId: node.anchorChildMessageId,
      depth: node.depth,
      workspaceMode: node.workspaceMode,
      contextDeliveryMode: node.contextDeliveryMode,
      status: 'completed',
      syncState: 'local_only',
      createdAt: node.createdAt,
    };
    if (session.workspace) metadata.portableWorkspaceV2 = session.workspace;
    const result = this.db.prepare(`
      UPDATE sessions
      SET parent_session_id = ?, metadata = ?
      WHERE id = ?
    `).run(node.parentSessionId, canonicalStringify(metadata), node.sessionId);
    if (result.changes !== 1) {
      fail('REFERENCE_NOT_CLOSED', `lineage projection for ${node.sessionId} was not written`);
    }
  }

  private readImportRecord(
    sourceExportId: string,
    ownerScopeId: string,
    projectId: string,
    namespace: string,
  ): StoredImportRow | null {
    return (this.db.prepare(`
      SELECT *
      FROM session_fork_portability_imports
      WHERE source_export_id = ? AND target_owner_scope_id = ?
        AND target_project_id = ? AND import_namespace = ?
      LIMIT 1
    `).get(
      sourceExportId,
      ownerScopeId,
      projectId,
      namespace,
    ) as StoredImportRow | undefined) ?? null;
  }

  private resolveExistingImport(
    row: StoredImportRow,
    payloadDigest: string,
  ): ImportSessionForkResult {
    if (row.source_payload_digest !== payloadDigest) {
      fail('SYNC_ID_DIGEST_CONFLICT', 'import namespace was reused for a different payload');
    }
    const parsedPlan = parseJson<ImportSessionForkResult | StoredImportPlanV1>(
      row.plan_json,
      'stored import plan',
    );
    const storedPlan = (
      'schema' in parsedPlan
      && parsedPlan.schema === 'neo.session-fork-import-plan'
      && parsedPlan.version === 1
    ) ? parsedPlan : null;
    const result = storedPlan?.result ?? parsedPlan as ImportSessionForkResult;
    if (
      result.importId !== row.import_id
      || result.sourceExportId !== row.source_export_id
      || result.rootSessionId !== row.imported_root_session_id
    ) {
      fail('REFERENCE_NOT_CLOSED', `completed import ${row.import_id} has a divergent stored plan`);
    }
    if (!this.conversationBranchRepo) {
      fail('REFERENCE_NOT_CLOSED', 'completed import lost its immutable conversation ledger');
    }
    const boundary = {
      ownerUserId: persistedOwnerScope(row.target_owner_scope_id),
      projectId: row.target_project_id,
    };
    for (const sessionId of Object.values(result.sessionIdMap)) {
      const session = this.db.prepare(`
        SELECT user_id, project_id
        FROM sessions
        WHERE id = ?
        LIMIT 1
      `).get(sessionId) as { user_id: string | null; project_id: string | null } | undefined;
      if (!session) {
        fail('REFERENCE_NOT_CLOSED', `completed import lost session ${sessionId}`);
      }
      if (
        session.user_id !== boundary.ownerUserId
        || session.project_id !== boundary.projectId
      ) {
        fail('REFERENCE_NOT_CLOSED', `completed import session ${sessionId} crossed its boundary`);
      }
      if (storedPlan) {
        const expectedProjectionDigest =
          storedPlan.compatibilityProjectionDigestBySession[sessionId];
        if (
          typeof expectedProjectionDigest !== 'string'
          || this.importedCompatibilityProjectionDigest(sessionId) !== expectedProjectionDigest
        ) {
          fail(
            'REFERENCE_NOT_CLOSED',
            `completed import session ${sessionId} changed its compatibility projection`,
          );
        }
      }
      const audit = this.conversationBranchRepo.auditLineage(sessionId, boundary);
      const expectedStatus = storedPlan
        ? storedPlan.expectedConversationStatusBySession[sessionId]
        : this.expectedStatusFromImportedLedger(sessionId);
      if (!expectedStatus) {
        fail(
          'REFERENCE_NOT_CLOSED',
          `completed import ${row.import_id} lost expected status for ${sessionId}`,
        );
      }
      try {
        this.assertConversationAuditClosure(sessionId, audit, expectedStatus);
      } catch (error) {
        fail(
          'REFERENCE_NOT_CLOSED',
          `completed import session ${sessionId} failed immutable replay closure: ${audit.issues
            .map((issue) => issue.code)
            .join(', ')}; ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    for (const messageId of Object.values(result.messageIdMap)) {
      const closure = this.db.prepare(`
        SELECT
          EXISTS(SELECT 1 FROM messages WHERE id = ?) AS message_exists,
          EXISTS(
            SELECT 1
            FROM conversation_branch_entries
            WHERE projected_message_id = ?
          ) AS reference_exists
      `).get(messageId, messageId) as {
        message_exists: number;
        reference_exists: number;
      };
      if (!closure.message_exists || !closure.reference_exists) {
        fail('REFERENCE_NOT_CLOSED', `completed import lost message mapping ${messageId}`);
      }
    }
    for (const forkId of Object.values(result.forkIdMap)) {
      const closure = this.db.prepare(`
        SELECT
          EXISTS(SELECT 1 FROM session_forks WHERE id = ?) AS fork_exists,
          EXISTS(
            SELECT 1
            FROM session_fork_message_map
            WHERE fork_id = ?
          ) AS mapping_exists,
          EXISTS(
            SELECT 1
            FROM conversation_branches
            WHERE fork_id = ?
          ) AS branch_exists
      `).get(forkId, forkId, forkId) as {
        fork_exists: number;
        mapping_exists: number;
        branch_exists: number;
      };
      if (!closure.fork_exists || !closure.mapping_exists || !closure.branch_exists) {
        fail('REFERENCE_NOT_CLOSED', `completed import lost fork mapping ${forkId}`);
      }
    }
    return result;
  }

  private expectedStatusFromImportedLedger(
    sessionId: string,
  ): ConversationLineageAuditStatus {
    const lifecycle = this.db.prepare(`
      SELECT event_type
      FROM conversation_branch_events
      WHERE branch_id = (SELECT id FROM conversation_branches WHERE session_id = ?)
        AND event_type IN ('quarantine', 'repair_override', 'projection_repair')
      ORDER BY sequence DESC
      LIMIT 1
    `).get(sessionId) as { event_type: string } | undefined;
    if (lifecycle?.event_type === 'quarantine') return 'quarantined';
    if (lifecycle?.event_type === 'repair_override') return 'override_active';
    return 'healthy';
  }

  private readSyncRow(
    direction: 'outbox' | 'inbox',
    syncEnvelopeId: string,
  ): StoredSyncRow | null {
    return (this.db.prepare(`
      SELECT *
      FROM session_fork_portability_sync
      WHERE direction = ? AND sync_envelope_id = ?
      LIMIT 1
    `).get(direction, syncEnvelopeId) as StoredSyncRow | undefined) ?? null;
  }

  private requireSyncRecord(
    direction: 'outbox' | 'inbox',
    syncEnvelopeId: string,
    ownerScopeId: string,
    projectId: string,
  ): SessionForkSyncEnvelopeRecord {
    const record = this.getSyncRecord(
      direction,
      syncEnvelopeId,
      ownerScopeId,
      projectId,
    );
    if (!record) {
      fail('SYNC_ENVELOPE_NOT_FOUND', `${direction} envelope ${syncEnvelopeId} does not exist`);
    }
    return record;
  }

  private syncRowToRecord(row: StoredSyncRow): SessionForkSyncEnvelopeRecord {
    const envelope = decodeSessionExportEnvelopeV2(row.envelope_json, {
      ownerScopeId: row.owner_scope_id,
      projectId: row.project_id,
    });
    if (envelope.payloadDigest !== row.payload_digest) {
      fail('DIGEST_MISMATCH', `sync envelope ${row.sync_envelope_id} payload drifted`);
    }
    return {
      syncEnvelopeId: row.sync_envelope_id,
      payloadDigest: row.payload_digest,
      dependencyIds: parseStringArray(
        row.dependency_ids_json,
        `sync ${row.sync_envelope_id} dependencies`,
      ),
      envelope,
      direction: row.direction,
      state: row.state,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      ...(row.reason ? { reason: row.reason } : {}),
    };
  }

  private resolveSyncDuplicate(
    row: StoredSyncRow,
    payloadDigest: string,
    ownerScopeId: string,
    projectId: string,
  ): SessionForkSyncEnvelopeRecord {
    if (row.owner_scope_id !== ownerScopeId) {
      fail('OWNER_SCOPE_MISMATCH', `sync envelope ${row.sync_envelope_id} belongs to another owner`);
    }
    if (row.project_id !== projectId) {
      fail('PROJECT_SCOPE_MISMATCH', `sync envelope ${row.sync_envelope_id} belongs to another project`);
    }
    if (row.payload_digest !== payloadDigest) {
      this.db.prepare(`
        UPDATE session_fork_portability_sync
        SET state = 'blocked', reason = 'SYNC_ID_DIGEST_CONFLICT',
            updated_at = updated_at + 1
        WHERE direction = ? AND sync_envelope_id = ?
          AND owner_scope_id = ? AND project_id = ?
      `).run(row.direction, row.sync_envelope_id, ownerScopeId, projectId);
      fail('SYNC_ID_DIGEST_CONFLICT', `${row.sync_envelope_id} was reused with another digest`);
    }
    return this.syncRowToRecord(row);
  }

  private assertDependencies(syncEnvelopeId: string, dependencyIds: string[]): void {
    if (
      dependencyIds.includes(syncEnvelopeId)
      || new Set(dependencyIds).size !== dependencyIds.length
    ) {
      fail('REFERENCE_NOT_CLOSED', `${syncEnvelopeId} has invalid dependency references`);
    }
  }

  private unappliedInboundDependencies(
    dependencyIds: string[],
    ownerScopeId: string,
    projectId: string,
  ): string[] {
    return dependencyIds.filter((dependencyId) => {
      const row = this.readSyncRow('inbox', dependencyId);
      return row?.owner_scope_id !== ownerScopeId
        || row.project_id !== projectId
        || row.state !== 'applied';
    });
  }

  private promoteQuarantinedInbound(
    now: number,
    ownerScopeId: string,
    projectId: string,
  ): void {
    let promoted = true;
    while (promoted) {
      promoted = false;
      const rows = this.db.prepare(`
        SELECT *
        FROM session_fork_portability_sync
        WHERE direction = 'inbox' AND state = 'quarantined'
          AND owner_scope_id = ? AND project_id = ?
        ORDER BY created_at ASC, sync_envelope_id ASC
      `).all(ownerScopeId, projectId) as StoredSyncRow[];
      for (const row of rows) {
        const dependencyIds = parseStringArray(
          row.dependency_ids_json,
          `sync ${row.sync_envelope_id} dependencies`,
        );
        if (this.unappliedInboundDependencies(
          dependencyIds,
          ownerScopeId,
          projectId,
        ).length > 0) continue;
        this.db.prepare(`
          UPDATE session_fork_portability_sync
          SET state = 'ready', reason = NULL, updated_at = ?
          WHERE direction = 'inbox' AND sync_envelope_id = ?
            AND state = 'quarantined'
        `).run(now, row.sync_envelope_id);
        promoted = true;
      }
    }
  }
}
