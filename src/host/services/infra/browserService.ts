// ============================================================================
// BrowserService - Browser automation using Playwright
// Provides programmatic browser control for all agents
// Logs are transparent and returned to the agent for visibility
// ============================================================================

import type { Browser, BrowserContext, Page, Route } from 'playwright';
import { randomUUID } from 'node:crypto';
import * as path from 'path';
import * as fs from 'fs';
import { type ChildProcess } from 'child_process';
import { app, broadcastToRenderer } from '../../platform';
import type { Disposable } from '../serviceRegistry';
import { getServiceRegistry } from '../serviceRegistry';
import type {
  ManagedBrowserAccountStateSummary,
  ManagedBrowserMode,
  ManagedBrowserProfileMode,
  ManagedBrowserProxyConfig,
  ManagedBrowserSessionState,
  WorkbenchActionTrace,
} from '../../../shared/contract/desktop';
import { IPC_CHANNELS } from '../../../shared/ipc';
import {
  resolveBrowserProvider,
  type BrowserProviderResolution,
} from './browserProvider';
import { BrowserLogger } from './browser/logger';
import { browserRelayService } from './browserRelayService';
import {
  applyStorageStateToPage,
  getBrowserPageSessionStorageEntryCount,
  installStorageStateInitScript,
  summarizeBrowserAccountState,
} from './browser/accountStateHelpers';
import {
  captureBrowserScreenshot, type ApprovedBrowserUploadFile,
  uploadBrowserFile,
  waitForBrowserDownload,
} from './browser/browserArtifactActions';
import {
  beginBrowserWorkbenchTrace,
  finishBrowserWorkbenchTrace,
} from './browser/browserTraceLifecycle';
import {
  buildBrowserProviderDiagnostics,
  createInitialBrowserProviderDiagnostics,
} from './browser/browserProviderDiagnostics';
import {
  buildManagedBrowserSessionState,
  snapshotBrowserTab,
} from './browser/browserSessionState';
import {
  isBrowserWorkbenchUrlAllowed,
  validateBrowserWorkbenchUrl,
} from './browser/browserUrlPolicy';
import {
  getPlaywrightProxyOptions,
  launchPlaywrightBundledBrowser,
  launchSystemChromeCdpBrowser,
} from './browser/browserLaunchHelpers';
import { ManagedBrowserLeaseController } from './browser/managedBrowserLeaseController';
import {
  findBrowserElementByText,
  findBrowserElements,
  getBrowserElementBoundingBox,
  getBrowserPageContent,
  getBrowserPageHtml,
} from './browser/pageInspectionHelpers';
import { BrowserTargetRefRegistry } from './browser/targetRefRegistry';
import {
  dragBrowserTargetRefs,
  captureBrowserDomSnapshot,
  getBrowserAccessibilitySnapshot,
  getBrowserDialogState,
  handleBrowserDialog,
  hoverBrowserTargetRef,
  readBrowserClipboardMetadata,
  waitForBrowserSelector,
  writeBrowserClipboard,
  type BrowserPendingDialog,
} from './browser/browserSurfaceInteractions';
import {
  MANAGED_BROWSER_ARTIFACT_DIR,
  MANAGED_BROWSER_ARTIFACT_ROOT_DIR,
  getDefaultUserAgent,
  getManagedBrowserProxyFingerprint,
  parseHostList,
  readBrowserStorageState,
  resolveManagedBrowserProfile,
  resolveManagedBrowserProxyConfig,
  resolveManagedBrowserWorkspaceScope,
  sanitizeManagedBrowserId,
  shouldCleanupManagedBrowserProfile,
  summarizeBrowserUrlForLog,
} from './browser/managedBrowserHelpers';
import {
  type BrowserArtifactSummary,
  type BrowserDialogState,
  type BrowserDomSnapshot,
  type BrowserProviderDiagnostics,
  type BrowserStorageStateArtifact,
  type BrowserTab,
  type BrowserTargetRef,
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
  | 'dialog'
  | 'import_profile_cookies'
  | 'clear_cookies'
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
  private leaseController: ManagedBrowserLeaseController;
  private proxyConfig: ManagedBrowserProxyConfig;
  private mode: ManagedBrowserMode;
  private viewport = { width: 1280, height: 720 };
  private traces: WorkbenchActionTrace[] = [];
  private targetRefs = new BrowserTargetRefRegistry();
  private pendingDialogs = new Map<string, BrowserPendingDialog>();
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
    this.providerDiagnostics = createInitialBrowserProviderDiagnostics(() => resolveBrowserProvider());
    this.leaseController = new ManagedBrowserLeaseController((lease) => {
      this.logger.log('WARN', `Managed browser lease expired (${lease.leaseId}); closing session.`);
      void this.close().catch((error) => {
        this.logger.log('WARN', `Failed to close expired managed browser lease: ${error}`);
      });
    });
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
      this.leaseController.renew({
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
    this.leaseController.renew({
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
      this.pendingDialogs.clear();
      this.activeTabId = null;
      this.leaseController.release();
      await this.cleanupIsolatedProfileDir();
      if (this.profileMode === 'isolated') {
        this.configureManagedBrowserSession('persistent');
      }
      this.logger.log('INFO', 'Browser closed, all tabs cleared');
      this.emitSessionChanged('close');
    } else {
      this.leaseController.release();
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
    const tabId = `tab_${randomUUID()}`;

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

    page.on('dialog', (dialog) => {
      this.pendingDialogs.set(tabId, { dialog, openedAtMs: Date.now() });
      this.logger.log('WARN', `Browser dialog paused for explicit handling (${dialog.type()})`);
      this.emitSessionChanged('dialog');
    });
    page.on('close', () => this.pendingDialogs.delete(tabId));

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
      this.pendingDialogs.delete(tabId);
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
    return buildManagedBrowserSessionState({
      sessionId: this.sessionId,
      profileId: this.profileId,
      profileMode: this.profileMode,
      workspaceScope: this.workspaceScope,
      artifactDir: this.artifactDir,
      lease: this.leaseController.getState(),
      proxy: this.proxyConfig,
      externalBridge: browserRelayService.getState(),
      accountState: this.lastAccountState,
      running: this.isRunning(),
      tabCount: this.tabs.size,
      activeTab: this.getActiveTab(),
      mode: this.mode,
      providerDiagnostics: this.providerDiagnostics,
      profileDir: this.profileDir,
      viewport: this.viewport,
      allowedHosts: this.allowedHosts,
      blockedHosts: this.blockedHosts,
      lastTrace: this.traces.at(-1) || null,
    });
  }

  async ensureSession(url: string = 'about:blank', options: ManagedBrowserLaunchOptions = {}): Promise<ManagedBrowserSessionState> {
    await this.ensureBrowser(options);
    this.leaseController.renew({
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
    this.targetRefs.clear();
    await this.refreshTabMetadata(tab);
    this.logger.log('INFO', `Navigation complete: "${tab.title}"`);
    this.emitSessionChanged('navigate');
  }

  async goBack(tabId?: string): Promise<void> {
    this.logger.log('INFO', 'Going back in history');
    const tab = this.getTab(tabId);
    await tab.page.goBack();
    this.targetRefs.clear();
    await this.refreshTabMetadata(tab);
    this.emitSessionChanged('history');
  }

  async goForward(tabId?: string): Promise<void> {
    const tab = this.getTab(tabId);
    await tab.page.goForward();
    this.targetRefs.clear();
    await this.refreshTabMetadata(tab);
    this.emitSessionChanged('history');
  }

  async reload(tabId?: string): Promise<void> {
    const tab = this.getTab(tabId);
    await tab.page.reload();
    this.targetRefs.clear();
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

  async click(selector: string, tabId?: string): Promise<void> { await this.getTab(tabId).page.click(selector); }

  async getElementBoundingBox(selector: string, tabId?: string): Promise<ElementInfo['rect'] | null> {
    return getBrowserElementBoundingBox(this.getTab(tabId), selector);
  }

  async clickTargetRef(targetRefInput: unknown, tabId?: string): Promise<BrowserTargetRef> {
    return await this.targetRefs.click(targetRefInput, (id) => this.getTab(id), tabId);
  }

  async clickAtPosition(x: number, y: number, tabId?: string): Promise<void> {
    await this.getTab(tabId).page.mouse.click(x, y);
  }

  async type(selector: string, text: string, tabId?: string): Promise<void> {
    await this.getTab(tabId).page.fill(selector, text);
  }

  async typeTargetRef(targetRefInput: unknown, text: string, tabId?: string): Promise<BrowserTargetRef> {
    return await this.targetRefs.fill(targetRefInput, text, (id) => this.getTab(id), tabId);
  }

  async typeAtFocus(text: string, tabId?: string): Promise<void> { await this.getTab(tabId).page.keyboard.type(text); }

  async pressKey(key: string, tabId?: string): Promise<void> { await this.getTab(tabId).page.keyboard.press(key); }

  async scroll(direction: 'up' | 'down', amount: number = 300, tabId?: string): Promise<void> {
    const tab = this.getTab(tabId);
    const delta = direction === 'down' ? amount : -amount;
    await tab.page.mouse.wheel(0, delta);
  }

  async hover(selector: string, tabId?: string): Promise<void> { await this.getTab(tabId).page.hover(selector); }

  async hoverTargetRef(targetRefInput: unknown, tabId?: string): Promise<BrowserTargetRef> {
    return hoverBrowserTargetRef({
      getTab: (id) => this.getTab(id), registry: this.targetRefs, tabId, targetRefInput,
    });
  }

  async dragTargetRefs(
    sourceTargetRefInput: unknown,
    destinationTargetRefInput: unknown,
    tabId?: string,
  ): Promise<{ source: BrowserTargetRef; destination: BrowserTargetRef }> {
    return dragBrowserTargetRefs({
      destinationTargetRefInput, getTab: (id) => this.getTab(id), registry: this.targetRefs,
      sourceTargetRefInput, tabId,
    });
  }

  getDialogState(tabId?: string): BrowserDialogState {
    return getBrowserDialogState({
      getTab: (id) => this.getTab(id), pendingDialogs: this.pendingDialogs, tabId,
    });
  }

  async handleDialog(
    action: 'accept' | 'dismiss',
    promptText?: string,
    tabId?: string,
  ): Promise<BrowserDialogState> {
    return handleBrowserDialog({
      action, emitChanged: () => this.emitSessionChanged('dialog'), getTab: (id) => this.getTab(id),
      pendingDialogs: this.pendingDialogs, promptText, tabId,
    });
  }

  async readClipboardMetadata(tabId?: string): Promise<{ textLength: number }> {
    return readBrowserClipboardMetadata(this.getTab(tabId));
  }

  async writeClipboard(text: string, tabId?: string): Promise<void> {
    await writeBrowserClipboard(this.getTab(tabId), text);
  }

  async waitForSelector(selector: string, timeout: number = 5000, tabId?: string): Promise<boolean> {
    return waitForBrowserSelector(this.getTab(tabId), selector, timeout);
  }

  // --------------------------------------------------------------------------
  // Page Content
  // --------------------------------------------------------------------------

  async getPageContent(tabId?: string): Promise<PageContent> {
    const tab = this.getTab(tabId);
    return await getBrowserPageContent(tab);
  }

  async getPageHTML(tabId?: string): Promise<string> {
    const tab = this.getTab(tabId);
    return await getBrowserPageHtml(tab);
  }

  async findElements(selector: string, tabId?: string): Promise<ElementInfo[]> {
    const tab = this.getTab(tabId);
    return await findBrowserElements(tab, selector);
  }

  async findElementByText(text: string, tabId?: string): Promise<ElementInfo | null> {
    const tab = this.getTab(tabId);
    return await findBrowserElementByText(tab, text);
  }

  async getInteractiveElements(tabId?: string): Promise<ElementInfo[]> {
    const tab = this.getTab(tabId);
    const selectors = 'button, a, input, select, textarea, [role="button"], [onclick]';
    return this.findElements(selectors, tab.id);
  }

  async getDomSnapshot(tabId?: string): Promise<BrowserDomSnapshot> {
    return captureBrowserDomSnapshot(this.getTab(tabId), this.targetRefs);
  }

  async getAccessibilitySnapshot(tabId?: string): Promise<unknown> {
    const tab = this.getTab(tabId);
    return getBrowserAccessibilitySnapshot(tab, () => this.getDomSnapshot(tab.id));
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
    return await captureBrowserScreenshot({
      tab,
      screenshotDir: this.screenshotDir,
      options,
    });
  }

  async waitForDownload(
    trigger: { selector?: string; targetRef?: unknown },
    tabId?: string,
  ): Promise<BrowserArtifactSummary> {
    const tab = this.getTab(tabId);
    return await waitForBrowserDownload({
      tab,
      trigger,
      clickTargetRef: async (targetRef) => await this.clickTargetRef(targetRef, tabId),
      downloadDir: this.downloadDir,
      sessionId: this.sessionId,
    });
  }

  async uploadFile(args: {
    approvedFile: ApprovedBrowserUploadFile;
    selector?: string;
    targetRef?: unknown;
    tabId?: string;
  }): Promise<BrowserArtifactSummary> {
    return await uploadBrowserFile({
      ...args,
      sessionId: this.sessionId,
      getTab: (id) => this.getTab(id),
      resolveTargetRef: async (targetRef, overrideTabId) =>
        await this.targetRefs.resolve(targetRef, (id) => this.getTab(id), overrideTabId),
    });
  }

  // --------------------------------------------------------------------------
  // JavaScript Execution (for page scripting)
  // --------------------------------------------------------------------------

  async runScript<T>(script: string, tabId?: string): Promise<T> {
    const tab = this.getTab(tabId);
    return await tab.page.evaluate(script) as T;
  }

  async withIsolatedPage<T>(options: {
    viewport?: { width: number; height: number };
    leaseOwner?: string;
    leaseTtlMs?: number;
    route?: (route: Route) => Promise<boolean>;
    run: (page: Page) => Promise<T>;
  }): Promise<T> {
    await this.ensureBrowser({
      leaseOwner: options.leaseOwner || 'isolated-page',
      leaseTtlMs: options.leaseTtlMs,
    });
    const browser = this.browser || this.context?.browser();
    if (!browser) {
      throw new Error('Managed browser cannot create an isolated context in this runtime.');
    }

    const viewport = options.viewport
      ? {
          width: Math.max(320, Math.floor(options.viewport.width)),
          height: Math.max(240, Math.floor(options.viewport.height)),
        }
      : this.viewport;
    const context = await browser.newContext({
      viewport,
      acceptDownloads: false,
      ignoreHTTPSErrors: false,
      proxy: getPlaywrightProxyOptions(this.proxyConfig),
      userAgent: getDefaultUserAgent(),
    });

    await context.route('**/*', async (route) => {
      try {
        if (await options.route?.(route)) {
          return;
        }
        const url = route.request().url();
        if (!this.isUrlAllowed(url)) {
          this.logger.log('WARN', `Blocked isolated browser request: ${summarizeBrowserUrlForLog(url)}`);
          await route.abort('blockedbyclient');
          return;
        }
        await route.continue();
      } catch (error) {
        this.logger.log('WARN', `Isolated browser route handler failed: ${error instanceof Error ? error.message : String(error)}`);
        await route.abort('failed').catch(() => undefined);
      }
    });

    const page = await context.newPage();
    try {
      return await options.run(page);
    } finally {
      await context.close().catch((error) => {
        this.logger.log('WARN', `Failed to close isolated browser context: ${error instanceof Error ? error.message : String(error)}`);
      });
      this.leaseController.heartbeat();
    }
  }

  // --------------------------------------------------------------------------
  // Account State
  // --------------------------------------------------------------------------

  async getAccountStateSummary(): Promise<ManagedBrowserAccountStateSummary> {
    await this.ensureBrowser();
    const state = await this.context!.storageState();
    const activeSessionStorageEntryCount = await getBrowserPageSessionStorageEntryCount(this.getActiveTab());
    const summary = summarizeBrowserAccountState({
      state,
      activeSessionStorageEntryCount,
    });
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
    const activeSessionStorageEntryCount = await getBrowserPageSessionStorageEntryCount(this.getActiveTab());
    const accountState = summarizeBrowserAccountState({
      state,
      storageStatePath: outputPath,
      activeSessionStorageEntryCount,
    });
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
    await installStorageStateInitScript(this.context!, origins);
    await applyStorageStateToPage(this.getActiveTab(), origins).catch((error) => {
      this.logger.log('WARN', `Unable to apply imported localStorage to active page: ${error instanceof Error ? error.message : String(error)}`);
    });
    const activeSessionStorageEntryCount = await getBrowserPageSessionStorageEntryCount(this.getActiveTab());
    const accountState = summarizeBrowserAccountState({
      state,
      storageStatePath: resolvedPath,
      activeSessionStorageEntryCount,
    });
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
    this.leaseController.heartbeat();
    return beginBrowserWorkbenchTrace({
      ...args,
      mode: this.mode,
      providerDiagnostics: this.providerDiagnostics,
      profileDir: this.profileDir,
      before: snapshotBrowserTab(this.getActiveTab()),
    });
  }

  finishTrace(
    trace: WorkbenchActionTrace,
    args: {
      success: boolean;
      error?: string | null;
      screenshotPath?: string | null;
    },
  ): WorkbenchActionTrace {
    const completed = finishBrowserWorkbenchTrace(trace, {
      ...args,
      after: snapshotBrowserTab(this.getActiveTab(), args.screenshotPath || undefined),
      consoleErrors: this.consoleErrors.slice(-10),
      networkFailures: this.networkFailures.slice(-10),
    });
    this.traces.push(completed);
    this.traces = this.traces.slice(-100);
    return completed;
  }

  // --------------------------------------------------------------------------
  // Private Helpers
  // --------------------------------------------------------------------------

  private async launchSystemChromeCdp(resolution: BrowserProviderResolution): Promise<void> {
    this.updateProviderDiagnostics(resolution, {
      executable: resolution.systemExecutable,
      cdpPort: null,
    });
    const launched = await launchSystemChromeCdpBrowser({
      resolution,
      profileDir: this.profileDir,
      mode: this.mode,
      viewport: this.viewport,
      proxy: this.proxyConfig,
      logger: this.logger,
      onProcessStart: (chromeProcess) => {
        this.browserProcess = chromeProcess;
      },
      onProcessExit: (chromeProcess, code, signal) => {
        if (this.browserProcess === chromeProcess) {
          this.logger.log('WARN', `System Chrome exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`);
          this.cleanupCrashedBrowserProcess();
        }
      },
    });
    this.browser = launched.browser;
    this.context = launched.context;
    this.updateProviderDiagnostics(resolution, {
      executable: launched.executable,
      cdpPort: launched.cdpPort,
    });
  }

  private async launchPlaywrightBundled(
    resolution: BrowserProviderResolution,
    fallbackReason: string | null = null,
  ): Promise<void> {
    const launched = await launchPlaywrightBundledBrowser({
      resolution,
      fallbackReason,
      profileDir: this.profileDir,
      downloadDir: this.downloadDir,
      mode: this.mode,
      viewport: this.viewport,
      proxy: this.proxyConfig,
      logger: this.logger,
    });
    this.updateProviderDiagnostics(
      {
        ...resolution,
        provider: 'playwright-bundled',
        providerFallbackReason: fallbackReason,
      },
      {
        executable: launched.executable,
        cdpPort: null,
        missingExecutable: resolution.missingExecutable || launched.missingExecutable,
        recommendedAction: launched.recommendedAction,
      },
    );
    this.context = launched.context;
    this.browser = launched.browser;
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
    this.providerDiagnostics = buildBrowserProviderDiagnostics(resolution, runtime);
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

  private cleanupCrashedBrowserProcess(): void {
    this.browserProcess = null;
    this.browser = null;
    this.context = null;
    this.tabs.clear();
    this.targetRefs.clear();
    this.pendingDialogs.clear();
    this.activeTabId = null;
    this.leaseController.markExpired();
    this.emitSessionChanged('crashed');
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

  private validateUrl(url: string): { allowed: true } | { allowed: false; reason: string } {
    return validateBrowserWorkbenchUrl(url, {
      allowedHosts: this.allowedHosts,
      blockedHosts: this.blockedHosts,
    });
  }

  isUrlAllowed(url: string): boolean {
    return isBrowserWorkbenchUrlAllowed(url, {
      allowedHosts: this.allowedHosts,
      blockedHosts: this.blockedHosts,
    });
  }
}

// Default agent BrowserService — IPC 接入层和未传 agentId 的工具实现层用这一个。
// 多 agent 隔离请通过 `getBrowserService(agentId)` 或 `browserPool.acquire(agentId)`
// 拿到 per-agent 实例（见 ./browserPool.ts）。pool 的 default key 复用本实例，
// 保证 IPC 路径和工具未传 agentId 路径看到同一个 BrowserContext。
const browserServiceInstance = new BrowserService();
getServiceRegistry().register('BrowserService', browserServiceInstance);
export const browserService = browserServiceInstance;
