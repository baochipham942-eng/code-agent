#!/usr/bin/env node
import process from 'node:process';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import {
  PRODUCTION_CLOUD_API_URL,
  RENDERER_BUNDLE_CHANNEL_ENV,
  RENDERER_BUNDLE_MANIFEST_URL_ENV,
  resolveRendererBundleEndpoint,
} from '../src/shared/constants/network.ts';
import {
  CONTROL_PLANE_ARTIFACTS,
  runControlPlaneSmoke,
} from './control-plane-smoke.mjs';
import {
  DEFAULT_MIN_MANIFEST_VALIDITY_SECONDS,
  RendererBundlePublishVerificationError,
  verifyRendererBundlePublish,
} from './verify-renderer-bundle-publish.mjs';

export class RendererHotUpdateProductionVerificationError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'RendererHotUpdateProductionVerificationError';
    this.code = options.code ?? 'renderer_hot_update_production_verification_failed';
    this.failures = options.failures;
    this.details = options.details;
  }
}

export const RENDERER_HOT_UPDATE_CONTROL_PLANE_ARTIFACTS = CONTROL_PLANE_ARTIFACTS.filter(
  (artifact) => artifact.expectedKind === 'renderer_bundle_rollout',
);

function hasFlag(args, name) {
  return args.includes(name);
}

function readArg(args, names) {
  const aliases = Array.isArray(names) ? names : [names];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    for (const name of aliases) {
      if (arg === name) {
        return args[index + 1];
      }
      if (arg.startsWith(`${name}=`)) {
        return arg.slice(name.length + 1);
      }
    }
  }
  return undefined;
}

