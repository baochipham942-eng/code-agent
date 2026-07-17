// ============================================================================
// Model Strategy Recommendation E2E
// ============================================================================
//
// 目标：用真实 web renderer + Chromium/Chrome 验证会话页模型策略推荐条的点击链路。
// 不提交消息、不请求真实模型，只验证：
//   输入简单任务 → 出现“采用自动”推荐 → 点击 → domain:session.switchModel 写入 adaptive override。
//   注入 external engine 最近失败 → 出现“切回 Native”推荐 → 点击 → domain:agentEngine.select 写入 native engine。
//
// 运行方式：
//   npm run build:web && npm run build:renderer
//   npx playwright test --config tests/e2e/playwright.system-chrome.config.ts \
//     tests/e2e/model-strategy-recommendation.spec.ts
//
// 默认显式使用本机 Playwright 缓存里的 headless shell/CDP；如需优先系统 Chrome/CDP，
// 设置 E2E_SYSTEM_CHROME=1 或 E2E_CHROME_PATH。只有显式设置 E2E_ALLOW_PIPE_FALLBACK=1
// 时才会退回 Playwright pipe launch，避免把 CDP 环境问题伪装成产品断言失败。
// ============================================================================

import { expect, test } from '@playwright/test';
import { chromium, type Browser, type Page } from 'playwright';
import { spawn, type ChildProcessByStdio } from 'child_process';
import type { Readable } from 'stream';
import { constants, createWriteStream } from 'fs';
import { access, mkdir, mkdtemp, readdir, writeFile } from 'fs/promises';
import http from 'http';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { setTimeout as delay } from 'timers/promises';

const SPEC_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SPEC_DIR, '..', '..');
const MAIN_PROVIDER = 'xiaomi';
const MAIN_MODEL = 'mimo-v2.5-pro';
const CHROME_EXECUTABLE = process.env.E2E_CHROME_PATH
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PLAYWRIGHT_CACHE_DIR = path.join(os.homedir(), 'Library/Caches/ms-playwright');
const ALLOW_PIPE_FALLBACK = process.env.E2E_ALLOW_PIPE_FALLBACK === '1';

interface E2EEnv {
  fakeHome: string;
  dataDir: string;
  workspace: string;
}

type StartedServer = {
  baseUrl: string;
  child: ChildProcessByStdio<null, Readable, Readable>;
  output: () => string;
};

type StartedBrowser = {
  browser: Browser;
  child?: ChildProcessByStdio<null, Readable, Readable>;
  endpoint?: string;
  output?: () => string;
};

function formatBrowserStartError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function buildCdpRequiredError(args: {
  label: string;
  failures: Array<[string, unknown]>;
}): Error {
  const details = args.failures
    .map(([name, error]) => `- ${name}: ${formatBrowserStartError(error)}`)
    .join('\n');
  return new Error(`${args.label} requires a browser CDP endpoint, but every CDP launch path failed.
${details}

This is an environment gate, not a model-strategy product assertion. Set E2E_ALLOW_PIPE_FALLBACK=1 only for local debugging when a Playwright pipe launch is acceptable.`);
}

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Failed to allocate a local port')));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

async function prepareFakeHome(env: E2EEnv): Promise<void> {
  const configDir = path.join(env.fakeHome, '.code-agent');
  await mkdir(configDir, { recursive: true });
  await mkdir(env.dataDir, { recursive: true });
  await mkdir(env.workspace, { recursive: true });

  const minimalConfig = {
    models: {
      defaultProvider: MAIN_PROVIDER,
      default: MAIN_PROVIDER,
      providers: {
        [MAIN_PROVIDER]: {
          enabled: true,
          model: MAIN_MODEL,
          billingMode: 'payg',
        },
      },
      routing: {
        chat: { provider: MAIN_PROVIDER, model: MAIN_MODEL },
        code: { provider: MAIN_PROVIDER, model: MAIN_MODEL },
        fast: { provider: MAIN_PROVIDER, model: MAIN_MODEL },
      },
    },
  };
  await writeFile(path.join(env.dataDir, 'config.json'), JSON.stringify(minimalConfig, null, 2), 'utf-8');
}

async function fetchJsonWithTimeout<T>(url: string, timeoutMs: number): Promise<{ response: Response; json: T }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    const json = await response.json() as T;
    return { response, json };
  } finally {
    clearTimeout(timer);
  }
}

