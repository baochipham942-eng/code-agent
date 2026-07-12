#!/usr/bin/env node
import crypto from 'node:crypto';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import {
  getControlPlanePublicKeysFromEnv,
  verifyControlPlaneEnvelope,
} from '../src/host/services/cloud/controlPlaneTrust.ts';

export class RuntimeAssetsPublishVerificationError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'RuntimeAssetsPublishVerificationError';
    this.code = options.code ?? 'runtime_assets_publish_verification_failed';
    this.endpoint = options.endpoint;
    this.status = options.status;
    this.details = options.details;
  }
}

function readArg(args, name) {
  const index = args.indexOf(name);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : undefined;
}

function hasFlag(args, name) {
  return args.includes(name);
}

function sha256Hex(bytes) {
  return crypto.createHash('sha256').update(Buffer.from(bytes)).digest('hex');
}

function extractSha256(text) {
  return text.match(/\b[a-f0-9]{64}\b/i)?.[0]?.toLowerCase() ?? null;
}

function assertNonEmptyString(value, field, code = 'invalid_manifest') {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new RuntimeAssetsPublishVerificationError(`${field} is required`, {
      code,
      details: { field },
    });
  }
}

async function fetchText(fetchImpl, url) {
  const response = await fetchImpl(url, { headers: { Accept: 'text/plain, application/json' } });
  const text = await response.text();
  if (!response.ok) {
    throw new RuntimeAssetsPublishVerificationError(`${url} returned HTTP ${response.status}`, {
      code: 'http_status',
      endpoint: url,
      status: response.status,
      details: text.slice(0, 500),
    });
  }
  return text;
}

async function fetchBytes(fetchImpl, url) {
  const response = await fetchImpl(url);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!response.ok) {
    throw new RuntimeAssetsPublishVerificationError(`${url} returned HTTP ${response.status}`, {
      code: 'http_status',
      endpoint: url,
      status: response.status,
      details: Buffer.from(bytes).toString('utf8').slice(0, 500),
    });
  }
  if (bytes.byteLength === 0) {
    throw new RuntimeAssetsPublishVerificationError(`${url} is empty`, {
      code: 'empty_artifact',
      endpoint: url,
    });
  }
  return bytes;
}

