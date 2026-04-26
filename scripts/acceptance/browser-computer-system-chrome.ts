import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import net from 'net';
import { chromium, type Browser } from 'playwright';

export const SYSTEM_CHROME_CDP_PROVIDER = 'system-chrome-cdp';

export interface SystemChromeSession {
  browser: Browser;
  chrome: ChildProcessWithoutNullStreams;
  executable: string;
  port: number;
  profileDir: string;
  provider: typeof SYSTEM_CHROME_CDP_PROVIDER;
}

export class SystemChromeUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SystemChromeUnavailableError';
  }
}

export function getSystemChromeExecutable(): string {
  if (process.env.CODE_AGENT_SYSTEM_CHROME_PATH) {
    return process.env.CODE_AGENT_SYSTEM_CHROME_PATH;
  }
  if (process.env.CHROME_PATH) {
    return process.env.CHROME_PATH;
  }

  if (process.platform === 'darwin') {
    return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  }
  if (process.platform === 'win32') {
    return 'chrome.exe';
  }
  return process.env.GOOGLE_CHROME_BIN || 'google-chrome';
}

export function ensureSystemChromeAvailable(executable = getSystemChromeExecutable()): void {
  if (executable.includes('/') && !existsSync(executable)) {
    throw new SystemChromeUnavailableError(
      `System Chrome is not available at ${executable}. Set CODE_AGENT_SYSTEM_CHROME_PATH or CHROME_PATH to a Chrome executable.`,
    );
  }
}

export function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : null;
      server.close(() => {
        if (port) {
          resolve(port);
        } else {
          reject(new Error('Failed to allocate a free port'));
        }
      });
    });
  });
}

export function buildSystemChromeArgs(options: {
  port: number;
  profileDir: string;
  visible?: boolean;
  initialUrl?: string;
}): string[] {
  return [
    ...(options.visible ? [] : ['--headless=new']),
    '--disable-gpu',
    '--disable-background-networking',
    '--disable-sync',
    '--disable-extensions',
    '--disable-component-update',
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=${options.profileDir}`,
    '--remote-debugging-address=127.0.0.1',
    `--remote-debugging-port=${options.port}`,
    options.initialUrl || 'about:blank',
  ];
}

export function startSystemChrome(options: {
  port: number;
  profileDir: string;
  visible?: boolean;
  initialUrl?: string;
  executable?: string;
}): ChildProcessWithoutNullStreams {
  const executable = options.executable || getSystemChromeExecutable();
  ensureSystemChromeAvailable(executable);

  const chrome = spawn(executable, buildSystemChromeArgs({
    port: options.port,
    profileDir: options.profileDir,
    visible: options.visible,
    initialUrl: options.initialUrl,
  }), {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  chrome.once('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') {
      chrome.emit('system-chrome-unavailable', new SystemChromeUnavailableError(
        `System Chrome executable could not be started: ${executable}. Set CODE_AGENT_SYSTEM_CHROME_PATH or CHROME_PATH.`,
      ));
    }
  });

  return chrome;
}

export async function connectToSystemChrome(
  port: number,
  chrome: ChildProcessWithoutNullStreams,
  output: () => string,
  timeoutMs = 10_000,
): Promise<Browser> {
  const start = Date.now();
  let lastError: unknown;

  while (Date.now() - start < timeoutMs) {
    if (chrome.exitCode !== null) {
      throw new SystemChromeUnavailableError(
        `System Chrome exited before CDP became available. exitCode=${chrome.exitCode}\n${output()}`,
      );
    }

    try {
      return await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }

  const message = lastError instanceof Error ? lastError.message : String(lastError || 'unknown error');
  throw new SystemChromeUnavailableError(
    `Timed out connecting to system Chrome over CDP at 127.0.0.1:${port}.\n${message}\n${output()}`,
  );
}

export async function launchSystemChromeSession(options: {
  profilePrefix: string;
  visible?: boolean;
  initialUrl?: string;
  timeoutMs?: number;
}): Promise<SystemChromeSession> {
  const port = await getFreePort();
  const profileDir = mkdtempSync(join(tmpdir(), options.profilePrefix));
  const executable = getSystemChromeExecutable();
  let logs = '';
  const append = (chunk: Buffer) => {
    logs += chunk.toString();
    if (logs.length > 20_000) {
      logs = logs.slice(-20_000);
    }
  };
  const chrome = startSystemChrome({
    port,
    profileDir,
    visible: options.visible,
    initialUrl: options.initialUrl,
    executable,
  });
  chrome.stdout.on('data', append);
  chrome.stderr.on('data', append);

  try {
    const browser = await connectToSystemChrome(port, chrome, () => logs, options.timeoutMs);
    return {
      browser,
      chrome,
      executable,
      port,
      profileDir,
      provider: SYSTEM_CHROME_CDP_PROVIDER,
    };
  } catch (error) {
    await closeSystemChromeSession({ chrome, profileDir }).catch(() => undefined);
    throw error;
  }
}

export async function closeSystemChromeSession(
  session: Pick<SystemChromeSession, 'chrome' | 'profileDir'>,
): Promise<void> {
  if (!session.chrome.killed && session.chrome.exitCode === null) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (session.chrome.exitCode === null) {
          session.chrome.kill('SIGKILL');
        }
        resolve();
      }, 2_000);

      session.chrome.once('close', () => {
        clearTimeout(timer);
        resolve();
      });

      session.chrome.kill('SIGTERM');
    });
  }

  rmSync(session.profileDir, { recursive: true, force: true });
}

export function makeSystemChromeProviderOptions(mode: 'headless' | 'visible'): Record<string, unknown> {
  return {
    mode,
    provider: SYSTEM_CHROME_CDP_PROVIDER,
    executablePath: getSystemChromeExecutable(),
  };
}

export function classifyAcceptanceError(error: unknown): {
  kind: 'missing_playwright_executable' | 'system_chrome_unavailable' | 'other';
  message: string;
} {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();

  if (
    error instanceof SystemChromeUnavailableError
    || lower.includes('system chrome')
    || lower.includes('code_agent_system_chrome_path')
  ) {
    return { kind: 'system_chrome_unavailable', message };
  }

  if (
    lower.includes('executable doesn') && lower.includes('playwright')
    || lower.includes('looks like playwright was just installed')
    || lower.includes('npx playwright install')
    || lower.includes('browserType.launchPersistentContext')
  ) {
    return { kind: 'missing_playwright_executable', message };
  }

  return { kind: 'other', message };
}

export function formatAcceptanceError(error: unknown): string {
  const classified = classifyAcceptanceError(error);
  if (classified.kind === 'missing_playwright_executable') {
    return [
      'missing_playwright_executable: BrowserService tried to launch Playwright-managed Chromium, but its browser executable is missing.',
      'Use provider=system-chrome-cdp for the acceptance path, or install the Playwright browser with `npx playwright install chromium`.',
      classified.message,
    ].join('\n');
  }
  if (classified.kind === 'system_chrome_unavailable') {
    return [
      'system_chrome_unavailable: system Chrome could not be started or did not expose CDP.',
      'Install Google Chrome or set CODE_AGENT_SYSTEM_CHROME_PATH / CHROME_PATH.',
      classified.message,
    ].join('\n');
  }
  return classified.message;
}
