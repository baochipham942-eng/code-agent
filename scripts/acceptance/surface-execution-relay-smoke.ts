import { createHash } from 'node:crypto';
import { execFileSync, spawn, type ChildProcessByStdio } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import WebSocket from 'ws';
import {
  type Browser,
  type BrowserContext,
  type CDPSession,
  type Page,
  type Worker,
} from 'playwright';
import {
  getApplicationRunRegistry,
  resetApplicationRunRegistryForTests,
} from '../../src/host/app/applicationRunRegistry.ts';
import { browserRelayService } from '../../src/host/services/infra/browserRelayService.ts';
import { checkBrowserRelay } from '../../src/host/diagnostics/checks/browserRelay.ts';
import {
  getRelayBrowserProviderAdapter,
  resetRelayBrowserProviderAdapterForTests,
} from '../../src/host/services/surfaceExecution/RelayBrowserProviderAdapter.ts';
import { surfaceIdentityFromToolContext } from '../../src/host/services/surfaceExecution/ManagedBrowserProviderAdapter.ts';
import {
  getSurfaceExecutionRuntime,
  resetSurfaceExecutionRuntimeForTests,
} from '../../src/host/services/surfaceExecution/SurfaceExecutionRuntime.ts';
import { browserActionTool } from '../../src/host/tools/vision/browserAction.ts';
import type { ToolContext, ToolExecutionResult } from '../../src/host/tools/types.ts';
import {
  BROWSER_RELAY_CAPABILITIES_V2,
  BROWSER_RELAY_PROTOCOL_VERSION_V2,
} from '../../src/shared/contract/browserRelay.ts';
import type {
  SurfaceElementRefV1,
  SurfaceExecutionEventV1,
  SurfaceObservationV1,
} from '../../src/shared/contract/surfaceExecution.ts';
import {
  closeSystemChromeSession,
  connectToSystemChrome,
  ensureSystemChromeAvailable,
  getFreePort,
  getSystemChromeExecutable,
} from './browser-computer-system-chrome.ts';
import {
  finishWithError,
  getStringOption,
  hasFlag,
  parseArgs,
  printJson,
  printKeyValue,
} from './_helpers.ts';
import {
  surfaceAcceptanceCampaignProofFields,
  surfaceAcceptanceSourceFingerprint,
} from './surface-execution-proof.ts';

const RELAY_PORT = 23_001;
const CONVERSATION_ID = 'surface-relay-acceptance';
const RUN_ID = 'surface-relay-run';
const CANARY = 'surface-secret-canary-relay-e2e';
const BUSINESS_RESULT = 'Relay business result committed';
const RELAY_FIXTURE_USER = 'relay-fixture-user';
const RELAY_FIXTURE_PASSWORD = 'relay-fixture-password';
const LONG_LEASE_TTL_MS = 45_000;
const SHORT_LEASE_TTL_MS = 5_000;
const WAIT_STEP_MS = 50;
const MAIN_ACTION_SCOPES = [
  'get_content',
  'get_dom_snapshot',
  'get_a11y_snapshot',
  'type',
  'click',
  'screenshot',
  'get_logs',
  'navigate',
  'upload_file',
  'hover',
  'drag',
  'get_dialog_state',
  'handle_dialog',
  'wait',
  'close',
  'lease:return',
] as const;

type ApprovalMode = 'auto' | 'operator';

interface AgentHarness {
  agentId: string;
  events: SurfaceExecutionEventV1[];
  sequence: number;
}

interface NativePlacement {
  tabId: number;
  windowId: number;
  index: number;
  pinned: boolean;
  active: boolean;
}

interface PopupSnapshot {
  status: string;
  origin: string;
  actions: string[];
  agentId: string;
  conversationId: string;
  surfaceSessionId: string;
  approveDisabled: boolean;
  returnDisabled: boolean;
  message: string;
}

interface PopupEvidence {
  mode: ApprovalMode;
  label: string;
  screenshotPath?: string;
  screenshotSha256?: string;
  screenshotBytes?: number;
  snapshot: Omit<PopupSnapshot, 'surfaceSessionId'> & { surfaceSessionPresent: boolean };
}

interface RelayChromeSession {
  browser: Browser;
  chrome: ChildProcessByStdio<null, Readable, Readable>;
  context: BrowserContext;
  executable: string;
  extensionId: string;
  extensionPath: string;
  fixturePage: Page;
  logs: () => string;
  port: number;
  profileDir: string;
  rootCdp: CDPSession;
}

interface ExtensionTab {
  id: number;
  windowId: number;
  index: number;
  pinned?: boolean;
  active?: boolean;
  url?: string;
}

interface ExtensionChromeApi {
  action: { openPopup(): Promise<void> };
  tabs: {
    query(query: Record<string, unknown>): Promise<ExtensionTab[]>;
    update(tabId: number, update: Record<string, unknown>): Promise<ExtensionTab>;
  };
  windows: { update(windowId: number, update: Record<string, unknown>): Promise<unknown> };
}

class RelayAcceptanceBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RelayAcceptanceBlockedError';
  }
}

function usage(): void {
  console.log(`Surface Execution Relay acceptance

Usage:
  npm run acceptance:surface-execution-relay -- [options]

Options:
  --visible              Launch isolated System Chrome visibly.
  --approval <mode>      auto (default) or operator.
  --out <directory>      Persist proof JSON and current-run screenshots.
  --json                 Print JSON only.
  --help                 Show this help.

The auto path loads the unpacked Relay extension through Chrome CDP, opens the
real extension popup, captures its scope disclosure, and clicks Approve. If
Chrome cannot expose that popup target, the run exits non-zero with a structured
blocked proof. Use --visible --approval operator only for explicit human approval.`);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function gitSha(ref: string): string {
  return execFileSync('git', ['rev-parse', ref], {
    cwd: process.cwd(),
    encoding: 'utf8',
  }).trim();
}

function sanitizeMessage(value: unknown): string {
  const message = value instanceof Error ? value.message : String(value);
  return message.replaceAll(CANARY, '[REDACTED]');
}

function withoutCanary(value: unknown, label: string): void {
  assert(!JSON.stringify(value).includes(CANARY), `${label} leaked the redaction canary`);
}

function errorCode(result: ToolExecutionResult): string {
  const metadata = result.metadata || {};
  const relay = metadata.relayErrorV2 as { code?: unknown } | undefined;
  const surface = metadata.surfaceExecutionErrorV1 as { code?: unknown } | undefined;
  const recovery = metadata.recovery as { code?: unknown } | undefined;
  return [relay?.code, surface?.code, metadata.code, recovery?.code]
    .find((value): value is string => typeof value === 'string') || 'unknown';
}

function assertFailureCode(
  result: ToolExecutionResult,
  label: string,
  allowedCodes: readonly string[],
): string {
  assert(!result.success, `${label} unexpectedly succeeded`);
  const code = errorCode(result);
  assert(allowedCodes.includes(code), `${label} returned ${code}: ${result.error || 'no error'}`);
  return code;
}

async function waitFor<T>(
  read: () => Promise<T> | T,
  accept: (value: T) => boolean,
  timeoutMs: number,
  label: string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  while (Date.now() < deadline) {
    last = await read();
    if (accept(last)) return last;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, WAIT_STEP_MS));
  }
  throw new Error(`Timed out waiting for ${label}; last=${JSON.stringify(last)}`);
}

async function verifyProtocolMismatchBlocked(port: number): Promise<{
  connectionRejected: true;
  lastError: string;
}> {
  const config = await fetch(`http://127.0.0.1:${port}/api/browser-relay/config`, {
    headers: { 'X-Agent-Neo-Relay-Extension': BROWSER_RELAY_PROTOCOL_VERSION_V2 },
  }).then((response) => response.json()) as { token?: string };
  assert(typeof config.token === 'string' && config.token.length > 20,
    'Relay mismatch probe did not receive extension-only bootstrap material');
  const socket = new WebSocket(
    `ws://127.0.0.1:${port}/ws/browser-relay?token=${encodeURIComponent(config.token)}`,
  );
  await new Promise<void>((resolveOpen, rejectOpen) => {
    socket.once('open', () => resolveOpen());
    socket.once('error', rejectOpen);
  });
  const closed = new Promise<boolean>((resolveClosed) => {
    socket.once('close', () => resolveClosed(true));
  });
  socket.send(JSON.stringify({
    type: 'hello',
    protocolVersion: '1.0-invalid',
    extensionInstanceId: 'acceptance-mismatch-probe',
    capabilities: [...BROWSER_RELAY_CAPABILITIES_V2],
    orphanedLeaseIds: [],
  }));
  const state = await waitFor(
    () => browserRelayService.getState(),
    (candidate) => candidate.lastError?.includes('protocol version mismatch') === true,
    3_000,
    'Relay protocol mismatch rejection',
  );
  const connectionRejected = await Promise.race([
    closed,
    new Promise<boolean>((resolveTimeout) => setTimeout(() => resolveTimeout(false), 3_000)),
  ]);
  if (!connectionRejected) socket.terminate();
  assert(connectionRejected, 'Relay mismatch probe connection was not closed by the Host');
  assert(state.lastError?.includes('protocol version mismatch'),
    `Relay mismatch probe returned an unexpected error: ${state.lastError || 'none'}`);
  return { connectionRejected: true, lastError: state.lastError };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolveClose) => {
    server.close(() => resolveClose());
    server.closeAllConnections();
  });
}

