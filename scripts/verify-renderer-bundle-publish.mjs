#!/usr/bin/env node
import { Buffer } from 'node:buffer';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import process from 'node:process';
import { pathToFileURL, URL } from 'node:url';
import nodeFetch from 'node-fetch';
import {
  getControlPlanePublicKeysFromEnv,
  verifyControlPlaneEnvelope,
} from '../src/main/services/cloud/controlPlaneTrust.ts';
import { getShellCapabilityIds } from '../src/main/shellCapabilities.ts';
import { missingShellCapabilities } from '../src/shared/contract/shellCapabilities.ts';

export const DEFAULT_MIN_MANIFEST_VALIDITY_SECONDS = 7 * 24 * 60 * 60;

export class RendererBundlePublishVerificationError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'RendererBundlePublishVerificationError';
    this.code = options.code ?? 'renderer_bundle_publish_verification_failed';
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

function assertNonEmptyString(value, field) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new RendererBundlePublishVerificationError(`${field} is required`, {
      code: 'invalid_manifest',
      details: { field },
    });
  }
}

function sha256Hex(bytes) {
  return crypto.createHash('sha256').update(Buffer.from(bytes)).digest('hex');
}

function sortedStringArray(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((entry) => typeof entry === 'string' && entry.trim().length > 0))]
    .sort((left, right) => left.localeCompare(right));
}

function assertOptionalStringArray(value, field, code) {
  if (value === undefined) return;
  if (
    !Array.isArray(value) ||
    !value.every((entry) => typeof entry === 'string' && entry.trim().length > 0)
  ) {
    throw new RendererBundlePublishVerificationError(`${field} must be a string array`, {
      code,
      details: value,
    });
  }
}

function requireEqual(actual, expected, field) {
  if (actual !== expected) {
    throw new RendererBundlePublishVerificationError(`release record ${field} does not match renderer manifest`, {
      code: 'release_record_mismatch',
      details: { field, expected, actual },
    });
  }
}

function normalizeOptionalString(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizePemLiteral(value) {
  return value.trim().replace(/\\n/g, '\n');
}

function parsePublicKeysJson(raw, source) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new RendererBundlePublishVerificationError(`${source} must be valid JSON`, {
      code: 'invalid_public_keys',
    });
  }
  const keysSource = parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.keys
    ? parsed.keys
    : parsed;
  if (!keysSource || typeof keysSource !== 'object' || Array.isArray(keysSource)) {
    throw new RendererBundlePublishVerificationError(`${source} must be a public key map`, {
      code: 'invalid_public_keys',
    });
  }
  const publicKeys = Object.fromEntries(
    Object.entries(keysSource)
      .filter((entry) => (
        typeof entry[0] === 'string' &&
        entry[0].trim().length > 0 &&
        typeof entry[1] === 'string' &&
        entry[1].trim().length > 0
      ))
      .map(([keyId, publicKey]) => [keyId, normalizePemLiteral(publicKey)]),
  );
  if (Object.keys(publicKeys).length === 0) {
    throw new RendererBundlePublishVerificationError(`${source} must contain at least one public key`, {
      code: 'invalid_public_keys',
    });
  }
  return publicKeys;
}

export async function readPublicKeysFromArgs(args) {
  const publicKeysJson = normalizeOptionalString(readArg(args, '--public-keys-json'));
  const publicKeysFile = normalizeOptionalString(readArg(args, '--public-keys-file'));
  const publicKeyId = normalizeOptionalString(readArg(args, '--public-key-id'));
  const publicKey = normalizeOptionalString(readArg(args, '--public-key'));

  const configuredSources = [
    publicKeysJson ? '--public-keys-json' : null,
    publicKeysFile ? '--public-keys-file' : null,
    publicKeyId || publicKey ? '--public-key-id/--public-key' : null,
  ].filter(Boolean);
  if (configuredSources.length > 1) {
    throw new RendererBundlePublishVerificationError(
      `Only one public key source may be provided: ${configuredSources.join(', ')}`,
      { code: 'invalid_args' },
    );
  }
  if (publicKeysJson) {
    return parsePublicKeysJson(publicKeysJson, '--public-keys-json');
  }
  if (publicKeysFile) {
    let content;
    try {
      content = await fs.readFile(publicKeysFile, 'utf8');
    } catch (error) {
      throw new RendererBundlePublishVerificationError(
        `Unable to read --public-keys-file: ${publicKeysFile}`,
        {
          code: 'invalid_public_keys_file',
          details: error instanceof Error ? error.message : String(error),
        },
      );
    }
    return parsePublicKeysJson(content, '--public-keys-file');
  }
  if (publicKeyId || publicKey) {
    if (!publicKeyId || !publicKey) {
      throw new RendererBundlePublishVerificationError(
        '--public-key-id and --public-key must be provided together',
        { code: 'invalid_args' },
      );
    }
    return { [publicKeyId]: normalizePemLiteral(publicKey) };
  }
  return undefined;
}

