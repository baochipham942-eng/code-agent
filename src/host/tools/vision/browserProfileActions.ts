/**
 * ADR-041 browser_action handlers for profile list/import/clear.
 */
import type { ToolContext, ToolExecutionResult } from '../types';
import type { BrowserProfileSourceId } from '../../../shared/contract/desktop';
import type { BrowserService } from '../../services/infra/browserService';
import {
  clearManagedBrowserCookiesViaService,
  importBrowserProfileCookiesViaService,
  listImportableBrowserProfiles,
} from '../../services/infra/browser/managedBrowserCookieImport';
import { getBrowserProfileImportApprovalService } from '../../services/surfaceExecution/BrowserProfileImportApprovalService';

function summarizePathTail(value: string | undefined): string | null {
  if (!value) return null;
  const parts = value.split(/[/\\]/).filter(Boolean);
  return parts.slice(-2).join('/') || value;
}

function summarizeAccountStateForTool(accountState: unknown): Record<string, unknown> | null {
  if (!accountState || typeof accountState !== 'object') return null;
  const record = accountState as Record<string, unknown>;
  return {
    status: record.status,
    cookieCount: record.cookieCount,
    expiredCookieCount: record.expiredCookieCount,
    domainCount: Array.isArray(record.cookieDomains) ? record.cookieDomains.length : 0,
    domains: Array.isArray(record.cookieDomains) ? record.cookieDomains.slice(0, 12) : [],
    updatedAtMs: record.updatedAtMs,
  };
}

export async function executeBrowserProfileAction(args: {
  action: 'list_profiles' | 'import_profile_cookies' | 'clear_cookies';
  browserService: BrowserService;
  params: Record<string, unknown>;
  context?: ToolContext;
}): Promise<ToolExecutionResult> {
  const { action, browserService, params, context } = args;

  if (action === 'list_profiles') {
    const profiles = listImportableBrowserProfiles().map((profile) => ({
      source: profile.source,
      appName: profile.appName,
      profileId: profile.profileId,
      profileName: profile.profileName,
      available: profile.available,
      unavailableReason: profile.unavailableReason || null,
      unavailableMessage: profile.unavailableMessage || null,
      profileDirTail: summarizePathTail(profile.profileDir),
      lastActiveAtMs: profile.lastActiveAtMs || null,
    }));
    return {
      success: true,
      output: JSON.stringify({ count: profiles.length, profiles }, null, 2),
      metadata: {
        browserProfileCount: profiles.length,
        browserProfiles: profiles,
      },
    };
  }

  if (action === 'clear_cookies') {
    const accountState = await clearManagedBrowserCookiesViaService(browserService);
    return {
      success: true,
      output: 'Managed browser cookies cleared.',
      metadata: {
        browserAccountState: summarizeAccountStateForTool(accountState),
      },
    };
  }

  const source = typeof params.source === 'string' ? params.source : '';
  const profileId = typeof params.profileId === 'string' ? params.profileId : '';
  const userConfirmed = params.userConfirmed === true;
  if (!source || !profileId) {
    return { success: false, error: 'source and profileId required for import_profile_cookies' };
  }
  if (!userConfirmed) {
    return {
      success: false,
      error:
        'import_profile_cookies requires userConfirmed=true after explicit user approval (use Browser Surface key import). ADR-041 forbids silent agent imports.',
    };
  }
  const domainAllowlist = Array.isArray(params.domainAllowlist)
    ? params.domainAllowlist.filter((item): item is string => typeof item === 'string')
    : undefined;
  if (!context) {
    return {
      success: false,
      error: 'SURFACE_APPROVAL_INVALID: profile cookie import requires a Host permission context.',
      metadata: { code: 'SURFACE_APPROVAL_INVALID' },
    };
  }
  const hostApproved = await context.requestPermission({
    type: 'file_read',
    tool: 'browser_action.import_profile_cookies',
    forceConfirm: true,
    dangerLevel: 'warning',
    reason: '导入浏览器登录 Cookie 需要一次性、限定 profile 与 domain 的 Host 授权。',
    details: {
      source,
      profileId,
      domainAllowlist: domainAllowlist || [],
      approvalMode: 'host_signed_one_time',
    },
  });
  if (!hostApproved) {
    return {
      success: false,
      error: 'SURFACE_APPROVAL_REQUIRED: profile cookie import was not approved by the user.',
      metadata: { code: 'SURFACE_APPROVAL_REQUIRED' },
    };
  }
  const subject = {
    conversationId: context.sessionId?.trim() || 'legacy-conversation',
    runId: context.runId?.trim() || context.currentToolCallId?.trim() || 'legacy-run',
    agentId: context.agentId?.trim() || 'primary',
  };
  const scope = { source, profileId, ...(domainAllowlist ? { domainAllowlist } : {}) };
  const approvalService = getBrowserProfileImportApprovalService();
  const approval = approvalService.issue({ subject, scope });
  if (!approvalService.consume({ token: approval.token, subject, scope })) {
    return {
      success: false,
      error: 'SURFACE_APPROVAL_INVALID: profile cookie import approval could not be consumed.',
      metadata: { code: 'SURFACE_APPROVAL_INVALID' },
    };
  }
  const result = await importBrowserProfileCookiesViaService(browserService, {
    source: source as BrowserProfileSourceId,
    profileId,
    domainAllowlist,
    userConfirmed: true,
  });
  if (!result.ok) {
    return {
      success: false,
      error: result.failureMessage || result.failureCode || 'Profile cookie import failed',
      metadata: {
        importSource: result.importSource,
        failureCode: result.failureCode,
        recommendedAction: 'start_browser_relay_or_retry_import',
      },
    };
  }
  return {
    success: true,
    output: `Imported ${result.importedCookieCount} cookies from ${result.source}/${result.profileId} (${result.domainCount} domains). Values redacted.`,
    metadata: {
      importSource: result.importSource,
      importedCookieCount: result.importedCookieCount,
      skippedCookieCount: result.skippedCookieCount,
      domainCount: result.domainCount,
      domains: result.domains,
      browserAccountState: summarizeAccountStateForTool(result.accountState || null),
      approval: {
        mode: 'host_signed_one_time',
        scopeHash: approval.scopeHash,
        expiresAt: approval.expiresAt,
      },
    },
  };
}
