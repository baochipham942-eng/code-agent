import type { BrowserContext } from 'playwright';
import * as path from 'path';
import type { ManagedBrowserAccountStateSummary } from '../../../../shared/contract/desktop';
import {
  normalizeStorageStateCookies,
  normalizeStorageStateOrigins,
} from './managedBrowserHelpers';
import type { BrowserStorageStateLike, BrowserTab } from './types';

export async function getBrowserPageSessionStorageEntryCount(tab: BrowserTab | null): Promise<number> {
  if (!tab) {
    return 0;
  }
  return await tab.page.evaluate(() => {
    try {
      return window.sessionStorage?.length || 0;
    } catch {
      return 0;
    }
  }).catch(() => 0);
}

export function summarizeBrowserAccountState(args: {
  state: BrowserStorageStateLike;
  storageStatePath?: string;
  activeSessionStorageEntryCount?: number;
  nowMs?: number;
}): ManagedBrowserAccountStateSummary {
  const cookies = normalizeStorageStateCookies(args.state.cookies);
  const origins = normalizeStorageStateOrigins(args.state.origins);
  const nowSeconds = Math.floor((args.nowMs ?? Date.now()) / 1000);
  const expiredCookieCount = cookies.filter((cookie) =>
    typeof cookie.expires === 'number' && cookie.expires > 0 && cookie.expires < nowSeconds
  ).length;
  const localStorageEntryCount = origins.reduce((sum, origin) => sum + origin.localStorage.length, 0);
  const sessionStorageEntryCount = origins.reduce((sum, origin) => sum + origin.sessionStorage.length, 0)
    + (args.activeSessionStorageEntryCount || 0);
  let status: ManagedBrowserAccountStateSummary['status'] = 'empty';
  if (expiredCookieCount > 0) {
    status = 'account_state_expired';
  } else if (cookies.length > 0 || localStorageEntryCount > 0 || sessionStorageEntryCount > 0) {
    status = 'available';
  }

  return {
    status,
    cookieCount: cookies.length,
    expiredCookieCount,
    originCount: origins.length,
    localStorageEntryCount,
    sessionStorageEntryCount,
    cookieDomains: Array.from(new Set(cookies.map((cookie) => cookie.domain).filter(Boolean))).sort(),
    origins: origins.map((origin) => origin.origin).filter(Boolean).sort(),
    updatedAtMs: args.nowMs ?? Date.now(),
    storageStatePath: args.storageStatePath ? path.basename(args.storageStatePath) : null,
  };
}

export async function installStorageStateInitScript(
  context: BrowserContext,
  origins: unknown[],
): Promise<void> {
  const safeOrigins = normalizeStorageStateOrigins(origins);
  if (safeOrigins.length === 0) {
    return;
  }
  await context.addInitScript((originEntries) => {
    const entries = Array.isArray(originEntries) ? originEntries : [];
    const match = entries.find((entry) => entry && typeof entry === 'object' && (entry as { origin?: string }).origin === window.location.origin) as {
      localStorage?: Array<{ name: string; value: string }>;
      sessionStorage?: Array<{ name: string; value: string }>;
    } | undefined;
    if (!match) {
      return;
    }
    try {
      for (const item of match.localStorage || []) {
        window.localStorage.setItem(item.name, item.value);
      }
    } catch {
      // Some origins block storage access; leave navigation usable.
    }
    try {
      for (const item of match.sessionStorage || []) {
        window.sessionStorage.setItem(item.name, item.value);
      }
    } catch {
      // Some origins block storage access; leave navigation usable.
    }
  }, safeOrigins);
}

export async function applyStorageStateToPage(
  tab: BrowserTab | null,
  origins: unknown[],
): Promise<void> {
  const safeOrigins = normalizeStorageStateOrigins(origins);
  if (!tab || safeOrigins.length === 0) {
    return;
  }
  await tab.page.evaluate((originEntries) => {
    const entries = Array.isArray(originEntries) ? originEntries : [];
    const match = entries.find((entry) => entry && typeof entry === 'object' && (entry as { origin?: string }).origin === window.location.origin) as {
      localStorage?: Array<{ name: string; value: string }>;
      sessionStorage?: Array<{ name: string; value: string }>;
    } | undefined;
    if (!match) {
      return;
    }
    for (const item of match.localStorage || []) {
      window.localStorage.setItem(item.name, item.value);
    }
    for (const item of match.sessionStorage || []) {
      window.sessionStorage.setItem(item.name, item.value);
    }
  }, safeOrigins);
}