async function startServer(env: E2EEnv): Promise<StartedServer> {
  const webServerPath = path.join(REPO_ROOT, 'dist', 'web', 'webServer.cjs');
  try {
    await access(webServerPath, constants.R_OK);
  } catch {
    throw new Error('dist/web/webServer.cjs 不存在，请先跑 npm run build:web && npm run build:renderer');
  }

  const port = await getFreePort();
  const outputChunks: string[] = [];
  const logStream = createWriteStream(path.join(env.fakeHome, 'webserver.log'), { flags: 'a' });
  const child = spawn(process.execPath, [webServerPath], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      HOME: env.fakeHome,
      CODE_AGENT_DATA_DIR: env.dataDir,
      CODE_AGENT_E2E: '1',
      CODE_AGENT_WORKING_DIR: env.workspace,
      WEB_HOST: '127.0.0.1',
      WEB_PORT: String(port),
      AGENT_NEO_BUNDLED_RUNTIME_ROOT: REPO_ROOT,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    outputChunks.push(String(chunk));
    logStream.write(String(chunk));
  });
  child.stderr.on('data', (chunk) => {
    outputChunks.push(String(chunk));
    logStream.write(String(chunk));
  });
  child.on('exit', () => logStream.end());

  const server: StartedServer = {
    baseUrl: `http://127.0.0.1:${port}`,
    child,
    output: () => outputChunks.join('').slice(-200_000),
  };

  const deadline = Date.now() + 90_000;
  let lastError = '';
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`webServer exited early with ${child.exitCode}\n${server.output()}`);
    }
    try {
      const { response, json: health } = await fetchJsonWithTimeout<{ status?: string }>(
        `${server.baseUrl}/api/health`,
        2_000,
      );
      if (response.ok && health.status === 'ok') return server;
      lastError = JSON.stringify(health);
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await delay(250);
  }
  await stopServer(server).catch(() => undefined);
  throw new Error(`Timed out waiting for webServer. Last error: ${lastError}\n${server.output()}`);
}

async function stopServer(server: StartedServer): Promise<void> {
  if (server.child.exitCode !== null) return;
  server.child.kill('SIGTERM');
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (server.child.exitCode !== null) return;
    await delay(100);
  }
  server.child.kill('SIGKILL');
}

async function startBrowserExecutableOverCdp(params: {
  executablePath: string;
  label: string;
  userDataPrefix: string;
}): Promise<StartedBrowser> {
  try {
    await access(params.executablePath, constants.X_OK);
  } catch {
    throw new Error(`${params.label} 不可执行: ${params.executablePath}`);
  }

  const debuggingPort = await getFreePort();
  const userDataDir = await mkdtemp(path.join(os.tmpdir(), params.userDataPrefix));
  const outputChunks: string[] = [];
  const child = spawn(params.executablePath, [
    `--remote-debugging-port=${debuggingPort}`,
    '--remote-debugging-address=127.0.0.1',
    '--remote-allow-origins=*',
    `--user-data-dir=${userDataDir}`,
    '--headless=new',
    '--no-sandbox',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-default-apps',
    '--disable-extensions',
    '--disable-sync',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--hide-scrollbars',
    '--mute-audio',
    'about:blank',
  ], {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => outputChunks.push(String(chunk)));
  child.stderr.on('data', (chunk) => outputChunks.push(String(chunk)));

  const endpoint = `http://127.0.0.1:${debuggingPort}`;
  const started: Omit<StartedBrowser, 'browser'> = {
    child,
    endpoint,
    output: () => outputChunks.join('').slice(-50_000),
  };

  const deadline = Date.now() + 30_000;
  let lastError = '';
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`${params.label} exited early with ${child.exitCode}\n${started.output?.()}`);
    }
    try {
      const { response, json } = await fetchJsonWithTimeout<{ webSocketDebuggerUrl?: string }>(
        `${endpoint}/json/version`,
        1_000,
      );
      if (response.ok && json.webSocketDebuggerUrl) {
        const browser = await chromium.connectOverCDP(endpoint);
        return { ...started, browser };
      }
      lastError = JSON.stringify(json);
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await delay(250);
  }

  await stopChrome(started).catch(() => undefined);
  throw new Error(`Timed out waiting for ${params.label} CDP. Last error: ${lastError}\n${started.output?.()}`);
}