function normalizeOptionalString(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function firstString(...values) {
  for (const value of values) {
    const normalized = normalizeOptionalString(value);
    if (normalized) return normalized;
  }
  return undefined;
}

function normalizePemLiteral(value) {
  return value.trim().replace(/\\n/g, '\n');
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sha256Hex(bytes) {
  return crypto.createHash('sha256').update(Buffer.from(bytes)).digest('hex');
}

function normalizeVersionForMatch(value) {
  return normalizeOptionalString(value)?.replace(/^v/, '');
}

function expectedStringMatchSummary(actual, expected) {
  const normalizedExpected = normalizeOptionalString(expected);
  if (!normalizedExpected) return {};
  const normalizedActual = normalizeOptionalString(actual);
  return {
    expected: normalizedExpected,
    matchesExpected: normalizedActual === normalizedExpected,
  };
}

function expectedVersionMatchSummary(actual, expected) {
  const normalizedExpected = normalizeVersionForMatch(expected);
  if (!normalizedExpected) return {};
  const normalizedActual = normalizeVersionForMatch(actual);
  return {
    expected: normalizedExpected,
    matchesExpected: normalizedActual === normalizedExpected,
  };
}

function buildAppUpdateSnapshotUrl(baseUrl) {
  const url = new URL('/api/update', baseUrl);
  url.searchParams.set('action', 'check');
  url.searchParams.set('version', '0.0.0');
  url.searchParams.set('platform', 'darwin');
  url.searchParams.set('channel', 'stable');
  return url.toString();
}

async function fetchAppUpdateSnapshot(fetchImpl, appUpdateUrl, rendererManifestVersion) {
  const response = await fetchJsonSnapshot(fetchImpl, appUpdateUrl);
  return summarizeAppUpdateSnapshot({
    url: appUpdateUrl,
    response,
    rendererManifestVersion,
  });
}

function summarizeAppUpdateSnapshot({
  url,
  response,
  rendererManifestVersion,
}) {
  const summary = {
    url,
    ok: response.ok,
    status: response.status,
    contentType: response.contentType,
    ...(response.textSample ? { textSample: response.textSample } : {}),
  };
  if (!isRecord(response.body)) {
    return summary;
  }
  const latestVersion = normalizeVersionForMatch(response.body.latestVersion);
  const rendererVersion = normalizeVersionForMatch(rendererManifestVersion);
  return {
    ...summary,
    success: response.body.success,
    hasUpdate: response.body.hasUpdate,
    forceUpdate: response.body.forceUpdate,
    currentVersion: normalizeVersionForMatch(response.body.currentVersion),
    latestVersion,
    channel: normalizeOptionalString(response.body.channel),
    source: normalizeOptionalString(response.body.source),
    publishedAt: normalizeOptionalString(response.body.publishedAt),
    ...(latestVersion && rendererVersion
      ? {
        rendererManifestExpectation: {
          version: rendererVersion,
          matchesLatestVersion: rendererVersion === latestVersion,
        },
      }
      : {}),
  };
}

function latestVersionFromAppUpdateSnapshot(snapshot) {
  return normalizeVersionForMatch(snapshot?.latestVersion);
}

async function resolveExpectedVersionFromAppUpdate({
  fetchImpl,
  appUpdateUrl,
  explicitExpectedVersion,
}) {
  const snapshot = await fetchAppUpdateSnapshot(fetchImpl, appUpdateUrl);
  const latestVersion = latestVersionFromAppUpdateSnapshot(snapshot);
  if (!snapshot.ok) {
    throw new RendererHotUpdateProductionVerificationError(
      `app update metadata returned HTTP ${snapshot.status}`,
      {
        code: 'app_update_http_status',
        details: snapshot,
      },
    );
  }
  if (!latestVersion) {
    throw new RendererHotUpdateProductionVerificationError(
      'app update metadata did not include latestVersion',
      {
        code: 'missing_app_update_latest_version',
        details: snapshot,
      },
    );
  }

  const normalizedExpected = normalizeVersionForMatch(explicitExpectedVersion);
  if (normalizedExpected && normalizedExpected !== latestVersion) {
    throw new RendererHotUpdateProductionVerificationError(
      `app update latestVersion ${latestVersion} does not match expected version ${normalizedExpected}`,
      {
        code: 'app_update_expected_version_mismatch',
        details: {
          expectedVersion: normalizedExpected,
          latestVersion,
          appUpdate: snapshot,
        },
      },
    );
  }

  return {
    expectedVersion: latestVersion,
    snapshot,
  };
}

function summarizeBundleManifestEnvelope(envelope, {
  now = Date.now(),
  expectedVersion,
} = {}) {
  if (!isRecord(envelope)) {
    return {
      present: false,
      reason: 'manifest-not-object',
    };
  }
  const payload = isRecord(envelope.payload) ? envelope.payload : {};
  const payloadVersion = normalizeOptionalString(payload.version);
  const expiresAt = normalizeOptionalString(envelope.expiresAt);
  const expiresAtMs = expiresAt ? Date.parse(expiresAt) : NaN;
  const requiredShellCapabilities = Array.isArray(payload.requiredShellCapabilities)
    ? payload.requiredShellCapabilities
    : [];
  const requiredRuntimeAssets = Array.isArray(payload.requiredRuntimeAssets)
    ? payload.requiredRuntimeAssets
    : [];
  const requiredResources = Array.isArray(payload.requiredResources)
    ? payload.requiredResources
    : [];
  return {
    present: true,
    schemaVersion: envelope.schemaVersion,
    kind: envelope.kind,
    keyId: normalizeOptionalString(envelope.keyId),
    issuedAt: normalizeOptionalString(envelope.issuedAt),
    expiresAt,
    expired: Number.isFinite(expiresAtMs) ? expiresAtMs <= now : undefined,
    contentHash: normalizeOptionalString(envelope.contentHash),
    payload: {
      version: payloadVersion,
      ...expectedVersionMatchSummary(payloadVersion, expectedVersion),
      minShellVersion: normalizeOptionalString(payload.minShellVersion),
      contentHash: normalizeOptionalString(payload.contentHash),
      bundleUrl: normalizeOptionalString(payload.bundleUrl),
      rollbackToBuiltin: payload.rollbackToBuiltin === true,
      requiredShellCapabilitiesCount: requiredShellCapabilities.length,
      requiredRuntimeAssetsCount: requiredRuntimeAssets.length,
      requiredResourcesCount: requiredResources.length,
    },
  };
}

async function fetchText(fetchImpl, url) {
  const response = await fetchImpl(url, {
    method: 'GET',
    headers: { Accept: 'application/json' },
  });
  const text = await response.text();
  return {
    ok: response.ok,
    status: response.status,
    text,
    contentType: response.headers?.get?.('content-type') ?? undefined,
  };
}

async function fetchJsonSnapshot(fetchImpl, url) {
  const response = await fetchText(fetchImpl, url);
  if (!response.text.trim()) {
    return {
      ok: response.ok,
      status: response.status,
      contentType: response.contentType,
      body: undefined,
    };
  }
  try {
    return {
      ok: response.ok,
      status: response.status,
      contentType: response.contentType,
      body: JSON.parse(response.text),
    };
  } catch {
    return {
      ok: response.ok,
      status: response.status,
      contentType: response.contentType,
      body: undefined,
      textSample: response.text.slice(0, 500),
    };
  }
}

async function fetchBundleHashSnapshot(fetchImpl, bundleUrl, expectedHash) {
  const response = await fetchImpl(bundleUrl);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const actualHash = response.ok ? sha256Hex(bytes) : undefined;
  return {
    ok: response.ok,
    status: response.status,
    bytes: bytes.byteLength,
    ...(actualHash ? { sha256: actualHash } : {}),
    ...(expectedHash ? { expectedSha256: expectedHash } : {}),
    ...(actualHash && expectedHash ? { matchesManifestPayload: actualHash === expectedHash.toLowerCase() } : {}),
  };
}

export async function inspectRendererHotUpdateRemoteArtifacts({
  manifestUrl,
  releaseRecordUrl,
  appUpdateUrl,
  expectedVersion,
  expectedReleaseChannel,
  fetchImpl = globalThis.fetch,
  includeBundleHash = true,
  now = Date.now(),
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new RendererHotUpdateProductionVerificationError('fetch is not available in this Node.js runtime.', {
      code: 'missing_fetch',
    });
  }
  if (!manifestUrl) {
    throw new RendererHotUpdateProductionVerificationError('manifestUrl is required for remote artifact inspection', {
      code: 'missing_manifest_source',
    });
  }

  const manifestResponse = await fetchJsonSnapshot(fetchImpl, manifestUrl);
  const manifestSummary = {
    url: manifestUrl,
    ok: manifestResponse.ok,
    status: manifestResponse.status,
    contentType: manifestResponse.contentType,
    ...(manifestResponse.body
      ? {
        envelope: summarizeBundleManifestEnvelope(manifestResponse.body, {
          now,
          expectedVersion,
        }),
      }
      : {}),
    ...(manifestResponse.textSample ? { textSample: manifestResponse.textSample } : {}),
  };

  const releaseRecordSummary = releaseRecordUrl
    ? await (async () => {
      const response = await fetchJsonSnapshot(fetchImpl, releaseRecordUrl);
      return {
        url: releaseRecordUrl,
        ok: response.ok,
        status: response.status,
        contentType: response.contentType,
        ...(isRecord(response.body)
          ? {
            kind: response.body.kind,
            version: response.body.version,
            ...expectedVersionMatchSummary(response.body.version, expectedVersion),
            channel: response.body.channel,
            ...(normalizeOptionalString(expectedReleaseChannel)
              ? { channelExpectation: expectedStringMatchSummary(response.body.channel, expectedReleaseChannel) }
              : {}),
            rollout: response.body.rollout,
          }
          : {}),
        ...(response.textSample ? { textSample: response.textSample } : {}),
      };
    })()
    : null;

  const payload = isRecord(manifestResponse.body) && isRecord(manifestResponse.body.payload)
    ? manifestResponse.body.payload
    : {};
  const manifestVersion = normalizeOptionalString(payload.version);
  const bundleUrl = normalizeOptionalString(payload.bundleUrl);
  const rollbackToBuiltin = payload.rollbackToBuiltin === true;
  const bundleSummary = includeBundleHash && bundleUrl && !rollbackToBuiltin
    ? await fetchBundleHashSnapshot(fetchImpl, bundleUrl, normalizeOptionalString(payload.contentHash))
    : null;
  const appUpdateSummary = appUpdateUrl
    ? await fetchAppUpdateSnapshot(fetchImpl, appUpdateUrl, manifestVersion)
    : null;

  return {
    manifest: manifestSummary,
    releaseRecord: releaseRecordSummary,
    appUpdate: appUpdateSummary,
    bundle: bundleSummary ? { url: bundleUrl, ...bundleSummary } : null,
  };
}

function parsePublicKeysJson(raw, source) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new RendererHotUpdateProductionVerificationError(`${source} must be valid JSON`, {
      code: 'invalid_public_keys',
    });
  }
  const keysSource = parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.keys
    ? parsed.keys
    : parsed;
  if (!keysSource || typeof keysSource !== 'object' || Array.isArray(keysSource)) {
    throw new RendererHotUpdateProductionVerificationError(`${source} must be a public key map`, {
      code: 'invalid_public_keys',
    });
  }
  const publicKeys = Object.fromEntries(
    Object.entries(keysSource)
      .filter((entry) => (
        typeof entry[0] === 'string'
        && entry[0].trim().length > 0
        && typeof entry[1] === 'string'
        && entry[1].trim().length > 0
      ))
      .map(([keyId, publicKey]) => [keyId, normalizePemLiteral(publicKey)]),
  );
  if (Object.keys(publicKeys).length === 0) {
    throw new RendererHotUpdateProductionVerificationError(`${source} must contain at least one public key`, {
      code: 'invalid_public_keys',
    });
  }
  return publicKeys;
}

