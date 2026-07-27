import { createHash } from 'node:crypto';
import type BetterSqlite3 from 'better-sqlite3';

import type { Message } from '../../../../shared/contract/message';
import type { SessionForkContextDeliveryMode } from '../../../../shared/contract/sessionFork';
import type {
  AnchorWorkspaceEvidence,
  WorkspaceForkIntent,
  WorkspaceForkIntentStore,
} from '../../sessionFork/workspace/types';

type SQLiteRow = Record<string, unknown>;

type SessionForkAnchorEvidenceStatus = 'complete' | 'blocked';

export interface SessionForkAnchorEvidenceRecord {
  id: string;
  sourceSessionId: string;
  anchorMessageId: string;
  ownerUserId: string | null;
  projectId: string | null;
  workspaceScopeVersion: string | null;
  sourceIdentityDigest: string | null;
  sourceIdentity: Record<string, unknown> | null;
  messageDigest: string;
  repositoryRoot: string | null;
  baseCommit: string | null;
  observedHead: string | null;
  evidenceDigest: string | null;
  evidence: AnchorWorkspaceEvidence | null;
  summary: Record<string, unknown>;
  status: SessionForkAnchorEvidenceStatus;
  blockedReason: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface RecordSessionForkAnchorEvidenceInput {
  sourceSessionId: string;
  anchorMessageId: string;
  ownerUserId: string | null;
  projectId: string | null;
  workspaceScopeVersion: string | null;
  sourceIdentityDigest: string | null;
  sourceIdentity: Record<string, unknown> | null;
  messageDigest: string;
  repositoryRoot: string | null;
  evidence: AnchorWorkspaceEvidence | null;
  summary?: Record<string, unknown>;
  status: SessionForkAnchorEvidenceStatus;
  blockedReason?: string | null;
  now?: number;
}

type SessionForkWorkspaceSagaState =
  | 'preparing'
  | 'workspace_ready'
  | 'child_staged'
  | 'completed'
  | 'quarantined'
  | 'aborted';

export interface SessionForkWorkspaceSagaRecord {
  intentId: string;
  sourceSessionId: string;
  anchorMessageId: string;
  idempotencyKey: string;
  requestDigest: string;
  evidenceId: string;
  proposedForkId: string;
  proposedChildSessionId: string;
  contextDeliveryMode: SessionForkContextDeliveryMode;
  childTitle: string;
  workspacePath: string | null;
  state: SessionForkWorkspaceSagaState;
  childSessionId: string | null;
  error: Record<string, unknown> | null;
  createdAt: number;
  updatedAt: number;
}

export interface BeginSessionForkWorkspaceSagaInput {
  sourceSessionId: string;
  anchorMessageId: string;
  idempotencyKey: string;
  requestDigest: string;
  evidenceId: string;
  proposedForkId: string;
  proposedChildSessionId: string;
  contextDeliveryMode: SessionForkContextDeliveryMode;
  childTitle: string;
  now?: number;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

export function digestSessionForkAnchorMessage(message: Message): string {
  return sha256(canonicalJson({
    id: message.id,
    role: message.role,
    content: message.content,
    timestamp: message.timestamp,
    visibility: message.visibility ?? 'active',
    toolCalls: message.toolCalls ?? null,
    toolResults: message.toolResults ?? null,
    contentParts: message.contentParts ?? null,
    attachments: message.attachments ?? null,
    isMeta: Boolean(message.isMeta),
    reasoning: message.reasoning ?? null,
    thinking: message.thinking ?? null,
    artifacts: message.artifacts ?? null,
    metadata: message.metadata ?? null,
    compaction: message.compaction ?? null,
  }));
}

export function isCompletedSessionForkAnchor(message: Message): boolean {
  return message.role === 'assistant'
    && !message.isMeta
    && message.subtype !== 'tool_use'
    && (message.visibility ?? 'active') === 'active'
    && message.content.trim().length > 0
    && (!message.toolCalls || message.toolCalls.length === 0)
    && !message.contentParts?.some((part) => part.type === 'tool_call');
}

function parseObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'string' || !value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function parseEvidence(value: unknown): AnchorWorkspaceEvidence | null {
  const parsed = parseObject(value);
  return parsed as AnchorWorkspaceEvidence | null;
}

function cloneIntent(intent: WorkspaceForkIntent): WorkspaceForkIntent {
  return structuredClone(intent);
}

export class SessionForkWorkspaceRepository implements WorkspaceForkIntentStore {
  constructor(private readonly db: BetterSqlite3.Database) {}

