import type BetterSqlite3 from 'better-sqlite3';

import type { Message } from '../../../../shared/contract/message';
import type {
  ForkLineageDraftV1,
  ForkLineageMessageMappingDraftV1,
  ForkLineageNodeDraftV1,
  PortableSessionWorkspaceV2,
  SessionExportEnvelopeV2,
  SessionExportModeV2,
  SessionExportSourceV2,
} from '../../../../shared/contract/sessionForkPortability';
import type { PortableConversationHistoryV1 } from '../../../../shared/contract/conversationHistory';
import {
  LOCAL_SESSION_FORK_OWNER_SCOPE_ID,
  SessionForkPortabilityError,
} from '../../../../shared/contract/sessionForkPortability';
import {
  buildPortableIsolatedAnchorEvidenceV1,
  buildSessionExportEnvelopeV2,
  buildPortableConversationHistory,
  validatePortableSessionWorkspaceV2,
} from '../../sessionFork/portability';
import {
  portabilityDigest,
} from '../../sessionFork/portability/canonical';
import {
  canonicalConversationJson,
  canonicalConversationMessagePayload,
} from '../database/schemaConversationBranch';
import { sanitizeConversationMessageSnapshot } from '../conversationMessageSnapshot';
import { ConversationBranchRepository } from './ConversationBranchRepository';
import type { AnchorWorkspaceEvidence } from '../../sessionFork/workspace';
import {
  rowToMessage,
  rowToSession,
} from './sessionRepositoryParsers';
import {
  readPublishedImportedPortableWorkspace,
  type PublishedImportedWorkspaceSessionRow,
} from './sessionForkPublishedWorkspaceReader';

type SQLiteRow = Record<string, unknown>;

export interface SourceBackedSessionForkExportInput {
  exportId: string;
  rootSessionId: string;
  ownerScopeId: string;
  projectId: string;
  mode: SessionExportModeV2;
  exportedAt: number;
}

interface StoredForkRow extends SQLiteRow {
  id: string;
  source_session_id: string;
  child_session_id: string;
  root_session_id: string;
  parent_fork_id: string | null;
  anchor_message_id: string;
  anchor_child_message_id: string;
  workspace_mode: 'shared_current' | 'isolated_at_anchor';
  context_delivery_mode:
    | 'neo_native_prefix'
    | 'provider_native_fork'
    | 'validated_context_handoff'
    | 'unsupported';
  status: string;
  depth: number;
  workspace_snapshot_id: string | null;
  created_at: number;
}

const ARTIFACT_BLOCK = /```(?:chart|spreadsheet|mermaid|html|generative_ui|neo_ui|question-form)\s*\n[\s\S]*?```/g;

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

function portableDigestValue(value: unknown): string {
  if (typeof value === 'string' && /^sha256:[a-f0-9]{64}$/iu.test(value)) {
    return value.toLowerCase();
  }
  if (typeof value === 'string' && /^[a-f0-9]{64}$/iu.test(value)) {
    return `sha256:${value.toLowerCase()}`;
  }
  return portabilityDigest(value);
}

function sanitizeArtifactContent(message: Message): Message {
  if (!message.artifacts?.length) return message;
  return {
    ...message,
    content: message.content.replace(
      ARTIFACT_BLOCK,
      '[只读 Artifact provenance：payload omitted]',
    ),
  };
}

export class SessionForkPortabilitySourceReader {
  private readonly conversationBranchRepo: ConversationBranchRepository;

  constructor(private readonly db: BetterSqlite3.Database) {
    this.conversationBranchRepo = new ConversationBranchRepository(db);
  }

