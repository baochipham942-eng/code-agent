// ============================================================================
// BrowserService - Browser automation using Playwright
// Provides programmatic browser control for all agents
// Logs are transparent and returned to the agent for visibility
// ============================================================================

import type { Browser, BrowserContext } from 'playwright';
import * as path from 'path';
import * as fs from 'fs';
import { spawn, type ChildProcess } from 'child_process';
import { app, broadcastToRenderer } from '../../platform';
import type { Disposable } from '../serviceRegistry';
import { getServiceRegistry } from '../serviceRegistry';
import type {
  ManagedBrowserAccountStateSummary,
  ManagedBrowserLeaseState,
  ManagedBrowserMode,
  ManagedBrowserProfileMode,
  ManagedBrowserProxyConfig,
  ManagedBrowserSessionState,
  WorkbenchActionTrace,
  WorkbenchSnapshotRef,
} from '../../../shared/contract/desktop';
import { IPC_CHANNELS } from '../../../shared/ipc';
import {
  buildSystemChromeCdpArgs,
  findAvailablePort,
  resolveBrowserProvider,
  type BrowserProviderResolution,
} from './browserProvider';
import { BrowserLogger } from './browser/logger';
import {
  BROWSER_TARGET_REF_TTL_MS,
  MANAGED_BROWSER_ARTIFACT_DIR,
  MANAGED_BROWSER_ARTIFACT_ROOT_DIR,
  MANAGED_BROWSER_EXTERNAL_BRIDGE_UNSUPPORTED,
  buildBrowserEnvironment,
  createBrowserArtifactSummary,
  createManagedBrowserLease,
  getDefaultUserAgent,
  getManagedBrowserProxyFingerprint,
  inferMimeType,
  isLocalHost,
  isManagedBrowserLeaseExpired,
  matchesHostList,
  normalizeStorageStateCookies,
  normalizeStorageStateOrigins,
  parseBrowserTargetRefInput,
  parseHostList,
  readBrowserStorageState,
  redactBrowserWorkbenchTraceParams,
  resolveManagedBrowserProfile,
  resolveManagedBrowserProxyConfig,
  resolveManagedBrowserWorkspaceScope,
  sanitizeArtifactFilename,
  sanitizeManagedBrowserId,
  shouldCleanupManagedBrowserProfile,
  summarizeBrowserUrlForLog,
} from './browser/managedBrowserHelpers';
import {
  BrowserTargetRefError,
  type BrowserArtifactSummary,
  type BrowserDomSnapshot,
  type BrowserProviderDiagnostics,
  type BrowserStorageStateArtifact,
  type BrowserStorageStateLike,
  type BrowserTab,
  type BrowserTargetRef,
  type BrowserTargetRefRecord,
  type ElementInfo,
  type ManagedBrowserLaunchOptions,
  type PageContent,
  type ScreenshotResult,
} from './browser/types';

export * from './browser/types';
export { BrowserLogger } from './browser/logger';
export {
  createManagedBrowserLease,
  createManagedBrowserSessionId,
  isManagedBrowserLeaseExpired,
  redactBrowserWorkbenchTraceParams,
  resolveManagedBrowserProfile,
  resolveManagedBrowserProxyConfig,
  resolveManagedBrowserWorkspaceScope,
  shouldCleanupManagedBrowserProfile,
} from './browser/managedBrowserHelpers';

// Lazy-load playwright to avoid hard dependency at module load time
// (e.g., when bundled for test runner where playwright is not installed)
let _playwright: typeof import('playwright') | null = null;
async function getPlaywright() {
  if (!_playwright) {
    _playwright = await import('playwright');
  }
  return _playwright;
}

type ManagedBrowserSessionChangeReason =
  | 'launch'
  | 'close'
  | 'new_tab'
  | 'close_tab'
  | 'switch_tab'
  | 'navigate'
  | 'page_load'
  | 'history'
  | 'reload'
  | 'set_viewport'
  | 'crashed';

export class BrowserService implements Disposable {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private browserProcess: ChildProcess | null = null;
  private tabs: Map<string, BrowserTab> = new Map();
  private activeTabId: string | null = null;
  private disposed = false;
  private agentId: string | undefined;
  private userDataDir: string;
  private screenshotDir: string;
  private artifactRootDir: string;
  private downloadDir: string;
  private artifactDir: string;
  private sessionId: string | null = null;
  private profileId: string;
  private profileMode: ManagedBrowserProfileMode;
  private profileDir: string;
  private isolatedProfileDir: string | null = null;
  private isolatedProfileRootDir: string | null = null;
  private workspaceScope: string;
  private lastAccountState: ManagedBrowserAccountStateSummary | null = null;
  private lease: ManagedBrowserLeaseState | null = null;
  private leaseTimer: ReturnType<typeof setTimeout> | null = null;
  private proxyConfig: ManagedBrowserProxyConfig;
  private mode: ManagedBrowserMode;
  private viewport = { width: 1280, height: 720 };
  private traces: WorkbenchActionTrace[] = [];
  private targetRefs: Map<string, BrowserTargetRefRecord> = new Map();
  private snapshotSequence = 0;
  private consoleErrors: string[] = [];
  private networkFailures: string[] = [];
  private allowedHosts: string[];
  private blockedHosts: string[];
  private providerDiagnostics: BrowserProviderDiagnostics;
  public logger: BrowserLogger = new BrowserLogger();

  constructor(agentId?: string) {
    this.agentId = agentId;
    const userData = app?.getPath('userData') || process.cwd();
    this.userDataDir = userData;
    this.screenshotDir = path.join(userData, MANAGED_BROWSER_ARTIFACT_DIR);
    this.artifactRootDir = path.join(userData, MANAGED_BROWSER_ARTIFACT_ROOT_DIR);
    this.workspaceScope = resolveManagedBrowserWorkspaceScope(process.cwd());
    const initialProfile = resolveManagedBrowserProfile({
      userDataDir: userData,
      profileMode: 'persistent',
      workspaceScope: this.workspaceScope,
      agentId,
    });
    this.sessionId = initialProfile.sessionId;
    this.profileId = initialProfile.profileId;
    this.profileMode = initialProfile.profileMode;
    this.profileDir = initialProfile.profileDir;
    this.artifactDir = initialProfile.artifactDir;
    this.downloadDir = this.resolveDownloadDir(initialProfile.sessionId);
    this.isolatedProfileRootDir = initialProfile.isolatedRootDir;
    this.mode = this.getDefaultMode();
    this.allowedHosts = parseHostList(process.env.CODE_AGENT_BROWSER_ALLOWED_HOSTS);
    this.blockedHosts = parseHostList(process.env.CODE_AGENT_BROWSER_BLOCKED_HOSTS);
    this.proxyConfig = resolveManagedBrowserProxyConfig({ env: process.env });
    this.providerDiagnostics = this.createInitialProviderDiagnostics();
    if (!fs.existsSync(this.screenshotDir)) {
      fs.mkdirSync(this.screenshotDir, { recursive: true });
    }
    fs.mkdirSync(this.downloadDir, { recursive: true });
    fs.mkdirSync(this.profileDir, { recursive: true });
    this.logger.log('INFO', 'BrowserService initialized');
  }

