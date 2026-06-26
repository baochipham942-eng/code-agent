import type { Browser, BrowserContext } from 'playwright';
import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import {
  buildSystemChromeCdpArgs,
  findAvailablePort,
  resolveCdpEndpointUrl,
  type BrowserProviderResolution,
} from '../browserProvider';
import { loadPlaywright } from '../../../runtime/playwrightRuntime';
import type {
  ManagedBrowserMode,
  ManagedBrowserProxyConfig,
} from '../../../../shared/contract/desktop';
import {
  buildBrowserEnvironment,
  getDefaultUserAgent,
} from './managedBrowserHelpers';

type BrowserLaunchLogger = {
  log(level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR', message: string): void;
};

interface BrowserLaunchBaseInput {
  mode: ManagedBrowserMode;
  viewport: { width: number; height: number };
  proxy: ManagedBrowserProxyConfig;
  logger: BrowserLaunchLogger;
}

export interface SystemChromeCdpLaunchInput extends BrowserLaunchBaseInput {
  resolution: BrowserProviderResolution;
  profileDir: string;
  onProcessStart(process: ChildProcess): void;
  onProcessExit(process: ChildProcess, code: number | null, signal: NodeJS.Signals | null): void;
}

export interface PlaywrightBundledLaunchInput extends BrowserLaunchBaseInput {
  resolution: BrowserProviderResolution;
  profileDir: string;
  downloadDir: string;
  fallbackReason?: string | null;
}

let playwrightModule: typeof import('playwright') | null = null;

async function getPlaywright() {
  if (!playwrightModule) {
    const loaded = await loadPlaywright();
    if (!loaded.ok || !loaded.module) {
      throw new Error(loaded.error || 'Playwright package is unavailable in this runtime.');
    }
    playwrightModule = loaded.module;
  }
  return playwrightModule;
}

async function waitForCdpEndpoint(port: number, chromeProcess: ChildProcess): Promise<void> {
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

export function getPlaywrightProxyOptions(
  proxyConfig: ManagedBrowserProxyConfig,
): { server: string; bypass?: string } | undefined {
  if (!proxyConfig.server || proxyConfig.mode === 'direct') {
    return undefined;
  }
  return {
    server: proxyConfig.server,
    bypass: proxyConfig.bypass.length > 0 ? proxyConfig.bypass.join(',') : undefined,
  };
}

export async function launchSystemChromeCdpBrowser(
  input: SystemChromeCdpLaunchInput,
): Promise<{ browser: Browser; context: BrowserContext; executable: string; cdpPort: number }> {
  const executable = input.resolution.systemExecutable;
  if (input.resolution.missingExecutable || !executable) {
    throw new Error(input.resolution.recommendedAction || 'System Chrome executable is missing');
  }

  const cdpPort = await findAvailablePort();
  const chromeProcess = spawn(executable, buildSystemChromeCdpArgs({
    cdpPort,
    profileDir: input.profileDir,
    headless: input.mode === 'headless',
    viewport: input.viewport,
    proxy: input.proxy,
  }), {
    env: buildBrowserEnvironment(),
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  input.onProcessStart(chromeProcess);
  chromeProcess.stderr?.on('data', (chunk) => {
    const message = String(chunk).trim();
    if (message) {
      input.logger.log('DEBUG', `[System Chrome] ${message.slice(0, 500)}`);
    }
  });
  chromeProcess.once('exit', (code, signal) => {
    input.onProcessExit(chromeProcess, code, signal);
  });

  await Promise.race([
    waitForCdpEndpoint(cdpPort, chromeProcess),
    new Promise<never>((_, reject) => {
      chromeProcess.once('error', reject);
    }),
  ]);

  const pw = await getPlaywright();
  const browser = await pw.chromium.connectOverCDP(await resolveCdpEndpointUrl(cdpPort));
  const context = browser.contexts()[0] || await browser.newContext({
    viewport: input.viewport,
    acceptDownloads: true,
    ignoreHTTPSErrors: false,
    proxy: getPlaywrightProxyOptions(input.proxy),
    userAgent: getDefaultUserAgent(),
  });
  return { browser, context, executable, cdpPort };
}

export async function launchPlaywrightBundledBrowser(
  input: PlaywrightBundledLaunchInput,
): Promise<{
  browser: Browser | null;
  context: BrowserContext;
  executable: string | null;
  missingExecutable: boolean;
  recommendedAction?: string | null;
}> {
  const pw = await getPlaywright();
  const executable = typeof pw.chromium.executablePath === 'function'
    ? pw.chromium.executablePath()
    : null;
  const missingExecutable = !executable || !fs.existsSync(executable);
  const context = await pw.chromium.launchPersistentContext(input.profileDir, {
    headless: input.mode === 'headless',
    viewport: input.viewport,
    acceptDownloads: true,
    downloadsPath: input.downloadDir,
    ignoreHTTPSErrors: false,
    proxy: getPlaywrightProxyOptions(input.proxy),
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
  return {
    browser: context.browser(),
    context,
    executable,
    missingExecutable,
    recommendedAction: missingExecutable
      ? 'Run npx playwright install chromium to enable the bundled fallback, or use CODE_AGENT_BROWSER_PROVIDER=system-chrome-cdp with a valid Chrome executable.'
      : input.resolution.recommendedAction,
  };
}