async function startFixtureServer(): Promise<{ server: Server; origin: string; url: string }> {
  const server = createServer((request, response) => {
    const authenticated = (request.headers.cookie || '').split(';').some((cookie) => (
      cookie.trim() === 'relay_session=authenticated'
    ));
    if (request.method === 'POST' && request.url === '/login') {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk: string) => {
        body += chunk;
        if (body.length > 4_096) request.destroy();
      });
      request.once('end', () => {
        const form = new URLSearchParams(body);
        if (form.get('user') !== RELAY_FIXTURE_USER
          || form.get('password') !== RELAY_FIXTURE_PASSWORD) {
          response.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' });
          response.end('invalid fixture credentials');
          return;
        }
        response.writeHead(303, {
          location: '/relay',
          'set-cookie': 'relay_session=authenticated; HttpOnly; SameSite=Strict; Path=/; Max-Age=300',
          'cache-control': 'no-store',
        });
        response.end();
      });
      return;
    }
    if (request.url?.startsWith('/network-proof')) {
      if (!authenticated) {
        response.writeHead(401, { 'content-type': 'application/json' });
        response.end('{"committed":false}');
        return;
      }
      request.resume();
      response.writeHead(201, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
      });
      response.end('{"committed":true}');
      return;
    }
    if (!authenticated) {
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      });
      response.end(`<!doctype html>
<html>
  <head><meta charset="utf-8"><title>Relay login fixture</title></head>
  <body>
    <main>
      <h1>Relay existing-session login</h1>
      <form method="post" action="/login">
        <label>User <input id="login-user" name="user" autocomplete="username"></label>
        <label>Password <input id="login-password" name="password" type="password" autocomplete="current-password"></label>
        <button id="login-submit" type="submit">Sign in</button>
      </form>
    </main>
  </body>
</html>`);
      return;
    }
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    });
    response.end(`<!doctype html>
<html>
  <head><meta charset="utf-8"><title>Relay acceptance fixture</title></head>
  <body data-completed="no">
    <main>
      <h1>Relay Surface fixture</h1>
      <p id="auth-status">Authenticated Relay session</p>
      <label>Relay secret
        <input id="secret" type="password" autocomplete="off"
          oninput="console.log('authorization=${CANARY}')">
      </label>
      <button id="commit" onclick="document.querySelector('#status').textContent='${BUSINESS_RESULT}'; document.body.dataset.completed='yes'; console.log('token=${CANARY}'); void fetch('/network-proof?discard=query', { method: 'POST', body: 'metadata-only-proof' })">Commit relay result</button>
      <p id="status">Relay business result pending</p>
      <label>Relay upload
        <input id="upload" type="file" onchange="document.querySelector('#upload-status').textContent='Relay upload verified: ' + (this.files?.[0]?.size || 0) + ' bytes'">
      </label>
      <p id="upload-status">Relay upload pending</p>
      <button id="hover-target" onmouseenter="document.querySelector('#hover-status').textContent='Relay hover verified'">Hover target</button>
      <p id="hover-status">Relay hover pending</p>
      <button id="drag-source" onmousedown="document.body.dataset.dragging='yes'">Drag source</button>
      <button id="drag-target" onmouseup="if(document.body.dataset.dragging==='yes'){document.querySelector('#drag-status').textContent='Relay drag verified';document.body.dataset.dragging='no'}">Drag destination</button>
      <p id="drag-status">Relay drag pending</p>
      <button id="dialog-trigger" onclick="const accepted=confirm('Relay acceptance confirmation');const status=document.querySelector('#dialog-status');status.textContent=(status.textContent==='Relay dialog pending'?'':status.textContent+' | ')+(accepted?'Relay dialog accepted':'Relay dialog dismissed')">Open confirmation</button>
      <p id="dialog-status">Relay dialog pending</p>
    </main>
  </body>
</html>`);
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolveListen());
  });
  const address = server.address();
  assert(address && typeof address !== 'string', 'Fixture server did not bind a TCP port');
  const origin = `http://127.0.0.1:${address.port}`;
  return { server, origin, url: `${origin}/relay` };
}

async function authenticateExistingRelaySession(page: Page, protectedUrl: string): Promise<{
  cookie: { httpOnly: true; name: string; sameSite: 'Strict' };
  method: 'real-http-form-post';
  readback: string;
}> {
  await page.fill('#login-user', RELAY_FIXTURE_USER);
  await page.fill('#login-password', RELAY_FIXTURE_PASSWORD);
  await Promise.all([
    page.waitForResponse((response) => (
      response.url() === protectedUrl
      && response.request().method() === 'GET'
      && response.status() === 200
    )),
    page.click('#login-submit'),
  ]);
  await page.waitForLoadState('domcontentloaded');
  const readback = (await page.textContent('#auth-status'))?.trim() || '';
  assert(readback === 'Authenticated Relay session', 'Relay fixture did not enter its protected session');
  const cookie = (await page.context().cookies()).find((candidate) => candidate.name === 'relay_session');
  assert(cookie?.httpOnly === true && cookie.sameSite === 'Strict', 'Relay fixture session cookie lost its HttpOnly/SameSite boundary');
  return {
    cookie: { httpOnly: true, name: cookie.name, sameSite: 'Strict' },
    method: 'real-http-form-post',
    readback,
  };
}

function createHarness(agentId: string): AgentHarness {
  return { agentId, events: [], sequence: 0 };
}

function contextFor(harness: AgentHarness, label: string): ToolContext {
  harness.sequence += 1;
  return {
    workingDirectory: process.cwd(),
    workspace: process.cwd(),
    sessionId: CONVERSATION_ID,
    runId: RUN_ID,
    turnId: `turn-${harness.agentId}`,
    agentId: harness.agentId,
    currentToolCallId: `${harness.agentId}:${label}:${harness.sequence}`,
    abortSignal: new AbortController().signal,
    requestPermission: async () => true,
    executionIntent: {
      browserSessionMode: 'desktop',
      preferBrowserSession: true,
      allowBrowserAutomation: true,
      browserSessionSnapshot: { ready: true },
    },
    emit(type, data) {
      if (type === 'surface_execution') harness.events.push(data as SurfaceExecutionEventV1);
    },
  };
}

async function execute(
  harness: AgentHarness,
  label: string,
  params: Record<string, unknown>,
): Promise<ToolExecutionResult> {
  return browserActionTool.execute({ ...params, engine: 'relay' }, contextFor(harness, label));
}

async function requireSuccess(
  harness: AgentHarness,
  label: string,
  params: Record<string, unknown>,
): Promise<ToolExecutionResult> {
  const result = await execute(harness, label, params);
  if (!result.success) throw new Error(`${harness.agentId} ${label} failed (${errorCode(result)}): ${result.error}`);
  return result;
}

function observation(result: ToolExecutionResult): SurfaceObservationV1 {
  const value = result.metadata?.surfaceObservationV1 as SurfaceObservationV1 | undefined;
  assert(value?.stateId && Array.isArray(value.elementRefs), 'Relay result did not include a Surface observation');
  return value;
}

function browserElement(
  value: SurfaceObservationV1,
  predicate: (element: Extract<SurfaceElementRefV1, { kind: 'browser-element' }>) => boolean,
  label: string,
): Extract<SurfaceElementRefV1, { kind: 'browser-element' }> {
  const element = value.elementRefs.find((candidate): candidate is Extract<SurfaceElementRefV1, { kind: 'browser-element' }> => (
    candidate.kind === 'browser-element' && predicate(candidate)
  ));
  assert(element, `Relay observation did not include ${label}; elements=${value.elementRefs
    .map((candidate) => candidate.kind === 'browser-element' ? `${candidate.role}:${candidate.name}` : candidate.kind)
    .join(',') || 'none'}`);
  return element;
}

function chromeArgs(options: {
  fixtureUrl: string;
  port: number;
  profileDir: string;
  visible: boolean;
}): string[] {
  return [
    ...(options.visible ? [] : ['--headless=new']),
    '--disable-gpu',
    '--disable-background-networking',
    '--disable-sync',
    '--disable-component-update',
    '--no-first-run',
    '--no-default-browser-check',
    '--enable-unsafe-extension-debugging',
    `--user-data-dir=${options.profileDir}`,
    '--remote-debugging-address=127.0.0.1',
    `--remote-debugging-port=${options.port}`,
    options.fixtureUrl,
  ];
}

