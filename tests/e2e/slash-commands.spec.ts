// ============================================================================
// /schedule + /loop 渲染器 E2E（真实渲染器 + 真模型）
//
// 验证两条新斜杠命令在真实浏览器里端到端跑通：
//   1. /schedule <自然语言> → cron:generateFromPrompt(LLM) → createJob → 成功 toast
//   2. /loop <prompt>        → loop:start → LoopStatusBar「循环中」控制条 → 点停止 → 条消失
//
// 隔离策略（参考 goal-mode.spec.ts）：spec 自起 webServer + HOME 指向临时目录，
// 配置/会话写入假 HOME，不污染真实 ~/.code-agent。模型用 zhipu/glm-5。
//
// 运行方式（真模型，不进 CI；缺 key 时自动 skip）：
//   npm run build:web && npm run build:renderer
//   npx playwright test --config tests/e2e/playwright.system-chrome.config.ts \
//     tests/e2e/slash-commands.spec.ts
//   key 优先取 CMD_E2E_API_KEY，否则回落真实 ~/.code-agent/.env 的 ZHIPU_API_KEY。
// ============================================================================

import { test, expect, type Page } from '@playwright/test';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { access, mkdir, mkdtemp, readFile, writeFile } from 'fs/promises';
import { constants, createWriteStream, readFileSync } from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { setTimeout as delay } from 'timers/promises';

const SPEC_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SPEC_DIR, '..', '..');
const SCREENSHOT_DIR = path.join(SPEC_DIR, 'screenshots');

const MAIN_PROVIDER = 'xiaomi';
const MAIN_MODEL = 'mimo-v2.5-pro';

async function readFileSafe(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, 'utf-8');
  } catch {
    return '';
  }
}

function readRealEnvValue(realEnv: string, key: string): string | undefined {
  const line = realEnv.split('\n').find((l) => l.trim().startsWith(`${key}=`));
  return line?.slice(line.indexOf('=') + 1).trim();
}

// key：优先 env var，否则回落真实 ~/.code-agent/.env 的 ZHIPU_API_KEY（本地自动跑）。
const realEnvRaw = (() => {
  try {
    // 同步读一次用于 skip 判定
    return readFileSync(path.join(os.homedir(), '.code-agent', '.env'), 'utf-8');
  } catch {
    return '';
  }
})();
const apiKey = process.env.CMD_E2E_API_KEY || readRealEnvValue(realEnvRaw, 'XIAOMI_API_KEY') || '';

interface E2EEnv {
  fakeHome: string;
  dataDir: string;
  workspace: string;
}

type StartedServer = {
  baseUrl: string;
  child: ChildProcessWithoutNullStreams;
  output: () => string;
};

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

  const realEnv = await readFileSafe(path.join(os.homedir(), '.code-agent', '.env'));
  const lines: string[] = [`XIAOMI_API_KEY=${apiKey}`];
  for (const proxyKey of ['HTTPS_PROXY', 'HTTP_PROXY']) {
    const v = readRealEnvValue(realEnv, proxyKey);
    if (v) lines.push(`${proxyKey}=${v}`);
  }
  await writeFile(path.join(configDir, '.env'), lines.join('\n') + '\n', 'utf-8');

  const minimalConfig = {
    models: {
      defaultProvider: MAIN_PROVIDER,
      default: MAIN_PROVIDER,
      providers: { [MAIN_PROVIDER]: { model: MAIN_MODEL, enabled: true } },
      routing: {
        code: { provider: MAIN_PROVIDER, model: MAIN_MODEL },
        fast: { provider: MAIN_PROVIDER, model: MAIN_MODEL },
        chat: { provider: MAIN_PROVIDER, model: MAIN_MODEL },
      },
    },
  };
  await writeFile(path.join(env.dataDir, 'config.json'), JSON.stringify(minimalConfig, null, 2), 'utf-8');
}

