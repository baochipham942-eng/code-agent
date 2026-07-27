import type {
  SessionForkSyncEnvelopeRecord,
  SessionForkSyncTransport,
  SessionForkSyncWireEnvelope,
} from '../../../../shared/contract/sessionForkPortability';
import { SessionForkPortabilityError } from '../../../../shared/contract/sessionForkPortability';
import { deepPortableClone } from './canonical';
import { validateSessionExportEnvelopeV2 } from './codec';

export class FakeSessionForkSyncTransport implements SessionForkSyncTransport {
  private readonly envelopes = new Map<string, SessionForkSyncWireEnvelope>();
  uploadCount = 0;

  async upload(envelope: SessionForkSyncWireEnvelope): Promise<void> {
    const existing = this.envelopes.get(envelope.syncEnvelopeId);
    if (existing) {
      if (existing.payloadDigest !== envelope.payloadDigest) {
        throw new SessionForkPortabilityError(
          'SYNC_ID_DIGEST_CONFLICT',
          `transport already contains ${envelope.syncEnvelopeId} with another digest`,
        );
      }
      return;
    }
    this.envelopes.set(envelope.syncEnvelopeId, deepPortableClone(envelope));
    this.uploadCount += 1;
  }

  async download(syncEnvelopeId: string): Promise<SessionForkSyncWireEnvelope | null> {
    const envelope = this.envelopes.get(syncEnvelopeId);
    return envelope ? deepPortableClone(envelope) : null;
  }
}

export interface LocalSessionForkSyncStateMachineOptions {
  transport?: SessionForkSyncTransport;
  remoteUploadEnabled?: boolean;
  expectedOwnerScopeId?: string;
  expectedProjectId?: string;
}

export interface EnqueueSessionForkOutboundInput {
  syncEnvelopeId: string;
  dependencyIds: string[];
  envelope: SessionForkSyncWireEnvelope['envelope'];
  now: number;
}

export class LocalSessionForkSyncStateMachine {
  private readonly records = new Map<string, SessionForkSyncEnvelopeRecord>();
  private readonly transport?: SessionForkSyncTransport;
  private readonly remoteUploadEnabled: boolean;
  private readonly expectedOwnerScopeId?: string;
  private readonly expectedProjectId?: string;

  constructor(options: LocalSessionForkSyncStateMachineOptions = {}) {
    this.transport = options.transport;
    this.remoteUploadEnabled = options.remoteUploadEnabled === true;
    this.expectedOwnerScopeId = options.expectedOwnerScopeId;
    this.expectedProjectId = options.expectedProjectId;
  }

  get(syncEnvelopeId: string): SessionForkSyncEnvelopeRecord | null {
    const record = this.records.get(syncEnvelopeId);
    return record ? deepPortableClone(record) : null;
  }

  list(): SessionForkSyncEnvelopeRecord[] {
    return [...this.records.values()]
      .sort((left, right) => (
        left.createdAt - right.createdAt
        || left.syncEnvelopeId.localeCompare(right.syncEnvelopeId)
      ))
      .map(deepPortableClone);
  }

  enqueueOutbound(input: EnqueueSessionForkOutboundInput): SessionForkSyncEnvelopeRecord {
    validateSessionExportEnvelopeV2(input.envelope);
    this.assertDependencies(input.syncEnvelopeId, input.dependencyIds);
    const existing = this.records.get(input.syncEnvelopeId);
    if (existing) {
      return this.resolveDuplicate(existing, input.envelope.payloadDigest);
    }
    const record: SessionForkSyncEnvelopeRecord = {
      syncEnvelopeId: input.syncEnvelopeId,
      payloadDigest: input.envelope.payloadDigest,
      dependencyIds: [...input.dependencyIds],
      envelope: deepPortableClone(input.envelope),
      direction: 'outbox',
      state: 'local_only',
      createdAt: input.now,
      updatedAt: input.now,
    };
    this.records.set(record.syncEnvelopeId, record);
    return deepPortableClone(record);
  }

  async flushOutbound(syncEnvelopeId: string): Promise<SessionForkSyncEnvelopeRecord> {
    const record = this.records.get(syncEnvelopeId);
    if (record?.direction !== 'outbox') {
      throw new SessionForkPortabilityError(
        'SYNC_ENVELOPE_NOT_FOUND',
        `outbox envelope ${syncEnvelopeId} does not exist`,
      );
    }
    if (record.state === 'applied') return deepPortableClone(record);
    if (!this.remoteUploadEnabled) {
      throw new SessionForkPortabilityError(
        'REMOTE_UPLOAD_DISABLED',
        'remote lineage upload is disabled unless explicitly enabled',
      );
    }
    if (!this.transport) {
      throw new SessionForkPortabilityError(
        'INVALID_ENVELOPE',
        'remote upload was enabled without a transport',
      );
    }
    record.state = 'pending';
    record.updatedAt += 1;
    delete record.reason;
    try {
      await this.transport.upload({
        syncEnvelopeId: record.syncEnvelopeId,
        payloadDigest: record.payloadDigest,
        dependencyIds: [...record.dependencyIds],
        envelope: deepPortableClone(record.envelope),
      });
      record.state = 'applied';
      record.updatedAt += 1;
      return deepPortableClone(record);
    } catch (error) {
      record.state = 'blocked';
      record.reason = error instanceof SessionForkPortabilityError
        ? error.code
        : 'TRANSPORT_UPLOAD_FAILED';
      record.updatedAt += 1;
      throw error;
    }
  }