function readPublicKeysFromArgs(argv) {
  const publicKeysJson = normalizeOptionalString(readArg(argv, '--public-keys-json'));
  const publicKeysFile = normalizeOptionalString(readArg(argv, '--public-keys-file'));
  const publicKeyId = normalizeOptionalString(readArg(argv, '--public-key-id'));
  const publicKey = normalizeOptionalString(readArg(argv, '--public-key'));

  const configuredSources = [
    publicKeysJson ? '--public-keys-json' : null,
    publicKeysFile ? '--public-keys-file' : null,
    publicKeyId || publicKey ? '--public-key-id/--public-key' : null,
  ].filter(Boolean);
  if (configuredSources.length > 1) {
    throw new RendererHotUpdateProductionVerificationError(
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
      content = fs.readFileSync(publicKeysFile, 'utf8');
    } catch (error) {
      throw new RendererHotUpdateProductionVerificationError(
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
      throw new RendererHotUpdateProductionVerificationError(
        '--public-key-id and --public-key must be provided together',
        { code: 'invalid_args' },
      );
    }
    return { [publicKeyId]: normalizePemLiteral(publicKey) };
  }
  return undefined;
}

function parseMinRequiredShellCapabilities(args, env) {
  if (hasFlag(args, '--allow-empty-required-shell-capabilities')) {
    return 0;
  }
  const raw = firstString(
    readArg(args, '--min-required-shell-capabilities'),
    env.RENDERER_BUNDLE_MIN_REQUIRED_SHELL_CAPABILITIES,
  );
  if (!raw) return 1;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new RendererHotUpdateProductionVerificationError(
      '--min-required-shell-capabilities must be a non-negative integer',
      {
        code: 'invalid_args',
        details: { value: raw },
      },
    );
  }
  return value;
}

