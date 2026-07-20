/**
 * ADR-041 — deterministic Managed vs Relay engine routing for browser_action.
 */
import type {
  BrowserActionEngine,
  BrowserEngineRecovery,
  BrowserEngineRouteDecision,
  ManagedBrowserExternalBridgeState,
} from '../../../shared/contract/desktop';

export interface BrowserEngineRouteInput {
  requestedEngine?: BrowserActionEngine | null;
  targetUrl?: string | null;
  intent?: 'login_reuse' | 'automation' | 'preview' | 'unknown' | null;
  requireIsolatedProfile?: boolean;
  isCiOrTest?: boolean;
  relay?: Pick<
    ManagedBrowserExternalBridgeState,
    'status' | 'attachedTabCount' | 'enabled'
  > | null;
  /**
   * True only when the current Surface owner holds a live Relay tab lease.
   * Extension connection and attached-tab counts are transport state, not authorization.
   */
  relayLeaseReady?: boolean;
  managedAvailable?: boolean;
}

function isLocalOrPreviewUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    if (parsed.protocol === 'file:') return true;
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.local')) {
      return true;
    }
    return false;
  } catch {
    return /^(https?:\/\/)?(localhost|127\.0\.0\.1|\[::1\])/i.test(url);
  }
}

function recovery(args: {
  code: string;
  requestedEngine: BrowserActionEngine;
  selectedEngine: BrowserActionEngine | null;
  recommendedAction: string;
  availableEngines: BrowserActionEngine[];
  reason: string;
}): BrowserEngineRecovery {
  return {
    code: args.code,
    requestedEngine: args.requestedEngine,
    selectedEngine: args.selectedEngine,
    recoverable: true,
    recommendedAction: args.recommendedAction,
    availableEngines: args.availableEngines,
    reason: args.reason,
  };
}

export function resolveBrowserActionEngine(
  input: BrowserEngineRouteInput,
): BrowserEngineRouteDecision {
  const requested: BrowserActionEngine = input.requestedEngine || 'auto';
  const relayConnected = input.relay?.status === 'connected';
  const relayReady = relayConnected && input.relayLeaseReady === true;
  const managedAvailable = input.managedAvailable !== false;
  const available: BrowserActionEngine[] = ['auto'];
  if (managedAvailable) available.push('managed');
  if (relayReady) available.push('relay');

  if (requested === 'managed') {
    if (!managedAvailable) {
      return {
        selectedEngine: 'managed',
        requestedEngine: requested,
        reason: 'explicit_managed_unavailable',
        recovery: recovery({
          code: 'managed_unavailable',
          requestedEngine: requested,
          selectedEngine: null,
          recommendedAction: 'start_managed_browser',
          availableEngines: available,
          reason: 'Managed browser is not available.',
        }),
      };
    }
    return {
      selectedEngine: 'managed',
      requestedEngine: requested,
      reason: 'explicit_managed',
    };
  }

  if (requested === 'relay') {
    if (!relayReady) {
      return {
        selectedEngine: 'relay',
        requestedEngine: requested,
        reason: 'explicit_relay_unavailable',
        recovery: recovery({
          code: relayConnected ? 'BROWSER_TAB_BORROW_REQUIRED' : 'relay_not_connected',
          requestedEngine: requested,
          selectedEngine: null,
          recommendedAction: relayConnected ? 'borrow_browser_tab' : 'start_browser_relay',
          availableEngines: available,
          reason: relayConnected
            ? 'Browser relay is connected but this owner has no valid tab lease.'
            : 'Browser relay extension is not connected.',
        }),
      };
    }
    return {
      selectedEngine: 'relay',
      requestedEngine: requested,
      reason: 'explicit_relay',
    };
  }

  // auto
  if (input.requireIsolatedProfile || input.isCiOrTest || input.intent === 'preview' || input.intent === 'automation') {
    return {
      selectedEngine: 'managed',
      requestedEngine: requested,
      reason: input.isCiOrTest
        ? 'auto_ci_or_test'
        : input.requireIsolatedProfile
          ? 'auto_isolated_profile'
          : 'auto_automation_or_preview',
    };
  }

  if (isLocalOrPreviewUrl(input.targetUrl)) {
    return {
      selectedEngine: 'managed',
      requestedEngine: requested,
      reason: 'auto_local_url',
    };
  }

  if (input.intent === 'login_reuse') {
    if (relayReady) {
      return {
        selectedEngine: 'relay',
        requestedEngine: requested,
        reason: 'auto_login_reuse_relay',
      };
    }
    return {
      selectedEngine: 'managed',
      requestedEngine: requested,
      reason: 'auto_login_reuse_managed_recovery',
      recovery: recovery({
        code: relayConnected ? 'BROWSER_TAB_BORROW_REQUIRED' : 'relay_not_connected',
        requestedEngine: requested,
        selectedEngine: 'managed',
        recommendedAction: relayConnected
          ? 'borrow_browser_tab_or_import_cookies'
          : 'start_browser_relay_or_import_cookies',
        availableEngines: available,
        reason: relayConnected
          ? 'Login reuse requires a valid owner-scoped Relay tab lease or profile cookie import.'
          : 'Login reuse requires a connected Relay extension or profile cookie import.',
      }),
    };
  }

  return {
    selectedEngine: 'managed',
    requestedEngine: requested,
    reason: 'auto_default_managed',
  };
}