  ingestInbound(
    wire: SessionForkSyncWireEnvelope,
    now: number,
  ): SessionForkSyncEnvelopeRecord {
    const existing = this.records.get(wire.syncEnvelopeId);
    if (existing) {
      return this.resolveDuplicate(existing, wire.payloadDigest);
    }
    const draft: SessionForkSyncEnvelopeRecord = {
      ...deepPortableClone(wire),
      direction: 'inbox',
      state: 'blocked',
      createdAt: now,
      updatedAt: now,
    };
    this.records.set(wire.syncEnvelopeId, draft);
    try {
      if (wire.payloadDigest !== wire.envelope.payloadDigest) {
        throw new SessionForkPortabilityError(
          'DIGEST_MISMATCH',
          `sync wrapper digest differs from export ${wire.envelope.exportId}`,
        );
      }
      this.assertDependencies(wire.syncEnvelopeId, wire.dependencyIds);
      validateSessionExportEnvelopeV2(wire.envelope, (
        this.expectedOwnerScopeId !== undefined && this.expectedProjectId !== undefined
          ? {
            ownerScopeId: this.expectedOwnerScopeId,
            projectId: this.expectedProjectId,
          }
          : undefined
      ));
      const missingDependencies = this.unappliedDependencies(wire.dependencyIds);
      draft.state = missingDependencies.length > 0 ? 'quarantined' : 'ready';
      draft.reason = missingDependencies.length > 0 ? 'DEPENDENCY_NOT_APPLIED' : undefined;
      return deepPortableClone(draft);
    } catch (error) {
      draft.state = 'blocked';
      draft.reason = error instanceof SessionForkPortabilityError ? error.code : 'INVALID_ENVELOPE';
      throw error;
    }
  }

  applyInbound(syncEnvelopeId: string, now: number): SessionForkSyncEnvelopeRecord {
    const record = this.records.get(syncEnvelopeId);
    if (record?.direction !== 'inbox') {
      throw new SessionForkPortabilityError(
        'SYNC_ENVELOPE_NOT_FOUND',
        `inbox envelope ${syncEnvelopeId} does not exist`,
      );
    }
    if (record.state === 'applied') return deepPortableClone(record);
    if (record.state !== 'ready') {
      throw new SessionForkPortabilityError(
        'ENVELOPE_NOT_READY',
        `${syncEnvelopeId} is ${record.state}`,
      );
    }
    record.state = 'applied';
    record.updatedAt = now;
    delete record.reason;
    this.promoteQuarantined(now);
    return deepPortableClone(record);
  }

  private resolveDuplicate(
    existing: SessionForkSyncEnvelopeRecord,
    payloadDigest: string,
  ): SessionForkSyncEnvelopeRecord {
    if (existing.payloadDigest === payloadDigest) {
      return deepPortableClone(existing);
    }
    existing.state = 'blocked';
    existing.reason = 'SYNC_ID_DIGEST_CONFLICT';
    existing.updatedAt += 1;
    throw new SessionForkPortabilityError(
      'SYNC_ID_DIGEST_CONFLICT',
      `${existing.syncEnvelopeId} was reused with another digest`,
    );
  }

  private assertDependencies(syncEnvelopeId: string, dependencyIds: string[]): void {
    if (
      dependencyIds.includes(syncEnvelopeId)
      || new Set(dependencyIds).size !== dependencyIds.length
    ) {
      throw new SessionForkPortabilityError(
        'REFERENCE_NOT_CLOSED',
        `${syncEnvelopeId} has invalid dependency references`,
      );
    }
  }

  private unappliedDependencies(dependencyIds: string[]): string[] {
    return dependencyIds.filter((dependencyId) => (
      this.records.get(dependencyId)?.state !== 'applied'
    ));
  }

  private promoteQuarantined(now: number): void {
    let changed = true;
    while (changed) {
      changed = false;
      for (const record of this.records.values()) {
        if (
          record.direction === 'inbox'
          && record.state === 'quarantined'
          && this.unappliedDependencies(record.dependencyIds).length === 0
        ) {
          record.state = 'ready';
          record.updatedAt = now;
          delete record.reason;
          changed = true;
        }
      }
    }
  }
}
