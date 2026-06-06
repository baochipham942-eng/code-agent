import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ControlPlaneEnvelope } from '../../../src/shared/contract/controlPlane';
import {
  buildControlPlaneContentHash,
  buildControlPlaneSigningPayload,
} from '../../../src/main/services/cloud/controlPlaneTrust';
import {
  RuntimeAssetsPublishVerificationError,
  verifyRuntimeAssetsPublish,
} from '../../../scripts/verify-runtime-assets-publish.mjs';

function bytesResponse(bytes: Uint8Array, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => Buffer.from(bytes).toString('utf8'),
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}

function textResponse(text: string, status = 200) {
  return bytesResponse(Buffer.from(text), status);
}

function sha256Hex(bytes: Uint8Array): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function buildSignedRuntimeAssetsEnvelope(payload: Record<string, unknown>) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const envelope: ControlPlaneEnvelope<Record<string, unknown>> = {
    schemaVersion: 1,
    kind: 'runtime_assets_manifest' as ControlPlaneEnvelope['kind'],
    issuedAt: '2026-06-06T00:00:00.000Z',
    expiresAt: '2099-12-31T23:59:59.000Z',
    contentHash: buildControlPlaneContentHash(payload),
    keyId: 'runtime-assets-key',
    payload,
  };
  envelope.signature = crypto
    .sign(null, Buffer.from(buildControlPlaneSigningPayload(envelope)), privateKey)
    .toString('base64');
  return {
    envelope,
    publicKeys: {
      'runtime-assets-key': publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    },
  };
}

function buildRuntimeAssetsPublishFixture(overrides: {
  payload?: Partial<Record<string, unknown>>;
  archiveBytes?: Buffer;
  archiveSha256?: string;
} = {}) {
  const archiveBytes = overrides.archiveBytes ?? Buffer.from('playwright-browser-runtime');
  const asset = {
    id: 'playwright-browser-runtime',
    archiveFile: 'playwright-browser-runtime.tar.gz',
    archiveBytes: archiveBytes.byteLength,
    archiveSha256: overrides.archiveSha256 ?? sha256Hex(archiveBytes),
    expandedSha256: 'f'.repeat(64),
  };
  const { envelope, publicKeys } = buildSignedRuntimeAssetsEnvelope({
    schemaVersion: 1,
    kind: 'agent_neo_runtime_assets',
    generatedAt: '2026-06-06T00:00:00.000Z',
    appVersion: '0.16.93',
    platform: 'darwin-arm64',
    assets: [asset],
    ...overrides.payload,
  });
  const manifestText = JSON.stringify(envelope);
  const manifestSha256 = sha256Hex(Buffer.from(manifestText));
  return {
    archiveBytes,
    envelope,
    manifestSha256,
    manifestText,
    publicKeys,
  };
}

describe('verifyRuntimeAssetsPublish', () => {
  it('verifies a signed manifest, sha sidecar, and published archives', async () => {
    const fixture = buildRuntimeAssetsPublishFixture();
    const fetchImpl = async (url: string) => {
      if (url.endsWith('/runtime-assets-manifest-darwin-arm64.json')) {
        return textResponse(fixture.manifestText);
      }
      if (url.endsWith('/runtime-assets-manifest-darwin-arm64.sha256')) {
        return textResponse(`${fixture.manifestSha256}  runtime-assets-manifest-darwin-arm64.json\n`);
      }
      return bytesResponse(fixture.archiveBytes);
    };

    await expect(verifyRuntimeAssetsPublish({
      manifestUrl: 'https://oss.example/v0.16.93/runtime-assets/runtime-assets-manifest-darwin-arm64.json',
      manifestSha256Url: 'https://oss.example/v0.16.93/runtime-assets/runtime-assets-manifest-darwin-arm64.sha256',
      publicKeys: fixture.publicKeys,
      fetchImpl,
      expectedVersion: '0.16.93',
      expectedPlatform: 'darwin-arm64',
      minAssets: 1,
    })).resolves.toMatchObject({
      appVersion: '0.16.93',
      platform: 'darwin-arm64',
      manifestSha256: fixture.manifestSha256,
      assetCount: 1,
      keyId: 'runtime-assets-key',
    });
  });

  it('rejects when the sha sidecar is not reachable', async () => {
    const fixture = buildRuntimeAssetsPublishFixture();

    await expect(verifyRuntimeAssetsPublish({
      manifestUrl: 'https://oss.example/runtime-assets/runtime-assets-manifest-darwin-arm64.json',
      manifestSha256Url: 'https://oss.example/runtime-assets/runtime-assets-manifest-darwin-arm64.sha256',
      publicKeys: fixture.publicKeys,
      fetchImpl: async (url: string) => (
        url.endsWith('.sha256')
          ? textResponse('NoSuchKey', 404)
          : textResponse(fixture.manifestText)
      ),
    })).rejects.toMatchObject({
      code: 'http_status',
      status: 404,
    });
  });

  it('rejects when the manifest bytes do not match the sha sidecar', async () => {
    const fixture = buildRuntimeAssetsPublishFixture();

    await expect(verifyRuntimeAssetsPublish({
      manifestUrl: 'https://oss.example/runtime-assets/runtime-assets-manifest-darwin-arm64.json',
      manifestSha256Url: 'https://oss.example/runtime-assets/runtime-assets-manifest-darwin-arm64.sha256',
      publicKeys: fixture.publicKeys,
      fetchImpl: async (url: string) => (
        url.endsWith('.sha256')
          ? textResponse(`${'a'.repeat(64)}  runtime-assets-manifest-darwin-arm64.json\n`)
          : textResponse(fixture.manifestText)
      ),
    })).rejects.toMatchObject({
      code: 'manifest_hash_mismatch',
    });
  });

  it('rejects when an archive hash does not match the signed manifest', async () => {
    const fixture = buildRuntimeAssetsPublishFixture();

    await expect(verifyRuntimeAssetsPublish({
      manifestUrl: 'https://oss.example/runtime-assets/runtime-assets-manifest-darwin-arm64.json',
      manifestSha256Url: 'https://oss.example/runtime-assets/runtime-assets-manifest-darwin-arm64.sha256',
      publicKeys: fixture.publicKeys,
      fetchImpl: async (url: string) => {
        if (url.endsWith('.json')) return textResponse(fixture.manifestText);
        if (url.endsWith('.sha256')) return textResponse(fixture.manifestSha256);
        return bytesResponse(Buffer.from('different-archive'));
      },
    })).rejects.toMatchObject({
      code: 'archive_hash_mismatch',
    });
  });

  it('rejects when the manifest has too few assets', async () => {
    const fixture = buildRuntimeAssetsPublishFixture({
      payload: { assets: [] },
    });

    await expect(verifyRuntimeAssetsPublish({
      manifestUrl: 'https://oss.example/runtime-assets/runtime-assets-manifest-darwin-arm64.json',
      manifestSha256Url: 'https://oss.example/runtime-assets/runtime-assets-manifest-darwin-arm64.sha256',
      publicKeys: fixture.publicKeys,
      fetchImpl: async (url: string) => (
        url.endsWith('.sha256')
          ? textResponse(fixture.manifestSha256)
          : textResponse(fixture.manifestText)
      ),
      minAssets: 1,
    })).rejects.toBeInstanceOf(RuntimeAssetsPublishVerificationError);
  });
});
