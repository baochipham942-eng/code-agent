import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { existsSync } from 'fs';
import type { Page } from 'playwright';
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
  launchSystemChromeSession,
  SYSTEM_CHROME_CDP_PROVIDER,
} from './browser-computer-system-chrome.ts';

function usage(): void {
  console.log(`Browser / Computer app-host smoke

Usage:
  npm run acceptance:browser-computer-app-host -- [options]

Options:
  --visible       Launch the managed browser repair action in visible mode.
  --skip-build    Reuse existing dist/web and dist/renderer artifacts.
  --keep-browser  Keep the Chrome process open after the smoke.
  --keep-server   Keep the app-host server process open after the smoke.
  --port <port>   App-host port. Default: auto.
  --provider <id> Browser provider for managed repair. Default: system-chrome-cdp.
  --json          Print JSON only.
  --help          Show this help.

What it validates:
  - dist/web webServer serves the real dist/renderer app
  - system Chrome headless + CDP can open the real app-host UI
  - ChatInput AbilityMenu can switch Managed/Desktop browser modes
  - Managed repair action starts a real managed browser session
  - Desktop readiness renders unprobed state and repair actions without foreground desktop actions`);
}

function npmCommand(): string {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

const CHAT_FAILURE_SECRET = 'app-host-secret@example.com';
const CHAT_FAILURE_PROMPT = 'Render the app-host computer_use failure smoke card.';

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

async function waitForHealth(baseUrl: string, server: ChildProcessWithoutNullStreams, output: () => string): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < 30_000) {
    if (server.exitCode !== null) {
      throw new Error(`app-host exited early with code ${server.exitCode}\n${output()}`);
    }

    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {
      // Keep polling until timeout.
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`Timed out waiting for app-host health at ${baseUrl}/api/health\n${output()}`);
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

async function expectTextIncludes(label: string, text: string, expected: string, failures: string[]): Promise<void> {
  if (!text.includes(expected)) {
    failures.push(`${label} missing "${expected}"`);
  }
}

async function waitForBrowserStatusText(
  page: Page,
  label: string,
  predicate: (text: string) => boolean,
  timeoutMs = 30_000,
): Promise<string> {
  const start = Date.now();
  let lastText = '';

  while (Date.now() - start < timeoutMs) {
    const locator = page.locator('[data-testid="ability-menu-browser-status"]');
    if (await locator.count()) {
      lastText = await locator.first().innerText({ timeout: 500 }).catch(() => lastText);
      if (predicate(lastText)) {
        return lastText;
      }
    }

    await page.waitForTimeout(250);
  }

  throw new Error(`${label} timed out after ${timeoutMs}ms. Last AbilityMenu text:\n${lastText}`);
}

async function getAbilityMenuText(page: Page): Promise<string> {
  const popover = page.locator('[data-testid="ability-menu-popover"]');
  if (await popover.count()) {
    return await popover.first().innerText({ timeout: 500 }).catch(() => '');
  }
  return '';
}

async function waitForAppReady(page: Page, timeoutMs = 60_000): Promise<void> {
  try {
    await page.locator('[data-chat-input]').waitFor({ state: 'visible', timeout: timeoutMs });
  } catch (error) {
    const title = await page.title().catch(() => '');
    const bodyText = await page.locator('body').innerText({ timeout: 500 }).catch(() => '');
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`App UI did not render chat input within ${timeoutMs}ms.
URL: ${page.url()}
Title: ${title}
Body:
${bodyText.slice(0, 1_500)}

Original error:
${message}`);
  }
}

async function ensureBrowserModeSelected(
  page: Page,
  mode: 'managed' | 'desktop',
  expectedLabel: string,
): Promise<string> {
  const status = page.locator('[data-testid="ability-menu-browser-status"]');
  if (await status.count()) {
    const text = await status.first().innerText({ timeout: 500 }).catch(() => '');
    if (text.includes(expectedLabel)) {
      return text;
    }
  }

  const modeButton = page.locator(`[data-testid="ability-menu-browser-${mode}"]`).first();
  if (await modeButton.isVisible().catch(() => false)) {
    await modeButton.click({ timeout: 5_000 });
  }

  return waitForBrowserStatusText(
    page,
    `${expectedLabel} status`,
    (text) => text.includes(expectedLabel),
    10_000,
  );
}

