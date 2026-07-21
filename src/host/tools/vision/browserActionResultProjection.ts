import type { ToolContext, ToolExecutionResult } from '../types';
import type {
  BrowserArtifactSummary,
  BrowserService,
  BrowserTargetRef,
} from '../../services/infra/browserService.js';
import { finalizeBrowserActionResult } from './browserActionFinalize';

type BrowserActionTrace = ReturnType<BrowserService['finishTrace']>;

export function getScreenshotPathFromResult(result: ToolExecutionResult): string | null {
  const path = result.metadata?.path;
  return typeof path === 'string' ? path : null;
}

export function summarizeBrowserTargetRefForTool(targetRef: BrowserTargetRef): Record<string, unknown> {
  return {
    refId: targetRef.refId,
    source: targetRef.source,
    selector: targetRef.selector,
    role: targetRef.role || null,
    name: targetRef.name || null,
    textHint: targetRef.textHint || null,
    tabId: targetRef.tabId,
    snapshotId: targetRef.snapshotId,
    capturedAtMs: targetRef.capturedAtMs,
    ttlMs: targetRef.ttlMs,
    confidence: targetRef.confidence,
    rect: targetRef.rect || null,
    boundingBox: targetRef.rect || null,
  };
}

export function summarizeBrowserArtifactForTool(artifact: BrowserArtifactSummary): Record<string, unknown> {
  return {
    artifactId: artifact.artifactId,
    kind: artifact.kind,
    name: artifact.name,
    artifactPath: summarizePathTail(artifact.artifactPath),
    size: artifact.size,
    mimeType: artifact.mimeType,
    sha256: artifact.sha256,
    createdAtMs: artifact.createdAtMs,
    sessionId: artifact.sessionId,
  };
}

export function summarizeAccountStateForTool(accountState: unknown): Record<string, unknown> | null {
  if (!accountState) {
    return null;
  }
  const state = accountState as Record<string, unknown>;
  return {
    status: state.status || 'empty',
    cookieCount: state.cookieCount || 0,
    expiredCookieCount: state.expiredCookieCount || 0,
    originCount: state.originCount || 0,
    localStorageEntryCount: state.localStorageEntryCount || 0,
    sessionStorageEntryCount: state.sessionStorageEntryCount || 0,
    cookieDomains: Array.isArray(state.cookieDomains) ? state.cookieDomains : [],
    origins: Array.isArray(state.origins) ? state.origins : [],
    updatedAtMs: state.updatedAtMs || null,
    storageStatePath: summarizePathTail(
      typeof state.storageStatePath === 'string' ? state.storageStatePath : undefined,
    ),
  };
}

export function formatBrowserTargetRefLabel(targetRef: BrowserTargetRef): string {
  return [
    targetRef.name || targetRef.textHint || targetRef.selector || targetRef.refId,
    targetRef.source,
    targetRef.snapshotId,
  ].filter(Boolean).join(' · ');
}

export function getBrowserTargetRefErrorDetails(error: unknown): {
  code: string;
  message: string;
  retryHint: string;
  refId: string | null;
  snapshotId: string | null;
} | null {
  if (!error || typeof error !== 'object') {
    return null;
  }
  const record = error as Record<string, unknown>;
  if (record.code !== 'STALE_TARGET_REF') {
    return null;
  }
  return {
    code: typeof record.code === 'string' ? record.code : 'STALE_TARGET_REF',
    message: error instanceof Error ? error.message : 'TargetRef is stale or unavailable.',
    retryHint: typeof record.retryHint === 'string'
      ? record.retryHint
      : 'Run browser_action.get_dom_snapshot and retry with a fresh targetRef.',
    refId: typeof record.refId === 'string' ? record.refId : null,
    snapshotId: typeof record.snapshotId === 'string' ? record.snapshotId : null,
  };
}

export function resolveBrowserSecretRef(secretRef: string | undefined): string | undefined {
  if (!secretRef) {
    return undefined;
  }
  if (secretRef.startsWith('env:')) {
    const envName = secretRef.slice(4);
    if (!/^[A-Z0-9_]+$/.test(envName)) {
      return undefined;
    }
    return process.env[envName];
  }
  return undefined;
}

export function summarizeSecretRef(secretRef: string | undefined): string {
  if (!secretRef) {
    return 'secretRef';
  }
  if (secretRef.startsWith('env:')) {
    return 'env';
  }
  return 'secretRef';
}

