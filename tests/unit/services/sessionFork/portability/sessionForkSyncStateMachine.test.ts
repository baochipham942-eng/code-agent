import { describe, expect, it } from 'vitest';
import {
  FakeSessionForkSyncTransport,
  LocalSessionForkSyncStateMachine,
  SessionForkPortabilityError,
  buildSessionExportEnvelopeV2,
} from '../../../../../src/host/services/sessionFork/portability';
import { OWNER_ID, PROJECT_ID, subtreeDraft } from './fixture';

describe('local session fork sync state machine', () => {
  it('keeps remote upload disabled by default', async () => {
    const transport = new FakeSessionForkSyncTransport();
    const sync = new LocalSessionForkSyncStateMachine({ transport });
    const record = sync.enqueueOutbound({
      syncEnvelopeId: 'sync-1',
      envelope: buildSessionExportEnvelopeV2(subtreeDraft()),
      dependencyIds: [],
      now: 1,
    });

    expect(record.state).toBe('local_only');
    await expect(sync.flushOutbound('sync-1')).rejects.toThrow(/REMOTE_UPLOAD_DISABLED/);
    expect(transport.uploadCount).toBe(0);
    expect(sync.get('sync-1')?.state).toBe('local_only');
  });

  it('roundtrips through a fake transport when upload is explicitly enabled', async () => {
    const transport = new FakeSessionForkSyncTransport();
    const sender = new LocalSessionForkSyncStateMachine({
      transport,
      remoteUploadEnabled: true,
    });
    const receiver = new LocalSessionForkSyncStateMachine();
    const envelope = buildSessionExportEnvelopeV2(subtreeDraft());

    sender.enqueueOutbound({
      syncEnvelopeId: 'sync-1',
      envelope,
      dependencyIds: [],
      now: 1,
    });
    expect((await sender.flushOutbound('sync-1')).state).toBe('applied');

    const wire = await transport.download('sync-1');
    const incoming = receiver.ingestInbound(wire!, 2);
    expect(incoming.state).toBe('ready');
    expect(receiver.applyInbound('sync-1', 3).state).toBe('applied');
    expect(receiver.get('sync-1')?.envelope).toEqual(envelope);
  });

  it('exposes pending while an explicitly enabled transport is awaiting acknowledgement', async () => {
    let acknowledge: (() => void) | undefined;
    const transport = {
      upload: () => new Promise<void>((resolve) => {
        acknowledge = resolve;
      }),
      download: async () => null,
    };
    const sync = new LocalSessionForkSyncStateMachine({
      transport,
      remoteUploadEnabled: true,
    });
    sync.enqueueOutbound({
      syncEnvelopeId: 'sync-pending',
      envelope: buildSessionExportEnvelopeV2(subtreeDraft()),
      dependencyIds: [],
      now: 1,
    });

    const flushing = sync.flushOutbound('sync-pending');
    expect(sync.get('sync-pending')?.state).toBe('pending');
    acknowledge?.();
    expect((await flushing).state).toBe('applied');
  });

  it('quarantines out-of-order dependencies and promotes only after they apply', async () => {
    const base = buildSessionExportEnvelopeV2(subtreeDraft());
    const dependent = buildSessionExportEnvelopeV2({
      ...subtreeDraft(),
      exportId: 'export-2',
    });
    const receiver = new LocalSessionForkSyncStateMachine();

    const childRecord = receiver.ingestInbound({
      syncEnvelopeId: 'sync-child',
      payloadDigest: dependent.payloadDigest,
      dependencyIds: ['sync-parent'],
      envelope: dependent,
    }, 1);
    expect(childRecord.state).toBe('quarantined');
    expect(childRecord.reason).toBe('DEPENDENCY_NOT_APPLIED');
    expect(() => receiver.applyInbound('sync-child', 2)).toThrow(/ENVELOPE_NOT_READY/);

    receiver.ingestInbound({
      syncEnvelopeId: 'sync-parent',
      payloadDigest: base.payloadDigest,
      dependencyIds: [],
      envelope: base,
    }, 3);
    receiver.applyInbound('sync-parent', 4);
    expect(receiver.get('sync-child')?.state).toBe('ready');
    expect(receiver.applyInbound('sync-child', 5).state).toBe('applied');
  });

  it('is idempotent for equal ID/digest and blocks equal ID with a different digest', () => {
    const envelope = buildSessionExportEnvelopeV2(subtreeDraft());
    const receiver = new LocalSessionForkSyncStateMachine();
    const wire = {
      syncEnvelopeId: 'sync-1',
      payloadDigest: envelope.payloadDigest,
      dependencyIds: [],
      envelope,
    };

    const first = receiver.ingestInbound(wire, 1);
    const duplicate = receiver.ingestInbound(wire, 2);
    expect(duplicate).toEqual(first);

    const conflictingEnvelope = buildSessionExportEnvelopeV2({
      ...subtreeDraft(),
      exportId: 'export-conflict',
    });
    expect(() => receiver.ingestInbound({
      ...wire,
      payloadDigest: conflictingEnvelope.payloadDigest,
      envelope: conflictingEnvelope,
    }, 3)).toThrowError(SessionForkPortabilityError);
    expect(receiver.get('sync-1')?.state).toBe('blocked');
    expect(receiver.get('sync-1')?.reason).toBe('SYNC_ID_DIGEST_CONFLICT');
  });

  it('validates owner and project at the inbox boundary', () => {
    const envelope = buildSessionExportEnvelopeV2(subtreeDraft());
    const receiver = new LocalSessionForkSyncStateMachine({
      expectedOwnerScopeId: OWNER_ID,
      expectedProjectId: PROJECT_ID,
    });
    const wire = {
      syncEnvelopeId: 'sync-1',
      payloadDigest: envelope.payloadDigest,
      dependencyIds: [],
      envelope: {
        ...envelope,
        ownerScopeId: 'attacker',
      },
    };

    expect(() => receiver.ingestInbound(wire, 1)).toThrow(/OWNER_SCOPE_MISMATCH/);
    expect(receiver.get('sync-1')?.state).toBe('blocked');
  });
});