async function activateRepairAction(page: Page, selector: string, label: string): Promise<'playwright-click' | 'dom-click'> {
  const deadline = Date.now() + 12_000;
  let lastError = '';
  let reselectedManaged = false;

  while (Date.now() < deadline) {
    const button = page.locator(selector).first();
    const visible = await button.isVisible().catch(() => false);
    const enabled = visible ? await button.isEnabled().catch(() => false) : false;

    if (visible && enabled) {
      try {
        await button.click({ timeout: 2_000 });
        return 'playwright-click';
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }

      try {
        const handle = await button.elementHandle({ timeout: 500 });
        if (handle) {
          await handle.evaluate((element) => {
            (element as HTMLElement).click();
          });
          return 'dom-click';
        }
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    } else if (selector.includes('launch_managed_browser') && !reselectedManaged) {
      reselectedManaged = true;
      await page.locator('[data-testid="ability-menu-browser-managed"]').first().click({ timeout: 2_000 }).catch((error) => {
        lastError = error instanceof Error ? error.message : String(error);
      });
    }

    await page.waitForTimeout(250);
  }

  const menuText = await getAbilityMenuText(page);
  throw new Error(`${label} repair action could not be activated. Last error:\n${lastError}\nCurrent AbilityMenu text:\n${menuText}`);
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

function getProviderOption(args: ReturnType<typeof parseArgs>): string {
  const value = args.options.provider;
  if (value === undefined || value === true) {
    return SYSTEM_CHROME_CDP_PROVIDER;
  }
  return Array.isArray(value) ? value[value.length - 1] : value;
}

async function installProviderInjection(page: Page, provider: string): Promise<void> {
  await page.route('**/api/domain/desktop/ensureManagedBrowserSession', async (route) => {
    const request = route.request();
    const postData = request.postData();
    let body: Record<string, unknown> = {};
    if (postData) {
      try {
        body = JSON.parse(postData) as Record<string, unknown>;
      } catch {
        body = {};
      }
    }
    const payload = typeof body.payload === 'object' && body.payload !== null
      ? body.payload as Record<string, unknown>
      : {};

    await route.continue({
      headers: {
        ...request.headers(),
        'content-type': 'application/json',
      },
      postData: JSON.stringify({
        ...body,
        payload: {
          ...payload,
          provider,
        },
      }),
    });
  });
}

function formatSseEvent(event: string, data: Record<string, unknown>): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function buildComputerFailureSse(): string {
  const turnId = 'turn-app-host-computer-failure';
  const toolCallId = 'tool-app-host-computer-failure';
  const toolArguments = {
    action: 'smart_type',
    selector: '#missing-email',
    text: CHAT_FAILURE_SECRET,
  };

  return [
    formatSseEvent('turn_start', {
      turnId,
      iteration: 1,
    }),
    formatSseEvent('stream_chunk', {
      turnId,
      content: 'Checking Computer surface failure rendering.\n',
    }),
    formatSseEvent('stream_tool_call_start', {
      turnId,
      index: 0,
      id: toolCallId,
      name: 'computer_use',
    }),
    formatSseEvent('stream_tool_call_delta', {
      turnId,
      index: 0,
      argumentsDelta: JSON.stringify(toolArguments),
    }),
    formatSseEvent('tool_call_start', {
      turnId,
      _index: 0,
      id: toolCallId,
      name: 'computer_use',
      arguments: toolArguments,
    }),
    formatSseEvent('tool_call_end', {
      toolCallId,
      success: false,
      error: `No element found for selector #missing-email after trying ${CHAT_FAILURE_SECRET}`,
      duration: 12,
      metadata: {
        traceId: 'trace-app-host-computer-failure',
        computerSurfaceMode: 'foreground_fallback',
      },
    }),
    formatSseEvent('turn_end', {
      turnId,
    }),
    formatSseEvent('agent_complete', {}),
  ].join('');
}

async function installRunSseInterception(
  page: Page,
  runRequests: Array<{ prompt: string; sessionId: string | null }>,
): Promise<void> {
  await page.exposeFunction('__recordAppHostSmokeRun', (request: { prompt: string; sessionId: string | null }) => {
    runRequests.push(request);
  });

  await page.addInitScript(({ sseBody, expectedPrompt }: { sseBody: string; expectedPrompt: string }) => {
    type SmokeWindow = Window & {
      __recordAppHostSmokeRun?: (request: { prompt: string; sessionId: string | null }) => void;
      __appHostSmokeRunRequests?: Array<{ prompt: string; sessionId: string | null; status: number }>;
    };
    const smokeWindow = window as SmokeWindow;
    const originalFetch = window.fetch.bind(window);

    smokeWindow.__appHostSmokeRunRequests = [];
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
      const method = (init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
      let isRunEndpoint = false;
      try {
        const parsedUrl = new URL(url, window.location.href);
        isRunEndpoint = parsedUrl.origin === window.location.origin && parsedUrl.pathname === '/api/run';
      } catch {
        isRunEndpoint = url === '/api/run';
      }

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

        const request = {
          prompt: typeof body.prompt === 'string' ? body.prompt : '',
          sessionId: typeof body.sessionId === 'string' ? body.sessionId : null,
          status: 200,
        };
        smokeWindow.__appHostSmokeRunRequests?.push(request);
        void smokeWindow.__recordAppHostSmokeRun?.({
          prompt: request.prompt,
          sessionId: request.sessionId,
        });

        const encoder = new TextEncoder();
        const chunks = sseBody
          .split('\n\n')
          .filter((chunk) => chunk.trim().length > 0)
          .map((chunk) => `${chunk}\n\n`);
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            for (const chunk of chunks) {
              controller.enqueue(encoder.encode(chunk));
            }
            controller.close();
          },
        });

        return new Response(stream, {
          status: 200,
          headers: {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache',
          },
        });
      }

      return originalFetch(input, init);
    };
  }, { sseBody: buildComputerFailureSse(), expectedPrompt: CHAT_FAILURE_PROMPT });
}

