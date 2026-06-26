import crypto from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ControlPlaneEnvelope } from '../../../src/shared/contract/controlPlane';
import {
  buildControlPlaneContentHash,
  buildControlPlaneSigningPayload,
} from '../../../src/host/services/cloud/controlPlaneTrust';
import {
  DEFAULT_MIN_MANIFEST_VALIDITY_SECONDS,
  RendererBundlePublishVerificationError,
  readPublicKeysFromArgs,
  verifyRendererBundlePublish,
} from '../../../scripts/verify-renderer-bundle-publish.mjs';

function bytesResponse(bytes: Uint8Array, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => Buffer.from(bytes).toString('utf8'),
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}

function jsonResponse(body: unknown, status = 200) {
  return bytesResponse(Buffer.from(JSON.stringify(body)), status);
}

function sha256Hex(bytes: Uint8Array): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function buildSignedRendererEnvelope(
  payload: Record<string, unknown>,
  options: { expiresAt?: string } = {},
) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const envelope: ControlPlaneEnvelope<Record<string, unknown>> = {
    schemaVersion: 1,
    kind: 'renderer_bundle' as ControlPlaneEnvelope['kind'],
    issuedAt: '2026-06-06T00:00:00.000Z',
    expiresAt: options.expiresAt ?? '2099-12-31T23:59:59.000Z',
    contentHash: buildControlPlaneContentHash(payload),
    keyId: 'renderer-key',
    payload,
  };
  envelope.signature = crypto
    .sign(null, Buffer.from(buildControlPlaneSigningPayload(envelope)), privateKey)
    .toString('base64');
  return {
    envelope,
    publicKeys: {
      'renderer-key': publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    },
  };
}

function buildReleaseRecord(payload: Record<string, unknown>) {
  return {
    schemaVersion: 1,
    kind: 'renderer_bundle_release_record',
    createdAt: '2026-06-06T00:00:00.000Z',
    channel: 'latest',
    version: payload.version,
    minShellVersion: payload.minShellVersion,
    rollbackToBuiltin: payload.rollbackToBuiltin === true,
    ...(payload.rollbackReason ? { rollbackReason: payload.rollbackReason } : {}),
    ...(payload.contentHash ? { contentHash: payload.contentHash } : {}),
    ...(payload.bundleUrl ? { bundleUrl: payload.bundleUrl } : {}),
    requiredShellCapabilitiesCount: Array.isArray(payload.requiredShellCapabilities)
      ? payload.requiredShellCapabilities.length
      : 0,
    requiredShellCapabilities: payload.requiredShellCapabilities ?? [],
    requiredRuntimeAssetsCount: Array.isArray(payload.requiredRuntimeAssets)
      ? payload.requiredRuntimeAssets.length
      : 0,
    requiredRuntimeAssets: payload.requiredRuntimeAssets ?? [],
    requiredResourcesCount: Array.isArray(payload.requiredResources)
      ? payload.requiredResources.length
      : 0,
    requiredResources: payload.requiredResources ?? [],
    urls: {
      latestManifest: 'https://oss.example/renderer-bundle/latest/manifest.json',
      latestBundle: payload.rollbackToBuiltin ? null : 'https://oss.example/renderer-bundle/latest/bundle.tar.gz',
      latestReleaseRecord: 'https://oss.example/renderer-bundle/latest/release-record.json',
    },
    git: {},
  };
}