async function startChrome(): Promise<StartedBrowser> {
  const resolveBundledChromiumExecutable = async (): Promise<string> => {
    if (process.env.E2E_BUNDLED_CHROMIUM_PATH) return process.env.E2E_BUNDLED_CHROMIUM_PATH;

    const entries = await readdir(PLAYWRIGHT_CACHE_DIR, { withFileTypes: true }).catch(() => []);
    const chromiumDirs = entries
      .filter((entry) => entry.isDirectory() && /^chromium-\d+$/.test(entry.name))
      .map((entry) => entry.name)
      .sort((a, b) => Number(b.replace('chromium-', '')) - Number(a.replace('chromium-', '')));

    for (const dir of chromiumDirs) {
      const candidate = path.join(
        PLAYWRIGHT_CACHE_DIR,
        dir,
        'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
      );
      try {
        await access(candidate, constants.X_OK);
        return candidate;
      } catch {
        // Try the next cached Chromium revision.
      }
    }

    throw new Error(`No executable Playwright Chromium found under ${PLAYWRIGHT_CACHE_DIR}`);
  };

  const resolveHeadlessShellExecutable = async (): Promise<string> => {
    if (process.env.E2E_HEADLESS_SHELL_PATH) return process.env.E2E_HEADLESS_SHELL_PATH;

    const entries = await readdir(PLAYWRIGHT_CACHE_DIR, { withFileTypes: true }).catch(() => []);
    const shellDirs = entries
      .filter((entry) => entry.isDirectory() && /^chromium_headless_shell-\d+$/.test(entry.name))
      .map((entry) => entry.name)
      .sort((a, b) => (
        Number(b.replace('chromium_headless_shell-', '')) - Number(a.replace('chromium_headless_shell-', ''))
      ));

    for (const dir of shellDirs) {
      const candidate = path.join(
        PLAYWRIGHT_CACHE_DIR,
        dir,
        'chrome-headless-shell-mac-arm64/chrome-headless-shell',
      );
      try {
        await access(candidate, constants.X_OK);
        return candidate;
      } catch {
        // Try the next cached headless shell revision.
      }
    }

    throw new Error(`No executable Playwright headless shell found under ${PLAYWRIGHT_CACHE_DIR}`);
  };

  const startHeadlessShellOverCdp = async (): Promise<StartedBrowser> => {
    const executablePath = await resolveHeadlessShellExecutable();
    return startBrowserExecutableOverCdp({
      executablePath,
      label: 'Playwright headless shell',
      userDataPrefix: 'model-strategy-e2e-headless-shell-',
    });
  };

  const startBundledChromiumOverCdp = async (): Promise<StartedBrowser> => {
    const executablePath = await resolveBundledChromiumExecutable();
    return startBrowserExecutableOverCdp({
      executablePath,
      label: 'Playwright Chromium',
      userDataPrefix: 'model-strategy-e2e-chromium-',
    });
  };

  const launchBundledChromium = async (reason: string): Promise<StartedBrowser> => {
    const executablePath = await resolveBundledChromiumExecutable();
    const browser = await chromium.launch({
      executablePath,
      headless: true,
      timeout: 60_000,
      args: ['--no-sandbox'],
    });
    return {
      browser,
      output: () => reason,
    };
  };

  if (!process.env.E2E_CHROME_PATH && process.env.E2E_SYSTEM_CHROME !== '1') {
    try {
      return await startHeadlessShellOverCdp();
    } catch (shellError) {
      try {
        return await startBundledChromiumOverCdp();
      } catch (cdpError) {
        if (ALLOW_PIPE_FALLBACK) {
          return launchBundledChromium(`Headless shell and bundled Chromium CDP launch failed, using Playwright pipe fallback: ${
            formatBrowserStartError(cdpError)
          } / ${formatBrowserStartError(shellError)}`);
        }
        throw buildCdpRequiredError({
          label: 'Model strategy recommendation e2e',
          failures: [
            ['Playwright headless shell CDP', shellError],
            ['Playwright Chromium CDP', cdpError],
          ],
        });
      }
    }
  }

  if (process.env.E2E_HEADLESS_SHELL_PATH) {
    try {
      return await startHeadlessShellOverCdp();
    } catch (shellError) {
      if (ALLOW_PIPE_FALLBACK) {
        return launchBundledChromium(`Headless shell launch failed, using bundled Chromium fallback: ${
          formatBrowserStartError(shellError)
        }`);
      }
      throw buildCdpRequiredError({
        label: 'Model strategy recommendation e2e',
        failures: [['Configured headless shell CDP', shellError]],
      });
    }
  }

  try {
    return await startBrowserExecutableOverCdp({
      executablePath: CHROME_EXECUTABLE,
      label: 'system Chrome',
      userDataPrefix: 'model-strategy-e2e-chrome-',
    });
  } catch (cdpError) {
    if (!ALLOW_PIPE_FALLBACK) {
      throw buildCdpRequiredError({
        label: 'Model strategy recommendation e2e',
        failures: [['System Chrome CDP', cdpError]],
      });
    }
    try {
      return await launchBundledChromium(`CDP launch failed, using bundled Chromium fallback: ${
        formatBrowserStartError(cdpError)
      }`);
    } catch (bundledError) {
      const launchOptions = process.env.E2E_CHROME_PATH
        ? {
          executablePath: CHROME_EXECUTABLE,
          headless: true,
          timeout: 60_000,
          args: ['--no-sandbox'],
        }
        : {
          channel: 'chrome' as const,
          headless: true,
          timeout: 60_000,
          args: ['--no-sandbox'],
        };
      const browser = await chromium.launch(launchOptions);
      return {
        browser,
        output: () => `CDP and bundled Chromium launch failed, using system Chrome fallback: ${
          formatBrowserStartError(bundledError)
        }`,
      };
    }
  }
}