function normalizeOptionalPercent(value) {
  const normalized = normalizeOptionalString(value);
  if (!normalized) return undefined;
  const percent = Number(normalized);
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
    throw new RendererBundlePublishVerificationError('expected rollout percent must be a number between 0 and 100', {
      code: 'invalid_expected_rollout_percent',
      details: value,
    });
  }
  return percent;
}

function normalizeNonNegativeInteger(value, field) {
  const numberValue = Number(value);
  if (!Number.isInteger(numberValue) || numberValue < 0) {
    throw new RendererBundlePublishVerificationError(`${field} must be a non-negative integer`, {
      code: 'invalid_args',
      details: { field, value },
    });
  }
  return numberValue;
}

function normalizeNowMs(now) {
  if (now instanceof Date) return now.getTime();
  if (now !== undefined) return Number(now);
  return Date.now();
}

function assertManifestValidityWindow(expiresAt, {
  now,
  minManifestValiditySeconds = DEFAULT_MIN_MANIFEST_VALIDITY_SECONDS,
} = {}) {
  const minSeconds = normalizeNonNegativeInteger(minManifestValiditySeconds, 'minManifestValiditySeconds');
  if (minSeconds === 0) return;
  const expiresAtMs = Date.parse(expiresAt);
  const nowMs = normalizeNowMs(now);
  const remainingSeconds = Math.floor((expiresAtMs - nowMs) / 1000);
  if (!Number.isFinite(expiresAtMs) || !Number.isFinite(nowMs) || remainingSeconds < minSeconds) {
    throw new RendererBundlePublishVerificationError(
      `renderer bundle manifest expires too soon: ${expiresAt}`,
      {
        code: 'manifest_expires_too_soon',
        details: {
          expiresAt,
          remainingSeconds,
          minManifestValiditySeconds: minSeconds,
        },
      },
    );
  }
}

