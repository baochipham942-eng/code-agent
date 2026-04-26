// ============================================================================
// BrowserService - Browser automation using Playwright
// Provides programmatic browser control for all agents
// Logs are transparent and returned to the agent for visibility
// ============================================================================

import type { Browser, Page, BrowserContext } from 'playwright';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as crypto from 'crypto';
import { spawn, type ChildProcess } from 'child_process';
import { app } from '../../platform';
import { logCollector } from '../../mcp/logCollector.js';
import { createLogger } from './logger';
import type { Disposable } from '../serviceRegistry';
import { getServiceRegistry } from '../serviceRegistry';
import type {
  ManagedBrowserAccountStateSummary,
  ManagedBrowserExternalBridgeState,
  ManagedBrowserLeaseState,
  ManagedBrowserMode,
  ManagedBrowserProfileMode,
  ManagedBrowserProxyConfig,
  ManagedBrowserProxyMode,
  ManagedBrowserProvider,
  ManagedBrowserProviderPreference,
  ManagedBrowserSessionState,
  WorkbenchActionTrace,
  WorkbenchSnapshotRef,
} from '../../../shared/contract/desktop';
import {
  redactBrowserComputerInputArgs,
  redactBrowserComputerInputPayloadsInValue,
} from '../../../shared/utils/browserComputerRedaction';
import {
  buildSystemChromeCdpArgs,
  findAvailablePort,
  resolveBrowserProvider,
  type BrowserProviderResolution,
} from './browserProvider';

// Lazy-load playwright to avoid hard dependency at module load time
// (e.g., when bundled for test runner where playwright is not installed)
let _playwright: typeof import('playwright') | null = null;
async function getPlaywright() {
  if (!_playwright) {
    _playwright = await import('playwright');
  }
  return _playwright;
}

const serviceLogger = createLogger('BrowserService');
const MANAGED_BROWSER_PERSISTENT_PROFILE_ID = 'managed-browser-profile';
const MANAGED_BROWSER_ARTIFACT_DIR = 'screenshots';
const MANAGED_BROWSER_ARTIFACT_ROOT_DIR = 'managed-browser-artifacts';
const MANAGED_BROWSER_ISOLATED_PROFILE_PREFIX = 'code-agent-managed-browser-';
const BROWSER_TARGET_REF_TTL_MS = 60_000;
const MANAGED_BROWSER_DEFAULT_LEASE_TTL_MS = 30 * 60_000;
const MANAGED_BROWSER_MIN_LEASE_TTL_MS = 5_000;
const MANAGED_BROWSER_MAX_LEASE_TTL_MS = 4 * 60 * 60_000;
const MANAGED_BROWSER_EXTERNAL_BRIDGE_UNSUPPORTED: ManagedBrowserExternalBridgeState = {
  enabled: false,
  status: 'unsupported',
  requiresExplicitAuthorization: true,
  reason: 'External browser attach and extension bridge are intentionally disabled for the in-app managed browser baseline.',
};

// Log collector for transparent operation logging
export class BrowserLogger {
  private logs: string[] = [];
  private maxLogs: number = 100;

  log(level: 'INFO' | 'WARN' | 'ERROR' | 'DEBUG', message: string): void {
    const timestamp = new Date().toISOString().split('T')[1].split('.')[0];
    const entry = `[${timestamp}] [${level}] ${message}`;
    this.logs.push(entry);
    serviceLogger.debug(entry);

    // Also send to centralized LogCollector for MCP access
    logCollector.browser(level, message);

    // Keep only recent logs
    if (this.logs.length > this.maxLogs) {
      this.logs = this.logs.slice(-this.maxLogs);
    }
  }

  getLogs(count?: number): string[] {
    return count ? this.logs.slice(-count) : [...this.logs];
  }

  getLogsAsString(count?: number): string {
    return this.getLogs(count).join('\n');
  }

  clear(): void {
    this.logs = [];
  }
}