async function getRunInterceptionStatus(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    const smokeWindow = window as Window & {
      __appHostSmokeRunRequests?: Array<{ status: number }>;
    };
    const requests = smokeWindow.__appHostSmokeRunRequests || [];
    return requests[requests.length - 1]?.status ?? null;
  });
}

async function closeDesktopPanelIfOpen(page: Page): Promise<void> {
  const panel = page.locator('[data-testid="desktop-status-panel"]').first();
  if (!(await panel.isVisible().catch(() => false))) {
    return;
  }

  await page.locator('[data-testid="desktop-status-panel"] > div').first().click({
    position: { x: 8, y: 8 },
    timeout: 2_000,
  }).catch(() => undefined);
  await panel.waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => undefined);
}

async function exerciseChatInputComputerFailure(
  page: Page,
  failures: string[],
): Promise<{
  runResponseStatus: number | null;
  hasFailureCard: boolean;
  hasRedaction: boolean;
  hasExecutableSnapshotRecovery: boolean;
  recoveryActionClicked: boolean;
  recoveryRequestStatus: number | null;
  recoveryActionSucceeded: boolean;
  recoveryEvidenceVisible: boolean;
  hasNoDesktopStatusAction: boolean;
  leakedSecretInText: boolean;
  leakedSecretInHtml: boolean;
}> {
  await closeDesktopPanelIfOpen(page);
  await page.keyboard.press('Escape').catch(() => undefined);

  const input = page.locator('[data-chat-input]').first();
  await input.scrollIntoViewIfNeeded();
  await input.fill(CHAT_FAILURE_PROMPT);
  await input.press('Enter');

  const runSeen = await page.waitForFunction(
    () => {
      const smokeWindow = window as Window & {
        __appHostSmokeRunRequests?: unknown[];
      };
      return (smokeWindow.__appHostSmokeRunRequests?.length || 0) > 0;
    },
    undefined,
    { timeout: 10_000 },
  ).then(() => true).catch(() => false);
  const runResponseStatus = await getRunInterceptionStatus(page);
  if (!runSeen) {
    failures.push('ChatInput did not call /api/run.');
  } else if (runResponseStatus !== 200) {
    failures.push(`ChatInput /api/run returned ${runResponseStatus ?? 'unknown'}.`);
  }

  await page.waitForFunction(
    () => document.body.innerText.includes('刷新页面证据'),
    undefined,
    { timeout: 15_000 },
  ).catch(() => undefined);

  const text = await page.locator('body').innerText({ timeout: 2_000 }).catch(() => '');
  const html = await page.content().catch(() => '');
  const snapshotAction = page.locator('[data-testid="browser-computer-next-step-action-refresh_browser_snapshot"]').first();
  const desktopStatusAction = page.locator('[data-testid="browser-computer-next-step-action-open_desktop_status"]').first();
  const expectedRedaction = `[redacted ${CHAT_FAILURE_SECRET.length} chars]`;
  const hasFailureCard = text.includes('Computer')
    && text.includes('刷新页面证据')
    && text.includes('trace-app-host-computer-failure');
  const hasRedaction = text.includes(expectedRedaction);
  const hasExecutableSnapshotRecovery = text.includes('读取 DOM / Accessibility snapshot')
    && text.includes('可执行')
    && (html.includes('browser-computer-next-step-action-refresh_browser_snapshot')
      || await snapshotAction.isVisible().catch(() => false));
  const hasDesktopStatusAction = html.includes('browser-computer-next-step-action-open_desktop_status')
    || await desktopStatusAction.isVisible().catch(() => false);
  const hasNoDesktopStatusAction = !hasDesktopStatusAction;
  let leakedSecretInText = text.includes(CHAT_FAILURE_SECRET);
  let leakedSecretInHtml = html.includes(CHAT_FAILURE_SECRET);
  let recoveryActionClicked = false;
  let recoveryRequestStatus: number | null = null;
  let recoveryActionSucceeded = false;
  let recoveryEvidenceVisible = false;

  if (!hasFailureCard) {
    failures.push('ChatInput computer_use failure card did not render expected snapshot recovery summary/trace.');
  }
  if (!hasRedaction) {
    failures.push(`ChatInput computer_use failure card missing ${expectedRedaction}.`);
  }
  if (!hasExecutableSnapshotRecovery) {
    failures.push('ChatInput computer_use failure card missing executable DOM/Accessibility snapshot recovery action.');
  }
  if (!hasNoDesktopStatusAction) {
    failures.push('ChatInput browser-selector recovery unexpectedly rendered Desktop status action.');
  }
  if (leakedSecretInText || leakedSecretInHtml) {
    failures.push('ChatInput computer_use failure leaked input payload secret into rendered DOM.');
  }

  if (hasExecutableSnapshotRecovery) {
    const recoveryResponsePromise = page.waitForResponse(
      (response) => response.url().includes('/api/domain/desktop/getManagedBrowserRecoverySnapshot')
        && response.request().method() === 'POST',
      { timeout: 15_000 },
    ).catch(() => null);
    await snapshotAction.click({ timeout: 5_000 });
    recoveryActionClicked = true;
    const recoveryResponse = await recoveryResponsePromise;
    recoveryRequestStatus = recoveryResponse?.status() ?? null;
    if (!recoveryResponse?.ok()) {
      failures.push(`ChatInput snapshot recovery action returned ${recoveryRequestStatus ?? 'unknown'}.`);
    }
    await page.waitForFunction(
      () => {
        const bodyText = document.body.innerText;
        return bodyText.includes('success')
          && bodyText.includes('页面证据已刷新')
          && bodyText.includes('DOM headings:')
          && bodyText.includes('Interactive elements:')
          && bodyText.includes('Accessibility snapshot:');
      },
      undefined,
      { timeout: 15_000 },
    ).catch(() => undefined);

    const afterText = await page.locator('body').innerText({ timeout: 2_000 }).catch(() => '');
    const afterHtml = await page.content().catch(() => '');
    recoveryActionSucceeded = afterText.includes('success') && afterText.includes('页面证据已刷新');
    recoveryEvidenceVisible = afterText.includes('DOM headings:')
      && afterText.includes('Interactive elements:')
      && afterText.includes('Accessibility snapshot:');
    leakedSecretInText = leakedSecretInText || afterText.includes(CHAT_FAILURE_SECRET);
    leakedSecretInHtml = leakedSecretInHtml || afterHtml.includes(CHAT_FAILURE_SECRET);

    if (!recoveryActionSucceeded) {
      failures.push('ChatInput snapshot recovery action did not render success status.');
    }
    if (!recoveryEvidenceVisible) {
      failures.push('ChatInput snapshot recovery action did not render DOM/a11y evidence summary.');
    }
    if (leakedSecretInText || leakedSecretInHtml) {
      failures.push('ChatInput snapshot recovery result leaked input payload secret into rendered DOM.');
    }
  }

  return {
    runResponseStatus,
    hasFailureCard,
    hasRedaction,
    hasExecutableSnapshotRecovery,
    recoveryActionClicked,
    recoveryRequestStatus,
    recoveryActionSucceeded,
    recoveryEvidenceVisible,
    hasNoDesktopStatusAction,
    leakedSecretInText,
    leakedSecretInHtml,
  };
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
  const provider = getProviderOption(args);
  let chromeSession: Awaited<ReturnType<typeof launchSystemChromeSession>> | null = null;
  const failures: string[] = [];
  const consoleErrors: string[] = [];
  const repairRequests: Array<{ action: string; status: number | null; ok: boolean }> = [];
  const runRequests: Array<{ prompt: string; sessionId: string | null }> = [];

  try {
    await waitForHealth(baseUrl, appHost.child, appHost.output);
    chromeSession = await launchSystemChromeSession({
      profilePrefix: 'code-agent-browser-computer-app-host-',
    });
    const context = chromeSession.browser.contexts()[0] || await chromeSession.browser.newContext();
    const page = context.pages()[0] || await context.newPage();
    await installProviderInjection(page, provider);
    await installRunSseInterception(page, runRequests);

    page.on('pageerror', (error) => {
      consoleErrors.push(error.message);
    });
    page.on('console', (message) => {
      if (message.type() === 'error') {
        consoleErrors.push(message.text());
      }
    });
    page.on('response', (response) => {
      const url = response.url();
      if (url.includes('/api/domain/desktop/')) {
        const action = url.split('/api/domain/desktop/')[1]?.split(/[?#]/)[0] || 'unknown';
        repairRequests.push({
          action,
          status: response.status(),
          ok: response.ok(),
        });
      }
    });

    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await waitForAppReady(page);
    await page.locator('[data-testid="ability-menu-trigger"]').click();
    await page.locator('[data-testid="ability-menu-popover"]').waitFor({ state: 'visible', timeout: 10_000 });

    await page.locator('[data-testid="ability-menu-browser-managed"]').click();
    const managedInitialText = await ensureBrowserModeSelected(page, 'managed', 'Managed browser');
    await expectTextIncludes('managed initial', managedInitialText, 'Managed browser', failures);

    const managedRepairSelector = hasFlag(args, 'visible')
      ? '[data-testid="ability-menu-repair-launch_managed_browser_visible"]'
      : '[data-testid="ability-menu-repair-launch_managed_browser"]';
    const managedInitiallyReady = managedInitialText.includes('Ready') && managedInitialText.includes('Running');

    let managedReadyText = managedInitialText;
    let repairActionClicked = false;
    let repairActivationMethod: 'playwright-click' | 'dom-click' | null = null;
    let managedRepairReturnedProvider: string | null = null;
    if (!managedInitiallyReady) {
      await expectTextIncludes('managed initial', managedInitialText, 'Blocked', failures);
      await expectTextIncludes('managed initial', managedInitialText, 'Stopped', failures);

      const repairButton = page.locator(managedRepairSelector);
      if (await repairButton.count() === 0 || !(await repairButton.first().isVisible().catch(() => false))) {
        throw new Error(`Managed repair action was not visible. Current AbilityMenu text:\n${await getAbilityMenuText(page) || managedInitialText}`);
      }
      const expectedRepairAction = 'ensureManagedBrowserSession';
      const repairResponsePromise = page.waitForResponse(
        (response) => response.url().includes(`/api/domain/desktop/${expectedRepairAction}`)
          && response.request().method() === 'POST',
        { timeout: 15_000 },
      ).catch(() => null);

      repairActivationMethod = await activateRepairAction(page, managedRepairSelector, 'Managed browser');
      repairActionClicked = true;
      const repairResponse = await repairResponsePromise;
      if (!repairResponse) {
        throw new Error(`Managed repair action did not call ${expectedRepairAction}. Current AbilityMenu text:\n${await getAbilityMenuText(page) || managedInitialText}`);
      }
      if (!repairResponse.ok()) {
        const body = await repairResponse.text().catch(() => '');
        throw new Error(`Managed repair action returned ${repairResponse.status()}.\n${body}`);
      }
      const repairBody = await repairResponse.json().catch(() => null) as {
        data?: { provider?: string | null };
      } | null;
      managedRepairReturnedProvider = repairBody?.data?.provider ?? null;
      if (managedRepairReturnedProvider && managedRepairReturnedProvider !== provider) {
        failures.push(`Managed repair provider mismatch: expected ${provider}, got ${managedRepairReturnedProvider}.`);
      }

      await ensureBrowserModeSelected(page, 'managed', 'Managed browser');
      managedReadyText = await waitForBrowserStatusText(
        page,
        'Managed browser ready state',
        (text) => text.includes('Managed browser') && text.includes('Ready') && text.includes('Running'),
        45_000,
      );
    }
    await expectTextIncludes('managed ready', managedReadyText, 'Managed browser', failures);
    await expectTextIncludes('managed ready', managedReadyText, 'Ready', failures);
    await expectTextIncludes('managed ready', managedReadyText, 'Running', failures);
    await expectTextIncludes('managed ready', managedReadyText, hasFlag(args, 'visible') ? 'visible' : 'headless', failures);

    await page.locator('[data-testid="ability-menu-browser-desktop"]').click();
    const desktopText = await ensureBrowserModeSelected(page, 'desktop', 'Computer surface');
    await expectTextIncludes('desktop status', desktopText, 'Computer surface', failures);
    await expectTextIncludes('desktop status', desktopText, 'Blocked', failures);
    await expectTextIncludes('desktop status', desktopText, 'Screen Capture', failures);
    await expectTextIncludes('desktop status', desktopText, 'Accessibility', failures);
    await expectTextIncludes('desktop status', desktopText, '未探测', failures);
    await expectTextIncludes('desktop status', desktopText, '检查屏幕录制', failures);
    await expectTextIncludes('desktop status', desktopText, '检查辅助功能', failures);
    await expectTextIncludes('desktop status', desktopText, '查看桌面状态', failures);

    const desktopPanelButton = page.locator('[data-testid="ability-menu-repair-open_desktop_panel"]').first();
    if (await desktopPanelButton.count() === 0 || !(await desktopPanelButton.isVisible().catch(() => false))) {
      throw new Error(`Desktop status repair action was not visible. Current AbilityMenu text:\n${await getAbilityMenuText(page) || desktopText}`);
    }
    await desktopPanelButton.click({ timeout: 5_000 });
    const desktopPanel = page.locator('[data-testid="desktop-status-panel"]').first();
    await desktopPanel.waitFor({ state: 'visible', timeout: 10_000 });
    const desktopPanelText = await desktopPanel.innerText({ timeout: 2_000 }).catch(() => '');
    await expectTextIncludes('desktop panel', desktopPanelText, '桌面活动', failures);
    await page.mouse.click(10, 10).catch(() => undefined);
    await desktopPanel.waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => undefined);
    const chatInputFailure = await exerciseChatInputComputerFailure(page, failures);

    const result = {
      ok: failures.length === 0,
      appHost: {
        baseUrl,
        serverRunning: appHost.child.exitCode === null,
      },
      chrome: {
        provider: chromeSession.provider,
        executable: chromeSession.executable,
        cdpPort: chromeSession.port,
      },
      ui: {
        managedProvider: provider,
        managedInitial: {
          blocked: managedInitialText.includes('Blocked'),
          hasHeadlessRepair: managedInitialText.includes('启动隔离浏览器'),
          hasVisibleRepair: managedInitialText.includes('打开可见浏览器'),
        },
        managedReady: {
          ready: managedReadyText.includes('Ready'),
          running: managedReadyText.includes('Running'),
          mode: hasFlag(args, 'visible') ? 'visible' : 'headless',
          returnedProvider: managedRepairReturnedProvider,
          repairActionClicked,
          repairActivationMethod,
          repairRequests,
        },
        desktop: {
          blocked: desktopText.includes('Blocked'),
          unprobed: desktopText.includes('未探测'),
          hasRepairActions: desktopText.includes('检查屏幕录制')
            && desktopText.includes('检查辅助功能')
            && desktopText.includes('查看桌面状态'),
          panelOpened: desktopPanelText.includes('桌面活动'),
        },
        chatInputFailure,
        runRequests,
        consoleErrors,
      },
      failures,
    };

    if (consoleErrors.length > 0) {
      failures.push(`browser console/page errors: ${consoleErrors.slice(0, 3).join(' | ')}`);
      result.ok = false;
    }

    if (hasFlag(args, 'json')) {
      printJson(result);
    } else {
      printKeyValue('Browser / Computer App-Host Smoke Summary', [
        ['baseUrl', result.appHost.baseUrl],
        ['chromeProvider', result.chrome.provider],
        ['chromeExecutable', result.chrome.executable],
        ['managedRepairProvider', result.ui.managedProvider],
        ['managedRepairReturnedProvider', result.ui.managedReady.returnedProvider],
        ['managedInitialBlocked', result.ui.managedInitial.blocked],
        ['managedReady', result.ui.managedReady.ready],
        ['managedMode', result.ui.managedReady.mode],
        ['desktopBlocked', result.ui.desktop.blocked],
        ['desktopUnprobed', result.ui.desktop.unprobed],
        ['desktopRepairActions', result.ui.desktop.hasRepairActions],
        ['desktopPanelOpened', result.ui.desktop.panelOpened],
        ['chatRunResponseStatus', result.ui.chatInputFailure.runResponseStatus],
        ['chatFailureCard', result.ui.chatInputFailure.hasFailureCard],
        ['chatRedaction', result.ui.chatInputFailure.hasRedaction],
        ['chatSnapshotRecovery', result.ui.chatInputFailure.hasExecutableSnapshotRecovery],
        ['chatRecoveryClicked', result.ui.chatInputFailure.recoveryActionClicked],
        ['chatRecoveryStatus', result.ui.chatInputFailure.recoveryRequestStatus],
        ['chatRecoverySucceeded', result.ui.chatInputFailure.recoveryActionSucceeded],
        ['chatRecoveryEvidence', result.ui.chatInputFailure.recoveryEvidenceVisible],
        ['chatNoDesktopStatusAction', result.ui.chatInputFailure.hasNoDesktopStatusAction],
        ['chatSecretLeaked', result.ui.chatInputFailure.leakedSecretInText || result.ui.chatInputFailure.leakedSecretInHtml],
        ['chatRunRequests', result.ui.runRequests.length],
        ['consoleErrors', consoleErrors.length],
      ]);

      if (failures.length > 0) {
        console.log('\nFailures');
        for (const failure of failures) {
          console.log(`- ${failure}`);
        }
      } else {
        console.log('\nApp-host smoke passed.');
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