  recordAnchorEvidence(
    input: RecordSessionForkAnchorEvidenceInput,
  ): SessionForkAnchorEvidenceRecord {
    const sourceSessionId = input.sourceSessionId.trim();
    const anchorMessageId = input.anchorMessageId.trim();
    const messageDigest = input.messageDigest.trim();
    if (!sourceSessionId || !anchorMessageId || !messageDigest) {
      throw new Error('anchor evidence requires source, message, and digest identities');
    }
    if (input.status === 'complete' && !input.evidence) {
      throw new Error('complete anchor evidence requires a sealed evidence bundle');
    }
    const now = input.now ?? Date.now();
    const existing = this.getAnchorEvidence(sourceSessionId, anchorMessageId);
    if (existing?.status === 'complete') return existing;
    const id = existing?.id ?? `fork_evidence_${sha256(`${sourceSessionId}:${anchorMessageId}`).slice(0, 32)}`;
    const evidence = input.evidence;
    const transaction = this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO session_fork_anchor_evidence (
          id, source_session_id, anchor_message_id, owner_user_id, project_id,
          workspace_scope_version, source_identity_digest, source_identity_json,
          message_digest, repository_root, base_commit, observed_head,
          evidence_digest, evidence_json, summary_json, status, blocked_reason,
          created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(source_session_id, anchor_message_id) DO UPDATE SET
          owner_user_id = excluded.owner_user_id,
          project_id = excluded.project_id,
          workspace_scope_version = excluded.workspace_scope_version,
          source_identity_digest = excluded.source_identity_digest,
          source_identity_json = excluded.source_identity_json,
          message_digest = excluded.message_digest,
          repository_root = excluded.repository_root,
          base_commit = excluded.base_commit,
          observed_head = excluded.observed_head,
          evidence_digest = excluded.evidence_digest,
          evidence_json = excluded.evidence_json,
          summary_json = excluded.summary_json,
          status = excluded.status,
          blocked_reason = excluded.blocked_reason,
          updated_at = excluded.updated_at
      `).run(
        id,
        sourceSessionId,
        anchorMessageId,
        input.ownerUserId,
        input.projectId,
        input.workspaceScopeVersion,
        input.sourceIdentityDigest,
        input.sourceIdentity ? canonicalJson(input.sourceIdentity) : null,
        messageDigest,
        input.repositoryRoot,
        evidence?.manifest.baseCommit ?? null,
        evidence?.manifest.observedHead ?? null,
        evidence?.manifest.evidenceDigest ?? null,
        evidence ? canonicalJson(evidence) : null,
        canonicalJson(input.summary ?? {}),
        input.status,
        input.blockedReason ?? null,
        existing?.createdAt ?? now,
        now,
      );
    });
    transaction();
    return this.requireAnchorEvidence(sourceSessionId, anchorMessageId);
  }

  getAnchorEvidence(
    sourceSessionId: string,
    anchorMessageId: string,
    ownerUserId?: string | null,
  ): SessionForkAnchorEvidenceRecord | null {
    const ownerPredicate = ownerUserId === undefined
      ? ''
      : ownerUserId === null
        ? ' AND owner_user_id IS NULL'
        : ' AND owner_user_id = ?';
    const params = typeof ownerUserId === 'string' ? [ownerUserId] : [];
    const row = this.db.prepare(`
      SELECT *
      FROM session_fork_anchor_evidence
      WHERE source_session_id = ? AND anchor_message_id = ?
        ${ownerPredicate}
      LIMIT 1
    `).get(sourceSessionId, anchorMessageId, ...params) as SQLiteRow | undefined;
    return row ? this.rowToAnchorEvidence(row) : null;
  }

  create(intent: WorkspaceForkIntent): Promise<WorkspaceForkIntent> {
    const existing = this.getIntentSync(intent.intentId);
    if (existing) {
      if (existing.requestDigest !== intent.requestDigest) {
        return Promise.reject(new Error(`intent ${intent.intentId} conflicts with persisted request`));
      }
      return Promise.resolve(cloneIntent(existing));
    }
    try {
      this.db.prepare(`
        INSERT INTO session_fork_workspace_intents (
          intent_id, request_digest, revision, source_session_id,
          proposed_child_session_id, repository_root, workspace_path,
          evidence_digest, intent_json, status, advertisable, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        intent.intentId,
        intent.requestDigest,
        intent.revision,
        intent.sourceSessionId,
        intent.proposedChildSessionId,
        intent.repositoryRoot,
        intent.workspacePath,
        intent.evidenceDigest,
        this.serializeIntent(intent),
        intent.status,
        intent.advertisable ? 1 : 0,
        intent.createdAt,
        intent.updatedAt,
      );
      return Promise.resolve(cloneIntent(intent));
    } catch (error) {
      return Promise.reject(error);
    }
  }