async function startRelayChrome(options: {
  fixtureUrl: string;
  visible: boolean;
}): Promise<RelayChromeSession> {
  const executable = getSystemChromeExecutable();
  ensureSystemChromeAvailable(executable);
  const port = await getFreePort();
  const profileDir = mkdtempSync(join(tmpdir(), 'surface-relay-chrome-'));
  let logs = '';
  const append = (chunk: Buffer) => {
    logs += chunk.toString();
    if (logs.length > 20_000) logs = logs.slice(-20_000);
  };
  const chrome = spawn(executable, chromeArgs({
    fixtureUrl: options.fixtureUrl,
    port,
    profileDir,
    visible: options.visible,
  }), { stdio: ['ignore', 'pipe', 'pipe'] });
  chrome.stdout.on('data', append);
  chrome.stderr.on('data', append);

  try {
    const browser = await connectToSystemChrome(port, chrome, () => logs, 15_000);
    const context = browser.contexts()[0];
    assert(context, 'System Chrome did not expose its default browser context');
    const fixturePage = await waitFor(
      () => context.pages(),
      (pages) => pages.some((page) => page.url() === options.fixtureUrl),
      10_000,
      'the fixture tab',
    ).then((pages) => pages.find((page) => page.url() === options.fixtureUrl));
    assert(fixturePage, 'Fixture tab disappeared before extension loading');
    await fixturePage.waitForLoadState('domcontentloaded');
    const rootCdp = await browser.newBrowserCDPSession();
    const extensionPath = resolve('resources/browser-relay-extension');
    const loaded = await rootCdp.send('Extensions.loadUnpacked', { path: extensionPath }) as { id?: string };
    assert(typeof loaded.id === 'string' && loaded.id.length > 0, 'Chrome did not return the unpacked extension id');
    return {
      browser,
      chrome,
      context,
      executable,
      extensionId: loaded.id,
      extensionPath,
      fixturePage,
      logs: () => logs,
      port,
      profileDir,
      rootCdp,
    };
  } catch (error) {
    await closeSystemChromeSession({ chrome, profileDir }).catch(() => undefined);
    throw error;
  }
}

async function extensionWorker(context: BrowserContext, extensionId: string): Promise<Worker> {
  const prefix = `chrome-extension://${extensionId}/`;
  return waitFor(
    () => context.serviceWorkers(),
    (workers) => workers.some((worker) => worker.url().startsWith(prefix)),
    10_000,
    'the Relay extension service worker',
  ).then((workers) => workers.find((worker) => worker.url().startsWith(prefix)) as Worker);
}

async function extensionStatus(worker: Worker): Promise<Record<string, unknown>> {
  return worker.evaluate(async () => {
    const workerGlobal = globalThis as typeof globalThis & {
      getPopupStatus?: () => Promise<Record<string, unknown>>;
    };
    if (typeof workerGlobal.getPopupStatus !== 'function') {
      throw new Error('Relay worker does not expose getPopupStatus');
    }
    return workerGlobal.getPopupStatus();
  }) as Promise<Record<string, unknown>>;
}

async function nativePlacement(worker: Worker, targetUrl: string): Promise<NativePlacement> {
  const placement = await worker.evaluate(async (url) => {
    const chromeApi = (globalThis as typeof globalThis & { chrome: ExtensionChromeApi }).chrome;
    const tabs = await chromeApi.tabs.query({});
    const tab = tabs.find((candidate: { url?: string }) => candidate.url === url);
    if (!tab) return null;
    return {
      tabId: tab.id,
      windowId: tab.windowId,
      index: tab.index,
      pinned: Boolean(tab.pinned),
      active: Boolean(tab.active),
    };
  }, targetUrl) as NativePlacement | null;
  assert(placement && Number.isInteger(placement.tabId), `Extension could not locate fixture tab ${targetUrl}`);
  return placement;
}

async function pinAndActivateFixture(worker: Worker, targetUrl: string): Promise<NativePlacement> {
  await worker.evaluate(async (url) => {
    const chromeApi = (globalThis as typeof globalThis & { chrome: ExtensionChromeApi }).chrome;
    const tabs = await chromeApi.tabs.query({});
    const tab = tabs.find((candidate: { url?: string }) => candidate.url === url);
    if (!tab) throw new Error(`fixture tab not found: ${url}`);
    await chromeApi.tabs.update(tab.id, { active: true, pinned: true });
    await chromeApi.windows.update(tab.windowId, { focused: true });
  }, targetUrl);
  return nativePlacement(worker, targetUrl);
}

function samePlacement(actual: NativePlacement, expected: NativePlacement): boolean {
  return actual.tabId === expected.tabId
    && actual.windowId === expected.windowId
    && actual.index === expected.index
    && actual.pinned === expected.pinned
    && actual.active === expected.active;
}

class AttachedTargetSession {
  private nextId = 0;
  private readonly pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  private readonly onMessage = (event: { sessionId?: string; message?: string }) => {
    if (event.sessionId !== this.sessionId || typeof event.message !== 'string') return;
    const response = JSON.parse(event.message) as {
      id?: number;
      result?: unknown;
      error?: { message?: string };
    };
    if (!response.id) return;
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    clearTimeout(pending.timer);
    if (response.error) pending.reject(new Error(response.error.message || 'Popup CDP command failed'));
    else pending.resolve(response.result);
  };

  private constructor(
    private readonly root: CDPSession,
    private readonly sessionId: string,
  ) {
    root.on('Target.receivedMessageFromTarget', this.onMessage);
  }

  static async attach(root: CDPSession, targetId: string): Promise<AttachedTargetSession> {
    const attached = await root.send('Target.attachToTarget', { targetId, flatten: false }) as { sessionId?: string };
    assert(attached.sessionId, 'Chrome did not attach to the Relay popup target');
    const session = new AttachedTargetSession(root, attached.sessionId);
    await session.send('Runtime.enable');
    await session.send('Page.enable');
    return session;
  }

  async send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = ++this.nextId;
    const response = new Promise<T>((resolveResponse, rejectResponse) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectResponse(new Error(`Popup CDP command timed out: ${method}`));
      }, 5_000);
      this.pending.set(id, {
        resolve: (value) => resolveResponse(value as T),
        reject: rejectResponse,
        timer,
      });
    });
    try {
      await this.root.send('Target.sendMessageToTarget', {
        sessionId: this.sessionId,
        message: JSON.stringify({ id, method, params }),
      });
    } catch (error) {
      const pending = this.pending.get(id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      }
    }
    return response;
  }

  async evaluate<T>(expression: string): Promise<T> {
    const evaluated = await this.send<{
      result?: { value?: unknown };
      exceptionDetails?: { text?: string };
    }>('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (evaluated.exceptionDetails) {
      throw new Error(evaluated.exceptionDetails.text || 'Relay popup evaluation failed');
    }
    return evaluated.result?.value as T;
  }

  async screenshot(path: string): Promise<void> {
    const captured = await this.send<{ data?: string }>('Page.captureScreenshot', { format: 'png' });
    assert(captured.data, 'Chrome did not capture the Relay approval popup');
    writeFileSync(path, Buffer.from(captured.data, 'base64'));
  }

  async dispose(): Promise<void> {
    this.root.off('Target.receivedMessageFromTarget', this.onMessage);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Relay popup target detached'));
    }
    this.pending.clear();
    await this.root.send('Target.detachFromTarget', { sessionId: this.sessionId }).catch(() => undefined);
  }
}

async function closeExistingPopups(root: CDPSession, extensionId: string): Promise<void> {
  const targets = await root.send('Target.getTargets') as {
    targetInfos?: Array<{ targetId: string; url: string }>;
  };
  await Promise.all((targets.targetInfos || [])
    .filter((target) => target.url === `chrome-extension://${extensionId}/popup.html`)
    .map((target) => root.send('Target.closeTarget', { targetId: target.targetId }).catch(() => undefined)));
}

async function openPopupTarget(
  session: RelayChromeSession,
  worker: Worker,
): Promise<AttachedTargetSession> {
  await closeExistingPopups(session.rootCdp, session.extensionId);
  await worker.evaluate(async () => {
    const chromeApi = (globalThis as typeof globalThis & { chrome: ExtensionChromeApi }).chrome;
    await chromeApi.action.openPopup();
  });
  const popupUrl = `chrome-extension://${session.extensionId}/popup.html`;
  const target = await waitFor(
    async () => {
      const targets = await session.rootCdp.send('Target.getTargets') as {
        targetInfos?: Array<{ targetId: string; url: string }>;
      };
      return (targets.targetInfos || []).find((candidate) => candidate.url === popupUrl) || null;
    },
    (candidate) => candidate !== null,
    5_000,
    'the real Relay popup target',
  );
  assert(target, 'Relay popup target was not available');
  return AttachedTargetSession.attach(session.rootCdp, target.targetId);
}

const READ_POPUP_EXPRESSION = `(() => ({
  status: document.getElementById('status')?.textContent || '',
  origin: document.getElementById('pendingOrigin')?.textContent || '',
  actions: (document.getElementById('pendingActions')?.textContent || '').split(',').map((value) => value.trim()).filter(Boolean),
  agentId: document.getElementById('pendingAgent')?.textContent || '',
  conversationId: document.getElementById('pendingConversation')?.textContent || '',
  surfaceSessionId: document.getElementById('pendingSession')?.textContent || '',
  approveDisabled: Boolean(document.getElementById('approve')?.disabled),
  returnDisabled: Boolean(document.getElementById('returnLease')?.disabled),
  message: document.getElementById('message')?.textContent || '',
}))()`;

async function popupSnapshot(popup: AttachedTargetSession): Promise<PopupSnapshot> {
  return waitFor(
    () => popup.evaluate<PopupSnapshot>(READ_POPUP_EXPRESSION),
    (snapshot) => snapshot.status.length > 0,
    3_000,
    'Relay popup state',
  );
}