describe('verifyRendererBundlePublish', () => {
  it('reads control-plane public keys from CLI sources', async () => {
    const pem = '-----BEGIN PUBLIC KEY-----\\nabc\\n-----END PUBLIC KEY-----';
    const keysJson = JSON.stringify({ keys: { 'renderer-key': pem } });
    const dir = await mkdtemp(path.join(tmpdir(), 'renderer-public-keys-'));
    const file = path.join(dir, 'keys.json');
    await writeFile(file, keysJson, 'utf8');

    await expect(readPublicKeysFromArgs(['--public-keys-file', file])).resolves.toEqual({
      'renderer-key': '-----BEGIN PUBLIC KEY-----\nabc\n-----END PUBLIC KEY-----',
    });
    await expect(readPublicKeysFromArgs(['--public-keys-json', keysJson])).resolves.toEqual({
      'renderer-key': '-----BEGIN PUBLIC KEY-----\nabc\n-----END PUBLIC KEY-----',
    });
    await expect(readPublicKeysFromArgs([
      '--public-key-id',
      'renderer-key',
      '--public-key',
      pem,
    ])).resolves.toEqual({
      'renderer-key': '-----BEGIN PUBLIC KEY-----\nabc\n-----END PUBLIC KEY-----',
    });
  });

  it('rejects ambiguous control-plane public key CLI sources', async () => {
    await expect(readPublicKeysFromArgs([
      '--public-keys-json',
      '{"renderer-key":"pem"}',
      '--public-key-id',
      'renderer-key',
      '--public-key',
      'pem',
    ])).rejects.toMatchObject({
      code: 'invalid_args',
    });
  });

  it('verifies a signed manifest and published bundle bytes', async () => {
    const bundleBytes = Buffer.from('renderer-bundle');
    const payload = {
      version: '0.16.93',
      contentHash: sha256Hex(bundleBytes),
      minShellVersion: '0.16.93',
      bundleUrl: 'https://oss.example/renderer-bundle/latest/bundle.tar.gz',
      requiredShellCapabilities: ['domain:update/check', 'native:tauri/desktop_get_capabilities'],
      requiredRuntimeAssets: ['playwright-browser-runtime'],
      requiredResources: ['resources/browser-relay-extension'],
    };
    const { envelope, publicKeys } = buildSignedRendererEnvelope({
      ...payload,
    });
    const fetchImpl = async (url: string) => (
      url.endsWith('/manifest.json')
        ? jsonResponse(envelope)
        : url.endsWith('/release-record.json')
          ? jsonResponse(buildReleaseRecord(payload))
          : bytesResponse(bundleBytes)
    );

    await expect(verifyRendererBundlePublish({
      manifestUrl: 'https://oss.example/renderer-bundle/latest/manifest.json',
      releaseRecordUrl: 'https://oss.example/renderer-bundle/latest/release-record.json',
      publicKeys,
      fetchImpl,
        expectedVersion: '0.16.93',
        minRequiredShellCapabilities: 1,
        expectedReleaseChannel: 'latest',
      })).resolves.toMatchObject({
        version: '0.16.93',
        contentHash: sha256Hex(bundleBytes),
        requiredShellCapabilitiesCount: 2,
        requiredRuntimeAssetsCount: 1,
        requiredResourcesCount: 1,
        releaseRecordVerified: true,
        releaseRecordUrl: 'https://oss.example/renderer-bundle/latest/release-record.json',
        bundleBytes: bundleBytes.byteLength,
        keyId: 'renderer-key',
      });
    });

  it('rejects when release record does not match the verified manifest', async () => {
    const bundleBytes = Buffer.from('renderer-bundle');
    const payload = {
      version: '0.16.93',
      contentHash: sha256Hex(bundleBytes),
      minShellVersion: '0.16.93',
      bundleUrl: 'https://oss.example/renderer-bundle/latest/bundle.tar.gz',
      requiredShellCapabilities: ['domain:update/check'],
    };
    const { envelope, publicKeys } = buildSignedRendererEnvelope(payload);
    const badRecord = {
      ...buildReleaseRecord(payload),
      contentHash: '0'.repeat(64),
    };

    await expect(verifyRendererBundlePublish({
      manifestUrl: 'https://oss.example/renderer-bundle/latest/manifest.json',
      releaseRecordUrl: 'https://oss.example/renderer-bundle/latest/release-record.json',
      publicKeys,
      fetchImpl: async (url: string) => (
        url.endsWith('/manifest.json')
          ? jsonResponse(envelope)
          : url.endsWith('/release-record.json')
            ? jsonResponse(badRecord)
            : bytesResponse(bundleBytes)
      ),
      minRequiredShellCapabilities: 1,
    })).rejects.toMatchObject({
      code: 'release_record_mismatch',
      details: { field: 'contentHash' },
    });
  });

  it('rejects when release record resource dependencies do not match the manifest', async () => {
    const bundleBytes = Buffer.from('renderer-bundle');
    const payload = {
      version: '0.16.93',
      contentHash: sha256Hex(bundleBytes),
      minShellVersion: '0.16.93',
      bundleUrl: 'https://oss.example/renderer-bundle/latest/bundle.tar.gz',
      requiredShellCapabilities: ['domain:update/check'],
      requiredRuntimeAssets: ['playwright-browser-runtime'],
      requiredResources: ['resources/browser-relay-extension'],
    };
    const { envelope, publicKeys } = buildSignedRendererEnvelope(payload);
    const badRecord = {
      ...buildReleaseRecord(payload),
      requiredRuntimeAssets: ['onnxruntime-vad'],
    };

    await expect(verifyRendererBundlePublish({
      manifestUrl: 'https://oss.example/renderer-bundle/latest/manifest.json',
      releaseRecordUrl: 'https://oss.example/renderer-bundle/latest/release-record.json',
      publicKeys,
      fetchImpl: async (url: string) => (
        url.endsWith('/manifest.json')
          ? jsonResponse(envelope)
          : url.endsWith('/release-record.json')
            ? jsonResponse(badRecord)
            : bytesResponse(bundleBytes)
      ),
      minRequiredShellCapabilities: 1,
    })).rejects.toMatchObject({
      code: 'release_record_mismatch',
      details: {
        expected: ['playwright-browser-runtime'],
        actual: ['onnxruntime-vad'],
      },
    });
  });

  it('rejects when release record rollout metadata does not match expected publish scope', async () => {
    const bundleBytes = Buffer.from('renderer-bundle');
    const payload = {
      version: '0.16.93',
      contentHash: sha256Hex(bundleBytes),
      minShellVersion: '0.16.93',
      bundleUrl: 'https://oss.example/renderer-bundle/channels/beta/bundle.tar.gz',
      requiredShellCapabilities: ['domain:update/check'],
    };
    const { envelope, publicKeys } = buildSignedRendererEnvelope(payload);
    const record = {
      ...buildReleaseRecord(payload),
      channel: 'beta',
      rollout: {
        channel: 'beta',
        cohort: 'staff',
        percent: 25,
      },
    };

    await expect(verifyRendererBundlePublish({
      manifestUrl: 'https://oss.example/renderer-bundle/channels/beta/manifest.json',
      releaseRecordUrl: 'https://oss.example/renderer-bundle/channels/beta/release-record.json',
      publicKeys,
      fetchImpl: async (url: string) => (
        url.endsWith('/manifest.json')
          ? jsonResponse(envelope)
          : url.endsWith('/release-record.json')
            ? jsonResponse(record)
            : bytesResponse(bundleBytes)
      ),
      minRequiredShellCapabilities: 1,
      expectedReleaseChannel: 'beta',
      expectedCohort: 'internal',
      expectedRolloutPercent: '25',
    })).rejects.toMatchObject({
      code: 'release_record_mismatch',
      details: { field: 'rollout.cohort', expected: 'internal', actual: 'staff' },
    });
  });

  it('rejects when latest manifest is not reachable', async () => {
    await expect(verifyRendererBundlePublish({
      manifestUrl: 'https://oss.example/renderer-bundle/latest/manifest.json',
      publicKeys: { key: 'not-used' },
      fetchImpl: async () => jsonResponse({ error: 'NoSuchKey' }, 404),
    })).rejects.toMatchObject({
      code: 'manifest_http_status',
    });
  });

  it('rejects when bundle bytes do not match manifest hash', async () => {
    const bundleBytes = Buffer.from('renderer-bundle');
    const { envelope, publicKeys } = buildSignedRendererEnvelope({
      version: '0.16.93',
      contentHash: sha256Hex(bundleBytes),
      minShellVersion: '0.16.93',
      bundleUrl: 'https://oss.example/renderer-bundle/latest/bundle.tar.gz',
      requiredShellCapabilities: ['domain:update/check'],
    });
    const fetchImpl = async (url: string) => (
      url.endsWith('/manifest.json')
        ? jsonResponse(envelope)
        : bytesResponse(Buffer.from('different-bundle'))
    );

    await expect(verifyRendererBundlePublish({
      manifestUrl: 'https://oss.example/renderer-bundle/latest/manifest.json',
      publicKeys,
      fetchImpl,
      minRequiredShellCapabilities: 1,
    })).rejects.toMatchObject({
      code: 'bundle_hash_mismatch',
    });
  });

  it('rejects a signed manifest that expires before the static publish validity window', async () => {
    const bundleBytes = Buffer.from('renderer-bundle');
    const payload = {
      version: '0.16.93',
      contentHash: sha256Hex(bundleBytes),
      minShellVersion: '0.16.93',
      bundleUrl: 'https://oss.example/renderer-bundle/latest/bundle.tar.gz',
      requiredShellCapabilities: ['domain:update/check'],
    };
    const { envelope, publicKeys } = buildSignedRendererEnvelope(payload, {
      expiresAt: '2026-06-06T01:00:00.000Z',
    });

    await expect(verifyRendererBundlePublish({
      manifestUrl: 'https://oss.example/renderer-bundle/latest/manifest.json',
      publicKeys,
      fetchImpl: async (url: string) => (
        url.endsWith('/manifest.json')
          ? jsonResponse(envelope)
          : bytesResponse(bundleBytes)
      ),
      minRequiredShellCapabilities: 1,
      now: Date.parse('2026-06-06T00:00:00.000Z'),
    })).rejects.toMatchObject({
      code: 'manifest_expires_too_soon',
      details: {
        expiresAt: '2026-06-06T01:00:00.000Z',
        remainingSeconds: 3600,
        minManifestValiditySeconds: DEFAULT_MIN_MANIFEST_VALIDITY_SECONDS,
      },
    });
  });

  it('allows a short-lived manifest when the minimum validity window is disabled', async () => {
    const bundleBytes = Buffer.from('renderer-bundle');
    const payload = {
      version: '0.16.93',
      contentHash: sha256Hex(bundleBytes),
      minShellVersion: '0.16.93',
      bundleUrl: 'https://oss.example/renderer-bundle/latest/bundle.tar.gz',
      requiredShellCapabilities: ['domain:update/check'],
    };
    const { envelope, publicKeys } = buildSignedRendererEnvelope(payload, {
      expiresAt: '2026-06-06T01:00:00.000Z',
    });

    await expect(verifyRendererBundlePublish({
      manifestUrl: 'https://oss.example/renderer-bundle/latest/manifest.json',
      publicKeys,
      fetchImpl: async (url: string) => (
        url.endsWith('/manifest.json')
          ? jsonResponse(envelope)
          : bytesResponse(bundleBytes)
      ),
      minRequiredShellCapabilities: 1,
      minManifestValiditySeconds: 0,
      now: Date.parse('2026-06-06T00:00:00.000Z'),
    })).resolves.toMatchObject({
      version: '0.16.93',
      expiresAt: '2026-06-06T01:00:00.000Z',
    });
  });

    it('rejects when required shell capabilities are missing from manifest', async () => {
    const bundleBytes = Buffer.from('renderer-bundle');
    const { envelope, publicKeys } = buildSignedRendererEnvelope({
      version: '0.16.93',
      contentHash: sha256Hex(bundleBytes),
      minShellVersion: '0.16.93',
      bundleUrl: 'https://oss.example/renderer-bundle/latest/bundle.tar.gz',
      requiredShellCapabilities: [],
    });

    await expect(verifyRendererBundlePublish({
      manifestUrl: 'https://oss.example/renderer-bundle/latest/manifest.json',
      publicKeys,
      fetchImpl: async (url: string) => (
        url.endsWith('/manifest.json')
          ? jsonResponse(envelope)
          : bytesResponse(bundleBytes)
      ),
      minRequiredShellCapabilities: 1,
      })).rejects.toBeInstanceOf(RendererBundlePublishVerificationError);
    });

    it('rejects when required shell capabilities are not supported by the current shell', async () => {
      const bundleBytes = Buffer.from('renderer-bundle');
      const { envelope, publicKeys } = buildSignedRendererEnvelope({
        version: '0.16.93',
        contentHash: sha256Hex(bundleBytes),
        minShellVersion: '0.16.93',
        bundleUrl: 'https://oss.example/renderer-bundle/latest/bundle.tar.gz',
        requiredShellCapabilities: ['domain:update/check', 'native:tauri/future_command'],
      });

      await expect(verifyRendererBundlePublish({
        manifestUrl: 'https://oss.example/renderer-bundle/latest/manifest.json',
        publicKeys,
        fetchImpl: async (url: string) => (
          url.endsWith('/manifest.json')
            ? jsonResponse(envelope)
            : bytesResponse(bundleBytes)
        ),
        minRequiredShellCapabilities: 1,
      })).rejects.toMatchObject({
        code: 'unsupported_shell_capabilities',
        details: { missingShellCapabilities: ['native:tauri/future_command'] },
      });
    });

    it('verifies a signed rollback manifest without fetching bundle bytes', async () => {
      const { envelope, publicKeys } = buildSignedRendererEnvelope({
        version: '0.16.93',
        minShellVersion: '0.16.93',
        rollbackToBuiltin: true,
        rollbackReason: 'bad renderer overlay',
      });
      const fetchedUrls: string[] = [];

      await expect(verifyRendererBundlePublish({
        manifestUrl: 'https://oss.example/renderer-bundle/latest/manifest.json',
        publicKeys,
        fetchImpl: async (url: string) => {
          fetchedUrls.push(url);
          return jsonResponse(envelope);
        },
        expectedVersion: '0.16.93',
        minRequiredShellCapabilities: 0,
      })).resolves.toMatchObject({
        version: '0.16.93',
        rollbackToBuiltin: true,
        rollbackReason: 'bad renderer overlay',
        bundleUrl: null,
        contentHash: null,
        bundleBytes: 0,
      });
      expect(fetchedUrls).toEqual(['https://oss.example/renderer-bundle/latest/manifest.json']);
    });
  });