  get(intentId: string): Promise<WorkspaceForkIntent | null> {
    const intent = this.getIntentSync(intentId);
    return Promise.resolve(intent ? cloneIntent(intent) : null);
  }

  list(): Promise<WorkspaceForkIntent[]> {
    const rows = this.db.prepare(`
      SELECT source_session_id, evidence_digest, intent_json
      FROM session_fork_workspace_intents
      ORDER BY created_at ASC, intent_id ASC
    `).all() as Array<{
      source_session_id: string;
      evidence_digest: string;
      intent_json: string;
    }>;
    return Promise.resolve(rows.map((row) => this.hydrateIntent(row)));
  }

  update(
    intentId: string,
    expectedRevision: number,
    patch: Partial<Omit<WorkspaceForkIntent, 'intentId' | 'version' | 'revision' | 'createdAt'>>,
  ): Promise<WorkspaceForkIntent> {
    const current = this.getIntentSync(intentId);
    if (!current) return Promise.reject(new Error(`intent ${intentId} does not exist`));
    if (current.revision !== expectedRevision) {
      return Promise.reject(new Error(`intent ${intentId} revision changed`));
    }
    const next: WorkspaceForkIntent = {
      ...current,
      ...structuredClone(patch),
      version: 1,
      intentId,
      revision: current.revision + 1,
      createdAt: current.createdAt,
    };
    const result = this.db.prepare(`
      UPDATE session_fork_workspace_intents
      SET request_digest = ?, revision = ?, source_session_id = ?,
          proposed_child_session_id = ?, repository_root = ?, workspace_path = ?,
          evidence_digest = ?, intent_json = ?, status = ?, advertisable = ?,
          updated_at = ?
      WHERE intent_id = ? AND revision = ?
    `).run(
      next.requestDigest,
      next.revision,
      next.sourceSessionId,
      next.proposedChildSessionId,
      next.repositoryRoot,
      next.workspacePath,
      next.evidenceDigest,
      this.serializeIntent(next),
      next.status,
      next.advertisable ? 1 : 0,
      next.updatedAt,
      intentId,
      expectedRevision,
    );
    if (result.changes !== 1) {
      return Promise.reject(new Error(`intent ${intentId} revision changed`));
    }
    return Promise.resolve(cloneIntent(next));
  }

