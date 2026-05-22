// ============================================================================
// Control plane envelope verification
// ============================================================================

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type {
  ControlPlaneArtifactKind,
  ControlPlaneDiagnostic,
  ControlPlaneEnvelope,
  ControlPlaneTrustResult,
} from '../../../shared/contract/controlPlane';

export type ControlPlanePublicKeys = Record<string, string>;
export type SupportedControlPlaneArtifactKind = ControlPlaneArtifactKind | 'runtime_assets_manifest';

export interface VerifyControlPlaneEnvelopeOptions {
  kind: SupportedControlPlaneArtifactKind;
  publicKeys?: ControlPlanePublicKeys;
  requireSignature?: boolean;
  allowUnsigned?: boolean;
  now?: number;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function isString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalizePemLiteral(value: string): string {
  return value.trim().replace(/\\n/g, '\n');
}

function diagnostic(
  code: string,
  message: string,
  extra: Partial<ControlPlaneDiagnostic> = {},
): ControlPlaneDiagnostic {
  return {
    severity: extra.severity ?? 'error',
    code,
    message,
    ...(extra.expected ? { expected: extra.expected } : {}),
    ...(extra.actual ? { actual: extra.actual } : {}),
  };
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

export function isControlPlaneEnvelope(value: unknown): value is ControlPlaneEnvelope {
  const record = asRecord(value);
  return record.schemaVersion === 1
    && isString(record.kind)
    && isString(record.expiresAt)
    && isString(record.contentHash)
    && Object.prototype.hasOwnProperty.call(record, 'payload');
}

function verifySignature(
  envelope: ControlPlaneEnvelope,
  publicKeyPem: string,
): boolean {
  if (!envelope.signature) {
    return false;
  }
  try {
    return crypto.verify(
      null,
      Buffer.from(buildControlPlaneSigningPayload(envelope)),
      publicKeyPem,
      Buffer.from(envelope.signature, 'base64'),
    );
  } catch {
    return false;
  }
}

export function verifyControlPlaneEnvelope<TPayload>(
  value: unknown,
  options: VerifyControlPlaneEnvelopeOptions,
): ControlPlaneTrustResult<TPayload> {
  const diagnostics: ControlPlaneDiagnostic[] = [];

  if (!isControlPlaneEnvelope(value)) {
    return {
      trusted: false,
      diagnostics: [
        diagnostic('invalid_envelope', 'Control plane response must use schemaVersion:1 with payload, kind, expiresAt, and contentHash.'),
      ],
    };
  }

  const envelope = value as ControlPlaneEnvelope<TPayload>;
  if (envelope.kind !== options.kind) {
    diagnostics.push(diagnostic('kind_mismatch', 'Control plane envelope kind does not match the requested artifact.', {
      expected: options.kind,
      actual: envelope.kind,
    }));
  }

  if (!/^sha256:[a-f0-9]{64}$/i.test(envelope.contentHash)) {
    diagnostics.push(diagnostic('invalid_content_hash', 'Control plane envelope contentHash must use sha256:<64 hex chars>.', {
      actual: envelope.contentHash,
    }));
  }

  const actualHash = buildControlPlaneContentHash(envelope.payload);
  if (envelope.contentHash.toLowerCase() !== actualHash) {
    diagnostics.push(diagnostic('content_hash_mismatch', 'Control plane envelope contentHash does not match payload.', {
      expected: envelope.contentHash,
      actual: actualHash,
    }));
  }

  const expiresAtMs = Date.parse(envelope.expiresAt);
  if (!Number.isFinite(expiresAtMs)) {
    diagnostics.push(diagnostic('invalid_expires_at', 'Control plane envelope expiresAt must be a valid date string.', {
      actual: envelope.expiresAt,
    }));
  } else if (expiresAtMs <= (options.now ?? Date.now())) {
    diagnostics.push(diagnostic('expired_envelope', 'Control plane envelope is expired.', {
      actual: envelope.expiresAt,
    }));
  }

  const requireSignature = options.requireSignature ?? !options.allowUnsigned;
  if (requireSignature || envelope.signature) {
    if (!envelope.signature) {
      diagnostics.push(diagnostic('missing_signature', 'Control plane envelope signature is required.'));
    }
    if (!envelope.keyId) {
      diagnostics.push(diagnostic('missing_key_id', 'Control plane envelope keyId is required when signature verification is enabled.'));
    } else {
      const publicKey = options.publicKeys?.[envelope.keyId];
      if (!publicKey) {
        diagnostics.push(diagnostic('unknown_key_id', 'Control plane envelope keyId is not configured locally.', {
          actual: envelope.keyId,
        }));
      } else if (!verifySignature(envelope, publicKey)) {
        diagnostics.push(diagnostic('invalid_signature', 'Control plane envelope signature verification failed.', {
          actual: envelope.keyId,
        }));
      }
    }
  }

  const trusted = diagnostics.every((entry) => entry.severity !== 'error');
  return {
    trusted,
    ...(trusted ? { payload: envelope.payload } : {}),
    diagnostics,
    contentHash: actualHash,
    ...(envelope.keyId ? { keyId: envelope.keyId } : {}),
    expiresAt: envelope.expiresAt,
  };
}

export function getControlPlanePublicKeysFromEnv(): ControlPlanePublicKeys {
  const rawJson = process.env.CODE_AGENT_CONTROL_PLANE_PUBLIC_KEYS;
  if (rawJson) {
    try {
      const parsed = JSON.parse(rawJson) as Record<string, unknown>;
      return Object.fromEntries(
        Object.entries(parsed)
          .filter((entry): entry is [string, string] => isString(entry[0]) && isString(entry[1]))
          .map(([keyId, publicKey]) => [keyId, normalizePemLiteral(publicKey)]),
      );
    } catch {
      return {};
    }
  }

  const keyId = process.env.CODE_AGENT_CONTROL_PLANE_KEY_ID;
  const publicKey = process.env.CODE_AGENT_CONTROL_PLANE_PUBLIC_KEY;
  if (keyId && publicKey) {
    return { [keyId]: normalizePemLiteral(publicKey) };
  }
  return getControlPlanePublicKeysFromFile();
}

function parsePublicKeysFile(content: string): ControlPlanePublicKeys {
  const parsed = JSON.parse(content) as Record<string, unknown>;
  const keysSource = parsed.keys && typeof parsed.keys === 'object' && !Array.isArray(parsed.keys)
    ? parsed.keys as Record<string, unknown>
    : parsed;
  return Object.fromEntries(
    Object.entries(keysSource)
      .filter((entry): entry is [string, string] => isString(entry[0]) && isString(entry[1]))
      .map(([keyId, publicKey]) => [keyId, normalizePemLiteral(publicKey)]),
  );
}

function getControlPlanePublicKeyFileCandidates(): string[] {
  const candidates = [
    process.env.CODE_AGENT_CONTROL_PLANE_PUBLIC_KEYS_FILE,
  ];

  const scriptPath = process.argv[1];
  if (scriptPath) {
    candidates.push(path.join(path.dirname(scriptPath), 'control-plane-public-keys.json'));
  }
  candidates.push(
    path.join(process.cwd(), 'dist/web/control-plane-public-keys.json'),
    path.join(process.cwd(), 'control-plane-public-keys.json'),
  );

  return [...new Set(candidates.filter((candidate): candidate is string => Boolean(candidate)))];
}

export function getControlPlanePublicKeysFromFile(): ControlPlanePublicKeys {
  for (const candidate of getControlPlanePublicKeyFileCandidates()) {
    try {
      if (!fs.existsSync(candidate)) {
        continue;
      }
      const keys = parsePublicKeysFile(fs.readFileSync(candidate, 'utf8'));
      if (Object.keys(keys).length > 0) {
        return keys;
      }
    } catch {
      continue;
    }
  }
  return {};
}