function assertRuntimeAssetManifest(payload, options = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new RuntimeAssetsPublishVerificationError('runtime assets manifest payload must be an object', {
      code: 'invalid_manifest',
      details: payload,
    });
  }
  if (payload.schemaVersion !== 1) {
    throw new RuntimeAssetsPublishVerificationError('runtime assets manifest schemaVersion must be 1', {
      code: 'invalid_manifest',
      details: { schemaVersion: payload.schemaVersion },
    });
  }
  if (payload.kind !== 'agent_neo_runtime_assets') {
    throw new RuntimeAssetsPublishVerificationError('runtime assets manifest kind mismatch', {
      code: 'invalid_manifest_kind',
      details: { kind: payload.kind },
    });
  }
  if (options.expectedVersion && payload.appVersion !== options.expectedVersion) {
    throw new RuntimeAssetsPublishVerificationError(
      `runtime assets appVersion mismatch: expected ${options.expectedVersion}, got ${payload.appVersion}`,
      {
        code: 'version_mismatch',
        details: { expected: options.expectedVersion, actual: payload.appVersion },
      },
    );
  }
  if (options.expectedPlatform && payload.platform !== options.expectedPlatform) {
    throw new RuntimeAssetsPublishVerificationError(
      `runtime assets platform mismatch: expected ${options.expectedPlatform}, got ${payload.platform}`,
      {
        code: 'platform_mismatch',
        details: { expected: options.expectedPlatform, actual: payload.platform },
      },
    );
  }
  const minAssets = options.minAssets ?? 1;
  if (!Array.isArray(payload.assets) || payload.assets.length < minAssets) {
    throw new RuntimeAssetsPublishVerificationError(`runtime assets manifest must contain at least ${minAssets} assets`, {
      code: 'missing_assets',
      details: { expected: minAssets, actual: Array.isArray(payload.assets) ? payload.assets.length : 0 },
    });
  }

  const assetIds = new Set();
  for (const asset of payload.assets) {
    if (!asset || typeof asset !== 'object' || Array.isArray(asset)) {
      throw new RuntimeAssetsPublishVerificationError('runtime asset entry must be an object', {
        code: 'invalid_asset',
        details: asset,
      });
    }
    assertNonEmptyString(asset.id, 'asset.id', 'invalid_asset');
    if (assetIds.has(asset.id)) {
      throw new RuntimeAssetsPublishVerificationError(`duplicate runtime asset id: ${asset.id}`, {
        code: 'duplicate_asset_id',
        details: asset.id,
      });
    }
    assetIds.add(asset.id);
    assertNonEmptyString(asset.archiveFile, `runtime asset ${asset.id} archiveFile`, 'invalid_asset_archive_url');
    if (typeof asset.archiveSha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(asset.archiveSha256)) {
      throw new RuntimeAssetsPublishVerificationError(`runtime asset ${asset.id} archiveSha256 is invalid`, {
        code: 'invalid_asset_archive_sha256',
        details: asset,
      });
    }
    if (typeof asset.expandedSha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(asset.expandedSha256)) {
      throw new RuntimeAssetsPublishVerificationError(`runtime asset ${asset.id} expandedSha256 is invalid`, {
        code: 'invalid_asset_expanded_sha256',
        details: asset,
      });
    }
    if (!Number.isFinite(asset.archiveBytes) || asset.archiveBytes <= 0) {
      throw new RuntimeAssetsPublishVerificationError(`runtime asset ${asset.id} archiveBytes must be positive`, {
        code: 'invalid_asset_archive_bytes',
        details: asset,
      });
    }
  }
  if (options.expectedAssetIds?.length) {
    const expected = [...options.expectedAssetIds].sort();
    const actual = [...assetIds].sort();
    if (expected.length !== actual.length || expected.some((id, index) => id !== actual[index])) {
      throw new RuntimeAssetsPublishVerificationError(
        `runtime assets manifest ids mismatch: expected ${expected.join(',')}, got ${actual.join(',')}`,
        { code: 'asset_ids_mismatch', details: { expected, actual } },
      );
    }
  }
  return payload;
}