  buildEnvelope(input: SourceBackedSessionForkExportInput): SessionExportEnvelopeV2 {
    const root = this.requireScopedSession(
      input.rootSessionId,
      input.ownerScopeId,
      input.projectId,
    );
    if (input.mode === 'detached_child') {
      const fork = this.readForkByChild(input.rootSessionId);
      if (!fork) {
        fail('DETACHED_PROVENANCE_REQUIRED', 'detached_child requires an explicit user Fork record');
      }
      this.requireScopedSession(
        fork.source_session_id,
        input.ownerScopeId,
        input.projectId,
      );
      const mapping = this.readMappings(fork);
      const sourceAnchor = mapping.find((entry) => (
        entry.sourceMessageId === fork.anchor_message_id
      ));
      if (!sourceAnchor) {
        fail('REFERENCE_NOT_CLOSED', 'detached fork anchor has no message mapping evidence');
      }
      return buildSessionExportEnvelopeV2({
        exportId: input.exportId,
        exportedAt: input.exportedAt,
        ownerScopeId: input.ownerScopeId,
        projectId: input.projectId,
        rootSessionId: input.rootSessionId,
        mode: 'detached_child',
        sessions: [{
          session: root,
          messages: this.readPortableMessages(input.rootSessionId),
          workspace: this.readPortableWorkspace(fork),
        }],
        conversationHistory: this.readPortableConversationHistory(
          [input.rootSessionId],
          input.rootSessionId,
          input.ownerScopeId,
          input.projectId,
        ),
        detachedProvenance: {
          sourceRootSessionId: fork.root_session_id,
          sourceParentSessionId: fork.source_session_id,
          sourceForkId: fork.id,
          sourceAnchorMessageId: fork.anchor_message_id,
          sourceAnchorDigest: portableDigestValue(sourceAnchor.sourceRowDigest),
          sourceDepth: Number(fork.depth),
        },
      });
    }

    const forks = this.readSubtreeForks(input.rootSessionId);
    const sessionIds = [
      input.rootSessionId,
      ...forks.map((fork) => fork.child_session_id),
    ];
    const sessionsById = new Map<string, SessionExportSourceV2['session']>();
    for (const sessionId of sessionIds) {
      sessionsById.set(
        sessionId,
        this.requireScopedSession(sessionId, input.ownerScopeId, input.projectId),
      );
    }
    const rootFork = this.readForkByChild(input.rootSessionId);
    const sources = sessionIds.map((sessionId) => {
      const edge = forks.find((fork) => fork.child_session_id === sessionId)
        ?? (sessionId === input.rootSessionId ? rootFork : null);
      const session = sessionsById.get(sessionId);
      if (!session) {
        fail('REFERENCE_NOT_CLOSED', `session ${sessionId} disappeared during export`);
      }
      return {
        session,
        messages: this.readPortableMessages(sessionId),
        workspace: edge
          ? this.readPortableWorkspace(edge)
          : {
            mode: 'shared_current' as const,
            label: '历史对话 + 当前文件' as const,
          },
      };
    });
    const lineage = this.buildSubtreeLineage(input.rootSessionId, forks, input.exportedAt);
    return buildSessionExportEnvelopeV2({
      exportId: input.exportId,
      exportedAt: input.exportedAt,
      ownerScopeId: input.ownerScopeId,
      projectId: input.projectId,
      rootSessionId: input.rootSessionId,
      mode: 'subtree',
      sessions: sources,
      lineage,
      conversationHistory: this.readPortableConversationHistory(
        sessionIds,
        input.rootSessionId,
        input.ownerScopeId,
        input.projectId,
      ),
    });
  }