function safePopupEvidence(
  mode: ApprovalMode,
  label: string,
  snapshot: PopupSnapshot,
  screenshotPath?: string,
): PopupEvidence {
  return {
    mode,
    label,
    ...(screenshotPath
      ? {
          screenshotPath,
          screenshotSha256: sha256(screenshotPath),
          screenshotBytes: statSync(screenshotPath).size,
        }
      : {}),
    snapshot: {
      status: snapshot.status,
      origin: snapshot.origin,
      actions: snapshot.actions,
      agentId: snapshot.agentId,
      conversationId: snapshot.conversationId,
      surfaceSessionPresent: snapshot.surfaceSessionId.length > 0,
      approveDisabled: snapshot.approveDisabled,
      returnDisabled: snapshot.returnDisabled,
      message: snapshot.message,
    },
  };
}

async function approveLease(options: {
  actionScopes: readonly string[];
  agentId: string;
  label: string;
  launchPromise: Promise<ToolExecutionResult>;
  mode: ApprovalMode;
  origin: string;
  outputDir: string;
  session: RelayChromeSession;
  ttlMs: number;
  worker: Worker;
}): Promise<{ evidence: PopupEvidence; launch: ToolExecutionResult }> {
  const pending = await waitFor(
    () => extensionStatus(options.worker),
    (status) => Boolean(status.pendingLease),
    5_000,
    `${options.label} pending Relay lease`,
  );
  const pendingLease = pending.pendingLease as Record<string, unknown>;
  assert(pendingLease.agentId === options.agentId, `${options.label} pending lease disclosed the wrong Agent`);
  assert(pendingLease.conversationId === CONVERSATION_ID, `${options.label} pending lease disclosed the wrong conversation`);
  assert(pendingLease.origin === options.origin, `${options.label} pending lease disclosed the wrong origin`);
  assert(
    JSON.stringify([...(pendingLease.actions as string[] || [])].sort()) === JSON.stringify([...options.actionScopes].sort()),
    `${options.label} pending lease disclosed the wrong action set`,
  );

  if (options.mode === 'operator') {
    console.error(`Approve ${options.label} in the visible Agent Neo Browser Relay popup within ${options.ttlMs}ms.`);
    let launch: ToolExecutionResult;
    try {
      launch = await options.launchPromise;
    } catch (error) {
      throw new RelayAcceptanceBlockedError(`Operator approval did not complete: ${sanitizeMessage(error)}`);
    }
    if (!launch.success) {
      throw new RelayAcceptanceBlockedError(`Operator approval failed: ${launch.error || errorCode(launch)}`);
    }
    return {
      launch,
      evidence: {
        mode: 'operator',
        label: options.label,
        snapshot: {
          status: String(pending.connectionState || 'pending'),
          origin: String(pendingLease.origin || ''),
          actions: pendingLease.actions as string[] || [],
          agentId: String(pendingLease.agentId || ''),
          conversationId: String(pendingLease.conversationId || ''),
          surfaceSessionPresent: Boolean(pendingLease.surfaceSessionId),
          approveDisabled: false,
          returnDisabled: true,
          message: 'approved by operator',
        },
      },
    };
  }

  let popup: AttachedTargetSession | null = null;
  try {
    popup = await openPopupTarget(options.session, options.worker);
    const snapshot = await waitFor(
      () => popup?.evaluate<PopupSnapshot>(READ_POPUP_EXPRESSION) as Promise<PopupSnapshot>,
      (candidate) => !candidate.approveDisabled && candidate.surfaceSessionId.length > 0,
      5_000,
      `${options.label} popup approval controls`,
    );
    assert(snapshot.status.includes('connected'), `${options.label} popup did not show a connected protocol`);
    assert(snapshot.origin === options.origin, `${options.label} popup origin was ${snapshot.origin}`);
    assert(snapshot.agentId === options.agentId, `${options.label} popup Agent was ${snapshot.agentId}`);
    assert(snapshot.conversationId === CONVERSATION_ID, `${options.label} popup conversation was ${snapshot.conversationId}`);
    assert(
      JSON.stringify([...snapshot.actions].sort()) === JSON.stringify([...options.actionScopes].sort()),
      `${options.label} popup action set did not match the requested lease`,
    );
    const screenshotPath = join(options.outputDir, `${options.label}-approval-popup.png`);
    await popup.screenshot(screenshotPath);
    const evidence = safePopupEvidence('auto', options.label, snapshot, screenshotPath);
    await popup.evaluate<boolean>("document.getElementById('approve').click(); true");
    const launch = await options.launchPromise;
    if (!launch.success) throw new Error(`${options.label} launch failed (${errorCode(launch)}): ${launch.error}`);
    return { evidence, launch };
  } catch (error) {
    void options.launchPromise.catch(() => undefined);
    if (error instanceof RelayAcceptanceBlockedError) throw error;
    throw new RelayAcceptanceBlockedError(
      `Automated Relay popup approval is unavailable for ${options.label}: ${sanitizeMessage(error)}. `
      + 'Re-run with --visible --approval operator for explicit human approval.',
    );
  } finally {
    await popup?.dispose().catch(() => undefined);
  }
}

async function clickPopupControl(options: {
  buttonId: 'reconnect' | 'returnLease';
  session: RelayChromeSession;
  worker: Worker;
}): Promise<PopupSnapshot> {
  let popup: AttachedTargetSession | null = null;
  try {
    popup = await openPopupTarget(options.session, options.worker);
    const snapshot = await popupSnapshot(popup);
    if (options.buttonId === 'returnLease') {
      assert(!snapshot.returnDisabled, 'Relay popup did not offer tab return');
    }
    await popup.evaluate<boolean>(`document.getElementById('${options.buttonId}').click(); true`);
    return snapshot;
  } finally {
    await popup?.dispose().catch(() => undefined);
  }
}

function saveRelayScreenshot(result: ToolExecutionResult, outputDir: string, basename = 'relay-business'): {
  path: string;
  sha256: string;
  bytes: number;
} {
  const imageBase64 = result.metadata?.imageBase64;
  assert(typeof imageBase64 === 'string' && imageBase64.length > 100, 'Relay screenshot did not include image bytes');
  const mimeType = result.metadata?.imageMimeType === 'image/jpeg' ? 'image/jpeg' : 'image/png';
  const path = join(outputDir, `${basename}.${mimeType === 'image/jpeg' ? 'jpg' : 'png'}`);
  writeFileSync(path, Buffer.from(imageBase64, 'base64'));
  assert(statSync(path).size > 0, 'Relay screenshot file is empty');
  return { path, sha256: sha256(path), bytes: statSync(path).size };
}