function parseMinManifestValiditySeconds(args, env) {
  if (hasFlag(args, '--allow-short-manifest-validity')) {
    return 0;
  }
  const raw = firstString(
    readArg(args, '--min-manifest-validity-seconds'),
    env.RENDERER_BUNDLE_MIN_MANIFEST_VALIDITY_SECONDS,
  );
  if (!raw) return DEFAULT_MIN_MANIFEST_VALIDITY_SECONDS;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new RendererHotUpdateProductionVerificationError(
      '--min-manifest-validity-seconds must be a non-negative integer',
      {
        code: 'invalid_args',
        details: { value: raw },
      },
    );
  }
  return value;
}

function parsePositiveIntegerArg(args, env, {
  argName,
  envNames,
  defaultValue,
}) {
  const raw = firstString(
    readArg(args, argName),
    ...envNames.map((name) => env[name]),
  );
  if (!raw) return defaultValue;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new RendererHotUpdateProductionVerificationError(
      `${argName} must be a positive integer`,
      {
        code: 'invalid_args',
        details: { value: raw },
      },
    );
  }
  return value;
}

function parseNonNegativeIntegerArg(args, env, {
  argName,
  envNames,
  defaultValue,
}) {
  const raw = firstString(
    readArg(args, argName),
    ...envNames.map((name) => env[name]),
  );
  if (!raw) return defaultValue;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new RendererHotUpdateProductionVerificationError(
      `${argName} must be a non-negative integer`,
      {
        code: 'invalid_args',
        details: { value: raw },
      },
    );
  }
  return value;
}

export function deriveRendererBundleReleaseRecordUrl(manifestUrl) {
  if (!manifestUrl) return undefined;
  try {
    const url = new URL(manifestUrl);
    if (!url.pathname.endsWith('/manifest.json')) {
      return undefined;
    }
    url.pathname = url.pathname.replace(/\/manifest\.json$/, '/release-record.json');
    return url.toString();
  } catch {
    return undefined;
  }
}

