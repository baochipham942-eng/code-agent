// ============================================================================
// Generative UI local persistence — instances, events, and execution manifests
// ============================================================================

import type BetterSqlite3 from 'better-sqlite3';
import type {
  ExecutionManifestStatus,
  ExecutionManifestV1,
  NeoUIEventResultV1,
  NeoUIEventV1,
  NeoUIInstanceStatus,
  NeoUIInstanceV1,
  NeoUIModelSpecV1,
} from '../../../../shared/contract/generativeUI';
import { guardSensitiveValue } from '../../../security/sensitiveDataGuard';

type SQLiteRow = Record<string, unknown>;

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function rowToInstance(row: SQLiteRow): NeoUIInstanceV1 {
  return {
    schemaVersion: 1,
    instanceId: String(row.instance_id),
    sessionId: String(row.session_id),
    sourceMessageId: String(row.source_message_id),
    sourceOrdinal: Number(row.source_ordinal),
    sourceKey: String(row.source_key),
    specHash: String(row.spec_hash),
    origin: 'model',
    spec: parseJson<NeoUIModelSpecV1>(row.spec_json, {
      schemaVersion: 1,
      components: [],
      fallback: 'Interactive content is unavailable.',
    }),
    state: parseJson<Record<string, unknown>>(row.state_json, {}),
    stateRevision: Number(row.state_revision),
    status: row.status as NeoUIInstanceStatus,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    ...(row.error == null ? {} : { error: String(row.error) }),
  };
}