async function returnViaPopupAndVerify(options: {
  expected: NativePlacement;
  fixtureUrl: string;
  session: RelayChromeSession;
  worker: Worker;
}): Promise<void> {
  await options.session.fixturePage.bringToFront();
  await clickPopupControl({
    buttonId: 'returnLease',
    session: options.session,
    worker: options.worker,
  });
  await waitFor(
    () => nativePlacement(options.worker, options.fixtureUrl),
    (placement) => samePlacement(placement, options.expected),
    5_000,
    'the Relay tab to return to its exact original placement',
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (hasFlag(args, 'help')) {
    usage();
    return;
  }
  const campaignProof = surfaceAcceptanceCampaignProofFields();
  const approvalOption = getStringOption(args, 'approval') || 'auto';
  assert(approvalOption === 'auto' || approvalOption === 'operator', '--approval must be auto or operator');
  const approvalMode = approvalOption as ApprovalMode;
  if (approvalMode === 'operator') {
    assert(hasFlag(args, 'visible'), '--approval operator requires --visible');
  }
  const outputDir = resolve(getStringOption(args, 'out')
    || mkdtempSync(join(tmpdir(), 'surface-execution-relay-proof-')));
  mkdirSync(outputDir, { recursive: true });
  const uploadInputDir = mkdtempSync(join(tmpdir(), 'surface-relay-upload-'));
  const uploadFileName = 'relay-upload-fixture.txt';
  const uploadFilePath = join(uploadInputDir, uploadFileName);
  const uploadContents = 'Agent Neo Relay upload acceptance fixture\n';
  writeFileSync(uploadFilePath, uploadContents, 'utf8');
  const uploadFileBytes = statSync(uploadFilePath).size;
  const uploadFileSha256 = sha256(uploadFilePath);

  resetRelayBrowserProviderAdapterForTests();
  resetSurfaceExecutionRuntimeForTests();
  resetApplicationRunRegistryForTests();
  const registry = getApplicationRunRegistry();
  registry.start({ runId: RUN_ID, sessionId: CONVERSATION_ID, workspace: process.cwd() });
  const runtime = getSurfaceExecutionRuntime();
  const adapter = getRelayBrowserProviderAdapter();
  const mainHarness = createHarness('relay-agent-main');
  const expiryHarness = createHarness('relay-agent-expiry');
  const orphanHarness = createHarness('relay-agent-orphan');
  const attackerHarness = createHarness('relay-agent-attacker');
  const fixture = await startFixtureServer();
  let chromeSession: RelayChromeSession | null = null;
  const popupEvidence: PopupEvidence[] = [];
  const startedAt = Date.now();

  try {
    const started = await browserRelayService.ensureStarted(RELAY_PORT);
    assert(started.port === RELAY_PORT, `Relay port ${RELAY_PORT} was unavailable; service selected ${started.port}`);
    const mismatchEvidence = await verifyProtocolMismatchBlocked(RELAY_PORT);
    chromeSession = await startRelayChrome({
      fixtureUrl: fixture.url,
      visible: hasFlag(args, 'visible'),
    });
    let worker = await extensionWorker(chromeSession.context, chromeSession.extensionId);
    const connectedState = await waitFor(
      () => browserRelayService.getState(),
      (state) => state.status === 'connected',
      10_000,
      'Relay protocol handshake',
    );
    assert(connectedState.authToken === null, 'Relay state exposed raw pairing material');
    const doctorEvidence = checkBrowserRelay(connectedState);
    assert(
      doctorEvidence.length === 1 && doctorEvidence[0]?.status === 'pass',
      `Browser Relay doctor did not report a healthy protocol 2.2 connection: ${JSON.stringify(doctorEvidence)}`,
    );
    withoutCanary(doctorEvidence, 'Relay doctor evidence');
    const handshakeStatus = await extensionStatus(worker);
    assert(handshakeStatus.handshakeComplete === true, 'Extension did not complete the Relay handshake');
    assert(BROWSER_RELAY_CAPABILITIES_V2.length > 0, 'Relay capability contract is empty');
    const authenticationEvidence = await authenticateExistingRelaySession(
      chromeSession.fixturePage,
      fixture.url,
    );
    // Playwright auto-dismisses page dialogs when no listener is registered. Keep
    // the acceptance harness passive so the Relay extension remains the only
    // component allowed to apply the explicit accept/dismiss policy.
    const nativeDialogEvidence: Array<{ type: string; messageLength: number }> = [];
    chromeSession.fixturePage.on('dialog', (dialog) => {
      nativeDialogEvidence.push({
        type: dialog.type(),
        messageLength: dialog.message().length,
      });
    });

    const beforeLease = await execute(mainHarness, 'before-lease', { action: 'get_content' });
    const beforeLeaseCode = assertFailureCode(beforeLease, 'Relay action before approval', [
      'BROWSER_TAB_BORROW_REQUIRED',
      'relay_action_failed',
    ]);
    const beforeLeaseWrite = await execute(mainHarness, 'before-lease-write', {
      action: 'navigate',
      url: fixture.url,
    });
    const beforeLeaseWriteCode = assertFailureCode(
      beforeLeaseWrite,
      'Relay mutation before approval',
      ['BROWSER_TAB_BORROW_REQUIRED', 'relay_action_failed'],
    );

    await chromeSession.fixturePage.bringToFront();
    const original = await pinAndActivateFixture(worker, fixture.url);
    const mainLaunchPromise = execute(mainHarness, 'launch', {
      action: 'launch',
      relayDomainScopes: [fixture.origin],
      relayActionScopes: [...MAIN_ACTION_SCOPES],
      relayLeaseTtlMs: LONG_LEASE_TTL_MS,
    });
    const mainApproval = await approveLease({
      actionScopes: MAIN_ACTION_SCOPES,
      agentId: mainHarness.agentId,
      label: 'main',
      launchPromise: mainLaunchPromise,
      mode: approvalMode,
      origin: fixture.origin,
      outputDir,
      session: chromeSession,
      ttlMs: LONG_LEASE_TTL_MS,
      worker,
    });
    popupEvidence.push(mainApproval.evidence);
    withoutCanary(mainApproval.launch, 'Relay launch result');
    const authenticatedSession = await requireSuccess(mainHarness, 'authenticated-session-readback', {
      action: 'get_content',
    });
    assert(
      authenticatedSession.output?.includes(authenticationEvidence.readback),
      'Relay did not reuse the browser tab\'s existing authenticated session',
    );

    const mainIdentity = surfaceIdentityFromToolContext(contextFor(mainHarness, 'binding'));
    assert(mainIdentity, 'Main Relay identity was unavailable');
    const mainBinding = adapter.getBinding(mainIdentity);
    assert(mainBinding, 'Main Relay binding was unavailable after approval');
    assert(mainBinding.target.origin === fixture.origin, 'Approved Relay target origin changed');
    assert(mainBinding.lease.domainScopes.length === 1
      && mainBinding.lease.domainScopes[0] === `origin:${fixture.origin}`,
    'Host lease widened the approved domain scope');
    assert(
      JSON.stringify([...mainBinding.lease.actionScopes].sort()) === JSON.stringify([...MAIN_ACTION_SCOPES].sort()),
      'Host lease widened or changed the approved action scope',
    );
    const agentPlacement = await nativePlacement(worker, fixture.url);
    assert(agentPlacement.tabId === original.tabId, 'Relay approved a different tab than the popup disclosed');
    assert(agentPlacement.windowId !== original.windowId, 'Relay did not move the approved tab into an Agent Window');
    assert(agentPlacement.pinned === false, 'Agent Window retained the user-window pinned state');

    const actionDenied = await execute(mainHarness, 'action-scope-denied', {
      action: 'press_key',
      key: 'Enter',
    });
    const actionDeniedCode = assertFailureCode(actionDenied, 'Out-of-scope Relay action', [
      'RELAY_ACTION_NOT_ALLOWED',
      'SURFACE_APPROVAL_INVALID',
      'relay_action_failed',
    ]);
    const domainDenied = await execute(mainHarness, 'domain-scope-denied', {
      action: 'navigate',
      url: fixture.url.replace('127.0.0.1', 'localhost'),
    });
    const domainDeniedCode = assertFailureCode(domainDenied, 'Out-of-scope Relay domain', [
      'RELAY_DOMAIN_NOT_ALLOWED',
      'SURFACE_APPROVAL_INVALID',
      'relay_action_failed',
    ]);
    assert(chromeSession.fixturePage.url() === fixture.url, 'Blocked domain navigation mutated the leased tab');

    const axResult = await requireSuccess(mainHarness, 'ax', { action: 'get_a11y_snapshot' });
    assert(observation(axResult).elementRefs.length >= 2, 'Relay AX snapshot returned no interactive refs');
    const domResult = await requireSuccess(mainHarness, 'dom', { action: 'get_dom_snapshot' });
    const initialObservation = observation(domResult);
    const secretRef = browserElement(
      initialObservation,
      (element) => element.role?.toLowerCase() === 'textbox'
        && element.name?.includes('Relay secret') === true,
      'the Relay secret textbox',
    );
    const staleCommitRef = browserElement(
      initialObservation,
      (element) => element.role?.toLowerCase() === 'button'
        && element.name?.includes('Commit relay result') === true,
      'the Relay commit button',
    );
    const liveBindingBeforeType = adapter.getBinding(mainIdentity);
    assert(liveBindingBeforeType, 'Relay binding disappeared before the first ref-based mutation');
    const runtimeBindingBeforeType = runtime.getBrowserBinding({
      identity: mainIdentity,
      provider: 'browser-relay',
      surfaceSessionId: liveBindingBeforeType.surfaceSessionId,
      predecessorStateId: liveBindingBeforeType.predecessorStateId,
    });
    assert(
      runtimeBindingBeforeType?.observation.stateId === initialObservation.stateId,
      'Tool-returned Relay observation does not match the current Host observation',
    );
    assert(
      runtimeBindingBeforeType.observation.elementRefs.some((element) => element.ref === secretRef.ref),
      'Tool-returned Relay element ref is absent from the current Host observation',
    );
    const typed = await requireSuccess(mainHarness, 'type-canary', {
      action: 'type',
      targetRef: secretRef,
      text: CANARY,
    });
    withoutCanary(typed, 'Relay type result');

    const staleResult = await execute(mainHarness, 'stale-ref', {
      action: 'click',
      targetRef: staleCommitRef,
    });
    const staleCode = assertFailureCode(staleResult, 'Superseded Relay element ref', [
      'SURFACE_STATE_STALE',
      'SURFACE_TARGET_REVISION_CHANGED',
      'SURFACE_ELEMENT_REF_NOT_FOUND',
      'RELAY_TARGET_CHANGED',
      'relay_action_failed',
    ]);
    const refreshedDom = observation(await requireSuccess(mainHarness, 'dom-refresh', {
      action: 'get_dom_snapshot',
    }));
    const uploadRef = browserElement(
      refreshedDom,
      (element) => element.selectorFallback === '#upload'
        || element.name?.includes('Relay upload') === true,
      'the Relay upload input',
    );
    const uploaded = await requireSuccess(mainHarness, 'upload-file', {
      action: 'upload_file',
      targetRef: uploadRef,
      uploadFilePath,
    });
    withoutCanary(uploaded, 'Relay upload result');
    assert(!JSON.stringify(uploaded).includes(uploadFilePath), 'Relay upload result exposed the absolute approved path');
    const uploadArtifact = uploaded.metadata?.browserArtifact as {
      kind?: string;
      name?: string;
      size?: number;
      sha256?: string;
      artifactPath?: string;
    } | undefined;
    assert(uploadArtifact?.kind === 'upload', 'Relay upload did not project an upload artifact');
    assert(uploadArtifact.name === uploadFileName, 'Relay upload artifact returned the wrong basename');
    assert(uploadArtifact.size === uploadFileBytes, 'Relay upload artifact returned the wrong byte count');
    assert(uploadArtifact.sha256 === uploadFileSha256, 'Relay upload artifact returned the wrong digest');
    assert(uploadArtifact.artifactPath === `.../${uploadFileName}`, 'Relay upload artifact exposed an unsafe path');
    writeFileSync(join(outputDir, uploadFileName), uploadContents, 'utf8');
    const uploadReadback = await requireSuccess(mainHarness, 'upload-readback', {
      action: 'get_content',
    });
    assert(
      uploadReadback.output?.includes(`Relay upload verified: ${uploadFileBytes} bytes`),
      'Relay upload action succeeded without page-level file size readback',
    );
    const clipboardDeferred = await execute(mainHarness, 'clipboard-defer', {
      action: 'read_clipboard',
    });
    const clipboardDeferredCode = assertFailureCode(
      clipboardDeferred,
      'Relay clipboard transport boundary',
      ['SURFACE_CAPABILITY_UNSUPPORTED'],
    );
    const downloadDeferred = await execute(mainHarness, 'download-defer', {
      action: 'wait_for_download',
      selector: '#commit',
    });
    const downloadDeferredCode = assertFailureCode(
      downloadDeferred,
      'Relay download cleanup boundary',
      ['SURFACE_CAPABILITY_UNSUPPORTED', 'relay_action_failed'],
    );
    assert(
      downloadDeferred.metadata?.deferReason === 'relay_download_cancel_cleanup_unavailable'
        || downloadDeferred.metadata?.recovery && typeof downloadDeferred.metadata.recovery === 'object',
      'Relay download defer did not include a stable recovery/defer projection',
    );

    const hoverDom = observation(await requireSuccess(mainHarness, 'dom-before-hover', {
      action: 'get_dom_snapshot',
    }));
    const hoverRef = browserElement(
      hoverDom,
      (element) => element.role?.toLowerCase() === 'button'
        && element.name?.includes('Hover target') === true,
      'the Relay hover target',
    );
    await requireSuccess(mainHarness, 'hover', {
      action: 'hover',
      targetRef: hoverRef,
    });
    const hoverReadback = await requireSuccess(mainHarness, 'hover-readback', {
      action: 'get_content',
    });
    assert(
      hoverReadback.output?.includes('Relay hover verified'),
      'Relay hover action succeeded without page-level business-state readback',
    );
    const hoverScreenshotResult = await requireSuccess(mainHarness, 'hover-screenshot', {
      action: 'screenshot',
      fullPage: true,
      analyze: false,
    });
    withoutCanary(hoverScreenshotResult, 'Relay hover screenshot result');
    const hoverScreenshot = saveRelayScreenshot(hoverScreenshotResult, outputDir, 'relay-hover');

    const dragDom = observation(await requireSuccess(mainHarness, 'dom-before-drag', {
      action: 'get_dom_snapshot',
    }));
    const dragSourceRef = browserElement(
      dragDom,
      (element) => element.role?.toLowerCase() === 'button'
        && element.name?.includes('Drag source') === true,
      'the Relay drag source',
    );
    const dragDestinationRef = browserElement(
      dragDom,
      (element) => element.role?.toLowerCase() === 'button'
        && element.name?.includes('Drag destination') === true,
      'the Relay drag destination',
    );
    await requireSuccess(mainHarness, 'drag', {
      action: 'drag',
      targetRef: dragSourceRef,
      destinationTargetRef: dragDestinationRef,
    });
    const dragReadback = await requireSuccess(mainHarness, 'drag-readback', {
      action: 'get_content',
    });
    assert(
      dragReadback.output?.includes('Relay drag verified'),
      'Relay drag action succeeded without page-level business-state readback',
    );
    const dragScreenshotResult = await requireSuccess(mainHarness, 'drag-screenshot', {
      action: 'screenshot',
      fullPage: true,
      analyze: false,
    });
    withoutCanary(dragScreenshotResult, 'Relay drag screenshot result');
    const dragScreenshot = saveRelayScreenshot(dragScreenshotResult, outputDir, 'relay-drag');

    const dialogAcceptDom = observation(await requireSuccess(mainHarness, 'dom-before-dialog-accept', {
      action: 'get_dom_snapshot',
    }));
    const dialogAcceptRef = browserElement(
      dialogAcceptDom,
      (element) => element.role?.toLowerCase() === 'button'
        && element.name?.includes('Open confirmation') === true,
      'the Relay dialog trigger for accept',
    );
    const dialogAcceptClick = execute(mainHarness, 'dialog-open-accept', {
      action: 'click',
      targetRef: dialogAcceptRef,
    });
    const pendingAcceptDialogResult = await waitFor(
      () => requireSuccess(mainHarness, 'dialog-state-accept', { action: 'get_dialog_state' }),
      (result) => (
        (result.metadata?.browserDialogState as { pending?: unknown } | undefined)?.pending === true
      ),
      3_000,
      'the Relay confirm dialog to enter the default-pause state',
    );
    const pendingAcceptDialog = pendingAcceptDialogResult.metadata?.browserDialogState as {
      pending?: boolean;
      type?: string;
      messageLength?: number;
      defaultPolicy?: string;
    };
    assert(
      pendingAcceptDialog.type === 'confirm'
        && pendingAcceptDialog.defaultPolicy === 'pause'
        && Number.isSafeInteger(pendingAcceptDialog.messageLength)
        && (pendingAcceptDialog.messageLength || 0) > 0,
      'Relay dialog state did not expose safe default-pause confirm metadata',
    );
    const acceptedDialogResult = await requireSuccess(mainHarness, 'dialog-accept', {
      action: 'handle_dialog',
      dialogAction: 'accept',
    });
    const dialogAcceptClickResult = await dialogAcceptClick;
    assert(
      dialogAcceptClickResult.success,
      `Relay dialog accept trigger did not complete after handling (${errorCode(dialogAcceptClickResult)}): ${dialogAcceptClickResult.error}`,
    );
    const acceptedDialog = acceptedDialogResult.metadata?.browserDialogState as {
      pending?: boolean;
      handled?: boolean;
      action?: string;
      defaultPolicy?: string;
    } | undefined;
    assert(
      acceptedDialog?.pending === false
        && acceptedDialog.handled === true
        && acceptedDialog.action === 'accept'
        && acceptedDialog.defaultPolicy === 'pause',
      'Relay did not project confirmed accept handling under the default-pause policy',
    );
    const acceptedReadback = await requireSuccess(mainHarness, 'dialog-accept-readback', {
      action: 'get_content',
    });
    assert(
      acceptedReadback.output?.includes('Relay dialog accepted'),
      'Relay dialog accept succeeded without page-level business-state readback',
    );

    const dialogDismissDom = observation(await requireSuccess(mainHarness, 'dom-before-dialog-dismiss', {
      action: 'get_dom_snapshot',
    }));
    const dialogDismissRef = browserElement(
      dialogDismissDom,
      (element) => element.role?.toLowerCase() === 'button'
        && element.name?.includes('Open confirmation') === true,
      'the Relay dialog trigger for dismiss',
    );
    const dialogDismissClick = execute(mainHarness, 'dialog-open-dismiss', {
      action: 'click',
      targetRef: dialogDismissRef,
    });
    const pendingDismissDialogResult = await waitFor(
      () => requireSuccess(mainHarness, 'dialog-state-dismiss', { action: 'get_dialog_state' }),
      (result) => (
        (result.metadata?.browserDialogState as { pending?: unknown } | undefined)?.pending === true
      ),
      3_000,
      'the second Relay confirm dialog to enter the default-pause state',
    );
    const pendingDismissDialog = pendingDismissDialogResult.metadata?.browserDialogState as {
      pending?: boolean;
      type?: string;
      messageLength?: number;
      defaultPolicy?: string;
    };
    assert(
      pendingDismissDialog.type === 'confirm'
        && pendingDismissDialog.defaultPolicy === 'pause'
        && pendingDismissDialog.messageLength === pendingAcceptDialog.messageLength,
      'Relay dialog dismiss path did not preserve the safe default-pause metadata contract',
    );
    const dismissedDialogResult = await requireSuccess(mainHarness, 'dialog-dismiss', {
      action: 'handle_dialog',
      dialogAction: 'dismiss',
    });
    const dialogDismissClickResult = await dialogDismissClick;
    assert(
      dialogDismissClickResult.success,
      `Relay dialog dismiss trigger did not complete after handling (${errorCode(dialogDismissClickResult)}): ${dialogDismissClickResult.error}`,
    );
    const dismissedDialog = dismissedDialogResult.metadata?.browserDialogState as {
      pending?: boolean;
      handled?: boolean;
      action?: string;
      defaultPolicy?: string;
    } | undefined;
    assert(
      dismissedDialog?.pending === false
        && dismissedDialog.handled === true
        && dismissedDialog.action === 'dismiss'
        && dismissedDialog.defaultPolicy === 'pause',
      'Relay did not project confirmed dismiss handling under the default-pause policy',
    );
    const dialogReadback = await requireSuccess(mainHarness, 'dialog-dismiss-readback', {
      action: 'get_content',
    });
    const dialogBusinessReadback = 'Relay dialog accepted | Relay dialog dismissed';
    assert(
      dialogReadback.output?.includes(dialogBusinessReadback),
      'Relay dialog accept/dismiss succeeded without the combined page-level business-state readback',
    );
    const dialogScreenshotResult = await requireSuccess(mainHarness, 'dialog-screenshot', {
      action: 'screenshot',
      fullPage: true,
      analyze: false,
    });
    withoutCanary(dialogScreenshotResult, 'Relay dialog screenshot result');
    const dialogScreenshot = saveRelayScreenshot(dialogScreenshotResult, outputDir, 'relay-dialog');
    assert(
      nativeDialogEvidence.length === 2
        && nativeDialogEvidence.every((dialog) => (
          dialog.type === 'confirm'
          && dialog.messageLength === pendingAcceptDialog.messageLength
        )),
      `Relay acceptance harness did not observe exactly two native confirm dialogs: ${JSON.stringify(nativeDialogEvidence)}`,
    );

    const postUploadDom = observation(await requireSuccess(mainHarness, 'dom-after-upload', {
      action: 'get_dom_snapshot',
    }));
    const commitRef = browserElement(
      postUploadDom,
      (element) => element.role?.toLowerCase() === 'button'
        && element.name?.includes('Commit relay result') === true,
      'the refreshed Relay commit button',
    );
    await requireSuccess(mainHarness, 'commit', { action: 'click', targetRef: commitRef });
    const content = await requireSuccess(mainHarness, 'business-readback', { action: 'get_content' });
    assert(content.output?.includes(BUSINESS_RESULT), 'Relay action succeeded without business-state readback');

    const attacker = await execute(attackerHarness, 'cross-agent', { action: 'get_content' });
    const crossAgentCode = assertFailureCode(attacker, 'Cross-Agent Relay access', [
      'BROWSER_TAB_BORROW_REQUIRED',
      'SURFACE_TARGET_NOT_OWNED',
      'RELAY_LEASE_NOT_OWNED',
      'relay_action_failed',
    ]);
    const afterAttack = await requireSuccess(mainHarness, 'post-attack-readback', {
      action: 'get_content',
    });
    assert(afterAttack.output?.includes(BUSINESS_RESULT), 'Cross-Agent attempt changed the business state');

    const logResult = await requireSuccess(mainHarness, 'logs', { action: 'get_logs' });
    assert(
      /^[1-9]\d* redacted browser log entr/.test(logResult.output || ''),
      `Relay logs did not capture a redacted canary event: ${logResult.output}`,
    );
    withoutCanary(logResult, 'Relay log result');
    const logCursor = logResult.metadata?.surfaceBrowserLogCursorV1 as {
      entries?: Array<{ cursor?: number; source?: string; text?: string; url?: string }>;
      nextCursor?: number;
    } | undefined;
    assert(Number.isSafeInteger(logCursor?.nextCursor), 'Relay logs did not project a stable cursor');
    assert(
      logCursor?.entries?.some((entry) => entry.source === 'console'),
      'Relay logs did not project console metadata',
    );
    assert(
      logCursor?.entries?.some((entry) => (
        entry.source === 'network'
        && entry.text === 'request POST'
        && entry.url === `${fixture.origin}/network-proof`
      )),
      'Relay logs did not project query-free network request metadata',
    );
    const screenshotResult = await requireSuccess(mainHarness, 'screenshot', {
      action: 'screenshot',
      fullPage: true,
      analyze: false,
    });
    withoutCanary(screenshotResult, 'Relay screenshot result');
    const businessScreenshot = saveRelayScreenshot(screenshotResult, outputDir);

    const stopStartedAt = Date.now();
    await runtime.controlConversation({
      conversationId: CONVERSATION_ID,
      surfaceSessionId: mainBinding.surfaceSessionId,
      action: 'stop',
      reason: 'Relay acceptance stop and tab return',
    });
    const stopLatencyMs = Date.now() - stopStartedAt;
    assert(stopLatencyMs < 2_000, `Relay stop latency ${stopLatencyMs}ms exceeded 2000ms`);
    await waitFor(
      () => nativePlacement(worker, fixture.url),
      (placement) => samePlacement(placement, original),
      5_000,
      'normal Relay cleanup to restore the exact tab placement',
    );
    assert(browserRelayService.getState().attachedTabCount === 0, 'Host retained a Relay lease after stop cleanup');
    assert(adapter.getBinding(mainIdentity) === null, 'Relay adapter retained its binding after stop cleanup');
    const postStop = await execute(mainHarness, 'post-stop', { action: 'get_content' });
    const postStopCode = assertFailureCode(postStop, 'Relay action after stop', [
      'BROWSER_TAB_BORROW_REQUIRED',
      'SURFACE_SESSION_NOT_FOUND',
      'relay_action_failed',
    ]);

    await chromeSession.fixturePage.bringToFront();
    const expiryLaunchPromise = execute(expiryHarness, 'launch', {
      action: 'launch',
      relayDomainScopes: [fixture.origin],
      relayActionScopes: ['get_content', 'close', 'lease:return'],
      relayLeaseTtlMs: SHORT_LEASE_TTL_MS,
    });
    const expiryApproval = await approveLease({
      actionScopes: ['get_content', 'close', 'lease:return'],
      agentId: expiryHarness.agentId,
      label: 'expiry',
      launchPromise: expiryLaunchPromise,
      mode: approvalMode,
      origin: fixture.origin,
      outputDir,
      session: chromeSession,
      ttlMs: SHORT_LEASE_TTL_MS,
      worker,
    });
    popupEvidence.push(expiryApproval.evidence);
    const expiryIdentity = surfaceIdentityFromToolContext(contextFor(expiryHarness, 'binding'));
    assert(expiryIdentity, 'Expiry Relay identity was unavailable');
    const expiryBinding = adapter.getBinding(expiryIdentity);
    assert(expiryBinding, 'Expiry Relay binding was unavailable');
    const expiryAt = expiryBinding.lease.expiresAt;
    assert(typeof expiryAt === 'number', 'Expiry Relay binding did not expose a lease deadline');
    await new Promise((resolveDelay) => setTimeout(
      resolveDelay,
      Math.max(1, expiryAt - Date.now() + 150),
    ));
    const expired = await execute(expiryHarness, 'after-expiry', { action: 'get_content' });
    const expiryCode = assertFailureCode(expired, 'Expired Relay lease', [
      'BROWSER_TAB_BORROW_REQUIRED',
      'RELAY_LEASE_EXPIRED',
      'relay_action_failed',
    ]);
    await returnViaPopupAndVerify({
      expected: original,
      fixtureUrl: fixture.url,
      session: chromeSession,
      worker,
    });

    await chromeSession.fixturePage.bringToFront();
    const orphanLaunchPromise = execute(orphanHarness, 'launch', {
      action: 'launch',
      relayDomainScopes: [fixture.origin],
      relayActionScopes: ['get_content', 'close', 'lease:return'],
      relayLeaseTtlMs: LONG_LEASE_TTL_MS,
    });
    const orphanApproval = await approveLease({
      actionScopes: ['get_content', 'close', 'lease:return'],
      agentId: orphanHarness.agentId,
      label: 'orphan',
      launchPromise: orphanLaunchPromise,
      mode: approvalMode,
      origin: fixture.origin,
      outputDir,
      session: chromeSession,
      ttlMs: LONG_LEASE_TTL_MS,
      worker,
    });
    popupEvidence.push(orphanApproval.evidence);
    const orphanIdentity = surfaceIdentityFromToolContext(contextFor(orphanHarness, 'binding'));
    assert(orphanIdentity, 'Orphan Relay identity was unavailable');
    const orphanBinding = adapter.getBinding(orphanIdentity);
    assert(orphanBinding, 'Orphan Relay binding was unavailable');
    const connectionGeneration = browserRelayService.getConnectionGeneration();
    await chromeSession.fixturePage.bringToFront();
    await clickPopupControl({ buttonId: 'reconnect', session: chromeSession, worker });
    await waitFor(
      () => adapter.hasReadyLease(orphanIdentity),
      (ready) => ready === false,
      5_000,
      'the Relay lease to become orphaned',
    );
    worker = await extensionWorker(chromeSession.context, chromeSession.extensionId);
    await waitFor(
      () => ({
        generation: browserRelayService.getConnectionGeneration(),
        state: browserRelayService.getState(),
      }),
      (current) => current.state.status === 'connected'
        && Boolean(current.generation)
        && current.generation !== connectionGeneration,
      10_000,
      'the Relay extension to reconnect with a new generation',
    );
    const orphanLease = runtime.browserTabLeases.getOwned(orphanBinding.hostLeaseId, {
      conversationId: orphanIdentity.conversationId,
      sessionId: orphanBinding.surfaceSessionId,
      runId: orphanIdentity.runId,
      agentId: orphanIdentity.agentId,
    });
    assert(orphanLease, 'Disconnected Host lease disappeared before orphan verification');
    assert(orphanLease.state === 'orphaned', `Disconnected Host lease state was ${orphanLease.state}`);
    const orphanBlocked = await execute(orphanHarness, 'after-disconnect', { action: 'get_content' });
    const orphanCode = assertFailureCode(orphanBlocked, 'Orphaned Relay lease', [
      'BROWSER_TAB_BORROW_REQUIRED',
      'RELAY_LEASE_NOT_OWNED',
      'relay_action_failed',
    ]);
    await returnViaPopupAndVerify({
      expected: original,
      fixtureUrl: fixture.url,
      session: chromeSession,
      worker,
    });
    await waitFor(
      () => browserRelayService.getState().attachedTabCount,
      (count) => count === 0,
      5_000,
      'the Host to observe orphaned tab return',
    );

    const allEvents = [mainHarness, expiryHarness, orphanHarness, attackerHarness]
      .flatMap((harness) => harness.events);
    withoutCanary(allEvents, 'Relay Surface event stream');
    const proof = {
      version: 1,
      status: 'passed',
      ...campaignProof,
      recordedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      worktree: process.cwd(),
      head: gitSha('HEAD'),
      originMain: gitSha('origin/main'),
      mergeBase: execFileSync('git', ['merge-base', 'HEAD', 'origin/main'], {
        cwd: process.cwd(),
        encoding: 'utf8',
      }).trim(),
      fixtureOrigin: fixture.origin,
      sourceFingerprint: surfaceAcceptanceSourceFingerprint(),
      chrome: {
        executable: chromeSession.executable,
        version: execFileSync(chromeSession.executable, ['--version'], { encoding: 'utf8' }).trim(),
        headless: !hasFlag(args, 'visible'),
        ephemeralProfile: true,
      },
      relay: {
        protocolVersion: BROWSER_RELAY_PROTOCOL_VERSION_V2,
        capabilities: [...BROWSER_RELAY_CAPABILITIES_V2],
        extensionVersion: JSON.parse(
          readFileSync(join(chromeSession.extensionPath, 'manifest.json'), 'utf8'),
        ).version,
        approvalMode,
        requiresExplicitAuthorization: connectedState.requiresExplicitAuthorization,
        rawPairingMaterialProjected: connectedState.authToken !== null,
        mismatchEvidence,
      },
      assertions: {
        handshakeAndCapabilities: true,
        protocolVersionMismatchBlocked: true,
        pairingFlowVerified: true,
        doctorStatusVerified: true,
        relayAuthenticatedSessionReused: true,
        unauthorizedBeforeLeaseBlocked: true,
        unauthorizedWriteBeforeLeaseBlocked: true,
        explicitPopupApproval: popupEvidence.every((evidence) => evidence.mode === approvalMode),
        exactTabApproved: true,
        exactDomainBlocked: true,
        exactActionBlocked: true,
        exactTimeExpiryBlocked: true,
        agentWindowIsolation: true,
        domSnapshot: true,
        accessibilitySnapshot: true,
        hostIssuedElementRefMatchesCurrentObservation: true,
        inputMutation: true,
        exactFileUploadApprovedAndVerified: true,
        relayClipboardFailClosed: true,
        relayDownloadFailClosed: true,
        hoverBusinessStateVerified: true,
        dragBusinessStateVerified: true,
        dialogPolicyBusinessStateVerified: true,
        staleElementRefBlocked: true,
        businessReadback: true,
        screenshotCaptured: true,
        crossAgentBlocked: true,
        exactTabPlacementReturned: true,
        stopLatencyBelowTwoSeconds: true,
        postStopMutationBlocked: true,
        disconnectOrphanedLease: true,
        orphanedMutationBlocked: true,
        orphanedTabReturned: true,
        redactionCanaryAbsent: true,
        rawPairingMaterialAbsent: true,
        consoleNetworkCursor: true,
      },
      stableErrorCodes: {
        beforeLease: beforeLeaseCode,
        beforeLeaseWrite: beforeLeaseWriteCode,
        actionScope: actionDeniedCode,
        domainScope: domainDeniedCode,
        staleElementRef: staleCode,
        crossAgent: crossAgentCode,
        expiry: expiryCode,
        orphan: orphanCode,
        postStop: postStopCode,
        clipboardDeferred: clipboardDeferredCode,
        downloadDeferred: downloadDeferredCode,
      },
      doctorEvidence,
      authenticationEvidence: {
        ...authenticationEvidence,
        relayReadback: 'Authenticated Relay session',
      },
      stopLatencyMs,
      popupEvidence,
      businessEvidence: {
        expectedReadback: BUSINESS_RESULT,
        screenshot: businessScreenshot,
        upload: {
          path: uploadFileName,
          name: uploadFileName,
          bytes: uploadFileBytes,
          sha256: uploadFileSha256,
          pageReadback: `Relay upload verified: ${uploadFileBytes} bytes`,
        },
      },
      complexEvidence: {
        hover: {
          screenshot: hoverScreenshot,
          businessReadback: 'Relay hover verified',
        },
        drag: {
          screenshot: dragScreenshot,
          businessReadback: 'Relay drag verified',
        },
        dialog: {
          screenshot: dialogScreenshot,
          businessReadback: dialogBusinessReadback,
          policy: {
            defaultPolicy: 'pause',
            type: 'confirm',
            acceptVerified: true,
            dismissVerified: true,
            messageLength: pendingAcceptDialog.messageLength,
            nativeDialogEvents: nativeDialogEvidence.length,
          },
        },
      },
      evidenceBackedDefers: [
        {
          capability: 'relay_clipboard',
          status: 'evidence-backed-defer',
          gate: 'G3',
          reason: 'relay_clipboard_transport_unavailable',
          fallback: 'managed',
          evidenceObserved: [
            'relay-action-catalog-has-no-clipboard-method',
            'relay-clipboard-request-fails-closed',
            'managed-controlled-clipboard-business-readback-passed',
          ],
          evidenceRequired: [
            'explicit-system-clipboard-permission',
            'metadata-only-readback',
            'redaction-safe-proof',
          ],
        },
        {
          capability: 'relay_download',
          status: 'evidence-backed-defer',
          gate: 'G3',
          reason: 'relay_download_cancel_cleanup_unavailable',
          fallback: 'managed',
          evidenceObserved: [
            'relay-action-catalog-has-no-download-method',
            'relay-download-request-fails-closed',
            'managed-controlled-download-cleanup-passed',
          ],
          evidenceRequired: [
            'cancel-on-timeout',
            'partial-file-cleanup',
            'isolated-artifact-directory',
          ],
        },
      ],
      logEvidence: {
        nextCursor: logCursor.nextCursor,
        sources: Array.from(new Set((logCursor.entries || []).map((entry) => entry.source))),
        networkUrls: (logCursor.entries || [])
          .filter((entry) => entry.source === 'network')
          .map((entry) => entry.url),
      },
      eventCount: allEvents.length,
    };
    withoutCanary(proof, 'Relay acceptance proof');
    const proofPath = join(outputDir, 'proof.json');
    writeFileSync(proofPath, `${JSON.stringify(proof, null, 2)}\n`, 'utf8');
    if (hasFlag(args, 'json')) {
      printJson({ ok: true, outputDir, proofPath, ...proof.assertions });
    } else {
      printKeyValue('Surface Execution Relay Acceptance', [
        ['ok', true],
        ['protocol', BROWSER_RELAY_PROTOCOL_VERSION_V2],
        ['popupApprovals', popupEvidence.length],
        ['events', allEvents.length],
        ['outputDir', outputDir],
        ['proofPath', proofPath],
      ]);
    }
  } catch (error) {
    const status = error instanceof RelayAcceptanceBlockedError ? 'blocked' : 'failed';
    const proofPath = join(outputDir, 'proof.json');
    const failureProof = {
      version: 1,
      status,
      ...campaignProof,
      recordedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      worktree: process.cwd(),
      head: gitSha('HEAD'),
      originMain: gitSha('origin/main'),
      mergeBase: execFileSync('git', ['merge-base', 'HEAD', 'origin/main'], {
        cwd: process.cwd(),
        encoding: 'utf8',
      }).trim(),
      sourceFingerprint: surfaceAcceptanceSourceFingerprint(),
      reason: sanitizeMessage(error),
      approvalMode,
      popupEvidence,
      recommendedAction: status === 'blocked'
        ? 'Run with --visible --approval operator and explicitly approve the disclosed tab/domain/action/time scope.'
        : 'Inspect the failing current-run assertion; do not treat this run as acceptance evidence.',
      chromeLogAvailable: Boolean(chromeSession?.logs()),
    };
    withoutCanary(failureProof, 'Relay blocked/failed proof');
    writeFileSync(proofPath, `${JSON.stringify(failureProof, null, 2)}\n`, 'utf8');
    throw error;
  } finally {
    await browserRelayService.stop().catch(() => undefined);
    if (chromeSession) {
      await chromeSession.browser.close().catch(() => undefined);
      await closeSystemChromeSession(chromeSession).catch(() => undefined);
    }
    rmSync(uploadInputDir, { recursive: true, force: true });
    await closeServer(fixture.server);
    registry.clear();
    resetRelayBrowserProviderAdapterForTests();
    resetSurfaceExecutionRuntimeForTests();
    resetApplicationRunRegistryForTests();
  }
}

main().then(() => process.exit(0)).catch(finishWithError);