function usage() {
  return [
    'Usage: npm run renderer:verify-production -- [options]',
    '',
    'Verifies the production renderer hot-update surface:',
    '  1. Vercel control-plane signed renderer_bundle_rollout envelope',
    '  2. Published renderer manifest signature, bundle sha256, and release-record consistency',
    '',
    'Options:',
    '  --control-plane-base-url <url>       Default: CONTROL_PLANE_BASE_URL, CLOUD_API_URL, then production URL',
    '  --control-plane-token <token>        Default: CONTROL_PLANE_SMOKE_TOKEN',
    '  --release-channel <channel>          Default: latest; derives renderer-bundle/channels/<channel>/manifest.json',
    '  --manifest-url <url>                 Override renderer manifest URL',
    '  --release-record-url <url>           Override renderer release-record URL',
    '  --app-update-url <url>               Override app update metadata URL for diagnostics',
    '  --skip-release-record                Do not verify release-record.json',
    '  --expected-version <version>         Require manifest payload.version',
    '  --expected-version-from-app-update   Use stable /api/update latestVersion as expected renderer version',
    '  --expected-release-channel <channel> Require release-record channel metadata',
    '  --expected-cohort <cohort>           Require release-record rollout.cohort',
    '  --expected-rollout-percent <0-100>   Require release-record rollout.percent',
    '  --min-required-shell-capabilities <n> Default: 1',
    '  --allow-empty-required-shell-capabilities  Use for rollback manifests',
    '  --allow-unknown-shell-capabilities   Skip current-shell support validation',
    '  --min-manifest-validity-seconds <n>  Default: 604800',
    '  --allow-short-manifest-validity      Disable minimum remaining manifest validity check',
    '  --public-keys-file <file>             Control-plane public keys JSON file',
    '  --public-keys-json <json>             Control-plane public keys JSON map',
    '  --public-key-id <id> --public-key <pem>  Single control-plane public key',
    '  --include-remote-snapshot         Include unsigned remote artifact diagnostics on failure',
    '  --skip-bundle-hash-snapshot       Do not download bundle bytes for remote diagnostics',
    '  --full-control-plane-smoke           Check all control-plane artifacts, not only renderer_bundle_rollout',
    '  --skip-control-plane                 Only verify published renderer bundle',
    '  --skip-renderer-bundle               Only verify control-plane envelopes',
    '  --retry-attempts <n>                 Retry full verification up to n attempts; default: 1',
    '  --retry-delay-ms <n>                 Wait n ms between retry attempts; default: 0',
  ].join('\n');
}