async function startServer(env: E2EEnv): Promise<StartedServer> {
  const webServerPath = path.join(REPO_ROOT, 'dist', 'web', 'webServer.cjs');
  try {
    await access(webServerPath, constants.R_OK);
  } catch {
    throw new Error('dist/web/webServer.cjs 不存在 — 先跑 npm run build:web && npm run build:renderer');
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
  child.stdout.on('data', (chunk) => { outputChunks.push(String(chunk)); logStream.write(String(chunk)); });
  child.stderr.on('data', (chunk) => { outputChunks.push(String(chunk)); logStream.write(String(chunk)); });
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
      const response = await fetch(`${server.baseUrl}/api/health`);
      const health = await response.json() as { status?: string };
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

async function openAppWithCleanSession(page: Page, baseUrl: string) {
  const ssePromise = page.waitForResponse(
    (resp) => resp.url().includes('/api/events'),
    { timeout: 20_000 },
  );
  await page.goto(`${baseUrl}/`);
  await expect(page.locator('.h-screen')).toBeVisible({ timeout: 15_000 });
  await ssePromise;

  const newSessionBtn = page.getByRole('button', { name: '新会话' });
  await expect(newSessionBtn).toBeVisible({ timeout: 15_000 });
  await newSessionBtn.click();

  await expect(page.locator('[data-session-id][aria-current="true"]').first()).toBeVisible({ timeout: 10_000 });
  const chatInput = page.locator('[data-chat-input]');
  await expect(chatInput).toBeVisible({ timeout: 10_000 });
  return chatInput;
}

async function submitCommand(page: Page, command: string) {
  const chatInput = page.locator('[data-chat-input]');
  await chatInput.fill(command);
  await chatInput.press('Enter');
}

test.describe.configure({ mode: 'serial' });
test.describe('/schedule + /loop 斜杠命令', () => {
  test.skip(!apiKey, '缺 XIAOMI key（真模型 E2E，不进 CI）');

  let env: E2EEnv;
  let server: StartedServer;

  test.beforeAll(async () => {
    test.setTimeout(180_000);
    const fakeHome = await mkdtemp(path.join(os.tmpdir(), 'slash-cmd-e2e-home-'));
    env = {
      fakeHome,
      dataDir: path.join(fakeHome, 'data'),
      workspace: path.join(fakeHome, 'workspace'),
    };
    await prepareFakeHome(env);
    server = await startServer(env);
    // eslint-disable-next-line no-console
    console.log(`[slash-cmd-e2e] fake HOME: ${env.fakeHome}, server: ${server.baseUrl}`);
  });

  test.afterAll(async () => {
    if (server) await stopServer(server);
  });

  test('/schedule：自然语言 → 创建定时任务 → 成功 toast', async ({ page }) => {
    test.setTimeout(90_000);
    await openAppWithCleanSession(page, server.baseUrl);

    await submitCommand(page, '/schedule 每天早上8点检查一次部署状态并汇报');

    // generateFromPrompt（LLM 出配置）→ createJob → 成功 toast
    const successToast = page.getByText(/已创建定时任务/);
    await expect(successToast).toBeVisible({ timeout: 60_000 });
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'slash-schedule-created.png') });
  });

  test('/loop：启动 → 控制条「循环中」→ 点停止 → 条消失', async ({ page }) => {
    test.setTimeout(90_000);
    await openAppWithCleanSession(page, server.baseUrl);

    // maxTurns 2 限制成本；横条在 loop:start 返回即出现，不依赖模型轮次完成
    await submitCommand(page, '/loop 5m 回复一句“检查中”即可 --max-turns 2');

    const statusBar = page.getByText(/循环中/);
    await expect(statusBar).toBeVisible({ timeout: 15_000 });
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'slash-loop-running.png') });

    // 点控制条上的「停止」→ loop:stop → 状态变 stopped → 控制条消失
    await page.getByRole('button', { name: /停止/ }).first().click();
    await expect(statusBar).toBeHidden({ timeout: 15_000 });
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'slash-loop-stopped.png') });
  });
});