export async function verifyRuntimeAssetsPublish({
  manifestUrl,
  manifestSha256Url,
  fetchImpl = fetch,
  publicKeys = getControlPlanePublicKeysFromEnv(),
  expectedVersion,
  expectedPlatform,
  expectedAssetIds,
  minAssets = 1,
  now,
} = {}) {
  if (!manifestUrl || !manifestSha256Url) {
    throw new RuntimeAssetsPublishVerificationError('manifestUrl and manifestSha256Url are required', {
      code: 'missing_runtime_assets_source',
    });
  }
  if (!publicKeys || Object.keys(publicKeys).length === 0) {
    throw new RuntimeAssetsPublishVerificationError('control-plane public keys are required', {
      code: 'missing_public_keys',
    });
  }

  const [manifestText, shaText] = await Promise.all([
    fetchText(fetchImpl, manifestUrl),
    fetchText(fetchImpl, manifestSha256Url),
  ]);
  const expectedManifestSha = extractSha256(shaText);
  if (!expectedManifestSha) {
    throw new RuntimeAssetsPublishVerificationError('runtime assets sha256 file does not contain a sha256 digest', {
      code: 'invalid_manifest_sha256_file',
      endpoint: manifestSha256Url,
      details: shaText.slice(0, 500),
    });
  }
  const actualManifestSha = sha256Hex(Buffer.from(manifestText));
  if (actualManifestSha !== expectedManifestSha) {
    throw new RuntimeAssetsPublishVerificationError('runtime assets manifest sha256 does not match .sha256 file', {
      code: 'manifest_hash_mismatch',
      details: { expected: expectedManifestSha, actual: actualManifestSha },
    });
  }

  let envelope;
  try {
    envelope = JSON.parse(manifestText);
  } catch {
    throw new RuntimeAssetsPublishVerificationError('runtime assets manifest is not valid JSON', {
      code: 'invalid_manifest_json',
      endpoint: manifestUrl,
      details: manifestText.slice(0, 500),
    });
  }
  const trust = verifyControlPlaneEnvelope(envelope, {
    kind: 'runtime_assets_manifest',
    publicKeys,
    ...(now !== undefined ? { now } : {}),
  });
  if (!trust.trusted || !trust.payload) {
    throw new RuntimeAssetsPublishVerificationError(
      `runtime assets manifest envelope failed verification: ${trust.diagnostics.map((entry) => entry.code).join(', ')}`,
      {
        code: 'untrusted_manifest',
        endpoint: manifestUrl,
        details: trust.diagnostics,
      },
    );
  }

  const manifest = assertRuntimeAssetManifest(trust.payload, {
    expectedVersion,
    expectedPlatform,
    expectedAssetIds,
    minAssets,
  });
  const assets = [];
  for (const asset of manifest.assets) {
    const archiveUrl = new URL(asset.archiveFile, manifestUrl).toString();
    const archiveBytes = await fetchBytes(fetchImpl, archiveUrl);
    const actualArchiveSha = sha256Hex(archiveBytes);
    if (actualArchiveSha !== asset.archiveSha256.toLowerCase()) {
      throw new RuntimeAssetsPublishVerificationError(`runtime asset ${asset.id} archive hash mismatch`, {
        code: 'archive_hash_mismatch',
        endpoint: archiveUrl,
        details: { assetId: asset.id, expected: asset.archiveSha256, actual: actualArchiveSha },
      });
    }
    if (typeof asset.archiveBytes === 'number' && asset.archiveBytes !== archiveBytes.byteLength) {
      throw new RuntimeAssetsPublishVerificationError(`runtime asset ${asset.id} archive size mismatch`, {
        code: 'archive_size_mismatch',
        endpoint: archiveUrl,
        details: { assetId: asset.id, expected: asset.archiveBytes, actual: archiveBytes.byteLength },
      });
    }
    assets.push({
      id: asset.id,
      archiveUrl,
      archiveBytes: archiveBytes.byteLength,
      archiveSha256: asset.archiveSha256,
    });
  }

  return {
    manifestUrl,
    manifestSha256Url,
    manifestSha256: expectedManifestSha,
    appVersion: manifest.appVersion,
    platform: manifest.platform,
    assetCount: assets.length,
    assets,
    keyId: trust.keyId,
    expiresAt: trust.expiresAt,
  };
}

function usage() {
  return [
    'Usage: npx tsx scripts/verify-runtime-assets-publish.mjs --manifest-url <url> --manifest-sha256-url <url> [--expected-version <version>]',
    '',
    'Options:',
    '  --expected-platform <platform>  Require manifest.platform to match, e.g. darwin-arm64',
    '  --min-assets <n>               Require manifest.assets.length >= n (default: 1)',
    '  --expected-assets <ids>         Require exact comma-separated asset ids',
  ].join('\n');
}

async function main() {
  const args = process.argv.slice(2);
  if (hasFlag(args, '--help') || hasFlag(args, '-h')) {
    console.log(usage());
    return;
  }
  const summary = await verifyRuntimeAssetsPublish({
    manifestUrl: readArg(args, '--manifest-url'),
    manifestSha256Url: readArg(args, '--manifest-sha256-url'),
    expectedVersion: readArg(args, '--expected-version'),
    expectedPlatform: readArg(args, '--expected-platform'),
    minAssets: Number(readArg(args, '--min-assets') ?? 1),
    expectedAssetIds: (readArg(args, '--expected-assets') ?? '').split(',').map((value) => value.trim()).filter(Boolean),
  });
  console.log('[verify-runtime-assets-publish] passed');
  console.log(JSON.stringify(summary, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    if (error instanceof RuntimeAssetsPublishVerificationError) {
      console.error(`[verify-runtime-assets-publish] ${error.message}`);
      if (error.details !== undefined) {
        console.error(JSON.stringify(error.details, null, 2));
      }
      process.exitCode = 1;
      return;
    }
    console.error(error);
    process.exitCode = 1;
  });
}
