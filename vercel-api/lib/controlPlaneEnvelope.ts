import * as crypto from 'node:crypto';
import {
  recordControlPlaneAuditErrorBackground,
  recordControlPlaneAuditEventBackground,
} from './controlPlaneAudit.js';

export type ControlPlaneArtifactKind =
  | 'cloud_config'
  | 'capability_registry'
  | 'prompt_registry'
  | 'update_manifest';

export interface ControlPlaneEnvelope<TPayload = unknown> {
  schemaVersion: 1;
  kind: ControlPlaneArtifactKind;
  issuedAt?: string;
  expiresAt: string;
  contentHash: string;
  keyId?: string;
  signature?: string;
  payload: TPayload;
}

export interface ControlPlaneRequestLike {
  method?: string;
  query?: Record<string, string | string[] | undefined>;
  headers?: Record<string, string | string[] | undefined>;
  body?: unknown;
}

export interface ControlPlaneResponseLike {
  setHeader(name: string, value: string): void;
  status(code: number): ControlPlaneResponseLike;
  json(value: unknown): void;
  end(): void;
}

export interface CreateControlPlaneEnvelopeOptions<TPayload> {
  kind: ControlPlaneArtifactKind;
  payload: TPayload;
  keyId: string;
  privateKey: string;
  issuedAt?: string;
  expiresAt?: string;
  ttlSeconds?: number;
  now?: Date;
}

export class ControlPlaneConfigError extends Error {
  constructor(message: string, public readonly statusCode = 503) {
    super(message);
    this.name = 'ControlPlaneConfigError';
  }
}

export function canonicalizeForControlPlane(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalizeForControlPlane(entry));
  }
  if (!value || typeof value !== 'object') {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalizeForControlPlane(entry)]),
  );
}

export function buildControlPlaneContentHash(payload: unknown): string {
  return `sha256:${crypto
    .createHash('sha256')
    .update(JSON.stringify(canonicalizeForControlPlane(payload)))
    .digest('hex')}`;
}

export function buildControlPlaneSigningPayload(envelope: ControlPlaneEnvelope): string {
  return JSON.stringify(canonicalizeForControlPlane({
    schemaVersion: envelope.schemaVersion,
    kind: envelope.kind,
    issuedAt: envelope.issuedAt,
    expiresAt: envelope.expiresAt,
    contentHash: envelope.contentHash,
    keyId: envelope.keyId,
    payload: envelope.payload,
  }));
}

function normalizePem(raw: string): string {
  const normalized = raw.trim().replace(/\\n/g, '\n');
  if (normalized.includes('-----BEGIN')) {
    return normalized;
  }

  const decoded = Buffer.from(normalized, 'base64').toString('utf8').trim().replace(/\\n/g, '\n');
  if (decoded.includes('-----BEGIN')) {
    return decoded;
  }

  return normalized;
}

function readEnv(env: NodeJS.ProcessEnv, names: string[]): string | null {
  for (const name of names) {
    const value = env[name];
    if (value && value.trim().length > 0) {
      return value;
    }
  }
  return null;
}

function parseTtlSeconds(env: NodeJS.ProcessEnv): number {
  const raw = readEnv(env, ['CONTROL_PLANE_TTL_SECONDS', 'CODE_AGENT_CONTROL_PLANE_TTL_SECONDS']);
  if (!raw) {
    return 3600;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new ControlPlaneConfigError('CONTROL_PLANE_TTL_SECONDS must be a positive number.', 500);
  }
  return parsed;
}

function buildExpiresAt(now: Date, ttlSeconds: number): string {
  return new Date(now.getTime() + ttlSeconds * 1000).toISOString();
}

export function createControlPlaneEnvelope<TPayload>(
  options: CreateControlPlaneEnvelopeOptions<TPayload>,
): ControlPlaneEnvelope<TPayload> {
  const now = options.now ?? new Date();
  const issuedAt = options.issuedAt ?? now.toISOString();
  const expiresAt = options.expiresAt ?? buildExpiresAt(now, options.ttlSeconds ?? 3600);
  const envelope: ControlPlaneEnvelope<TPayload> = {
    schemaVersion: 1,
    kind: options.kind,
    issuedAt,
    expiresAt,
    contentHash: buildControlPlaneContentHash(options.payload),
    keyId: options.keyId,
    payload: options.payload,
  };

  envelope.signature = crypto.sign(
    null,
    Buffer.from(buildControlPlaneSigningPayload(envelope)),
    normalizePem(options.privateKey),
  ).toString('base64');

  return envelope;
}

export function createControlPlaneEnvelopeFromEnv<TPayload>(
  kind: ControlPlaneArtifactKind,
  payload: TPayload,
  env: NodeJS.ProcessEnv = process.env,
): ControlPlaneEnvelope<TPayload> {
  const privateKey = readEnv(env, [
    'CONTROL_PLANE_PRIVATE_KEY',
    'CODE_AGENT_CONTROL_PLANE_PRIVATE_KEY',
  ]);
  const keyId = readEnv(env, [
    'CONTROL_PLANE_KEY_ID',
    'CODE_AGENT_CONTROL_PLANE_KEY_ID',
  ]);

  if (!privateKey) {
    throw new ControlPlaneConfigError('CONTROL_PLANE_PRIVATE_KEY is not configured.');
  }
  if (!keyId) {
    throw new ControlPlaneConfigError('CONTROL_PLANE_KEY_ID is not configured.');
  }

  return createControlPlaneEnvelope({
    kind,
    payload,
    keyId,
    privateKey,
    ttlSeconds: parseTtlSeconds(env),
  });
}