function rowToManifest(row: SQLiteRow): ExecutionManifestV1 {
  return {
    schemaVersion: 1,
    manifestId: String(row.manifest_id),
    sessionId: String(row.session_id),
    instanceId: String(row.instance_id),
    origin: 'host',
    nonce: String(row.nonce),
    scopeHash: String(row.scope_hash),
    title: String(row.title),
    summary: String(row.summary),
    items: parseJson<ExecutionManifestV1['items']>(row.items_json, []),
    status: row.status as ExecutionManifestStatus,
    expiresAt: Number(row.expires_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    ...(row.resolved_at == null ? {} : { resolvedAt: Number(row.resolved_at) }),
    ...(row.invalidation_reason == null ? {} : { invalidationReason: String(row.invalidation_reason) }),
  };
}

export interface InsertGenerativeUIInstanceInput {
  instance: NeoUIInstanceV1;
}

export interface InsertGenerativeUIEventInput {
  event: NeoUIEventV1;
  result: NeoUIEventResultV1;
}

export type GenerativeUIEventReplay =
  | { kind: 'duplicate'; result: NeoUIEventResultV1; manifest?: ExecutionManifestV1 }
  | { kind: 'conflict' };

interface PersistedGenerativeUIEventResult {
  status: NeoUIEventResultV1['status'];
  error?: string;
  stateRevision?: number;
  manifestId?: string;
}

export class GenerativeUIRepository {
  constructor(private readonly db: BetterSqlite3.Database) {}

  sourceMessageExists(sessionId: string, messageId: string): boolean {
    const row = this.db
      .prepare('SELECT 1 AS found FROM messages WHERE session_id = ? AND id = ? LIMIT 1')
      .get(sessionId, messageId) as SQLiteRow | undefined;
    return row?.found === 1;
  }

  getSourceMessageContent(sessionId: string, messageId: string): string | null {
    const row = this.db
      .prepare('SELECT content FROM messages WHERE session_id = ? AND id = ? LIMIT 1')
      .get(sessionId, messageId) as SQLiteRow | undefined;
    return typeof row?.content === 'string' ? row.content : null;
  }

  insertInstance(input: InsertGenerativeUIInstanceInput): NeoUIInstanceV1 {
    const { instance } = input;
    this.db.prepare(`
      INSERT OR IGNORE INTO generative_ui_instances (
        instance_id, session_id, source_message_id, source_ordinal, source_key,
        spec_hash, spec_json, state_json, state_revision, status,
        created_at, updated_at, error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      instance.instanceId,
      instance.sessionId,
      instance.sourceMessageId,
      instance.sourceOrdinal,
      instance.sourceKey,
      instance.specHash,
      JSON.stringify(instance.spec),
      JSON.stringify(instance.state),
      instance.stateRevision,
      instance.status,
      instance.createdAt,
      instance.updatedAt,
      instance.error ?? null,
    );
    return this.getBySourceKey(instance.sourceKey) ?? instance;
  }

  getBySourceKey(sourceKey: string): NeoUIInstanceV1 | null {
    const row = this.db
      .prepare('SELECT * FROM generative_ui_instances WHERE source_key = ?')
      .get(sourceKey) as SQLiteRow | undefined;
    return row ? rowToInstance(row) : null;
  }

  getById(instanceId: string): NeoUIInstanceV1 | null {
    const row = this.db
      .prepare('SELECT * FROM generative_ui_instances WHERE instance_id = ?')
      .get(instanceId) as SQLiteRow | undefined;
    return row ? rowToInstance(row) : null;
  }

  listByMessage(sessionId: string, messageId: string): NeoUIInstanceV1[] {
    return (this.db.prepare(`
      SELECT * FROM generative_ui_instances
      WHERE session_id = ? AND source_message_id = ? AND status != 'deleted'
      ORDER BY source_ordinal ASC
    `).all(sessionId, messageId) as SQLiteRow[]).map(rowToInstance);
  }

  listBySession(sessionId: string): NeoUIInstanceV1[] {
    return (this.db.prepare(`
      SELECT * FROM generative_ui_instances
      WHERE session_id = ? AND status != 'deleted'
      ORDER BY source_message_id ASC, source_ordinal ASC
    `).all(sessionId) as SQLiteRow[]).map(rowToInstance);
  }

  invalidateSupersededInstances(
    sessionId: string,
    sourceMessageId: string,
    sourceOrdinal: number,
    specHash: string,
    now: number,
  ): void {
    const transaction = this.db.transaction(() => {
      this.db.prepare(`
        UPDATE execution_manifests
        SET status = 'invalidated', updated_at = ?, resolved_at = ?, invalidation_reason = 'SPEC_SUPERSEDED'
        WHERE session_id = ? AND instance_id IN (
          SELECT instance_id FROM generative_ui_instances
          WHERE session_id = ? AND source_message_id = ? AND source_ordinal = ? AND spec_hash != ?
        ) AND status IN ('pending', 'approved', 'executing')
      `).run(now, now, sessionId, sessionId, sourceMessageId, sourceOrdinal, specHash);
      this.db.prepare(`
        UPDATE generative_ui_instances SET status = 'invalid', updated_at = ?, error = 'SPEC_SUPERSEDED'
        WHERE session_id = ? AND source_message_id = ? AND source_ordinal = ?
          AND spec_hash != ? AND status IN ('active', 'hidden')
      `).run(now, sessionId, sourceMessageId, sourceOrdinal, specHash);
    });
    transaction();
  }

  applyStateEvent(
    event: NeoUIEventV1,
    nextState: Record<string, unknown>,
    now: number,
  ): NeoUIEventResultV1 {
    const transaction = this.db.transaction((): NeoUIEventResultV1 => {
      const replay = this.getEventReplay(event);
      if (replay?.kind === 'duplicate') return { ...replay.result, status: 'duplicate' };
      if (replay?.kind === 'conflict') return { status: 'rejected', error: 'EVENT_IDEMPOTENCY_CONFLICT' };

      const instance = this.getById(event.instanceId);
      if (instance?.sessionId !== event.sessionId || instance?.status !== 'active') {
        const result: NeoUIEventResultV1 = { status: 'rejected', error: 'INSTANCE_NOT_ACTIVE' };
        this.insertEvent({ event, result });
        return result;
      }
      if (instance.specHash !== event.specHash) {
        const result: NeoUIEventResultV1 = { status: 'rejected', error: 'SPEC_HASH_MISMATCH' };
        this.insertEvent({ event, result });
        return result;
      }
      if (instance.stateRevision !== event.baseStateRevision) {
        const result: NeoUIEventResultV1 = { status: 'conflict', instance, error: 'STATE_REVISION_CONFLICT' };
        this.insertEvent({ event, result });
        return result;
      }

      const update = this.db.prepare(`
        UPDATE generative_ui_instances
        SET state_json = ?, state_revision = state_revision + 1, updated_at = ?
        WHERE instance_id = ? AND state_revision = ? AND status = 'active'
      `).run(JSON.stringify(nextState), now, instance.instanceId, event.baseStateRevision);
      if (update.changes !== 1) {
        const current = this.getById(instance.instanceId) ?? instance;
        const result: NeoUIEventResultV1 = { status: 'conflict', instance: current, error: 'STATE_REVISION_CONFLICT' };
        this.insertEvent({ event, result });
        return result;
      }

      const updated = this.getById(instance.instanceId);
      if (!updated) throw new Error('GENERATIVE_UI_INSTANCE_LOST_AFTER_UPDATE');
      const result: NeoUIEventResultV1 = { status: 'applied', instance: updated };
      this.insertEvent({ event, result });
      return result;
    });
    return transaction();
  }

  insertEvent(input: InsertGenerativeUIEventInput): void {
    const persistedResult: PersistedGenerativeUIEventResult = {
      status: input.result.status,
      ...(input.result.error ? { error: input.result.error } : {}),
      ...(input.result.instance ? { stateRevision: input.result.instance.stateRevision } : {}),
      ...(input.result.hostSurface ? { manifestId: input.result.hostSurface.manifest.manifestId } : {}),
    };
    const redactedPayload = input.event.payload
      ? guardSensitiveValue(input.event.payload, { surface: 'activity', mode: 'local-persist' })
      : null;
    this.db.prepare(`
      INSERT OR IGNORE INTO generative_ui_events (
        event_id, session_id, instance_id, node_id, spec_hash,
        base_state_revision, intent, payload_json, idempotency_key,
        result_json, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.event.eventId,
      input.event.sessionId,
      input.event.instanceId,
      input.event.nodeId,
      input.event.specHash,
      input.event.baseStateRevision,
      input.event.intent,
      redactedPayload ? JSON.stringify(redactedPayload) : null,
      input.event.idempotencyKey,
      JSON.stringify(persistedResult),
      input.result.status,
      input.event.createdAt,
    );
  }

  getEventReplay(event: NeoUIEventV1): GenerativeUIEventReplay | null {
    const rows = this.db.prepare(`
      SELECT event_id, session_id, instance_id, idempotency_key, result_json
      FROM generative_ui_events
      WHERE idempotency_key = ? OR event_id = ?
    `).all(event.idempotencyKey, event.eventId) as SQLiteRow[];
    if (rows.length === 0) return null;
    const duplicate = rows.find((row) => (
      String(row.idempotency_key) === event.idempotencyKey
      && String(row.session_id) === event.sessionId
      && String(row.instance_id) === event.instanceId
    ));
    if (!duplicate || rows.some((row) => (
      String(row.event_id) === event.eventId
      && String(row.idempotency_key) !== event.idempotencyKey
    ))) {
      return { kind: 'conflict' };
    }
    const persisted = parseJson<PersistedGenerativeUIEventResult & {
      instance?: NeoUIInstanceV1;
      hostSurface?: { manifest?: ExecutionManifestV1 };
    }>(duplicate.result_json, { status: 'rejected', error: 'INVALID_EVENT_RESULT' });
    const instance = this.getById(String(duplicate.instance_id));
    const manifestId = persisted.manifestId ?? persisted.hostSurface?.manifest?.manifestId;
    const manifest = manifestId ? this.getManifest(manifestId) ?? undefined : undefined;
    return {
      kind: 'duplicate',
      result: {
        status: persisted.status,
        ...(persisted.error ? { error: persisted.error } : {}),
        ...(instance ? { instance } : {}),
      },
      ...(manifest ? { manifest } : {}),
    };
  }

  insertManifest(manifest: ExecutionManifestV1): ExecutionManifestV1 {
    this.db.prepare(`
      INSERT INTO execution_manifests (
        manifest_id, session_id, instance_id, nonce, scope_hash,
        title, summary, items_json, status, expires_at,
        created_at, updated_at, resolved_at, invalidation_reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
    `).run(
      manifest.manifestId,
      manifest.sessionId,
      manifest.instanceId,
      manifest.nonce,
      manifest.scopeHash,
      manifest.title,
      manifest.summary,
      JSON.stringify(manifest.items),
      manifest.status,
      manifest.expiresAt,
      manifest.createdAt,
      manifest.updatedAt,
    );
    return manifest;
  }

  getManifest(manifestId: string): ExecutionManifestV1 | null {
    const row = this.db.prepare('SELECT * FROM execution_manifests WHERE manifest_id = ?')
      .get(manifestId) as SQLiteRow | undefined;
    return row ? rowToManifest(row) : null;
  }

  getLatestManifestForInstance(instanceId: string): ExecutionManifestV1 | null {
    const row = this.db.prepare(`
      SELECT * FROM execution_manifests
      WHERE instance_id = ?
      ORDER BY created_at DESC
      LIMIT 1
    `).get(instanceId) as SQLiteRow | undefined;
    return row ? rowToManifest(row) : null;
  }

  updateManifest(
    manifestId: string,
    expectedStatuses: ExecutionManifestStatus[],
    nextStatus: ExecutionManifestStatus,
    now: number,
    invalidationReason?: string,
  ): ExecutionManifestV1 | null {
    return this.transitionManifest(
      manifestId,
      expectedStatuses,
      nextStatus,
      now,
      invalidationReason,
    ).manifest;
  }

  transitionManifest(
    manifestId: string,
    expectedStatuses: ExecutionManifestStatus[],
    nextStatus: ExecutionManifestStatus,
    now: number,
    invalidationReason?: string,
  ): { manifest: ExecutionManifestV1 | null; changed: boolean } {
    if (expectedStatuses.length === 0) {
      return { manifest: this.getManifest(manifestId), changed: false };
    }
    const placeholders = expectedStatuses.map(() => '?').join(', ');
    const result = this.db.prepare(`
      UPDATE execution_manifests
      SET status = ?, updated_at = ?, resolved_at = ?, invalidation_reason = ?
      WHERE manifest_id = ? AND status IN (${placeholders})
    `).run(
      nextStatus,
      now,
      ['approved', 'executing'].includes(nextStatus) ? null : now,
      invalidationReason ?? null,
      manifestId,
      ...expectedStatuses,
    );
    return { manifest: this.getManifest(manifestId), changed: result.changes === 1 };
  }

  markOpenManifestsOrphaned(now: number): number {
    const result = this.db.prepare(`
      UPDATE execution_manifests
      SET status = 'orphaned', updated_at = ?, resolved_at = ?, invalidation_reason = 'PROCESS_RESTART'
      WHERE status IN ('pending', 'approved', 'executing')
    `).run(now, now);
    return result.changes;
  }

  hideInstancesForMessages(sessionId: string, messageIds: string[], now: number): void {
    if (messageIds.length === 0) return;
    const placeholders = messageIds.map(() => '?').join(', ');
    const transaction = this.db.transaction(() => {
      this.db.prepare(`
        UPDATE generative_ui_instances SET status = 'hidden', updated_at = ?
        WHERE session_id = ? AND source_message_id IN (${placeholders}) AND status = 'active'
      `).run(now, sessionId, ...messageIds);
      this.db.prepare(`
        UPDATE execution_manifests SET status = 'invalidated', updated_at = ?, resolved_at = ?, invalidation_reason = 'SOURCE_REWOUND'
        WHERE session_id = ? AND instance_id IN (
          SELECT instance_id FROM generative_ui_instances
          WHERE session_id = ? AND source_message_id IN (${placeholders})
        ) AND status IN ('pending', 'approved')
      `).run(now, now, sessionId, sessionId, ...messageIds);
    });
    transaction();
  }
}
