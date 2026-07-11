import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { chromium, type Browser, type Page } from 'playwright';
import {
  finishWithError,
  getNumberOption,
  getStringOption,
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

interface UiCancelRunRequest {
  prompt: string;
  sessionId: string | null;
  status: 'pending';
}

interface DevAgentLoopStubStatus {
  ok?: boolean;
  sessionId?: string;
  exists?: boolean;
  active?: boolean;
  cancelCount?: number;
  cancelledAt?: number | null;
  releasedAt?: number | null;
  cancelReason?: string | null;
  error?: string;
}

const UI_CANCEL_PROMPT = 'agent-runtime-ui-cancel-smoke-hold-run';
const DEFAULT_REPORT_PATH = 'docs/stability/agent-runtime-app-host-smoke-latest.json';

function gitHead(): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: process.cwd(), encoding: 'utf8' }).trim();
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
  --out <path>    Structured evidence path. Default: ${DEFAULT_REPORT_PATH}.
  --json          Print JSON only.
  --help          Show this help.

What it validates:
  - dist/web webServer serves the real dist/renderer app
  - /api/health responds from the app-host server
  - system Chrome headless + CDP can open the real renderer
  - the local web auth gate returns an authenticated dev user
  - a controlled dev-only agent event hook accepts a minimal event
  - the renderer stop button clicks through to the app-host cancel route

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

async function installUiCancelRunInterception(
  page: Page,
  runRequests: UiCancelRunRequest[],
): Promise<void> {
  await page.exposeFunction('__recordAgentRuntimeUiCancelRun', (request: UiCancelRunRequest) => {
    runRequests.push(request);
  });

  await page.addInitScript(({ expectedPrompt }: { expectedPrompt: string }) => {
    type SmokeWindow = Window & {
      __recordAgentRuntimeUiCancelRun?: (request: UiCancelRunRequest) => void;
      __agentRuntimeUiCancelRunRequests?: UiCancelRunRequest[];
    };
    const smokeWindow = window as SmokeWindow;
    const originalFetch = window.fetch.bind(window);

    smokeWindow.__agentRuntimeUiCancelRunRequests = [];
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
      const method = (init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
      const isRunEndpoint = (() => {
        try {
          const parsedUrl = new URL(url, window.location.href);
          return parsedUrl.origin === window.location.origin && parsedUrl.pathname === '/api/run';
        } catch {
          return url === '/api/run';
        }
      })();

      if (isRunEndpoint && method === 'POST') {
        let body: Record<string, unknown> = {};
        if (typeof init?.body === 'string') {
          try {
            body = JSON.parse(init.body) as Record<string, unknown>;
          } catch {
            body = {};
          }
        }
        if (body.prompt !== expectedPrompt) {
          return originalFetch(input, init);
        }

        const request: UiCancelRunRequest = {
          prompt: typeof body.prompt === 'string' ? body.prompt : '',
          sessionId: typeof body.sessionId === 'string' ? body.sessionId : null,
          status: 'pending',
        };
        smokeWindow.__agentRuntimeUiCancelRunRequests?.push(request);
        void smokeWindow.__recordAgentRuntimeUiCancelRun?.(request);
        return new Promise<Response>(() => undefined);
      }

      return originalFetch(input, init);
    };
  }, { expectedPrompt: UI_CANCEL_PROMPT });
}

async function readLatestUiCancelRunRequest(page: Page): Promise<UiCancelRunRequest | null> {
  return page.evaluate(() => {
    const smokeWindow = window as Window & {
      __agentRuntimeUiCancelRunRequests?: UiCancelRunRequest[];
    };
    const requests = smokeWindow.__agentRuntimeUiCancelRunRequests || [];
    return requests[requests.length - 1] ?? null;
  });
}

