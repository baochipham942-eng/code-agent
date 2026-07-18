// ============================================================================
// Goal Mode E2E - /goal 渲染器实时点击流验证（真实渲染器 + 真模型）
// ============================================================================
//
// 补齐 docs/designs/goal-mode.md §10 P3 的"渲染器实时点击流"缺口：
// 此前 /goal 只做过 headless REST SSE 实证，渲染器链路（ChatInput 斜杠命令 →
// httpTransport POST /api/run → SSE goal 事件 → GoalStatusBar / GoalNoticeMessage）
// 从未在真实浏览器里端到端跑通过。
//
// 验证流程（两条路径）：
//   1. met 路径：输入 /goal + --verify → 开启卡片 → 状态条（目标进行中）→
//      迭代推进（第 N 轮）→ 完成卡片（目标已完成）→ 文件系统硬证据
//   2. aborted 路径：--verify "false" --max-turns 2 → 中止卡片（目标已中止）
//
// 运行方式（真模型，不进 CI；缺 key 时自动 skip）：
//   npm run build:web && npm run build:renderer
//   GOAL_E2E_API_KEY=<0ki key> npx playwright test \
//     --config tests/e2e/playwright.system-chrome.config.ts tests/e2e/goal-mode.spec.ts
//
// 隔离策略（参考 scripts/acceptance/role-assets-e2e.ts）：
//   spec 自起 webServer + HOME 指向临时目录 → 配置/会话全部写入假 HOME，
//   不污染真实 ~/.code-agent。模型用 zhipu/glm-5（app 的 zhipu 端点即 0ki 代理）。
// ============================================================================

import { test, expect, type Page } from '@playwright/test';
import { spawn, type ChildProcessByStdio } from 'child_process';
import type { Readable } from 'stream';
import { access, mkdir, mkdtemp, readFile, writeFile } from 'fs/promises';
import { constants, createWriteStream } from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { setTimeout as delay } from 'timers/promises';

// ----------------------------------------------------------------------------
// 配置
// ----------------------------------------------------------------------------

// ESM 环境（package.json type:module）没有 __dirname，从 import.meta.url 推导
const SPEC_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SPEC_DIR, '..', '..');
const SCREENSHOT_DIR = path.join(SPEC_DIR, 'screenshots');

const MAIN_PROVIDER = process.env.GOAL_E2E_PROVIDER || 'zhipu';
const MAIN_MODEL = process.env.GOAL_E2E_MODEL || 'glm-5';

/** 等完成/中止卡片的上限（真模型多轮循环 + 闸1 verify，给足余量） */
const GOAL_COMPLETE_TIMEOUT_MS = 360_000;
/** 两条真模型用例之间的冷却（0ki 限流恢复窗口） */
const TRANSIENT_COOLDOWN_MS = 30_000;
/** 瞬时模型错误（限流/服务繁忙）重试前的退避 */
const TRANSIENT_RETRY_BACKOFF_MS = 60_000;

// 真模型 E2E：缺 key 时整组 skip（不进 CI、不阻塞全量 suite）
const apiKey = process.env.GOAL_E2E_API_KEY || '';

// ----------------------------------------------------------------------------
// webServer 自管理（假 HOME 隔离，参考 role-assets-e2e.ts）
// ----------------------------------------------------------------------------

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

async function readFileSafe(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, 'utf-8');
  } catch {
    return '';
  }
}

