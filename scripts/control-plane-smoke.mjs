#!/usr/bin/env node
import crypto from 'node:crypto';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

export const CONTROL_PLANE_ARTIFACTS = [
  {
    name: 'cloud config',
    path: '/api/v1/config',
    expectedKind: 'cloud_config',
  },
  {
    name: 'prompt registry',
    path: '/api/prompts?gen=all',
    expectedKind: 'prompt_registry',
  },
  {
    name: 'capability registry',
    path: '/api/v1/control-plane?artifact=capabilities',
    expectedKind: 'capability_registry',
  },
];

export class ControlPlaneSmokeError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'ControlPlaneSmokeError';
    this.code = options.code ?? 'control_plane_smoke_failed';
    this.endpoint = options.endpoint;
    this.status = options.status;
    this.failures = options.failures;
    this.details = options.details;
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function canonicalizeForControlPlane(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalizeForControlPlane(entry));
  }
  if (!isRecord(value)) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalizeForControlPlane(entry)]),
  );
}

export function buildControlPlaneContentHash(payload) {
  return `sha256:${crypto
    .createHash('sha256')
    .update(JSON.stringify(canonicalizeForControlPlane(payload)))
    .digest('hex')}`;
}

function assertBaseUrl(baseUrl) {
  if (!baseUrl || typeof baseUrl !== 'string') {
    throw new ControlPlaneSmokeError('Base URL is required.', { code: 'missing_base_url' });
  }
  try {
    return new URL(baseUrl);
  } catch {
    throw new ControlPlaneSmokeError(`Invalid base URL: ${baseUrl}`, { code: 'invalid_base_url' });
  }
}

function artifactUrl(baseUrl, artifactPath) {
  return new URL(artifactPath, baseUrl).toString();
}

function formatBody(body) {
  if (body === undefined || body === null) {
    return '';
  }
  try {
    return ` Body: ${JSON.stringify(body)}`;
  } catch {
    return '';
  }
}

