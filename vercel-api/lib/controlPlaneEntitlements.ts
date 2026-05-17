import type { CloudConfigPayload } from './controlPlanePayloads';
import type { ControlPlaneRequestLike } from './controlPlaneEnvelope';

type EntitlementPolicy = NonNullable<CloudConfigPayload['entitlement']>;
type EntitlementStatus = EntitlementPolicy['status'];

interface ControlPlaneSubject {
  id: string;
  email?: string;
  source: 'server_token_map';
}

interface SubjectEntitlementMapping {
  subject: {
    id: string;
    email?: string;
  };
  entitlement: EntitlementPolicy;
}

type SubjectEntitlementMap = Record<string, SubjectEntitlementMapping>;

function readEnv(env: NodeJS.ProcessEnv, names: string[]): string | null {
  for (const name of names) {
    const value = env[name];
    if (value && value.trim().length > 0) {
      return value;
    }
  }
  return null;
}

function readBooleanEnv(env: NodeJS.ProcessEnv, names: string[]): boolean {
  const value = readEnv(env, names);
  if (!value) {
    return false;
  }
  return /^(1|true|yes|required)$/i.test(value.trim());
}

function getHeader(req: ControlPlaneRequestLike, name: string): string | null {
  const headers = req.headers ?? {};
  const value = headers[name] ?? headers[name.toLowerCase()] ?? headers[name.toUpperCase()];
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }
  return value ?? null;
}

function getBearerToken(req: ControlPlaneRequestLike): string | null {
  const value = getHeader(req, 'authorization');
  const match = value?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

function readSubjectEntitlementMap(env: NodeJS.ProcessEnv): SubjectEntitlementMap | null {
  const raw = readEnv(env, [
    'CONTROL_PLANE_ENTITLEMENT_TOKEN_MAP_JSON',
    'CODE_AGENT_CONTROL_PLANE_ENTITLEMENT_TOKEN_MAP_JSON',
  ]);
  if (!raw) {
    return null;
  }

  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('CONTROL_PLANE_ENTITLEMENT_TOKEN_MAP_JSON must be a JSON object.');
  }

  return parsed as SubjectEntitlementMap;
}

function isValidStatus(value: string): value is EntitlementStatus {
  return value === 'active' || value === 'trial' || value === 'expired' || value === 'revoked';
}

function isValidMapping(value: SubjectEntitlementMapping | undefined): value is SubjectEntitlementMapping {
  if (!value || typeof value !== 'object') {
    return false;
  }
  if (!value.subject || typeof value.subject.id !== 'string' || value.subject.id.trim().length === 0) {
    return false;
  }
  const entitlement = value.entitlement;
  return Boolean(
    entitlement
      && typeof entitlement.plan === 'string'
      && Array.isArray(entitlement.capabilities)
      && isValidStatus(entitlement.status),
  );
}

function revokedEntitlement(reason: string): EntitlementPolicy {
  return {
    status: 'revoked',
    plan: 'unauthenticated',
    capabilities: [],
    reason,
  };
}

function applySubjectEntitlement(
  payload: CloudConfigPayload,
  subject: ControlPlaneSubject,
  entitlement: EntitlementPolicy,
): CloudConfigPayload {
  return {
    ...payload,
    subject,
    entitlement,
  };
}

function applyFailClosedEntitlement(payload: CloudConfigPayload, reason: string): CloudConfigPayload {
  return {
    ...payload,
    subject: undefined,
    entitlement: revokedEntitlement(reason),
  };
}

export function applyServerEntitlementGate(
  req: ControlPlaneRequestLike,
  payload: CloudConfigPayload,
  env: NodeJS.ProcessEnv = process.env,
): CloudConfigPayload {
  const tokenMap = readSubjectEntitlementMap(env);
  const authRequired = readBooleanEnv(env, [
    'CONTROL_PLANE_ENTITLEMENT_REQUIRED',
    'CODE_AGENT_CONTROL_PLANE_ENTITLEMENT_REQUIRED',
  ]);

  if (!authRequired && !tokenMap) {
    return payload;
  }

  const token = getBearerToken(req);
  if (!token) {
    return applyFailClosedEntitlement(payload, 'missing_verified_subject');
  }

  const mapping = tokenMap?.[token];
  if (!isValidMapping(mapping)) {
    return applyFailClosedEntitlement(payload, 'invalid_verified_subject');
  }

  return applySubjectEntitlement(
    payload,
    {
      id: mapping.subject.id,
      ...(mapping.subject.email ? { email: mapping.subject.email } : {}),
      source: 'server_token_map',
    },
    mapping.entitlement,
  );
}