function validateManifestPayload(payload, options = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new RendererBundlePublishVerificationError('renderer bundle manifest payload must be an object', {
      code: 'invalid_manifest',
      details: payload,
    });
  }
  assertNonEmptyString(payload.version, 'payload.version');
  assertNonEmptyString(payload.minShellVersion, 'payload.minShellVersion');
  if (payload.rollbackToBuiltin !== undefined && typeof payload.rollbackToBuiltin !== 'boolean') {
    throw new RendererBundlePublishVerificationError('payload.rollbackToBuiltin must be boolean when provided', {
      code: 'invalid_rollback_manifest',
      details: payload.rollbackToBuiltin,
    });
  }
  if (payload.rollbackReason !== undefined && typeof payload.rollbackReason !== 'string') {
    throw new RendererBundlePublishVerificationError('payload.rollbackReason must be a string when provided', {
      code: 'invalid_rollback_manifest',
      details: payload.rollbackReason,
    });
  }
  if (!payload.rollbackToBuiltin) {
    assertNonEmptyString(payload.contentHash, 'payload.contentHash');
    assertNonEmptyString(payload.bundleUrl, 'payload.bundleUrl');
    if (!/^[a-f0-9]{64}$/i.test(payload.contentHash)) {
      throw new RendererBundlePublishVerificationError('payload.contentHash must be a 64-char sha256 hex digest', {
        code: 'invalid_manifest_hash',
        details: payload.contentHash,
      });
    }
    try {
      const bundleUrl = new URL(payload.bundleUrl);
      if (!['http:', 'https:'].includes(bundleUrl.protocol)) {
        throw new Error('unsupported protocol');
      }
    } catch {
      throw new RendererBundlePublishVerificationError(`payload.bundleUrl is not a valid HTTP URL: ${payload.bundleUrl}`, {
        code: 'invalid_bundle_url',
        details: payload.bundleUrl,
      });
    }
  }
  assertOptionalStringArray(
    payload.requiredShellCapabilities,
    'payload.requiredShellCapabilities',
    'invalid_required_shell_capabilities',
  );
  assertOptionalStringArray(
    payload.requiredRuntimeAssets,
    'payload.requiredRuntimeAssets',
    'invalid_required_runtime_assets',
  );
  assertOptionalStringArray(
    payload.requiredResources,
    'payload.requiredResources',
    'invalid_required_resources',
  );
  if (options.expectedVersion && payload.version !== options.expectedVersion) {
    throw new RendererBundlePublishVerificationError(
      `renderer bundle version mismatch: expected ${options.expectedVersion}, got ${payload.version}`,
      {
        code: 'version_mismatch',
        details: { expected: options.expectedVersion, actual: payload.version },
      },
    );
  }
  const minRequiredShellCapabilities = options.minRequiredShellCapabilities ?? 0;
  const requiredShellCapabilities = payload.requiredShellCapabilities ?? [];
  const requiredCount = requiredShellCapabilities.length;
  if (requiredCount < minRequiredShellCapabilities) {
    throw new RendererBundlePublishVerificationError(
      `renderer bundle requires ${requiredCount} shell capabilities, expected at least ${minRequiredShellCapabilities}`,
      {
        code: 'required_shell_capabilities_too_few',
        details: { actual: requiredCount, expected: minRequiredShellCapabilities },
      },
    );
  }
  if (!options.allowUnknownShellCapabilities) {
    const supportedShellCapabilities = options.supportedShellCapabilities ?? [];
    const missingCapabilities = missingShellCapabilities(
      supportedShellCapabilities,
      requiredShellCapabilities,
    );
    if (missingCapabilities.length > 0) {
      throw new RendererBundlePublishVerificationError(
        `renderer bundle requires shell capabilities that this shell does not support: ${missingCapabilities.join(', ')}`,
        {
          code: 'unsupported_shell_capabilities',
          details: { missingShellCapabilities: missingCapabilities },
        },
      );
    }
  }
  return payload;
}

