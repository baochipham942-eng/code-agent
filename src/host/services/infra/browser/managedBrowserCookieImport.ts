/**
 * ADR-041 — managed browser cookie apply / profile import / clear helpers.
 * Lives outside BrowserService to keep the god-file under max-lines.
 */
import type { BrowserContext, Page } from 'playwright';
import type {
  BrowserCookieImportRequest,
  BrowserCookieImportResult,
  BrowserProfileDescriptor,
  ManagedBrowserAccountStateSummary,
} from '../../../../shared/contract/desktop';
import { listBrowserProfiles } from './browserProfileCatalog';
import {
  importBrowserProfileCookies,
  type PlaywrightCookieSeed,
} from './browserProfileImportService';
import type { BrowserService } from '../browserService';

export interface ManagedBrowserCookieHost {
  ensureRunning(options?: { mode?: 'headless' | 'visible'; profileMode?: 'persistent' | 'isolated' }): Promise<void>;
  ensureActiveTab(): Promise<void>;
  getContext(): BrowserContext;
  getActivePage(): Page | null;
  getAccountStateSummary(): Promise<ManagedBrowserAccountStateSummary>;
  logInfo(message: string): void;
  emitSessionChanged(reason: 'import_profile_cookies' | 'clear_cookies'): void;
}

/** Access private BrowserService fields without growing the god-file. */
function createHostFromBrowserService(service: BrowserService): ManagedBrowserCookieHost {
  const internal = service as unknown as {
    ensureBrowser(options?: { mode?: 'headless' | 'visible'; profileMode?: 'persistent' | 'isolated' }): Promise<void>;
    tabs: Map<string, unknown>;
    context: BrowserContext | null;
    logger: { log(level: string, message: string): void };
    emitSessionChanged(reason: string): void;
    newTab(url?: string): Promise<string>;
    getActiveTab(): { page: Page } | null;
    getAccountStateSummary(): Promise<ManagedBrowserAccountStateSummary>;
  };

  return {
    ensureRunning: async (options) => {
      await internal.ensureBrowser(options);
    },
    ensureActiveTab: async () => {
      if (internal.tabs.size === 0) {
        await internal.newTab('about:blank');
      }
    },
    getContext: () => {
      if (!internal.context) {
        throw new Error('Managed browser context is not available.');
      }
      return internal.context;
    },
    getActivePage: () => internal.getActiveTab()?.page || null,
    getAccountStateSummary: () => internal.getAccountStateSummary(),
    logInfo: (message) => internal.logger.log('INFO', message),
    emitSessionChanged: (reason) => internal.emitSessionChanged(reason),
  };
}

export async function applyManagedBrowserCookies(
  host: ManagedBrowserCookieHost,
  cookies: PlaywrightCookieSeed[],
): Promise<ManagedBrowserAccountStateSummary> {
  // Preserve the owning Surface profile mode. A run-scoped isolated Managed
  // session may import explicitly approved cookies without becoming persistent.
  await host.ensureRunning({ mode: 'visible' });
  await host.ensureActiveTab();
  if (cookies.length > 0) {
    await host.getContext().addCookies(cookies as Parameters<BrowserContext['addCookies']>[0]);
  }
  try {
    const page = host.getActivePage();
    if (page && !page.isClosed()) {
      const url = page.url();
      if (url && url !== 'about:blank') {
        await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => undefined);
      }
    }
  } catch {
    // reload is best-effort
  }
  const accountState = await host.getAccountStateSummary();
  host.logInfo(
    `Applied ${cookies.length} cookies into managed profile (domains summarized only; values redacted).`,
  );
  host.emitSessionChanged('import_profile_cookies');
  return accountState;
}

export function listImportableBrowserProfiles(): BrowserProfileDescriptor[] {
  return listBrowserProfiles();
}

export async function importBrowserProfileCookiesViaService(
  service: BrowserService,
  request: BrowserCookieImportRequest,
): Promise<BrowserCookieImportResult> {
  const host = createHostFromBrowserService(service);
  return importBrowserProfileCookies(request, {
    applyCookies: async (cookies) => applyManagedBrowserCookies(host, cookies),
  });
}

export async function clearManagedBrowserCookiesViaService(
  service: BrowserService,
): Promise<ManagedBrowserAccountStateSummary> {
  const host = createHostFromBrowserService(service);
  await host.ensureRunning({ mode: 'visible' });
  await host.getContext().clearCookies();
  const accountState = await host.getAccountStateSummary();
  host.logInfo('Cleared managed browser cookies.');
  host.emitSessionChanged('clear_cookies');
  return accountState;
}