  // --------------------------------------------------------------------------
  // Browser Lifecycle
  // --------------------------------------------------------------------------

  async launch(options: ManagedBrowserLaunchOptions = {}): Promise<void> {
    if (this.isRunning()) {
      if (options.profileMode && options.profileMode !== this.profileMode) {
        throw new Error(`Managed browser is already running with profileMode=${this.profileMode}; close it before switching to ${options.profileMode}.`);
      }
      if (options.proxy) {
        const nextProxy = resolveManagedBrowserProxyConfig({ input: options.proxy, env: process.env });
        if (getManagedBrowserProxyFingerprint(nextProxy) !== getManagedBrowserProxyFingerprint(this.proxyConfig)) {
          throw new Error('Managed browser is already running with a different proxy config; close it before switching proxy.');
        }
      }
      this.renewLease({
        owner: options.leaseOwner || 'managed-browser',
        ttlMs: options.leaseTtlMs,
      });
      this.logger.log('WARN', 'Browser already running, skipping launch');
      this.emitSessionChanged('launch');
      return;
    }

    this.mode = options.mode || this.getDefaultMode();
    this.configureManagedBrowserSession(options.profileMode || 'persistent');
    this.proxyConfig = resolveManagedBrowserProxyConfig({ input: options.proxy, env: process.env });
    const resolution = resolveBrowserProvider({ requestedProvider: options.provider });
    this.updateProviderDiagnostics(resolution, {
      executable: resolution.systemExecutable,
      cdpPort: null,
    });

    this.logger.log('INFO', `Launching managed browser via ${resolution.provider} (${this.mode}, profile=${this.profileMode})...`);
    if (resolution.provider === 'system-chrome-cdp') {
      try {
        await this.launchSystemChromeCdp(resolution);
      } catch (error) {
        if (resolution.requestedProvider !== 'auto') {
          await this.cleanupFailedSystemChromeLaunch({ cleanupProfile: true });
          throw error;
        }
        await this.cleanupFailedSystemChromeLaunch({ cleanupProfile: false });
        const fallbackReason = error instanceof Error ? error.message : String(error);
        this.logger.log('WARN', `System Chrome CDP launch failed; falling back to Playwright bundled Chromium: ${fallbackReason}`);
        try {
          await this.launchPlaywrightBundled(resolution, `System Chrome CDP launch failed: ${fallbackReason}`);
        } catch (fallbackError) {
          await this.cleanupFailedSystemChromeLaunch({ cleanupProfile: true });
          throw fallbackError;
        }
      }
    } else {
      try {
        await this.launchPlaywrightBundled(resolution, resolution.providerFallbackReason);
      } catch (error) {
        await this.cleanupFailedSystemChromeLaunch({ cleanupProfile: true });
        throw error;
      }
    }

    try {
      await this.installContextGuards();
    } catch (error) {
      await this.cleanupFailedSystemChromeLaunch({ cleanupProfile: true });
      throw error;
    }
    this.logger.log(
      'INFO',
      `Browser launched successfully via ${this.providerDiagnostics.provider} (viewport: ${this.viewport.width}x${this.viewport.height}, profile=${this.profileMode})`,
    );
    this.renewLease({
      owner: options.leaseOwner || 'managed-browser',
      ttlMs: options.leaseTtlMs,
    });
    this.emitSessionChanged('launch');
  }

  async close(): Promise<void> {
    if (this.browser || this.context || this.browserProcess) {
      this.logger.log('INFO', 'Closing browser...');
      await this.context?.close().catch(() => undefined);
      await this.browser?.close().catch(() => undefined);
      await this.stopSystemChromeProcess();
      this.browser = null;
      this.context = null;
      this.tabs.clear();
      this.targetRefs.clear();
      this.activeTabId = null;
      this.releaseLease();
      await this.cleanupIsolatedProfileDir();
      if (this.profileMode === 'isolated') {
        this.configureManagedBrowserSession('persistent');
      }
      this.logger.log('INFO', 'Browser closed, all tabs cleared');
      this.emitSessionChanged('close');
    } else {
      this.releaseLease();
      this.logger.log('WARN', 'No browser to close');
      this.emitSessionChanged('close');
    }
  }

  isRunning(): boolean {
    return this.browser !== null || this.context !== null;
  }

  // --------------------------------------------------------------------------
  // Tab Management
  // --------------------------------------------------------------------------