  private readPortableConversationHistory(
    sessionIds: string[],
    exportRootSessionId: string,
    ownerScopeId: string,
    projectId: string,
  ): PortableConversationHistoryV1 {
    const placeholders = sessionIds.map(() => '?').join(',');
    const branches = this.db.prepare(`
      SELECT *
      FROM conversation_branches
      WHERE session_id IN (${placeholders})
      ORDER BY created_at ASC, id ASC
    `).all(...sessionIds) as SQLiteRow[];
    if (branches.length !== sessionIds.length) {
      fail('REFERENCE_NOT_CLOSED', 'export sessions do not all have immutable branches');
    }
    const rootBranch = branches.find((branch) => branch.session_id === exportRootSessionId);
    if (!rootBranch) {
      fail('REFERENCE_NOT_CLOSED', `export root ${exportRootSessionId} has no immutable branch`);
    }
    const branchIds = new Set(branches.map((branch) => String(branch.id)));
    const projectedRoot = Boolean(
      rootBranch.parent_branch_id
      && !branchIds.has(String(rootBranch.parent_branch_id)),
    );
    const normalizedBranches = branches.map((branch) => ({
      ...branch,
      root_branch_id: String(rootBranch.id),
      ...(branch.id === rootBranch.id && projectedRoot
        ? {
          parent_branch_id: null,
          fork_id: null,
          anchor_entry_id: null,
        }
        : {}),
    }));
    const branchPlaceholders = branches.map(() => '?').join(',');
    const references = this.db.prepare(`
      SELECT *
      FROM conversation_branch_entries
      WHERE branch_id IN (${branchPlaceholders})
      ORDER BY branch_id ASC, ordinal ASC
    `).all(...branches.map((branch) => branch.id)) as SQLiteRow[];
    const normalizedReferences = references.map((reference) => (
      projectedRoot
      && reference.branch_id === rootBranch.id
      && reference.alias_kind === 'fork_copy'
        ? { ...reference, alias_kind: 'native' }
        : reference
    ));
    const entries = this.db.prepare(`
      SELECT DISTINCT entry.*
      FROM conversation_entries AS entry
      JOIN conversation_branch_entries AS reference ON reference.entry_id = entry.id
      WHERE reference.branch_id IN (${branchPlaceholders})
      ORDER BY entry.created_at ASC, entry.id ASC
    `).all(...branches.map((branch) => branch.id)) as SQLiteRow[];
    const events = this.db.prepare(`
      SELECT *
      FROM conversation_branch_events
      WHERE branch_id IN (${branchPlaceholders})
      ORDER BY branch_id ASC, sequence ASC
    `).all(...branches.map((branch) => branch.id)) as SQLiteRow[];
    const projectedEvents = projectedRoot
      ? this.projectDetachedRootEvents(rootBranch, normalizedReferences, events)
      : events;
    const normalizedEvents = this.normalizeLegacyBranchEvents(
      normalizedReferences,
      projectedEvents,
    );
    return buildPortableConversationHistory({
      ownerUserId: ownerScopeId === LOCAL_SESSION_FORK_OWNER_SCOPE_ID ? null : ownerScopeId,
      projectId,
      branches: normalizedBranches,
      entries,
      references: normalizedReferences,
      events: normalizedEvents,
    });
  }

  private projectDetachedRootEvents(
    rootBranch: SQLiteRow,
    references: SQLiteRow[],
    events: SQLiteRow[],
  ): SQLiteRow[] {
    const rootReferences = references
      .filter((reference) => reference.branch_id === rootBranch.id)
      .sort((left, right) => Number(left.ordinal) - Number(right.ordinal));
    const output: SQLiteRow[] = [];
    let sequence = 0;
    for (const event of events) {
      if (event.branch_id !== rootBranch.id) {
        output.push(event);
        continue;
      }
      if (event.event_type === 'fork') {
        const payload = parseJson<Record<string, unknown>>(
          event.payload_json,
          `fork event ${String(event.id)}`,
        );
        const ordinals = Array.isArray(payload.ordinals)
          ? payload.ordinals.map(Number).filter(Number.isSafeInteger)
          : rootReferences
              .filter((reference) => reference.alias_kind === 'native')
              .map((reference) => Number(reference.ordinal));
        for (const [index, ordinal] of ordinals.entries()) {
          const reference = rootReferences.find((candidate) => Number(candidate.ordinal) === ordinal);
          if (!reference) {
            fail('REFERENCE_NOT_CLOSED', `detached root fork ordinal ${ordinal} is missing`);
          }
          sequence += 1;
          output.push({
            ...event,
            id: `${String(event.id)}:detached:${index}`,
            sequence,
            event_type: 'append',
            idempotency_key: `${String(event.idempotency_key)}:detached:${index}`,
            payload_json: JSON.stringify({
              ordinal,
              entryId: reference.entry_id,
              projectedMessageId: reference.projected_message_id,
            }),
          });
        }
        continue;
      }
      sequence += 1;
      output.push({ ...event, sequence });
    }
    return output;
  }