export function readJsonPayloadFromEnv<TPayload>(
  names: string[],
  env: NodeJS.ProcessEnv = process.env,
): TPayload {
  const raw = readEnv(env, names);
  if (!raw) {
    throw new ControlPlaneConfigError(`${names[0]} is not configured.`);
  }
  try {
    return JSON.parse(raw) as TPayload;
  } catch {
    throw new ControlPlaneConfigError(`${names[0]} must be valid JSON.`, 500);
  }
}

function getHeader(
  req: ControlPlaneRequestLike,
  name: string,
): string | null {
  const headers = req.headers ?? {};
  const value = headers[name] ?? headers[name.toLowerCase()] ?? headers[name.toUpperCase()];
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }
  return value ?? null;
}

function normalizeEtag(value: string): string {
  return value.trim().replace(/^W\//, '').replace(/^"|"$/g, '');
}

function matchesIfNoneMatch(req: ControlPlaneRequestLike, contentHash: string): boolean {
  const header = getHeader(req, 'if-none-match');
  if (!header) {
    return false;
  }
  return header
    .split(',')
    .map((entry) => normalizeEtag(entry))
    .includes(contentHash);
}

function sendError(res: ControlPlaneResponseLike, statusCode: number, code: string, message: string): void {
  res.status(statusCode).json({
    error: code,
    message,
  });
}

function sendCreatedControlPlaneEnvelope<TPayload>(
  req: ControlPlaneRequestLike,
  res: ControlPlaneResponseLike,
  kind: ControlPlaneArtifactKind,
  payload: TPayload,
): void {
  const envelope = createControlPlaneEnvelopeFromEnv(kind, payload);
  res.setHeader('Cache-Control', 'private, max-age=60');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('ETag', `"${envelope.contentHash}"`);
  if (envelope.keyId) {
    res.setHeader('X-Control-Plane-Key-Id', envelope.keyId);
  }
  res.setHeader('X-Control-Plane-Expires-At', envelope.expiresAt);

  if (matchesIfNoneMatch(req, envelope.contentHash)) {
    res.status(304).end();
    recordControlPlaneAuditEventBackground(req, {
      envelope,
      statusCode: 304,
      outcome: 'not_modified',
    });
    return;
  }

  if (req.method?.toUpperCase() === 'HEAD') {
    res.status(200).end();
    recordControlPlaneAuditEventBackground(req, {
      envelope,
      statusCode: 200,
      outcome: 'head',
    });
    return;
  }

  res.status(200).json(envelope);
  recordControlPlaneAuditEventBackground(req, {
    envelope,
    statusCode: 200,
    outcome: 'served',
  });
}

export function sendControlPlaneEnvelope<TPayload>(
  req: ControlPlaneRequestLike,
  res: ControlPlaneResponseLike,
  kind: ControlPlaneArtifactKind,
  payloadFactory: () => TPayload,
): void {
  if (req.method && !['GET', 'HEAD'].includes(req.method.toUpperCase())) {
    res.setHeader('Allow', 'GET, HEAD');
    sendError(res, 405, 'method_not_allowed', 'Only GET and HEAD are supported.');
    recordControlPlaneAuditErrorBackground(req, {
      kind,
      statusCode: 405,
      errorCode: 'method_not_allowed',
    });
    return;
  }

  try {
    sendCreatedControlPlaneEnvelope(req, res, kind, payloadFactory());
  } catch (error) {
    if (error instanceof ControlPlaneConfigError) {
      sendError(res, error.statusCode, 'control_plane_unconfigured', error.message);
      recordControlPlaneAuditErrorBackground(req, {
        kind,
        statusCode: error.statusCode,
        errorCode: 'control_plane_unconfigured',
      });
      return;
    }
    sendError(res, 500, 'control_plane_signing_failed', 'Failed to sign control-plane artifact.');
    recordControlPlaneAuditErrorBackground(req, {
      kind,
      statusCode: 500,
      errorCode: 'control_plane_signing_failed',
    });
  }
}

export async function sendControlPlaneEnvelopeAsync<TPayload>(
  req: ControlPlaneRequestLike,
  res: ControlPlaneResponseLike,
  kind: ControlPlaneArtifactKind,
  payloadFactory: () => TPayload | Promise<TPayload>,
): Promise<void> {
  if (req.method && !['GET', 'HEAD'].includes(req.method.toUpperCase())) {
    res.setHeader('Allow', 'GET, HEAD');
    sendError(res, 405, 'method_not_allowed', 'Only GET and HEAD are supported.');
    recordControlPlaneAuditErrorBackground(req, {
      kind,
      statusCode: 405,
      errorCode: 'method_not_allowed',
    });
    return;
  }

  try {
    sendCreatedControlPlaneEnvelope(req, res, kind, await payloadFactory());
  } catch (error) {
    if (error instanceof ControlPlaneConfigError) {
      sendError(res, error.statusCode, 'control_plane_unconfigured', error.message);
      recordControlPlaneAuditErrorBackground(req, {
        kind,
        statusCode: error.statusCode,
        errorCode: 'control_plane_unconfigured',
      });
      return;
    }
    sendError(res, 500, 'control_plane_signing_failed', 'Failed to sign control-plane artifact.');
    recordControlPlaneAuditErrorBackground(req, {
      kind,
      statusCode: 500,
      errorCode: 'control_plane_signing_failed',
    });
  }
}