export function parseRendererHotUpdateProductionArgs(argv, env = process.env) {
  if (hasFlag(argv, '--help') || hasFlag(argv, '-h')) {
    return { help: true };
  }

  const knownOptions = new Set([
    '--control-plane-base-url',
    '--cloud-base-url',
    '--base-url',
    '--control-plane-token',
    '--token',
    '--bearer-token',
    '--release-channel',
    '--channel',
    '--manifest-url',
    '--release-record-url',
    '--app-update-url',
    '--expected-version',
    '--expected-release-channel',
    '--expected-cohort',
    '--expected-rollout-percent',
    '--min-required-shell-capabilities',
    '--min-manifest-validity-seconds',
    '--retry-attempts',
    '--retry-delay-ms',
    '--public-keys-file',
    '--public-keys-json',
    '--public-key-id',
    '--public-key',
  ]);
  const valueMayStartWithDash = new Set(['--public-key']);
  const knownFlags = new Set([
    '--help',
    '-h',
    '--skip-control-plane',
    '--skip-renderer-bundle',
    '--skip-release-record',
    '--expected-version-from-app-update',
    '--allow-empty-required-shell-capabilities',
    '--allow-unknown-shell-capabilities',
    '--allow-short-manifest-validity',
    '--include-remote-snapshot',
    '--skip-bundle-hash-snapshot',
    '--full-control-plane-smoke',
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--') && arg !== '-h') {
      throw new RendererHotUpdateProductionVerificationError(`Unexpected argument: ${arg}\n${usage()}`, {
        code: 'invalid_args',
      });
    }
    const optionName = arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg;
    if (knownFlags.has(optionName)) {
      continue;
    }
    if (!knownOptions.has(optionName)) {
      throw new RendererHotUpdateProductionVerificationError(`Unknown option: ${optionName}\n${usage()}`, {
        code: 'invalid_args',
      });
    }
    if (!arg.includes('=')) {
      if (
        argv[index + 1] === undefined
        || (argv[index + 1].startsWith('--') && !valueMayStartWithDash.has(optionName))
      ) {
        throw new RendererHotUpdateProductionVerificationError(`${optionName} requires a value`, {
          code: 'invalid_args',
        });
      }
      index += 1;
    }
  }

  const skipControlPlane = hasFlag(argv, '--skip-control-plane');
  const skipRendererBundle = hasFlag(argv, '--skip-renderer-bundle');
  if (skipControlPlane && skipRendererBundle) {
    throw new RendererHotUpdateProductionVerificationError(
      '--skip-control-plane and --skip-renderer-bundle cannot both be set',
      { code: 'invalid_args' },
    );
  }

  const explicitManifestUrl = firstString(
    readArg(argv, '--manifest-url'),
    env.RENDERER_BUNDLE_MANIFEST_URL,
  );
  const releaseChannel = firstString(
    readArg(argv, ['--release-channel', '--channel']),
    env.RENDERER_BUNDLE_RELEASE_CHANNEL,
    env[RENDERER_BUNDLE_CHANNEL_ENV],
  );
  const endpointEnv = {
    ...env,
    ...(releaseChannel ? { [RENDERER_BUNDLE_CHANNEL_ENV]: releaseChannel } : {}),
    ...(explicitManifestUrl ? { [RENDERER_BUNDLE_MANIFEST_URL_ENV]: explicitManifestUrl } : {}),
  };
  const endpoint = resolveRendererBundleEndpoint(endpointEnv);
  const releaseRecordUrl = hasFlag(argv, '--skip-release-record')
    ? undefined
    : firstString(
      readArg(argv, '--release-record-url'),
      env.RENDERER_BUNDLE_RELEASE_RECORD_URL,
      deriveRendererBundleReleaseRecordUrl(endpoint.manifestUrl),
    );
  if (!hasFlag(argv, '--skip-release-record') && !skipRendererBundle && !releaseRecordUrl) {
    throw new RendererHotUpdateProductionVerificationError(
      'release-record URL is required when manifest URL does not end with /manifest.json',
      {
        code: 'missing_release_record_url',
        details: { manifestUrl: endpoint.manifestUrl },
      },
    );
  }

  const expectedReleaseChannel = firstString(
    readArg(argv, '--expected-release-channel'),
    env.RENDERER_BUNDLE_EXPECTED_RELEASE_CHANNEL,
    endpoint.manifestUrlOverride ? undefined : endpoint.channel,
  );

  const controlPlaneBaseUrl = firstString(
    readArg(argv, ['--control-plane-base-url', '--cloud-base-url', '--base-url']),
    env.CONTROL_PLANE_BASE_URL,
    env.CLOUD_API_URL,
    PRODUCTION_CLOUD_API_URL,
  );

  return {
    controlPlaneBaseUrl,
    controlPlaneToken: firstString(
      readArg(argv, ['--control-plane-token', '--token', '--bearer-token']),
      env.CONTROL_PLANE_SMOKE_TOKEN,
    ),
    manifestUrl: endpoint.manifestUrl,
    releaseRecordUrl,
    appUpdateUrl: firstString(
      readArg(argv, '--app-update-url'),
      env.RENDERER_BUNDLE_APP_UPDATE_URL,
    ) ?? buildAppUpdateSnapshotUrl(controlPlaneBaseUrl),
    expectedVersion: firstString(readArg(argv, '--expected-version'), env.RENDERER_BUNDLE_EXPECTED_VERSION),
    expectedVersionFromAppUpdate: hasFlag(argv, '--expected-version-from-app-update')
      || env.RENDERER_BUNDLE_EXPECTED_VERSION_FROM_APP_UPDATE === '1'
      || env.RENDERER_BUNDLE_EXPECTED_VERSION_FROM_APP_UPDATE === 'true',
    expectedReleaseChannel,
    expectedCohort: firstString(readArg(argv, '--expected-cohort'), env.RENDERER_BUNDLE_EXPECTED_COHORT),
    expectedRolloutPercent: firstString(
      readArg(argv, '--expected-rollout-percent'),
      env.RENDERER_BUNDLE_EXPECTED_ROLLOUT_PERCENT,
    ),
    minRequiredShellCapabilities: parseMinRequiredShellCapabilities(argv, env),
    minManifestValiditySeconds: parseMinManifestValiditySeconds(argv, env),
    allowUnknownShellCapabilities: hasFlag(argv, '--allow-unknown-shell-capabilities'),
    publicKeys: readPublicKeysFromArgs(argv),
    includeRemoteSnapshot: hasFlag(argv, '--include-remote-snapshot'),
    includeBundleHashSnapshot: !hasFlag(argv, '--skip-bundle-hash-snapshot'),
    controlPlaneArtifacts: hasFlag(argv, '--full-control-plane-smoke')
      ? CONTROL_PLANE_ARTIFACTS
      : RENDERER_HOT_UPDATE_CONTROL_PLANE_ARTIFACTS,
    retryAttempts: parsePositiveIntegerArg(argv, env, {
      argName: '--retry-attempts',
      envNames: [
        'RENDERER_HOT_UPDATE_PRODUCTION_VERIFY_RETRY_ATTEMPTS',
        'RENDERER_BUNDLE_VERIFY_PRODUCTION_RETRY_ATTEMPTS',
      ],
      defaultValue: 1,
    }),
    retryDelayMs: parseNonNegativeIntegerArg(argv, env, {
      argName: '--retry-delay-ms',
      envNames: [
        'RENDERER_HOT_UPDATE_PRODUCTION_VERIFY_RETRY_DELAY_MS',
        'RENDERER_BUNDLE_VERIFY_PRODUCTION_RETRY_DELAY_MS',
      ],
      defaultValue: 0,
    }),
    skipControlPlane,
    skipRendererBundle,
  };
}