  private normalizeLegacyBranchEvents(
    references: SQLiteRow[],
    events: SQLiteRow[],
  ): SQLiteRow[] {
    const referencesByBranch = new Map<string, SQLiteRow[]>();
    for (const reference of references) {
      const branchId = String(reference.branch_id);
      const grouped = referencesByBranch.get(branchId) ?? [];
      grouped.push(reference);
      referencesByBranch.set(branchId, grouped);
    }
    for (const grouped of referencesByBranch.values()) {
      grouped.sort((left, right) => Number(left.ordinal) - Number(right.ordinal));
    }
    const eventsByBranch = new Map<string, SQLiteRow[]>();
    for (const event of events) {
      const branchId = String(event.branch_id);
      const grouped = eventsByBranch.get(branchId) ?? [];
      grouped.push(event);
      eventsByBranch.set(branchId, grouped);
    }
    const normalized: SQLiteRow[] = [];
    for (const [branchId, branchEvents] of eventsByBranch) {
      branchEvents.sort((left, right) => (
        Number(left.sequence) - Number(right.sequence)
        || String(left.id).localeCompare(String(right.id))
      ));
      let sequence = 0;
      for (const event of branchEvents) {
        const payload = parseJson<Record<string, unknown>>(
          event.payload_json,
          `conversation event ${String(event.id)}`,
        );
        if (event.event_type === 'fork' && typeof payload.sourceAnchorMessageId !== 'string') {
          const branchReferences = referencesByBranch.get(branchId) ?? [];
          const forkReferences = branchReferences
            .filter((reference) => reference.alias_kind === 'fork_copy');
          const declaredOrdinals = Array.isArray(payload.ordinals)
            ? payload.ordinals.map(Number).filter(Number.isSafeInteger)
            : branchReferences.map((reference) => Number(reference.ordinal));
          if (forkReferences.length === 0) {
            fail('REFERENCE_NOT_CLOSED', `legacy fork event ${String(event.id)} has no shared prefix`);
          }
          sequence += 1;
          normalized.push({
            ...event,
            sequence,
            payload_json: JSON.stringify({
              ...payload,
              ordinals: forkReferences.map((reference) => Number(reference.ordinal)),
              entryIds: forkReferences.map((reference) => String(reference.entry_id)),
              sourceAnchorMessageId: payload.anchorMessageId,
              childAnchorMessageId: String(forkReferences.at(-1)?.projected_message_id),
            }),
          });
          const forkOrdinals = new Set(
            forkReferences.map((reference) => Number(reference.ordinal)),
          );
          for (const [index, ordinal] of declaredOrdinals
            .filter((candidate) => !forkOrdinals.has(candidate))
            .entries()) {
            const reference = branchReferences.find(
              (candidate) => Number(candidate.ordinal) === ordinal,
            );
            if (!reference) {
              fail(
                'REFERENCE_NOT_CLOSED',
                `legacy fork event ${String(event.id)} ordinal ${ordinal} is missing`,
              );
            }
            sequence += 1;
            normalized.push({
              ...event,
              id: `${String(event.id)}:legacy-append:${index}`,
              sequence,
              event_type: 'append',
              idempotency_key: `${String(event.idempotency_key)}:legacy-append:${index}`,
              payload_json: JSON.stringify({
                ordinal,
                entryId: reference.entry_id,
                projectedMessageId: reference.projected_message_id,
              }),
            });
          }
          continue;
        }
        const normalizedPayload = event.event_type === 'rewind'
          && !Array.isArray(payload.hiddenMessageIds)
          && Array.isArray(payload.hidden)
          ? {
            ...payload,
            hiddenMessageIds: payload.hidden.flatMap((item) => (
              item
              && typeof item === 'object'
              && typeof (item as Record<string, unknown>).projectedMessageId === 'string'
                ? [(item as Record<string, unknown>).projectedMessageId as string]
                : []
            )),
          }
          : payload;
        sequence += 1;
        normalized.push({
          ...event,
          sequence,
          payload_json: JSON.stringify(normalizedPayload),
        });
      }
    }
    return normalized;
  }

