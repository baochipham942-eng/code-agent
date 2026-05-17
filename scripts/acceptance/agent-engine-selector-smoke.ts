import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { delimiter, join } from 'path';
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
} from './browser-computer-system-chrome.ts';

type AgentEngineKind = 'native' | 'codex_cli' | 'claude_code';

interface AgentEngineSessionMetadata {
  kind: AgentEngineKind;
  cwd?: string;
  permissionProfile?: string;
  origin?: string;
  updatedAt?: number;
}

interface SessionLike {
  id: string;
  title?: string;
  workingDirectory?: string | null;
  engine?: AgentEngineSessionMetadata;
}

interface DomainResponse<T> {
  success: boolean;
  data?: T;
  error?: { message?: string };
}

function usage(): void {
  console.log(`Agent Engine selector app-host smoke

Usage:
  npm run acceptance:agent-engine-selector -- [options]

Options:
  --visible       Launch system Chrome in visible mode.
  --skip-build    Reuse existing dist/web and dist/renderer artifacts.
  --keep-browser  Keep the Chrome process open after the smoke.
  --keep-server   Keep the app-host server process open after the smoke.
  --port <port>   App-host port. Default: auto.
  --json          Print JSON only.
  --help          Show this help.

What it validates:
  - the local app-host serves the current renderer build
  - system Chrome headless + CDP can open the real app-host UI
  - the Engine selector exposes Native, Codex CLI, and Claude Code descriptors
  - selecting an external engine writes session engine metadata
  - no external CLI model run is started; fake codex/claude binaries only answer --version`);
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

function createFakeExternalEngineBin(): string {
  const binDir = mkdtempSync(join(tmpdir(), 'code-agent-agent-engine-smoke-bin-'));

  if (process.platform === 'win32') {
    writeFileSync(join(binDir, 'codex.cmd'), '@echo off\r\necho codex 0.0.0-smoke\r\n', 'utf-8');
    writeFileSync(join(binDir, 'claude.cmd'), '@echo off\r\necho claude 0.0.0-smoke\r\n', 'utf-8');
    return binDir;
  }

  const codexPath = join(binDir, 'codex');
  const claudePath = join(binDir, 'claude');
  writeFileSync(codexPath, '#!/bin/sh\necho "codex 0.0.0-smoke"\n', 'utf-8');
  writeFileSync(claudePath, '#!/bin/sh\necho "claude 0.0.0-smoke"\n', 'utf-8');
  chmodSync(codexPath, 0o755);
  chmodSync(claudePath, 0o755);
  return binDir;
}

function startAppHost(port: number, fakeBinDir: string): { child: ChildProcessWithoutNullStreams; output: () => string } {
  let logs = '';
  const child = spawn('node', ['dist/web/webServer.cjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PATH: `${fakeBinDir}${delimiter}${process.env.PATH || ''}`,
      WEB_HOST: '127.0.0.1',
      WEB_PORT: String(port),
      CODE_AGENT_ENABLE_DEV_API: 'true',
      CODE_AGENT_E2E: '1',
      CODE_AGENT_WORKING_DIR: process.cwd(),
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

async function dismissApiKeySetupIfVisible(page: Page): Promise<void> {
  const skipButton = page.getByRole('button', { name: '稍后配置' }).first();
  if (await skipButton.isVisible().catch(() => false)) {
    await skipButton.click({ timeout: 2_000 }).catch(() => undefined);
  }
}

async function waitForAppReady(page: Page, timeoutMs = 60_000): Promise<void> {
  try {
    await page.setViewportSize({ width: 1440, height: 960 }).catch(() => undefined);
    const showSidebar = page.getByLabel('Show sidebar');
    if (await showSidebar.isVisible().catch(() => false)) {
      await showSidebar.click({ timeout: 5_000 }).catch(() => undefined);
    }
    await page.locator('[data-chat-input]').waitFor({ state: 'visible', timeout: timeoutMs });
    await dismissApiKeySetupIfVisible(page);
    await page.locator('button[aria-label="切换模型"]').last().waitFor({ state: 'visible', timeout: timeoutMs });
  } catch (error) {
    const bodyText = await page.locator('body').innerText({ timeout: 500 }).catch(() => '');
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`App UI did not render the chat shell within ${timeoutMs}ms.
URL: ${page.url()}
Body:
${bodyText.slice(0, 1_500)}

Original error:
${message}`);
  }
}

async function invokeDomain<T>(
  page: Page,
  domain: string,
  action: string,
  payload?: unknown,
): Promise<T> {
  return page.evaluate(async ({ domainName, actionName, actionPayload }) => {
    const api = window.domainAPI || window.codeAgentDomainAPI;
    if (!api) {
      throw new Error('domainAPI is not available');
    }
    const response = await api.invoke(domainName, actionName, actionPayload) as DomainResponse<unknown>;
    if (!response?.success) {
      throw new Error(response?.error?.message || `${domainName}:${actionName} failed`);
    }
    return response.data;
  }, { domainName: domain, actionName: action, actionPayload: payload }) as Promise<T>;
}

async function createSmokeSession(page: Page, workingDirectory: string): Promise<SessionLike> {
  const title = `Engine Selector Smoke ${Date.now()}`;
  const session = await invokeDomain<SessionLike>(page, 'domain:session', 'create', {
    title,
    workingDirectory,
  });
  if (!session?.id) {
    throw new Error('Session create did not return an id.');
  }
  return session;
}

async function loadSession(page: Page, sessionId: string): Promise<SessionLike> {
  const session = await invokeDomain<SessionLike>(page, 'domain:session', 'load', { sessionId });
  if (!session?.id) {
    throw new Error(`Session load did not return ${sessionId}.`);
  }
  return session;
}

async function selectEngineViaDomain(
  page: Page,
  sessionId: string,
  kind: AgentEngineKind,
): Promise<AgentEngineSessionMetadata> {
  return invokeDomain<AgentEngineSessionMetadata>(page, 'domain:agentEngine', 'select', {
    sessionId,
    kind,
    permissionProfile: kind === 'native' ? 'default' : 'read_only',
  });
}

async function cleanupSmokeSession(page: Page, sessionId: string | null): Promise<void> {
  if (!sessionId || page.isClosed()) return;
  await invokeDomain<null>(page, 'domain:session', 'delete', { sessionId }).catch(() => undefined);
}

async function ensureSmokeSessionFirst(page: Page, sessionId: string, failures: string[]): Promise<void> {
  const sessions = await invokeDomain<SessionLike[]>(page, 'domain:session', 'list', {});
  if (sessions[0]?.id !== sessionId) {
    failures.push(`smoke session was not first in session list: first=${sessions[0]?.id || 'missing'} smoke=${sessionId}`);
  }
}

async function selectSmokeSessionInSidebar(page: Page, session: SessionLike): Promise<void> {
  const title = session.title || session.id;
  const sessionItem = page.locator(`[data-session-id="${session.id}"]`).first();
  if (await sessionItem.isVisible().catch(() => false)) {
    await sessionItem.click({ timeout: 5_000 });
    await page.locator(`[data-session-id="${session.id}"][aria-current="true"]`).first()
      .waitFor({ state: 'visible', timeout: 10_000 });
    return;
  }

  const byLabel = page.getByLabel(`打开会话 ${title}`).first();
  await byLabel.waitFor({ state: 'visible', timeout: 10_000 });
  await byLabel.click({ timeout: 5_000 });
  await page.locator(`[data-session-id="${session.id}"][aria-current="true"]`).first()
    .waitFor({ state: 'visible', timeout: 10_000 });
}

async function openEngineSelector(page: Page): Promise<void> {
  await dismissApiKeySetupIfVisible(page);
  const trigger = page.locator('button[aria-label="切换模型"]').last();
  await trigger.scrollIntoViewIfNeeded().catch(() => undefined);
  await trigger.click({ timeout: 5_000 });
  await page.locator('button[title*="Native"]').first().waitFor({ state: 'visible', timeout: 10_000 });
}

async function readEngineButtons(page: Page): Promise<Array<{ text: string; title: string }>> {
  return page.evaluate(() => Array.from(document.querySelectorAll<HTMLButtonElement>('button[title]'))
    .map((button) => ({
      text: button.innerText.trim(),
      title: button.getAttribute('title') || '',
    }))
    .filter((button) =>
      button.title.includes('Native')
      || button.title.includes('Codex CLI')
      || button.title.includes('Claude Code')
    ));
}

function findEngineButton(buttons: Array<{ text: string; title: string }>, label: string): boolean {
  return buttons.some((button) => button.title.includes(label));
}

async function clickEngine(page: Page, label: 'Native' | 'Codex CLI' | 'Claude Code'): Promise<void> {
  const button = page.locator(`button[title*="${label}"]`).first();
  await button.waitFor({ state: 'visible', timeout: 10_000 });
  if (!await button.isEnabled().catch(() => false)) {
    const title = await button.getAttribute('title').catch(() => '');
    throw new Error(`${label} engine button is disabled. title=${title}`);
  }
  await button.click({ timeout: 5_000 });
}

async function waitForTriggerEngine(page: Page, shortLabel: 'Native' | 'Codex' | 'Claude'): Promise<string> {
  const trigger = page.locator('button[aria-label="切换模型"]').last();
  const start = Date.now();
  let lastTexts: string[] = [];

  while (Date.now() - start < 10_000) {
    lastTexts = await page.evaluate(() => Array.from(
      document.querySelectorAll<HTMLButtonElement>('button[aria-label="切换模型"]'),
    ).map((button) => button.innerText || button.textContent || ''));
    if (lastTexts.some((text) => text.includes(shortLabel))) {
      return trigger.innerText({ timeout: 1_000 });
    }
    await page.waitForTimeout(250);
  }

  throw new Error(`Timed out waiting for model switcher engine ${shortLabel}. Trigger texts=${JSON.stringify(lastTexts)}`);
}

async function waitForSessionEngine(
  page: Page,
  sessionId: string,
  expectedKind: AgentEngineKind,
): Promise<AgentEngineSessionMetadata> {
  const start = Date.now();
  let lastEngine: AgentEngineSessionMetadata | undefined;

  while (Date.now() - start < 10_000) {
    const session = await loadSession(page, sessionId);
    lastEngine = session.engine;
    if (lastEngine?.kind === expectedKind) {
      return lastEngine;
    }
    await page.waitForTimeout(250);
  }

  throw new Error(`Timed out waiting for session engine ${expectedKind}. Last engine=${JSON.stringify(lastEngine)}`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (hasFlag(args, 'help')) {
    usage();
    return;
  }

  await ensureBuild(hasFlag(args, 'skip-build'));

  const fakeBinDir = createFakeExternalEngineBin();
  const appPort = getNumberOption(args, 'port') || await getFreePort();
  const baseUrl = `http://127.0.0.1:${appPort}`;
  const appHost = startAppHost(appPort, fakeBinDir);
  let chromeSession: Awaited<ReturnType<typeof launchSystemChromeSession>> | null = null;
  let page: Page | null = null;
  let smokeSessionId: string | null = null;
  const failures: string[] = [];
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];

  try {
    await waitForHealth(baseUrl, appHost.child, appHost.output);

    chromeSession = await launchSystemChromeSession({
      profilePrefix: 'code-agent-agent-engine-selector-',
      visible: hasFlag(args, 'visible'),
      initialUrl: baseUrl,
    });

    const context = chromeSession.browser.contexts()[0] || await chromeSession.browser.newContext();
    page = context.pages()[0] || await context.newPage();
    page.on('pageerror', (error) => {
      pageErrors.push(error.message);
    });
    page.on('console', (message) => {
      if (message.type() === 'error') {
        consoleErrors.push(message.text());
      }
    });

    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await waitForAppReady(page);

    const smokeSession = await createSmokeSession(page, process.cwd());
    smokeSessionId = smokeSession.id;
    await selectEngineViaDomain(page, smokeSession.id, 'codex_cli');
    await ensureSmokeSessionFirst(page, smokeSession.id, failures);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForAppReady(page);
    await selectSmokeSessionInSidebar(page, smokeSession);
    const initialTrigger = await waitForTriggerEngine(page, 'Codex');
    const initialEngine = await waitForSessionEngine(page, smokeSession.id, 'codex_cli');

    await openEngineSelector(page);
    const engineButtons = await readEngineButtons(page);
    const selector = {
      native: findEngineButton(engineButtons, 'Native'),
      codexCli: findEngineButton(engineButtons, 'Codex CLI'),
      claudeCode: findEngineButton(engineButtons, 'Claude Code'),
    };
    if (!selector.native) failures.push('Engine selector missing Native.');
    if (!selector.codexCli) failures.push('Engine selector missing Codex CLI.');
    if (!selector.claudeCode) failures.push('Engine selector missing Claude Code.');

    await clickEngine(page, 'Native');
    const nativeTrigger = await waitForTriggerEngine(page, 'Native');
    const nativeEngine = await waitForSessionEngine(page, smokeSession.id, 'native');

    await clickEngine(page, 'Codex CLI');
    const codexTrigger = await waitForTriggerEngine(page, 'Codex');
    const codexEngine = await waitForSessionEngine(page, smokeSession.id, 'codex_cli');

    await clickEngine(page, 'Claude Code');
    const claudeTrigger = await waitForTriggerEngine(page, 'Claude');
    const claudeEngine = await waitForSessionEngine(page, smokeSession.id, 'claude_code');

    if (codexEngine.permissionProfile !== 'read_only') {
      failures.push(`Codex CLI permissionProfile mismatch: ${codexEngine.permissionProfile || 'missing'}`);
    }
    if (claudeEngine.permissionProfile !== 'read_only') {
      failures.push(`Claude Code permissionProfile mismatch: ${claudeEngine.permissionProfile || 'missing'}`);
    }
    if (!codexEngine.cwd || !claudeEngine.cwd) {
      failures.push('External engine metadata missing cwd.');
    }

    if (consoleErrors.length > 0) {
      failures.push(`browser console errors: ${consoleErrors.slice(0, 3).join(' | ')}`);
    }
    if (pageErrors.length > 0) {
      failures.push(`browser page errors: ${pageErrors.slice(0, 3).join(' | ')}`);
    }

    const result = {
      ok: failures.length === 0,
      appHost: {
        baseUrl,
        serverRunning: appHost.child.exitCode === null,
      },
      chrome: chromeSession ? {
        provider: chromeSession.provider,
        executable: chromeSession.executable,
        cdpPort: chromeSession.port,
        mode: hasFlag(args, 'visible') ? 'visible' : 'headless',
      } : null,
      fakeExternalCli: {
        used: true,
        versionOnly: true,
      },
      selector,
      engineButtons,
      session: {
        id: smokeSession.id,
        title: smokeSession.title,
        workingDirectory: process.cwd(),
        initialTrigger,
        initialEngine,
        nativeTrigger,
        nativeEngine,
        codexTrigger,
        codexEngine,
        claudeTrigger,
        claudeEngine,
      },
      consoleErrors,
      pageErrors,
      failures,
    };

    await cleanupSmokeSession(page, smokeSession.id);
    smokeSessionId = null;

    if (hasFlag(args, 'json')) {
      printJson(result);
    } else {
      printKeyValue('Agent Engine Selector Smoke Summary', [
        ['baseUrl', result.appHost.baseUrl],
        ['chromeProvider', result.chrome?.provider],
        ['chromeExecutable', result.chrome?.executable],
        ['chromeMode', result.chrome?.mode],
        ['fakeExternalCliVersionOnly', result.fakeExternalCli.versionOnly],
        ['selectorNative', result.selector.native],
        ['selectorCodexCli', result.selector.codexCli],
        ['selectorClaudeCode', result.selector.claudeCode],
        ['initialEngine', result.session.initialEngine.kind],
        ['nativeEngine', result.session.nativeEngine.kind],
        ['codexEngine', result.session.codexEngine.kind],
        ['claudeEngine', result.session.claudeEngine.kind],
        ['codexCwd', result.session.codexEngine.cwd],
        ['claudeCwd', result.session.claudeEngine.cwd],
        ['consoleErrors', consoleErrors.length],
        ['pageErrors', pageErrors.length],
      ]);

      if (failures.length > 0) {
        console.log('\nFailures');
        for (const failure of failures) {
          console.log(`- ${failure}`);
        }
      } else {
        console.log('\nAgent Engine selector smoke passed.');
      }
    }

    if (failures.length > 0) {
      process.exit(1);
    }
  } finally {
    if (page) {
      await cleanupSmokeSession(page, smokeSessionId);
    }
    if (!hasFlag(args, 'keep-browser')) {
      await chromeSession?.browser.close().catch(() => undefined);
      if (chromeSession) {
        await closeSystemChromeSession(chromeSession).catch(() => undefined);
      }
    }
    if (!hasFlag(args, 'keep-server')) {
      await stopProcess(appHost.child);
    }
    rmSync(fakeBinDir, { recursive: true, force: true });
  }
}

main().catch((error) => finishWithError(formatAcceptanceError(error)));
