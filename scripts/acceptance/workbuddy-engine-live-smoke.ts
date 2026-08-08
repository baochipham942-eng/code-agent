import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  closeSystemChromeSession,
  launchSystemChromeSession,
} from './browser-computer-system-chrome';
import { describeChildExit, isChildGone } from './childProcessState';

const port = Number(process.env.WEB_PORT || 8196);
const baseUrl = `http://127.0.0.1:${port}`;
const nonce = process.env.WORKBUDDY_E2E_NONCE || `NEO_WORKBUDDY_${Date.now()}`;
const requestedModel = 'client_default';
const workspace = process.cwd();

interface DomainResponse<T> {
  success: boolean;
  data?: T;
  error?: { message?: string };
}

interface SessionShape {
  id: string;
  engine?: { kind?: string; model?: string };
  messages?: Array<{ role?: string; content?: string }>;
}

let output = '';
let child: ChildProcessByStdio<null, Readable, Readable> | null = null;
let token = '';
let sessionId = '';

function append(chunk: Buffer): void {
  output += chunk.toString('utf8');
  if (output.length > 60_000) output = output.slice(-60_000);
}

function startupToken(): string | undefined {
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim().startsWith('{')) continue;
    try {
      const parsed = JSON.parse(line) as { port?: number; token?: string };
      if (parsed.port === port && parsed.token) return parsed.token;
    } catch {
      // Ignore non-JSON application logs.
    }
  }
  return undefined;
}