function validateReleaseRecordPayload(record, manifest, options = {}) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new RendererBundlePublishVerificationError('renderer release record must be an object', {
      code: 'invalid_release_record',
      details: record,
    });
  }
  requireEqual(record.schemaVersion, 1, 'schemaVersion');
  requireEqual(record.kind, 'renderer_bundle_release_record', 'kind');
  if (options.expectedReleaseChannel) {
    requireEqual(record.channel, options.expectedReleaseChannel, 'channel');
    requireEqual(record.rollout?.channel ?? record.channel, options.expectedReleaseChannel, 'rollout.channel');
  }
  if (options.expectedCohort) {
    requireEqual(record.rollout?.cohort, options.expectedCohort, 'rollout.cohort');
  }
  if (options.expectedRolloutPercent !== undefined) {
    requireEqual(Number(record.rollout?.percent), options.expectedRolloutPercent, 'rollout.percent');
  }
  requireEqual(record.version, manifest.version, 'version');
  requireEqual(record.minShellVersion, manifest.minShellVersion, 'minShellVersion');
  requireEqual(record.rollbackToBuiltin === true, manifest.rollbackToBuiltin === true, 'rollbackToBuiltin');
  if (manifest.rollbackReason !== undefined) {
    requireEqual(record.rollbackReason, manifest.rollbackReason, 'rollbackReason');
  }

  if (manifest.rollbackToBuiltin) {
    if (record.contentHash !== undefined || record.bundleUrl !== undefined) {
      throw new RendererBundlePublishVerificationError('rollback release record must not include bundle fields', {
        code: 'invalid_release_record',
        details: { contentHash: record.contentHash, bundleUrl: record.bundleUrl },
      });
    }
    const urls = record.urls && typeof record.urls === 'object' && !Array.isArray(record.urls)
      ? record.urls
      : {};
    if (
      (Object.prototype.hasOwnProperty.call(urls, 'latestBundle') && urls.latestBundle !== null) ||
      (Object.prototype.hasOwnProperty.call(urls, 'snapshotBundle') && urls.snapshotBundle !== null)
    ) {
      throw new RendererBundlePublishVerificationError('rollback release record bundle URLs must be null', {
        code: 'invalid_release_record',
        details: urls,
      });
    }
  } else {
    requireEqual(record.contentHash, manifest.contentHash, 'contentHash');
    requireEqual(record.bundleUrl, manifest.bundleUrl, 'bundleUrl');
  }

  const manifestCapabilities = sortedStringArray(manifest.requiredShellCapabilities);
  const recordCapabilities = sortedStringArray(record.requiredShellCapabilities);
  requireEqual(record.requiredShellCapabilitiesCount, manifestCapabilities.length, 'requiredShellCapabilitiesCount');
  const sameCapabilities = manifestCapabilities.length === recordCapabilities.length
    && manifestCapabilities.every((capability, index) => capability === recordCapabilities[index]);
  if (!sameCapabilities) {
    throw new RendererBundlePublishVerificationError('release record requiredShellCapabilities do not match renderer manifest', {
      code: 'release_record_mismatch',
      details: {
        expected: manifestCapabilities,
        actual: recordCapabilities,
      },
    });
  }
  const manifestRuntimeAssets = sortedStringArray(manifest.requiredRuntimeAssets);
  const recordRuntimeAssets = sortedStringArray(record.requiredRuntimeAssets);
  requireEqual(record.requiredRuntimeAssetsCount ?? 0, manifestRuntimeAssets.length, 'requiredRuntimeAssetsCount');
  const sameRuntimeAssets = manifestRuntimeAssets.length === recordRuntimeAssets.length
    && manifestRuntimeAssets.every((asset, index) => asset === recordRuntimeAssets[index]);
  if (!sameRuntimeAssets) {
    throw new RendererBundlePublishVerificationError('release record requiredRuntimeAssets do not match renderer manifest', {
      code: 'release_record_mismatch',
      details: {
        expected: manifestRuntimeAssets,
        actual: recordRuntimeAssets,
      },
    });
  }
  const manifestResources = sortedStringArray(manifest.requiredResources);
  const recordResources = sortedStringArray(record.requiredResources);
  requireEqual(record.requiredResourcesCount ?? 0, manifestResources.length, 'requiredResourcesCount');
  const sameResources = manifestResources.length === recordResources.length
    && manifestResources.every((resource, index) => resource === recordResources[index]);
  if (!sameResources) {
    throw new RendererBundlePublishVerificationError('release record requiredResources do not match renderer manifest', {
      code: 'release_record_mismatch',
      details: {
        expected: manifestResources,
        actual: recordResources,
      },
    });
  }
  return record;
}

async function readJsonFromPath(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

async function fetchJson(fetchImpl, url) {
  const response = await fetchImpl(url, { headers: { Accept: 'application/json' } });
  const text = await response.text();
  if (!response.ok) {
    throw new RendererBundlePublishVerificationError(`manifest returned HTTP ${response.status}`, {
      code: 'manifest_http_status',
      endpoint: url,
      status: response.status,
      details: text.slice(0, 500),
    });
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new RendererBundlePublishVerificationError('manifest response is not valid JSON', {
      code: 'invalid_manifest_json',
      endpoint: url,
      details: text.slice(0, 500),
    });
  }
}

async function readBytesFromPath(filePath) {
  return fs.readFile(filePath);
}

async function fetchBytes(fetchImpl, url) {
  const response = await fetchImpl(url);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!response.ok) {
    throw new RendererBundlePublishVerificationError(`bundle returned HTTP ${response.status}`, {
      code: 'bundle_http_status',
      endpoint: url,
      status: response.status,
      details: Buffer.from(bytes).toString('utf8').slice(0, 500),
    });
  }
  if (bytes.byteLength === 0) {
    throw new RendererBundlePublishVerificationError('bundle is empty', {
      code: 'empty_bundle',
      endpoint: url,
    });
  }
  return bytes;
}

