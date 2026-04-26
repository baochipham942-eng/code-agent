// ============================================================================
// BrowserService - Browser automation using Playwright
// Provides programmatic browser control for all agents
// Logs are transparent and returned to the agent for visibility
// ============================================================================

import type { Browser, Page, BrowserContext } from 'playwright';
import * as path from 'path';
import * as fs from 'fs';
import { spawn, type ChildProcess } from 'child_process';
import { app } from '../../platform';
import { logCollector } from '../../mcp/logCollector.js';
import { createLogger } from './logger';
import type { Disposable } from '../serviceRegistry';
import { getServiceRegistry } from '../serviceRegistry';
import type {
  ManagedBrowserMode,
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

export interface BrowserDomSnapshot {
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
    rect: { x: number; y: number; width: number; height: number };
  }>;
}

export interface ManagedBrowserLaunchOptions {
  mode?: ManagedBrowserMode;
  provider?: ManagedBrowserProviderPreference;
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

class BrowserService implements Disposable {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private browserProcess: ChildProcess | null = null;
  private tabs: Map<string, BrowserTab> = new Map();
  private activeTabId: string | null = null;
  private disposed = false;
  private screenshotDir: string;
  private profileDir: string;
  private mode: ManagedBrowserMode;
  private viewport = { width: 1280, height: 720 };
  private traces: WorkbenchActionTrace[] = [];
  private consoleErrors: string[] = [];
  private networkFailures: string[] = [];
  private allowedHosts: string[];
  private blockedHosts: string[];
  private providerDiagnostics: BrowserProviderDiagnostics;
  public logger: BrowserLogger = new BrowserLogger();

  constructor() {
    const userData = app?.getPath('userData') || process.cwd();
    this.screenshotDir = path.join(userData, 'screenshots');
    this.profileDir = path.join(userData, 'managed-browser-profile');
    this.mode = this.getDefaultMode();
    this.allowedHosts = parseHostList(process.env.CODE_AGENT_BROWSER_ALLOWED_HOSTS);
    this.blockedHosts = parseHostList(process.env.CODE_AGENT_BROWSER_BLOCKED_HOSTS);
    this.providerDiagnostics = this.createInitialProviderDiagnostics();
    if (!fs.existsSync(this.screenshotDir)) {
      fs.mkdirSync(this.screenshotDir, { recursive: true });
    }
    if (!fs.existsSync(this.profileDir)) {
      fs.mkdirSync(this.profileDir, { recursive: true });
    }
    this.logger.log('INFO', 'BrowserService initialized');
  }

  // --------------------------------------------------------------------------
  // Browser Lifecycle
  // --------------------------------------------------------------------------

  async launch(options: ManagedBrowserLaunchOptions = {}): Promise<void> {
    if (this.browser) {
      this.logger.log('WARN', 'Browser already running, skipping launch');
      return;
    }

    this.mode = options.mode || this.getDefaultMode();
    const resolution = resolveBrowserProvider({ requestedProvider: options.provider });
    this.updateProviderDiagnostics(resolution, {
      executable: resolution.systemExecutable,
      cdpPort: null,
    });

    this.logger.log('INFO', `Launching managed browser via ${resolution.provider} (${this.mode})...`);
    if (resolution.provider === 'system-chrome-cdp') {
      try {
        await this.launchSystemChromeCdp(resolution);
      } catch (error) {
        await this.cleanupFailedSystemChromeLaunch();
        if (resolution.requestedProvider !== 'auto') {
          throw error;
        }
        const fallbackReason = error instanceof Error ? error.message : String(error);
        this.logger.log('WARN', `System Chrome CDP launch failed; falling back to Playwright bundled Chromium: ${fallbackReason}`);
        await this.launchPlaywrightBundled(resolution, `System Chrome CDP launch failed: ${fallbackReason}`);
      }
    } else {
      await this.launchPlaywrightBundled(resolution, resolution.providerFallbackReason);
    }

    await this.installContextGuards();
    this.logger.log(
      'INFO',
      `Browser launched successfully via ${this.providerDiagnostics.provider} (viewport: ${this.viewport.width}x${this.viewport.height})`,
    );
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
      this.activeTabId = null;
      this.logger.log('INFO', 'Browser closed, all tabs cleared');
    } else {
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

    this.logger.log('INFO', `Creating new tab${url ? ` with URL: ${url}` : ''}`);
    const page = await this.context!.newPage();
    await page.setViewportSize(this.viewport).catch(() => undefined);
    const tabId = `tab_${Date.now()}`;

    if (url) {
      this.logger.log('DEBUG', `Navigating to: ${url}`);
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
      this.logger.log('DEBUG', `Page loaded: ${tab.url} - "${tab.title}"`);
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
      const entry = `[${tabId}] ${request.url()} ${request.failure()?.errorText || 'request failed'}`;
      this.networkFailures.push(entry);
      this.networkFailures = this.networkFailures.slice(-50);
      this.logger.log('WARN', `[Page Request Failed] ${entry}`);
    });