async function stopChrome(browser: StartedBrowser | Omit<StartedBrowser, 'browser'>): Promise<void> {
  if ('browser' in browser) {
    await browser.browser.close().catch(() => undefined);
  }
  if (!browser.child) return;
  if (browser.child.exitCode !== null) return;
  browser.child.kill('SIGTERM');
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (browser.child.exitCode !== null) return;
    await delay(100);
  }
  browser.child.kill('SIGKILL');
}

async function listSessions(page: Page): Promise<Array<{ id?: unknown }>> {
  return page.evaluate(async () => {
    const api = (window as unknown as {
      domainAPI?: {
        invoke: (
          domain: string,
          action: string,
          payload: unknown,
        ) => Promise<{ success?: boolean; data?: unknown; error?: { message?: string } }>;
      };
    }).domainAPI;
    if (!api) throw new Error('window.domainAPI unavailable');
    const res = await api.invoke('domain:session', 'list', { includeArchived: false });
    if (!res?.success) throw new Error(res?.error?.message || 'session list failed');
    return Array.isArray(res.data) ? res.data as Array<{ id?: unknown }> : [];
  });
}

async function openAppWithInitialSession(page: Page, baseUrl: string): Promise<string> {
  const ssePromise = page.waitForResponse(
    (resp) => resp.url().includes('/api/events'),
    { timeout: 20_000 },
  );
  await page.goto(`${baseUrl}/?e2e=1`);
  await expect(page.locator('.h-screen')).toBeVisible({ timeout: 15_000 });
  await ssePromise;

  await expect(page.locator('[data-chat-input]')).toBeVisible({ timeout: 10_000 });
  await expect.poll(async () => listSessions(page), { timeout: 10_000 }).toHaveLength(1);
  const [session] = await listSessions(page);
  expect(session.id, 'initial session id missing').toEqual(expect.any(String));
  return session.id as string;
}

async function injectExternalEngineFailure(page: Page, sessionId: string): Promise<void> {
  await page.evaluate(({ sessionId, occurredAt }) => {
    const harness = (window as unknown as {
      __modelStrategyE2E?: {
        injectExternalEngineFailure: (sessionId: string, failure: {
          category: 'auth';
          reason: string;
          message: string;
          suggestion: string;
          retryable: boolean;
          occurredAt: number;
          statusCode: number;
          exitCode: number;
          reliability: { authState: 'needs_login' };
        }) => void;
      };
    }).__modelStrategyE2E;
    if (!harness) throw new Error('window.__modelStrategyE2E unavailable');
    harness.injectExternalEngineFailure(sessionId, {
      category: 'auth',
      reason: 'auth_failed',
      message: 'Failed to authenticate',
      suggestion: 'Claude Code 认证失败。请完成 Claude CLI 登录或检查订阅/API 凭据后重试。',
      retryable: false,
      occurredAt,
      statusCode: 401,
      exitCode: 1,
      reliability: { authState: 'needs_login' },
    });
  }, { sessionId, occurredAt: Date.now() - 120_000 });
}

