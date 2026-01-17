// ============================================================================
// BrowserService - Browser automation using Playwright
// Provides programmatic browser control for all agents
// Logs are transparent and returned to the agent for visibility
// ============================================================================

import { chromium, Browser, Page, BrowserContext } from 'playwright';
import * as path from 'path';
import * as fs from 'fs';
import { app } from 'electron';
import { logCollector } from '../mcp/LogCollector.js';

// Log collector for transparent operation logging
export class BrowserLogger {
  private logs: string[] = [];
  private maxLogs: number = 100;

  log(level: 'INFO' | 'WARN' | 'ERROR' | 'DEBUG', message: string): void {
    const timestamp = new Date().toISOString().split('T')[1].split('.')[0];
    const entry = `[${timestamp}] [${level}] ${message}`;
    this.logs.push(entry);
    console.log(`[BrowserService] ${entry}`);

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

class BrowserService {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private tabs: Map<string, BrowserTab> = new Map();
  private activeTabId: string | null = null;
  private screenshotDir: string;
  public logger: BrowserLogger = new BrowserLogger();

  constructor() {
    this.screenshotDir = path.join(
      app?.getPath('userData') || process.cwd(),
      'screenshots'
    );
    if (!fs.existsSync(this.screenshotDir)) {
      fs.mkdirSync(this.screenshotDir, { recursive: true });
    }
    this.logger.log('INFO', 'BrowserService initialized');
  }

  // --------------------------------------------------------------------------
  // Browser Lifecycle
  // --------------------------------------------------------------------------

  async launch(): Promise<void> {
    if (this.browser) {
      this.logger.log('WARN', 'Browser already running, skipping launch');
      return;
    }

    this.logger.log('INFO', 'Launching Chromium browser...');
    this.browser = await chromium.launch({
      headless: false, // Show browser window for visual feedback
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
      ],
    });

    this.context = await this.browser.newContext({
      viewport: { width: 1280, height: 720 },
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    });

    this.logger.log('INFO', 'Browser launched successfully (viewport: 1280x720)');
  }

  async close(): Promise<void> {
    if (this.browser) {
      this.logger.log('INFO', 'Closing browser...');
      await this.browser.close();
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
    return this.browser !== null;
  }

  // --------------------------------------------------------------------------
  // Tab Management
  // --------------------------------------------------------------------------

  async newTab(url?: string): Promise<string> {
    await this.ensureBrowser();

    this.logger.log('INFO', `Creating new tab${url ? ` with URL: ${url}` : ''}`);
    const page = await this.context!.newPage();
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
        this.logger.log('ERROR', `[Page Console] ${msg.text()}`);
      } else if (msg.type() === 'warn') {
        this.logger.log('WARN', `[Page Console] ${msg.text()}`);
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
        this.activeTabId = this.tabs.size > 0 ? this.tabs.keys().next().value : null;
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

  // --------------------------------------------------------------------------
  // Navigation
  // --------------------------------------------------------------------------

  async navigate(url: string, tabId?: string): Promise<void> {
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
          href: a.href,
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

  // --------------------------------------------------------------------------
  // Private Helpers
  // --------------------------------------------------------------------------

  private async ensureBrowser(): Promise<void> {
    if (!this.browser) {
      await this.launch();
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
}

// Singleton instance
export const browserService = new BrowserService();
