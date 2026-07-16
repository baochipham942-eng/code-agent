import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';
import { applySchema } from '../../../src/host/services/core/database/schema';
import { GenerativeUIRepository } from '../../../src/host/services/core/repositories/GenerativeUIRepository';
import { GenerativeUIService } from '../../../src/host/services/generativeUI/generativeUIService';
import type { NeoUIEventV1 } from '../../../src/shared/contract/generativeUI';
import { getTelemetryService } from '../../../src/host/telemetry/telemetryService';

function logger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function rawSpec(): string {
  return JSON.stringify({
    schemaVersion: 1,
    title: 'Safe deployment',
    initialState: { plan: 'safe' },
    components: [{
      id: 'plan',
      type: 'ChoiceGroup',
      props: { label: 'Plan', options: [{ value: 'safe', label: 'Safe' }] },
      actions: [
        { event: 'change', intent: 'state.update', valuePath: 'plan' },
        { event: 'submit', intent: 'operation.request' },
      ],
    }],
    fallback: 'Choose a safe deployment plan.',
  });
}

describe('GenerativeUIService', () => {
  let db: BetterSqlite3.Database;
  let repo: GenerativeUIRepository;
  let now: number;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applySchema(db, logger() as never);
    db.prepare(`
      INSERT INTO sessions (id, title, model_provider, model_name, created_at, updated_at)
      VALUES ('s1', 'Session', 'openai', 'gpt-4.1', 1, 1)
    `).run();
    db.prepare(`
      INSERT INTO messages (id, session_id, role, content, timestamp)
      VALUES ('m1', 's1', 'assistant', ?, 1)
    `).run(`\`\`\`neo_ui\n${rawSpec()}\n\`\`\``);
    repo = new GenerativeUIRepository(db);
    now = 1_000;
  });

  afterEach(() => {
    getTelemetryService().reset();
    db.close();
  });

  function service(resolveResourceRevision?: () => string | undefined) {
    return new GenerativeUIService({
      repo,
      now: () => now,
      enabled: () => true,
      manifestEnabled: () => true,
      resolveResourceRevision,
    });
  }

  it('admits a persisted final spec once and restores the same instance', () => {
    const first = service().resolveInstance({
      sessionId: 's1', sourceMessageId: 'm1', sourceOrdinal: 0, rawSpec: rawSpec(),
    });
    const second = service().resolveInstance({
      sessionId: 's1', sourceMessageId: 'm1', sourceOrdinal: 0, rawSpec: rawSpec(),
    });

    expect(first.instance?.origin).toBe('model');
    expect(second.instance?.instanceId).toBe(first.instance?.instanceId);
    expect(second.instance?.state).toEqual({ plan: 'safe' });
  });

  it('binds admission to the exact persisted message fence and supersedes edited specs', () => {
    const first = service().resolveInstance({
      sessionId: 's1', sourceMessageId: 'm1', sourceOrdinal: 0, rawSpec: rawSpec(),
    }).instance!;
    const forged = JSON.stringify({ ...JSON.parse(rawSpec()), title: 'Forged renderer spec' });
    expect(service().resolveInstance({
      sessionId: 's1', sourceMessageId: 'm1', sourceOrdinal: 0, rawSpec: forged,
    })).toMatchObject({ enabled: true, error: 'SOURCE_SPEC_MISMATCH' });

    db.prepare('UPDATE messages SET content = ? WHERE id = ?')
      .run(`\`\`\`neo_ui\n${forged}\n\`\`\``, 'm1');
    const edited = service().resolveInstance({
      sessionId: 's1', sourceMessageId: 'm1', sourceOrdinal: 0, rawSpec: forged,
    }).instance!;
    expect(edited.instanceId).not.toBe(first.instanceId);
    expect(repo.getById(first.instanceId)).toMatchObject({ status: 'invalid', error: 'SPEC_SUPERSEDED' });
  });

  it('applies state with optimistic revision and deduplicates repeated events', () => {
    const instance = service().resolveInstance({
      sessionId: 's1', sourceMessageId: 'm1', sourceOrdinal: 0, rawSpec: rawSpec(),
    }).instance!;
    const event: NeoUIEventV1 = {
      eventId: 'event-1',
      sessionId: 's1',
      instanceId: instance.instanceId,
      nodeId: 'plan',
      specHash: instance.specHash,
      baseStateRevision: 0,
      intent: 'state.update',
      payload: { patch: { plan: 'fast' } },
      idempotencyKey: 'idem-1',
      createdAt: now,
    };

    const applied = service().applyEvent(event);
    const duplicate = service().applyEvent(event);
    const conflict = service().applyEvent({ ...event, eventId: 'event-2', idempotencyKey: 'idem-2' });

    expect(applied).toMatchObject({ status: 'applied', instance: { stateRevision: 1, state: { plan: 'fast' } } });
    expect(duplicate.status).toBe('duplicate');
    expect(conflict).toMatchObject({ status: 'conflict', error: 'STATE_REVISION_CONFLICT' });
  });

  it('rejects forged approval events from a model-owned instance', () => {
    const instance = service().resolveInstance({
      sessionId: 's1', sourceMessageId: 'm1', sourceOrdinal: 0, rawSpec: rawSpec(),
    }).instance!;
    const result = service().applyEvent({
      eventId: 'forged', sessionId: 's1', instanceId: instance.instanceId,
      nodeId: 'plan', specHash: instance.specHash, baseStateRevision: 0,
      intent: 'approval.respond', payload: { decision: 'approve' },
      idempotencyKey: 'forged', createdAt: now,
    });
    expect(result).toEqual({ status: 'rejected', error: 'HOST_SURFACE_REQUIRED' });
  });

  it('creates a Host manifest and executes the no-op adapter exactly once', () => {
    const instance = service().resolveInstance({
      sessionId: 's1', sourceMessageId: 'm1', sourceOrdinal: 0, rawSpec: rawSpec(),
    }).instance!;
    const event: NeoUIEventV1 = {
      eventId: 'operation-1', sessionId: 's1', instanceId: instance.instanceId,
      nodeId: 'plan', specHash: instance.specHash, baseStateRevision: 0,
      intent: 'operation.request',
      payload: { label: 'Validate', summary: 'Dry run only', resourceRevision: 'r1' },
      idempotencyKey: 'operation-1', createdAt: now,
    };
    const request = service(() => 'r1').applyEvent(event);
    const duplicateRequest = service(() => 'r1').applyEvent(event);
    const manifest = request.hostSurface!.manifest;
    const approved = service(() => 'r1').resolveManifest({
      sessionId: 's1', manifestId: manifest.manifestId, nonce: manifest.nonce, decision: 'approve',
    });
    const repeated = service(() => 'r1').resolveManifest({
      sessionId: 's1', manifestId: manifest.manifestId, nonce: manifest.nonce, decision: 'approve',
    });

    expect(manifest.origin).toBe('host');
    expect(duplicateRequest).toMatchObject({
      status: 'duplicate',
      hostSurface: { manifest: { manifestId: manifest.manifestId } },
    });
    expect(approved).toMatchObject({ accepted: true, manifest: { status: 'completed' } });
    expect(repeated).toMatchObject({ accepted: true, manifest: { status: 'completed' } });
  });

  it('keeps trusted actions behind the independent executionManifestV1 flag', () => {
    const disabled = new GenerativeUIService({
      repo,
      now: () => now,
      enabled: () => true,
      manifestEnabled: () => false,
    });
    const instance = disabled.resolveInstance({
      sessionId: 's1', sourceMessageId: 'm1', sourceOrdinal: 0, rawSpec: rawSpec(),
    }).instance!;
    expect(disabled.applyEvent({
      eventId: 'disabled-operation', sessionId: 's1', instanceId: instance.instanceId,
      nodeId: 'plan', specHash: instance.specHash, baseStateRevision: 0,
      intent: 'operation.request', idempotencyKey: 'disabled-operation', createdAt: now,
    })).toEqual({ status: 'rejected', error: 'EXECUTION_MANIFEST_DISABLED' });

    const enabled = service();
    const pending = enabled.applyEvent({
      eventId: 'created-before-disable', sessionId: 's1', instanceId: instance.instanceId,
      nodeId: 'plan', specHash: instance.specHash, baseStateRevision: 0,
      intent: 'operation.request', idempotencyKey: 'created-before-disable', createdAt: now,
    }).hostSurface!.manifest;
    expect(disabled.resolveManifest({
      sessionId: 's1', manifestId: pending.manifestId, nonce: pending.nonce, decision: 'approve',
    })).toMatchObject({
      accepted: false,
      error: 'EXECUTION_MANIFEST_DISABLED',
      manifest: { status: 'invalidated', invalidationReason: 'FEATURE_DISABLED' },
    });
  });

  it('fails closed when the resource revision drifts or the manifest expires', () => {
    const instance = service().resolveInstance({
      sessionId: 's1', sourceMessageId: 'm1', sourceOrdinal: 0, rawSpec: rawSpec(),
    }).instance!;
    const createManifest = (id: string) => service().applyEvent({
      eventId: id, sessionId: 's1', instanceId: instance.instanceId,
      nodeId: 'plan', specHash: instance.specHash, baseStateRevision: 0,
      intent: 'operation.request', payload: { resourceRevision: 'r1' },
      idempotencyKey: id, createdAt: now,
    }).hostSurface!.manifest;

    const drifted = createManifest('drift');
    expect(service(() => 'r2').resolveManifest({
      sessionId: 's1', manifestId: drifted.manifestId, nonce: drifted.nonce, decision: 'approve',
    })).toMatchObject({ accepted: false, error: 'RESOURCE_REVISION_DRIFT', manifest: { status: 'invalidated' } });

    const expired = createManifest('expired');
    now += 10 * 60 * 1000 + 1;
    expect(service(() => 'r1').resolveManifest({
      sessionId: 's1', manifestId: expired.manifestId, nonce: expired.nonce, decision: 'approve',
    })).toMatchObject({ accepted: false, error: 'MANIFEST_EXPIRED', manifest: { status: 'expired' } });
  });

  it('rejects cross-session, tampered, and oversized events without recording payload data in telemetry', () => {
    const instance = service().resolveInstance({
      sessionId: 's1', sourceMessageId: 'm1', sourceOrdinal: 0, rawSpec: rawSpec(),
    }).instance!;
    const base: NeoUIEventV1 = {
      eventId: 'bad-event', sessionId: 'wrong-session', instanceId: instance.instanceId,
      nodeId: 'plan', specHash: instance.specHash, baseStateRevision: 0,
      intent: 'state.update', payload: { patch: { secret: 'never-export-me' } },
      idempotencyKey: 'bad-event', createdAt: now,
    };
    expect(service().applyEvent(base)).toMatchObject({ status: 'rejected', error: 'INSTANCE_NOT_ACTIVE' });
    expect(service().applyEvent({
      ...base,
      eventId: 'tampered',
      sessionId: 's1',
      specHash: 'tampered',
      idempotencyKey: 'tampered',
    })).toMatchObject({ status: 'rejected', error: 'SPEC_HASH_MISMATCH' });
    expect(service().applyEvent({
      ...base,
      eventId: 'oversized',
      sessionId: 's1',
      idempotencyKey: 'oversized',
      payload: { patch: { plan: 'x'.repeat(20_000) } },
    })).toMatchObject({ status: 'rejected', error: 'STATE_BUDGET_EXCEEDED' });
    expect(service().applyEvent({
      ...base,
      eventId: 'event-budget',
      sessionId: 's1',
      idempotencyKey: 'event-budget',
      payload: { huge: 'x'.repeat(40_000) },
    })).toMatchObject({ status: 'rejected', error: 'EVENT_BUDGET_EXCEEDED' });
    expect(service().applyEvent({
      ...base,
      eventId: 'unbound-state',
      sessionId: 's1',
      idempotencyKey: 'unbound-state',
      payload: { patch: { unrelated: true } },
    })).toMatchObject({ status: 'rejected', error: 'STATE_PATCH_NOT_BOUND' });

    const serializedTelemetry = JSON.stringify(getTelemetryService().getRecentSpans(20));
    expect(serializedTelemetry).not.toContain('never-export-me');
    expect(serializedTelemetry).not.toContain('tampered');
    expect(serializedTelemetry).not.toContain('x'.repeat(100));
  });

  it('persists redacted event payloads and minimal replay metadata', () => {
    const instance = service().resolveInstance({
      sessionId: 's1', sourceMessageId: 'm1', sourceOrdinal: 0, rawSpec: rawSpec(),
    }).instance!;
    service().applyEvent({
      eventId: 'redacted', sessionId: 's1', instanceId: instance.instanceId,
      nodeId: 'plan', specHash: instance.specHash, baseStateRevision: 0,
      intent: 'state.update', payload: { patch: { plan: 'api_key=sk-private-event-value' } },
      idempotencyKey: 'redacted', createdAt: now,
    });
    const row = db.prepare(`
      SELECT payload_json, result_json FROM generative_ui_events WHERE event_id = 'redacted'
    `).get() as { payload_json: string; result_json: string };
    expect(row.payload_json).not.toContain('sk-private-event-value');
    expect(row.result_json).not.toContain('initialState');
    expect(row.result_json).not.toContain('specHash');
    expect(row.result_json).not.toContain('nonce');
    expect(JSON.parse(row.result_json)).toEqual({ status: 'applied', stateRevision: 1 });
  });

  it('does not leak replay results or lose durability when event identifiers collide', () => {
    const instance = service().resolveInstance({
      sessionId: 's1', sourceMessageId: 'm1', sourceOrdinal: 0, rawSpec: rawSpec(),
    }).instance!;
    const first: NeoUIEventV1 = {
      eventId: 'shared-event', sessionId: 's1', instanceId: instance.instanceId,
      nodeId: 'plan', specHash: instance.specHash, baseStateRevision: 0,
      intent: 'state.update', payload: { patch: { plan: 'first' } },
      idempotencyKey: 'shared-idem', createdAt: now,
    };
    expect(service().applyEvent(first).status).toBe('applied');

    expect(service().applyEvent({
      ...first,
      eventId: 'different-event',
      sessionId: 'other-session',
      idempotencyKey: 'shared-idem',
    })).toEqual({ status: 'rejected', error: 'EVENT_IDEMPOTENCY_CONFLICT' });
    expect(service().applyEvent({
      ...first,
      idempotencyKey: 'different-idem',
    })).toEqual({ status: 'rejected', error: 'EVENT_IDEMPOTENCY_CONFLICT' });
    expect(repo.getById(instance.instanceId)?.stateRevision).toBe(1);
  });

  it('orphan-invalidates open manifests and cascades message deletion', () => {
    const instance = service().resolveInstance({
      sessionId: 's1', sourceMessageId: 'm1', sourceOrdinal: 0, rawSpec: rawSpec(),
    }).instance!;
    const manifest = service().applyEvent({
      eventId: 'pending', sessionId: 's1', instanceId: instance.instanceId,
      nodeId: 'plan', specHash: instance.specHash, baseStateRevision: 0,
      intent: 'operation.request', idempotencyKey: 'pending', createdAt: now,
    }).hostSurface!.manifest;

    expect(repo.markOpenManifestsOrphaned(now + 1)).toBe(1);
    expect(repo.getManifest(manifest.manifestId)?.status).toBe('orphaned');
    db.prepare('DELETE FROM messages WHERE id = ?').run('m1');
    expect(repo.getById(instance.instanceId)).toBeNull();
    expect(repo.getManifest(manifest.manifestId)).toBeNull();
  });
});
