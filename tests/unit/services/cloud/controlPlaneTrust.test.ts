import { describe, expect, it } from 'vitest';
import * as crypto from 'crypto';
import type { ControlPlaneEnvelope } from '../../../../src/shared/contract/controlPlane';
import {
  buildControlPlaneContentHash,
  buildControlPlaneSigningPayload,
  verifyControlPlaneEnvelope,
} from '../../../../src/main/services/cloud/controlPlaneTrust';

function buildSignedEnvelope(payload: Record<string, unknown>, expiresAt = '2099-12-31T23:59:59.000Z') {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const envelope: ControlPlaneEnvelope<Record<string, unknown>> = {
    schemaVersion: 1,
    kind: 'cloud_config',
    issuedAt: '2026-05-17T00:00:00.000Z',
    expiresAt,
    contentHash: buildControlPlaneContentHash(payload),
    keyId: 'test-key',
    payload,
  };
  envelope.signature = crypto.sign(
    null,
    Buffer.from(buildControlPlaneSigningPayload(envelope)),
    privateKey,
  ).toString('base64');
  return {
    envelope,
    publicKeys: {
      'test-key': publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    },
  };
}

describe('controlPlaneTrust', () => {
  it('trusts a signed, unexpired envelope with a matching payload hash', () => {
    const payload = {
      version: 'test',
      prompts: { system: 'safe' },
    };
    const { envelope, publicKeys } = buildSignedEnvelope(payload);

    const result = verifyControlPlaneEnvelope<typeof payload>(envelope, {
      kind: 'cloud_config',
      publicKeys,
      requireSignature: true,
      now: Date.parse('2026-05-17T00:00:00.000Z'),
    });

    expect(result).toMatchObject({
      trusted: true,
      payload,
      keyId: 'test-key',
      expiresAt: '2099-12-31T23:59:59.000Z',
      diagnostics: [],
    });
  });

  it('rejects tampered payloads, expired envelopes, and unknown signing keys', () => {
    const payload = {
      version: 'test',
      prompts: { system: 'safe' },
    };
    const { envelope } = buildSignedEnvelope(payload, '2000-01-01T00:00:00.000Z');
    const tampered = {
      ...envelope,
      payload: {
        ...payload,
        prompts: { system: 'tampered' },
      },
    };

    const result = verifyControlPlaneEnvelope(tampered, {
      kind: 'cloud_config',
      publicKeys: {},
      requireSignature: true,
      now: Date.parse('2026-05-17T00:00:00.000Z'),
    });

    expect(result.trusted).toBe(false);
    expect(result.diagnostics.map((entry) => entry.code)).toEqual(expect.arrayContaining([
      'content_hash_mismatch',
      'expired_envelope',
      'unknown_key_id',
    ]));
  });

  it('rejects unsigned raw config shapes by default', () => {
    const result = verifyControlPlaneEnvelope({
      version: 'raw',
      prompts: {},
    }, {
      kind: 'cloud_config',
      requireSignature: true,
    });

    expect(result.trusted).toBe(false);
    expect(result.diagnostics.map((entry) => entry.code)).toContain('invalid_envelope');
  });
});