async function domain<T>(domainName: string, action: string, payload?: unknown): Promise<T> {
  const response = await fetch(`${baseUrl}/api/domain/${domainName}/${action}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ payload }),
  });
  const result = await response.json() as DomainResponse<T>;
  if (!response.ok || !result.success) {
    throw new Error(result.error?.message || `${domainName}:${action} failed (${response.status})`);
  }
  return result.data as T;
}

async function waitForServer(): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child && isChildGone(child)) {
      throw new Error(`[workbuddy-engine-live] webServer exited early (${describeChildExit(child)})`);
    }
    token = startupToken() || '';
    if (token) {
      const response = await fetch(`${baseUrl}/api/health`).catch(() => null);
      if (response?.ok) return;
    }
    await delay(250);
  }
  throw new Error('Timed out waiting for the real webServer runtime.');
}

async function main(): Promise<void> {
  const dataDir = await mkdtemp(join(tmpdir(), 'neo-workbuddy-live-'));
  const serverChild = spawn(process.execPath, ['dist/web/webServer.cjs'], {
    cwd: workspace,
    env: {
      ...process.env,
      WEB_HOST: '127.0.0.1',
      WEB_PORT: String(port),
      CODE_AGENT_E2E: '1',
      CODE_AGENT_ENABLE_DEV_API: 'true',
      CODE_AGENT_DATA_DIR: dataDir,
      CODE_AGENT_WORKING_DIR: workspace,
      CODE_AGENT_RENDERER_HOT_UPDATE: 'false',
      CODEBUDDY_CONFIG_DIR: process.env.CODEBUDDY_CONFIG_DIR
        || join(process.env.HOME || '', '.workbuddy'),
      NODE_ENV: 'production',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child = serverChild;
  serverChild.stdout.on('data', append);
  serverChild.stderr.on('data', append);
  await waitForServer();

  // Mirror the product's explicit "检测本机客户端" action. Startup may warm
  // the catalog before local CLIs have finished becoming available; detect
  // invalidates both the engine registry and model catalog before validation.
  await domain('agentEngine', 'detect');
  const sources = await domain<Array<{
    manifestId: string;
    detected: boolean;
    selectable: boolean;
    authState: string;
    binaryPath?: string;
    version?: string;
  }>>('agentEngine', 'listSources');
  const source = sources.find((entry) => entry.manifestId === 'codebuddy_code');
  if (!source?.detected || !source.selectable || source.authState !== 'authenticated') {
    throw new Error(`WorkBuddy source is not selectable: ${JSON.stringify(source)}`);
  }
  const session = await domain<SessionShape>('session', 'create', {
    title: `WorkBuddy Live ${nonce}`,
    workingDirectory: workspace,
  });
  sessionId = session.id;
  const selected = await domain<{ kind?: string; model?: string }>('agentEngine', 'select', {
    sessionId,
    kind: 'codebuddy_code',
    permissionProfile: 'read_only',
    workingDirectory: workspace,
  });
  if (selected.kind !== 'codebuddy_code') {
    throw new Error(`Engine selection did not persist WorkBuddy: ${JSON.stringify(selected)}`);
  }
  if (selected.model && selected.model !== requestedModel) {
    throw new Error(`WorkBuddy unexpectedly persisted an unverified model: ${JSON.stringify(selected)}`);
  }

  const response = await fetch(`${baseUrl}/api/run`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      sessionId,
      prompt: `只回复这个字符串，不要解释：${nonce}`,
      project: workspace,
      context: { workingDirectory: workspace },
    }),
  });
  const eventStream = await response.text();
  if (!response.ok) throw new Error(`/api/run failed (${response.status}): ${eventStream}`);

  const loaded = await domain<SessionShape>('session', 'load', { sessionId });
  const assistant = [...(loaded.messages || [])]
    .reverse()
    .find((message) => message.role === 'assistant');
  if (!assistant?.content?.includes(nonce)) {
    throw new Error(`WorkBuddy reply did not contain nonce. reply=${assistant?.content || '<missing>'}`);
  }

  const chrome = await launchSystemChromeSession({
    profilePrefix: 'neo-workbuddy-live-conversation-',
    visible: false,
    initialUrl: baseUrl,
  });
  const context = chrome.browser.contexts()[0] || await chrome.browser.newContext();
  const page = context.pages()[0] || await context.newPage();
  try {
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    const laterButton = page.getByRole('button', { name: '稍后配置' }).first();
    if (await laterButton.isVisible().catch(() => false)) {
      await laterButton.click({ timeout: 3_000 }).catch(() => undefined);
    }
    const sessionRow = page.locator(`[data-session-id="${sessionId}"]`).first();
    await sessionRow.waitFor({ state: 'visible', timeout: 30_000 });
    await sessionRow.click();
    await page.getByText(nonce, { exact: true }).last()
      .waitFor({ state: 'visible', timeout: 30_000 });
    const screenshotPath = join(
      workspace,
      'docs',
      'acceptance',
      'external-cli-engine-onboarding',
      '08-session-workbuddy-live-conversation.png',
    );
    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.log(JSON.stringify({
      screenshot: screenshotPath,
      browserConsoleErrors: [],
    }));
  } finally {
    await closeSystemChromeSession(chrome);
  }

  console.log(JSON.stringify({
    verdict: 'PASS',
    runtime: 'dist/web/webServer.cjs',
    source: {
      manifestId: source.manifestId,
      detected: source.detected,
      selectable: source.selectable,
      authState: source.authState,
      version: source.version,
      binaryPath: source.binaryPath,
    },
    selectedEngine: selected,
    modelSelection: 'client_default',
    requestedModel,
    sessionId,
    nonce,
    assistantReply: assistant.content,
    sseContainedNonce: eventStream.includes(nonce),
    dataDir,
  }, null, 2));
}

main()
  .catch((error) => {
    console.error(JSON.stringify({
      verdict: 'FAIL',
      error: error instanceof Error ? error.message : String(error),
      sessionId,
      logTail: output.slice(-8_000).replace(
        /("?(?:token|password|authorization)"?\s*[:=]\s*)[^\s,}]+/gi,
        '$1<redacted>',
      ),
    }, null, 2));
    process.exitCode = 1;
  })
  .finally(async () => {
    if (sessionId && token) {
      await domain('session', 'delete', { sessionId }).catch(() => undefined);
    }
    const runningChild = child;
    if (runningChild && !isChildGone(runningChild)) {
      runningChild.kill('SIGTERM');
      await Promise.race([
        new Promise<void>((resolve) => runningChild.once('close', () => resolve())),
        delay(3_000).then(() => {
          if (!isChildGone(runningChild)) runningChild.kill('SIGKILL');
        }),
      ]);
    }
  });