  private buildSubtreeLineage(
    rootSessionId: string,
    forks: StoredForkRow[],
    createdAt: number,
  ): ForkLineageDraftV1 {
    const children = new Map<string, StoredForkRow[]>();
    for (const fork of forks) {
      const group = children.get(fork.source_session_id) ?? [];
      group.push(fork);
      children.set(fork.source_session_id, group);
    }
    for (const group of children.values()) {
      group.sort((left, right) => (
        Number(left.created_at) - Number(right.created_at)
        || left.id.localeCompare(right.id)
      ));
    }
    const nodes: ForkLineageNodeDraftV1[] = [{
      forkId: null,
      sessionId: rootSessionId,
      parentSessionId: null,
      rootSessionId,
      sourceAnchorMessageId: null,
      anchorChildMessageId: null,
      depth: 0,
      ordinal: 0,
      workspaceMode: this.readForkByChild(rootSessionId)?.workspace_mode ?? 'shared_current',
      contextDeliveryMode: 'neo_native_prefix',
      createdAt: Number(this.requireSessionRow(rootSessionId).created_at),
    }];
    const mappings: ForkLineageMessageMappingDraftV1[] = [];
    const visit = (parentSessionId: string, depth: number): void => {
      for (const [ordinal, fork] of (children.get(parentSessionId) ?? []).entries()) {
        nodes.push({
          forkId: fork.id,
          sessionId: fork.child_session_id,
          parentSessionId,
          rootSessionId,
          sourceAnchorMessageId: fork.anchor_message_id,
          anchorChildMessageId: fork.anchor_child_message_id,
          depth,
          ordinal,
          workspaceMode: fork.workspace_mode,
          contextDeliveryMode: fork.context_delivery_mode,
          createdAt: Number(fork.created_at),
        });
        mappings.push(...this.readMappings(fork).map((mapping) => ({
          forkId: fork.id,
          ordinal: mapping.ordinal,
          sourceSessionId: fork.source_session_id,
          childSessionId: fork.child_session_id,
          sourceMessageId: mapping.sourceMessageId,
          childMessageId: mapping.childMessageId,
          sourceTimestamp: mapping.sourceTimestamp,
          sourceOrderKey: mapping.sourceOrderKey,
          sourceRowDigest: portableDigestValue(mapping.sourceRowDigest),
        })));
        visit(fork.child_session_id, depth + 1);
      }
    };
    visit(rootSessionId, 1);
    return { createdAt, nodes, messageMappings: mappings };
  }

  private readSubtreeForks(rootSessionId: string): StoredForkRow[] {
    const forks: StoredForkRow[] = [];
    const visited = new Set<string>([rootSessionId]);
    const queue = [rootSessionId];
    while (queue.length > 0) {
      const sourceSessionId = queue.shift();
      if (!sourceSessionId) break;
      const children = this.db.prepare(`
        SELECT *
        FROM session_forks
        WHERE source_session_id = ? AND status = 'completed'
        ORDER BY created_at ASC, id ASC
      `).all(sourceSessionId) as StoredForkRow[];
      for (const fork of children) {
        if (visited.has(fork.child_session_id)) {
          fail('LINEAGE_INVALID', `fork lineage contains a cycle at ${fork.child_session_id}`);
        }
        visited.add(fork.child_session_id);
        forks.push(fork);
        queue.push(fork.child_session_id);
      }
    }
    return forks;
  }