  beginSaga(input: BeginSessionForkWorkspaceSagaInput): SessionForkWorkspaceSagaRecord {
    const sourceSessionId = input.sourceSessionId.trim();
    const idempotencyKey = input.idempotencyKey.trim();
    const requestDigest = input.requestDigest.trim();
    if (!sourceSessionId || !idempotencyKey || !requestDigest) {
      throw new Error('workspace saga requires source, idempotency, and request digests');
    }
    const existing = this.getSagaByRequest(sourceSessionId, idempotencyKey);
    if (existing) {
      if (existing.requestDigest !== requestDigest) {
        throw new Error('workspace saga idempotency key conflicts with another request');
      }
      return existing;
    }
    const now = input.now ?? Date.now();
    this.db.prepare(`
      INSERT INTO session_fork_workspace_sagas (
        intent_id, source_session_id, anchor_message_id, idempotency_key,
        request_digest, evidence_id, proposed_fork_id,
        proposed_child_session_id, context_delivery_mode, child_title,
        workspace_path, state, child_session_id, error_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'preparing', NULL, NULL, ?, ?)
    `).run(
      `workspace_intent_${sha256(`${sourceSessionId}:${idempotencyKey}`).slice(0, 32)}`,
      sourceSessionId,
      input.anchorMessageId,
      idempotencyKey,
      requestDigest,
      input.evidenceId,
      input.proposedForkId,
      input.proposedChildSessionId,
      input.contextDeliveryMode,
      input.childTitle,
      now,
      now,
    );
    return this.requireSagaByRequest(sourceSessionId, idempotencyKey);
  }

  markSagaWorkspaceReady(
    intentId: string,
    workspacePath: string,
    now = Date.now(),
  ): SessionForkWorkspaceSagaRecord {
    const current = this.requireSaga(intentId);
    if (current.state === 'completed' || current.state === 'child_staged') return current;
    if (current.state === 'quarantined' || current.state === 'aborted') {
      throw new Error(`workspace saga ${intentId} is ${current.state}`);
    }
    this.db.prepare(`
      UPDATE session_fork_workspace_sagas
      SET workspace_path = ?, state = 'workspace_ready', error_json = NULL, updated_at = ?
      WHERE intent_id = ? AND state IN ('preparing', 'workspace_ready')
    `).run(workspacePath, now, intentId);
    return this.requireSaga(intentId);
  }