  async newTab(url?: string): Promise<string> {
    if (url) {
      const allowed = this.validateUrl(url);
      if (!allowed.allowed) {
        throw new Error(allowed.reason);
      }
    }
    await this.ensureBrowser();

    this.logger.log('INFO', `Creating new tab${url ? ` with URL: ${summarizeBrowserUrlForLog(url)}` : ''}`);
    const page = await this.context!.newPage();
    await page.setViewportSize(this.viewport).catch(() => undefined);
    const tabId = `tab_${Date.now()}`;

    if (url) {
      this.logger.log('DEBUG', `Navigating to: ${summarizeBrowserUrlForLog(url)}`);
      await page.goto(url, { waitUntil: 'domcontentloaded' });
    }

    const tab: BrowserTab = {
      id: tabId,
      page,
      url: page.url(),
      title: await page.title(),
    };

    this.tabs.set(tabId, tab);
    this.activeTabId = tabId;

    page.on('load', async () => {
      await this.refreshTabMetadata(tab);
      this.logger.log('DEBUG', `Page loaded: ${summarizeBrowserUrlForLog(tab.url)} - "${tab.title}"`);
      this.emitSessionChanged('page_load');
    });

    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        const entry = `[${tabId}] ${msg.text()}`;
        this.consoleErrors.push(entry);
        this.consoleErrors = this.consoleErrors.slice(-50);
        this.logger.log('ERROR', `[Page Console] ${entry}`);
      } else if (msg.type() === 'warning') {
        this.logger.log('WARN', `[Page Console] ${msg.text()}`);
      }
    });

    page.on('requestfailed', (request) => {
      const entry = `[${tabId}] ${summarizeBrowserUrlForLog(request.url())} ${request.failure()?.errorText || 'request failed'}`;
      this.networkFailures.push(entry);
      this.networkFailures = this.networkFailures.slice(-50);
      this.logger.log('WARN', `[Page Request Failed] ${entry}`);
    });

    page.on('response', (response) => {
      if (response.status() >= 400) {
        const entry = `[${tabId}] ${response.status()} ${summarizeBrowserUrlForLog(response.url())}`;
        this.networkFailures.push(entry);
        this.networkFailures = this.networkFailures.slice(-50);
        this.logger.log('WARN', `[Page Response] ${entry}`);
      }
    });

    this.logger.log('INFO', `Tab created: ${tabId} - "${tab.title}" (${summarizeBrowserUrlForLog(tab.url)})`);
    this.emitSessionChanged('new_tab');
    return tabId;
  }

  async closeTab(tabId: string): Promise<void> {
    const tab = this.tabs.get(tabId);
    if (tab) {
      this.logger.log('INFO', `Closing tab: ${tabId} - "${tab.title}"`);
      await tab.page.close();
      this.tabs.delete(tabId);
      if (this.activeTabId === tabId) {
        this.activeTabId = this.tabs.size > 0 ? (this.tabs.keys().next().value ?? null) : null;
      }
      this.logger.log('INFO', `Tab closed. Remaining tabs: ${this.tabs.size}`);
      this.emitSessionChanged('close_tab');
    } else {
      this.logger.log('WARN', `Tab not found: ${tabId}`);
    }
  }

  async switchTab(tabId: string): Promise<void> {
    if (this.tabs.has(tabId)) {
      this.activeTabId = tabId;
      const tab = this.tabs.get(tabId)!;
      await tab.page.bringToFront();
      this.logger.log('INFO', `Switched to tab: ${tabId} - "${tab.title}"`);
      this.emitSessionChanged('switch_tab');
    } else {
      this.logger.log('WARN', `Cannot switch - tab not found: ${tabId}`);
    }
  }

  getActiveTab(): BrowserTab | null {
    return this.activeTabId ? this.tabs.get(this.activeTabId) || null : null;
  }

  listTabs(): Array<{ id: string; url: string; title: string }> {
    return Array.from(this.tabs.values()).map(tab => ({
      id: tab.id,
      url: tab.url,
      title: tab.title,
    }));
  }

  getSessionState(): ManagedBrowserSessionState {
    const activeTab = this.getActiveTab();
    return {
      sessionId: this.sessionId,
      profileId: this.profileId,
      profileMode: this.profileMode,
      workspaceScope: this.workspaceScope,
      artifactDir: this.artifactDir,
      lease: this.getLeaseState(),
      proxy: this.getPublicProxyConfig(),
      externalBridge: MANAGED_BROWSER_EXTERNAL_BRIDGE_UNSUPPORTED,
      accountState: this.lastAccountState,
      running: this.isRunning(),
      tabCount: this.tabs.size,
      activeTab: activeTab
        ? {
          id: activeTab.id,
          url: activeTab.url,
          title: activeTab.title,
        }
        : null,
      mode: this.mode,
      provider: this.providerDiagnostics.provider,
      requestedProvider: this.providerDiagnostics.requestedProvider,
      executable: this.providerDiagnostics.executable,
      cdpPort: this.providerDiagnostics.cdpPort,
      profileDir: this.profileDir,
      missingExecutable: this.providerDiagnostics.missingExecutable,
      recommendedAction: this.providerDiagnostics.recommendedAction,
      providerFallbackReason: this.providerDiagnostics.providerFallbackReason,
      viewport: this.viewport,
      allowedHosts: this.allowedHosts,
      blockedHosts: this.blockedHosts,
      lastTrace: this.traces.at(-1) || null,
    };
  }

  async ensureSession(url: string = 'about:blank', options: ManagedBrowserLaunchOptions = {}): Promise<ManagedBrowserSessionState> {
    await this.ensureBrowser(options);
    this.renewLease({
      owner: options.leaseOwner || 'managed-browser',
      ttlMs: options.leaseTtlMs,
    });
    if (!this.getActiveTab()) {
      await this.newTab(url === 'about:blank' ? undefined : url);
    }
    return this.getSessionState();
  }

  // --------------------------------------------------------------------------
  // Navigation
  // --------------------------------------------------------------------------

  async navigate(url: string, tabId?: string): Promise<void> {
    const allowed = this.validateUrl(url);
    if (!allowed.allowed) {
      throw new Error(allowed.reason);
    }
    const tab = this.getTab(tabId);
    this.logger.log('INFO', `Navigating to: ${summarizeBrowserUrlForLog(url)}`);
    await tab.page.goto(url, { waitUntil: 'domcontentloaded' });
    await this.refreshTabMetadata(tab);
    this.logger.log('INFO', `Navigation complete: "${tab.title}"`);
    this.emitSessionChanged('navigate');
  }

  async goBack(tabId?: string): Promise<void> {
    this.logger.log('INFO', 'Going back in history');
    const tab = this.getTab(tabId);
    await tab.page.goBack();
    await this.refreshTabMetadata(tab);
    this.emitSessionChanged('history');
  }

  async goForward(tabId?: string): Promise<void> {
    const tab = this.getTab(tabId);
    await tab.page.goForward();
    await this.refreshTabMetadata(tab);
    this.emitSessionChanged('history');
  }

  async reload(tabId?: string): Promise<void> {
    const tab = this.getTab(tabId);
    await tab.page.reload();
    await this.refreshTabMetadata(tab);
    this.emitSessionChanged('reload');
  }

  async setViewport(width: number, height: number): Promise<void> {
    this.viewport = {
      width: Math.max(320, Math.floor(width)),
      height: Math.max(240, Math.floor(height)),
    };
    await Promise.all(
      Array.from(this.tabs.values()).map((tab) =>
        tab.page.setViewportSize(this.viewport).catch((error) => {
          this.logger.log('WARN', `Failed to set viewport for ${tab.id}: ${error}`);
        })
      ),
    );
    this.emitSessionChanged('set_viewport');
  }

  // --------------------------------------------------------------------------
  // Page Interaction
  // --------------------------------------------------------------------------

  async click(selector: string, tabId?: string): Promise<void> {
    const tab = this.getTab(tabId);
    await tab.page.click(selector);
  }

  async clickTargetRef(targetRefInput: unknown, tabId?: string): Promise<BrowserTargetRef> {
    const resolved = await this.resolveTargetRef(targetRefInput, tabId);
    const tab = this.getTab(resolved.targetRef.tabId);
    await tab.page.click(resolved.targetRef.selector);
    return resolved.targetRef;
  }

  async clickAtPosition(x: number, y: number, tabId?: string): Promise<void> {
    const tab = this.getTab(tabId);
    await tab.page.mouse.click(x, y);
  }

  async type(selector: string, text: string, tabId?: string): Promise<void> {
    const tab = this.getTab(tabId);
    await tab.page.fill(selector, text);
  }

  async typeTargetRef(targetRefInput: unknown, text: string, tabId?: string): Promise<BrowserTargetRef> {
    const resolved = await this.resolveTargetRef(targetRefInput, tabId);
    const tab = this.getTab(resolved.targetRef.tabId);
    await tab.page.fill(resolved.targetRef.selector, text);
    return resolved.targetRef;
  }

  async typeAtFocus(text: string, tabId?: string): Promise<void> {
    const tab = this.getTab(tabId);
    await tab.page.keyboard.type(text);
  }

  async pressKey(key: string, tabId?: string): Promise<void> {
    const tab = this.getTab(tabId);
    await tab.page.keyboard.press(key);
  }

  async scroll(direction: 'up' | 'down', amount: number = 300, tabId?: string): Promise<void> {
    const tab = this.getTab(tabId);
    const delta = direction === 'down' ? amount : -amount;
    await tab.page.mouse.wheel(0, delta);
  }

  async hover(selector: string, tabId?: string): Promise<void> {
    const tab = this.getTab(tabId);
    await tab.page.hover(selector);
  }

  async waitForSelector(selector: string, timeout: number = 5000, tabId?: string): Promise<boolean> {
    const tab = this.getTab(tabId);
    try {
      await tab.page.waitForSelector(selector, { timeout });
      return true;
    } catch {
      return false;
    }
  }

  // --------------------------------------------------------------------------
  // Page Content
  // --------------------------------------------------------------------------

  async getPageContent(tabId?: string): Promise<PageContent> {
    const tab = this.getTab(tabId);
    const page = tab.page;

    const [text, links] = await Promise.all([
      page.innerText('body').catch(() => ''),
      page.$$eval('a[href]', (anchors) =>
        anchors.slice(0, 50).map((a) => ({
          text: a.textContent?.trim() || '',
          href: (a as HTMLAnchorElement).href,
        }))
      ).catch(() => []),
    ]);

    return {
      url: page.url(),
      title: await page.title(),
      text: text.substring(0, 10000),
      links,
    };
  }

  async getPageHTML(tabId?: string): Promise<string> {
    const tab = this.getTab(tabId);
    return await tab.page.content();
  }

  async findElements(selector: string, tabId?: string): Promise<ElementInfo[]> {
    const tab = this.getTab(tabId);
    return await tab.page.$$eval(selector, (elements) =>
      elements.slice(0, 20).map((el) => ({
        selector: '',
        text: el.textContent?.trim().substring(0, 100) || '',
        tagName: el.tagName.toLowerCase(),
        attributes: Object.fromEntries(
          Array.from(el.attributes).map((attr) => [attr.name, attr.value])
        ),
        rect: el.getBoundingClientRect(),
      }))
    );
  }

  async findElementByText(text: string, tabId?: string): Promise<ElementInfo | null> {
    const tab = this.getTab(tabId);
    const element = await tab.page.$(`text=${text}`);
    if (!element) return null;

    return await element.evaluate((el) => ({
      selector: '',
      text: el.textContent?.trim() || '',
      tagName: el.tagName.toLowerCase(),
      attributes: Object.fromEntries(
        Array.from(el.attributes).map((attr) => [attr.name, attr.value])
      ),
      rect: el.getBoundingClientRect(),
    }));
  }

  async getInteractiveElements(tabId?: string): Promise<ElementInfo[]> {
    const tab = this.getTab(tabId);
    const selectors = 'button, a, input, select, textarea, [role="button"], [onclick]';
    return this.findElements(selectors, tab.id);
  }

  async getDomSnapshot(tabId?: string): Promise<BrowserDomSnapshot> {
    const tab = this.getTab(tabId);
    const page = tab.page;
    const snapshotId = this.createSnapshotId();
    const capturedAtMs = Date.now();
    const [headings, rawInteractiveElements] = await Promise.all([
      page.$$eval('h1,h2,h3,h4,h5,h6', (nodes) =>
        nodes.slice(0, 30).map((node) => ({
          level: Number(node.tagName.replace(/^H/i, '')) || 0,
          text: node.textContent?.trim().slice(0, 160) || '',
        })).filter((item) => item.text)
      ).catch(() => []),
      page.$$eval(
        'button, a[href], input, select, textarea, [role], [onclick], [tabindex]',
        (nodes) => nodes.slice(0, 80).map((node) => {
          const el = node as HTMLElement;
          const rect = el.getBoundingClientRect();
          const id = el.getAttribute('id');
          const className = el.getAttribute('class');
          const tag = el.tagName.toLowerCase();
          const escapeCss = (value: string) => {
            const css = (globalThis as typeof globalThis & { CSS?: { escape?: (input: string) => string } }).CSS;
            if (css?.escape) {
              return css.escape(value);
            }
            return value.replace(/(["\\#.:,[\]=\s>+~*])/g, '\\$1');
          };
          const quotedAttr = (name: string, value: string) => `[${name}="${value.replace(/(["\\])/g, '\\$1')}"]`;
          const selectorHint = (() => {
            if (id) return `#${escapeCss(id)}`;
            const testId = el.getAttribute('data-testid') || el.getAttribute('data-test');
            if (testId) return quotedAttr(el.getAttribute('data-testid') ? 'data-testid' : 'data-test', testId);
            const name = el.getAttribute('name');
            if (name && /^(input|select|textarea|button)$/i.test(tag)) {
              return `${tag}${quotedAttr('name', name)}`;
            }
            if (className) {
              const firstClass = className.split(/\s+/).filter(Boolean)[0];
              if (firstClass) return `${tag}.${escapeCss(firstClass)}`;
            }
            const parts: string[] = [];
            let current: HTMLElement | null = el;
            while (current?.nodeType === Node.ELEMENT_NODE) {
              const currentTag = current.tagName.toLowerCase();
              const currentTagName = current.tagName;
              const parent: HTMLElement | null = current.parentElement;
              if (!parent) {
                parts.unshift(currentTag);
                break;
              }
              const sameTagSiblings = Array.from(parent.children).filter((child) => child.tagName === currentTagName);
              const nth = sameTagSiblings.indexOf(current) + 1;
              parts.unshift(sameTagSiblings.length > 1 ? `${currentTag}:nth-of-type(${nth})` : currentTag);
              if (parent === document.body || parent === document.documentElement) {
                break;
              }
              current = parent;
            }
            return parts.join(' > ') || tag;
          })();
          return {
            tag,
            role: el.getAttribute('role'),
            text: el.textContent?.trim().slice(0, 160) || '',
            ariaLabel: el.getAttribute('aria-label'),
            placeholder: el.getAttribute('placeholder'),
            selectorHint,
            refConfidence: id ? 0.95 : className ? 0.65 : 0.45,
            rect: {
              x: Math.round(rect.x),
              y: Math.round(rect.y),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
            },
          };
        }).filter((item) => item.rect.width > 0 && item.rect.height > 0)
      ).catch(() => []),
    ]);
    const currentUrl = page.url();
    this.pruneTargetRefs(capturedAtMs);
    const interactiveElements = rawInteractiveElements.map((element, index) => {
      const targetRef: BrowserTargetRef = {
        refId: `tref_${snapshotId}_${index + 1}`,
        source: 'dom',
        selector: element.selectorHint,
        role: element.role,
        name: element.ariaLabel || element.text || element.placeholder || element.selectorHint,
        textHint: element.text || element.ariaLabel || element.placeholder || null,
        frameId: null,
        tabId: tab.id,
        snapshotId,
        capturedAtMs,
        ttlMs: BROWSER_TARGET_REF_TTL_MS,
        confidence: element.refConfidence,
      };
      this.targetRefs.set(targetRef.refId, {
        targetRef,
        url: currentUrl,
      });
      const { refConfidence: _refConfidence, ...publicElement } = element;
      return {
        ...publicElement,
        targetRef,
      };
    });

    return {
      snapshotId,
      tabId: tab.id,
      capturedAtMs,
      url: currentUrl,
      title: await page.title(),
      headings,
      interactiveElements,
    };
  }

  async getAccessibilitySnapshot(tabId?: string): Promise<unknown> {
    const tab = this.getTab(tabId);
    const pageWithAccessibility = tab.page as unknown as {
      accessibility?: {
        snapshot(options?: { interestingOnly?: boolean }): Promise<unknown>;
      };
    };
    if (pageWithAccessibility.accessibility?.snapshot) {
      return await pageWithAccessibility.accessibility.snapshot({ interestingOnly: true });
    }
    return {
      fallback: 'playwright_accessibility_snapshot_unavailable',
      domSnapshot: await this.getDomSnapshot(tabId),
    };
  }

  // --------------------------------------------------------------------------
  // Screenshots
  // --------------------------------------------------------------------------

  async screenshot(options: {
    fullPage?: boolean;
    selector?: string;
    format?: 'png' | 'jpeg';
    tabId?: string;
  } = {}): Promise<ScreenshotResult> {
    const tab = this.getTab(options.tabId);
    const filename = `screenshot_${Date.now()}.${options.format || 'png'}`;
    const filepath = path.join(this.screenshotDir, filename);

    try {
      if (options.selector) {
        const element = await tab.page.$(options.selector);
        if (!element) {
          return { success: false, error: `Element not found: ${options.selector}` };
        }
        await element.screenshot({ path: filepath });
      } else {
        await tab.page.screenshot({
          path: filepath,
          fullPage: options.fullPage || false,
        });
      }

      const base64 = fs.readFileSync(filepath).toString('base64');

      return {
        success: true,
        path: filepath,
        base64,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Screenshot failed',
      };
    }
  }

  async waitForDownload(
    trigger: { selector?: string; targetRef?: unknown },
    tabId?: string,
  ): Promise<BrowserArtifactSummary> {
    const tab = this.getTab(tabId);
    const downloadPromise = tab.page.waitForEvent('download', { timeout: 15_000 });
    if (trigger.targetRef) {
      await this.clickTargetRef(trigger.targetRef, tabId);
    } else if (trigger.selector) {
      await tab.page.click(trigger.selector);
    } else {
      throw new Error('selector or targetRef required for wait_for_download');
    }

    const download = await downloadPromise;
    const suggestedName = sanitizeArtifactFilename(download.suggestedFilename() || `download_${Date.now()}`);
    fs.mkdirSync(this.downloadDir, { recursive: true });
    const artifactPath = path.join(this.downloadDir, suggestedName);
    await download.saveAs(artifactPath);
    return createBrowserArtifactSummary({
      kind: 'download',
      artifactPath,
      mimeType: inferMimeType(suggestedName),
      sessionId: this.sessionId,
    });
  }

  async uploadFile(args: {
    filePath: string;
    selector?: string;
    targetRef?: unknown;
    tabId?: string;
  }): Promise<BrowserArtifactSummary> {
    const resolvedFilePath = path.resolve(args.filePath);
    const stat = fs.statSync(resolvedFilePath);
    if (!stat.isFile()) {
      throw new Error(`Upload path is not a file: ${path.basename(resolvedFilePath)}`);
    }

    if (args.targetRef) {
      const resolved = await this.resolveTargetRef(args.targetRef, args.tabId);
      const tab = this.getTab(resolved.targetRef.tabId);
      await this.setUploadFileOnTarget(tab, resolved.targetRef.selector, resolvedFilePath);
    } else {
      if (!args.selector) {
        throw new Error('selector or targetRef required for upload_file');
      }
      const tab = this.getTab(args.tabId);
      await this.setUploadFileOnTarget(tab, args.selector, resolvedFilePath);
    }

    return createBrowserArtifactSummary({
      kind: 'upload',
      artifactPath: resolvedFilePath,
      mimeType: inferMimeType(resolvedFilePath),
      sessionId: this.sessionId,
    });
  }

  private async setUploadFileOnTarget(tab: BrowserTab, selector: string, filePath: string): Promise<void> {
    const locator = tab.page.locator(selector).first();
    const isFileInput = await locator.evaluate((element) => {
      return element.tagName.toLowerCase() === 'input'
        && (element.getAttribute('type') || '').toLowerCase() === 'file';
    }).catch(() => false);
    if (isFileInput) {
      await locator.setInputFiles(filePath);
      return;
    }

    const fileChooserPromise = tab.page.waitForEvent('filechooser', { timeout: 10_000 });
    await locator.click();
    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles(filePath);
  }

  // --------------------------------------------------------------------------
  // JavaScript Execution (for page scripting)
  // --------------------------------------------------------------------------

  async runScript<T>(script: string, tabId?: string): Promise<T> {
    const tab = this.getTab(tabId);
    return await tab.page.evaluate(script) as T;
  }

  // --------------------------------------------------------------------------
  // Account State
  // --------------------------------------------------------------------------

  async getAccountStateSummary(): Promise<ManagedBrowserAccountStateSummary> {
    await this.ensureBrowser();
    const state = await this.context!.storageState();
    const summary = await this.summarizeAccountState(state);
    this.lastAccountState = summary;
    return summary;
  }

  async exportStorageState(filePath?: string): Promise<BrowserStorageStateArtifact> {
    await this.ensureBrowser();
    const outputPath = filePath
      ? path.resolve(filePath)
      : path.join(this.screenshotDir, `storage_state_${Date.now()}.json`);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    const state = await this.context!.storageState({ path: outputPath });
    const accountState = await this.summarizeAccountState(state, outputPath);
    this.lastAccountState = accountState;
    return { path: outputPath, accountState };
  }

  async importStorageState(filePath: string): Promise<ManagedBrowserAccountStateSummary> {
    await this.ensureBrowser();
    const resolvedPath = path.resolve(filePath);
    const state = readBrowserStorageState(resolvedPath);
    const cookies = Array.isArray(state.cookies) ? state.cookies : [];
    const origins = Array.isArray(state.origins) ? state.origins : [];
    if (cookies.length > 0) {
      await this.context!.addCookies(cookies as Parameters<BrowserContext['addCookies']>[0]);
    }
    await this.installStorageStateInitScript(origins);
    await this.applyStorageStateToActivePage(origins).catch((error) => {
      this.logger.log('WARN', `Unable to apply imported localStorage to active page: ${error instanceof Error ? error.message : String(error)}`);
    });
    const accountState = await this.summarizeAccountState(state, resolvedPath);
    this.lastAccountState = accountState;
    return accountState;
  }

  // --------------------------------------------------------------------------
  // Form Handling
  // --------------------------------------------------------------------------

  async fillForm(formData: Record<string, string>, tabId?: string): Promise<void> {
    const tab = this.getTab(tabId);
    for (const [selector, value] of Object.entries(formData)) {
      await tab.page.fill(selector, value);
    }
  }

  async submitForm(formSelector: string, tabId?: string): Promise<void> {
    const tab = this.getTab(tabId);
    await tab.page.$eval(formSelector, (form: HTMLFormElement) => form.submit());
  }

  async selectOption(selector: string, value: string, tabId?: string): Promise<void> {
    const tab = this.getTab(tabId);
    await tab.page.selectOption(selector, value);
  }

  // --------------------------------------------------------------------------
  // Wait Utilities
  // --------------------------------------------------------------------------

  async waitForNavigation(tabId?: string): Promise<void> {
    const tab = this.getTab(tabId);
    await tab.page.waitForLoadState('domcontentloaded');
  }

  async waitForTimeout(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  beginTrace(args: {
    toolName: string;
    action: string;
    params?: Record<string, unknown>;
  }): WorkbenchActionTrace {
    this.heartbeatLease();
    return {
      id: `trace_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      targetKind: 'browser',
      toolName: args.toolName,
      action: args.action,
      mode: this.mode,
      provider: this.providerDiagnostics.provider,
      executable: this.providerDiagnostics.executable,
      cdpPort: this.providerDiagnostics.cdpPort,
      profileDir: this.profileDir,
      missingExecutable: this.providerDiagnostics.missingExecutable,
      recommendedAction: this.providerDiagnostics.recommendedAction,
      startedAtMs: Date.now(),
      before: this.snapshotActiveTab(),
      params: redactBrowserWorkbenchTraceParams(args.toolName, args.params || {}),
      consoleErrors: [],
      networkFailures: [],
    };
  }

  finishTrace(
    trace: WorkbenchActionTrace,
    args: {
      success: boolean;
      error?: string | null;
      screenshotPath?: string | null;
    },
  ): WorkbenchActionTrace {
    const completed: WorkbenchActionTrace = {
      ...trace,
      completedAtMs: Date.now(),
      after: this.snapshotActiveTab(args.screenshotPath || undefined),
      success: args.success,
      error: args.error || null,
      screenshotPath: args.screenshotPath || null,
      consoleErrors: this.consoleErrors.slice(-10),
      networkFailures: this.networkFailures.slice(-10),
    };
    this.traces.push(completed);
    this.traces = this.traces.slice(-100);
    return completed;
  }

  // --------------------------------------------------------------------------
  // Private Helpers
  // --------------------------------------------------------------------------

  private async launchSystemChromeCdp(resolution: BrowserProviderResolution): Promise<void> {
    const executable = resolution.systemExecutable;
    if (resolution.missingExecutable || !executable) {
      throw new Error(resolution.recommendedAction || 'System Chrome executable is missing');
    }

    const cdpPort = await findAvailablePort();
    this.updateProviderDiagnostics(resolution, { executable, cdpPort });
    const chromeArgs = buildSystemChromeCdpArgs({
      cdpPort,
      profileDir: this.profileDir,
      headless: this.mode === 'headless',
      viewport: this.viewport,
      proxy: this.proxyConfig,
    });

    const chromeProcess = spawn(executable, chromeArgs, {
      env: buildBrowserEnvironment(),
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    this.browserProcess = chromeProcess;
    chromeProcess.stderr?.on('data', (chunk) => {
      const message = String(chunk).trim();
      if (message) {
        this.logger.log('DEBUG', `[System Chrome] ${message.slice(0, 500)}`);
      }
    });
    chromeProcess.once('exit', (code, signal) => {
      if (this.browserProcess === chromeProcess) {
        this.logger.log('WARN', `System Chrome exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`);
        this.cleanupCrashedBrowserProcess();
      }
    });

    await Promise.race([
      this.waitForCdpEndpoint(cdpPort, chromeProcess),
      new Promise<never>((_, reject) => {
        chromeProcess.once('error', reject);
      }),
    ]);

    const pw = await getPlaywright();
    this.browser = await pw.chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
    this.context = this.browser.contexts()[0] || await this.browser.newContext({
      viewport: this.viewport,
      acceptDownloads: true,
      ignoreHTTPSErrors: false,
      proxy: this.getPlaywrightProxyOptions(),
      userAgent: getDefaultUserAgent(),
    });
    this.updateProviderDiagnostics(resolution, { executable, cdpPort });
  }

  private async launchPlaywrightBundled(
    resolution: BrowserProviderResolution,
    fallbackReason: string | null = null,
  ): Promise<void> {
    const pw = await getPlaywright();
    const executable = typeof pw.chromium.executablePath === 'function'
      ? pw.chromium.executablePath()
      : null;
    const playwrightExecutableMissing = !executable || !fs.existsSync(executable);
    this.updateProviderDiagnostics(
      {
        ...resolution,
        provider: 'playwright-bundled',
        providerFallbackReason: fallbackReason,
      },
      {
        executable,
        cdpPort: null,
        missingExecutable: resolution.missingExecutable || playwrightExecutableMissing,
        recommendedAction: playwrightExecutableMissing
          ? 'Run npx playwright install chromium to enable the bundled fallback, or use CODE_AGENT_BROWSER_PROVIDER=system-chrome-cdp with a valid Chrome executable.'
          : resolution.recommendedAction,
      },
    );
    this.context = await pw.chromium.launchPersistentContext(this.profileDir, {
      headless: this.mode === 'headless',
      viewport: this.viewport,
      acceptDownloads: true,
      downloadsPath: this.downloadDir,
      ignoreHTTPSErrors: false,
      proxy: this.getPlaywrightProxyOptions(),
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-extensions',
        '--disable-background-networking',
        '--no-first-run',
        '--no-default-browser-check',
      ],
      env: buildBrowserEnvironment(),
      userAgent: getDefaultUserAgent(),
    });
    this.browser = this.context.browser();
  }

  private async installContextGuards(): Promise<void> {
    if (!this.context) {
      throw new Error('Browser context was not created');
    }
    await this.context.route('**/*', async (route) => {
      const url = route.request().url();
      if (!this.isUrlAllowed(url)) {
      this.logger.log('WARN', `Blocked browser request: ${summarizeBrowserUrlForLog(url)}`);
        await route.abort('blockedbyclient');
        return;
      }
      await route.continue();
    });
  }

  private async waitForCdpEndpoint(port: number, chromeProcess: ChildProcess): Promise<void> {
    const startedAt = Date.now();
    const endpoint = `http://127.0.0.1:${port}/json/version`;
    while (Date.now() - startedAt < 10000) {
      if (chromeProcess.exitCode !== null || chromeProcess.signalCode !== null) {
        throw new Error(`System Chrome exited before CDP became ready (code=${chromeProcess.exitCode ?? 'null'}, signal=${chromeProcess.signalCode ?? 'null'})`);
      }
      try {
        const response = await fetch(endpoint);
        if (response.ok) {
          return;
        }
      } catch {
        // Chrome opens the debugging endpoint a moment after the process starts.
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    throw new Error(`Timed out waiting for Chrome CDP endpoint on port ${port}`);
  }

  private async cleanupFailedSystemChromeLaunch(args: { cleanupProfile: boolean }): Promise<void> {
    await this.context?.close().catch(() => undefined);
    await this.browser?.close().catch(() => undefined);
    this.context = null;
    this.browser = null;
    await this.stopSystemChromeProcess();
    if (args.cleanupProfile) {
      await this.cleanupIsolatedProfileDir();
      if (this.profileMode === 'isolated') {
        this.configureManagedBrowserSession('persistent');
      }
    }
  }

  private async stopSystemChromeProcess(): Promise<void> {
    const chromeProcess = this.browserProcess;
    this.browserProcess = null;
    if (chromeProcess?.exitCode !== null || chromeProcess.signalCode !== null) {
      return;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 1000);
      chromeProcess.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      chromeProcess.kill();
    });
  }

  private async summarizeAccountState(
    state: BrowserStorageStateLike,
    storageStatePath?: string,
  ): Promise<ManagedBrowserAccountStateSummary> {
    const cookies = normalizeStorageStateCookies(state.cookies);
    const origins = normalizeStorageStateOrigins(state.origins);
    const nowSeconds = Math.floor(Date.now() / 1000);
    const expiredCookieCount = cookies.filter((cookie) =>
      typeof cookie.expires === 'number' && cookie.expires > 0 && cookie.expires < nowSeconds
    ).length;
    const localStorageEntryCount = origins.reduce((sum, origin) => sum + origin.localStorage.length, 0);
    const sessionStorageEntryCount = origins.reduce((sum, origin) => sum + origin.sessionStorage.length, 0)
      + await this.getActivePageSessionStorageEntryCount();
    const status = expiredCookieCount > 0
      ? 'account_state_expired'
      : cookies.length > 0 || localStorageEntryCount > 0 || sessionStorageEntryCount > 0
        ? 'available'
        : 'empty';

    return {
      status,
      cookieCount: cookies.length,
      expiredCookieCount,
      originCount: origins.length,
      localStorageEntryCount,
      sessionStorageEntryCount,
      cookieDomains: Array.from(new Set(cookies.map((cookie) => cookie.domain).filter(Boolean))).sort(),
      origins: origins.map((origin) => origin.origin).filter(Boolean).sort(),
      updatedAtMs: Date.now(),
      storageStatePath: storageStatePath ? path.basename(storageStatePath) : null,
    };
  }

  private async getActivePageSessionStorageEntryCount(): Promise<number> {
    const tab = this.getActiveTab();
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

  private async installStorageStateInitScript(origins: unknown[]): Promise<void> {
    const safeOrigins = normalizeStorageStateOrigins(origins);
    if (safeOrigins.length === 0) {
      return;
    }
    await this.context!.addInitScript((originEntries) => {
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

  private async applyStorageStateToActivePage(origins: unknown[]): Promise<void> {
    const safeOrigins = normalizeStorageStateOrigins(origins);
    const tab = this.getActiveTab();
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

  private configureManagedBrowserSession(profileMode: ManagedBrowserProfileMode): void {
    const resolution = resolveManagedBrowserProfile({
      userDataDir: this.userDataDir,
      profileMode,
      workspaceScope: this.workspaceScope,
      agentId: this.agentId,
    });
    this.sessionId = resolution.sessionId;
    this.profileId = resolution.profileId;
    this.profileMode = resolution.profileMode;
    this.profileDir = resolution.profileDir;
    this.artifactDir = resolution.artifactDir;
    this.downloadDir = this.resolveDownloadDir(resolution.sessionId);
    this.isolatedProfileDir = resolution.temporary ? resolution.profileDir : null;
    this.isolatedProfileRootDir = resolution.isolatedRootDir;
    fs.mkdirSync(this.profileDir, { recursive: true });
    fs.mkdirSync(this.downloadDir, { recursive: true });
  }

  private resolveDownloadDir(sessionId: string | null): string {
    const safeSessionId = sanitizeManagedBrowserId(sessionId || 'browser-session');
    return path.join(this.artifactRootDir, safeSessionId, 'downloads');
  }

  private async cleanupIsolatedProfileDir(): Promise<void> {
    const profileDir = this.isolatedProfileDir;
    const rootDir = this.isolatedProfileRootDir;
    this.isolatedProfileDir = null;
    if (!profileDir || !rootDir) {
      return;
    }
    if (!shouldCleanupManagedBrowserProfile({
      profileMode: 'isolated',
      profileDir,
      temporary: true,
      isolatedRootDir: rootDir,
    })) {
      this.logger.log('WARN', 'Skipped isolated browser profile cleanup because the path was outside the managed isolated root');
      return;
    }
    await fs.promises.rm(profileDir, { recursive: true, force: true }).catch(() => {
      this.logger.log('WARN', `Failed to clean isolated browser profile ${this.profileId}`);
    });
  }

  private updateProviderDiagnostics(
    resolution: BrowserProviderResolution,
    runtime: {
      executable: string | null;
      cdpPort: number | null;
      missingExecutable?: boolean;
      recommendedAction?: string | null;
    },
  ): void {
    this.providerDiagnostics = {
      provider: resolution.provider,
      requestedProvider: resolution.requestedProvider,
      executable: runtime.executable,
      cdpPort: runtime.cdpPort,
      missingExecutable: runtime.missingExecutable ?? resolution.missingExecutable,
      recommendedAction: runtime.recommendedAction ?? resolution.recommendedAction,
      providerFallbackReason: resolution.providerFallbackReason,
    };
  }

  private createInitialProviderDiagnostics(): BrowserProviderDiagnostics {
    try {
      const resolution = resolveBrowserProvider();
      return {
        provider: resolution.provider,
        requestedProvider: resolution.requestedProvider,
        executable: resolution.provider === 'system-chrome-cdp' ? resolution.systemExecutable : null,
        cdpPort: null,
        missingExecutable: resolution.missingExecutable,
        recommendedAction: resolution.recommendedAction,
        providerFallbackReason: resolution.providerFallbackReason,
      };
    } catch (error) {
      return {
        provider: null,
        requestedProvider: null,
        executable: null,
        cdpPort: null,
        missingExecutable: false,
        recommendedAction: error instanceof Error ? error.message : String(error),
        providerFallbackReason: null,
      };
    }
  }

  // --------------------------------------------------------------------------
  // Disposable
  // --------------------------------------------------------------------------

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    try {
      await this.close();
    } catch (error) {
      this.logger.log('WARN', `Error during dispose: ${error}`);
    }
  }

  private async ensureBrowser(options: ManagedBrowserLaunchOptions = {}): Promise<void> {
    if (!this.isRunning()) {
      await this.launch(options);
    }
  }

  private async refreshTabMetadata(tab: BrowserTab): Promise<void> {
    tab.url = tab.page.url();
    tab.title = await tab.page.title().catch(() => tab.title);
  }

  private renewLease(args: { owner?: string; ttlMs?: number } = {}): ManagedBrowserLeaseState {
    const nowMs = Date.now();
    const lease = createManagedBrowserLease({
      owner: args.owner || this.lease?.owner || 'managed-browser',
      ttlMs: args.ttlMs,
      nowMs,
      leaseId: this.lease?.status === 'active' ? this.lease.leaseId : undefined,
      acquiredAtMs: this.lease?.status === 'active' ? this.lease.acquiredAtMs : undefined,
    });
    this.lease = lease;
    this.scheduleLeaseExpiry(lease);
    return lease;
  }

  private heartbeatLease(): void {
    if (this.lease?.status !== 'active') {
      return;
    }
    const nowMs = Date.now();
    if (isManagedBrowserLeaseExpired(this.lease, nowMs)) {
      this.markLeaseExpired(nowMs);
      return;
    }
    this.lease = {
      ...this.lease,
      lastHeartbeatAtMs: nowMs,
      expiresAtMs: nowMs + this.lease.ttlMs,
    };
    this.scheduleLeaseExpiry(this.lease);
  }

  private releaseLease(): void {
    this.clearLeaseTimer();
    if (!this.lease) {
      return;
    }
    const nowMs = Date.now();
    this.lease = {
      ...this.lease,
      lastHeartbeatAtMs: nowMs,
      expiresAtMs: nowMs,
      status: 'released',
    };
  }

  private getLeaseState(): ManagedBrowserLeaseState | null {
    if (!this.lease) {
      return null;
    }
    if (this.lease.status === 'active' && isManagedBrowserLeaseExpired(this.lease)) {
      this.markLeaseExpired();
    }
    return this.lease ? { ...this.lease } : null;
  }

  private scheduleLeaseExpiry(lease: ManagedBrowserLeaseState): void {
    this.clearLeaseTimer();
    if (lease.status !== 'active') {
      return;
    }
    const delayMs = Math.max(0, lease.expiresAtMs - Date.now());
    this.leaseTimer = setTimeout(() => {
      if (this.lease?.leaseId !== lease.leaseId || this.lease.status !== 'active') {
        return;
      }
      this.markLeaseExpired();
      this.logger.log('WARN', `Managed browser lease expired (${lease.leaseId}); closing session.`);
      void this.close().catch((error) => {
        this.logger.log('WARN', `Failed to close expired managed browser lease: ${error}`);
      });
    }, delayMs);
    this.leaseTimer.unref?.();
  }

  private clearLeaseTimer(): void {
    if (this.leaseTimer) {
      clearTimeout(this.leaseTimer);
      this.leaseTimer = null;
    }
  }

  private markLeaseExpired(nowMs: number = Date.now()): void {
    this.clearLeaseTimer();
    if (!this.lease) {
      return;
    }
    this.lease = {
      ...this.lease,
      lastHeartbeatAtMs: nowMs,
      expiresAtMs: Math.min(this.lease.expiresAtMs, nowMs),
      status: 'expired',
    };
  }

  private cleanupCrashedBrowserProcess(): void {
    this.browserProcess = null;
    this.browser = null;
    this.context = null;
    this.tabs.clear();
    this.targetRefs.clear();
    this.activeTabId = null;
    this.markLeaseExpired();
    this.emitSessionChanged('crashed');
  }

  private getPublicProxyConfig(): ManagedBrowserProxyConfig {
    return {
      ...this.proxyConfig,
      bypass: [...this.proxyConfig.bypass],
    };
  }

  private getPlaywrightProxyOptions(): { server: string; bypass?: string } | undefined {
    if (!this.proxyConfig.server || this.proxyConfig.mode === 'direct') {
      return undefined;
    }
    return {
      server: this.proxyConfig.server,
      bypass: this.proxyConfig.bypass.length > 0 ? this.proxyConfig.bypass.join(',') : undefined,
    };
  }

  private emitSessionChanged(reason: ManagedBrowserSessionChangeReason): void {
    try {
      broadcastToRenderer(IPC_CHANNELS.MANAGED_BROWSER_SESSION_CHANGED, {
        reason,
        session: this.getSessionState(),
      });
    } catch (error) {
      this.logger.log('WARN', `Failed to broadcast managed browser session change (${reason}): ${error}`);
    }
  }

  private getTab(tabId?: string): BrowserTab {
    const id = tabId || this.activeTabId;
    if (!id) {
      throw new Error('No active tab. Create a new tab first.');
    }
    const tab = this.tabs.get(id);
    if (!tab) {
      throw new Error(`Tab not found: ${id}`);
    }
    return tab;
  }

  private getDefaultMode(): ManagedBrowserMode {
    return process.env.CODE_AGENT_BROWSER_VISIBLE === '1'
      ? 'visible'
      : 'headless';
  }

  private createSnapshotId(): string {
    this.snapshotSequence += 1;
    return `snapshot_${Date.now()}_${this.snapshotSequence}`;
  }

  private pruneTargetRefs(now = Date.now()): void {
    for (const [refId, record] of this.targetRefs.entries()) {
      const ageMs = now - record.targetRef.capturedAtMs;
      if (ageMs > record.targetRef.ttlMs) {
        this.targetRefs.delete(refId);
      }
    }
  }

  private async resolveTargetRef(
    targetRefInput: unknown,
    overrideTabId?: string,
  ): Promise<{ targetRef: BrowserTargetRef }> {
    this.pruneTargetRefs();
    const { refId, snapshotId } = parseBrowserTargetRefInput(targetRefInput);
    if (!refId) {
      throw new BrowserTargetRefError('targetRef.refId is required. Refresh the DOM snapshot and retry with a fresh targetRef.', null, snapshotId);
    }

    const record = this.targetRefs.get(refId);
    if (!record) {
      throw new BrowserTargetRefError(`TargetRef ${refId} is stale or unknown. Refresh the DOM snapshot and retry.`, refId, snapshotId);
    }
    if (snapshotId && record.targetRef.snapshotId !== snapshotId) {
      throw new BrowserTargetRefError(`TargetRef ${refId} does not belong to snapshot ${snapshotId}. Refresh the DOM snapshot and retry.`, refId, snapshotId);
    }

    const tabId = overrideTabId || record.targetRef.tabId;
    if (tabId !== record.targetRef.tabId) {
      throw new BrowserTargetRefError(`TargetRef ${refId} belongs to a different tab. Refresh the DOM snapshot for the active tab and retry.`, refId, record.targetRef.snapshotId);
    }

    const tab = this.getTab(tabId);
    if (tab.page.url() !== record.url) {
      throw new BrowserTargetRefError(`TargetRef ${refId} is stale after navigation. Refresh the DOM snapshot and retry.`, refId, record.targetRef.snapshotId);
    }

    const element = await tab.page.$(record.targetRef.selector);
    if (!element) {
      throw new BrowserTargetRefError(`TargetRef ${refId} no longer resolves to an element. Refresh the DOM snapshot and retry.`, refId, record.targetRef.snapshotId);
    }
    await element.dispose().catch(() => undefined);

    return { targetRef: record.targetRef };
  }

  private snapshotActiveTab(screenshotPath?: string): WorkbenchSnapshotRef | null {
    const tab = this.getActiveTab();
    if (!tab) {
      return null;
    }

    return {
      url: tab.url,
      title: tab.title,
      screenshotPath: screenshotPath || null,
      capturedAtMs: Date.now(),
    };
  }

  private validateUrl(url: string): { allowed: true } | { allowed: false; reason: string } {
    if (this.isUrlAllowed(url)) {
      return { allowed: true };
    }
    return {
      allowed: false,
      reason: `URL is blocked by Browser Workbench policy: ${url}`,
    };
  }

  isUrlAllowed(url: string): boolean {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return false;
    }

    if (['about:', 'data:', 'blob:'].includes(parsed.protocol)) {
      return true;
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return false;
    }

    const host = parsed.hostname.toLowerCase();
    if (matchesHostList(host, this.blockedHosts)) {
      return false;
    }
    if (this.allowedHosts.length === 0) {
      return true;
    }
    return isLocalHost(host) || matchesHostList(host, this.allowedHosts);
  }
}

// Default agent BrowserService — IPC 接入层和未传 agentId 的工具实现层用这一个。
// 多 agent 隔离请通过 `getBrowserService(agentId)` 或 `browserPool.acquire(agentId)`
// 拿到 per-agent 实例（见 ./browserPool.ts）。
import { browserPool } from './browserPool';
const browserServiceInstance = browserPool.acquire();
getServiceRegistry().register('BrowserService', browserServiceInstance);
export const browserService = browserServiceInstance;