  private readPortableMessages(sessionId: string): SessionExportSourceV2['messages'] {
    const rows = this.db.prepare(`
      SELECT rowid AS __rowid, *
      FROM messages
      WHERE session_id = ?
      ORDER BY timestamp ASC, rowid ASC
    `).all(sessionId) as SQLiteRow[];
    const immutableByMessageId = new Map(
      this.conversationBranchRepo.replay(
        sessionId,
        {
          ownerUserId: typeof this.requireSessionRow(sessionId).user_id === 'string'
            ? String(this.requireSessionRow(sessionId).user_id)
            : null,
          projectId: typeof this.requireSessionRow(sessionId).project_id === 'string'
            ? String(this.requireSessionRow(sessionId).project_id)
            : null,
        },
        { includeRewound: true },
      ).messages.map((message) => [message.projectedMessageId, message.message]),
    );
    return rows.map((row) => {
      const message = sanitizeArtifactContent(rowToMessage(row));
      const immutable = immutableByMessageId.get(message.id);
      const attachmentProvenance = immutable?.readOnlyAttachmentProvenance;
      if (Array.isArray(attachmentProvenance)) {
        message.attachments = attachmentProvenance as Message['attachments'];
      }
      const artifactProvenance = immutable?.readOnlyArtifactProvenance;
      if (Array.isArray(artifactProvenance)) {
        message.artifacts = artifactProvenance as Message['artifacts'];
      }
      return message as Message & Record<string, unknown>;
    });
  }

  private readPortableWorkspace(
    fork: StoredForkRow,
  ): PortableSessionWorkspaceV2 {
    if (fork.workspace_mode === 'shared_current') {
      return { mode: 'shared_current', label: '历史对话 + 当前文件' };
    }
    const row = this.db.prepare(`
      SELECT
        saga.evidence_id,
        saga.state AS saga_state,
        intent.status AS intent_status,
        intent.advertisable,
        intent.evidence_digest AS intent_evidence_digest,
        evidence.status AS evidence_status,
        evidence.source_identity_digest,
        evidence.source_identity_json,
        evidence.base_commit,
        evidence.evidence_digest,
        evidence.evidence_json
      FROM session_fork_workspace_sagas saga
      JOIN session_fork_workspace_intents intent
        ON intent.intent_id = saga.intent_id
      JOIN session_fork_anchor_evidence evidence
        ON evidence.id = saga.evidence_id
      WHERE saga.proposed_fork_id = ?
        AND saga.proposed_child_session_id = ?
      LIMIT 1
    `).get(fork.id, fork.child_session_id) as SQLiteRow | undefined;
    if (
      row?.saga_state !== 'completed'
      || row.intent_status !== 'advertised'
      || Number(row.advertisable) !== 1
      || row.evidence_status !== 'complete'
      || typeof row.evidence_digest !== 'string'
      || row.intent_evidence_digest !== row.evidence_digest
      || typeof row.base_commit !== 'string'
      || !row.base_commit
    ) {
      const importedWorkspace = this.readImportedPortableWorkspace(fork);
      if (importedWorkspace) return importedWorkspace;
      fail('INVALID_ENVELOPE', `isolated fork ${fork.id} lacks complete advertised evidence`);
    }
    const evidence = parseJson<AnchorWorkspaceEvidence>(
      row.evidence_json,
      `isolated fork ${fork.id} evidence`,
    );
    const manifest = evidence.manifest;
    if (
      manifest.captureState !== 'complete'
      || manifest.baseCommit !== row.base_commit
      || manifest.evidenceDigest !== row.evidence_digest
    ) {
      fail('INVALID_ENVELOPE', `isolated fork ${fork.id} evidence manifest is incomplete`);
    }
    const repositoryIdentityDigest = portableDigestValue(
      row.source_identity_digest
      ?? (typeof row.source_identity_json === 'string'
        ? parseJson<unknown>(row.source_identity_json, 'source identity')
        : manifest.repositoryIdentity),
    );
    return {
      mode: 'isolated_at_anchor',
      label: '历史对话 + 锚点文件',
      isolatedAnchor: buildPortableIsolatedAnchorEvidenceV1({
        evidenceId: String(row.evidence_id),
        repositoryIdentityDigest,
        evidence,
      }),
    };
  }