  stageChild<T extends { forkId: string; childSessionId: string }>(
    intentId: string,
    createChild: (saga: SessionForkWorkspaceSagaRecord) => T,
    now = Date.now(),
  ): T {
    const transaction = this.db.transaction(() => {
      const saga = this.requireSaga(intentId);
      if (saga.state === 'quarantined' || saga.state === 'aborted') {
        throw new Error(`workspace saga ${intentId} is ${saga.state}`);
      }
      if (!saga.workspacePath) throw new Error(`workspace saga ${intentId} has no verified workspace`);
      const result = createChild(saga);
      if (
        result.forkId !== saga.proposedForkId
        || result.childSessionId !== saga.proposedChildSessionId
      ) {
        throw new Error('staged child identity differs from the durable workspace saga');
      }
      if (saga.state !== 'completed') {
        const childRow = this.db.prepare(`
          SELECT metadata FROM sessions WHERE id = ? LIMIT 1
        `).get(result.childSessionId) as { metadata: string | null } | undefined;
        const anchorEvidence = this.db.prepare(`
          SELECT project_id, workspace_scope_version, repository_root,
                 base_commit, evidence_digest, evidence_json, source_identity_json
          FROM session_fork_anchor_evidence
          WHERE id = ? AND status = 'complete'
          LIMIT 1
        `).get(saga.evidenceId) as {
          project_id: string;
          workspace_scope_version: string;
          repository_root: string;
          base_commit: string;
          evidence_digest: string;
          evidence_json: string;
          source_identity_json: string;
        } | undefined;
        const evidence = parseEvidence(anchorEvidence?.evidence_json);
        if (!childRow || !anchorEvidence || !evidence) {
          throw new Error('the staged child has no complete WorkspaceScope evidence projection');
        }
        const childMetadata = parseObject(childRow.metadata) ?? {};
        childMetadata.forkWorkspaceScopeV1 = {
          version: 1,
          forkId: saga.proposedForkId,
          intentId,
          evidenceId: saga.evidenceId,
          projectId: anchorEvidence.project_id,
          sourceWorkspaceScopeVersion: anchorEvidence.workspace_scope_version,
          sourcePrimaryRoot: anchorEvidence.repository_root,
          isolatedPrimaryRoot: saga.workspacePath,
          baseCommit: anchorEvidence.base_commit,
          evidenceDigest: anchorEvidence.evidence_digest,
          sourceIdentity: parseObject(anchorEvidence.source_identity_json) ?? {},
          pathMappings: evidence.manifest.pathMappings.map((mapping) => ({
            sourceId: mapping.sourceId,
            sourcePath: mapping.sourcePath,
            sourceRelativePath: mapping.repositoryRelativePath,
            isolatedRelativePath: mapping.isolatedRelativePath,
          })),
        };
        const forkUpdate = this.db.prepare(`
          UPDATE session_forks
          SET status = 'workspace_ready', workspace_snapshot_id = ?,
              committed_at = NULL, updated_at = ?
          WHERE id = ? AND child_session_id = ?
        `).run(intentId, now, result.forkId, result.childSessionId);
        const childUpdate = this.db.prepare(`
          UPDATE sessions
          SET is_deleted = 1, metadata = ?, updated_at = ?
          WHERE id = ?
        `).run(canonicalJson(childMetadata), now, result.childSessionId);
        const sagaUpdate = this.db.prepare(`
          UPDATE session_fork_workspace_sagas
          SET state = 'child_staged', child_session_id = ?,
              error_json = NULL, updated_at = ?
          WHERE intent_id = ?
        `).run(result.childSessionId, now, intentId);
        if (forkUpdate.changes !== 1 || childUpdate.changes !== 1 || sagaUpdate.changes !== 1) {
          throw new Error('the staged child could not be hidden atomically');
        }
      }
      return result;
    });
    return transaction();
  }

  finalizeSaga(intentId: string, now = Date.now()): SessionForkWorkspaceSagaRecord {
    const transaction = this.db.transaction(() => {
      const saga = this.requireSaga(intentId);
      if (saga.state === 'completed') return saga;
      if (saga.state !== 'child_staged' || !saga.childSessionId) {
        throw new Error(`workspace saga ${intentId} has no staged child`);
      }
      const forkUpdate = this.db.prepare(`
        UPDATE session_forks
        SET status = 'completed', committed_at = ?, updated_at = ?
        WHERE id = ? AND child_session_id = ? AND status = 'workspace_ready'
      `).run(now, now, saga.proposedForkId, saga.childSessionId);
      const childUpdate = this.db.prepare(`
        UPDATE sessions
        SET is_deleted = 0, working_directory = ?, updated_at = ?
        WHERE id = ?
      `).run(saga.workspacePath, now, saga.childSessionId);
      const sagaUpdate = this.db.prepare(`
        UPDATE session_fork_workspace_sagas
        SET state = 'completed', error_json = NULL, updated_at = ?
        WHERE intent_id = ?
      `).run(now, intentId);
      if (forkUpdate.changes !== 1 || childUpdate.changes !== 1 || sagaUpdate.changes !== 1) {
        throw new Error('the staged child could not be finalized atomically');
      }
    });
    transaction();
    return this.requireSaga(intentId);
  }

