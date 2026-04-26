import * as fs from 'fs';
import * as net from 'net';
import type {
  ManagedBrowserProvider,
  ManagedBrowserProviderPreference,
} from '../../../shared/contract/desktop';

const MACOS_CHROME_EXECUTABLE = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

export interface BrowserProviderResolution {
  requestedProvider: ManagedBrowserProviderPreference;
  provider: ManagedBrowserProvider;
  systemExecutable: string | null;
  missingExecutable: boolean;
  recommendedAction: string | null;
  providerFallbackReason: string | null;
}

export function resolveBrowserProvider(args: {
  requestedProvider?: ManagedBrowserProviderPreference | string | null;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  existsSync?: (path: string) => boolean;
} = {}): BrowserProviderResolution {
  const env = args.env || process.env;
  const platform = args.platform || process.platform;
  const existsSync = args.existsSync || fs.existsSync;
  const requestedProvider = normalizeBrowserProviderPreference(
    args.requestedProvider || env.CODE_AGENT_BROWSER_PROVIDER || 'auto',
  );
  const systemExecutable = getSystemChromeExecutable(env, platform);
  const missingExecutable = !systemExecutable || !existsSync(systemExecutable);
  const recommendedAction = missingExecutable
    ? buildMissingChromeRecommendedAction(systemExecutable)
    : null;

  if (requestedProvider === 'playwright-bundled') {
    return {
      requestedProvider,
      provider: 'playwright-bundled',
      systemExecutable,
      missingExecutable,
      recommendedAction,
      providerFallbackReason: null,
    };
  }

  if (requestedProvider === 'system-chrome-cdp') {
    return {
      requestedProvider,
      provider: 'system-chrome-cdp',
      systemExecutable,
      missingExecutable,
      recommendedAction,
      providerFallbackReason: null,
    };
  }

  if (missingExecutable) {
    return {
      requestedProvider,
      provider: 'playwright-bundled',
      systemExecutable,
      missingExecutable,
      recommendedAction,
      providerFallbackReason: 'System Chrome executable not found; falling back to Playwright bundled Chromium.',
    };
  }

  return {
    requestedProvider,
    provider: 'system-chrome-cdp',
    systemExecutable,
    missingExecutable: false,
    recommendedAction: null,
    providerFallbackReason: null,
  };
}

export function normalizeBrowserProviderPreference(value: string): ManagedBrowserProviderPreference {
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized === 'auto') {
    return 'auto';
  }
  if (['system', 'chrome', 'chrome-cdp', 'system-chrome', 'system-chrome-cdp'].includes(normalized)) {
    return 'system-chrome-cdp';
  }
  if (['playwright', 'bundled', 'playwright-bundled'].includes(normalized)) {
    return 'playwright-bundled';
  }
  throw new Error(`Unsupported managed browser provider: ${value}`);
}

export function getSystemChromeExecutable(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const chromePath = env.CHROME_PATH?.trim() || env.CODE_AGENT_SYSTEM_CHROME_PATH?.trim();
  if (chromePath) {
    return chromePath;
  }
  if (platform === 'darwin') {
    return MACOS_CHROME_EXECUTABLE;
  }
  if (platform === 'win32') {
    return 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  }
  return '/usr/bin/google-chrome';
}

export function buildSystemChromeCdpArgs(args: {
  cdpPort: number;
  profileDir: string;
  headless: boolean;
  viewport: { width: number; height: number };
}): string[] {
  const chromeArgs = [
    `--remote-debugging-port=${args.cdpPort}`,
    '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${args.profileDir}`,
    `--window-size=${args.viewport.width},${args.viewport.height}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-dev-shm-usage',
    '--disable-extensions',
    '--disable-setuid-sandbox',
    '--no-sandbox',
  ];
  if (args.headless) {
    chromeArgs.push('--headless=new', '--hide-scrollbars', '--mute-audio');
  }
  return chromeArgs;
}

export async function findAvailablePort(host = '127.0.0.1'): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, host, () => {
      const address = server.address();
      server.close(() => {
        if (typeof address === 'object' && address?.port) {
          resolve(address.port);
        } else {
          reject(new Error('Failed to allocate a CDP port'));
        }
      });
    });
  });
}

function buildMissingChromeRecommendedAction(executable: string | null): string {
  const installTarget = executable || MACOS_CHROME_EXECUTABLE;
  return `Install Google Chrome at ${installTarget} or set CHROME_PATH to the Chrome executable; set CODE_AGENT_BROWSER_PROVIDER=playwright-bundled to force the bundled fallback.`;
}
