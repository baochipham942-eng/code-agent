import { describe, expect, it } from 'vitest';
import * as crypto from 'crypto';
import * as fs from 'fs';
import type { ControlPlaneEnvelope } from '../../../../src/shared/contract/controlPlane';
import {
  buildControlPlaneContentHash,
  buildControlPlaneSigningPayload,
  CONTROL_PLANE_PUBLIC_KEYS_REMEDIATION_HINT,
  formatControlPlaneDiagnostics,
  getControlPlanePublicKeysFromEnv,
  verifyControlPlaneEnvelope,
} from '../../../../src/host/services/cloud/controlPlaneTrust';

function buildSignedEnvelope(
  payload: Record<string, unknown>,
  expiresAt = '2099-12-31T23:59:59.000Z',
  kind: ControlPlaneEnvelope<Record<string, unknown>>['kind'] = 'cloud_config',
) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const envelope: ControlPlaneEnvelope<Record<string, unknown>> = {
    schemaVersion: 1,
    kind,
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

  it('explains unknown key ids without exposing public keys', () => {
    const payload = {
      version: 'test',
      prompts: { system: 'safe' },
    };
    const { envelope } = buildSignedEnvelope(payload);

    const result = verifyControlPlaneEnvelope(envelope, {
      kind: 'cloud_config',
      publicKeys: {
        'backup-key': '-----BEGIN PUBLIC KEY-----\nbackup\n-----END PUBLIC KEY-----',
        'current-key': '-----BEGIN PUBLIC KEY-----\ncurrent\n-----END PUBLIC KEY-----',
      },
      requireSignature: true,
      now: Date.parse('2026-05-17T00:00:00.000Z'),
    });

    const unknownKeyDiagnostic = result.diagnostics.find((entry) => entry.code === 'unknown_key_id') as
      | undefined
      | (typeof result.diagnostics[number] & {
        keyId?: string;
        knownKeyCount?: number;
        knownKeyIds?: string[];
        remediationHint?: string;
      });

    expect(result.trusted).toBe(false);
    expect(unknownKeyDiagnostic).toMatchObject({
      severity: 'error',
      actual: 'test-key',
      expected: 'known key ids: backup-key, current-key',
      keyId: 'test-key',
      knownKeyCount: 2,
      knownKeyIds: ['backup-key', 'current-key'],
      remediationHint: CONTROL_PLANE_PUBLIC_KEYS_REMEDIATION_HINT,
    });
    expect(unknownKeyDiagnostic?.message).toContain('test-key');
    expect(unknownKeyDiagnostic?.message).toContain('2 configured key ids');

    const formatted = formatControlPlaneDiagnostics(result.diagnostics);
    expect(formatted).toContain('keyId=test-key');
    expect(formatted).toContain('knownKeyCount=2');
    expect(formatted).toContain('knownKeyIds=[backup-key, current-key]');
    expect(formatted).toContain(`remediationHint=${CONTROL_PLANE_PUBLIC_KEYS_REMEDIATION_HINT}`);
    expect(JSON.stringify(result.diagnostics)).not.toContain('BEGIN PUBLIC KEY');
  });

  it('rejects a forged signature produced by a different key for a configured keyId', () => {
    const payload = {
      version: 'test',
      prompts: { system: 'safe' },
    };
    const { envelope, publicKeys } = buildSignedEnvelope(payload);
    const { privateKey: forgedPrivateKey } = crypto.generateKeyPairSync('ed25519');
    envelope.signature = crypto.sign(
      null,
      Buffer.from(buildControlPlaneSigningPayload(envelope)),
      forgedPrivateKey,
    ).toString('base64');

    const result = verifyControlPlaneEnvelope<typeof payload>(envelope, {
      kind: 'cloud_config',
      publicKeys,
      requireSignature: true,
      now: Date.parse('2026-05-17T00:00:00.000Z'),
    });

    expect(result.trusted).toBe(false);
    expect(result.diagnostics.map((entry) => entry.code)).toContain('invalid_signature');
    expect(result.diagnostics.map((entry) => entry.code)).not.toEqual(expect.arrayContaining([
      'content_hash_mismatch',
      'unknown_key_id',
    ]));
  });

  it('rejects an envelope signed for the wrong control-plane artifact kind', () => {
    const payload = {
      version: 'test',
      prompts: { system: 'safe' },
    };
    const { envelope, publicKeys } = buildSignedEnvelope(payload, undefined, 'cloud_config');

    const result = verifyControlPlaneEnvelope<typeof payload>(envelope, {
      kind: 'agent_engine_model_catalog',
      publicKeys,
      requireSignature: true,
      now: Date.parse('2026-05-17T00:00:00.000Z'),
    });

    expect(result.trusted).toBe(false);
    expect(result.diagnostics.map((entry) => entry.code)).toContain('kind_mismatch');
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

  it('loads bundled public keys from file when env keys are not set', () => {
    const previousFile = process.env.CODE_AGENT_CONTROL_PLANE_PUBLIC_KEYS_FILE;
    const previousJson = process.env.CODE_AGENT_CONTROL_PLANE_PUBLIC_KEYS;
    const previousKeyId = process.env.CODE_AGENT_CONTROL_PLANE_KEY_ID;
    const previousPublicKey = process.env.CODE_AGENT_CONTROL_PLANE_PUBLIC_KEY;
    const file = `${process.cwd()}/.test-data/control-plane-public-keys.json`;
    const publicKey = '-----BEGIN PUBLIC KEY-----\\ntest\\n-----END PUBLIC KEY-----';

    try {
      delete process.env.CODE_AGENT_CONTROL_PLANE_PUBLIC_KEYS;
      delete process.env.CODE_AGENT_CONTROL_PLANE_KEY_ID;
      delete process.env.CODE_AGENT_CONTROL_PLANE_PUBLIC_KEY;
      process.env.CODE_AGENT_CONTROL_PLANE_PUBLIC_KEYS_FILE = file;
      fs.mkdirSync(`${process.cwd()}/.test-data`, { recursive: true });
      fs.writeFileSync(file, JSON.stringify({
        schemaVersion: 1,
        keys: {
          file_key: publicKey,
        },
      }));

      expect(getControlPlanePublicKeysFromEnv()).toEqual({
        file_key: '-----BEGIN PUBLIC KEY-----\ntest\n-----END PUBLIC KEY-----',
      });
    } finally {
      if (previousFile === undefined) {
        delete process.env.CODE_AGENT_CONTROL_PLANE_PUBLIC_KEYS_FILE;
      } else {
        process.env.CODE_AGENT_CONTROL_PLANE_PUBLIC_KEYS_FILE = previousFile;
      }
      if (previousJson === undefined) {
        delete process.env.CODE_AGENT_CONTROL_PLANE_PUBLIC_KEYS;
      } else {
        process.env.CODE_AGENT_CONTROL_PLANE_PUBLIC_KEYS = previousJson;
      }
      if (previousKeyId === undefined) {
        delete process.env.CODE_AGENT_CONTROL_PLANE_KEY_ID;
      } else {
        process.env.CODE_AGENT_CONTROL_PLANE_KEY_ID = previousKeyId;
      }
      if (previousPublicKey === undefined) {
        delete process.env.CODE_AGENT_CONTROL_PLANE_PUBLIC_KEY;
      } else {
        process.env.CODE_AGENT_CONTROL_PLANE_PUBLIC_KEY = previousPublicKey;
      }
      fs.rmSync(file, { force: true });
    }
  });

  it('merges public keys from env JSON, env pair, and bundled file', () => {
    const previousFile = process.env.CODE_AGENT_CONTROL_PLANE_PUBLIC_KEYS_FILE;
    const previousJson = process.env.CODE_AGENT_CONTROL_PLANE_PUBLIC_KEYS;
    const previousKeyId = process.env.CODE_AGENT_CONTROL_PLANE_KEY_ID;
    const previousPublicKey = process.env.CODE_AGENT_CONTROL_PLANE_PUBLIC_KEY;
    const file = `${process.cwd()}/.test-data/control-plane-public-keys-merged.json`;

    try {
      fs.mkdirSync(`${process.cwd()}/.test-data`, { recursive: true });
      fs.writeFileSync(file, JSON.stringify({
        schemaVersion: 1,
        keys: {
          file_key: '-----BEGIN PUBLIC KEY-----\\nfile\\n-----END PUBLIC KEY-----',
          shared_key: '-----BEGIN PUBLIC KEY-----\\nfile-shared\\n-----END PUBLIC KEY-----',
        },
      }));
      process.env.CODE_AGENT_CONTROL_PLANE_PUBLIC_KEYS_FILE = file;
      process.env.CODE_AGENT_CONTROL_PLANE_PUBLIC_KEYS = JSON.stringify({
        json_key: '-----BEGIN PUBLIC KEY-----\\njson\\n-----END PUBLIC KEY-----',
      });
      process.env.CODE_AGENT_CONTROL_PLANE_KEY_ID = 'shared_key';
      process.env.CODE_AGENT_CONTROL_PLANE_PUBLIC_KEY = '-----BEGIN PUBLIC KEY-----\\nenv-shared\\n-----END PUBLIC KEY-----';

      expect(getControlPlanePublicKeysFromEnv()).toEqual({
        file_key: '-----BEGIN PUBLIC KEY-----\nfile\n-----END PUBLIC KEY-----',
        json_key: '-----BEGIN PUBLIC KEY-----\njson\n-----END PUBLIC KEY-----',
        shared_key: '-----BEGIN PUBLIC KEY-----\nenv-shared\n-----END PUBLIC KEY-----',
      });
    } finally {
      if (previousFile === undefined) {
        delete process.env.CODE_AGENT_CONTROL_PLANE_PUBLIC_KEYS_FILE;
      } else {
        process.env.CODE_AGENT_CONTROL_PLANE_PUBLIC_KEYS_FILE = previousFile;
      }
      if (previousJson === undefined) {
        delete process.env.CODE_AGENT_CONTROL_PLANE_PUBLIC_KEYS;
      } else {
        process.env.CODE_AGENT_CONTROL_PLANE_PUBLIC_KEYS = previousJson;
      }
      if (previousKeyId === undefined) {
        delete process.env.CODE_AGENT_CONTROL_PLANE_KEY_ID;
      } else {
        process.env.CODE_AGENT_CONTROL_PLANE_KEY_ID = previousKeyId;
      }
      if (previousPublicKey === undefined) {
        delete process.env.CODE_AGENT_CONTROL_PLANE_PUBLIC_KEY;
      } else {
        process.env.CODE_AGENT_CONTROL_PLANE_PUBLIC_KEY = previousPublicKey;
      }
      fs.rmSync(file, { force: true });
    }
  });
});