  quarantineSaga(
    intentId: string,
    error: Record<string, unknown>,
    now = Date.now(),
  ): SessionForkWorkspaceSagaRecord {
    const transaction = this.db.transaction(() => {
      const saga = this.requireSaga(intentId);
      if (saga.state === 'completed') throw new Error('completed workspace saga cannot be quarantined');
      if (saga.childSessionId) {
        this.db.prepare(`
          UPDATE sessions SET is_deleted = 1, updated_at = ? WHERE id = ?
        `).run(now, saga.childSessionId);
        this.db.prepare(`
          UPDATE session_forks
          SET status = 'quarantined', error_json = ?, updated_at = ?
          WHERE id = ?
        `).run(canonicalJson(error), now, saga.proposedForkId);
      }
      this.db.prepare(`
        UPDATE session_fork_workspace_sagas
        SET state = 'quarantined', error_json = ?, updated_at = ?
        WHERE intent_id = ?
      `).run(canonicalJson(error), now, intentId);
    });
    transaction();
    return this.requireSaga(intentId);
  }

  abortSaga(
    intentId: string,
    error: Record<string, unknown>,
    now = Date.now(),
  ): SessionForkWorkspaceSagaRecord {
    const saga = this.requireSaga(intentId);
    if (saga.childSessionId) return this.quarantineSaga(intentId, error, now);
    this.db.prepare(`
      UPDATE session_fork_workspace_sagas
      SET state = 'aborted', error_json = ?, updated_at = ?
      WHERE intent_id = ? AND state IN ('preparing', 'workspace_ready')
    `).run(canonicalJson(error), now, intentId);
    return this.requireSaga(intentId);
  }

  recordSagaError(
    intentId: string,
    error: Record<string, unknown>,
    now = Date.now(),
  ): SessionForkWorkspaceSagaRecord {
    this.db.prepare(`
      UPDATE session_fork_workspace_sagas
      SET error_json = ?, updated_at = ?
      WHERE intent_id = ? AND state NOT IN ('completed', 'aborted')
    `).run(canonicalJson(error), now, intentId);
    return this.requireSaga(intentId);
  }

  getSaga(intentId: string): SessionForkWorkspaceSagaRecord | null {
    const row = this.db.prepare(`
      SELECT * FROM session_fork_workspace_sagas WHERE intent_id = ? LIMIT 1
    `).get(intentId) as SQLiteRow | undefined;
    return row ? this.rowToSaga(row) : null;
  }

  getSagaByRequest(
    sourceSessionId: string,
    idempotencyKey: string,
  ): SessionForkWorkspaceSagaRecord | null {
    const row = this.db.prepare(`
      SELECT *
      FROM session_fork_workspace_sagas
      WHERE source_session_id = ? AND idempotency_key = ?
      LIMIT 1
    `).get(sourceSessionId, idempotencyKey) as SQLiteRow | undefined;
    return row ? this.rowToSaga(row) : null;
  }

  listRecoverableSagas(): SessionForkWorkspaceSagaRecord[] {
    return (this.db.prepare(`
      SELECT *
      FROM session_fork_workspace_sagas
      WHERE state IN ('preparing', 'workspace_ready', 'child_staged', 'quarantined')
      ORDER BY created_at ASC, intent_id ASC
    `).all() as SQLiteRow[]).map((row) => this.rowToSaga(row));
  }

  private getIntentSync(intentId: string): WorkspaceForkIntent | null {
    const row = this.db.prepare(`
      SELECT source_session_id, evidence_digest, intent_json
      FROM session_fork_workspace_intents
      WHERE intent_id = ?
      LIMIT 1
    `).get(intentId) as {
      source_session_id: string;
      evidence_digest: string;
      intent_json: string;
    } | undefined;
    return row ? this.hydrateIntent(row) : null;
  }

  private serializeIntent(intent: WorkspaceForkIntent): string {
    const { evidence: _storedByDigest, ...withoutEvidence } = intent;
    return canonicalJson(withoutEvidence);
  }