async function waitForStubCancel(
  page: Page,
  sessionId: string,
  timeoutMs = 5_000,
): Promise<DevAgentLoopStubStatus | null> {
  const deadline = Date.now() + timeoutMs;
  let latest: DevAgentLoopStubStatus | null = null;
  while (Date.now() < deadline) {
    const response = await fetchFromRenderer<DevAgentLoopStubStatus>(
      page,
      `/api/dev/agent-loop-stub/${encodeURIComponent(sessionId)}`,
    );
    latest = response.data;
    if (response.ok && latest?.ok && latest.cancelCount && latest.cancelCount > 0 && latest.active === false) {
      return latest;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return latest;
}

async function verifyRendererCancelClick(
  page: Page,
  runRequests: UiCancelRunRequest[],
  failures: string[],
): Promise<{
  prompt: string;
  sessionId: string | null;
  runIntercepted: boolean;
  stubCreated: boolean;
  stopButtonVisible: boolean;
  stubCancelled: boolean;
  stopButtonHiddenAfterCancel: boolean;
  cancelCount: number;
  cancelledAt: number | null;
  releasedAt: number | null;
  cancelToRunReleaseMs: number | null;
  cancelToUiCleanupMs: number | null;
}> {
  const input = page.locator('[data-chat-input]').first();
  await input.scrollIntoViewIfNeeded();
  await input.fill(UI_CANCEL_PROMPT);
  await input.press('Enter');

  const runIntercepted = await page.waitForFunction(
    () => {
      const smokeWindow = window as Window & {
        __agentRuntimeUiCancelRunRequests?: unknown[];
      };
      return (smokeWindow.__agentRuntimeUiCancelRunRequests?.length || 0) > 0;
    },
    undefined,
    { timeout: 10_000 },
  ).then(() => true).catch(() => false);
  const latestRun = await readLatestUiCancelRunRequest(page);
  const sessionId = latestRun?.sessionId ?? runRequests[runRequests.length - 1]?.sessionId ?? null;

  if (!runIntercepted || !sessionId) {
    failures.push('renderer cancel smoke did not reach a held /api/run request with a sessionId.');
    return {
      prompt: UI_CANCEL_PROMPT,
      sessionId,
      runIntercepted,
      stubCreated: false,
      stopButtonVisible: false,
      stubCancelled: false,
      stopButtonHiddenAfterCancel: false,
      cancelCount: 0,
      cancelledAt: null,
      releasedAt: null,
      cancelToRunReleaseMs: null,
      cancelToUiCleanupMs: null,
    };
  }

  const stubCreate = await fetchFromRenderer<DevAgentLoopStubStatus>(page, '/api/dev/agent-loop-stub', {
    method: 'POST',
    body: { sessionId },
  });
  const stubCreated = Boolean(stubCreate.ok && stubCreate.data?.ok && stubCreate.data.active);
  if (!stubCreated) {
    failures.push(`renderer cancel smoke could not seed active loop stub: ${stubCreate.status} ${stubCreate.text.slice(0, 500)}`);
  }

  const stopButton = page.locator('button[aria-label="停止"]').first();
  const stopButtonVisible = await stopButton.waitFor({ state: 'visible', timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
  let stopRequestedAt: number | null = null;
  if (!stopButtonVisible) {
    failures.push('renderer cancel smoke did not render the stop button while the run was held.');
  } else {
    stopRequestedAt = Date.now();
    await stopButton.click();
  }

  const stubAfterCancel = sessionId ? await waitForStubCancel(page, sessionId) : null;
  const stubCancelled = Boolean(stubAfterCancel?.ok && (stubAfterCancel.cancelCount ?? 0) > 0 && stubAfterCancel.active === false);
  if (!stubCancelled) {
    failures.push(`renderer cancel smoke did not cancel the app-host loop stub: ${JSON.stringify(stubAfterCancel)}`);
  }

  const stopButtonHiddenAfterCancel = await stopButton.waitFor({ state: 'hidden', timeout: 5_000 })
    .then(() => true)
    .catch(() => false);
  const uiClearedAt = stopButtonHiddenAfterCancel ? Date.now() : null;
  if (!stopButtonHiddenAfterCancel) {
    failures.push('renderer cancel smoke did not clear the stop button after cancel completed.');
  }

  const cancelToRunReleaseMs = stopRequestedAt && stubAfterCancel?.releasedAt
    ? stubAfterCancel.releasedAt - stopRequestedAt
    : null;
  const cancelToUiCleanupMs = stopRequestedAt && uiClearedAt
    ? uiClearedAt - stopRequestedAt
    : null;
  if (cancelToRunReleaseMs === null || cancelToRunReleaseMs > 1_000) {
    failures.push(`renderer cancel smoke exceeded the 1s RunRegistry release gate: ${String(cancelToRunReleaseMs)}ms`);
  }
  if (cancelToUiCleanupMs === null || cancelToUiCleanupMs > 1_000) {
    failures.push(`renderer cancel smoke exceeded the 1s UI cleanup gate: ${String(cancelToUiCleanupMs)}ms`);
  }

  if (sessionId) {
    await fetchFromRenderer(page, `/api/dev/agent-loop-stub/${encodeURIComponent(sessionId)}`, {
      method: 'DELETE',
    }).catch(() => undefined);
  }

  return {
    prompt: UI_CANCEL_PROMPT,
    sessionId,
    runIntercepted,
    stubCreated,
    stopButtonVisible,
    stubCancelled,
    stopButtonHiddenAfterCancel,
    cancelCount: stubAfterCancel?.cancelCount ?? 0,
    cancelledAt: stubAfterCancel?.cancelledAt ?? null,
    releasedAt: stubAfterCancel?.releasedAt ?? null,
    cancelToRunReleaseMs,
    cancelToUiCleanupMs,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (hasFlag(args, 'help')) {
    usage();
    return;
  }

  const reportPath = resolve(process.cwd(), getStringOption(args, 'out') || DEFAULT_REPORT_PATH);

  await ensureBuild(hasFlag(args, 'skip-build'));

  const appPort = getNumberOption(args, 'port') || await getFreePort();
  const baseUrl = `http://127.0.0.1:${appPort}`;
  const appHost = startAppHost(appPort);
  let chromeSession: SmokeChromeSession | null = null;
  const failures: string[] = [];
  const consoleErrors: string[] = [];
  const uiCancelRunRequests: UiCancelRunRequest[] = [];

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

    await installUiCancelRunInterception(page, uiCancelRunRequests);
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

    const uiCancel = await verifyRendererCancelClick(page, uiCancelRunRequests, failures);

    if (consoleErrors.length > 0) {
      failures.push(`browser console/page errors: ${consoleErrors.slice(0, 3).join(' | ')}`);
    }

    const result = {
      schemaVersion: 1,
      smoke: 'agent-runtime-app-host',
      generatedAt: new Date().toISOString(),
      gitHead: gitHead(),
      passed: failures.length === 0,
      scenarios: {
        RunRegistry: {
          passed: uiCancel.stubCreated && uiCancel.stubCancelled && uiCancel.cancelToRunReleaseMs !== null
            && uiCancel.cancelToRunReleaseMs <= 1_000,
          durationMs: uiCancel.cancelToRunReleaseMs ?? -1,
          terminalCleanup: uiCancel.stubCancelled && uiCancel.releasedAt !== null,
        },
        rendererStop: {
          passed: uiCancel.runIntercepted && uiCancel.stopButtonVisible && uiCancel.stopButtonHiddenAfterCancel
            && uiCancel.cancelToUiCleanupMs !== null && uiCancel.cancelToUiCleanupMs <= 1_000,
          durationMs: uiCancel.cancelToUiCleanupMs ?? -1,
          terminalCleanup: uiCancel.stopButtonHiddenAfterCancel,
        },
      },
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
      uiCancel,
      consoleErrors,
      failures,
    };
    result.passed = result.passed
      && Object.values(result.scenarios).every((scenario) => scenario.passed && scenario.terminalCleanup);
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, `${JSON.stringify({
      schemaVersion: result.schemaVersion,
      smoke: result.smoke,
      generatedAt: result.generatedAt,
      gitHead: result.gitHead,
      passed: result.passed,
      scenarios: result.scenarios,
    }, null, 2)}\n`);

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
        ['uiCancelSessionId', result.uiCancel.sessionId],
        ['uiCancelRunIntercepted', result.uiCancel.runIntercepted],
        ['uiCancelStubCancelled', result.uiCancel.stubCancelled],
        ['uiCancelStopHiddenAfterCancel', result.uiCancel.stopButtonHiddenAfterCancel],
        ['uiCancelToRunReleaseMs', result.uiCancel.cancelToRunReleaseMs],
        ['uiCancelToUiCleanupMs', result.uiCancel.cancelToUiCleanupMs],
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

    if (!result.passed) {
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
