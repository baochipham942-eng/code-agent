import { createHash } from 'crypto';
import { execFileSync, spawn, type ChildProcessByStdio } from 'child_process';
import type { Readable } from 'node:stream';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { basename, join, relative, resolve } from 'path';
import type { Locator, Page } from 'playwright';
import sharp from 'sharp';
import {
  finishWithError,
  getNumberOption,
  getStringOption,
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
  type SystemChromeSession,
} from './browser-computer-system-chrome.ts';
import {
  CONVERSATION_EXECUTION_CANARY,
} from './fixtures/surface-execution-conversation.ts';
import {
  surfaceAcceptanceCampaignProofFields,
  surfaceAcceptanceSourceFingerprint,
  type SurfaceAcceptanceCampaignProofFieldsV1,
} from './surface-execution-proof.ts';

const DEFAULT_OUTPUT_DIR = 'docs/acceptance/surface-execution/conversation-current';
const GENERATED_ARTIFACT_NAMES = [
  'business-evidence.png',
  'conversation-debug.png',
  'conversation-completed.png',
  'conversation-evidence-card.png',
  'conversation-folded-evidence.png',
  'conversation-header-timeline.png',
  'conversation-outputs-evidence-sources.png',
  'conversation-paused.png',
  'conversation-stopping.png',
  'conversation-takeover.png',
  'proof.json',
  'run.log',
  'subscription-diagnostic.json',
  'travel-site-final.html',
] as const;
const SOURCE_FILES = [
  'package.json',
  'scripts/acceptance/surface-execution-conversation-smoke.ts',
  'scripts/acceptance/surface-execution-proof.ts',
  'scripts/acceptance/fixtures/surface-execution-conversation.ts',
  'src/renderer/App.tsx',
  'src/renderer/components/ChatView.tsx',
  'src/renderer/components/features/chat/TurnCard.tsx',
  'src/renderer/components/features/surfaceExecution/SurfaceControls.tsx',
  'src/renderer/components/features/surfaceExecution/SurfaceEvidenceCard.tsx',
  'src/renderer/components/features/surfaceExecution/SurfaceExecutionCard.tsx',
  'src/renderer/components/features/surfaceExecution/SurfaceExecutionChatPanel.tsx',
  'src/renderer/components/features/surfaceExecution/SurfaceExecutionConversationPanel.tsx',
  'src/renderer/components/features/surfaceExecution/SurfaceInterventionCards.tsx',
  'src/renderer/components/features/surfaceExecution/SurfacePermissionCard.tsx',
  'src/renderer/components/features/surfaceExecution/SurfaceOutputEntry.tsx',
  'src/renderer/components/features/surfaceExecution/SurfaceResourceSections.tsx',
  'src/renderer/components/features/surfaceExecution/SurfaceSemanticTimeline.tsx',
  'src/renderer/components/features/surfaceExecution/SurfaceSessionHeader.tsx',
  'src/renderer/hooks/agent/effects/useSurfaceExecutionEffects.ts',
  'src/renderer/hooks/agent/useAgentEffects.ts',
  'src/renderer/hooks/useSurfaceExecutionConversation.ts',
  'src/renderer/hooks/useSurfaceExecutionPip.ts',
  'src/renderer/i18n/surfaceExecution.ts',
  'src/renderer/index.tsx',
  'src/renderer/services/surfaceExecutionClient.ts',
  'src/renderer/services/surfaceExecutionController.ts',
  'src/renderer/stores/surfaceExecutionStore.ts',
  'src/renderer/utils/surfaceExecutionProjection.ts',
  'src/host/services/surfaceExecution/SurfaceFrameRegistry.ts',
  'src/host/services/surfaceExecution/SurfaceOutputRegistry.ts',
  'src/shared/contract/surfaceExecution.ts',
  'src/shared/utils/surfaceExecutionRedaction.ts',
] as const;

interface AcceptanceAssertion {
  id: string;
  passed: boolean;
  expected: string;
  actual: string;
}

interface ScreenshotEvidence {
  file: string;
  sha256: string;
  bytes: number;
  width: number;
  height: number;
}

interface PipCommandRecord {
  command: string;
  state?: string;
  controls?: string[];
  dataUrlLength?: number;
}

interface ServedRendererFingerprint {
  script: string;
  sha256: string;
  bytes: number;
  localSha256: string;
  localBytes: number;
}

interface RuntimeSubscriptionDiagnostics {
  subscriptions?: Array<{ id: number; channel: string; at: number }>;
  deliveries?: Array<{
    id: number;
    channel: string;
    eventType?: string;
    sessionId?: string;
    dataConversationId?: string;
    at: number;
  }>;
  sse?: Array<{
    kind: string;
    url?: string;
    channel?: string;
    eventType?: string;
    sessionId?: string;
    dataConversationId?: string;
    at: number;
  }>;
  domainInvocations?: Array<{
    domain: string;
    action: string;
    conversationId?: string;
    surfaceSessionId?: string;
    controlAction?: string;
    at: number;
  }>;
}

interface SurfaceConversationSeedResult {
  ok: true;
  runId: string;
  surfaceSessionId: string;
  eventCount: number;
  writable: true;
  grantState: 'active';
  outputCount: number;
}

type SurfaceEffectDiagnostics = Record<string, unknown> | null;

function usage(): void {
  console.log(`Surface Execution Conversation app-host acceptance

Usage:
  npm run acceptance:surface-execution-conversation -- [options]

Options:
  --skip-build       Reuse existing dist/web and dist/renderer artifacts.
  --visible          Launch System Chrome in visible mode.
  --port <port>      App-host port. Default: auto.
  --out-dir <path>   Canonical evidence directory. Default: ${DEFAULT_OUTPUT_DIR}.
  --json             Print the final proof JSON.
  --help             Show this help.

What it validates:
  - fresh web/renderer build served by the real app-host
  - actual System Chrome renders Conversation Execution production components
  - Session Header, semantic timeline, Permission, Recovery and Takeover cards
  - screenshot Evidence captured/analyzed/verified axes and real PNG bytes
  - Outputs/Evidence/Sources remain visible beside a folded completed turn
  - Pause/Resume/Takeover/Stop request and state transitions
  - PiP frame and controls consume the same live Surface Session state
  - Surface redaction canary is absent from DOM, screenshots, log and proof`);
}

function npmCommand(): string {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function sanitize(value: string): string {
  return value
    .replaceAll(CONVERSATION_EXECUTION_CANARY, '[redacted-canary]')
    .replace(/(?:Bearer\s+)[^\s]+/gi, '$1[redacted]');
}

function git(...args: string[]): string {
  return execFileSync('git', args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  }).trim();
}

function runCommand(command: string, args: string[], label: string, log: (line: string) => void): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    log(`COMMAND ${command} ${args.join(' ')}`);
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (chunk: Buffer) => process.stdout.write(chunk));
    child.stderr.on('data', (chunk: Buffer) => process.stderr.write(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      log(`RESULT ${label} exit=${code ?? 1}`);
      if (code === 0) resolvePromise();
      else reject(new Error(`${label} failed with exit code ${code ?? 1}`));
    });
  });
}

async function ensureBuild(skipBuild: boolean, log: (line: string) => void): Promise<void> {
  if (skipBuild) {
    if (!existsSync('dist/web/webServer.cjs') || !existsSync('dist/renderer/index.html')) {
      throw new Error('Fresh app-host artifacts are missing; run without --skip-build.');
    }
    log('BUILD reused by explicit --skip-build');
    return;
  }
  await runCommand(npmCommand(), ['run', 'build:web'], 'build:web', log);
  await runCommand(npmCommand(), ['run', 'build:renderer'], 'build:renderer', log);
}