    page.on('response', (response) => {
      if (response.status() >= 400) {
        const entry = `[${tabId}] ${response.status()} ${response.url()}`;
        this.networkFailures.push(entry);
        this.networkFailures = this.networkFailures.slice(-50);
        this.logger.log('WARN', `[Page Response] ${entry}`);
      }
    });

    this.logger.log('INFO', `Tab created: ${tabId} - "${tab.title}" (${tab.url})`);
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
    this.logger.log('INFO', `Navigating to: ${url}`);
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

  async clickAtPosition(x: number, y: number, tabId?: string): Promise<void> {
    const tab = this.getTab(tabId);
    await tab.page.mouse.click(x, y);
  }

  async type(selector: string, text: string, tabId?: string): Promise<void> {
    const tab = this.getTab(tabId);
    await tab.page.fill(selector, text);
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
    const [headings, interactiveElements] = await Promise.all([
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
          const selectorHint = id
            ? `#${id}`
            : className
              ? `${tag}.${className.split(/\s+/).filter(Boolean)[0]}`
              : tag;
          return {
            tag,
            role: el.getAttribute('role'),
            text: el.textContent?.trim().slice(0, 160) || '',
            ariaLabel: el.getAttribute('aria-label'),
            placeholder: el.getAttribute('placeholder'),
            selectorHint,
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

    return {
      url: page.url(),
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

  // --------------------------------------------------------------------------
  // JavaScript Execution (for page scripting)
  // --------------------------------------------------------------------------

  async runScript<T>(script: string, tabId?: string): Promise<T> {
    const tab = this.getTab(tabId);
    // Playwright's evaluate runs script in page context
    return await tab.page.evaluate(script) as T;
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
      acceptDownloads: false,
      ignoreHTTPSErrors: false,
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
      acceptDownloads: false,
      ignoreHTTPSErrors: false,
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
        this.logger.log('WARN', `Blocked browser request: ${url}`);
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

  private async cleanupFailedSystemChromeLaunch(): Promise<void> {
    await this.context?.close().catch(() => undefined);
    await this.browser?.close().catch(() => undefined);
    this.context = null;
    this.browser = null;
    await this.stopSystemChromeProcess();
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
    if (!this.browser) {
      await this.launch(options);
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

export function redactBrowserWorkbenchTraceParams(toolName: string, params: Record<string, unknown>): Record<string, unknown> {
  const inputSafeParams = redactBrowserComputerInputArgs(toolName, params);
  if (inputSafeParams) {
    return inputSafeParams;
  }

  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (/password|token|secret|credential|cookie/i.test(key)) {
      redacted[key] = '[redacted]';
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

// Singleton instance
const browserServiceInstance = new BrowserService();
getServiceRegistry().register('BrowserService', browserServiceInstance);
export const browserService = browserServiceInstance;
