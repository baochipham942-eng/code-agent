import type { RendererBundleRolloutPolicyPayload } from './controlPlanePayloads.js';

const SUPABASE_URL_ENV_NAMES = [
  'CONTROL_PLANE_SUPABASE_URL',
  'CODE_AGENT_CONTROL_PLANE_SUPABASE_URL',
  'SUPABASE_URL',
];

const SUPABASE_SERVICE_KEY_ENV_NAMES = [
  'CONTROL_PLANE_SUPABASE_SERVICE_ROLE_KEY',
  'CODE_AGENT_CONTROL_PLANE_SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
];

const AUTO_ROLLBACK_ENABLED_ENV_NAMES = [
  'CONTROL_PLANE_RENDERER_BUNDLE_AUTO_ROLLBACK_ENABLED',
  'CODE_AGENT_RENDERER_BUNDLE_AUTO_ROLLBACK_ENABLED',
];

type AutoRollbackAction = 'pause' | 'rollback';

interface AutoRollbackConfig {
  enabled: boolean;
  table: string;
  windowMinutes: number;
  minAttempts: number;
  failureRate: number;
  action: AutoRollbackAction;
}

interface RendererBundleTelemetryAttemptRow {
  outcome?: unknown;
  reason?: unknown;
  manifest_url?: unknown;
  manifest_content_hash?: unknown;
  source_channel?: unknown;
  checked_at?: unknown;
}

export interface RendererBundleAutoRollbackSummary {
  attempts: number;
  failures: number;
  failureRate: number;
  action: AutoRollbackAction;
}

export interface RendererBundleRolloutPolicyWithAutoRollback extends RendererBundleRolloutPolicyPayload {
  autoRollback?: RendererBundleAutoRollbackSummary;
}