  private readImportedPortableWorkspace(
    fork: StoredForkRow,
  ): PortableSessionWorkspaceV2 | null {
    const row = this.db.prepare(`
      SELECT user_id, project_id, origin, metadata, agent_engine, read_only,
             working_directory, workspace, is_deleted, status
      FROM sessions
      WHERE id = ?
      LIMIT 1
    `).get(fork.child_session_id) as PublishedImportedWorkspaceSessionRow | undefined;
    if (
      !row
      || typeof row.origin !== 'string'
      || typeof row.metadata !== 'string'
    ) {
      return null;
    }
    const origin = parseJson<Record<string, unknown>>(
      row.origin,
      `imported session ${fork.child_session_id} origin`,
    );
    if (origin.kind !== 'import') return null;
    const metadata = parseJson<Record<string, unknown>>(
      row.metadata,
      `imported session ${fork.child_session_id} metadata`,
    );
    const workspace = metadata.portableWorkspaceV2;
    if (!workspace || typeof workspace !== 'object' || Array.isArray(workspace)) return null;
    const portable = structuredClone(workspace) as PortableSessionWorkspaceV2;
    validatePortableSessionWorkspaceV2(
      portable,
      `imported isolated fork ${fork.id} workspace`,
    );
    if (portable.mode !== 'isolated_at_anchor') return null;
    if (!Object.prototype.hasOwnProperty.call(metadata, 'importedWorkspacePublicationV1')) {
      if (
        Number(row.read_only) !== 1
        || row.working_directory !== null
        || row.workspace !== null
      ) {
        fail(
          'INVALID_ENVELOPE',
          `imported isolated fork ${fork.id} is neither hidden nor atomically published`,
        );
      }
      return portable;
    }
    return readPublishedImportedPortableWorkspace(this.db, {
      fork,
      session: row,
      metadata,
      importedPortable: portable,
      publication: metadata.importedWorkspacePublicationV1,
    });
  }

  private readMappings(fork: StoredForkRow): Array<{
    ordinal: number;
    sourceMessageId: string;
    childMessageId: string;
    sourceTimestamp: number;
    sourceOrderKey: string;
    sourceRowDigest: string;
  }> {
    const rows = this.db.prepare(`
      SELECT ordinal, source_message_id, child_message_id, source_timestamp,
             source_order_key, source_row_digest
      FROM session_fork_message_map
      WHERE fork_id = ?
      ORDER BY ordinal ASC
    `).all(fork.id) as Array<{
      ordinal: number;
      source_message_id: string;
      child_message_id: string;
      source_timestamp: number;
      source_order_key: string;
      source_row_digest: string;
    }>;
    if (
      rows.length === 0
      || rows.some((row, index) => Number(row.ordinal) !== index)
      || rows.at(-1)?.source_message_id !== fork.anchor_message_id
      || rows.at(-1)?.child_message_id !== fork.anchor_child_message_id
    ) {
      fail('REFERENCE_NOT_CLOSED', `fork ${fork.id} has incomplete mapping evidence`);
    }
    const sourceRows = this.db.prepare(`
      SELECT source.rowid AS __rowid, source.*
      FROM session_fork_message_map AS map
      JOIN messages AS source
        ON source.session_id = ? AND source.id = map.source_message_id
      WHERE map.fork_id = ?
      ORDER BY map.ordinal ASC
    `).all(fork.source_session_id, fork.id) as SQLiteRow[];
    const childRows = this.db.prepare(`
      SELECT child.rowid AS __rowid, child.*
      FROM session_fork_message_map AS map
      JOIN messages AS child
        ON child.session_id = ? AND child.id = map.child_message_id
      WHERE map.fork_id = ?
      ORDER BY map.ordinal ASC
    `).all(fork.child_session_id, fork.id) as SQLiteRow[];
    if (sourceRows.length !== rows.length || childRows.length !== rows.length) {
      fail('REFERENCE_NOT_CLOSED', `fork ${fork.id} mapping rows are not closed`);
    }
    for (const [index, row] of rows.entries()) {
      const source = sourceRows[index];
      const child = childRows[index];
      const sourcePayload = canonicalConversationJson(canonicalConversationMessagePayload(
        sanitizeConversationMessageSnapshot(rowToMessage(source)) as unknown as Record<string, unknown>,
      ));
      const childPayload = canonicalConversationJson(canonicalConversationMessagePayload(
        sanitizeConversationMessageSnapshot(rowToMessage(child)) as unknown as Record<string, unknown>,
      ));
      if (
        String(source.id) !== row.source_message_id
        || String(child.id) !== row.child_message_id
        || Number(source.timestamp) !== Number(row.source_timestamp)
        || String(row.source_order_key) !== `${Number(source.timestamp)}:${Number(source.__rowid)}`
        || sourcePayload !== childPayload
        || Boolean(child.is_meta)
      ) {
        fail(
          'REFERENCE_NOT_CLOSED',
          `fork ${fork.id} mapping ${index} does not preserve its copied message projection`,
        );
      }
    }
    return rows.map((row) => ({
      ordinal: Number(row.ordinal),
      sourceMessageId: String(row.source_message_id),
      childMessageId: String(row.child_message_id),
      sourceTimestamp: Number(row.source_timestamp),
      sourceOrderKey: String(row.source_order_key),
      sourceRowDigest: String(row.source_row_digest),
    }));
  }