export function withWorkbenchTrace(
  result: ToolExecutionResult,
  trace: BrowserActionTrace,
  context?: ToolContext,
): ToolExecutionResult {
  if (trace.targetKind !== 'browser') {
    throw new Error(`browser_action received an invalid ${trace.targetKind} workbench trace`);
  }
  return finalizeBrowserActionResult({
    result,
    action: typeof trace.action === 'string' ? trace.action : 'unknown',
    params: (trace.params || {}) as Record<string, unknown>,
    context,
    trace: {
      id: trace.id,
      targetKind: trace.targetKind,
      toolName: trace.toolName || 'browser_action',
      action: typeof trace.action === 'string' ? trace.action : 'unknown',
      params: (trace.params || {}) as Record<string, unknown>,
      startedAtMs: trace.startedAtMs,
      completedAtMs: trace.completedAtMs ?? null,
      success: trace.success ?? null,
      error: trace.error ?? null,
      provider: trace.provider ?? null,
      mode: trace.mode ?? null,
      screenshotPath: trace.screenshotPath ?? null,
    },
    provider: typeof result.metadata?.provider === 'string'
      ? result.metadata.provider
      : (trace.provider || 'system-chrome-cdp'),
  });
}

export function summarizeManagedBrowserStateForTool(
  state: ReturnType<BrowserService['getSessionState']>,
): Record<string, unknown> {
  return {
    sessionId: state.sessionId || null,
    profileId: state.profileId || null,
    profileMode: state.profileMode || null,
    workspaceScope: summarizeWorkspaceScope(state.workspaceScope || undefined),
    artifactDir: summarizePathTail(state.artifactDir || undefined),
    lease: state.lease
      ? {
          leaseId: state.lease.leaseId,
          owner: state.lease.owner,
          acquiredAtMs: state.lease.acquiredAtMs,
          lastHeartbeatAtMs: state.lease.lastHeartbeatAtMs,
          expiresAtMs: state.lease.expiresAtMs,
          ttlMs: state.lease.ttlMs,
          status: state.lease.status,
        }
      : null,
    proxy: state.proxy
      ? {
          mode: state.proxy.mode,
          bypass: state.proxy.bypass,
          regionHint: state.proxy.regionHint || null,
          source: state.proxy.source,
        }
      : null,
    externalBridge: state.externalBridge
      ? {
          enabled: state.externalBridge.enabled,
          status: state.externalBridge.status,
          requiresExplicitAuthorization: true,
          port: state.externalBridge.port || null,
          tokenHint: state.externalBridge.tokenHint || null,
          connectedTabCount: state.externalBridge.connectedTabCount || 0,
          attachedTabCount: state.externalBridge.attachedTabCount || 0,
          reason: state.externalBridge.reason,
        }
      : null,
    accountState: summarizeAccountStateForTool(state.accountState),
    running: state.running,
    tabCount: state.tabCount,
    activeTab: state.activeTab
      ? {
          id: state.activeTab.id,
          url: summarizeUrl(state.activeTab.url),
          title: state.activeTab.title,
        }
      : null,
    mode: state.mode || null,
    provider: state.provider || null,
    requestedProvider: state.requestedProvider || null,
    cdpPort: state.cdpPort || null,
    missingExecutable: state.missingExecutable || false,
    recommendedAction: state.recommendedAction || null,
    providerFallbackReason: state.providerFallbackReason || null,
    viewport: state.viewport || null,
    allowedHosts: state.allowedHosts || [],
    blockedHosts: state.blockedHosts || [],
    lastTraceId: state.lastTrace?.id || null,
  };
}

export function summarizePathTail(value: string | undefined): string | null {
  if (!value) {
    return null;
  }
  const normalized = value.replace(/\\/g, '/');
  const tail = normalized.split('/').filter(Boolean).pop();
  return tail ? `.../${tail}` : null;
}

function summarizeWorkspaceScope(value: string | undefined): string | null {
  if (!value) {
    return null;
  }
  return value.includes('/') || value.includes('\\')
    ? summarizePathTail(value)
    : value;
}

function summarizeUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      return `${url.origin}${url.pathname}`;
    }
    if (url.protocol === 'about:' && url.pathname === 'blank') {
      return 'about:blank';
    }
    if (url.protocol === 'blob:') {
      return url.origin !== 'null' ? `blob:${url.origin}/[redacted]` : 'blob:[redacted]';
    }
    return `${url.protocol}[redacted]`;
  } catch {
    return '[invalid URL]';
  }
}