export interface BrowserTab {
  id: string;
  page: Page;
  url: string;
  title: string;
}

export interface ScreenshotResult {
  success: boolean;
  path?: string;
  base64?: string;
  error?: string;
}

export interface PageContent {
  url: string;
  title: string;
  text: string;
  html?: string;
  links?: Array<{ text: string; href: string }>;
}

export interface ElementInfo {
  selector: string;
  text: string;
  tagName: string;
  attributes: Record<string, string>;
  rect: { x: number; y: number; width: number; height: number };
}

export interface BrowserTargetRef {
  refId: string;
  source: 'dom';
  selector: string;
  role?: string | null;
  name?: string | null;
  textHint?: string | null;
  frameId?: string | null;
  tabId: string;
  snapshotId: string;
  capturedAtMs: number;
  ttlMs: number;
  confidence: number;
}

export interface BrowserDomSnapshot {
  snapshotId: string;
  tabId: string;
  capturedAtMs: number;
  url: string;
  title: string;
  headings: Array<{ level: number; text: string }>;
  interactiveElements: Array<{
    tag: string;
    role?: string | null;
    text: string;
    ariaLabel?: string | null;
    placeholder?: string | null;
    selectorHint: string;
    targetRef: BrowserTargetRef;
    rect: { x: number; y: number; width: number; height: number };
  }>;
}

export interface ManagedBrowserLaunchOptions {
  mode?: ManagedBrowserMode;
  provider?: ManagedBrowserProviderPreference;
  profileMode?: ManagedBrowserProfileMode;
  leaseOwner?: string;
  leaseTtlMs?: number;
  proxy?: ManagedBrowserProxyInput | null;
}

export interface ManagedBrowserProxyInput {
  mode?: ManagedBrowserProxyMode | 'auto' | 'none' | 'off' | 'direct';
  server?: string | null;
  bypass?: string[] | string | null;
  regionHint?: string | null;
}

export interface ManagedBrowserProfileResolution {
  sessionId: string;
  profileId: string;
  profileMode: ManagedBrowserProfileMode;
  profileDir: string;
  workspaceScope: string;
  artifactDir: string;
  temporary: boolean;
  isolatedRootDir: string | null;
}

export interface BrowserStorageStateArtifact {
  path: string;
  accountState: ManagedBrowserAccountStateSummary;
}

export interface BrowserArtifactSummary {
  artifactId: string;
  kind: 'download' | 'upload';
  name: string;
  artifactPath: string;
  size: number;
  mimeType: string | null;
  sha256: string;
  createdAtMs: number;
  sessionId: string | null;
}

interface BrowserStorageStateCookie {
  name?: unknown;
  value?: unknown;
  domain?: unknown;
  path?: unknown;
  expires?: unknown;
  httpOnly?: unknown;
  secure?: unknown;
  sameSite?: unknown;
}

interface BrowserStorageStateOrigin {
  origin?: unknown;
  localStorage?: unknown;
  sessionStorage?: unknown;
}

interface BrowserStorageStateLike {
  cookies?: unknown;
  origins?: unknown;
}

interface BrowserProviderDiagnostics {
  provider: ManagedBrowserProvider | null;
  requestedProvider: ManagedBrowserProviderPreference | null;
  executable: string | null;
  cdpPort: number | null;
  missingExecutable: boolean;
  recommendedAction: string | null;
  providerFallbackReason: string | null;
}

interface BrowserTargetRefRecord {
  targetRef: BrowserTargetRef;
  url: string;
}

export class BrowserTargetRefError extends Error {
  readonly code = 'STALE_TARGET_REF';
  readonly recoverable = true;
  readonly retryHint = 'Run browser_action.get_dom_snapshot and retry with a fresh targetRef.';

  constructor(
    message: string,
    readonly refId: string | null,
    readonly snapshotId: string | null,
  ) {
    super(message);
    this.name = 'BrowserTargetRefError';
  }
}

