import type BetterSqlite3 from 'better-sqlite3';

import type {
  SessionExportEnvelopeV2,
  SessionForkSyncEnvelopeRecord,
  SessionForkSyncTransport,
  SessionForkSyncWireEnvelope,
} from '../../../../shared/contract/sessionForkPortability';
import {
  SessionForkPortabilityError,
} from '../../../../shared/contract/sessionForkPortability';
import {
  decodeSessionExportEnvelopeV2,
  encodeSessionExportEnvelopeV2,
  validateSessionExportEnvelopeV2,
} from '../../sessionFork/portability';
import { deepPortableClone } from '../../sessionFork/portability/canonical';
import {
  canonicalSessionForkStringify as canonicalStringify,
  failSessionForkPortability as fail,
  parseSessionForkStringArray as parseStringArray,
} from './SessionForkPortabilityInternals';

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

export class SessionForkSyncRepository {
  constructor(private readonly db: BetterSqlite3.Database) {}

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

  private requireEnvelopeScope(
    envelope: SessionExportEnvelopeV2,
    ownerScopeId: string,
    projectId: string,
  ): void {
    validateSessionExportEnvelopeV2(envelope, { ownerScopeId, projectId });
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