  private requireSessionRow(sessionId: string): SQLiteRow {
    const row = this.db.prepare(`
      SELECT *
      FROM sessions
      WHERE id = ? AND COALESCE(is_deleted, 0) = 0
      LIMIT 1
    `).get(sessionId) as SQLiteRow | undefined;
    if (!row) fail('REFERENCE_NOT_CLOSED', `session ${sessionId} does not exist`);
    return row;
  }

  private requireScopedSession(
    sessionId: string,
    ownerScopeId: string,
    projectId: string,
  ): SessionExportSourceV2['session'] {
    const row = this.requireSessionRow(sessionId);
    const persistedOwner = typeof row.user_id === 'string'
      ? row.user_id
      : LOCAL_SESSION_FORK_OWNER_SCOPE_ID;
    if (persistedOwner !== ownerScopeId) {
      fail('OWNER_SCOPE_MISMATCH', `session ${sessionId} belongs to another owner`);
    }
    if (row.project_id !== projectId) {
      fail('PROJECT_SCOPE_MISMATCH', `session ${sessionId} belongs to another project`);
    }
    const branch = this.db.prepare(`
      SELECT 1
      FROM conversation_branches
      WHERE session_id = ?
      LIMIT 1
    `).get(sessionId);
    if (!branch) {
      fail('REFERENCE_NOT_CLOSED', `session ${sessionId} has no immutable conversation branch`);
    }
    const audit = this.conversationBranchRepo.auditLineage(sessionId, {
      ownerUserId: ownerScopeId === LOCAL_SESSION_FORK_OWNER_SCOPE_ID ? null : ownerScopeId,
      projectId,
    });
    if (audit.status !== 'healthy') {
      fail(
        'LINEAGE_INVALID',
        `session ${sessionId} immutable lineage is ${audit.status}: ${audit.issues
          .map((issue) => issue.code)
          .join(', ')}`,
      );
    }
    return rowToSession(row) as unknown as SessionExportSourceV2['session'];
  }

  private readForkByChild(childSessionId: string): StoredForkRow | null {
    return (this.db.prepare(`
      SELECT *
      FROM session_forks
      WHERE child_session_id = ? AND status = 'completed'
      LIMIT 1
    `).get(childSessionId) as StoredForkRow | undefined) ?? null;
  }
}
