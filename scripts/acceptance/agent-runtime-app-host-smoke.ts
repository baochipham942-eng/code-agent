import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { existsSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { chromium, type Browser, type Page } from 'playwright';
import {
  finishWithError,
  getNumberOption,
  hasFlag,
  parseArgs,
  printJson,
  printKeyValue,
} from './_helpers.ts';
import {
  closeSystemChromeSession,
  formatAcceptanceError,
  getFreePort,
  getSystemChromeExecutable,
  startSystemChrome,
  SYSTEM_CHROME_CDP_PROVIDER,
} from './browser-computer-system-chrome.ts';

interface SmokeChromeSession {
  browser: Browser;
  chrome: ChildProcessWithoutNullStreams;
  executable: string;
  port: number;
  profileDir: string;
  provider: typeof SYSTEM_CHROME_CDP_PROVIDER;
}

function usage(): void {
  console.log(`Agent Runtime app-host smoke

Usage:
  npm run acceptance:agent-runtime-app-host -- [options]

Options:
  --skip-build    Reuse existing dist/web and dist/renderer artifacts.
  --keep-browser  Keep the Chrome process open after the smoke.
  --keep-server   Keep the app-host server process open after the smoke.
  --port <port>   App-host port. Default: auto.
  --json          Print JSON only.
  --help          Show this help.

What it validates:
  - dist/web webServer serves the real dist/renderer app
  - /api/health responds from the app-host server
  - system Chrome headless + CDP can open the real renderer
  - the local web auth gate returns an authenticated dev user
  - a controlled dev-only agent event hook accepts a minimal event

What it avoids:
  - no external model call
  - no swarm/eval full chain
  - no desktop write action`);
}

function npmCommand(): string {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function runCommand(command: string, args: string[], label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: 'inherit',
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${label} failed with exit code ${code ?? 1}`));
      }
    });
  });
}

async function ensureBuild(skipBuild: boolean): Promise<void> {
  if (skipBuild) {
    if (!existsSync('dist/web/webServer.cjs')) {
      throw new Error('dist/web/webServer.cjs is missing. Run without --skip-build first.');
    }
    if (!existsSync('dist/renderer/index.html')) {
      throw new Error('dist/renderer/index.html is missing. Run without --skip-build first.');
    }
    return;
  }

  await runCommand(npmCommand(), ['run', 'build:web'], 'build:web');
  await runCommand(npmCommand(), ['run', 'build:renderer'], 'build:renderer');
}

async function waitForHealth(
  baseUrl: string,
  server: ChildProcessWithoutNullStreams,
  output: () => string,
): Promise<{ ok: boolean; status: number; body: string }> {
  const start = Date.now();
  let lastStatus = 0;
  let lastBody = '';

  while (Date.now() - start < 30_000) {
    if (server.exitCode !== null) {
      throw new Error(`app-host exited early with code ${server.exitCode}\n${output()}`);
    }

    try {
      const response = await fetch(`${baseUrl}/api/health`);
      lastStatus = response.status;
      lastBody = await response.text();
      if (response.ok) {
        return { ok: true, status: response.status, body: lastBody };
      }
    } catch {
      // Keep polling until timeout.
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`Timed out waiting for app-host health at ${baseUrl}/api/health
Last status: ${lastStatus || 'N/A'}
Last body: ${lastBody || 'N/A'}
${output()}`);
}

function startAppHost(port: number): { child: ChildProcessWithoutNullStreams; output: () => string } {
  let logs = '';
  const child = spawn('node', ['dist/web/webServer.cjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      WEB_HOST: '127.0.0.1',
      WEB_PORT: String(port),
      CODE_AGENT_ENABLE_DEV_API: 'true',
      CODE_AGENT_E2E: '1',
      NODE_ENV: 'development',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const append = (chunk: Buffer) => {
    logs += chunk.toString();
    if (logs.length > 20_000) {
      logs = logs.slice(-20_000);
    }
  };
  child.stdout.on('data', append);
  child.stderr.on('data', append);

  return { child, output: () => logs };
}

async function stopProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.killed || child.exitCode !== null) return;

  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      if (child.exitCode === null) {
        child.kill('SIGKILL');
      }
      resolve();
    }, 2_000);

    child.once('close', () => {
      clearTimeout(timer);
      resolve();
    });

    child.kill('SIGTERM');
  });
}

async function launchSmokeChromeSession(options: { profilePrefix: string }): Promise<SmokeChromeSession> {
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
    executable,
  });
  chrome.stdout.on('data', append);
  chrome.stderr.on('data', append);

  try {
    const browser = await connectToSmokeChrome(port, chrome, () => logs);
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

async function connectToSmokeChrome(
  port: number,
  chrome: ChildProcessWithoutNullStreams,
  output: () => string,
  timeoutMs = 10_000,
): Promise<Browser> {
  const start = Date.now();
  let lastError: unknown;

  while (Date.now() - start < timeoutMs) {
    if (chrome.exitCode !== null) {
      throw new Error(`System Chrome exited before CDP became available. exitCode=${chrome.exitCode}\n${output()}`);
    }

    try {
      return await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    } catch (error) {
      lastError = error;
      const wsEndpoint = output().match(/DevTools listening on (ws:\/\/[^\s]+)/)?.[1];
      if (wsEndpoint) {
        try {
          return await chromium.connectOverCDP(wsEndpoint);
        } catch (wsError) {
          lastError = wsError;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }

  const message = lastError instanceof Error ? lastError.message : String(lastError || 'unknown error');
  throw new Error(`Timed out connecting to system Chrome over CDP at 127.0.0.1:${port}.
${message}
${output()}`);
}

async function waitForRenderer(page: Page, timeoutMs = 60_000): Promise<{ title: string; tokenPresent: boolean }> {
  await page.waitForFunction(
    () => typeof (window as unknown as { __CODE_AGENT_TOKEN__?: unknown }).__CODE_AGENT_TOKEN__ === 'string',
    undefined,
    { timeout: timeoutMs },
  );

  await Promise.race([
    page.locator('[data-chat-input]').waitFor({ state: 'visible', timeout: timeoutMs }),
    page.locator('body').waitFor({ state: 'visible', timeout: timeoutMs }),
  ]);

  return {
    title: await page.title().catch(() => ''),
    tokenPresent: await page.evaluate(() => {
      const token = (window as unknown as { __CODE_AGENT_TOKEN__?: unknown }).__CODE_AGENT_TOKEN__;
      return typeof token === 'string' && token.length > 0;
    }),
  };
}

async function fetchFromRenderer<T>(
  page: Page,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<{ ok: boolean; status: number; data: T | null; text: string }> {
  return page.evaluate(async ({ requestPath, requestInit }) => {
    const token = (window as unknown as { __CODE_AGENT_TOKEN__?: string }).__CODE_AGENT_TOKEN__;
    const response = await fetch(requestPath, {
      method: requestInit.method || 'GET',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: requestInit.body === undefined ? undefined : JSON.stringify(requestInit.body),
    });
    const text = await response.text();
    let data: unknown = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
    }
    return {
      ok: response.ok,
      status: response.status,
      data: data as T | null,
      text,
    };
  }, { requestPath: path, requestInit: init });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (hasFlag(args, 'help')) {
    usage();
    return;
  }

  await ensureBuild(hasFlag(args, 'skip-build'));

  const appPort = getNumberOption(args, 'port') || await getFreePort();
  const baseUrl = `http://127.0.0.1:${appPort}`;
  const appHost = startAppHost(appPort);
  let chromeSession: SmokeChromeSession | null = null;
  const failures: string[] = [];
  const consoleErrors: string[] = [];

  try {
    const health = await waitForHealth(baseUrl, appHost.child, appHost.output);
    chromeSession = await launchSmokeChromeSession({
      profilePrefix: 'code-agent-agent-runtime-app-host-',
    });
    const context = chromeSession.browser.contexts()[0] || await chromeSession.browser.newContext();
    const page = context.pages()[0] || await context.newPage();

    page.on('pageerror', (error) => {
      consoleErrors.push(error.message);
    });
    page.on('console', (message) => {
      if (message.type() === 'error') {
        consoleErrors.push(message.text());
      }
    });

    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    const renderer = await waitForRenderer(page);

    const authResponse = await fetchFromRenderer<{
      success?: boolean;
      data?: { isAuthenticated?: boolean; user?: { id?: string; email?: string } };
      error?: { message?: string };
    }>(page, '/api/domain/auth/getStatus', {
      method: 'POST',
      body: { payload: {} },
    });
    const authData = authResponse.data;
    const authAuthenticated = Boolean(authData?.success && authData.data?.isAuthenticated);
    if (!authResponse.ok || !authAuthenticated) {
      failures.push(`auth gate failed with ${authResponse.status}: ${authResponse.text.slice(0, 500)}`);
    }

    const devEvent = {
      type: 'notification',
      data: {
        message: 'agent-runtime-app-host-smoke',
      },
      sessionId: `agent-runtime-smoke-${Date.now()}`,
    };
    const devSignalResponse = await fetchFromRenderer<{
      ok?: boolean;
      count?: number;
      error?: string;
    }>(page, '/api/dev/emit-agent-events', {
      method: 'POST',
      body: { event: devEvent },
    });
    const devSignalAccepted = Boolean(devSignalResponse.ok && devSignalResponse.data?.ok && devSignalResponse.data.count === 1);
    if (!devSignalAccepted) {
      failures.push(`dev agent event hook failed with ${devSignalResponse.status}: ${devSignalResponse.text.slice(0, 500)}`);
    }

    if (consoleErrors.length > 0) {
      failures.push(`browser console/page errors: ${consoleErrors.slice(0, 3).join(' | ')}`);
    }

    const result = {
      ok: failures.length === 0,
      appHost: {
        baseUrl,
        serverRunning: appHost.child.exitCode === null,
        health,
      },
      chrome: {
        provider: chromeSession.provider,
        executable: chromeSession.executable,
        cdpPort: chromeSession.port,
      },
      renderer,
      auth: {
        status: authResponse.status,
        authenticated: authAuthenticated,
        userId: authData?.data?.user?.id ?? null,
        email: authData?.data?.user?.email ?? null,
      },
      devSignal: {
        status: devSignalResponse.status,
        accepted: devSignalAccepted,
        count: devSignalResponse.data?.count ?? null,
        eventType: devEvent.type,
        sessionId: devEvent.sessionId,
      },
      consoleErrors,
      failures,
    };

    if (hasFlag(args, 'json')) {
      printJson(result);
    } else {
      printKeyValue('Agent Runtime App-Host Smoke Summary', [
        ['baseUrl', result.appHost.baseUrl],
        ['healthStatus', result.appHost.health.status],
        ['chromeProvider', result.chrome.provider],
        ['chromeExecutable', result.chrome.executable],
        ['rendererTitle', result.renderer.title],
        ['rendererTokenPresent', result.renderer.tokenPresent],
        ['authStatus', result.auth.status],
        ['authAuthenticated', result.auth.authenticated],
        ['devSignalStatus', result.devSignal.status],
        ['devSignalAccepted', result.devSignal.accepted],
        ['consoleErrors', consoleErrors.length],
      ]);

      if (failures.length > 0) {
        console.log('\nFailures');
        for (const failure of failures) {
          console.log(`- ${failure}`);
        }
      } else {
        console.log('\nAgent runtime app-host smoke passed.');
      }
    }

    if (failures.length > 0) {
      process.exit(1);
    }
  } finally {
    if (!hasFlag(args, 'keep-browser')) {
      await chromeSession?.browser.close().catch(() => undefined);
      if (chromeSession) {
        await closeSystemChromeSession(chromeSession).catch(() => undefined);
      }
    }
    if (!hasFlag(args, 'keep-server')) {
      await stopProcess(appHost.child);
    }
  }
}

main().catch((error) => finishWithError(formatAcceptanceError(error)));