function readEnv(env: NodeJS.ProcessEnv, names: string[]): string | null {
  for (const name of names) {
    const value = env[name];
    if (value && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

function readBooleanEnv(env: NodeJS.ProcessEnv, names: string[]): boolean {
  const value = readEnv(env, names);
  return value ? /^(1|true|yes|on)$/i.test(value) : false;
}

function readNumberEnv(
  env: NodeJS.ProcessEnv,
  names: string[],
  fallback: number,
  validate: (value: number) => boolean,
): number {
  const value = readEnv(env, names);
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && validate(parsed) ? parsed : fallback;
}

function readAction(env: NodeJS.ProcessEnv): AutoRollbackAction {
  const value = readEnv(env, [
    'CONTROL_PLANE_RENDERER_BUNDLE_AUTO_ROLLBACK_ACTION',
    'CODE_AGENT_RENDERER_BUNDLE_AUTO_ROLLBACK_ACTION',
  ]);
  return value === 'pause' ? 'pause' : 'rollback';
}

function resolveAutoRollbackConfig(env: NodeJS.ProcessEnv): AutoRollbackConfig {
  return {
    enabled: readBooleanEnv(env, AUTO_ROLLBACK_ENABLED_ENV_NAMES),
    table: readEnv(env, [
      'CONTROL_PLANE_RENDERER_BUNDLE_TELEMETRY_TABLE',
      'CODE_AGENT_RENDERER_BUNDLE_TELEMETRY_TABLE',
    ]) ?? 'telemetry_renderer_bundle_attempts',
    windowMinutes: readNumberEnv(env, [
      'CONTROL_PLANE_RENDERER_BUNDLE_AUTO_ROLLBACK_WINDOW_MINUTES',
      'CODE_AGENT_RENDERER_BUNDLE_AUTO_ROLLBACK_WINDOW_MINUTES',
    ], 30, (value) => value > 0 && value <= 24 * 60),
    minAttempts: readNumberEnv(env, [
      'CONTROL_PLANE_RENDERER_BUNDLE_AUTO_ROLLBACK_MIN_ATTEMPTS',
      'CODE_AGENT_RENDERER_BUNDLE_AUTO_ROLLBACK_MIN_ATTEMPTS',
    ], 20, (value) => value > 0),
    failureRate: readNumberEnv(env, [
      'CONTROL_PLANE_RENDERER_BUNDLE_AUTO_ROLLBACK_FAILURE_RATE',
      'CODE_AGENT_RENDERER_BUNDLE_AUTO_ROLLBACK_FAILURE_RATE',
    ], 0.2, (value) => value >= 0 && value <= 1),
    action: readAction(env),
  };
}

function isFailure(row: RendererBundleTelemetryAttemptRow): boolean {
  return row.outcome === 'failed' ||
    row.reason === 'integrity-mismatch' ||
    row.reason === 'extract-unhealthy' ||
    row.reason === 'envelope-untrusted' ||
    row.reason === 'missing-shell-capability' ||
    row.reason === 'missing-runtime-asset' ||
    row.reason === 'missing-resource';
}

function matchesPolicy(row: RendererBundleTelemetryAttemptRow, policy: RendererBundleRolloutPolicyPayload): boolean {
  if (policy.manifestContentHash) {
    return row.manifest_content_hash === policy.manifestContentHash;
  }
  if (policy.manifestUrl) {
    return row.manifest_url === policy.manifestUrl;
  }
  if (policy.channel) {
    const channel = encodeURIComponent(policy.channel);
    const manifestUrl = typeof row.manifest_url === 'string' ? row.manifest_url : '';
    if (policy.channel === 'latest') {
      return row.source_channel === 'latest' || manifestUrl.includes('/renderer-bundle/latest/manifest.json');
    }
    return row.source_channel === policy.channel ||
      manifestUrl.includes(`/renderer-bundle/channels/${channel}/manifest.json`);
  }
  return true;
}

function summarizeRows(
  rows: RendererBundleTelemetryAttemptRow[],
  policy: RendererBundleRolloutPolicyPayload,
): { attempts: number; failures: number; failureRate: number } {
  const matching = rows.filter((row) => matchesPolicy(row, policy));
  const failures = matching.filter(isFailure).length;
  return {
    attempts: matching.length,
    failures,
    failureRate: matching.length > 0 ? failures / matching.length : 0,
  };
}

async function fetchRecentRendererBundleAttempts(options: {
  env: NodeJS.ProcessEnv;
  config: AutoRollbackConfig;
  sinceIso: string;
  fetchImpl: typeof fetch;
}): Promise<RendererBundleTelemetryAttemptRow[] | null> {
  const url = readEnv(options.env, SUPABASE_URL_ENV_NAMES);
  const serviceKey = readEnv(options.env, SUPABASE_SERVICE_KEY_ENV_NAMES);
  if (!url || !serviceKey) return null;

  const endpoint = new URL(`${url.replace(/\/+$/, '')}/rest/v1/${options.config.table}`);
  endpoint.searchParams.set('select', 'outcome,reason,manifest_url,manifest_content_hash,source_channel,checked_at');
  endpoint.searchParams.set('checked_at', `gte.${options.sinceIso}`);
  endpoint.searchParams.set('order', 'checked_at.desc');
  endpoint.searchParams.set('limit', '1000');

  const response = await options.fetchImpl(endpoint.toString(), {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${serviceKey}`,
      apikey: serviceKey,
      Accept: 'application/json',
    },
  });
  if (!response.ok) return null;
  const rows = await response.json().catch(() => null);
  return Array.isArray(rows) ? rows as RendererBundleTelemetryAttemptRow[] : [];
}

export async function applyRendererBundleAutoRollbackGuard(
  policy: RendererBundleRolloutPolicyPayload,
  options: {
    env?: NodeJS.ProcessEnv;
    fetchImpl?: typeof fetch;
    now?: Date;
  } = {},
): Promise<RendererBundleRolloutPolicyWithAutoRollback> {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const config = resolveAutoRollbackConfig(env);
  if (!config.enabled || typeof fetchImpl !== 'function') {
    return policy;
  }

  const now = options.now ?? new Date();
  const sinceIso = new Date(now.getTime() - config.windowMinutes * 60 * 1000).toISOString();
  const rows = await fetchRecentRendererBundleAttempts({
    env,
    config,
    sinceIso,
    fetchImpl,
  });
  if (!rows) return policy;

  const summary = summarizeRows(rows, policy);
  if (summary.attempts < config.minAttempts || summary.failureRate < config.failureRate) {
    return policy;
  }

  const autoRollback: RendererBundleAutoRollbackSummary = {
    ...summary,
    action: config.action,
  };
  if (config.action === 'pause') {
    return {
      ...policy,
      paused: true,
      pauseReason: `auto rollback guard: ${summary.failures}/${summary.attempts} failures`,
      autoRollback,
    };
  }

  return {
    ...policy,
    rollbackToBuiltin: true,
    rollbackReason: `auto rollback guard: ${summary.failures}/${summary.attempts} failures`,
    autoRollback,
  };
}
