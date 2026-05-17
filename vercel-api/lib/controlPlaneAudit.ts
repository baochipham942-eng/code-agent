import type {
  ControlPlaneArtifactKind,
  ControlPlaneEnvelope,
  ControlPlaneRequestLike,
} from './controlPlaneEnvelope.js';

export interface ControlPlaneAuditResult {
  ok: boolean;
  skippedReason?: string;
  error?: string;
}

interface ControlPlaneAuditConfig {
  url: string;
  key: string;
  table: string;
}

interface ControlPlaneAuditEventOptions<TPayload> {
  envelope: ControlPlaneEnvelope<TPayload>;
  statusCode: number;
  outcome: 'served' | 'not_modified' | 'head';
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  now?: Date;
}

interface ControlPlaneAuditErrorOptions {
  kind: ControlPlaneArtifactKind;
  statusCode: number;
  errorCode: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  now?: Date;
}

const AUDIT_ENABLED_ENV_NAMES = [
  'CONTROL_PLANE_AUDIT_ENABLED',
  'CODE_AGENT_CONTROL_PLANE_AUDIT_ENABLED',
];

const AUDIT_URL_ENV_NAMES = [
  'CONTROL_PLANE_AUDIT_SUPABASE_URL',
  'CODE_AGENT_CONTROL_PLANE_AUDIT_SUPABASE_URL',
  'CONTROL_PLANE_SUPABASE_URL',
  'CODE_AGENT_CONTROL_PLANE_SUPABASE_URL',
  'SUPABASE_URL',
];

const AUDIT_KEY_ENV_NAMES = [
  'CONTROL_PLANE_AUDIT_SUPABASE_SERVICE_ROLE_KEY',
  'CODE_AGENT_CONTROL_PLANE_AUDIT_SUPABASE_SERVICE_ROLE_KEY',
  'CONTROL_PLANE_SUPABASE_SERVICE_ROLE_KEY',
  'CODE_AGENT_CONTROL_PLANE_SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
];

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
  return value ? /^(1|true|yes|enabled)$/i.test(value) : false;
}

function resolveAuditConfig(env: NodeJS.ProcessEnv): ControlPlaneAuditConfig | null {
  if (!readBooleanEnv(env, AUDIT_ENABLED_ENV_NAMES)) {
    return null;
  }
  const url = readEnv(env, AUDIT_URL_ENV_NAMES);
  const key = readEnv(env, AUDIT_KEY_ENV_NAMES);
  if (!url || !key) {
    return null;
  }
  return {
    url: url.replace(/\/+$/, ''),
    key,
    table: readEnv(env, [
      'CONTROL_PLANE_AUDIT_TABLE',
      'CODE_AGENT_CONTROL_PLANE_AUDIT_TABLE',
    ]) ?? 'control_plane_audit_events',
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function getHeader(req: ControlPlaneRequestLike, name: string): string | null {
  const headers = req.headers ?? {};
  const value = headers[name] ?? headers[name.toLowerCase()] ?? headers[name.toUpperCase()];
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }
  return value ?? null;
}

function buildBaseRow(
  req: ControlPlaneRequestLike,
  args: {
    kind: ControlPlaneArtifactKind;
    statusCode: number;
    outcome: string;
    now: Date;
    errorCode?: string;
  },
): Record<string, unknown> {
  return {
    artifact_kind: args.kind,
    created_at: args.now.toISOString(),
    error_code: args.errorCode ?? null,
    outcome: args.outcome,
    request_id: getHeader(req, 'x-vercel-id') ?? getHeader(req, 'x-request-id'),
    request_method: req.method ?? 'GET',
    status_code: args.statusCode,
    user_agent: getHeader(req, 'user-agent'),
  };
}

function buildEnvelopeRow<TPayload>(
  req: ControlPlaneRequestLike,
  envelope: ControlPlaneEnvelope<TPayload>,
  statusCode: number,
  outcome: string,
  now: Date,
): Record<string, unknown> {
  const payload: Record<string, unknown> = isRecord(envelope.payload) ? envelope.payload : {};
  const subject = isRecord(payload.subject) ? payload.subject : {};
  const entitlement = isRecord(payload.entitlement) ? payload.entitlement : {};
  const release = isRecord(payload.release) ? payload.release : {};

  return {
    ...buildBaseRow(req, {
      kind: envelope.kind,
      statusCode,
      outcome,
      now,
    }),
    content_hash: envelope.contentHash,
    entitlement_plan: asString(entitlement.plan),
    entitlement_reason: asString(entitlement.reason),
    entitlement_status: asString(entitlement.status),
    key_id: envelope.keyId ?? null,
    payload_version: asString(payload.version),
    release_channel: asString(release.channel),
    subject_id: asString(subject.id),
    subject_source: asString(subject.source),
  };
}

async function postAuditRow(
  config: ControlPlaneAuditConfig,
  row: Record<string, unknown>,
  fetchImpl: typeof fetch,
): Promise<ControlPlaneAuditResult> {
  const response = await fetchImpl(
    `${config.url}/rest/v1/${encodeURIComponent(config.table)}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.key}`,
        apikey: config.key,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify(row),
    },
  );
  if (!response.ok) {
    return {
      ok: false,
      error: `audit_insert_failed:${response.status}`,
    };
  }
  return { ok: true };
}

export async function recordControlPlaneAuditEvent<TPayload>(
  req: ControlPlaneRequestLike,
  options: ControlPlaneAuditEventOptions<TPayload>,
): Promise<ControlPlaneAuditResult> {
  const env = options.env ?? process.env;
  const config = resolveAuditConfig(env);
  if (!config) {
    return { ok: true, skippedReason: 'audit_not_configured' };
  }
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    return { ok: true, skippedReason: 'fetch_unavailable' };
  }

  try {
    return await postAuditRow(
      config,
      buildEnvelopeRow(
        req,
        options.envelope,
        options.statusCode,
        options.outcome,
        options.now ?? new Date(),
      ),
      fetchImpl,
    );
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function recordControlPlaneAuditError(
  req: ControlPlaneRequestLike,
  options: ControlPlaneAuditErrorOptions,
): Promise<ControlPlaneAuditResult> {
  const env = options.env ?? process.env;
  const config = resolveAuditConfig(env);
  if (!config) {
    return { ok: true, skippedReason: 'audit_not_configured' };
  }
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    return { ok: true, skippedReason: 'fetch_unavailable' };
  }

  try {
    return await postAuditRow(
      config,
      buildBaseRow(req, {
        kind: options.kind,
        statusCode: options.statusCode,
        outcome: 'error',
        errorCode: options.errorCode,
        now: options.now ?? new Date(),
      }),
      fetchImpl,
    );
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function recordControlPlaneAuditEventBackground<TPayload>(
  req: ControlPlaneRequestLike,
  options: ControlPlaneAuditEventOptions<TPayload>,
): void {
  void recordControlPlaneAuditEvent(req, options);
}

export function recordControlPlaneAuditErrorBackground(
  req: ControlPlaneRequestLike,
  options: ControlPlaneAuditErrorOptions,
): void {
  void recordControlPlaneAuditError(req, options);
}