/** 准备假 HOME：.env（模型 key + 代理）+ config.json（zhipu/glm-5 默认） */
async function prepareFakeHome(env: E2EEnv): Promise<void> {
  const configDir = path.join(env.fakeHome, '.code-agent');
  await mkdir(configDir, { recursive: true });
  await mkdir(env.dataDir, { recursive: true });
  await mkdir(env.workspace, { recursive: true });

  const realEnv = await readFileSafe(path.join(os.homedir(), '.code-agent', '.env'));
  const readRealEnvValue = (key: string): string | undefined => {
    const line = realEnv.split('\n').find((l) => l.trim().startsWith(`${key}=`));
    return line?.slice(line.indexOf('=') + 1).trim();
  };

  const lines: string[] = [`ZHIPU_API_KEY=${apiKey}`];
  // 写回/意图判断等 quick model 走 groq（免费档，请求小）；没有就回落主模型
  const groqKey = readRealEnvValue('GROQ_API_KEY');
  if (groqKey) lines.push(`GROQ_API_KEY=${groqKey}`);
  // 代理（groq 等海外端点用；zhipu/0ki 是国内端点不受影响）
  for (const proxyKey of ['HTTPS_PROXY', 'HTTP_PROXY']) {
    const v = readRealEnvValue(proxyKey);
    if (v) lines.push(`${proxyKey}=${v}`);
  }
  await writeFile(path.join(configDir, '.env'), lines.join('\n') + '\n', 'utf-8');

  const quickRouting = groqKey
    ? { provider: 'groq', model: 'llama-3.3-70b-versatile' }
    : { provider: MAIN_PROVIDER, model: MAIN_MODEL };
  const minimalConfig = {
    models: {
      defaultProvider: MAIN_PROVIDER,
      default: MAIN_PROVIDER,
      providers: {
        [MAIN_PROVIDER]: { model: MAIN_MODEL, enabled: true },
      },
      routing: {
        code: { provider: MAIN_PROVIDER, model: MAIN_MODEL },
        fast: quickRouting,
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
      // E2E=1 跳过 auth/telemetry；不设 LOCAL_AGENT_MODEL → 真模型
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

  // 等 health ready
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

// ----------------------------------------------------------------------------
// 页面操作 helpers（复用 new-session.e2e.spec.ts 已验证的路径）
// ----------------------------------------------------------------------------

/** 打开应用 → 等 SSE 就绪 → 新建会话 → 返回 chat 输入框 */
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

/** 在 ChatInput 输入 /goal 命令并提交 */
async function submitGoalCommand(page: Page, command: string) {
  const chatInput = page.locator('[data-chat-input]');
  // fill 一次性写入完整命令：slash popover 因 filter 无匹配自动隐藏，Enter 落到 textarea 提交
  await chatInput.fill(command);
  await chatInput.press('Enter');
}

// ----------------------------------------------------------------------------
// 测试
// ----------------------------------------------------------------------------

test.describe.configure({ mode: 'serial' });
test.describe('Goal Mode 渲染器实时点击流', () => {
  test.skip(!apiKey, '缺 GOAL_E2E_API_KEY（真模型 E2E，不进 CI）');

  let env: E2EEnv;
  let server: StartedServer;

  test.beforeAll(async () => {
    test.setTimeout(180_000); // webServer 启动（16MB bundle 加载 + 初始化）给足余量
    const fakeHome = await mkdtemp(path.join(os.tmpdir(), 'goal-e2e-home-'));
    env = {
      fakeHome,
      dataDir: path.join(fakeHome, 'data'),
      workspace: path.join(fakeHome, 'workspace'),
    };
    await prepareFakeHome(env);
    server = await startServer(env);
    // eslint-disable-next-line no-console
    console.log(`[goal-e2e] fake HOME: ${env.fakeHome}, server: ${server.baseUrl}`);
  });

  test.afterAll(async () => {
    if (server) await stopServer(server);
  });

  test('met 路径：/goal 输入 → 状态条 → 迭代推进 → 完成卡片 + 文件硬证据', async ({ page }) => {
    test.setTimeout(GOAL_COMPLETE_TIMEOUT_MS + 120_000);

    await openAppWithCleanSession(page, server.baseUrl);

    // goal：让模型在 workspace 创建标记文件；verify 用绝对路径做确定性判据
    const marker = path.join(env.workspace, 'goal-e2e-done.txt');
    const goalText = `用 Bash 工具创建文件 ${marker}，内容只有一行：DONE。创建完成后立即调用 attempt_completion 申请完成`;
    const verifyCmd = `test -f ${marker} && grep -q DONE ${marker}`;
    await submitGoalCommand(page, `/goal ${goalText} --verify "${verifyCmd}" --max-turns 8`);

    // 1) 开启卡片（ChatInput 提交时同步插入）
    const startCard = page.locator('.goal-notice', { hasText: '开启目标' });
    await expect(startCard).toBeVisible({ timeout: 15_000 });

    // 2) 状态条（目标进行中 + 实时计时）
    const statusBar = page.locator('.goal-status-bar');
    await expect(statusBar).toBeVisible({ timeout: 15_000 });
    await expect(statusBar).toContainText('目标进行中');
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'goal-mode-01-started.png') });

    // 3) 迭代推进：goal_iteration SSE 事件 → appStore → 状态条出现"第 N 轮"
    //    （证明 per-turn 事件真的流到了渲染器，而不只是前端乐观状态）
    await expect(statusBar).toContainText(/第 \d+/, { timeout: 180_000 });
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'goal-mode-02-running.png') });

    // 4) 完成卡片（goal_complete{met} SSE 事件 → GoalNoticeMessage）
    const metCard = page.locator('.goal-notice', { hasText: '目标已完成' });
    await expect(metCard).toBeVisible({ timeout: GOAL_COMPLETE_TIMEOUT_MS });

    // 5) 完成后状态条消失（finishGoalRun → status!=running → 不渲染）
    await expect(statusBar).toBeHidden({ timeout: 10_000 });
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'goal-mode-03-met.png') });

    // 6) 文件系统硬证据：闸1 verify 的标记文件真实存在且内容正确
    const markerContent = await readFileSafe(marker);
    expect(markerContent, `闸1 verify 标记文件 ${marker} 应包含 DONE`).toContain('DONE');
  });

  test('aborted 路径：--verify "false" → 闸1 永不通过 → 轮次上限中止卡片', async ({ page }) => {
    // 含限流冷却 + 一次重试的总预算
    test.setTimeout(GOAL_COMPLETE_TIMEOUT_MS * 2 + TRANSIENT_COOLDOWN_MS + TRANSIENT_RETRY_BACKOFF_MS + 120_000);

    // verify 恒为 false → 闸1 永远 fail → 轮次上限后闸3 兜底中止
    const goalText = '回复一句"收到"即可，然后调用 attempt_completion 申请完成';
    const command = `/goal ${goalText} --verify "false" --max-turns 2`;

    // 上一条真模型 run 刚结束，先给 0ki 限流窗口留恢复时间
    await delay(TRANSIENT_COOLDOWN_MS);

    // 瞬时模型错误（0ki 限流"服务繁忙"）会让 run 以"运行失败"为由中止——那不是
    // 被测的闸3 轮次上限路径，退避后重试一次（参考 role-assets-e2e.ts 的瞬时错误处理）
    for (let attempt = 1; attempt <= 2; attempt++) {
      await openAppWithCleanSession(page, server.baseUrl);
      await submitGoalCommand(page, command);

      const startCard = page.locator('.goal-notice', { hasText: '开启目标' });
      await expect(startCard).toBeVisible({ timeout: 15_000 });

      const statusBar = page.locator('.goal-status-bar');
      await expect(statusBar).toBeVisible({ timeout: 15_000 });

      // 中止卡片（goal_complete{aborted} → GoalNoticeMessage amber 样式 + 原因）
      const abortedCard = page.locator('.goal-notice', { hasText: '目标已中止' });
      await expect(abortedCard).toBeVisible({ timeout: GOAL_COMPLETE_TIMEOUT_MS });

      const cardText = await abortedCard.innerText();
      const isTransient = /服务繁忙|稍后重试|rate limit|429|overloaded/i.test(cardText);
      if (isTransient && attempt < 2) {
        // eslint-disable-next-line no-console
        console.log(`[goal-e2e] run 因瞬时模型错误中止，${TRANSIENT_RETRY_BACKOFF_MS / 1000}s 后重试: ${cardText}`);
        await delay(TRANSIENT_RETRY_BACKOFF_MS);
        continue;
      }

      // 闸3 轮次上限中止 + 状态条消失
      await expect(abortedCard).toContainText('轮次上限');
      await expect(statusBar).toBeHidden({ timeout: 10_000 });
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'goal-mode-04-aborted.png') });
      return;
    }
  });
});