  private hydrateIntent(row: {
    source_session_id: string;
    evidence_digest: string;
    intent_json: string;
  }): WorkspaceForkIntent {
    const persisted = JSON.parse(row.intent_json) as Omit<WorkspaceForkIntent, 'evidence'>;
    const evidenceRow = this.db.prepare(`
      SELECT evidence_json
      FROM session_fork_anchor_evidence
      WHERE source_session_id = ?
        AND evidence_digest = ?
        AND status = 'complete'
      LIMIT 1
    `).get(row.source_session_id, row.evidence_digest) as { evidence_json: string } | undefined;
    const evidence = parseEvidence(evidenceRow?.evidence_json);
    if (!evidence) {
      throw new Error(`intent ${persisted.intentId} has no durable anchor evidence payload`);
    }
    return {
      ...persisted,
      evidence,
    };
  }

  private requireAnchorEvidence(
    sourceSessionId: string,
    anchorMessageId: string,
  ): SessionForkAnchorEvidenceRecord {
    const record = this.getAnchorEvidence(sourceSessionId, anchorMessageId);
    if (!record) throw new Error('anchor evidence was not persisted');
    return record;
  }

  private requireSaga(intentId: string): SessionForkWorkspaceSagaRecord {
    const saga = this.getSaga(intentId);
    if (!saga) throw new Error(`workspace saga ${intentId} does not exist`);
    return saga;
  }

  private requireSagaByRequest(
    sourceSessionId: string,
    idempotencyKey: string,
  ): SessionForkWorkspaceSagaRecord {
    const saga = this.getSagaByRequest(sourceSessionId, idempotencyKey);
    if (!saga) throw new Error('workspace saga was not persisted');
    return saga;
  }

  private rowToAnchorEvidence(row: SQLiteRow): SessionForkAnchorEvidenceRecord {
    return {
      id: String(row.id),
      sourceSessionId: String(row.source_session_id),
      anchorMessageId: String(row.anchor_message_id),
      ownerUserId: typeof row.owner_user_id === 'string' ? row.owner_user_id : null,
      projectId: typeof row.project_id === 'string' ? row.project_id : null,
      workspaceScopeVersion: typeof row.workspace_scope_version === 'string'
        ? row.workspace_scope_version
        : null,
      sourceIdentityDigest: typeof row.source_identity_digest === 'string'
        ? row.source_identity_digest
        : null,
      sourceIdentity: parseObject(row.source_identity_json),
      messageDigest: String(row.message_digest),
      repositoryRoot: typeof row.repository_root === 'string' ? row.repository_root : null,
      baseCommit: typeof row.base_commit === 'string' ? row.base_commit : null,
      observedHead: typeof row.observed_head === 'string' ? row.observed_head : null,
      evidenceDigest: typeof row.evidence_digest === 'string' ? row.evidence_digest : null,
      evidence: parseEvidence(row.evidence_json),
      summary: parseObject(row.summary_json) ?? {},
      status: String(row.status) as SessionForkAnchorEvidenceStatus,
      blockedReason: typeof row.blocked_reason === 'string' ? row.blocked_reason : null,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  private rowToSaga(row: SQLiteRow): SessionForkWorkspaceSagaRecord {
    return {
      intentId: String(row.intent_id),
      sourceSessionId: String(row.source_session_id),
      anchorMessageId: String(row.anchor_message_id),
      idempotencyKey: String(row.idempotency_key),
      requestDigest: String(row.request_digest),
      evidenceId: String(row.evidence_id),
      proposedForkId: String(row.proposed_fork_id),
      proposedChildSessionId: String(row.proposed_child_session_id),
      contextDeliveryMode: String(row.context_delivery_mode) as SessionForkContextDeliveryMode,
      childTitle: String(row.child_title),
      workspacePath: typeof row.workspace_path === 'string' ? row.workspace_path : null,
      state: String(row.state) as SessionForkWorkspaceSagaState,
      childSessionId: typeof row.child_session_id === 'string' ? row.child_session_id : null,
      error: parseObject(row.error_json),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }
}