async function getSessionEngine(page: Page, sessionId: string): Promise<unknown> {
  return page.evaluate(({ sessionId }) => {
    const harness = (window as unknown as {
      __modelStrategyE2E?: {
        getSessionEngine: (sessionId: string) => unknown;
      };
    }).__modelStrategyE2E;
    if (!harness) throw new Error('window.__modelStrategyE2E unavailable');
    return harness.getSessionEngine(sessionId);
  }, { sessionId });
}

async function getModelOverride(page: Page, sessionId: string): Promise<unknown> {
  return page.evaluate(async ({ sessionId }) => {
    const api = (window as unknown as {
      domainAPI?: {
        invoke: (
          domain: string,
          action: string,
          payload: unknown,
        ) => Promise<{ success?: boolean; data?: unknown; error?: { message?: string } }>;
      };
    }).domainAPI;
    if (!api) throw new Error('window.domainAPI unavailable');
    const res = await api.invoke('domain:session', 'getModelOverride', { sessionId });
    if (!res?.success) throw new Error(res?.error?.message || 'getModelOverride failed');
    return res.data ?? null;
  }, { sessionId });
}

test.describe.configure({ mode: 'serial' });
test.setTimeout(90_000);

test.describe('Model strategy recommendation browser flow', () => {
  let env: E2EEnv;
  let server: StartedServer;
  let browser: StartedBrowser;

  test.beforeAll(async () => {
    test.setTimeout(120_000);
    const fakeHome = await mkdtemp(path.join(os.tmpdir(), 'model-strategy-e2e-home-'));
    env = {
      fakeHome,
      dataDir: path.join(fakeHome, 'data'),
      workspace: path.join(fakeHome, 'workspace'),
    };
    await prepareFakeHome(env);
    server = await startServer(env);
    browser = await startChrome();
  });

  test.afterAll(async () => {
    if (browser) await stopChrome(browser);
    if (server) await stopServer(server);
  });

  test('adopts auto model strategy from the composer recommendation strip', async () => {
    const context = browser.browser.contexts()[0] ?? await browser.browser.newContext();
    const page = context.pages()[0] ?? await context.newPage();
    const sessionId = await openAppWithInitialSession(page, server.baseUrl);
    const input = page.locator('[data-chat-input]');

    await input.fill('你好');

    const strip = page.getByTestId('model-strategy-recommendation');
    await expect(strip).toBeVisible({ timeout: 10_000 });
    await expect(strip).toContainText('简单任务不必占用重模型');
    await expect(strip).toContainText('任务: 简单问答');
    await expect(strip).toContainText('计费: 按量');

    await strip.getByRole('button', { name: '采用自动' }).click();

    await expect(strip).not.toBeVisible({ timeout: 10_000 });
    await expect.poll(
      () => getModelOverride(page, sessionId),
      { timeout: 10_000 },
    ).toMatchObject({
      provider: MAIN_PROVIDER,
      model: MAIN_MODEL,
      adaptive: true,
    });
  });

  test('switches back to Native from an external engine failure recommendation', async () => {
    const context = browser.browser.contexts()[0] ?? await browser.browser.newContext();
    const page = context.pages()[0] ?? await context.newPage();
    const sessionId = await openAppWithInitialSession(page, server.baseUrl);
    const input = page.locator('[data-chat-input]');

    await injectExternalEngineFailure(page, sessionId);
    await input.fill('帮我修复这个函数的 bug');

    const strip = page.getByTestId('model-strategy-recommendation');
    await expect(strip).toBeVisible({ timeout: 10_000 });
    await expect(strip).toContainText('Claude Code 最近运行失败');
    await expect(strip).toContainText('失败: 认证失败');
    await expect(strip).toContainText('恢复: 需处理');

    await strip.getByRole('button', { name: '切回 Native' }).click();

    await expect(strip).not.toBeVisible({ timeout: 10_000 });
    await expect.poll(
      () => getSessionEngine(page, sessionId),
      { timeout: 10_000 },
    ).toMatchObject({
      kind: 'native',
    });
  });
});
