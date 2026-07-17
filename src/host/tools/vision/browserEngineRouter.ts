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
  const attachedCount = input.relay?.attachedTabCount || 0;
  const relayReady = relayConnected && attachedCount > 0;
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
          code: relayConnected ? 'relay_no_attached_tab' : 'relay_not_connected',
          requestedEngine: requested,
          selectedEngine: null,
          recommendedAction: relayConnected ? 'attach_browser_tab' : 'start_browser_relay',
          availableEngines: available,
          reason: relayConnected
            ? 'Browser relay is connected but no tab is attached.'
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

  if (input.intent === 'login_reuse' || relayReady) {
    if (relayReady) {
      return {
        selectedEngine: 'relay',
        requestedEngine: requested,
        reason: input.intent === 'login_reuse' ? 'auto_login_reuse_relay' : 'auto_relay_ready',
      };
    }
    return {
      selectedEngine: 'managed',
      requestedEngine: requested,
      reason: 'auto_login_reuse_fallback_managed',
      recovery: recovery({
        code: 'prefer_relay_for_login',
        requestedEngine: requested,
        selectedEngine: 'managed',
        recommendedAction: 'start_browser_relay_or_import_cookies',
        availableEngines: available,
        reason: 'Login reuse prefers an attached Chrome tab or profile cookie import.',
      }),
    };
  }

  return {
    selectedEngine: 'managed',
    requestedEngine: requested,
    reason: 'auto_default_managed',
  };
}