export async function verifyRendererBundlePublish({
  manifestUrl,
  manifestPath,
  bundlePath,
  releaseRecordUrl,
  releaseRecordPath,
  fetchImpl = nodeFetch,
  publicKeys = getControlPlanePublicKeysFromEnv(),
  expectedVersion,
  minRequiredShellCapabilities = 0,
  supportedShellCapabilities = getShellCapabilityIds(),
  allowUnknownShellCapabilities = false,
  expectedReleaseChannel,
  expectedCohort,
  expectedRolloutPercent,
  minManifestValiditySeconds = DEFAULT_MIN_MANIFEST_VALIDITY_SECONDS,
  now,
} = {}) {
  if (!manifestUrl && !manifestPath) {
    throw new RendererBundlePublishVerificationError('manifestUrl or manifestPath is required', {
      code: 'missing_manifest_source',
    });
  }
  if (releaseRecordUrl && releaseRecordPath) {
    throw new RendererBundlePublishVerificationError('releaseRecordUrl and releaseRecordPath cannot both be provided', {
      code: 'duplicate_release_record_source',
    });
  }
  if (!publicKeys || Object.keys(publicKeys).length === 0) {
    throw new RendererBundlePublishVerificationError('control-plane public keys are required', {
      code: 'missing_public_keys',
    });
  }

  const envelope = manifestPath
    ? await readJsonFromPath(manifestPath)
    : await fetchJson(fetchImpl, manifestUrl);
  const trust = verifyControlPlaneEnvelope(envelope, {
    kind: 'renderer_bundle',
    publicKeys,
    ...(now !== undefined ? { now } : {}),
  });
  if (!trust.trusted || !trust.payload) {
    throw new RendererBundlePublishVerificationError(
      `renderer bundle manifest envelope failed verification: ${trust.diagnostics.map((entry) => entry.code).join(', ')}`,
      {
        code: 'untrusted_manifest',
        endpoint: manifestUrl,
        details: trust.diagnostics,
      },
    );
  }
  assertManifestValidityWindow(trust.expiresAt, {
    now,
    minManifestValiditySeconds,
  });

  const manifest = validateManifestPayload(trust.payload, {
    expectedVersion,
    minRequiredShellCapabilities,
    supportedShellCapabilities,
    allowUnknownShellCapabilities,
  });
  let bundleBytes = new Uint8Array();
  if (!manifest.rollbackToBuiltin) {
    bundleBytes = bundlePath
      ? await readBytesFromPath(bundlePath)
      : await fetchBytes(fetchImpl, manifest.bundleUrl);
    const actualHash = sha256Hex(bundleBytes);
    if (actualHash !== manifest.contentHash.toLowerCase()) {
      throw new RendererBundlePublishVerificationError('bundle sha256 does not match manifest.contentHash', {
        code: 'bundle_hash_mismatch',
        endpoint: bundlePath ?? manifest.bundleUrl,
        details: { expected: manifest.contentHash, actual: actualHash },
      });
    }
  }
  const releaseRecordOptions = {
    expectedReleaseChannel: normalizeOptionalString(expectedReleaseChannel),
    expectedCohort: normalizeOptionalString(expectedCohort),
    expectedRolloutPercent: normalizeOptionalPercent(expectedRolloutPercent),
  };
  const releaseRecord = releaseRecordPath
    ? validateReleaseRecordPayload(await readJsonFromPath(releaseRecordPath), manifest, releaseRecordOptions)
    : releaseRecordUrl
      ? validateReleaseRecordPayload(await fetchJson(fetchImpl, releaseRecordUrl), manifest, releaseRecordOptions)
      : null;

  return {
    manifestUrl: manifestUrl ?? manifestPath,
    bundleUrl: manifest.rollbackToBuiltin ? null : (bundlePath ?? manifest.bundleUrl),
    version: manifest.version,
    minShellVersion: manifest.minShellVersion,
    contentHash: manifest.contentHash ?? null,
    rollbackToBuiltin: manifest.rollbackToBuiltin === true,
    rollbackReason: manifest.rollbackReason,
    bundleBytes: bundleBytes.byteLength,
    requiredShellCapabilitiesCount: sortedStringArray(manifest.requiredShellCapabilities).length,
    requiredRuntimeAssetsCount: sortedStringArray(manifest.requiredRuntimeAssets).length,
    requiredResourcesCount: sortedStringArray(manifest.requiredResources).length,
    releaseRecordUrl: releaseRecordUrl ?? releaseRecordPath ?? null,
    releaseRecordVerified: Boolean(releaseRecord),
    keyId: trust.keyId,
    expiresAt: trust.expiresAt,
  };
}

