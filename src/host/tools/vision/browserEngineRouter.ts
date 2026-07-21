/**
 * ADR-041 / Surface Execution V1 — deterministic Managed vs Relay routing.
 * Relay eligibility is action-specific and owner/target/scope bound. Transport
 * attachment counts are intentionally ignored because they are not authority.
 */
import { BROWSER_RELAY_ACTION_METHODS_V2 } from '../../../shared/contract/browserRelay';
import type {
  BrowserActionEngine,
  BrowserEngineRecovery,
  BrowserEngineRouteDecision,
  ManagedBrowserExternalBridgeState,
} from '../../../shared/contract/desktop';

export interface BrowserEngineRouteOwner {
  conversationId: string;
  runId: string;
  agentId: string;
}

export interface BrowserEngineRouteTarget {
  browserInstanceId: string;
  windowRef: string;
  tabRef: string;
  origin: string;
  documentRevision?: string;
  identityStatus?: 'verified' | 'host_derived' | 'ambiguous' | 'mismatch' | 'stale';
}

export interface BrowserRelayRouteAuthorization {
  owner: BrowserEngineRouteOwner;
  live: boolean;
  leaseState: string;
  expiresAt?: number | null;
  actionScopes: readonly string[];
  domainScopes: readonly string[];
  target: BrowserEngineRouteTarget;
}

export interface BrowserEngineRouteInput {
  requestedEngine?: BrowserActionEngine | null;
  action?: string | null;
  targetUrl?: string | null;
  target?: BrowserEngineRouteTarget | null;
  owner?: BrowserEngineRouteOwner | null;
  intent?: 'login_reuse' | 'automation' | 'preview' | 'unknown' | null;
  requireIsolatedProfile?: boolean;
  isCiOrTest?: boolean;
  relay?: Pick<
    ManagedBrowserExternalBridgeState,
    'status' | 'attachedTabCount' | 'enabled'
  > | null;
  /** @deprecated A ready boolean alone is not sufficient Relay authority. */
  relayLeaseReady?: boolean;
  relayAuthorization?: BrowserRelayRouteAuthorization | null;
  managedAvailable?: boolean;
  nowMs?: number;
}

interface RelayEligibility {
  ready: boolean;
  code?: string;
  recommendedAction?: string;
  reason?: string;
}

const RELAY_SPECIAL_ACTIONS = new Set(['close', 'list_tabs']);

function isLocalOrPreviewUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    if (parsed.protocol === 'file:') return true;
    return host === 'localhost'
      || host === '127.0.0.1'
      || host === '::1'
      || host.endsWith('.local');
  } catch {
    return /^(https?:\/\/)?(localhost|127\.0\.0\.1|\[::1\])/i.test(url);
  }
}

function sameOwner(left: BrowserEngineRouteOwner, right: BrowserEngineRouteOwner): boolean {
  return left.conversationId === right.conversationId
    && left.runId === right.runId
    && left.agentId === right.agentId;
}

function normalizedOrigin(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
      ? parsed.origin.toLowerCase()
      : null;
  } catch {
    return null;
  }
}

function domainAllowed(scopes: readonly string[], value: string): boolean {
  const origin = normalizedOrigin(value);
  if (!origin) return false;
  const hostname = new URL(origin).hostname.toLowerCase();
  return scopes.some((scope) => {
    const normalized = scope.trim().toLowerCase();
    if (!normalized || normalized.includes('*') || normalized === 'selected-tab-origin') return false;
    if (normalized.startsWith('origin:')) return normalized.slice('origin:'.length) === origin;
    if (normalized.startsWith('host:')) return normalized.slice('host:'.length) === hostname;
    if (normalized.includes('://')) return normalizedOrigin(normalized) === origin;
    return normalized === hostname;
  });
}

function completeTarget(target: BrowserEngineRouteTarget | null | undefined): boolean {
  return Boolean(
    typeof target?.browserInstanceId === 'string'
    && target.browserInstanceId.trim()
    && typeof target.windowRef === 'string'
    && target.windowRef.trim()
    && typeof target.tabRef === 'string'
    && target.tabRef.trim()
    && normalizedOrigin(target.origin),
  );
}

