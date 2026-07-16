/**
 * ADR-041 — decide and optionally short-circuit browser_action to relay engine.
 */
import type { ToolExecutionResult } from '../types';
import type { BrowserActionEngine } from '../../../shared/contract/desktop';
import { browserRelayService } from '../../services/infra/browserRelayService';
import { executeRelayBrowserAction } from '../../services/infra/browser/relayActionFacade';
import { resolveBrowserActionEngine } from './browserEngineRouter';

const MANAGED_ONLY_ACTIONS = new Set([
  'list_profiles',
  'import_profile_cookies',
  'clear_cookies',
  'export_storage_state',
  'import_storage_state',
]);

export async function maybeDispatchRelayBrowserAction(args: {
  action: string;
  params: Record<string, unknown>;
  url?: string;
  executionIntent?: string | null;
}): Promise<ToolExecutionResult | null> {
  const requestedEngine = (
    typeof args.params.engine === 'string' ? args.params.engine : 'auto'
  ) as BrowserActionEngine;

  const route = resolveBrowserActionEngine({
    requestedEngine,
    targetUrl: args.url,
    relay: browserRelayService.getState(),
    managedAvailable: true,
    intent: args.executionIntent === 'browser_login_reuse' ? 'login_reuse' : undefined,
  });

  if (
    route.recovery
    && (requestedEngine === 'relay' || requestedEngine === 'managed')
    && route.recovery.selectedEngine === null
  ) {
    return {
      success: false,
      error: route.recovery.reason || route.recovery.recommendedAction,
      metadata: { engineRoute: route, recovery: route.recovery },
    };
  }

  if (route.selectedEngine !== 'relay' || MANAGED_ONLY_ACTIONS.has(args.action)) {
    return null;
  }

  const result = await executeRelayBrowserAction({
    action: args.action,
    url: typeof args.params.url === 'string' ? args.params.url : args.url,
    selector: typeof args.params.selector === 'string' ? args.params.selector : undefined,
    text: typeof args.params.text === 'string' ? args.params.text : undefined,
    key: typeof args.params.key === 'string' ? args.params.key : undefined,
    direction: args.params.direction === 'up' || args.params.direction === 'down'
      ? args.params.direction
      : undefined,
    amount: typeof args.params.amount === 'number' ? args.params.amount : undefined,
    tabId: typeof args.params.tabId === 'string' || typeof args.params.tabId === 'number'
      ? args.params.tabId
      : undefined,
    fullPage: args.params.fullPage === true,
    formData: args.params.formData && typeof args.params.formData === 'object'
      ? args.params.formData as Record<string, string>
      : undefined,
    width: typeof args.params.width === 'number' ? args.params.width : undefined,
    height: typeof args.params.height === 'number' ? args.params.height : undefined,
  });

  return {
    ...result,
    metadata: {
      ...(result.metadata || {}),
      engineRoute: route,
    },
  };
}
