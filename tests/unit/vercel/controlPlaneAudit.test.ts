import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  recordControlPlaneAuditError,
  recordControlPlaneAuditEvent,
} from '../../../vercel-api/lib/controlPlaneAudit';
import type { ControlPlaneEnvelope } from '../../../vercel-api/lib/controlPlaneEnvelope';

const postgresMocks = vi.hoisted(() => ({
  unsafe: vi.fn(),
  end: vi.fn(),
  connect: vi.fn(),
}));

vi.mock('postgres', () => ({
  default: postgresMocks.connect,
}));

function makeEnvelope(): ControlPlaneEnvelope {
  return {
    schemaVersion: 1,
    kind: 'cloud_config',
    issuedAt: '2026-05-17T00:00:00.000Z',
    expiresAt: '2026-05-17T01:00:00.000Z',
    contentHash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    keyId: 'production-2026-05-17',
    payload: {
      version: 'production-2026-05-17.2',
      entitlement: {
        status: 'revoked',
        plan: 'unauthenticated',
        capabilities: [],
        reason: 'production_default_locked',
      },
      release: {
        channel: 'stable',
      },
      subject: {
        id: 'user-1',
        source: 'supabase_auth',
      },
    },
    signature: 'signature',
  };
}

describe('control-plane audit ledger', () => {
  beforeEach(() => {
    postgresMocks.unsafe.mockReset();
    postgresMocks.end.mockReset();
    postgresMocks.connect.mockReset();
    postgresMocks.unsafe.mockResolvedValue([]);
    postgresMocks.end.mockResolvedValue(undefined);
    postgresMocks.connect.mockReturnValue({
      unsafe: postgresMocks.unsafe,
      end: postgresMocks.end,
    });
  });

  it('skips writes unless audit is explicitly enabled', async () => {
    const fetchImpl = vi.fn<typeof fetch>();

    const result = await recordControlPlaneAuditEvent(
      { method: 'GET', headers: { authorization: 'Bearer secret-token' } },
      {
        envelope: makeEnvelope(),
        statusCode: 200,
        outcome: 'served',
        env: {},
        fetchImpl,
      },
    );

    expect(result).toEqual({ ok: true, skippedReason: 'audit_not_configured' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('can write through DATABASE_URL when no Supabase service role is configured', async () => {
    const result = await recordControlPlaneAuditEvent(
      { method: 'GET', headers: {} },
      {
        envelope: makeEnvelope(),
        statusCode: 200,
        outcome: 'served',
        now: new Date('2026-05-17T00:00:00.000Z'),
        env: {
          CONTROL_PLANE_AUDIT_ENABLED: 'true',
          DATABASE_URL: 'postgresql://user:pass@db.example.com/postgres',
        },
      },
    );

    expect(result).toEqual({ ok: true });
    expect(postgresMocks.connect).toHaveBeenCalledWith(
      'postgresql://user:pass@db.example.com/postgres',
      expect.objectContaining({ max: 1, prepare: false }),
    );
    expect(postgresMocks.unsafe).toHaveBeenCalledWith(
      expect.stringContaining('insert into control_plane_audit_events'),
      expect.arrayContaining([
        'cloud_config',
        'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        '2026-05-17T00:00:00.000Z',
        'unauthenticated',
        'production_default_locked',
        'revoked',
        null,
        'production-2026-05-17',
      ]),
    );
    expect(postgresMocks.end).toHaveBeenCalledWith({ timeout: 1 });
  });

  it('writes envelope metadata without tokens or full payloads', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue({
      ok: true,
      status: 201,
    } as Response);

    const result = await recordControlPlaneAuditEvent(
      {
        method: 'GET',
        headers: {
          authorization: 'Bearer secret-token',
          'user-agent': 'vitest',
          'x-vercel-id': 'iad1::request-id',
        },
      },
      {
        envelope: makeEnvelope(),
        statusCode: 200,
        outcome: 'served',
        now: new Date('2026-05-17T00:00:00.000Z'),
        env: {
          CONTROL_PLANE_AUDIT_ENABLED: 'true',
          CONTROL_PLANE_AUDIT_SUPABASE_URL: 'https://project.supabase.co',
          CONTROL_PLANE_AUDIT_SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
        },
        fetchImpl,
      },
    );

    expect(result).toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://project.supabase.co/rest/v1/control_plane_audit_events',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer service-role-key',
          apikey: 'service-role-key',
        }),
      }),
    );
    const body = JSON.parse((fetchImpl.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(body).toMatchObject({
      artifact_kind: 'cloud_config',
      content_hash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      entitlement_plan: 'unauthenticated',
      entitlement_reason: 'production_default_locked',
      entitlement_status: 'revoked',
      key_id: 'production-2026-05-17',
      outcome: 'served',
      payload_version: 'production-2026-05-17.2',
      release_channel: 'stable',
      request_id: 'iad1::request-id',
      request_method: 'GET',
      status_code: 200,
      subject_id: 'user-1',
      subject_source: 'supabase_auth',
      user_agent: 'vitest',
    });
    expect(JSON.stringify(body)).not.toContain('secret-token');
    expect(JSON.stringify(body)).not.toContain('signature');
    expect(JSON.stringify(body)).not.toContain('capabilities');
  });

  it('writes control-plane error rows without payload data', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue({
      ok: true,
      status: 201,
    } as Response);

    const result = await recordControlPlaneAuditError(
      { method: 'POST', headers: {} },
      {
        kind: 'prompt_registry',
        statusCode: 405,
        errorCode: 'method_not_allowed',
        now: new Date('2026-05-17T00:00:00.000Z'),
        env: {
          CONTROL_PLANE_AUDIT_ENABLED: 'true',
          CONTROL_PLANE_AUDIT_SUPABASE_URL: 'https://project.supabase.co',
          CONTROL_PLANE_AUDIT_SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
        },
        fetchImpl,
      },
    );

    expect(result).toEqual({ ok: true });
    const body = JSON.parse((fetchImpl.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(body).toMatchObject({
      artifact_kind: 'prompt_registry',
      error_code: 'method_not_allowed',
      outcome: 'error',
      request_method: 'POST',
      status_code: 405,
    });
    expect(body.content_hash).toBeUndefined();
  });
});