class BrowserService implements Disposable {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private browserProcess: ChildProcess | null = null;
  private tabs: Map<string, BrowserTab> = new Map();
  private activeTabId: string | null = null;
  private disposed = false;
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

  constructor() {
    const userData = app?.getPath('userData') || process.cwd();
    this.userDataDir = userData;
    this.screenshotDir = path.join(userData, MANAGED_BROWSER_ARTIFACT_DIR);
    this.artifactRootDir = path.join(userData, MANAGED_BROWSER_ARTIFACT_ROOT_DIR);
    this.workspaceScope = resolveManagedBrowserWorkspaceScope(process.cwd());
    const initialProfile = resolveManagedBrowserProfile({
      userDataDir: userData,
      profileMode: 'persistent',
      workspaceScope: this.workspaceScope,
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
    } else {
      this.releaseLease();
      this.logger.log('WARN', 'No browser to close');
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

    // Update tab info on navigation
    page.on('load', async () => {
      tab.url = page.url();
      tab.title = await page.title();
      this.logger.log('DEBUG', `Page loaded: ${summarizeBrowserUrlForLog(tab.url)} - "${tab.title}"`);
    });

    // Log console messages from the page
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
    tab.url = tab.page.url();
    tab.title = await tab.page.title();
    this.logger.log('INFO', `Navigation complete: "${tab.title}"`);
  }

  async goBack(tabId?: string): Promise<void> {
    this.logger.log('INFO', 'Going back in history');
    const tab = this.getTab(tabId);
    await tab.page.goBack();
  }

  async goForward(tabId?: string): Promise<void> {
    const tab = this.getTab(tabId);
    await tab.page.goForward();
  }

  async reload(tabId?: string): Promise<void> {
    const tab = this.getTab(tabId);
    await tab.page.reload();
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
      text: text.substring(0, 10000), // Limit text length
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
        selector: '', // Will be filled by caller if needed
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
            while (current && current.nodeType === Node.ELEMENT_NODE) {
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
    // Playwright's evaluate runs script in page context
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
    if (!chromeProcess || chromeProcess.exitCode !== null || chromeProcess.signalCode !== null) {
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
    if (!this.lease || this.lease.status !== 'active') {
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
      if (!this.lease || this.lease.leaseId !== lease.leaseId || this.lease.status !== 'active') {
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

function parseHostList(value: string | undefined): string[] {
  return (value || '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function matchesHostList(host: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    if (pattern.startsWith('*.')) {
      const suffix = pattern.slice(1);
      return host.endsWith(suffix);
    }
    return host === pattern || host.endsWith(`.${pattern}`);
  });
}

function isLocalHost(host: string): boolean {
  return host === 'localhost'
    || host === '127.0.0.1'
    || host === '::1'
    || host.endsWith('.local');
}

function buildBrowserEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL']) {
    const value = process.env[key];
    if (value) {
      env[key] = value;
    }
  }
  return env;
}

function getDefaultUserAgent(): string {
  return 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
}

function summarizeBrowserUrlForLog(value: string): string {
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

export function resolveManagedBrowserWorkspaceScope(workspacePath: string): string {
  const name = path.basename(path.resolve(workspacePath || process.cwd()));
  return sanitizeManagedBrowserId(name || 'workspace');
}

export function createManagedBrowserSessionId(now = Date.now()): string {
  return `browser_session_${now}_${Math.random().toString(36).slice(2, 8)}`;
}

export function createManagedBrowserLease(args: {
  owner?: string | null;
  ttlMs?: number | null;
  nowMs?: number;
  leaseId?: string | null;
  acquiredAtMs?: number | null;
} = {}): ManagedBrowserLeaseState {
  const nowMs = args.nowMs ?? Date.now();
  const ttlMs = clampManagedBrowserLeaseTtl(args.ttlMs);
  return {
    leaseId: args.leaseId || `lease_${nowMs}_${Math.random().toString(36).slice(2, 8)}`,
    owner: sanitizeManagedBrowserId(args.owner || 'managed-browser'),
    acquiredAtMs: args.acquiredAtMs || nowMs,
    lastHeartbeatAtMs: nowMs,
    expiresAtMs: nowMs + ttlMs,
    ttlMs,
    status: 'active',
  };
}

export function isManagedBrowserLeaseExpired(lease: ManagedBrowserLeaseState, nowMs = Date.now()): boolean {
  return lease.status === 'active' && lease.expiresAtMs <= nowMs;
}

function clampManagedBrowserLeaseTtl(value: number | null | undefined): number {
  if (!Number.isFinite(value || NaN)) {
    return MANAGED_BROWSER_DEFAULT_LEASE_TTL_MS;
  }
  return Math.min(
    MANAGED_BROWSER_MAX_LEASE_TTL_MS,
    Math.max(MANAGED_BROWSER_MIN_LEASE_TTL_MS, Math.floor(value as number)),
  );
}

export function resolveManagedBrowserProxyConfig(args: {
  input?: ManagedBrowserProxyInput | null;
  env?: NodeJS.ProcessEnv;
} = {}): ManagedBrowserProxyConfig {
  const env = args.env || process.env;
  const input = args.input;
  const source = input ? 'request' : env.CODE_AGENT_BROWSER_PROXY_SERVER ? 'env' : 'default';
  const rawMode = input?.mode;
  const rawServer = input ? input.server : env.CODE_AGENT_BROWSER_PROXY_SERVER;
  const bypass = normalizeProxyBypass(input ? input.bypass : env.CODE_AGENT_BROWSER_PROXY_BYPASS);
  const rawRegionHint = (input?.regionHint || env.CODE_AGENT_BROWSER_PROXY_REGION || '').trim();
  const regionHint = rawRegionHint ? sanitizeManagedBrowserId(rawRegionHint) : null;

  if (rawMode === 'direct' || rawMode === 'none' || rawMode === 'off') {
    return {
      mode: 'direct',
      server: null,
      bypass,
      regionHint,
      source,
    };
  }

  const server = normalizeProxyServer(rawServer);
  if (!server) {
    return {
      mode: 'direct',
      server: null,
      bypass,
      regionHint,
      source,
    };
  }

  return {
    mode: normalizeProxyMode(rawMode, server),
    server,
    bypass,
    regionHint,
    source,
  };
}

export function resolveManagedBrowserProfile(args: {
  userDataDir: string;
  profileMode?: ManagedBrowserProfileMode;
  workspaceScope?: string | null;
  sessionId?: string | null;
  tmpDir?: string;
  makeTempDir?: (prefix: string) => string;
}): ManagedBrowserProfileResolution {
  const profileMode = args.profileMode || 'persistent';
  const workspaceScope = sanitizeManagedBrowserId(args.workspaceScope || 'workspace');
  const sessionId = args.sessionId || createManagedBrowserSessionId();

  if (profileMode === 'persistent') {
    const profileId = MANAGED_BROWSER_PERSISTENT_PROFILE_ID;
    return {
      sessionId,
      profileId,
      profileMode,
      profileDir: path.join(args.userDataDir, profileId),
      workspaceScope,
      artifactDir: MANAGED_BROWSER_ARTIFACT_DIR,
      temporary: false,
      isolatedRootDir: null,
    };
  }

  if (profileMode !== 'isolated') {
    throw new Error(`Unsupported managed browser profileMode: ${profileMode}`);
  }

  const profileId = sanitizeManagedBrowserId(`isolated-${sessionId}`);
  const isolatedRootDir = path.join(args.tmpDir || os.tmpdir(), MANAGED_BROWSER_ISOLATED_PROFILE_PREFIX);
  fs.mkdirSync(isolatedRootDir, { recursive: true });
  const makeTempDir = args.makeTempDir || fs.mkdtempSync;
  const profileDir = makeTempDir(path.join(isolatedRootDir, `${profileId}-`));

  return {
    sessionId,
    profileId,
    profileMode,
    profileDir,
    workspaceScope,
    artifactDir: MANAGED_BROWSER_ARTIFACT_DIR,
    temporary: true,
    isolatedRootDir,
  };
}

export function shouldCleanupManagedBrowserProfile(profile: Pick<ManagedBrowserProfileResolution, 'profileMode' | 'profileDir' | 'temporary' | 'isolatedRootDir'>): boolean {
  return profile.profileMode === 'isolated'
    && profile.temporary
    && Boolean(profile.isolatedRootDir)
    && isPathInsideRoot(profile.profileDir, profile.isolatedRootDir || '');
}

function normalizeProxyBypass(value: string[] | string | null | undefined): string[] {
  const items = Array.isArray(value)
    ? value
    : String(value || '').split(/[;,]/g);
  return Array.from(new Set(items
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => item.replace(/\s+/g, ''))));
}

function normalizeProxyServer(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  const withProtocol = /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(trimmed)
    ? trimmed
    : `http://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(withProtocol);
  } catch {
    throw new Error('Invalid managed browser proxy server.');
  }
  if (parsed.username || parsed.password) {
    throw new Error('Managed browser proxy credentials are not accepted in proxy URLs.');
  }
  if (!['http:', 'https:', 'socks:', 'socks4:', 'socks5:'].includes(parsed.protocol)) {
    throw new Error(`Unsupported managed browser proxy protocol: ${parsed.protocol}`);
  }
  parsed.pathname = '';
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString().replace(/\/$/g, '');
}

function normalizeProxyMode(value: ManagedBrowserProxyInput['mode'], server: string): ManagedBrowserProxyMode {
  if (value === 'http' || value === 'socks') {
    return value;
  }
  return server.startsWith('socks') ? 'socks' : 'http';
}

function getManagedBrowserProxyFingerprint(proxy: ManagedBrowserProxyConfig): string {
  return JSON.stringify({
    mode: proxy.mode,
    server: proxy.server || null,
    bypass: proxy.bypass,
    regionHint: proxy.regionHint || null,
  });
}

function parseBrowserTargetRefInput(value: unknown): { refId: string | null; snapshotId: string | null } {
  if (typeof value === 'string') {
    return { refId: value.trim() || null, snapshotId: null };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { refId: null, snapshotId: null };
  }
  const record = value as Record<string, unknown>;
  return {
    refId: typeof record.refId === 'string' ? record.refId.trim() || null : null,
    snapshotId: typeof record.snapshotId === 'string' ? record.snapshotId.trim() || null : null,
  };
}

function readBrowserStorageState(filePath: string): BrowserStorageStateLike {
  const content = fs.readFileSync(filePath, 'utf8');
  const parsed = JSON.parse(content) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('storageState file must contain a JSON object');
  }
  const record = parsed as BrowserStorageStateLike;
  if (record.cookies !== undefined && !Array.isArray(record.cookies)) {
    throw new Error('storageState.cookies must be an array');
  }
  if (record.origins !== undefined && !Array.isArray(record.origins)) {
    throw new Error('storageState.origins must be an array');
  }
  return record;
}

function normalizeStorageStateCookies(value: unknown): Array<{
  name: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: string | null;
}> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item): item is BrowserStorageStateCookie => !!item && typeof item === 'object' && !Array.isArray(item))
    .map((cookie) => ({
      name: typeof cookie.name === 'string' ? cookie.name : '',
      domain: typeof cookie.domain === 'string' ? cookie.domain : '',
      path: typeof cookie.path === 'string' ? cookie.path : '/',
      expires: typeof cookie.expires === 'number' && Number.isFinite(cookie.expires) ? cookie.expires : -1,
      httpOnly: cookie.httpOnly === true,
      secure: cookie.secure === true,
      sameSite: typeof cookie.sameSite === 'string' ? cookie.sameSite : null,
    }))
    .filter((cookie) => cookie.name && cookie.domain);
}

function normalizeStorageStateOrigins(value: unknown): Array<{
  origin: string;
  localStorage: Array<{ name: string; value: string }>;
  sessionStorage: Array<{ name: string; value: string }>;
}> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item): item is BrowserStorageStateOrigin => !!item && typeof item === 'object' && !Array.isArray(item))
    .map((origin) => ({
      origin: typeof origin.origin === 'string' ? origin.origin : '',
      localStorage: normalizeStorageEntries(origin.localStorage),
      sessionStorage: normalizeStorageEntries(origin.sessionStorage),
    }))
    .filter((origin) => origin.origin);
}

function normalizeStorageEntries(value: unknown): Array<{ name: string; value: string }> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item): item is { name?: unknown; value?: unknown } => !!item && typeof item === 'object' && !Array.isArray(item))
    .map((item) => ({
      name: typeof item.name === 'string' ? item.name : '',
      value: typeof item.value === 'string' ? item.value : '',
    }))
    .filter((item) => item.name);
}

function createBrowserArtifactSummary(args: {
  kind: 'download' | 'upload';
  artifactPath: string;
  mimeType: string | null;
  sessionId: string | null;
}): BrowserArtifactSummary {
  const stat = fs.statSync(args.artifactPath);
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(args.artifactPath));
  const sha256 = hash.digest('hex');
  const name = path.basename(args.artifactPath);
  return {
    artifactId: `${args.kind}_${Date.now()}_${sha256.slice(0, 12)}`,
    kind: args.kind,
    name,
    artifactPath: args.artifactPath,
    size: stat.size,
    mimeType: args.mimeType,
    sha256,
    createdAtMs: Date.now(),
    sessionId: args.sessionId,
  };
}

function sanitizeArtifactFilename(value: string): string {
  const basename = path.basename(value).trim();
  const safe = basename
    .replace(/[^\w.+=@-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 160);
  return safe || `artifact_${Date.now()}`;
}

function inferMimeType(filePath: string): string | null {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.txt':
      return 'text/plain';
    case '.html':
    case '.htm':
      return 'text/html';
    case '.json':
      return 'application/json';
    case '.csv':
      return 'text/csv';
    case '.pdf':
      return 'application/pdf';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.webp':
      return 'image/webp';
    default:
      return null;
  }
}

function sanitizeManagedBrowserId(value: string): string {
  const safe = value
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96);
  return safe || 'workspace';
}

function isPathInsideRoot(targetPath: string, rootPath: string): boolean {
  const target = path.resolve(targetPath);
  const root = path.resolve(rootPath);
  return target !== root && target.startsWith(`${root}${path.sep}`);
}

export function redactBrowserWorkbenchTraceParams(toolName: string, params: Record<string, unknown>): Record<string, unknown> {
  const inputSafeParams = redactBrowserComputerInputArgs(toolName, params);
  if (inputSafeParams) {
    return inputSafeParams;
  }

  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (/password|token|secret|credential|cookie/i.test(key)) {
      redacted[key] = '[redacted]';
    } else if (/profile(dir|path)|userDataDir|artifact(dir|path)|download(dir|path)|uploadFilePath|workspace(scope|path|root|dir|directory)|storageState/i.test(key)) {
      redacted[key] = summarizeLocalPathForTrace(value);
    } else if (typeof value === 'string') {
      const sanitized = redactBrowserComputerInputPayloadsInValue(toolName, params, value);
      redacted[key] = typeof sanitized === 'string' && sanitized.length > 500
        ? `${sanitized.slice(0, 500)}...`
        : sanitized;
    } else {
      redacted[key] = redactBrowserComputerInputPayloadsInValue(toolName, params, value);
    }
  }
  return redacted;
}

function summarizeLocalPathForTrace(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return value;
  }
  return path.basename(trimmed) || '[path]';
}

// Singleton instance
const browserServiceInstance = new BrowserService();
getServiceRegistry().register('BrowserService', browserServiceInstance);
export const browserService = browserServiceInstance;