function readRequiredString(record, key) {
  const value = record[key];
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

export function validateControlPlaneEnvelope({ artifact, endpoint, status, body, now = Date.now() }) {
  if (status === 503 && isRecord(body) && body.error === 'control_plane_unconfigured') {
    throw new ControlPlaneSmokeError(
      `${artifact.name} is not configured on the control plane: ${body.message ?? 'missing signing or payload env'}`,
      {
        code: 'control_plane_unconfigured',
        endpoint,
        status,
        details: body,
      },
    );
  }

  if (status < 200 || status >= 300) {
    throw new ControlPlaneSmokeError(
      `${artifact.name} returned HTTP ${status}.${formatBody(body)}`,
      {
        code: 'http_status',
        endpoint,
        status,
        details: body,
      },
    );
  }

  if (!isRecord(body)) {
    throw new ControlPlaneSmokeError(`${artifact.name} did not return a JSON object envelope.`, {
      code: 'invalid_envelope',
      endpoint,
      status,
      details: body,
    });
  }

  const failures = [];
  if (body.schemaVersion !== 1) {
    failures.push(`schemaVersion expected 1, got ${JSON.stringify(body.schemaVersion)}`);
  }
  if (body.kind !== artifact.expectedKind) {
    failures.push(`kind expected ${artifact.expectedKind}, got ${JSON.stringify(body.kind)}`);
  }
  if (!Object.prototype.hasOwnProperty.call(body, 'payload') || body.payload === null || body.payload === undefined) {
    failures.push('payload is required');
  }

  const contentHash = readRequiredString(body, 'contentHash');
  if (!contentHash) {
    failures.push('contentHash is required');
  } else if (!/^sha256:[a-f0-9]{64}$/i.test(contentHash)) {
    failures.push(`contentHash must use sha256:<64 hex chars>, got ${JSON.stringify(contentHash)}`);
  } else {
    const actualHash = buildControlPlaneContentHash(body.payload);
    if (contentHash.toLowerCase() !== actualHash) {
      failures.push(`contentHash mismatch, expected ${contentHash}, actual ${actualHash}`);
    }
  }

  const signature = readRequiredString(body, 'signature');
  if (!signature) {
    failures.push('signature is required');
  }

  const keyId = readRequiredString(body, 'keyId');
  if (!keyId) {
    failures.push('keyId is required for a signed envelope');
  }

  const expiresAt = readRequiredString(body, 'expiresAt');
  if (!expiresAt) {
    failures.push('expiresAt is required');
  } else {
    const expiresAtMs = Date.parse(expiresAt);
    if (!Number.isFinite(expiresAtMs)) {
      failures.push(`expiresAt must be a valid date string, got ${JSON.stringify(expiresAt)}`);
    } else if (expiresAtMs <= now) {
      failures.push(`expiresAt is in the past: ${expiresAt}`);
    }
  }

  if (failures.length > 0) {
    let code = 'invalid_envelope';
    if (failures.some((failure) => failure.startsWith('kind expected'))) {
      code = 'kind_mismatch';
    } else if (failures.some((failure) => failure.startsWith('signature is required'))) {
      code = 'missing_signature';
    }
    throw new ControlPlaneSmokeError(
      `${artifact.name} envelope failed validation: ${failures.join('; ')}`,
      {
        code,
        endpoint,
        status,
        details: failures,
      },
    );
  }

  return {
    name: artifact.name,
    endpoint,
    status,
    kind: body.kind,
    keyId,
    contentHash,
    expiresAt,
  };
}

async function fetchJson(fetchImpl, url, token) {
  const headers = {
    Accept: 'application/json',
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetchImpl(url, {
    method: 'GET',
    headers,
  });
  const text = await response.text();
  if (!text.trim()) {
    return {
      status: response.status,
      body: undefined,
    };
  }
  try {
    return {
      status: response.status,
      body: JSON.parse(text),
    };
  } catch {
    throw new ControlPlaneSmokeError(`${url} returned non-JSON response.`, {
      code: 'invalid_json',
      endpoint: url,
      status: response.status,
      details: text.slice(0, 500),
    });
  }
}

export async function runControlPlaneSmoke({
  baseUrl,
  token,
  fetchImpl = globalThis.fetch,
  artifacts = CONTROL_PLANE_ARTIFACTS,
  now = Date.now(),
}) {
  const parsedBaseUrl = assertBaseUrl(baseUrl);
  if (typeof fetchImpl !== 'function') {
    throw new ControlPlaneSmokeError('fetch is not available in this Node.js runtime.', {
      code: 'missing_fetch',
    });
  }

  const results = [];
  const failures = [];
  for (const artifact of artifacts) {
    const endpoint = artifactUrl(parsedBaseUrl, artifact.path);
    try {
      const { status, body } = await fetchJson(fetchImpl, endpoint, token);
      results.push(validateControlPlaneEnvelope({ artifact, endpoint, status, body, now }));
    } catch (error) {
      failures.push(error instanceof ControlPlaneSmokeError
        ? error
        : new ControlPlaneSmokeError(`${artifact.name} request failed: ${error.message}`, {
          code: 'request_failed',
          endpoint,
          details: error,
        }));
    }
  }

  if (failures.length > 0) {
    const code = failures.length === 1
      ? failures[0].code
      : failures.some((failure) => failure.code === 'control_plane_unconfigured')
        ? 'control_plane_unconfigured'
        : 'control_plane_smoke_failed';
    throw new ControlPlaneSmokeError(
      failures.map((failure) => `${failure.endpoint}: ${failure.message}`).join('\n'),
      {
        code,
        failures,
      },
    );
  }

  return results;
}

function usage() {
  return [
    'Usage: node scripts/control-plane-smoke.mjs <base-url> [--token <bearer-token>]',
    '       node scripts/control-plane-smoke.mjs --base-url <base-url> [--bearer-token <token>]',
  ].join('\n');
}

export function parseControlPlaneSmokeArgs(argv) {
  let baseUrl = null;
  let token = null;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      return { help: true };
    }
    if (arg === '--base-url' || arg === '--url') {
      baseUrl = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (arg === '--token' || arg === '--bearer-token' || arg === '--bearer') {
      token = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (arg.startsWith('--')) {
      throw new ControlPlaneSmokeError(`Unknown option: ${arg}\n${usage()}`, {
        code: 'invalid_args',
      });
    }
    if (!baseUrl) {
      baseUrl = arg;
      continue;
    }
    throw new ControlPlaneSmokeError(`Unexpected argument: ${arg}\n${usage()}`, {
      code: 'invalid_args',
    });
  }

  if (!baseUrl) {
    throw new ControlPlaneSmokeError(`Base URL is required.\n${usage()}`, {
      code: 'missing_base_url',
    });
  }
  if (token === '') {
    throw new ControlPlaneSmokeError('Bearer token cannot be empty.', {
      code: 'invalid_args',
    });
  }
  return { baseUrl, token };
}

async function main(argv) {
  const args = parseControlPlaneSmokeArgs(argv);
  if (args.help) {
    console.log(usage());
    return;
  }

  const results = await runControlPlaneSmoke({
    baseUrl: args.baseUrl,
    token: args.token,
  });

  for (const result of results) {
    console.log(
      `[control-plane-smoke] ok ${result.name}: HTTP ${result.status}, kind=${result.kind}, keyId=${result.keyId}, contentHash=${result.contentHash}, expiresAt=${result.expiresAt}`,
    );
  }
  console.log(`[control-plane-smoke] passed: ${results.length} signed envelope(s) checked`);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main(process.argv.slice(2)).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[control-plane-smoke] failed: ${message}`);
    process.exitCode = 1;
  });
}
