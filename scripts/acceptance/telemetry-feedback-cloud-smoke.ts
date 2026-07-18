import { spawn, type ChildProcessByStdio } from 'child_process';
import type { Readable } from 'node:stream';
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Browser, Page } from 'playwright';
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
  type SystemChromeSession,
} from './browser-computer-system-chrome.ts';

interface SmokeResult {
  ok: boolean;
  baseUrl: string;
  sessionId: string;
  turnId: string;
  marker: string;
  uploadedTrace: unknown;
  uploadedFeedback: unknown;
}

function usage(): void {
  console.log(`Telemetry feedback cloud smoke

Usage:
  npm run acceptance:telemetry-feedback-cloud -- [options]

Options:
  --skip-build    Reuse existing dist/web and dist/renderer artifacts.
  --keep-browser  Keep the Chrome process open after the smoke.
  --keep-server   Keep the app-host server process open after the smoke.
  --port <port>   App-host port. Default: auto.
  --json          Print JSON only.
  --help          Show this help.

What it validates:
  - app-host serves the real renderer
  - a seeded completed turn renders as a real assistant message
  - local telemetry session + turn metadata upload through the real uploader
  - clicking the assistant 👎 button invokes telemetry:submit-feedback
  - local telemetry feedback is uploaded through the real uploader
  - Supabase RLS/admin read can see telemetry_sessions, telemetry_turns, and telemetry_feedback

What it avoids:
  - no external model call
  - no production-only route
  - no service-role key`);
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

function prepareTempDataDir(): string {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-neo-telemetry-feedback-'));
  const sourceDir = `${process.env.HOME}/.code-agent`;
  for (const fileName of ['.env', '.secure-key', 'secure-storage.json']) {
    const source = join(sourceDir, fileName);
    if (existsSync(source)) {
      copyFileSync(source, join(dataDir, fileName));
    }
  }
  return dataDir;
}

function startAppHost(port: number, dataDir: string): { child: ChildProcessByStdio<null, Readable, Readable>; output: () => string } {
  let logs = '';
  const child = spawn('node', ['dist/web/webServer.cjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      WEB_HOST: '127.0.0.1',
      WEB_PORT: String(port),
      CODE_AGENT_DATA_DIR: dataDir,
      CODE_AGENT_ENABLE_DEV_API: 'true',
      NODE_ENV: 'development',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const append = (chunk: Buffer) => {
    logs += chunk.toString();
    if (logs.length > 30_000) {
      logs = logs.slice(-30_000);
    }
  };
  child.stdout.on('data', append);
  child.stderr.on('data', append);

  return { child, output: () => logs };
}

async function stopProcess(child: ChildProcessByStdio<null, Readable, Readable>): Promise<void> {
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

async function waitForHealth(
  baseUrl: string,
  server: ChildProcessByStdio<null, Readable, Readable>,
  output: () => string,
): Promise<void> {
  const start = Date.now();
  let last = '';

  while (Date.now() - start < 45_000) {
    if (server.exitCode !== null) {
      throw new Error(`app-host exited early with code ${server.exitCode}\n${output()}`);
    }

    try {
      const response = await fetch(`${baseUrl}/api/health`);
      last = `${response.status} ${await response.text()}`;
      if (response.ok) return;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`Timed out waiting for app-host health at ${baseUrl}/api/health
Last: ${last}
${output()}`);
}

async function getAuthToken(page: Page): Promise<string> {
  const token = await page.evaluate(() =>
    (window as unknown as { __CODE_AGENT_TOKEN__?: string }).__CODE_AGENT_TOKEN__,
  );
  if (!token) throw new Error('window.__CODE_AGENT_TOKEN__ missing.');
  return token;
}

function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

async function postJson<T>(baseUrl: string, path: string, token: string, body: unknown): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${path} failed: ${response.status} ${text}`);
  }
  return JSON.parse(text) as T;
}

async function getJson<T>(baseUrl: string, path: string, token: string): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${path} failed: ${response.status} ${text}`);
  }
  return JSON.parse(text) as T;
}

async function createCleanSession(page: Page): Promise<string> {
  const newSessionBtn = page.locator('button', { hasText: '新会话' }).first();
  await newSessionBtn.waitFor({ state: 'visible', timeout: 60_000 });
  await newSessionBtn.click();

  const activeSession = page.locator('[data-session-id][aria-current="true"]').first();
  await activeSession.waitFor({ state: 'visible', timeout: 15_000 });
  const sessionId = await activeSession.getAttribute('data-session-id');
  if (!sessionId) throw new Error('active session id missing after creating a clean session.');
  await page.locator('[data-chat-input]').waitFor({ state: 'visible', timeout: 15_000 });
  return sessionId;
}

async function openSession(page: Page, sessionId: string): Promise<void> {
  const sessionItem = page.locator(`[data-session-id="${sessionId}"]`).first();
  await sessionItem.waitFor({ state: 'visible', timeout: 20_000 });
  const isCurrent = await sessionItem.evaluate((element) => element.getAttribute('aria-current') === 'true');
  if (!isCurrent) {
    await sessionItem.click();
  }
  await page.locator(`[data-session-id="${sessionId}"][aria-current="true"]`).first()
    .waitFor({ state: 'visible', timeout: 15_000 });
  await page.locator('[data-chat-input]').waitFor({ state: 'visible', timeout: 15_000 });
}

async function waitForCloudFeedback(
  baseUrl: string,
  token: string,
  sessionId: string,
  turnId: string,
  marker: string,
): Promise<unknown> {
  let last: unknown = null;
  const query = new URLSearchParams({ sessionId, turnId }).toString();

  for (let attempt = 0; attempt < 30; attempt += 1) {
    await postJson(baseUrl, '/api/dev/telemetry/upload', token, {});
    const result = await getJson<{ found: boolean; feedback?: Record<string, unknown> }>(
      baseUrl,
      `/api/dev/telemetry/cloud-feedback?${query}`,
      token,
    );
    last = result;

    const feedback = result.feedback;
    const fullContent = feedback?.full_content;
    const serializedContent = JSON.stringify(fullContent ?? {});
    if (result.found && feedback?.rating === -1 && serializedContent.includes(marker)) {
      return feedback;
    }

    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  throw new Error(`Timed out waiting for cloud telemetry_feedback. Last result: ${JSON.stringify(last)}`);
}

async function waitForCloudTrace(
  baseUrl: string,
  token: string,
  sessionId: string,
  turnId: string,
  marker: string,
): Promise<unknown> {
  let last: unknown = null;
  const query = new URLSearchParams({ sessionId, turnId }).toString();

  for (let attempt = 0; attempt < 30; attempt += 1) {
    await postJson(baseUrl, '/api/dev/telemetry/upload', token, {});
    const result = await getJson<{
      foundSession: boolean;
      foundTurn: boolean;
      session?: Record<string, unknown>;
      turn?: Record<string, unknown>;
    }>(
      baseUrl,
      `/api/dev/telemetry/cloud-trace?${query}`,
      token,
    );
    last = result;

    const serializedTurnPayload = JSON.stringify(result.turn?.payload ?? {});
    if (
      result.foundSession
      && result.foundTurn
      && result.session?.status === 'completed'
      && result.turn?.session_id === sessionId
      && result.turn?.id === turnId
      && !serializedTurnPayload.includes(marker)
    ) {
      return {
        session: result.session,
        turn: result.turn,
        payloadOmitsAssistantContent: true,
      };
    }

    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  throw new Error(`Timed out waiting for cloud telemetry session/turn. Last result: ${JSON.stringify(last)}`);
}

async function readRenderedMessageDebug(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(() => {
    const activeSession = document.querySelector('[data-session-id][aria-current="true"]');
    const assistantMessages = Array.from(document.querySelectorAll('[aria-label="助手消息"]'))
      .map((item) => item.textContent?.trim() || '')
      .filter(Boolean);
    return {
      activeSessionId: activeSession?.getAttribute('data-session-id') || null,
      assistantMessages,
      bodyTextTail: (document.body.textContent || '').slice(-2000),
      streamingPerf: (window as unknown as {
        __CODE_AGENT_STREAMING_PERF__?: { snapshot: () => unknown };
      }).__CODE_AGENT_STREAMING_PERF__?.snapshot?.() || null,
    };
  });
}

async function runSmoke(options: {
  skipBuild: boolean;
  keepBrowser: boolean;
  keepServer: boolean;
  port?: number;
}): Promise<SmokeResult> {
  await ensureBuild(options.skipBuild);

  const port = options.port ?? await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const dataDir = prepareTempDataDir();
  const server = startAppHost(port, dataDir);
  let chromeSession: SystemChromeSession | null = null;

  try {
    await waitForHealth(baseUrl, server.child, server.output);
    chromeSession = await launchSystemChromeSession({
      profilePrefix: 'agent-neo-telemetry-feedback-chrome-',
      initialUrl: baseUrl,
      timeoutMs: 15_000,
    });

    const browser: Browser = chromeSession.browser;
    const page = await browser.newPage();
    const sseReady = page.waitForResponse(
      (response) => response.url().includes('/api/events'),
      { timeout: 20_000 },
    ).catch(() => null);
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await page.locator('body').waitFor({ state: 'visible', timeout: 20_000 });
    await sseReady;

    const token = await getAuthToken(page);
    const sessionId = await createCleanSession(page);
    const turnId = `telemetry-feedback-smoke-${Date.now()}`;
    const marker = `TELEMETRY_FEEDBACK_CLOUD_${Date.now()}`;
    const assistantResponse = `Acceptance feedback response ${marker}`;

    await postJson(baseUrl, '/api/dev/telemetry/seed-turn', token, {
      sessionId,
      turnId,
      title: 'Telemetry feedback cloud smoke',
      userPrompt: 'Generate a short acceptance smoke response.',
      assistantResponse,
      modelProvider: 'acceptance',
      modelName: 'telemetry-feedback-cloud-smoke',
      workingDirectory: process.cwd(),
    });

    const uploadedTrace = await waitForCloudTrace(baseUrl, token, sessionId, turnId, marker);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('body').waitFor({ state: 'visible', timeout: 20_000 });
    await openSession(page, sessionId);

    const message = page.locator('[aria-label="助手消息"]').filter({ hasText: marker }).first();
    try {
      await message.waitFor({ state: 'visible', timeout: 20_000 });
    } catch (error) {
      const debug = await readRenderedMessageDebug(page);
      throw new Error(
        `Timed out waiting for rendered assistant message. Debug: ${JSON.stringify(debug)}\n${formatAcceptanceError(error)}`,
        { cause: error },
      );
    }
    await message.hover();
    const negativeButton = page.getByRole('button', { name: '标记有问题' }).first();
    await negativeButton.waitFor({ state: 'visible', timeout: 10_000 });
    await negativeButton.click();
    await page.waitForFunction(() => {
      const button = document.querySelector('button[aria-label="标记有问题"]');
      return button?.getAttribute('aria-pressed') === 'true';
    }, undefined, { timeout: 10_000 });

    const uploadedFeedback = await waitForCloudFeedback(baseUrl, token, sessionId, turnId, marker);
    return { ok: true, baseUrl, sessionId, turnId, marker, uploadedTrace, uploadedFeedback };
  } finally {
    if (chromeSession && !options.keepBrowser) {
      await closeSystemChromeSession(chromeSession).catch(() => undefined);
    }
    if (!options.keepServer) {
      await stopProcess(server.child).catch(() => undefined);
      rmSync(dataDir, { recursive: true, force: true });
    }
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (hasFlag(args, 'help')) {
    usage();
    return;
  }

  const jsonOnly = hasFlag(args, 'json');
  const result = await runSmoke({
    skipBuild: hasFlag(args, 'skip-build'),
    keepBrowser: hasFlag(args, 'keep-browser'),
    keepServer: hasFlag(args, 'keep-server'),
    port: getNumberOption(args, 'port'),
  });

  if (jsonOnly) {
    printJson(result);
    return;
  }

  printKeyValue('Telemetry feedback cloud smoke', [
    ['ok', result.ok],
    ['baseUrl', result.baseUrl],
    ['sessionId', result.sessionId],
    ['turnId', result.turnId],
    ['marker', result.marker],
    ['trace', JSON.stringify(result.uploadedTrace)],
  ]);
}

main().catch((error) => finishWithError(formatAcceptanceError(error)));
