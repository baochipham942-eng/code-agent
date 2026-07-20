/**
 * ADR-041 — decide and optionally short-circuit browser_action to relay engine.
 * M4: finalized with proof/pointer/redaction before returning to the agent.
 */
import type { ToolContext, ToolExecutionResult } from '../types';
import type { BrowserActionEngine } from '../../../shared/contract/desktop';
import type { ConversationExecutionIntent } from '../../../shared/contract/conversationEnvelope';
import { browserRelayService } from '../../services/infra/browserRelayService';
import { executeRelayBrowserAction } from '../../services/infra/browser/relayActionFacade';
import { getRelayBrowserProviderAdapter } from '../../services/surfaceExecution/RelayBrowserProviderAdapter';
import { resolveBrowserActionEngine } from './browserEngineRouter';
import { finalizeBrowserActionResult } from './browserActionFinalize';

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
  executionIntent?: ConversationExecutionIntent | null;
  context?: ToolContext;
}): Promise<ToolExecutionResult | null> {
  const requestedEngine = (
    typeof args.params.engine === 'string' ? args.params.engine : 'auto'
  ) as BrowserActionEngine;
  const relayIdentity = args.context?.sessionId
    && args.context.runId
    && args.context.agentId
    ? {
        conversationId: args.context.sessionId,
        runId: args.context.runId,
        agentId: args.context.agentId,
      }
    : null;
  const relayLeaseReady = relayIdentity
    ? getRelayBrowserProviderAdapter().hasReadyLease(relayIdentity)
    : false;

  const route = resolveBrowserActionEngine({
    requestedEngine,
    targetUrl: args.url,
    relay: browserRelayService.getState(),
    managedAvailable: true,
    // 本轮绑定 Desktop Browser workbench = 复用用户自己浏览器的登录态
    intent: args.executionIntent?.browserSessionMode === 'desktop' ? 'login_reuse' : undefined,
    relayLeaseReady,
  });

  if (
    route.recovery
    && (requestedEngine === 'relay' || requestedEngine === 'managed')
    && route.recovery.selectedEngine === null
  ) {
    if (requestedEngine === 'relay' && args.action === 'launch') {
      const result = await executeRelayBrowserAction({
        action: args.action,
        relayDomainScopes: Array.isArray(args.params.relayDomainScopes)
          ? args.params.relayDomainScopes.filter((value): value is string => typeof value === 'string')
          : undefined,
        relayActionScopes: Array.isArray(args.params.relayActionScopes)
          ? args.params.relayActionScopes.filter((value): value is string => typeof value === 'string')
          : undefined,
        relayLeaseTtlMs: typeof args.params.relayLeaseTtlMs === 'number'
          ? args.params.relayLeaseTtlMs
          : undefined,
      }, args.context);
      return finalizeBrowserActionResult({
        result,
        action: args.action,
        params: args.params,
        context: args.context,
        provider: 'browser-relay',
        engineRoute: route,
        recovery: result.success ? null : route.recovery,
      });
    }
    return finalizeBrowserActionResult({
      result: {
        success: false,
        error: route.recovery.reason || route.recovery.recommendedAction,
        metadata: {
          engineRoute: route,
          recovery: route.recovery,
          provider: requestedEngine === 'relay' ? 'browser-relay' : 'system-chrome-cdp',
        },
      },
      action: args.action,
      params: args.params,
      context: args.context,
      provider: requestedEngine === 'relay' ? 'browser-relay' : 'system-chrome-cdp',
      engineRoute: route,
      recovery: route.recovery,
      notes: ['engine routing blocked; follow recovery.recommendedAction'],
    });
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
    fullPage: args.params.fullPage === true,
    formData: args.params.formData && typeof args.params.formData === 'object'
      ? args.params.formData as Record<string, string>
      : undefined,
    width: typeof args.params.width === 'number' ? args.params.width : undefined,
    height: typeof args.params.height === 'number' ? args.params.height : undefined,
    timeout: typeof args.params.timeout === 'number' ? args.params.timeout : undefined,
    targetRef: args.params.targetRef,
    relayDomainScopes: Array.isArray(args.params.relayDomainScopes)
      ? args.params.relayDomainScopes.filter((value): value is string => typeof value === 'string')
      : undefined,
    relayActionScopes: Array.isArray(args.params.relayActionScopes)
      ? args.params.relayActionScopes.filter((value): value is string => typeof value === 'string')
      : undefined,
    relayLeaseTtlMs: typeof args.params.relayLeaseTtlMs === 'number'
      ? args.params.relayLeaseTtlMs
      : undefined,
  }, args.context);

  const recovery = result.success
    ? null
    : {
        code: typeof result.metadata?.capability === 'string'
          ? `relay_${result.metadata.capability}`
          : 'relay_action_failed',
        requestedEngine,
        selectedEngine: 'relay' as const,
        recoverable: true,
        recommendedAction: result.metadata?.capability === 'managed_only'
          ? 'use_engine_managed_or_profile_import'
          : 'attach_browser_tab_or_retry',
        availableEngines: ['auto', 'managed', 'relay'] as BrowserActionEngine[],
        reason: result.error || 'Relay action failed',
      };

  return finalizeBrowserActionResult({
    result: {
      ...result,
      metadata: {
        ...(result.metadata || {}),
        engineRoute: route,
        recovery,
      },
    },
    action: args.action,
    params: args.params,
    context: args.context,
    provider: 'browser-relay',
    engineRoute: route,
    recovery,
    notes: route.reason ? [`engine=${route.selectedEngine} (${route.reason})`] : undefined,
  });
}