function targetsMatch(
  requested: BrowserEngineRouteTarget | null | undefined,
  leased: BrowserEngineRouteTarget,
): RelayEligibility | null {
  if (!requested) {
    return {
      ready: false,
      code: 'SURFACE_TARGET_AMBIGUOUS',
      recommendedAction: 'refresh_relay_observation',
      reason: 'Relay routing requires a Host-derived target identity.',
    };
  }
  if (requested.identityStatus === 'ambiguous') {
    return {
      ready: false,
      code: 'SURFACE_TARGET_AMBIGUOUS',
      recommendedAction: 'refresh_relay_observation',
      reason: 'The requested Relay target identity is ambiguous.',
    };
  }
  if (requested.identityStatus === 'stale'
    || (requested.documentRevision && requested.documentRevision !== leased.documentRevision)) {
    return {
      ready: false,
      code: 'SURFACE_STATE_STALE',
      recommendedAction: 'refresh_relay_observation',
      reason: 'The requested Relay target belongs to an older document revision.',
    };
  }
  if (requested.identityStatus === 'mismatch'
    || requested.browserInstanceId !== leased.browserInstanceId
    || requested.windowRef !== leased.windowRef
    || requested.tabRef !== leased.tabRef
    || normalizedOrigin(requested.origin) !== normalizedOrigin(leased.origin)) {
    return {
      ready: false,
      code: 'SURFACE_TARGET_NOT_OWNED',
      recommendedAction: 'reselect_owned_relay_tab',
      reason: 'The requested target is outside the owner-scoped Relay lease.',
    };
  }
  return null;
}

function relayEligibility(input: BrowserEngineRouteInput): RelayEligibility {
  const connected = input.relay?.enabled === true && input.relay.status === 'connected';
  if (!connected) {
    return {
      ready: false,
      code: 'relay_not_connected',
      recommendedAction: 'start_browser_relay',
      reason: 'Browser Relay provider is not ready.',
    };
  }
  const action = input.action?.trim();
  if (!action) {
    return {
      ready: false,
      code: 'SURFACE_TARGET_AMBIGUOUS',
      recommendedAction: 'retry_with_explicit_browser_action',
      reason: 'Relay routing requires an explicit action capability.',
    };
  }
  if (action !== 'launch'
    && !RELAY_SPECIAL_ACTIONS.has(action)
    && !(action in BROWSER_RELAY_ACTION_METHODS_V2)) {
    return {
      ready: false,
      code: 'SURFACE_CAPABILITY_UNSUPPORTED',
      recommendedAction: 'use_engine_managed',
      reason: `Relay does not support browser_action.${action}.`,
    };
  }
  const authorization = input.relayAuthorization;
  if (action === 'launch' && !authorization) {
    return {
      ready: false,
      code: 'BROWSER_TAB_BORROW_REQUIRED',
      recommendedAction: 'borrow_browser_tab',
      reason: 'Relay is ready for an explicit owner-scoped tab approval.',
    };
  }
  if (!authorization || !input.owner || !sameOwner(input.owner, authorization.owner)) {
    return {
      ready: false,
      code: authorization ? 'SURFACE_TARGET_NOT_OWNED' : 'BROWSER_TAB_BORROW_REQUIRED',
      recommendedAction: authorization ? 'reselect_owned_relay_tab' : 'borrow_browser_tab',
      reason: authorization
        ? 'The Relay lease belongs to a different Surface owner.'
        : 'A live owner-scoped Relay tab lease is required.',
    };
  }
  const now = input.nowMs ?? Date.now();
  if (!authorization.live
    || authorization.leaseState !== 'leased'
    || authorization.expiresAt === undefined
    || authorization.expiresAt === null
    || authorization.expiresAt <= now) {
    return {
      ready: false,
      code: 'BROWSER_TAB_BORROW_REQUIRED',
      recommendedAction: 'renew_or_borrow_browser_tab',
      reason: 'The owner-scoped Relay tab lease is not live.',
    };
  }
  if (!completeTarget(authorization.target)) {
    return {
      ready: false,
      code: 'SURFACE_TARGET_AMBIGUOUS',
      recommendedAction: 'refresh_relay_observation',
      reason: 'The Relay lease has no complete Host-issued target identity.',
    };
  }
  const targetMismatch = targetsMatch(input.target, authorization.target);
  if (targetMismatch) return targetMismatch;
  if (action === 'launch') return { ready: true };
  const requiredScope = action === 'close' ? 'lease:return' : action;
  if (!authorization.actionScopes.includes(requiredScope)) {
    return {
      ready: false,
      code: 'SURFACE_APPROVAL_INVALID',
      recommendedAction: 'request_relay_action_scope',
      reason: `The Relay lease does not authorize browser_action.${action}.`,
    };
  }
  const domainTarget = input.targetUrl || input.target?.origin || authorization.target.origin;
  if (!domainAllowed(authorization.domainScopes, domainTarget)) {
    return {
      ready: false,
      code: 'SURFACE_APPROVAL_INVALID',
      recommendedAction: 'request_relay_domain_scope',
      reason: 'The Relay lease does not authorize the requested target domain.',
    };
  }
  return { ready: true };
}