function startAppHost(
  port: number,
  dataDir: string,
): { child: ChildProcessByStdio<null, Readable, Readable>; output: () => string } {
  let logs = '';
  const child = spawn('node', ['dist/web/webServer.cjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      WEB_HOST: '127.0.0.1',
      WEB_PORT: String(port),
      CODE_AGENT_DATA_DIR: dataDir,
      CODE_AGENT_ENABLE_DEV_API: 'true',
      CODE_AGENT_E2E: '1',
      CODE_AGENT_RENDERER_HOT_UPDATE: 'false',
      CODE_AGENT_DISABLE_RENDERER_HOT_UPDATE: '1',
      NODE_ENV: 'development',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const append = (chunk: Buffer) => {
    logs += chunk.toString();
    if (logs.length > 30_000) logs = logs.slice(-30_000);
  };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  return { child, output: () => logs };
}

async function stopProcess(child: ChildProcessByStdio<null, Readable, Readable>): Promise<void> {
  if (child.killed || child.exitCode !== null) return;
  await new Promise<void>((resolvePromise) => {
    const timer = setTimeout(() => {
      if (child.exitCode === null) child.kill('SIGKILL');
      resolvePromise();
    }, 2_000);
    child.once('close', () => {
      clearTimeout(timer);
      resolvePromise();
    });
    child.kill('SIGTERM');
  });
}

async function waitForHealth(
  baseUrl: string,
  server: ChildProcessByStdio<null, Readable, Readable>,
  output: () => string,
): Promise<{ status: number; body: string }> {
  const startedAt = Date.now();
  let lastStatus = 0;
  let lastBody = '';
  while (Date.now() - startedAt < 30_000) {
    if (server.exitCode !== null) {
      throw new Error(`app-host exited early with code ${server.exitCode}\n${sanitize(output())}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      lastStatus = response.status;
      lastBody = await response.text();
      if (response.ok) return { status: response.status, body: lastBody };
    } catch {
      // Keep polling until timeout.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
  }
  throw new Error(`app-host health timed out; status=${lastStatus}; body=${sanitize(lastBody)}\n${sanitize(output())}`);
}

async function waitForAppReady(page: Page): Promise<void> {
  await page.locator('[data-chat-input]').waitFor({ state: 'visible', timeout: 60_000 });
  await page.waitForFunction(() => {
    const input = document.querySelector('[data-chat-input]') as HTMLTextAreaElement | null;
    return Boolean(input && !input.disabled && !input.readOnly);
  }, undefined, { timeout: 30_000 });
}

async function fingerprintServedRenderer(
  page: Page,
  baseUrl: string,
): Promise<ServedRendererFingerprint> {
  const script = await page.locator('script[type="module"][src]').first().getAttribute('src');
  if (!script) throw new Error('Served renderer module script is unavailable');
  const servedResponse = await fetch(new URL(script, baseUrl));
  if (!servedResponse.ok) {
    throw new Error(`Served renderer script returned HTTP ${servedResponse.status}`);
  }
  const served = Buffer.from(await servedResponse.arrayBuffer());
  const relativeScript = script.replace(/^\.\//, '').replace(/^\//, '');
  const localPath = resolve('dist/renderer', relativeScript);
  if (!existsSync(localPath)) {
    throw new Error(`Served renderer script is absent from local dist/renderer: ${relativeScript}`);
  }
  const local = readFileSync(localPath);
  return {
    script: relativeScript,
    sha256: sha256(served),
    bytes: served.length,
    localSha256: sha256(local),
    localBytes: local.length,
  };
}

async function waitForCondition(
  predicate: () => boolean | Promise<boolean>,
  description: string,
  timeoutMs = 15_000,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function dismissIsolatedFolderTrustDialog(page: Page): Promise<boolean> {
  const blockButtons = page.getByRole('button', { name: '阻止项目配置', exact: true });
  const visible = await blockButtons.last().waitFor({ state: 'visible', timeout: 2_500 })
    .then(() => true)
    .catch(() => false);
  if (!visible) return false;
  await blockButtons.last().click();
  await waitForCondition(
    async () => !(await blockButtons.last().isVisible().catch(() => false)),
    'isolated folder-trust dialog dismissal',
    10_000,
  );
  return true;
}

async function createCleanSession(page: Page): Promise<{
  sessionId: string;
  previousSessionId: string | null;
  title: string;
  guardedUntouchedDraft: true;
}> {
  const title = `Conversation UX acceptance ${Date.now()}`;
  const transition = await page.evaluate(async (uniqueTitle) => {
    const hook = (window as unknown as {
      __modelStrategyE2E?: {
        createSession?: (title?: string) => Promise<string | null>;
        getCurrentSessionId?: () => string | null;
        injectMessages?: (messages: unknown[]) => void;
      };
    }).__modelStrategyE2E;
    if (!hook?.createSession || !hook.injectMessages) throw new Error('Missing ?e2e=1 session hook');
    const previousSessionId = hook.getCurrentSessionId?.() || null;
    hook.injectMessages([{
      id: `conversation-session-transition-${Date.now()}`,
      role: 'user',
      content: 'Prepare a uniquely named Conversation acceptance session.',
      timestamp: Date.now(),
    }]);
    const created = await hook.createSession(uniqueTitle);
    return {
      previousSessionId,
      sessionId: created || hook.getCurrentSessionId?.() || null,
      currentSessionId: hook.getCurrentSessionId?.() || null,
    };
  }, title);
  const sessionId = transition.sessionId;
  if (!sessionId) throw new Error('Clean Conversation session id is unavailable');
  if (sessionId === transition.previousSessionId || transition.currentSessionId !== sessionId) {
    throw new Error(
      `Unique Conversation title did not force a session transition: `
      + `${transition.previousSessionId || 'none'} -> ${sessionId} -> ${transition.currentSessionId || 'none'}`,
    );
  }
  await page.waitForFunction((expected) => {
    const hook = (window as unknown as {
      __modelStrategyE2E?: { getCurrentSessionId?: () => string | null };
    }).__modelStrategyE2E;
    return hook?.getCurrentSessionId?.() === expected;
  }, sessionId, { timeout: 15_000 });
  return {
    sessionId,
    previousSessionId: transition.previousSessionId,
    title,
    guardedUntouchedDraft: true,
  };
}

async function readSurfaceEffectDiagnostics(page: Page): Promise<SurfaceEffectDiagnostics> {
  return page.evaluate(() => {
    const hook = (window as unknown as {
      __modelStrategyE2E?: { getSurfaceExecutionDiagnostics?: () => SurfaceEffectDiagnostics };
    }).__modelStrategyE2E;
    return hook?.getSurfaceExecutionDiagnostics?.() ?? null;
  });
}

function acceptanceMessages(now: number): unknown[] {
  const toolNames = ['Write', 'browser_navigate', 'browser_action', 'browser_action', 'browser_action'];
  const toolCalls = toolNames.map((name, index) => ({
    id: `conversation-tool-${index + 1}`,
    name,
    arguments: index === 0
      ? { path: 'travel-site-final.html', content: '[acceptance fixture]' }
      : { action: ['open', 'screenshot', 'adjust', 'verify'][index - 1] },
    result: {
      toolCallId: `conversation-tool-${index + 1}`,
      success: true,
      output: `conversation step ${index + 1} completed`,
      duration: 10 + index,
    },
  }));
  return [
    {
      id: 'conversation-user-generation',
      role: 'user',
      content: '生成旅行网站，浏览器打开后读取截图，判断并调整，复验后交付。',
      timestamp: now - 10_000,
    },
    {
      id: 'conversation-turn-generation',
      role: 'assistant',
      content: '旅行网站已生成并完成截图复验，HTML 与 PNG 已进入交付区。',
      timestamp: now - 9_000,
      toolCalls,
    },
    {
      id: 'conversation-user-confirm',
      role: 'user',
      content: '确认关键证据和产物在折叠后仍可回看。',
      timestamp: now - 2_000,
    },
    {
      id: 'conversation-turn-confirm',
      role: 'assistant',
      content: '已确认，关键证据、产物和只读来源保持可见。',
      timestamp: now - 1_000,
    },
  ];
}

async function injectConversationMessages(page: Page, now: number): Promise<void> {
  await page.evaluate((messages) => {
    const hook = (window as unknown as {
      __modelStrategyE2E?: { injectMessages?: (next: unknown[]) => void };
    }).__modelStrategyE2E;
    if (!hook?.injectMessages) throw new Error('Missing ?e2e=1 message injection hook');
    hook.injectMessages(messages);
  }, acceptanceMessages(now));
  await page.getByText('已确认，关键证据、产物和只读来源保持可见。').waitFor({
    state: 'visible',
    timeout: 15_000,
  });
}

function parsePng(buffer: Buffer): { width: number; height: number } {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(signature)) {
    throw new Error('Screenshot evidence is not a valid PNG byte stream');
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function screenshotEvidence(root: string, path: string): ScreenshotEvidence {
  const buffer = readFileSync(path);
  const dimensions = parsePng(buffer);
  return {
    file: relative(root, path),
    sha256: sha256(buffer),
    bytes: buffer.length,
    ...dimensions,
  };
}

async function captureHeaderTimelineEvidence(
  session: Locator,
  screenshotPath: string,
): Promise<void> {
  const header = session.locator('[data-testid="surface-session-header"]');
  const timeline = session.locator('[data-testid="surface-semantic-timeline"]');
  await header.scrollIntoViewIfNeeded();
  const headerPng = await header.screenshot({ type: 'png' });
  await timeline.scrollIntoViewIfNeeded();
  const timelinePng = await timeline.screenshot({ type: 'png' });
  const [headerMetadata, timelineMetadata] = await Promise.all([
    sharp(headerPng).metadata(),
    sharp(timelinePng).metadata(),
  ]);
  const headerWidth = headerMetadata.width ?? 0;
  const headerHeight = headerMetadata.height ?? 0;
  const timelineWidth = timelineMetadata.width ?? 0;
  const timelineHeight = timelineMetadata.height ?? 0;
  if (
    headerWidth < 200
    || headerHeight < 40
    || timelineWidth < 200
    || timelineHeight < 40
  ) {
    throw new Error(
      `Conversation header/timeline capture is invalid: header=${headerWidth}x${headerHeight}, `
      + `timeline=${timelineWidth}x${timelineHeight}`,
    );
  }
  await sharp({
    create: {
      width: Math.max(headerWidth, timelineWidth),
      height: headerHeight + timelineHeight,
      channels: 4,
      background: { r: 9, g: 9, b: 11, alpha: 1 },
    },
  }).composite([
    { input: headerPng, left: 0, top: 0 },
    { input: timelinePng, left: 0, top: headerHeight },
  ]).png().toFile(screenshotPath);
}

async function createBusinessEvidence(
  page: Page,
  screenshotPath: string,
  htmlPath: string,
): Promise<{ panels: number; crop: string }> {
  await page.setViewportSize({ width: 1280, height: 900 });
  const html = `<!doctype html>
    <html lang="zh-CN">
      <head>
        <meta charset="utf-8" />
        <style>
          * { box-sizing: border-box; }
          body { margin: 0; min-height: 900px; color: #f5f4ef; background: #101a24; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
          header { min-height: 330px; padding: 64px 72px; background: linear-gradient(115deg, rgba(7,33,48,.98), rgba(16,72,76,.76)), radial-gradient(circle at 80% 30%, #d8a85c 0, transparent 28%); }
          .tag { letter-spacing: .18em; color: #f4c77d; text-transform: uppercase; font-size: 13px; }
          h1 { max-width: 760px; margin: 18px 0 16px; font-size: 58px; line-height: 1.04; }
          header p { max-width: 680px; color: #c9d8d6; font-size: 19px; line-height: 1.7; }
          main { display: grid; grid-template-columns: repeat(4, 1fr); gap: 18px; padding: 34px 54px 54px; }
          article { min-height: 250px; padding: 24px; border: 1px solid rgba(244,199,125,.24); border-radius: 18px; background: rgba(255,255,255,.055); }
          article span { color: #f4c77d; font-size: 12px; }
          article h2 { margin: 17px 0 10px; font-size: 24px; }
          article p { color: #adbfbd; line-height: 1.65; }
          footer { padding: 0 54px 30px; color: #77918f; font-size: 12px; }
        </style>
      </head>
      <body data-deliverable="travel-site-final">
        <header data-testid="hero" data-crop="contained">
          <div class="tag">WorkBuddy · Island Journey</div>
          <h1>沿着海风，完成一场有节奏的岛屿旅行</h1>
          <p>从路线、住宿、体验到预算，最终页面已经根据首轮截图判断完成调整并复验。</p>
        </header>
        <main>
          <article data-business-panel="route"><span>01 ROUTE</span><h2>路线</h2><p>三天两夜的环岛节奏，关键转场与停留时间清晰可读。</p></article>
          <article data-business-panel="stay"><span>02 STAY</span><h2>住宿</h2><p>海湾、老城与日出方向，按体验目标匹配不同住宿区域。</p></article>
          <article data-business-panel="experience"><span>03 EXPERIENCE</span><h2>体验</h2><p>日落航行、海岸徒步和本地餐桌组成完整的旅行叙事。</p></article>
          <article data-business-panel="budget"><span>04 BUDGET</span><h2>预算</h2><p>交通、住宿、体验和弹性资金均给出明确区间。</p></article>
        </main>
        <footer>Deterministic acceptance preview · no external network or user data</footer>
      </body>
    </html>`;
  writeFileSync(htmlPath, html);
  await page.setContent(html);
  const panels = await page.locator('[data-business-panel]').count();
  const crop = await page.locator('[data-testid="hero"]').getAttribute('data-crop') || '';
  if (panels !== 4 || crop !== 'contained') {
    throw new Error(`Business preview failed deterministic inspection: panels=${panels}, crop=${crop}`);
  }
  await page.screenshot({ path: screenshotPath, type: 'png', fullPage: true });
  return { panels, crop };
}

async function seedSurfaceConversation(
  page: Page,
  conversationId: string,
  evidenceAssetRef: string,
  outputHtmlAssetRef: string,
  outputImageAssetRef: string,
): Promise<SurfaceConversationSeedResult> {
  const result = await page.evaluate(async (input) => {
    const token = (window as unknown as { __CODE_AGENT_TOKEN__?: string }).__CODE_AGENT_TOKEN__;
    const response = await fetch('/api/dev/surface-execution-conversation/seed', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(input),
    });
    return { ok: response.ok, status: response.status, body: await response.text() };
  }, { conversationId, evidenceAssetRef, outputHtmlAssetRef, outputImageAssetRef });
  if (!result.ok) {
    throw new Error(`Production Surface conversation seed failed: ${result.status} ${sanitize(result.body)}`);
  }
  const parsed = JSON.parse(result.body) as Partial<SurfaceConversationSeedResult>;
  if (parsed.ok !== true
    || typeof parsed.runId !== 'string'
    || typeof parsed.surfaceSessionId !== 'string'
    || typeof parsed.eventCount !== 'number'
    || parsed.outputCount !== 2
    || parsed.writable !== true
    || parsed.grantState !== 'active') {
    throw new Error(`Production Surface conversation seed returned invalid evidence: ${sanitize(result.body)}`);
  }
  return parsed as SurfaceConversationSeedResult;
}

async function installIsolatedFolderTrustSafetyRoute(page: Page): Promise<void> {
  await page.route('**/api/domain/folderTrust/set', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: {
          state: 'blocked',
          canonicalRealpath: process.cwd(),
          displayPath: process.cwd(),
          dangerousItems: [],
          blockedItems: [],
          identityChanged: false,
        },
      }),
    });
  });
}

async function installPipRuntime(page: Page, screenshotDataUrl: string): Promise<void> {
  await page.evaluate((dataUrl) => {
    type PipTestWindow = {
      __TAURI_INTERNALS__?: {
        invoke: <T = unknown>(
          command: string,
          args?: Record<string, unknown>,
          options?: TauriInvokeOptions,
        ) => Promise<T>;
      };
      __conversationPipCalls?: PipCommandRecord[];
    };
    const target = window as unknown as PipTestWindow;
    target.__conversationPipCalls = [];
    target.__TAURI_INTERNALS__ = {
      invoke: async <T = unknown>(
        command: string,
        args?: Record<string, unknown>,
      ): Promise<T> => {
        const calls = target.__conversationPipCalls || [];
        if (command === 'pip_controls') {
          const controls = args?.controls as { state?: unknown; availableControls?: unknown } | undefined;
          calls.push({
            command,
            state: typeof controls?.state === 'string' ? controls.state : undefined,
            controls: Array.isArray(controls?.availableControls)
              ? controls.availableControls.filter((item): item is string => typeof item === 'string')
              : [],
          });
        } else if (command === 'pip_frame') {
          calls.push({
            command,
            dataUrlLength: typeof args?.dataUrl === 'string' ? args.dataUrl.length : 0,
          });
        } else {
          calls.push({ command });
        }
        target.__conversationPipCalls = calls;
        if (command === 'appshots_read_image_data_url') return dataUrl as T;
        return null as T;
      },
    };
  }, screenshotDataUrl);
}

async function readRuntimeDiagnostics(page: Page): Promise<RuntimeSubscriptionDiagnostics> {
  return page.evaluate(() => (
    (window as unknown as { __surfaceRuntimeDiagnostics?: RuntimeSubscriptionDiagnostics })
      .__surfaceRuntimeDiagnostics || {}
  ));
}

function snapshotInvocations(
  diagnostics: RuntimeSubscriptionDiagnostics,
  conversationId: string,
): NonNullable<RuntimeSubscriptionDiagnostics['domainInvocations']> {
  return (diagnostics.domainInvocations || []).filter((item) => (
    item.domain === 'domain:surfaceExecution'
      && item.action === 'getSnapshot'
      && item.conversationId === conversationId
  ));
}

function controlInvocations(
  diagnostics: RuntimeSubscriptionDiagnostics,
  conversationId: string,
): NonNullable<RuntimeSubscriptionDiagnostics['domainInvocations']> {
  return (diagnostics.domainInvocations || []).filter((item) => (
    item.domain === 'domain:surfaceExecution'
      && item.action === 'control'
      && item.conversationId === conversationId
  ));
}

async function readTerminalSurfaceArtifacts(
  page: Page,
  conversationId: string,
  surfaceSessionId: string,
): Promise<{
  state: string;
  writable: boolean;
  frame: { width: number; height: number; sourceBytes: number };
  htmlMarker: boolean;
  htmlCanaryAbsent: boolean;
  image: { width: number; height: number; sourceBytes: number };
  outputCount: number;
}> {
  return page.evaluate(async (scope) => {
    interface DomainResponse { success: boolean; data?: unknown; error?: { message?: string } }
    interface SnapshotData {
      sessions?: Array<{
        session?: { sessionId?: string; state?: string };
        writable?: boolean;
        evidence?: Array<{ kind?: string; assetRef?: string }>;
        outputs?: Array<{ ref?: string; label?: string }>;
      }>;
    }
    interface ImageData { dataUrl?: string }
    interface TextData { text?: string }
    const api = (window as unknown as {
      codeAgentDomainAPI?: {
        invoke: (domain: string, action: string, payload: unknown) => Promise<DomainResponse>;
      };
    }).codeAgentDomainAPI;
    if (!api) throw new Error('Surface domain bridge unavailable');
    const invoke = async (action: string, payload: unknown): Promise<unknown> => {
      const response = await api.invoke('domain:surfaceExecution', action, payload);
      if (!response.success) throw new Error(response.error?.message || `Surface ${action} failed`);
      return response.data;
    };
    const snapshot = await invoke('getSnapshot', {
      version: 1,
      conversationId: scope.conversationId,
    }) as SnapshotData;
    const session = snapshot.sessions?.find((candidate) => (
      candidate.session?.sessionId === scope.surfaceSessionId
    ));
    const frameRef = session?.evidence?.find((evidence) => evidence.kind === 'screenshot')?.assetRef;
    const htmlRef = session?.outputs?.find((output) => output.label === 'travel-site-final.html')?.ref;
    const imageRef = session?.outputs?.find((output) => output.label === 'travel-site-final.png')?.ref;
    if (!session || !frameRef || !htmlRef || !imageRef) {
      throw new Error('Terminal Surface snapshot is missing evidence or outputs');
    }
    const frame = await invoke('getFrame', {
      version: 1,
      conversationId: scope.conversationId,
      surfaceSessionId: scope.surfaceSessionId,
      assetRef: frameRef,
    }) as ImageData;
    const html = await invoke('getOutput', {
      version: 1,
      conversationId: scope.conversationId,
      surfaceSessionId: scope.surfaceSessionId,
      outputRef: htmlRef,
    }) as TextData;
    const imageOutput = await invoke('getOutput', {
      version: 1,
      conversationId: scope.conversationId,
      surfaceSessionId: scope.surfaceSessionId,
      outputRef: imageRef,
    }) as ImageData;
    const dimensions = (dataUrl: string | undefined) => new Promise<{
      width: number;
      height: number;
      sourceBytes: number;
    }>((resolvePromise, reject) => {
      if (!dataUrl) {
        reject(new Error('Image payload is unavailable'));
        return;
      }
      const image = new Image();
      image.onload = () => resolvePromise({
        width: image.naturalWidth,
        height: image.naturalHeight,
        sourceBytes: dataUrl.length,
      });
      image.onerror = () => reject(new Error('Image payload could not be decoded'));
      image.src = dataUrl;
    });
    return {
      state: session.session?.state || '',
      writable: session.writable === true,
      frame: await dimensions(frame.dataUrl),
      htmlMarker: html.text?.includes('data-deliverable="travel-site-final"') === true,
      htmlCanaryAbsent: !html.text?.includes('surface-secret-canary'),
      image: await dimensions(imageOutput.dataUrl),
      outputCount: session.outputs?.length || 0,
    };
  }, { conversationId, surfaceSessionId });
}

function runtimeDiagnosticsInitScript(): string {
  return `
    globalThis.__name = globalThis.__name || ((target) => target);
    (() => {
      const diagnostics = {
        subscriptions: [],
        deliveries: [],
        sse: [],
        domainInvocations: [],
      };
      globalThis.__surfaceRuntimeDiagnostics = diagnostics;
      const eventSummary = (value) => {
        const event = Array.isArray(value) ? value[0] : value;
        if (!event || typeof event !== 'object') return {};
        const data = event.data && typeof event.data === 'object' ? event.data : {};
        return {
          eventType: typeof event.type === 'string' ? event.type : undefined,
          sessionId: typeof event.sessionId === 'string' ? event.sessionId : undefined,
          dataConversationId: typeof data.conversationId === 'string' ? data.conversationId : undefined,
        };
      };
      let commandApi;
      Object.defineProperty(globalThis, 'codeAgentAPI', {
        configurable: true,
        enumerable: true,
        get: () => commandApi,
        set: (value) => {
          if (value && typeof value.on === 'function' && !value.__surfaceDiagnosticsWrapped) {
            const originalOn = value.on.bind(value);
            let nextSubscriptionId = 0;
            value.on = (channel, callback) => {
              const id = ++nextSubscriptionId;
              diagnostics.subscriptions.push({ id, channel: String(channel), at: performance.now() });
              const wrapped = (...args) => {
                diagnostics.deliveries.push({
                  id,
                  channel: String(channel),
                  ...eventSummary(args[0]),
                  at: performance.now(),
                });
                if (diagnostics.deliveries.length > 300) diagnostics.deliveries.shift();
                return callback(...args);
              };
              return originalOn(channel, wrapped);
            };
            Object.defineProperty(value, '__surfaceDiagnosticsWrapped', { value: true });
          }
          commandApi = value;
        },
      });
      let domainApi;
      Object.defineProperty(globalThis, 'codeAgentDomainAPI', {
        configurable: true,
        enumerable: true,
        get: () => domainApi,
        set: (value) => {
          if (value && typeof value.invoke === 'function' && !value.__surfaceDiagnosticsWrapped) {
            const originalInvoke = value.invoke.bind(value);
            value.invoke = (domain, action, payload) => {
              diagnostics.domainInvocations.push({
                domain: String(domain),
                action: String(action),
                conversationId: payload && typeof payload.conversationId === 'string'
                  ? payload.conversationId
                  : undefined,
                surfaceSessionId: payload && typeof payload.surfaceSessionId === 'string'
                  ? payload.surfaceSessionId
                  : undefined,
                controlAction: payload && typeof payload.action === 'string'
                  ? payload.action
                  : undefined,
                at: performance.now(),
              });
              return originalInvoke(domain, action, payload);
            };
            Object.defineProperty(value, '__surfaceDiagnosticsWrapped', { value: true });
          }
          domainApi = value;
        },
      });
      const NativeEventSource = globalThis.EventSource;
      if (typeof NativeEventSource === 'function') {
        globalThis.EventSource = class SurfaceDiagnosticEventSource extends NativeEventSource {
          constructor(url, options) {
            super(url, options);
            diagnostics.sse.push({ kind: 'construct', url: String(url).replace(/token=[^&]+/g, 'token=[redacted]'), at: performance.now() });
            this.addEventListener('open', () => {
              diagnostics.sse.push({ kind: 'open', at: performance.now() });
            });
            this.addEventListener('message', (message) => {
              let payload;
              try { payload = JSON.parse(message.data); } catch { payload = {}; }
              const args = Array.isArray(payload.args) ? payload.args : [payload.args];
              diagnostics.sse.push({
                kind: 'message',
                channel: typeof payload.channel === 'string' ? payload.channel : undefined,
                ...eventSummary(args[0]),
                at: performance.now(),
              });
              if (diagnostics.sse.length > 300) diagnostics.sse.shift();
            });
          }
        };
      }
    })();
  `;
}

async function locatorText(locator: Locator): Promise<string> {
  return sanitize((await locator.innerText()).replace(/\s+/g, ' ').trim());
}

function assertValue(
  assertions: AcceptanceAssertion[],
  id: string,
  condition: boolean,
  expected: string,
  actual: string,
): void {
  assertions.push({ id, passed: condition, expected, actual: sanitize(actual) });
  if (!condition) throw new Error(`${id}: expected ${expected}; actual ${sanitize(actual)}`);
}

async function waitForPipControl(page: Page, state: string, control: string): Promise<void> {
  try {
    await page.waitForFunction(({ expectedState, expectedControl }) => {
      const calls = (window as unknown as { __conversationPipCalls?: PipCommandRecord[] }).__conversationPipCalls || [];
      return calls.some((call) => call.command === 'pip_controls'
        && call.state === expectedState
        && call.controls?.includes(expectedControl));
    }, { expectedState: state, expectedControl: control }, { timeout: 15_000 });
  } catch (error) {
    const calls = await page.evaluate(() => (
      (window as unknown as { __conversationPipCalls?: PipCommandRecord[] }).__conversationPipCalls || []
    ));
    throw new Error(
      `Timed out waiting for PiP ${state}/${control}; calls=${sanitize(JSON.stringify(calls))}`,
      { cause: error },
    );
  }
}

async function clickControl(page: Page, label: RegExp): Promise<void> {
  const button = page.locator('[data-testid="surface-controls"]').getByRole('button', { name: label }).first();
  await button.waitFor({ state: 'visible', timeout: 10_000 });
  await button.click();
}

function filesUnder(root: string): string[] {
  const output: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) output.push(path);
    }
  };
  walk(root);
  return output.sort();
}

function targetedSourceFingerprint(): {
  algorithm: 'sha256';
  digest: string;
  diffDigest: string;
  files: Array<{ file: string; sha256: string; bytes: number }>;
  status: string[];
} {
  const files = SOURCE_FILES.filter(existsSync).map((file) => {
    const buffer = readFileSync(file);
    return { file, sha256: sha256(buffer), bytes: buffer.length };
  });
  const aggregate = createHash('sha256');
  for (const file of files) aggregate.update(`${file}\0${file.sha256}\0${file.bytes}\n`);
  const diff = execFileSync('git', ['diff', '--binary', 'HEAD', '--', ...SOURCE_FILES], {
    cwd: process.cwd(),
    maxBuffer: 32 * 1024 * 1024,
  });
  const status = git('status', '--short', '--', ...SOURCE_FILES).split('\n').filter(Boolean);
  return {
    algorithm: 'sha256',
    digest: aggregate.digest('hex'),
    diffDigest: sha256(diff),
    files,
    status,
  };
}

function rendererBundleFingerprint(): { digest: string; files: number; bytes: number } {
  const root = resolve('dist/renderer');
  const files = filesUnder(root).filter((file) => /\.(?:html|js|css)$/.test(file));
  const aggregate = createHash('sha256');
  let bytes = 0;
  for (const file of files) {
    const buffer = readFileSync(file);
    bytes += buffer.length;
    aggregate.update(`${relative(root, file)}\0${sha256(buffer)}\0${buffer.length}\n`);
  }
  return { digest: aggregate.digest('hex'), files: files.length, bytes };
}

function safeFailureProof(
  outputDir: string,
  startedAt: number,
  error: unknown,
  assertions: AcceptanceAssertion[],
  campaignProof: SurfaceAcceptanceCampaignProofFieldsV1,
): void {
  mkdirSync(outputDir, { recursive: true });
  const proof = {
    version: 1,
    status: 'failed',
    ...campaignProof,
    acceptance: 'surface-execution-conversation-app-host',
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date().toISOString(),
    head: (() => { try { return git('rev-parse', 'HEAD'); } catch { return 'unknown'; } })(),
    sourceFingerprint: surfaceAcceptanceSourceFingerprint(),
    error: sanitize(formatAcceptanceError(error)),
    assertions,
  };
  const serialized = JSON.stringify(proof, null, 2);
  writeFileSync(join(outputDir, 'proof.json'), `${serialized}\n`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (hasFlag(args, 'help')) {
    usage();
    return;
  }

  const campaignProof = surfaceAcceptanceCampaignProofFields();
  const outputDir = resolve(getStringOption(args, 'out-dir') || DEFAULT_OUTPUT_DIR);
  const repoRoot = resolve('.');
  const startedAt = Date.now();
  const assertions: AcceptanceAssertion[] = [];
  const logLines: string[] = [];
  const log = (line: string) => {
    const safe = `${new Date().toISOString()} ${sanitize(line)}`;
    logLines.push(safe);
    console.log(safe);
  };
  let appHost: ReturnType<typeof startAppHost> | null = null;
  let chrome: SystemChromeSession | null = null;
  const dataDir = mkdtempSync(join(tmpdir(), 'code-agent-conversation-acceptance-'));

  try {
    mkdirSync(outputDir, { recursive: true });
    for (const name of GENERATED_ARTIFACT_NAMES) {
      rmSync(join(outputDir, name), { force: true });
    }
    const invocationArgs = process.argv.slice(2);
    log(`COMMAND npm run acceptance:surface-execution-conversation${invocationArgs.length > 0 ? ` -- ${invocationArgs.join(' ')}` : ''}`);
    await ensureBuild(hasFlag(args, 'skip-build'), log);
    const targetedFingerprint = targetedSourceFingerprint();
    const bundle = rendererBundleFingerprint();
    const port = getNumberOption(args, 'port') || await getFreePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    appHost = startAppHost(port, dataDir);
    const health = await waitForHealth(baseUrl, appHost.child, appHost.output);
    assertValue(assertions, 'app_host_health', health.status === 200, 'HTTP 200', `HTTP ${health.status}`);

    chrome = await launchSystemChromeSession({
      profilePrefix: 'code-agent-conversation-acceptance-',
      visible: hasFlag(args, 'visible'),
      timeoutMs: 20_000,
    });
    const context = chrome.browser.contexts()[0];
    if (!context) throw new Error('System Chrome default context is unavailable');
    const previewPage = await context.newPage();
    const businessEvidencePath = join(outputDir, 'business-evidence.png');
    const businessHtmlPath = join(outputDir, 'travel-site-final.html');
    const businessInspection = await createBusinessEvidence(
      previewPage,
      businessEvidencePath,
      businessHtmlPath,
    );
    const businessPng = readFileSync(businessEvidencePath);
    const businessDimensions = parsePng(businessPng);
    assertValue(
      assertions,
      'business_screenshot_bytes',
      businessPng.length > 20_000 && businessDimensions.width === 1280 && businessDimensions.height >= 900,
      'real PNG > 20KB at 1280x900+',
      `${businessPng.length} bytes ${businessDimensions.width}x${businessDimensions.height}`,
    );
    assertValue(
      assertions,
      'business_semantic_verification',
      businessInspection.panels === 4 && businessInspection.crop === 'contained',
      '4 panels and contained Hero crop',
      `${businessInspection.panels} panels, crop=${businessInspection.crop}`,
    );
    const evidenceDataUrl = `data:image/png;base64,${businessPng.toString('base64')}`;
    await previewPage.close();

    const page = await context.newPage();
    await page.setViewportSize({ width: 1440, height: 1100 });
    const pageErrors: string[] = [];
    const domainRequestUrls: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(sanitize(error.message)));
    page.on('request', (request) => {
      if (request.url().includes('/api/domain/')) domainRequestUrls.push(request.url());
    });
    await installIsolatedFolderTrustSafetyRoute(page);
    await page.addInitScript({ content: runtimeDiagnosticsInitScript() });
    await page.goto(`${baseUrl}/?e2e=1`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await waitForAppReady(page);
    const servedRenderer = await fingerprintServedRenderer(page, baseUrl);
    assertValue(
      assertions,
      'fresh_renderer_bundle_served',
      servedRenderer.sha256 === servedRenderer.localSha256
        && servedRenderer.bytes === servedRenderer.localBytes,
      'app-host served JS SHA and bytes equal local dist/renderer',
      `${servedRenderer.script} ${servedRenderer.sha256}/${servedRenderer.localSha256} ${servedRenderer.bytes}/${servedRenderer.localBytes}`,
    );
    const blockedIsolatedFolderConfiguration = await dismissIsolatedFolderTrustDialog(page);
    await installPipRuntime(page, evidenceDataUrl);
    const now = Date.now();
    const sessionTransition = await createCleanSession(page);
    const conversationId = sessionTransition.sessionId;
    const panel = page.locator('[data-testid="surface-execution-conversation-panel"]');
    let initialConversationSnapshotRequests = 0;
    let conversationSnapshotRequestsBeforeSse = 0;
    let surfaceSeed: SurfaceConversationSeedResult | null = null;
    try {
      await waitForCondition(
        async () => snapshotInvocations(await readRuntimeDiagnostics(page), conversationId).length >= 1,
        'production session-switch snapshot request',
      );
      initialConversationSnapshotRequests = snapshotInvocations(
        await readRuntimeDiagnostics(page),
        conversationId,
      ).length;
      conversationSnapshotRequestsBeforeSse = initialConversationSnapshotRequests;
      surfaceSeed = await seedSurfaceConversation(
        page,
        conversationId,
        businessEvidencePath,
        businessHtmlPath,
        businessEvidencePath,
      );
      await waitForCondition(
        async () => snapshotInvocations(await readRuntimeDiagnostics(page), conversationId).length
          > conversationSnapshotRequestsBeforeSse,
        'runtime-event-triggered production snapshot refresh',
      );
      await panel.waitFor({ state: 'visible', timeout: 20_000 });
      await injectConversationMessages(page, now);
    } catch (error) {
      const body = sanitize((await page.locator('body').innerText().catch(() => '')).slice(0, 4_000));
      const runtimeDiagnostics = await readRuntimeDiagnostics(page).catch(() => ({}));
      const surfaceEffectDiagnostics = await readSurfaceEffectDiagnostics(page).catch(() => null);
      writeFileSync(
        join(outputDir, 'subscription-diagnostic.json'),
        `${JSON.stringify({ runtimeDiagnostics, surfaceEffectDiagnostics }, null, 2)}\n`,
      );
      const debugPath = join(outputDir, 'conversation-debug.png');
      await page.screenshot({ path: debugPath, type: 'png' }).catch(() => undefined);
      throw new Error(
        `Conversation Surface panel did not render; snapshotRequests=${snapshotInvocations(runtimeDiagnostics, conversationId).length}; `
        + `surfaceSeed=${JSON.stringify(surfaceSeed)}; `
        + `activeConversation=${conversationId}; pageErrors=${pageErrors.join(' | ') || 'none'}; `
        + `domainRequests=${domainRequestUrls.join(' | ') || 'none'}; `
        + `surfaceEffectDiagnostics=${JSON.stringify(surfaceEffectDiagnostics)}; `
        + `runtimeDiagnostics=${JSON.stringify(runtimeDiagnostics)}; body=${body}`,
        { cause: error },
      );
    }
    if (!surfaceSeed) throw new Error('Production Surface conversation seed is unavailable');
    const session = panel.locator('[data-testid="surface-execution-session"]').first();
    const header = session.locator('[data-testid="surface-session-header"]');
    const permission = session.locator('[data-testid="surface-permission-card"]');
    const timeline = session.locator('[data-testid="surface-semantic-timeline"]');
    const evidenceCard = session.locator('[data-testid="surface-evidence-card"]');
    const resources = session.locator('[data-testid="surface-resources"]');
    const controls = session.locator('[data-testid="surface-controls"]');

    const headerCopy = await locatorText(header);
    assertValue(
      assertions,
      'session_header_target_provider_state',
      headerCopy.includes('WorkBuddy 旅行站点')
        && headerCopy.includes('托管浏览器')
        && headerCopy.includes('执行中')
        && headerCopy.includes('Neo'),
      'target, managed provider, running state and Neo controller',
      headerCopy,
    );
    const phases = await timeline.locator('[data-testid="surface-timeline-event"]').evaluateAll((nodes) => (
      nodes.map((node) => node.getAttribute('data-phase') || '')
    ));
    assertValue(
      assertions,
      'semantic_timeline_business_phases',
      ['prepare', 'observe', 'act', 'verify', 'artifact', 'recover'].every((phase) => phases.includes(phase)),
      'prepare/observe/act/verify/artifact/recover',
      phases.join(','),
    );
    const timelineCopy = await locatorText(timeline);
    assertValue(
      assertions,
      'cross_surface_switch_reason_displayed',
      timelineCopy.includes('因为最终产物需要页面截图复验，已从 Computer 返回 Browser'),
      'visible reason for the Computer to Browser switch',
      timelineCopy,
    );
    const permissionCopy = await locatorText(permission);
    assertValue(
      assertions,
      'permission_scope',
      permissionCopy.includes('授权有效')
        && permissionCopy.includes('观察')
        && permissionCopy.includes('输入')
        && permissionCopy.includes('导航')
        && permissionCopy.includes('文件'),
      'active grant with observe/input/navigate/file',
      permissionCopy,
    );
    const recovery = session.locator('[data-testid="surface-recovery-card"]');
    await recovery.waitFor({ state: 'visible', timeout: 10_000 });
    assertValue(assertions, 'recovery_card', true, 'visible latest revision recovery', await locatorText(recovery));

    const evidenceStates = await evidenceCard.locator('[data-testid="surface-evidence-axis"]').evaluateAll((nodes) => (
      nodes.map((node) => node.getAttribute('data-state') || '')
    ));
    assertValue(
      assertions,
      'screenshot_evidence_lifecycle',
      ['captured', 'analyzed', 'verified'].every((state) => evidenceStates.includes(state)),
      'captured/analyzed/verified independent axes',
      evidenceStates.join(','),
    );
    const evidenceCopy = await locatorText(evidenceCard);
    assertValue(
      assertions,
      'screenshot_evidence_business_findings',
      evidenceCopy.includes('四个业务板块完整')
        && evidenceCopy.includes('Hero 图片主体完整')
        && evidenceCopy.includes('HTML 与 PNG 产物可用'),
      'three passed business checklist findings',
      evidenceCopy,
    );
    const evidencePreview = evidenceCard.locator('[data-testid="surface-evidence-preview"]');
    await evidencePreview.waitFor({ state: 'visible', timeout: 15_000 });
    const evidencePreviewPixels = await evidencePreview.locator('img').evaluate((image: HTMLImageElement) => ({
      width: image.naturalWidth,
      height: image.naturalHeight,
      sourceBytes: image.src.length,
    }));
    assertValue(
      assertions,
      'conversation_evidence_frame_pixels',
      evidencePreviewPixels.width === businessDimensions.width
        && evidencePreviewPixels.height === businessDimensions.height
        && evidencePreviewPixels.sourceBytes > 20_000,
      `${businessDimensions.width}x${businessDimensions.height} owner-scoped frame with real pixels`,
      JSON.stringify(evidencePreviewPixels),
    );
    assertValue(
      assertions,
      'evidence_frozen_capture_context',
      evidenceCopy.includes('http://127.0.0.1/workbuddy/travel-site')
        && evidenceCopy.includes(`${businessDimensions.width}×${businessDimensions.height}`),
      'captured source URL and frame dimensions rendered from frozen evidence context',
      evidenceCopy,
    );
    const resourceCopy = await locatorText(resources);
    assertValue(
      assertions,
      'outputs_evidence_sources_separated',
      resourceCopy.includes('travel-site-final.html')
        && resourceCopy.includes('travel-site-final.png')
        && resourceCopy.includes('来源')
        && resourceCopy.includes('只读来源'),
      'HTML/PNG outputs and read-only source',
      resourceCopy,
    );
    const outputEntries = resources.locator('[data-testid="surface-output-entry"]');
    const htmlOutput = outputEntries.filter({ hasText: 'travel-site-final.html' });
    await htmlOutput.getByRole('button', { name: '打开产物' }).click();
    const htmlPreview = htmlOutput.locator('[data-testid="surface-output-preview"]');
    await htmlPreview.waitFor({ state: 'visible', timeout: 15_000 });
    const htmlPreviewText = await locatorText(htmlPreview);
    assertValue(
      assertions,
      'owner_scoped_html_output_readback',
      htmlPreviewText.includes('data-deliverable="travel-site-final"')
        && await htmlPreview.locator('body[data-deliverable], main[data-deliverable]').count() === 0,
      'HTML output opens as inert owner-scoped text with the generated deliverable marker',
      htmlPreviewText.slice(0, 600),
    );
    const imageOutput = outputEntries.filter({ hasText: 'travel-site-final.png' });
    await imageOutput.getByRole('button', { name: '打开产物' }).click();
    const outputImage = imageOutput.locator('[data-testid="surface-output-preview"] img');
    await outputImage.waitFor({ state: 'visible', timeout: 15_000 });
    const outputPixels = await outputImage.evaluate((image: HTMLImageElement) => ({
      width: image.naturalWidth,
      height: image.naturalHeight,
      sourceBytes: image.src.length,
    }));
    assertValue(
      assertions,
      'owner_scoped_png_output_pixels',
      outputPixels.width === businessDimensions.width
        && outputPixels.height === businessDimensions.height
        && outputPixels.sourceBytes > 20_000,
      `${businessDimensions.width}x${businessDimensions.height} owner-scoped PNG output`,
      JSON.stringify(outputPixels),
    );
    const readonlyOutputs = outputEntries.locator('button:disabled');
    assertValue(
      assertions,
      'unknown_output_ref_fail_closed',
      await readonlyOutputs.count() >= 1,
      'unregistered trace remains read-only and cannot invoke a path or arbitrary ref',
      `disabled=${await readonlyOutputs.count()}`,
    );

    const foldedToggle = page.locator('button[title="展开本轮"]').first();
    await foldedToggle.waitFor({ state: 'visible', timeout: 10_000 });
    const expanded = await foldedToggle.getAttribute('aria-expanded');
    assertValue(
      assertions,
      'folded_turn_keeps_key_surface_resources',
      expanded === 'false'
        && await evidenceCard.count() === 1
        && await resources.count() === 1
        && await htmlPreview.count() === 1
        && await outputImage.count() === 1,
      'completed turn folded while Evidence and opened HTML/PNG resources remain mounted',
      `aria-expanded=${expanded}, evidence=${await evidenceCard.count()}, resources=${await resources.count()}`,
    );

    const composerStatus = page.locator('[data-testid="surface-execution-composer-status"]');
    const sidebarStatus = page.locator(
      `[data-session-id="${conversationId}"] [data-testid="surface-execution-sidebar-status"]`,
    );
    assertValue(
      assertions,
      'unified_run_status_running',
      await composerStatus.getAttribute('data-state') === 'running'
        && await sidebarStatus.getAttribute('data-state') === 'running'
        && await session.getAttribute('data-state') === 'running',
      'Conversation, Sidebar and Composer all read running from the same owner-scoped session',
      `${await session.getAttribute('data-state')}/${await sidebarStatus.getAttribute('data-state')}/${await composerStatus.getAttribute('data-state')}`,
    );

    const bodyText = await page.locator('body').innerText();
    const domHtml = await page.locator('body').innerHTML();
    assertValue(
      assertions,
      'redaction_canary_dom_absence',
      !bodyText.includes(CONVERSATION_EXECUTION_CANARY)
        && !domHtml.includes(CONVERSATION_EXECUTION_CANARY)
        && bodyText.includes('[redacted-canary]'),
      'raw canary absent and redacted placeholder visible',
      `rawBody=${bodyText.includes(CONVERSATION_EXECUTION_CANARY)}, rawHtml=${domHtml.includes(CONVERSATION_EXECUTION_CANARY)}, placeholder=${bodyText.includes('[redacted-canary]')}`,
    );

    const evidenceCardPath = join(outputDir, 'conversation-evidence-card.png');
    await evidenceCard.scrollIntoViewIfNeeded();
    await evidenceCard.screenshot({ path: evidenceCardPath, type: 'png' });
    const resourcesPath = join(outputDir, 'conversation-outputs-evidence-sources.png');
    await resources.scrollIntoViewIfNeeded();
    await resources.screenshot({ path: resourcesPath, type: 'png' });

    const headerTimelinePath = join(outputDir, 'conversation-header-timeline.png');
    await captureHeaderTimelineEvidence(session, headerTimelinePath);
    await panel.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    const foldedEvidencePath = join(outputDir, 'conversation-folded-evidence.png');
    await page.screenshot({ path: foldedEvidencePath, type: 'png' });

    await waitForPipControl(page, 'running', 'pause');
    const initialPipCalls = await page.evaluate(() => (
      (window as unknown as { __conversationPipCalls?: PipCommandRecord[] }).__conversationPipCalls || []
    ));
    assertValue(
      assertions,
      'pip_frame_and_live_controls',
      initialPipCalls.some((call) => call.command === 'pip_show')
        && initialPipCalls.some((call) => call.command === 'pip_frame' && (call.dataUrlLength || 0) > 20_000)
        && initialPipCalls.some((call) => call.command === 'pip_controls'
          && call.state === 'running'
          && ['pause', 'takeover', 'stop'].every((action) => call.controls?.includes(action))),
      'PiP show/frame and running pause/takeover/stop controls',
      JSON.stringify(initialPipCalls.slice(-8)),
    );

    await clickControl(page, /暂停/);
    await session.waitFor({ state: 'visible' });
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="surface-execution-session"]')?.getAttribute('data-state') === 'paused'
    ));
    await waitForPipControl(page, 'paused', 'resume');
    const pausedPath = join(outputDir, 'conversation-paused.png');
    await controls.scrollIntoViewIfNeeded();
    await controls.screenshot({ path: pausedPath, type: 'png' });
    const pauseControl = controlInvocations(await readRuntimeDiagnostics(page), conversationId).at(-1);
    assertValue(
      assertions,
      'pause_control_effect',
      pauseControl?.controlAction === 'pause'
        && pauseControl.surfaceSessionId === surfaceSeed.surfaceSessionId
        && await session.getAttribute('data-state') === 'paused'
        && await controls.getByRole('button', { name: /继续/ }).count() === 1,
      'pause request -> paused state -> Resume control',
      `${pauseControl?.controlAction}/${await session.getAttribute('data-state')}`,
    );

    await clickControl(page, /继续/);
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="surface-execution-session"]')?.getAttribute('data-state') === 'running'
    ));
    const resumeControl = controlInvocations(await readRuntimeDiagnostics(page), conversationId).at(-1);
    assertValue(
      assertions,
      'resume_control_effect',
      resumeControl?.controlAction === 'resume'
        && resumeControl.surfaceSessionId === surfaceSeed.surfaceSessionId,
      'resume request -> running state',
      `${resumeControl?.controlAction}/${await session.getAttribute('data-state')}`,
    );

    await clickControl(page, /我来操作/);
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="surface-execution-session"]')?.getAttribute('data-state') === 'waiting_human'
    ));
    const takeover = session.locator('[data-testid="surface-human-takeover-card"]');
    await takeover.waitFor({ state: 'visible', timeout: 10_000 });
    const takeoverPath = join(outputDir, 'conversation-takeover.png');
    await takeover.scrollIntoViewIfNeeded();
    await takeover.screenshot({ path: takeoverPath, type: 'png' });
    const takeoverControl = controlInvocations(await readRuntimeDiagnostics(page), conversationId).at(-1);
    assertValue(
      assertions,
      'takeover_control_and_card',
      takeoverControl?.controlAction === 'takeover'
        && takeoverControl.surfaceSessionId === surfaceSeed.surfaceSessionId
        && (await locatorText(takeover)).includes('需要你接管'),
      'takeover request -> waiting_human card',
      `${takeoverControl?.controlAction}/${await locatorText(takeover)}`,
    );

    await clickControl(page, /继续/);
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="surface-execution-session"]')?.getAttribute('data-state') === 'running'
    ));
    await clickControl(page, /停止/);
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="surface-execution-session"]')?.getAttribute('data-state') === 'stopping'
    ));
    const stoppingPath = join(outputDir, 'conversation-stopping.png');
    await controls.scrollIntoViewIfNeeded();
    await controls.screenshot({ path: stoppingPath, type: 'png' });
    const stoppingRuntimeDiagnostics = await readRuntimeDiagnostics(page);
    const stopControl = controlInvocations(stoppingRuntimeDiagnostics, conversationId).at(-1);
    assertValue(
      assertions,
      'stop_control_effect',
      stopControl?.controlAction === 'stop'
        && stopControl.surfaceSessionId === surfaceSeed.surfaceSessionId
        && await session.getAttribute('data-state') === 'stopping',
      'stop request -> stopping state',
      `${stopControl?.controlAction}/${await session.getAttribute('data-state')}`,
    );
    await clickControl(page, /结束 Session/);
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="surface-execution-session"]')?.getAttribute('data-state') === 'completed'
    ));
    await waitForCondition(
      async () => await composerStatus.getAttribute('data-state') === 'completed'
        && await sidebarStatus.getAttribute('data-state') === 'completed',
      'terminal Surface state in Sidebar and Composer',
    );
    const completedPath = join(outputDir, 'conversation-completed.png');
    await header.scrollIntoViewIfNeeded();
    await header.screenshot({ path: completedPath, type: 'png' });
    const terminalReadback = await readTerminalSurfaceArtifacts(
      page,
      conversationId,
      surfaceSeed.surfaceSessionId,
    );
    const finalRuntimeDiagnostics = await readRuntimeDiagnostics(page);
    const realControlRequests = controlInvocations(finalRuntimeDiagnostics, conversationId);
    const endControl = realControlRequests.at(-1);
    assertValue(
      assertions,
      'end_session_terminal_state',
      endControl?.controlAction === 'end_session'
        && endControl.surfaceSessionId === surfaceSeed.surfaceSessionId
        && await session.getAttribute('data-state') === 'completed',
      'end_session request -> completed read-only session',
      `${endControl?.controlAction}/${await session.getAttribute('data-state')}`,
    );
    assertValue(
      assertions,
      'unified_run_status_terminal',
      await composerStatus.getAttribute('data-state') === 'completed'
        && await sidebarStatus.getAttribute('data-state') === 'completed'
        && await evidenceCard.count() === 1
        && await resources.count() === 1,
      'Conversation, Sidebar and Composer share completed while evidence and outputs remain mounted',
      `${await session.getAttribute('data-state')}/${await sidebarStatus.getAttribute('data-state')}/${await composerStatus.getAttribute('data-state')}`,
    );
    assertValue(
      assertions,
      'terminal_frame_and_outputs_readback',
      terminalReadback.state === 'completed'
        && terminalReadback.writable === false
        && terminalReadback.frame.width === businessDimensions.width
        && terminalReadback.frame.height === businessDimensions.height
        && terminalReadback.frame.sourceBytes > 20_000
        && terminalReadback.image.width === businessDimensions.width
        && terminalReadback.image.height === businessDimensions.height
        && terminalReadback.image.sourceBytes > 20_000
        && terminalReadback.htmlMarker
        && terminalReadback.htmlCanaryAbsent
        && terminalReadback.outputCount >= 3,
      'fresh owner-scoped frame, inert HTML and PNG remain readable after completed',
      JSON.stringify(terminalReadback),
    );
    assertValue(
      assertions,
      'control_sequence',
      realControlRequests.map((item) => item.controlAction).join(',')
        === 'pause,resume,takeover,resume,stop,end_session',
      'pause,resume,takeover,resume,stop,end_session',
      realControlRequests.map((item) => item.controlAction).join(','),
    );
    const finalConversationSnapshotRequests = snapshotInvocations(
      finalRuntimeDiagnostics,
      conversationId,
    ).length;
    assertValue(
      assertions,
      'session_switch_snapshot_request',
      sessionTransition.previousSessionId !== conversationId
        && initialConversationSnapshotRequests >= 1,
      'new conversation id and at least one production snapshot request before SSE',
      `${sessionTransition.previousSessionId || 'none'} -> ${conversationId}; requests=${initialConversationSnapshotRequests}`,
    );
    assertValue(
      assertions,
      'sse_snapshot_refresh',
      finalConversationSnapshotRequests > conversationSnapshotRequestsBeforeSse,
      'same-conversation snapshot request count increases after SSE',
      `${conversationSnapshotRequestsBeforeSse} -> ${finalConversationSnapshotRequests}`,
    );
    assertValue(
      assertions,
      'native_snapshot_refresh',
      finalConversationSnapshotRequests >= 2,
      'at least initial and SSE-triggered snapshot requests',
      String(finalConversationSnapshotRequests),
    );
    assertValue(
      assertions,
      'renderer_page_errors',
      pageErrors.length === 0,
      'zero uncaught renderer errors',
      pageErrors.join(' | ') || '0',
    );

    const runtimeDiagnostics = finalRuntimeDiagnostics;
    const surfaceSnapshotInvocations = snapshotInvocations(runtimeDiagnostics, conversationId);
    const surfaceFrameInvocations = (runtimeDiagnostics.domainInvocations || []).filter((item) => (
      item.domain === 'domain:surfaceExecution'
        && item.action === 'getFrame'
        && item.conversationId === conversationId
        && item.surfaceSessionId === surfaceSeed.surfaceSessionId
    ));
    const surfaceOutputInvocations = (runtimeDiagnostics.domainInvocations || []).filter((item) => (
      item.domain === 'domain:surfaceExecution'
        && item.action === 'getOutput'
        && item.conversationId === conversationId
        && item.surfaceSessionId === surfaceSeed.surfaceSessionId
    ));
    const surfaceSseMessages = (runtimeDiagnostics.sse || []).filter((item) => (
      item.kind === 'message'
        && item.channel === 'agent:event'
        && item.eventType === 'surface_execution'
        && item.sessionId === conversationId
        && item.dataConversationId === conversationId
    ));
    const surfaceDeliveries = (runtimeDiagnostics.deliveries || []).filter((item) => (
      item.channel === 'agent:event'
        && item.eventType === 'surface_execution'
        && item.sessionId === conversationId
        && item.dataConversationId === conversationId
    ));
    const runtimeSurfaceEvidence = {
      agentEventSubscriptions: (runtimeDiagnostics.subscriptions || [])
        .filter((item) => item.channel === 'agent:event').length,
      snapshotInvocations: surfaceSnapshotInvocations,
      frameInvocations: surfaceFrameInvocations,
      outputInvocations: surfaceOutputInvocations,
      controlInvocations: realControlRequests,
      sseMessages: surfaceSseMessages,
      deliveries: surfaceDeliveries,
    };
    assertValue(
      assertions,
      'production_snapshot_invocation_chain',
      surfaceSnapshotInvocations.length >= 2,
      'at least session-switch and SSE production getSnapshot invocations',
      String(surfaceSnapshotInvocations.length),
    );
    assertValue(
      assertions,
      'surface_sse_subscription_delivery',
      runtimeSurfaceEvidence.agentEventSubscriptions >= 1
        && surfaceSseMessages.length >= 1
        && surfaceDeliveries.length >= 1,
      'agent:event subscription plus matching SSE message and callback delivery',
      JSON.stringify(runtimeSurfaceEvidence),
    );
    assertValue(
      assertions,
      'production_frame_resolution_chain',
      surfaceFrameInvocations.length >= 2,
      'owner-scoped getFrame domain invocations before and after terminal state',
      JSON.stringify(surfaceFrameInvocations),
    );
    assertValue(
      assertions,
      'production_output_resolution_chain',
      surfaceOutputInvocations.length >= 4,
      'owner-scoped HTML/PNG getOutput invocations before and after terminal state',
      JSON.stringify(surfaceOutputInvocations),
    );
    assertValue(
      assertions,
      'runtime_session_store_domain_renderer_chain',
      surfaceSeed.writable
        && surfaceSeed.grantState === 'active'
        && surfaceSeed.eventCount >= 6
        && surfaceSnapshotInvocations.length >= 2
        && surfaceFrameInvocations.length >= 2
        && surfaceOutputInvocations.length >= 4
        && realControlRequests.length === 6
        && surfaceDeliveries.length >= 1,
      'host runtime -> SessionManager projection -> domain snapshot/frame/output -> SSE -> Renderer with six real controls',
      JSON.stringify({
        surfaceSeed,
        snapshots: surfaceSnapshotInvocations.length,
        frames: surfaceFrameInvocations.length,
        outputs: surfaceOutputInvocations.length,
        controls: realControlRequests,
      }),
    );
    writeFileSync(
      join(outputDir, 'subscription-diagnostic.json'),
      `${JSON.stringify(runtimeSurfaceEvidence, null, 2)}\n`,
    );

    const screenshotPaths = [
      businessEvidencePath,
      headerTimelinePath,
      foldedEvidencePath,
      evidenceCardPath,
      resourcesPath,
      pausedPath,
      takeoverPath,
      stoppingPath,
      completedPath,
    ];
    const screenshots = screenshotPaths.map((path) => screenshotEvidence(repoRoot, path));
    for (const screenshot of screenshots) {
      assertValue(
        assertions,
        `screenshot_${basename(screenshot.file).replace(/\W+/g, '_')}`,
        screenshot.bytes > 2_000 && screenshot.width >= 200 && screenshot.height >= 40,
        'non-empty valid PNG crop at least 200x40',
        `${screenshot.bytes} bytes ${screenshot.width}x${screenshot.height}`,
      );
    }

    const pipCalls = await page.evaluate(() => (
      (window as unknown as { __conversationPipCalls?: PipCommandRecord[] }).__conversationPipCalls || []
    ));
    const head = git('rev-parse', 'HEAD');
    const originMain = git('rev-parse', 'origin/main');
    const mergeBase = git('merge-base', 'HEAD', 'origin/main');
    const proof = {
      version: 1,
      status: 'passed',
      ...campaignProof,
      acceptance: 'surface-execution-conversation-app-host',
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: new Date().toISOString(),
      worktree: repoRoot,
      git: {
        head,
        originMain,
        mergeBase,
        branch: git('branch', '--show-current'),
      },
      build: {
        fresh: !hasFlag(args, 'skip-build'),
        commands: hasFlag(args, 'skip-build')
          ? ['explicit --skip-build']
          : ['npm run build:web', 'npm run build:renderer'],
        rendererBundle: bundle,
      },
      sourceFingerprint: surfaceAcceptanceSourceFingerprint(),
      targetedSourceFingerprint: targetedFingerprint,
      runtime: {
        appHost: { baseUrl, healthStatus: health.status },
        servedRenderer,
        browser: {
          provider: SYSTEM_CHROME_CDP_PROVIDER,
          version: await chrome.browser.version(),
          executable: chrome.executable,
        },
        conversationId,
        sessionTransition,
        blockedIsolatedFolderConfiguration,
        hostRuntimeSeed: surfaceSeed,
        surfaceSessionId: surfaceSeed.surfaceSessionId,
        snapshotRequests: surfaceSnapshotInvocations.length,
        snapshotRequestConversationIds: surfaceSnapshotInvocations
          .map((item) => item.conversationId),
        initialConversationSnapshotRequests,
        conversationSnapshotRequestsBeforeSse,
        finalConversationSnapshotRequests,
        surfaceRuntimeEvidence: runtimeSurfaceEvidence,
        controlRequests: realControlRequests,
        pipCommands: pipCalls,
      },
      businessEvidence: {
        deterministicInspection: businessInspection,
        screenshot: screenshots[0],
      },
      screenshots,
      redactionCanary: {
        injected: true,
        fingerprint: sha256(CONVERSATION_EXECUTION_CANARY),
        rawAbsentFromDom: true,
        rawAbsentFromArtifacts: true,
        placeholderObserved: true,
      },
      assertions,
      summary: {
        passed: assertions.filter((item) => item.passed).length,
        failed: assertions.filter((item) => !item.passed).length,
        total: assertions.length,
      },
    };
    const serialized = JSON.stringify(proof, null, 2);
    assertValue(
      assertions,
      'redaction_canary_proof_absence',
      !serialized.includes(CONVERSATION_EXECUTION_CANARY),
      'raw canary absent from proof serialization',
      serialized.includes(CONVERSATION_EXECUTION_CANARY) ? 'present' : 'absent',
    );
    proof.summary = {
      passed: assertions.filter((item) => item.passed).length,
      failed: assertions.filter((item) => !item.passed).length,
      total: assertions.length,
    };
    log(
      `RESULT served-renderer script=${servedRenderer.script} sha256=${servedRenderer.sha256}/${servedRenderer.localSha256} bytes=${servedRenderer.bytes}/${servedRenderer.localBytes}`,
    );
    log(`RESULT acceptance exit=0 assertions=${proof.summary.passed}/${proof.summary.total}`);
    writeFileSync(join(outputDir, 'run.log'), `${logLines.join('\n')}\n`);
    writeFileSync(join(outputDir, 'proof.json'), `${JSON.stringify(proof, null, 2)}\n`);
    const leakedFiles = filesUnder(outputDir).filter((path) => readFileSync(path).includes(CONVERSATION_EXECUTION_CANARY));
    if (leakedFiles.length > 0) {
      throw new Error(`Raw redaction canary leaked into acceptance artifacts: ${leakedFiles.map((path) => relative(repoRoot, path)).join(', ')}`);
    }
    if (hasFlag(args, 'json')) printJson(proof);
    else {
      printKeyValue('Surface Execution Conversation acceptance', [
        ['status', proof.status],
        ['HEAD', head],
        ['origin/main', originMain],
        ['merge-base', mergeBase],
        ['browser', `${SYSTEM_CHROME_CDP_PROVIDER} ${await chrome.browser.version()}`],
        ['assertions', `${proof.summary.passed}/${proof.summary.total}`],
        ['proof', relative(repoRoot, join(outputDir, 'proof.json'))],
      ]);
    }
  } catch (error) {
    log(`RESULT acceptance exit=1 error=${formatAcceptanceError(error)}`);
    writeFileSync(join(outputDir, 'run.log'), `${logLines.join('\n')}\n`);
    safeFailureProof(outputDir, startedAt, error, assertions, campaignProof);
    throw error;
  } finally {
    if (chrome) {
      await chrome.browser.close().catch(() => undefined);
      await closeSystemChromeSession(chrome).catch(() => undefined);
    }
    if (appHost) await stopProcess(appHost.child).catch(() => undefined);
    rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch((error) => finishWithError(error));
