import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import net from 'net';
import { chromium, type Browser, type Page } from 'playwright';
import {
  finishWithError,
  getNumberOption,
  hasFlag,
  parseArgs,
  printJson,
  printKeyValue,
} from './_helpers.ts';

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

function getChromeExecutable(): string {
  if (process.env.CHROME_PATH) {
    return process.env.CHROME_PATH;
  }

  if (process.platform === 'darwin') {
    return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  }

  return 'google-chrome';
}

function getFreePort(): Promise<number> {
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

function startChrome(port: number, profileDir: string): ChildProcessWithoutNullStreams {
  return spawn(getChromeExecutable(), [
    '--headless=new',
    '--disable-gpu',
    '--disable-background-networking',
    '--disable-sync',
    '--disable-extensions',
    '--disable-component-update',
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=${profileDir}`,
    '--remote-debugging-address=127.0.0.1',
    `--remote-debugging-port=${port}`,
    'about:blank',
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function connectToChrome(port: number, timeoutMs = 10_000): Promise<Browser> {
  const start = Date.now();
  let lastError: unknown;

  while (Date.now() - start < timeoutMs) {
    try {
      return await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Failed to connect to Chrome over CDP');
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

async function removeDirWithRetries(dir: string): Promise<void> {
  let lastError: unknown;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`Failed to remove ${dir}`);
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

  const chromePort = await getFreePort();
  const profileDir = mkdtempSync(join(tmpdir(), 'code-agent-browser-computer-app-host-'));
  const chrome = startChrome(chromePort, profileDir);

  let browser: Browser | null = null;
  const failures: string[] = [];
  const consoleErrors: string[] = [];
  const repairRequests: Array<{ action: string; status: number | null; ok: boolean }> = [];

  try {
    await waitForHealth(baseUrl, appHost.child, appHost.output);
    browser = await connectToChrome(chromePort);
    const context = browser.contexts()[0] || await browser.newContext();
    const page = context.pages()[0] || await context.newPage();

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
    await expectTextIncludes('desktop status', desktopText, '检查/授权屏幕录制', failures);
    await expectTextIncludes('desktop status', desktopText, '检查/授权辅助功能', failures);
    await expectTextIncludes('desktop status', desktopText, '打开桌面面板', failures);

    const result = {
      ok: failures.length === 0,
      appHost: {
        baseUrl,
        serverRunning: appHost.child.exitCode === null,
      },
      chrome: {
        executable: getChromeExecutable(),
        cdpPort: chromePort,
      },
      ui: {
        managedInitial: {
          blocked: managedInitialText.includes('Blocked'),
          hasHeadlessRepair: managedInitialText.includes('启动 Headless'),
          hasVisibleRepair: managedInitialText.includes('启动 Visible'),
        },
        managedReady: {
          ready: managedReadyText.includes('Ready'),
          running: managedReadyText.includes('Running'),
          mode: hasFlag(args, 'visible') ? 'visible' : 'headless',
          repairActionClicked,
          repairActivationMethod,
          repairRequests,
        },
        desktop: {
          blocked: desktopText.includes('Blocked'),
          unprobed: desktopText.includes('未探测'),
          hasRepairActions: desktopText.includes('检查/授权屏幕录制')
            && desktopText.includes('检查/授权辅助功能')
            && desktopText.includes('打开桌面面板'),
        },
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
        ['chromeExecutable', result.chrome.executable],
        ['managedInitialBlocked', result.ui.managedInitial.blocked],
        ['managedReady', result.ui.managedReady.ready],
        ['managedMode', result.ui.managedReady.mode],
        ['desktopBlocked', result.ui.desktop.blocked],
        ['desktopUnprobed', result.ui.desktop.unprobed],
        ['desktopRepairActions', result.ui.desktop.hasRepairActions],
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
    if (browser && !hasFlag(args, 'keep-browser')) {
      await browser.close().catch(() => undefined);
    }
    if (!hasFlag(args, 'keep-browser')) {
      await stopProcess(chrome);
      await removeDirWithRetries(profileDir);
    }
    if (!hasFlag(args, 'keep-server')) {
      await stopProcess(appHost.child);
    }
  }
}

main().catch(finishWithError);