function recovery(args: {
  eligibility: RelayEligibility;
  requestedEngine: BrowserActionEngine;
  selectedEngine: BrowserActionEngine | null;
  availableEngines: BrowserActionEngine[];
}): BrowserEngineRecovery {
  return {
    code: args.eligibility.code || 'SURFACE_POLICY_BLOCKED',
    requestedEngine: args.requestedEngine,
    selectedEngine: args.selectedEngine,
    recoverable: true,
    recommendedAction: args.eligibility.recommendedAction || 'review_browser_engine_scope',
    availableEngines: args.availableEngines,
    reason: args.eligibility.reason,
  };
}

function managedUnavailable(
  requestedEngine: BrowserActionEngine,
  availableEngines: BrowserActionEngine[],
  reason: string,
): BrowserEngineRouteDecision {
  const eligibility: RelayEligibility = {
    ready: false,
    code: 'managed_unavailable',
    recommendedAction: 'start_managed_browser',
    reason: 'Managed browser provider is not ready.',
  };
  return {
    selectedEngine: 'managed',
    requestedEngine,
    reason,
    recovery: recovery({
      eligibility,
      requestedEngine,
      selectedEngine: null,
      availableEngines,
    }),
  };
}

export function resolveBrowserActionEngine(
  input: BrowserEngineRouteInput,
): BrowserEngineRouteDecision {
  const requested: BrowserActionEngine = input.requestedEngine || 'auto';
  const managedAvailable = input.managedAvailable !== false;
  const relay = relayEligibility(input);
  const available: BrowserActionEngine[] = ['auto'];
  if (managedAvailable) available.push('managed');
  if (relay.ready) available.push('relay');

  if (requested === 'managed') {
    if (!managedAvailable) return managedUnavailable(requested, available, 'explicit_managed_unavailable');
    return { selectedEngine: 'managed', requestedEngine: requested, reason: 'explicit_managed' };
  }

  if (requested === 'relay') {
    if (!relay.ready) {
      return {
        selectedEngine: 'relay',
        requestedEngine: requested,
        reason: relay.code === 'BROWSER_TAB_BORROW_REQUIRED'
          ? 'explicit_relay_consent_required'
          : 'explicit_relay_blocked',
        recovery: recovery({
          eligibility: relay,
          requestedEngine: requested,
          selectedEngine: null,
          availableEngines: available,
        }),
      };
    }
    return { selectedEngine: 'relay', requestedEngine: requested, reason: 'explicit_relay' };
  }

  const managedOnlyReason = input.isCiOrTest
    ? 'auto_ci_or_test'
    : input.requireIsolatedProfile
      ? 'auto_isolated_profile'
      : input.intent === 'preview' || input.intent === 'automation'
        ? 'auto_automation_or_preview'
        : isLocalOrPreviewUrl(input.targetUrl)
          ? 'auto_local_url'
          : null;
  if (managedOnlyReason) {
    return managedAvailable
      ? { selectedEngine: 'managed', requestedEngine: requested, reason: managedOnlyReason }
      : managedUnavailable(requested, available, `${managedOnlyReason}_unavailable`);
  }

  if (input.intent === 'login_reuse') {
    if (relay.ready) {
      return { selectedEngine: 'relay', requestedEngine: requested, reason: 'auto_login_reuse_relay' };
    }
    if (!managedAvailable) return managedUnavailable(requested, available, 'auto_login_reuse_unavailable');
    return {
      selectedEngine: 'managed',
      requestedEngine: requested,
      reason: 'auto_login_reuse_managed_recovery',
      recovery: recovery({
        eligibility: relay,
        requestedEngine: requested,
        selectedEngine: 'managed',
        availableEngines: available,
      }),
    };
  }

  return managedAvailable
    ? { selectedEngine: 'managed', requestedEngine: requested, reason: 'auto_default_managed' }
    : managedUnavailable(requested, available, 'auto_default_managed_unavailable');
}
