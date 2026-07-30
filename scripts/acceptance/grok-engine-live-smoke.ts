import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  closeSystemChromeSession,
  launchSystemChromeSession,
} from './browser-computer-system-chrome';

const port = Number(process.env.WEB_PORT || 8197);
const baseUrl = `http://127.0.0.1:${port}`;
const nonce = process.env.GROK_E2E_NONCE || `NEO_GROK_${Date.now()}`;
const requestedModel = 'grok-4.5';
const workspace = process.cwd();
const evidenceDir = join(workspace, 'docs', 'acceptance', 'external-cli-engine-onboarding');

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
let child: ChildProcessWithoutNullStreams | null = null;
let token = '';
let sessionId = '';

function append(chunk: Buffer): void {
  output += chunk.toString('utf8');
  if (output.length > 100_000) output = output.slice(-100_000);
}

function startupToken(): string | undefined {
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim().startsWith('{')) continue;
    try {
      const parsed = JSON.parse(line) as { port?: number; token?: string };
      if (parsed.port === port && parsed.token) return parsed.token;
    } catch {
      // Ignore application log lines.
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
    if (child?.exitCode !== null) throw new Error(`webServer exited early: ${child?.exitCode}`);
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
  const dataDir = await mkdtemp(join(tmpdir(), 'neo-grok-live-'));
  await mkdir(evidenceDir, { recursive: true });
  child = spawn(process.execPath, ['dist/web/webServer.cjs'], {
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
      NODE_ENV: 'production',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  await waitForServer();

  await domain('agentEngine', 'detect');
  const sources = await domain<Array<{
    manifestId: string;
    detected: boolean;
    selectable: boolean;
    authState: string;
    binaryPath?: string;
    version?: string;
  }>>('agentEngine', 'listSources');
  const source = sources.find((entry) => entry.manifestId === 'grok_cli');
  if (!source?.detected || !source.selectable || source.authState !== 'authenticated') {
    throw new Error(`Grok Build source is not selectable: ${JSON.stringify(source)}`);
  }

  const catalog = await domain<{
    catalog?: { engines?: Array<{ kind: string; defaultModel: string; models: Array<{ id: string }> }> };
  }>('agentEngine', 'listModels');
  const grokCatalog = catalog.catalog?.engines?.find((entry) => entry.kind === 'grok_cli');
  if (
    grokCatalog?.defaultModel !== requestedModel
    || grokCatalog.models.map((model) => model.id).join(',') !== requestedModel
  ) {
    throw new Error(`Grok model catalog is not the real local catalog: ${JSON.stringify(grokCatalog)}`);
  }

  const session = await domain<SessionShape>('session', 'create', {
    title: `Grok Live ${nonce}`,
    workingDirectory: workspace,
  });
  sessionId = session.id;
  const selected = await domain<{ kind?: string; model?: string }>('agentEngine', 'select', {
    sessionId,
    kind: 'grok_cli',
    model: requestedModel,
    permissionProfile: 'read_only',
    workingDirectory: workspace,
  });
  if (selected.kind !== 'grok_cli' || selected.model !== requestedModel) {
    throw new Error(`Engine/model selection did not persist Grok: ${JSON.stringify(selected)}`);
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
    throw new Error(`Grok reply did not contain nonce. reply=${assistant?.content || '<missing>'}`);
  }

  const screenshotPath = join(evidenceDir, '09-session-grok-live-conversation.png');
  const modelPopupScreenshotPath = join(evidenceDir, '10-session-grok-model-popup.png');
  const chrome = await launchSystemChromeSession({
    profilePrefix: 'neo-grok-live-conversation-',
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
    await page.screenshot({ path: screenshotPath, fullPage: true });
    await page.getByRole('button', { name: '切换模型' }).click();
    await page.locator('[data-external-engine-model-panel]')
      .waitFor({ state: 'visible', timeout: 10_000 });
    await page.locator(`[data-external-model="${requestedModel}"]`)
      .waitFor({ state: 'visible', timeout: 10_000 });
    await page.screenshot({ path: modelPopupScreenshotPath, fullPage: true });
  } finally {
    await closeSystemChromeSession(chrome);
  }

  const proof = {
    verdict: 'PASS',
    runtime: 'dist/web/webServer.cjs',
    source,
    selectedEngine: selected,
    discoveredModels: grokCatalog.models.map((model) => model.id),
    sessionId,
    nonce,
    assistantReply: assistant.content,
    sseContainedNonce: eventStream.includes(nonce),
    screenshot: screenshotPath,
    modelPopupScreenshot: modelPopupScreenshotPath,
    dataDir,
  };
  await writeFile(
    join(evidenceDir, 'grok-live-evidence.json'),
    `${JSON.stringify(proof, null, 2)}\n`,
    'utf8',
  );
  console.log(JSON.stringify(proof, null, 2));
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
    if (child && child.exitCode === null) {
      child.kill('SIGTERM');
      await Promise.race([
        new Promise<void>((resolve) => child?.once('close', () => resolve())),
        delay(3_000).then(() => {
          if (child?.exitCode === null) child.kill('SIGKILL');
        }),
      ]);
    }
  });