function usage() {
  return [
    'Usage: npx tsx scripts/verify-renderer-bundle-publish.mjs --manifest-url <url> [--expected-version <version>]',
    '       npx tsx scripts/verify-renderer-bundle-publish.mjs --manifest-path <file> --bundle-path <file> [--expected-version <version>]',
    '',
    'Options:',
    '  --min-required-shell-capabilities <n>  Require manifest.requiredShellCapabilities.length >= n',
    '  --allow-empty-required-shell-capabilities  Same as --min-required-shell-capabilities 0',
    '  --allow-unknown-shell-capabilities  Skip current-shell support validation',
    '  --min-manifest-validity-seconds <n>  Require signed manifest to remain valid for at least n seconds; default 604800',
    '  --allow-short-manifest-validity  Disable minimum remaining validity check',
    '  --public-keys-file <file>  Control-plane public keys JSON file',
    '  --public-keys-json <json>  Control-plane public keys JSON map',
    '  --public-key-id <id> --public-key <pem>  Single control-plane public key',
    '  --release-record-url <url>  Verify published renderer release-record.json against the manifest',
    '  --release-record-path <file>  Verify a local renderer release-record.json against the manifest',
    '  Verifies requiredRuntimeAssets / requiredResources counts and lists when release-record is provided',
    '  --expected-release-channel <channel>  Require release-record channel metadata',
    '  --expected-cohort <cohort>  Require release-record rollout.cohort',
    '  --expected-rollout-percent <0-100>  Require release-record rollout.percent',
  ].join('\n');
}

async function main() {
  const args = process.argv.slice(2);
  if (hasFlag(args, '--help') || hasFlag(args, '-h')) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const minRequiredShellCapabilities = hasFlag(args, '--allow-empty-required-shell-capabilities')
    ? 0
    : Number(readArg(args, '--min-required-shell-capabilities') ?? 0);
  const minManifestValiditySeconds = hasFlag(args, '--allow-short-manifest-validity')
    ? 0
    : normalizeNonNegativeInteger(
      readArg(args, '--min-manifest-validity-seconds') ?? DEFAULT_MIN_MANIFEST_VALIDITY_SECONDS,
      'minManifestValiditySeconds',
    );
  const summary = await verifyRendererBundlePublish({
    manifestUrl: readArg(args, '--manifest-url'),
    manifestPath: readArg(args, '--manifest-path'),
    bundlePath: readArg(args, '--bundle-path'),
    releaseRecordUrl: readArg(args, '--release-record-url'),
    releaseRecordPath: readArg(args, '--release-record-path'),
    expectedVersion: readArg(args, '--expected-version'),
    minRequiredShellCapabilities,
    allowUnknownShellCapabilities: hasFlag(args, '--allow-unknown-shell-capabilities'),
    expectedReleaseChannel: readArg(args, '--expected-release-channel'),
    expectedCohort: readArg(args, '--expected-cohort'),
    expectedRolloutPercent: readArg(args, '--expected-rollout-percent'),
    minManifestValiditySeconds,
    publicKeys: await readPublicKeysFromArgs(args),
  });
  process.stdout.write('[verify-renderer-bundle-publish] passed\n');
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    if (error instanceof RendererBundlePublishVerificationError) {
      process.stderr.write(`[verify-renderer-bundle-publish] ${error.message}\n`);
      if (error.details !== undefined) {
        process.stderr.write(`${JSON.stringify(error.details, null, 2)}\n`);
      }
      process.exitCode = 1;
      return;
    }
    process.stderr.write(`${error.stack ?? error}\n`);
    process.exitCode = 1;
  });
}
