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
import { spawn, type ChildProcessByStdio } from 'child_process';
import type { Readable } from 'stream';
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
      // 故意【不开】CODE_AGENT_NOTIFICATION_DRY_RUN：dry-run 会在焦点判断前短路 shouldNotify，
      // 测不到后台任务完成通知的 force 绕过焦点门（艾克斯抓到的真实 gap）。
      // 不开 dry-run 时 webServer 的 mock 窗口判定为 focused，普通通知会被跳过，
      // 唯有 loop/定时任务的 force 通知能穿过焦点门并被 record——正是要验证的修复。
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

/** 在页面里通过 window.domainAPI 调一次领域 IPC（与 app 同路径）。 */
async function invokeDomain<T = unknown>(
  page: Page,
  domain: string,
  action: string,
  payload: unknown,
): Promise<T> {
  return page.evaluate(
    async ({ domain, action, payload }) => {
      const api = (window as unknown as {
        domainAPI?: { invoke: (d: string, a: string, p: unknown) => Promise<{ success: boolean; data?: unknown; error?: { message?: string } }> };
      }).domainAPI;
      if (!api) throw new Error('window.domainAPI 不可用');
      const res = await api.invoke(domain, action, payload);
      if (!res?.success) throw new Error(res?.error?.message || `${domain}:${action} failed`);
      return res.data;
    },
    { domain, action, payload },
  ) as Promise<T>;
}

/** 轮询某个领域查询，直到 select() 返回非 null，或超时。 */
async function pollDomain<T>(
  page: Page,
  domain: string,
  action: string,
  payload: unknown,
  select: (data: unknown) => T | null,
  timeoutMs: number,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    last = await invokeDomain(page, domain, action, payload);
    const picked = select(last);
    if (picked !== null && picked !== undefined) return picked;
    await delay(750);
  }
  throw new Error(`pollDomain 超时：${domain}:${action}，最后一次=${JSON.stringify(last)}`);
}

async function currentSessionId(page: Page): Promise<string> {
  const id = await page
    .locator('[data-session-id][aria-current="true"]')
    .first()
    .getAttribute('data-session-id');
  if (!id) throw new Error('拿不到当前 sessionId');
  return id;
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

  // Block 1：loop 后台化——登记进 backgroundTaskLedger + 跑完发完成通知
  test('/loop 后台化：台账登记 kind=loop 任务 + 完成通知', async ({ page }) => {
    test.setTimeout(120_000);
    await openAppWithCleanSession(page, server.baseUrl);

    // max-turns 1：跑满 1 轮即自然完成（completed），触发终态通知
    await submitCommand(page, '/loop 回复一句“检查中”即可 --max-turns 1');

    // 台账里出现 kind=loop 的任务，并跑到终态
    const task = await pollDomain(
      page,
      'domain:backgroundTasks',
      'listTasks',
      { source: 'loop' },
      (data) => {
        const list = Array.isArray(data) ? (data as Record<string, unknown>[]) : [];
        const t = list.find((x) => x.kind === 'loop');
        if (!t) return null;
        const status = String(t.status);
        return status === 'completed' || status === 'failed' || status === 'cancelled' ? t : null;
      },
      90_000,
    );
    expect(task.kind).toBe('loop');
    expect(['completed', 'failed', 'cancelled']).toContain(String(task.status));

    // 自然完成发出了任务完成通知（dry-run 已记录）
    const notif = await pollDomain(
      page,
      'domain:notification',
      'getRecent',
      {},
      (data) => {
        const list = Array.isArray(data) ? (data as Record<string, unknown>[]) : [];
        return list.find((n) => n.type === 'task_complete' && String(n.title).includes('循环')) ?? null;
      },
      20_000,
    );
    expect(notif).toBeTruthy();
    // 成功完成的 loop 标题应是「任务完成 - 循环 · …」（失败态走「任务失败」分支）
    expect(String((notif as Record<string, unknown>).title)).toMatch(/^任务完成 - 循环/);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'slash-loop-backgrounded.png') });
  });

  // Block 2：定时 agent 任务跑完发系统通知（点通知能跳到生成的 session）
  test('/schedule 通知闭环：近未来一次性 agent 任务执行后发完成通知', async ({ page }) => {
    test.setTimeout(120_000);
    await openAppWithCleanSession(page, server.baseUrl);

    const jobName = `E2E定时通知-${Date.now()}`;
    const runAt = new Date(Date.now() + 4_000).toISOString();

    // 直接经 cron 领域建一个 4 秒后跑一次的 agent 任务（绕开 LLM 出时间，专测执行→通知链路）
    await invokeDomain(page, 'domain:cron', 'createJob', {
      name: jobName,
      scheduleType: 'at',
      schedule: { type: 'at', datetime: runAt },
      action: { type: 'agent', agentType: 'general', prompt: '回复一句“定时已执行”即可，不要调用任何工具。' },
      enabled: true,
    });

    // 等执行完成 → notifyAgentExecution 记录完成通知，title 含任务名
    const notif = await pollDomain(
      page,
      'domain:notification',
      'getRecent',
      {},
      (data) => {
        const list = Array.isArray(data) ? (data as Record<string, unknown>[]) : [];
        return list.find((n) => n.type === 'task_complete' && String(n.title).includes(jobName)) ?? null;
      },
      90_000,
    );
    expect(notif).toBeTruthy();
    expect(String((notif as Record<string, unknown>).sessionId)).toBeTruthy();
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'slash-schedule-notified.png') });
  });

  // Block 3：/schedule 不带参数 → 对话式创建卡片 + 模板填空即建
  test('/schedule 空参：弹对话式卡片 → 选模板填空 → 创建成功', async ({ page }) => {
    test.setTimeout(90_000);
    await openAppWithCleanSession(page, server.baseUrl);

    // 不带描述 → 不报错，弹 ScheduleComposerCard
    await submitCommand(page, '/schedule');
    const composer = page.locator('[data-schedule-composer]');
    await expect(composer).toBeVisible({ timeout: 10_000 });
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'slash-schedule-composer.png') });

    // 选「每日简报」模板 → 出现填空字段
    await composer.locator('[data-schedule-template="daily-briefing"]').click();
    const topicField = composer.locator('[data-schedule-field="topic"]');
    await expect(topicField).toBeVisible({ timeout: 5_000 });
    await topicField.fill('汇总昨天的部署与告警');

    // 点「创建定时任务」→ generateFromPrompt + createJob → 成功 toast
    await composer.locator('[data-schedule-create]').click();
    const successToast = page.getByText(/已创建定时任务/);
    await expect(successToast).toBeVisible({ timeout: 60_000 });
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'slash-schedule-template-created.png') });
  });

  // P0 护栏：过去时间的一次性任务必须被拒绝（不能静默"创建成功"却不跑）
  test('/schedule 护栏：过去时间的 at 任务被拒绝', async ({ page }) => {
    test.setTimeout(60_000);
    await openAppWithCleanSession(page, server.baseUrl);

    const past = new Date(Date.now() - 60_000).toISOString();
    let errored = false;
    let message = '';
    try {
      await invokeDomain(page, 'domain:cron', 'createJob', {
        name: `过去任务-${Date.now()}`,
        scheduleType: 'at',
        schedule: { type: 'at', datetime: past },
        action: { type: 'agent', agentType: 'general', prompt: 'x' },
        enabled: true,
      });
    } catch (err) {
      errored = true;
      message = err instanceof Error ? err.message : String(err);
    }
    expect(errored).toBe(true);
    expect(message).toMatch(/过去|将来/);
  });
});
