import { URL } from 'node:url';
import {
  BROWSER_RELAY_PROTOCOL_VERSION_V2,
  isBrowserRelayOwnerV2,
  type BrowserRelayLeaseApprovedV2,
  type BrowserRelayLeaseRequestV2,
  type BrowserRelayOwnerV2,
} from '../../../shared/contract/browserRelay';

type NormalizedDomainScope = { kind: 'origin' | 'host'; value: string };

export function sameBrowserRelayOwner(a: BrowserRelayOwnerV2, b: BrowserRelayOwnerV2): boolean {
  return a.surfaceSessionId === b.surfaceSessionId
    && a.conversationId === b.conversationId
    && a.runId === b.runId
    && a.agentId === b.agentId;
}

export function isBrowserRelayOpaqueRef(value: unknown): value is string {
  return typeof value === 'string'
    && value === value.trim()
    && value.length >= 3
    && value.length <= 512
    && !/^\d+$/.test(value);
}

export function isBrowserRelayScopeSubset(candidate: unknown, allowed: string[]): candidate is string[] {
  return Array.isArray(candidate)
    && candidate.length > 0
    && candidate.every((scope) => typeof scope === 'string' && allowed.includes(scope));
}

export function isBrowserRelayDomainScopeSubset(candidate: unknown, allowed: string[]): candidate is string[] {
  if (!Array.isArray(candidate) || candidate.length === 0) return false;
  return candidate.every((scope) => {
    if (typeof scope !== 'string') return false;
    if (allowed.includes(scope)) return true;
    const normalized = normalizeDomainScope(scope);
    if (!normalized) return false;
    if (allowed.includes('selected-tab-origin') && normalized.kind === 'origin') return true;
    return allowed.some((allowedScope) => domainScopeContains(normalized, allowedScope));
  });
}

export function browserRelayScopesAllowUrl(domainScopes: string[], value: string): boolean {
  try {
    const parsed = new URL(value);
    const origin = parsed.origin.toLowerCase();
    const hostname = parsed.hostname.toLowerCase();
    return domainScopes.some((scope) => {
      const normalized = scope.trim().toLowerCase();
      if (normalized.startsWith('origin:')) return normalized.slice('origin:'.length) === origin;
      if (normalized.startsWith('host:')) return normalized.slice('host:'.length) === hostname;
      if (normalized.includes('://')) return new URL(normalized).origin.toLowerCase() === origin;
      return normalized === hostname;
    });
  } catch {
    return false;
  }
}

export function validateBrowserRelayLeaseApproval(
  message: BrowserRelayLeaseApprovedV2,
  request: BrowserRelayLeaseRequestV2,
  now = Date.now(),
): string | null {
  if (message.protocolVersion !== BROWSER_RELAY_PROTOCOL_VERSION_V2
    || !isBrowserRelayOwnerV2(message)
    || !sameBrowserRelayOwner(message, request)) {
    return 'Relay approval did not match the pending owner or protocol.';
  }
  if (!Number.isFinite(message.approvedAt)
    || message.approvedAt <= 0
    || message.approvedAt > request.consentDeadlineAt
    || message.approvedAt > now + 5_000
    || now > request.consentDeadlineAt
    || !Number.isFinite(message.expiresAt)
    || message.expiresAt > request.expiresAt
    || message.expiresAt <= now
    || message.approvedAt > message.expiresAt) {
    return 'Relay approval was outside the pending consent or lease deadline.';
  }
  if (!isBrowserRelayDomainScopeSubset(message.domainScopes, request.domainScopes)
    || !isBrowserRelayScopeSubset(message.actionScopes, request.actionScopes)) {
    return 'Relay approval expanded the pending domain or action scope.';
  }
  if (!isBrowserRelayOpaqueRef(message.leaseId) || !isBrowserRelayOpaqueRef(message.approvalRef)) {
    return 'Relay approval references were missing or malformed.';
  }
  return validatePlacement(message);
}

function validatePlacement(message: BrowserRelayLeaseApprovedV2): string | null {
  const placement = (message as { placement?: unknown }).placement;
  if (!placement || typeof placement !== 'object' || Array.isArray(placement)) {
    return 'Relay approval placement was missing.';
  }
  const value = placement as Record<string, unknown>;
  for (const field of ['browserInstanceRef', 'tabRef', 'agentWindowRef', 'originalWindowRef', 'documentRevision']) {
    if (!isBrowserRelayOpaqueRef(value[field])) return `Relay approval placement ${field} was malformed.`;
  }
  if (!Number.isSafeInteger(value.originalIndex)
    || (value.originalIndex as number) < 0
    || (value.originalIndex as number) > 100_000
    || typeof value.originalPinned !== 'boolean'
    || typeof value.originalActive !== 'boolean') {
    return 'Relay approval original tab placement was malformed.';
  }
  if (typeof value.origin !== 'string'
    || !isExactHttpOrigin(value.origin)
    || !browserRelayScopesAllowUrl(message.domainScopes, value.origin)) {
    return 'Relay approval origin did not match the approved domain scope.';
  }
  return null;
}

function domainScopeContains(candidate: NormalizedDomainScope, allowedScope: string): boolean {
  const allowed = normalizeDomainScope(allowedScope);
  if (!allowed) return false;
  if (allowed.kind === candidate.kind) return allowed.value === candidate.value;
  if (candidate.kind !== 'origin' || allowed.kind !== 'host') return false;
  try {
    return new URL(candidate.value).hostname.toLowerCase() === allowed.value;
  } catch {
    return false;
  }
}

function normalizeDomainScope(scope: string): NormalizedDomainScope | null {
  const trimmed = scope.trim().toLowerCase();
  if (!trimmed || trimmed.includes('*') || trimmed === 'selected-tab-origin') return null;
  const originValue = trimmed.startsWith('origin:') ? trimmed.slice('origin:'.length) : trimmed;
  try {
    if (originValue.includes('://')) {
      const parsed = new URL(originValue);
      if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
        || parsed.username || parsed.password) return null;
      return { kind: 'origin', value: parsed.origin.toLowerCase() };
    }
    const hostValue = originValue.startsWith('host:') ? originValue.slice('host:'.length) : originValue;
    const parsed = new URL(`https://${hostValue}`);
    if (!parsed.hostname || parsed.pathname !== '/' || parsed.search || parsed.hash) return null;
    return { kind: 'host', value: parsed.hostname.toLowerCase() };
  } catch {
    return null;
  }
}

function isExactHttpOrigin(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:')
      && !parsed.username
      && !parsed.password
      && value.toLowerCase() === parsed.origin.toLowerCase();
  } catch {
    return false;
  }
}
