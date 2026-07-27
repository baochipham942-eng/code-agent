import { createHash } from 'node:crypto';
import type BetterSqlite3 from 'better-sqlite3';

import type {
  ConversationLineageAuditStatus,
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
  planSessionForkImport,
  searchForkDocuments,
  validateSessionExportEnvelopeV2,
} from '../../sessionFork/portability';
import { SessionForkPortabilitySourceReader } from './SessionForkPortabilitySourceReader';
import { ConversationBranchRepository } from './ConversationBranchRepository';
import { SessionForkConversationImportRepository } from './SessionForkConversationImportRepository';
import { SessionForkSyncRepository } from './SessionForkSyncRepository';

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

interface StoredImportPlanV1 {
  schema: 'neo.session-fork-import-plan';
  version: 1;
  result: ImportSessionForkResult;
  expectedConversationStatusBySession: Record<string, ConversationLineageAuditStatus>;
  compatibilityProjectionDigestBySession: Record<string, string>;
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
  private readonly conversationImportRepo: SessionForkConversationImportRepository;
  private readonly syncRepo: SessionForkSyncRepository;

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
    this.conversationImportRepo = new SessionForkConversationImportRepository(
      this.db,
      this.conversationBranchRepo,
    );
    this.syncRepo = new SessionForkSyncRepository(this.db);
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
        ? this.conversationImportRepo.integrateImportedConversationHistory(
          sourceConversationHistory,
          plan,
        )
        : null;
      if (!sourceConversationHistory) {
        this.conversationImportRepo.integrateImportedConversationLedger(
          plan,
          nodes,
          importedAt,
        );
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
        this.conversationImportRepo.verifyImportedConversationHistory(
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
        expectedConversationStatusBySession:
          this.conversationImportRepo.expectedConversationStatusBySession(
            sourceConversationHistory,
            plan,
          ),
        compatibilityProjectionDigestBySession: Object.fromEntries(
          Object.values(result.sessionIdMap).map((sessionId) => [
            sessionId,
            this.conversationImportRepo.importedCompatibilityProjectionDigest(
              sessionId,
            ),
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

  enqueueOutbound(
    input: EnqueueSessionForkOutboundInput,
  ): SessionForkSyncEnvelopeRecord {
    return this.syncRepo.enqueueOutbound(input);
  }

  async flushOutbound(
    syncEnvelopeId: string,
    ownerScopeId: string,
    projectId: string,
    options: FlushSessionForkOutboundOptions = {},
  ): Promise<SessionForkSyncEnvelopeRecord> {
    return this.syncRepo.flushOutbound(
      syncEnvelopeId,
      ownerScopeId,
      projectId,
      options,
    );
  }

  ingestInbound(
    input: IngestSessionForkInboundInput,
  ): SessionForkSyncEnvelopeRecord {
    return this.syncRepo.ingestInbound(input);
  }

  applyInbound(
    syncEnvelopeId: string,
    ownerScopeId: string,
    projectId: string,
    now = Date.now(),
  ): SessionForkSyncEnvelopeRecord {
    return this.syncRepo.applyInbound(
      syncEnvelopeId,
      ownerScopeId,
      projectId,
      now,
    );
  }

  recoverInterruptedSync(now = Date.now()): number {
    return this.syncRepo.recoverInterruptedSync(now);
  }

  getSyncRecord(
    direction: 'outbox' | 'inbox',
    syncEnvelopeId: string,
    ownerScopeId: string,
    projectId: string,
  ): SessionForkSyncEnvelopeRecord | null {
    return this.syncRepo.getSyncRecord(
      direction,
      syncEnvelopeId,
      ownerScopeId,
      projectId,
    );
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
    const publicationDeferred = plan.envelope.sessions.some(
      (candidate) => candidate.workspace?.mode === 'isolated_at_anchor',
    );
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
      ...(publicationDeferred
        ? {
          portabilityPublicationBarrierV1: {
            sourceExportId: plan.sourceExportId,
            sourcePayloadDigest: plan.envelope.payloadDigest,
            desiredReadOnly: session.workspace?.mode === 'isolated_at_anchor'
              ? false
              : Boolean(session.readOnly),
            workspaceMode: session.workspace?.mode ?? 'shared_current',
          },
        }
        : {}),
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
      publicationDeferred
        || session.readOnly
        || session.workspace?.mode === 'isolated_at_anchor'
        ? 1
        : 0,
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
        SELECT user_id, project_id, is_deleted
        FROM sessions
        WHERE id = ?
        LIMIT 1
      `).get(sessionId) as {
        user_id: string | null;
        project_id: string | null;
        is_deleted: number;
      } | undefined;
      if (!session) {
        fail('REFERENCE_NOT_CLOSED', `completed import lost session ${sessionId}`);
      }
      if (Number(session.is_deleted) !== 0) {
        fail('REFERENCE_NOT_CLOSED', `completed import session ${sessionId} was deleted`);
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
          || this.conversationImportRepo.importedCompatibilityProjectionDigest(
            sessionId,
          ) !== expectedProjectionDigest
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
        this.conversationImportRepo.assertConversationAuditClosure(
          sessionId,
          audit,
          expectedStatus,
        );
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

}
