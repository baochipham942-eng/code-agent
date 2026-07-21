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
import {
  resolveBrowserActionEngine,
  type BrowserEngineRouteTarget,
} from './browserEngineRouter';
import { finalizeBrowserActionResult } from './browserActionFinalize';
import { requestBrowserUploadApproval } from './browserUploadApproval';

const MANAGED_ONLY_ACTIONS = new Set([
  'list_profiles',
  'import_profile_cookies',
  'clear_cookies',
  'export_storage_state',
  'import_storage_state',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasNativeTargetKey(value: Record<string, unknown>): boolean {
  return Object.keys(value).some((key) => {
    const normalized = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
    return normalized.endsWith('tabid')
      || normalized.endsWith('windowid')
      || normalized.endsWith('debuggerid');
  });
}

function routeTargetFromBinding(
  leased: Omit<BrowserEngineRouteTarget, 'identityStatus'> | null,
  targetRef: unknown,
): BrowserEngineRouteTarget | null {
  if (!leased) return null;
  if (targetRef === undefined || targetRef === null) {
    return { ...leased, identityStatus: 'host_derived' };
  }
  if (!isRecord(targetRef) || hasNativeTargetKey(targetRef)) {
    return { ...leased, identityStatus: 'ambiguous' };
  }
  const tabRef = typeof targetRef.tabRef === 'string' ? targetRef.tabRef : leased.tabRef;
  const documentRevision = typeof targetRef.documentRevision === 'string'
    ? targetRef.documentRevision
    : leased.documentRevision;
  const identityStatus = documentRevision !== leased.documentRevision
    ? 'stale'
    : tabRef !== leased.tabRef
      ? 'mismatch'
      : typeof targetRef.tabRef === 'string' && typeof targetRef.documentRevision === 'string'
        ? 'verified'
        : 'host_derived';
  return { ...leased, tabRef, documentRevision, identityStatus };
}

function ownerBoundTargetRef(
  targetRef: unknown,
  target: BrowserEngineRouteTarget | null,
): unknown {
  if (!isRecord(targetRef) || !target || target.identityStatus === 'ambiguous') return targetRef;
  return {
    ...targetRef,
    tabRef: target.tabRef,
    documentRevision: target.documentRevision,
  };
}

function routeTargetWithDestinationFence(
  source: BrowserEngineRouteTarget | null,
  destination: BrowserEngineRouteTarget | null,
  action: string,
): BrowserEngineRouteTarget | null {
  if (action !== 'drag' || !destination) return source;
  if (destination.identityStatus === 'ambiguous'
    || destination.identityStatus === 'mismatch'
    || destination.identityStatus === 'stale') {
    return destination;
  }
  return source;
}

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
  const relayAdapter = getRelayBrowserProviderAdapter();
  const relayLeaseReady = relayIdentity
    ? relayAdapter.hasReadyLease(relayIdentity)
    : false;
  const relayBinding = relayIdentity ? relayAdapter.getBinding(relayIdentity) : null;
  const leasedTarget = relayBinding
    ? {
        browserInstanceId: relayBinding.target.browserInstanceId,
        windowRef: relayBinding.target.windowRef,
        tabRef: relayBinding.target.tabRef,
        origin: relayBinding.target.origin || '',
        documentRevision: relayBinding.target.documentRevision,
      }
    : null;
  const sourceRouteTarget = routeTargetFromBinding(leasedTarget, args.params.targetRef);
  const destinationRouteTarget = routeTargetFromBinding(
    leasedTarget,
    args.params.destinationTargetRef,
  );
  const routeTarget = routeTargetWithDestinationFence(
    sourceRouteTarget,
    destinationRouteTarget,
    args.action,
  );
  const routeOwner = relayIdentity
    ? {
        conversationId: relayIdentity.conversationId,
        runId: relayIdentity.runId,
        agentId: relayIdentity.agentId,
      }
    : null;

  const route = resolveBrowserActionEngine({
    requestedEngine,
    action: args.action,
    targetUrl: typeof args.params.url === 'string' ? args.params.url : args.url,
    target: routeTarget,
    owner: routeOwner,
    relay: browserRelayService.getState(),
    managedAvailable: true,
    requireIsolatedProfile: args.executionIntent?.browserSessionMode === 'managed',
    // 本轮绑定 Desktop Browser workbench = 复用用户自己浏览器的登录态
    intent: args.executionIntent?.browserSessionMode === 'desktop' ? 'login_reuse' : undefined,
    relayLeaseReady,
    relayAuthorization: relayBinding && routeOwner && leasedTarget
      ? {
          owner: {
            conversationId: relayBinding.identity.conversationId,
            runId: relayBinding.identity.runId,
            agentId: relayBinding.identity.agentId,
          },
          live: relayLeaseReady,
          leaseState: relayBinding.lease.state,
          expiresAt: relayBinding.lease.expiresAt,
          actionScopes: relayBinding.lease.actionScopes,
          domainScopes: relayBinding.lease.domainScopes,
          target: { ...leasedTarget, identityStatus: 'verified' },
        }
      : null,
  });

  if (
    route.recovery
    && (requestedEngine === 'relay' || requestedEngine === 'managed')
    && route.recovery.selectedEngine === null
  ) {
    if (requestedEngine === 'relay'
      && args.action === 'launch'
      && route.recovery.code === 'BROWSER_TAB_BORROW_REQUIRED') {
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

  const relayContext = args.context;
  if (!relayContext) {
    return finalizeBrowserActionResult({
      result: {
        success: false,
        error: 'Relay actions require an owner-scoped ToolContext.',
        metadata: {
          provider: 'browser-relay',
          engine: 'relay',
          code: 'SURFACE_TARGET_NOT_OWNED',
          engineRoute: route,
        },
      },
      action: args.action,
      params: args.params,
      provider: 'browser-relay',
      engineRoute: route,
    });
  }

  if (args.action === 'handle_dialog'
    && args.params.dialogAction === 'accept') {
    const approved = await relayContext.requestPermission({
      type: 'dangerous_command',
      tool: 'browser_action.handle_dialog',
      forceConfirm: true,
      dangerLevel: 'danger',
      reason: '接受网页对话框可能确认支付、删除或授权，必须对当前 Relay 动作显式批准。',
      details: {
        action: 'handle_dialog',
        dialogAction: 'accept',
        hasPromptText: typeof args.params.dialogPromptText === 'string',
      },
    });
    if (!approved) {
      return finalizeBrowserActionResult({
        result: {
          success: false,
          error: 'Browser dialog acceptance was not approved.',
          metadata: {
            provider: 'browser-relay',
            engine: 'relay',
            code: 'SURFACE_APPROVAL_REQUIRED',
            userActionRequired: true,
            engineRoute: route,
          },
        },
        action: args.action,
        params: args.params,
        context: relayContext,
        provider: 'browser-relay',
        engineRoute: route,
      });
    }
  }

  let relayUploadApprovalToken: string | undefined;
  if (args.action === 'upload_file') {
    if (typeof args.params.uploadFilePath !== 'string' || !args.params.uploadFilePath.trim()) {
      return finalizeBrowserActionResult({
        result: {
          success: false,
          error: 'uploadFilePath is required for Relay upload_file.',
          metadata: { provider: 'browser-relay', engine: 'relay', code: 'SURFACE_POLICY_BLOCKED' },
        },
        action: args.action,
        params: args.params,
        context: relayContext,
        provider: 'browser-relay',
        engineRoute: route,
      });
    }
    const uploadTargetRef = args.params.targetRef;
    if (!isRecord(uploadTargetRef)
      || typeof uploadTargetRef.ref !== 'string'
      || !uploadTargetRef.ref.trim()
      || typeof uploadTargetRef.tabRef !== 'string'
      || !uploadTargetRef.tabRef.trim()
      || typeof uploadTargetRef.documentRevision !== 'string'
      || !uploadTargetRef.documentRevision.trim()) {
      return finalizeBrowserActionResult({
        result: {
          success: false,
          error: 'Relay upload_file requires a fresh targetRef for the exact file input; selector fallback is not allowed.',
          metadata: { provider: 'browser-relay', engine: 'relay', code: 'SURFACE_ELEMENT_REF_NOT_FOUND' },
        },
        action: args.action,
        params: args.params,
        context: relayContext,
        provider: 'browser-relay',
        engineRoute: route,
      });
    }
    const approval = await requestBrowserUploadApproval({
      filePath: args.params.uploadFilePath,
      context: relayContext,
      engine: 'relay',
    });
    if (!approval.approved || !approval.relayToken) {
      return finalizeBrowserActionResult({
        result: {
          success: false,
          error: approval.approved
            ? 'Relay upload approval token was not issued.'
            : approval.reason,
          metadata: {
            provider: 'browser-relay',
            engine: 'relay',
            code: approval.approved ? 'SURFACE_APPROVAL_INVALID' : approval.code,
            userActionRequired: true,
          },
        },
        action: args.action,
        params: args.params,
        context: relayContext,
        provider: 'browser-relay',
        engineRoute: route,
      });
    }
    relayUploadApprovalToken = approval.relayToken;
  }

  const ownerBoundSourceTargetRef = ownerBoundTargetRef(args.params.targetRef, sourceRouteTarget);
  const ownerBoundDestinationTargetRef = ownerBoundTargetRef(
    args.params.destinationTargetRef,
    destinationRouteTarget,
  );
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
    ...(ownerBoundSourceTargetRef !== undefined && ownerBoundSourceTargetRef !== null
      ? { targetRef: ownerBoundSourceTargetRef }
      : {}),
    ...(ownerBoundDestinationTargetRef !== undefined && ownerBoundDestinationTargetRef !== null
      ? { destinationTargetRef: ownerBoundDestinationTargetRef }
      : {}),
    dialogAction: args.params.dialogAction === 'accept' || args.params.dialogAction === 'dismiss'
      ? args.params.dialogAction
      : undefined,
    dialogPromptText: typeof args.params.dialogPromptText === 'string'
      ? args.params.dialogPromptText
      : undefined,
    relayUploadApprovalToken,
    relayDomainScopes: Array.isArray(args.params.relayDomainScopes)
      ? args.params.relayDomainScopes.filter((value): value is string => typeof value === 'string')
      : undefined,
    relayActionScopes: Array.isArray(args.params.relayActionScopes)
      ? args.params.relayActionScopes.filter((value): value is string => typeof value === 'string')
      : undefined,
    relayLeaseTtlMs: typeof args.params.relayLeaseTtlMs === 'number'
      ? args.params.relayLeaseTtlMs
      : undefined,
  }, relayContext);

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
    context: relayContext,
    provider: 'browser-relay',
    engineRoute: route,
    recovery,
    notes: route.reason ? [`engine=${route.selectedEngine} (${route.reason})`] : undefined,
  });
}