function failureFromError(target, error) {
  return {
    target,
    code: error?.code ?? `${target}_verification_failed`,
    message: error instanceof Error ? error.message : String(error),
    ...(error?.endpoint ? { endpoint: error.endpoint } : {}),
    ...(error?.status ? { status: error.status } : {}),
    ...(error?.details !== undefined ? { details: error.details } : {}),
  };
}

export async function verifyRendererHotUpdateProduction({
  controlPlaneBaseUrl,
  controlPlaneToken,
  manifestUrl,
  releaseRecordUrl,
  appUpdateUrl,
  expectedVersion,
  expectedVersionFromAppUpdate = false,
  expectedReleaseChannel,
  expectedCohort,
  expectedRolloutPercent,
  minRequiredShellCapabilities = 1,
  minManifestValiditySeconds = DEFAULT_MIN_MANIFEST_VALIDITY_SECONDS,
  allowUnknownShellCapabilities = false,
  publicKeys,
  includeRemoteSnapshot = false,
  includeBundleHashSnapshot = true,
  controlPlaneArtifacts = RENDERER_HOT_UPDATE_CONTROL_PLANE_ARTIFACTS,
  skipControlPlane = false,
  skipRendererBundle = false,
  fetchImpl = globalThis.fetch,
  runControlPlaneSmokeImpl = runControlPlaneSmoke,
  verifyRendererBundlePublishImpl = verifyRendererBundlePublish,
} = {}) {
  if (skipControlPlane && skipRendererBundle) {
    throw new RendererHotUpdateProductionVerificationError(
      'skipControlPlane and skipRendererBundle cannot both be true',
      { code: 'invalid_args' },
    );
  }

  const summary = {};
  const failures = [];
  let resolvedExpectedVersion = expectedVersion;

  if (expectedVersionFromAppUpdate) {
    try {
      const appUpdate = await resolveExpectedVersionFromAppUpdate({
        fetchImpl,
        appUpdateUrl: appUpdateUrl ?? buildAppUpdateSnapshotUrl(controlPlaneBaseUrl ?? PRODUCTION_CLOUD_API_URL),
        explicitExpectedVersion: expectedVersion,
      });
      resolvedExpectedVersion = appUpdate.expectedVersion;
      summary.appUpdate = {
        skipped: false,
        expectedVersion: appUpdate.expectedVersion,
        ...appUpdate.snapshot,
      };
    } catch (error) {
      failures.push(failureFromError('app-update', error));
    }
  } else {
    summary.appUpdate = { skipped: true };
  }

  if (skipControlPlane) {
    summary.controlPlane = { skipped: true };
  } else {
    try {
      const results = await runControlPlaneSmokeImpl({
        baseUrl: controlPlaneBaseUrl ?? PRODUCTION_CLOUD_API_URL,
        token: controlPlaneToken,
        artifacts: controlPlaneArtifacts,
      });
      summary.controlPlane = {
        skipped: false,
        baseUrl: controlPlaneBaseUrl ?? PRODUCTION_CLOUD_API_URL,
        checked: results.length,
        artifacts: results,
      };
    } catch (error) {
      failures.push(failureFromError('control-plane', error));
    }
  }

  if (skipRendererBundle) {
    summary.rendererBundle = { skipped: true };
  } else {
    try {
      const result = await verifyRendererBundlePublishImpl({
        manifestUrl,
        releaseRecordUrl,
        expectedVersion: resolvedExpectedVersion,
        minRequiredShellCapabilities,
        minManifestValiditySeconds,
        allowUnknownShellCapabilities,
        ...(publicKeys ? { publicKeys } : {}),
        expectedReleaseChannel,
        expectedCohort,
        expectedRolloutPercent,
      });
      summary.rendererBundle = {
        skipped: false,
        ...result,
      };
    } catch (error) {
      failures.push(failureFromError('renderer-bundle', error));
    }
  }

  if (failures.length > 0) {
    let remoteSnapshot;
    if (includeRemoteSnapshot && !skipRendererBundle) {
      try {
        remoteSnapshot = await inspectRendererHotUpdateRemoteArtifacts({
          manifestUrl,
          releaseRecordUrl,
          appUpdateUrl: appUpdateUrl ?? buildAppUpdateSnapshotUrl(controlPlaneBaseUrl ?? PRODUCTION_CLOUD_API_URL),
          expectedVersion: resolvedExpectedVersion,
          expectedReleaseChannel,
          fetchImpl,
          includeBundleHash: includeBundleHashSnapshot,
        });
      } catch (error) {
        remoteSnapshot = {
          error: error instanceof Error ? error.message : String(error),
          code: error?.code,
        };
      }
    }
    const code = failures.length === 1
      ? failures[0].code
      : 'renderer_hot_update_production_verification_failed';
    throw new RendererHotUpdateProductionVerificationError(
      failures.map((failure) => `[${failure.target}] ${failure.message}`).join('\n'),
      {
        code,
        failures,
        ...(remoteSnapshot ? { details: { remoteSnapshot } } : {}),
      },
    );
  }

  return summary;
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function verifyRendererHotUpdateProductionWithRetry(options = {}) {
  const {
    retryAttempts = 1,
    retryDelayMs = 0,
    retrySleep = sleep,
    retryLog,
    ...verificationOptions
  } = options;
  if (!Number.isInteger(retryAttempts) || retryAttempts <= 0) {
    throw new RendererHotUpdateProductionVerificationError('retryAttempts must be a positive integer', {
      code: 'invalid_args',
      details: { retryAttempts },
    });
  }
  if (!Number.isInteger(retryDelayMs) || retryDelayMs < 0) {
    throw new RendererHotUpdateProductionVerificationError('retryDelayMs must be a non-negative integer', {
      code: 'invalid_args',
      details: { retryDelayMs },
    });
  }

  let lastError;
  for (let attempt = 1; attempt <= retryAttempts; attempt += 1) {
    try {
      return await verifyRendererHotUpdateProduction(verificationOptions);
    } catch (error) {
      lastError = error;
      if (attempt >= retryAttempts) {
        throw error;
      }
      if (typeof retryLog === 'function') {
        retryLog({
          attempt,
          attempts: retryAttempts,
          retryDelayMs,
          error,
        });
      }
      if (retryDelayMs > 0) {
        await retrySleep(retryDelayMs);
      }
    }
  }
  throw lastError;
}

async function main(argv) {
  const args = parseRendererHotUpdateProductionArgs(argv);
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const summary = await verifyRendererHotUpdateProductionWithRetry({
    ...args,
    retryLog: ({ attempt, attempts, retryDelayMs, error }) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(
        `[verify-renderer-hot-update-production] attempt ${attempt}/${attempts} failed; retrying in ${retryDelayMs}ms: ${message}\n`,
      );
    },
  });
  if (!summary.controlPlane?.skipped) {
    process.stdout.write(`[verify-renderer-hot-update-production] control-plane passed: ${summary.controlPlane.checked} envelope(s)\n`);
  }
  if (!summary.rendererBundle?.skipped) {
    process.stdout.write(`[verify-renderer-hot-update-production] renderer bundle passed: ${summary.rendererBundle.version}\n`);
  }
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main(process.argv.slice(2)).catch((error) => {
    if (
      error instanceof RendererHotUpdateProductionVerificationError ||
      error instanceof RendererBundlePublishVerificationError
    ) {
      process.stderr.write(`[verify-renderer-hot-update-production] ${error.message}\n`);
      if (error.failures !== undefined) {
        process.stderr.write(`${JSON.stringify(error.failures, null, 2)}\n`);
      }
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
