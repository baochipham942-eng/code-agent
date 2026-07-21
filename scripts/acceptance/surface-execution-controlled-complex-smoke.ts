#!/usr/bin/env npx tsx

import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { basename, dirname, join, resolve } from 'node:path';
import { buildSync } from 'esbuild';
import type {
  BrowserArtifactSummary,
  BrowserDomSnapshot,
  BrowserService,
  BrowserTargetRef,
} from '../../src/host/services/infra/browserService.ts';
import type {
  PermissionRequestData,
  ToolContext,
  ToolExecutionResult,
} from '../../src/host/tools/types.ts';
import type { BrowserActionEngine } from '../../src/shared/contract/desktop.ts';
import type { BrowserSessionMode } from '../../src/shared/contract/conversationEnvelope.ts';
import type { SurfaceExecutionEventV1 } from '../../src/shared/contract/surfaceExecution.ts';
import {
  finishWithError,
  getStringOption,
  hasFlag,
  parseArgs,
  printJson,
  printKeyValue,
  requireStringOption,
} from './_helpers.ts';
import {
  mergeControlledComplexIntoManagedProof,
  surfaceFingerprintEquals,
  validateControlledComplexProof,
  type ControlledComplexArtifactV1,
  type ControlledComplexProofV1,
  type ControlledComplexRouterEvidenceV1,
} from './surface-execution-controlled-complex-core.ts';
import {
  surfaceAcceptanceCampaignProofFields,
  surfaceAcceptanceSourceFingerprint,
} from './surface-execution-proof.ts';

const CONVERSATION_ID = 'surface-controlled-complex-acceptance';
const RUN_ID = 'surface-controlled-complex-run';
const AGENT_ID = 'controlled-complex-agent';
const DOWNLOAD_CONTENT = 'controlled-download-business-state-v1\n';
const AUTH_USERNAME = 'controlled-user';
const AUTH_PASSWORD = 'controlled-password';
const AUTH_COOKIE_NAME = 'surface_fixture_session';
const DIALOG_WAIT_MS = 5_000;

let browserActionTool: typeof import('../../src/host/tools/vision/browserAction.ts').browserActionTool;

interface Harness {
  events: SurfaceExecutionEventV1[];
  results: ToolExecutionResult[];
  permissionRequests: ControlledComplexProofV1['permissionRequests'];
  sequence: number;
}

interface BrowserDispatchOptions {
  engine?: BrowserActionEngine;
  agentId?: string;
  browserSessionMode?: Exclude<BrowserSessionMode, 'none'>;
}

interface FixtureState {
  loginPosts: number;
  protectedReads: number;
  downloadRequests: number;
  sessionValue: string;
}

interface Fixture {
  server: Server;
  baseUrl: string;
  oopifUrl: string;
  state: FixtureState;
}

function usage(): void {
  console.log('Surface Execution controlled complex acceptance\n\n'
    + 'Usage:\n'
    + '  npx tsx scripts/acceptance/surface-execution-controlled-complex-smoke.ts --out <directory> [options]\n\n'
    + 'Options:\n'
    + '  --base-managed-proof <path>  Validate and atomically aggregate into this Managed proof.\n'
    + '  --allow-system-clipboard     Required: capture, mutate, verify, and restore the clipboard.\n'
    + '  --visible                    Launch System Chrome visibly.\n'
    + '  --json                       Print JSON only.\n'
    + '  --help                       Show this help.\n\n'
    + 'Runs only against a local controlled HTTP fixture. It intentionally fails when a real\n'
    + 'OOPIF cannot be observed or closed Shadow DOM descendants are exposed as target refs.');
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function sha256Text(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function gitSha(ref: string): string {
  return execFileSync('git', ['rev-parse', ref], {
    cwd: process.cwd(),
    encoding: 'utf8',
  }).trim();
}

function mergeBase(): string {
  return execFileSync('git', ['merge-base', 'HEAD', 'origin/main'], {
    cwd: process.cwd(),
    encoding: 'utf8',
  }).trim();
}

function atomicWriteJson(path: string, value: unknown): void {
  const temporary = path + '.tmp-' + process.pid + '-' + randomUUID();
  writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', 'utf8');
  renameSync(temporary, path);
}

function sanitizeMessage(value: unknown, rawCanary: string): string {
  const message = value instanceof Error ? value.message : String(value);
  return message.split(rawCanary).join('[redacted-controlled-canary]');
}

function stableResultCode(result: ToolExecutionResult): string {
  const surfaceError = result.metadata?.surfaceExecutionErrorV1;
  if (surfaceError && typeof surfaceError === 'object' && !Array.isArray(surfaceError)) {
    const code = (surfaceError as Record<string, unknown>).code;
    if (typeof code === 'string') return code;
  }
  return typeof result.metadata?.code === 'string' ? result.metadata.code : '';
}

function domSnapshot(result: ToolExecutionResult): BrowserDomSnapshot {
  const snapshot = result.metadata?.domSnapshot as BrowserDomSnapshot | undefined;
  assert(snapshot, 'Browser result did not include a DOM snapshot');
  return snapshot;
}

function findTarget(
  snapshot: BrowserDomSnapshot,
  predicate: (candidate: BrowserDomSnapshot['interactiveElements'][number]) => boolean,
  label: string,
): BrowserDomSnapshot['interactiveElements'][number] {
  const candidate = snapshot.interactiveElements.find(predicate);
  assert(candidate, label + ' was absent from DOM snapshot ' + snapshot.snapshotId);
  return candidate;
}

function bySelector(snapshot: BrowserDomSnapshot, selector: string) {
  return findTarget(snapshot, (candidate) => candidate.selectorHint === selector, selector);
}

function requireReadback(result: ToolExecutionResult, expected: string, label: string): string {
  assert(result.output?.includes(expected), label + ' missed business readback: ' + expected);
  return expected;
}

function artifactRecord(path: string): ControlledComplexArtifactV1 {
  assert(statSync(path).isFile(), 'Artifact is missing: ' + path);
  return {
    path: basename(path),
    sha256: sha256File(path),
    bytes: statSync(path).size,
  };
}

function copyOwnedArtifact(source: string, outputDir: string, filename: string): ControlledComplexArtifactV1 {
  assert(statSync(source).isFile(), 'Source artifact is missing: ' + source);
  const target = join(outputDir, filename);
  copyFileSync(source, target);
  if (resolve(source) !== resolve(target)) unlinkSync(source);
  return artifactRecord(target);
}

function withoutCanary(value: unknown, rawCanary: string, label: string): void {
  assert(!JSON.stringify(value).includes(rawCanary), label + ' leaked the raw controlled canary');
}

function reactBundle(): string {
  const source = String.raw`
    import React, { useState } from 'react';
    import { createRoot } from 'react-dom/client';

    function App() {
      const [reversed, setReversed] = useState(false);
      const [status, setStatus] = useState('React waiting');
      const items = reversed ? ['beta', 'alpha'] : ['alpha', 'beta'];
      return (
        <section>
          <h2>React keyed reorder</h2>
          <button id="react-reorder" onClick={() => setReversed((value) => !value)}>
            Reorder React items
          </button>
          <p id="react-status">{status}</p>
          <div id="react-items">
            {items.map((item) => (
              <button id={'react-' + item} key={item} onClick={() => setStatus('React selected ' + item)}>
                {'Select ' + item}
              </button>
            ))}
          </div>
        </section>
      );
    }

    createRoot(document.getElementById('react-root')).render(<App />);
  `;
  const built = buildSync({
    stdin: {
      contents: source,
      loader: 'tsx',
      resolveDir: process.cwd(),
      sourcefile: 'controlled-complex-react-fixture.tsx',
    },
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target: ['chrome120'],
    logLevel: 'silent',
  });
  const output = built.outputFiles?.[0]?.text;
  assert(output, 'esbuild did not emit the controlled React fixture');
  return output;
}

function fixtureMain(oopifUrl: string): string {
  return String.raw`<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>Surface controlled complex fixture</title>
    <style>
      body { font-family: sans-serif; margin: 24px; }
      section { border: 1px solid #bbb; margin: 12px 0; padding: 12px; }
      button, input, a { margin: 4px; padding: 6px; }
      iframe { display: block; width: 480px; height: 110px; margin: 8px 0; }
    </style>
  </head>
  <body>
    <h1>Managed controlled complex fixture</h1>
    <div id="react-root"></div>
    <script src="/react-app.js"></script>

    <section>
      <h2>Frames</h2>
      <p id="iframe-status">Iframe waiting</p>
      <iframe id="same-origin-frame" src="/iframe-child"></iframe>
      <iframe id="oopif-frame" src="__OOPIF_URL__"></iframe>
    </section>

    <section>
      <h2>Shadow DOM</h2>
      <p id="shadow-status">Shadow waiting</p>
      <div id="open-shadow-host"></div>
      <div id="closed-shadow-host"></div>
    </section>

    <section>
      <h2>Pointer input</h2>
      <p id="hover-status">Hover waiting</p>
      <button id="hover-target">Hover target</button>
      <p id="drag-status">Drag waiting</p>
      <button id="drag-source">Drag source</button>
      <button id="drag-destination">Drag destination</button>
    </section>

    <section>
      <h2>Browser Router production dispatch</h2>
      <p id="router-intent-status">Router intent waiting</p>
      <button id="router-intent-action">Run isolated intent action</button>
      <p id="router-login-status">Router login reuse waiting</p>
      <button id="router-login-action">Run login reuse recovery action</button>
      <label>Capability fallback
        <input id="router-capability-input" autocomplete="off">
      </label>
      <p id="router-capability-status">Router capability waiting</p>
      <p id="router-owner-status">Router owner waiting</p>
      <button id="router-owner-action">Run owner-scoped action</button>
    </section>

    <section>
      <h2>Clipboard and dialog</h2>
      <label>Clipboard target <input id="clipboard-target" type="password" autocomplete="off"></label>
      <p id="clipboard-status">Clipboard waiting</p>
      <p id="dialog-status">Dialog waiting</p>
    </section>

    <section>
      <h2>Download</h2>
      <p id="download-status">Download waiting</p>
      <a id="download-target" href="/download-file" download
         onclick="document.querySelector('#download-status').textContent='Download requested'">
        Download controlled artifact
      </a>
    </section>

    <p><a id="login-link" href="/login">Open controlled login</a></p>
    <script>
      window.addEventListener('message', (event) => {
        if (event.data === 'controlled-iframe-complete') {
          document.querySelector('#iframe-status').textContent = 'Iframe action verified';
        }
      });

      const openRoot = document.querySelector('#open-shadow-host').attachShadow({ mode: 'open' });
      const openButton = document.createElement('button');
      openButton.id = 'open-shadow-action';
      openButton.textContent = 'Run open shadow action';
      openButton.addEventListener('click', () => {
        document.querySelector('#shadow-status').textContent = 'Open shadow action verified';
      });
      openRoot.append(openButton);

      const closedRoot = document.querySelector('#closed-shadow-host').attachShadow({ mode: 'closed' });
      const closedButton = document.createElement('button');
      closedButton.id = 'closed-shadow-action';
      closedButton.textContent = 'Closed shadow forbidden target';
      closedButton.addEventListener('click', () => {
        document.querySelector('#shadow-status').textContent = 'CLOSED SHADOW POLICY FAILURE';
      });
      closedRoot.append(closedButton);

      document.querySelector('#hover-target').addEventListener('mouseenter', () => {
        document.querySelector('#hover-status').textContent = 'Hover business state verified';
      });
      let dragging = false;
      document.querySelector('#drag-source').addEventListener('mousedown', () => { dragging = true; });
      document.querySelector('#drag-destination').addEventListener('mouseup', () => {
        if (dragging) document.querySelector('#drag-status').textContent = 'Drag business state verified';
        dragging = false;
      });
      document.querySelector('#router-intent-action').addEventListener('click', () => {
        document.querySelector('#router-intent-status').textContent =
          'Router isolated intent business state verified';
      });
      document.querySelector('#router-login-action').addEventListener('click', () => {
        document.querySelector('#router-login-status').textContent =
          'Router login reuse recovery business state verified';
      });
      document.querySelector('#router-capability-input').addEventListener('input', (event) => {
        document.querySelector('#router-capability-status').textContent =
          event.target.value === 'controlled capability value'
            ? 'Router capability fallback business state verified'
            : 'Router capability fallback mismatch';
      });
      document.querySelector('#router-owner-action').addEventListener('click', () => {
        document.querySelector('#router-owner-status').textContent =
          'Router owner recovery business state verified';
      });
      document.querySelector('#clipboard-target').addEventListener('input', async (event) => {
        const bytes = new TextEncoder().encode(event.target.value);
        const digest = await crypto.subtle.digest('SHA-256', bytes);
        const actual = Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('');
        document.querySelector('#clipboard-status').textContent =
          actual === window.__expectedClipboardSha256
            ? 'Clipboard paste business state verified'
            : 'Clipboard paste mismatch';
      });
    </script>
  </body>
</html>`.replace('__OOPIF_URL__', oopifUrl);
}

function fixtureLogin(): string {
  return '<!doctype html><html><head><meta charset="utf-8"><title>Controlled login</title></head>'
    + '<body><h1>Controlled HTTP login</h1>'
    + '<form id="login-form" method="post" action="/auth-session">'
    + '<label>User <input id="auth-user" name="username" autocomplete="username"></label>'
    + '<label>Password <input id="auth-password" name="password" type="password" autocomplete="current-password"></label>'
    + '<button id="auth-submit" type="submit">Sign in</button>'
    + '</form></body></html>';
}

async function requestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function respond(response: ServerResponse, status: number, contentType: string, body: string): void {
  response.writeHead(status, {
    'content-type': contentType,
    'cache-control': 'no-store',
  });
  response.end(body);
}

async function startFixtureServer(): Promise<Fixture> {
  const bundle = reactBundle();
  const state: FixtureState = {
    loginPosts: 0,
    protectedReads: 0,
    downloadRequests: 0,
    sessionValue: randomUUID(),
  };
  let baseUrl = '';
  let oopifUrl = '';
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url || '/', baseUrl || 'http://127.0.0.1');
      if (url.pathname === '/react-app.js') {
        respond(response, 200, 'text/javascript; charset=utf-8', bundle);
        return;
      }
      if (url.pathname === '/iframe-child') {
        respond(response, 200, 'text/html; charset=utf-8',
          '<!doctype html><button id="iframe-action" '
          + 'onclick="parent.postMessage(\'controlled-iframe-complete\', \'*\')">Run iframe action</button>');
        return;
      }
      if (url.pathname === '/oopif-child') {
        respond(response, 200, 'text/html; charset=utf-8',
          '<!doctype html><button id="oopif-forbidden-target">OOPIF forbidden target</button>');
        return;
      }
      if (url.pathname === '/download-file') {
        state.downloadRequests += 1;
        response.writeHead(200, {
          'content-type': 'text/plain; charset=utf-8',
          'content-disposition': 'attachment; filename="controlled-download.txt"',
          'cache-control': 'no-store',
        });
        response.end(DOWNLOAD_CONTENT);
        return;
      }
      if (url.pathname === '/login' && request.method === 'GET') {
        respond(response, 200, 'text/html; charset=utf-8', fixtureLogin());
        return;
      }
      if (url.pathname === '/auth-session' && request.method === 'POST') {
        state.loginPosts += 1;
        const form = new URLSearchParams(await requestBody(request));
        if (form.get('username') !== AUTH_USERNAME || form.get('password') !== AUTH_PASSWORD) {
          respond(response, 401, 'text/plain; charset=utf-8', 'controlled credentials rejected');
          return;
        }
        response.writeHead(303, {
          location: '/protected',
          'set-cookie': AUTH_COOKIE_NAME + '=' + state.sessionValue
            + '; Path=/; HttpOnly; SameSite=Strict',
          'cache-control': 'no-store',
        });
        response.end();
        return;
      }
      if (url.pathname === '/protected') {
        const expected = AUTH_COOKIE_NAME + '=' + state.sessionValue;
        const cookie = request.headers.cookie || '';
        const authorized = cookie.split(';').map((value) => value.trim()).includes(expected);
        if (!authorized) {
          respond(response, 401, 'text/plain; charset=utf-8', 'protected session required');
          return;
        }
        state.protectedReads += 1;
        respond(response, 200, 'text/html; charset=utf-8',
          '<!doctype html><html><head><title>Protected controlled session</title></head>'
          + '<body><h1>Protected page</h1>'
          + '<p id="auth-status">Authenticated fixture session verified</p></body></html>');
        return;
      }
      if (url.pathname === '/') {
        respond(response, 200, 'text/html; charset=utf-8', fixtureMain(oopifUrl));
        return;
      }
      respond(response, 404, 'text/plain; charset=utf-8', 'not found');
    })().catch((error) => {
      if (!response.headersSent) response.writeHead(500, { 'content-type': 'text/plain' });
      response.end(error instanceof Error ? error.message : 'fixture error');
    });
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolveListen());
  });
  const address = server.address();
  assert(address && typeof address !== 'string', 'Fixture server did not bind a TCP port');
  baseUrl = 'http://127.0.0.1:' + address.port;
  oopifUrl = 'http://localhost:' + address.port + '/oopif-child';
  return { server, baseUrl, oopifUrl, state };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolveClose) => server.close(() => resolveClose()));
}

function contextFor(
  harness: Harness,
  label: string,
  options: BrowserDispatchOptions = {},
): ToolContext {
  harness.sequence += 1;
  const agentId = options.agentId || AGENT_ID;
  const browserSessionMode = options.browserSessionMode || 'managed';
  return {
    workingDirectory: process.cwd(),
    workspace: process.cwd(),
    sessionId: CONVERSATION_ID,
    runId: RUN_ID,
    turnId: 'controlled-complex-turn',
    agentId,
    currentToolCallId: agentId + ':' + label + ':' + harness.sequence,
    abortSignal: new AbortController().signal,
    requestPermission: async (request: PermissionRequestData) => {
      harness.permissionRequests.push({
        tool: request.tool,
        type: request.type,
        ...(request.dangerLevel ? { dangerLevel: request.dangerLevel } : {}),
      });
      return true;
    },
    executionIntent: {
      browserSessionMode,
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
  harness: Harness,
  label: string,
  params: Record<string, unknown>,
  options: BrowserDispatchOptions = {},
): Promise<ToolExecutionResult> {
  const result = await browserActionTool.execute(
    { ...params, engine: options.engine || 'managed' },
    contextFor(harness, label, options),
  );
  harness.results.push(result);
  return result;
}

async function requireSuccess(
  harness: Harness,
  label: string,
  params: Record<string, unknown>,
  options: BrowserDispatchOptions = {},
): Promise<ToolExecutionResult> {
  const result = await execute(harness, label, params, options);
  if (!result.success) throw new Error(label + ' failed: ' + result.error);
  return result;
}

async function snapshot(harness: Harness, label: string): Promise<BrowserDomSnapshot> {
  return domSnapshot(await requireSuccess(harness, label, { action: 'get_dom_snapshot' }));
}

async function readback(harness: Harness, label: string, expected: string): Promise<string> {
  return requireReadback(
    await requireSuccess(harness, label, { action: 'get_content' }),
    expected,
    label,
  );
}

async function screenshotEvidence(
  harness: Harness,
  outputDir: string,
  task: string,
): Promise<ControlledComplexArtifactV1> {
  const result = await requireSuccess(harness, task + '-screenshot', {
    action: 'screenshot',
    fullPage: true,
    analyze: false,
  });
  const source = result.metadata?.path;
  assert(typeof source === 'string' && source, task + ' screenshot path is missing');
  return copyOwnedArtifact(source, outputDir, task + '.png');
}

async function pollDialog(
  service: BrowserService,
): Promise<void> {
  const deadline = Date.now() + DIALOG_WAIT_MS;
  while (Date.now() < deadline) {
    if (service.getDialogState().pending) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  throw new Error('Controlled dialog did not enter the paused state');
}

async function captureClipboard(
  service: BrowserService,
): Promise<string> {
  const tab = service.getActiveTab();
  assert(tab, 'Managed browser has no active tab for clipboard capture');
  const origin = new URL(tab.page.url()).origin;
  await tab.page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
  try {
    return await tab.page.evaluate(async () => {
      if (!navigator.clipboard?.readText) throw new Error('Clipboard read is unavailable');
      return await navigator.clipboard.readText();
    });
  } finally {
    await tab.page.context().clearPermissions();
  }
}

async function restoreClipboard(
  service: BrowserService,
  original: string,
): Promise<void> {
  const tab = service.getActiveTab();
  assert(tab, 'Managed browser has no active tab for clipboard restore');
  const origin = new URL(tab.page.url()).origin;
  await tab.page.context().grantPermissions(['clipboard-write'], { origin });
  try {
    await tab.page.evaluate(async (value) => {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard write is unavailable');
      await navigator.clipboard.writeText(value);
    }, original);
  } finally {
    await tab.page.context().clearPermissions();
  }
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function productionDispatchFacts(
  result: ToolExecutionResult,
  label: string,
): {
  selectedEngine: string;
  provider: string;
  traceId: string;
} {
  const metadata = result.metadata || {};
  const trace = recordValue(metadata.workbenchTrace);
  const traceParams = recordValue(trace?.params);
  const traceId = typeof metadata.traceId === 'string' ? metadata.traceId : '';
  const selectedEngine = typeof metadata.engine === 'string' ? metadata.engine : '';
  const provider = typeof metadata.provider === 'string' ? metadata.provider : '';
  assert(trace?.toolName === 'browser_action', label + ' did not traverse browser_action');
  assert(traceParams?.engine === 'auto', label + ' did not traverse the production auto router');
  assert(traceId && trace?.id === traceId, label + ' did not preserve its production trace id');
  assert(selectedEngine === 'managed', label + ' selected ' + selectedEngine + ', expected managed');
  assert(provider === 'system-chrome-cdp', label + ' used ' + provider + ', expected System Chrome');
  return { selectedEngine, provider, traceId };
}

async function routedObservation(
  harness: Harness,
  label: string,
  options: BrowserDispatchOptions,
): Promise<{
  result: ToolExecutionResult;
  snapshot: BrowserDomSnapshot;
  dispatch: ReturnType<typeof productionDispatchFacts>;
}> {
  const result = await requireSuccess(
    harness,
    label,
    { action: 'get_dom_snapshot' },
    { ...options, engine: 'auto' },
  );
  return {
    result,
    snapshot: domSnapshot(result),
    dispatch: productionDispatchFacts(result, label),
  };
}

async function routedSuccessor(
  harness: Harness,
  label: string,
  expected: string,
  options: BrowserDispatchOptions,
): Promise<{
  readback: string;
  dispatch: ReturnType<typeof productionDispatchFacts>;
}> {
  const result = await requireSuccess(
    harness,
    label,
    { action: 'get_content' },
    { ...options, engine: 'auto' },
  );
  return {
    readback: requireReadback(result, expected, label),
    dispatch: productionDispatchFacts(result, label),
  };
}

async function routerEvidence(harness: Harness): Promise<ControlledComplexRouterEvidenceV1> {
  const isolatedOptions: BrowserDispatchOptions = {
    engine: 'auto',
    browserSessionMode: 'managed',
  };
  const loginReuseOptions: BrowserDispatchOptions = {
    engine: 'auto',
    browserSessionMode: 'desktop',
  };
  const decisions: ControlledComplexRouterEvidenceV1['decisions'] = [];

  const intentObservation = await routedObservation(
    harness,
    'router-intent-observe',
    isolatedOptions,
  );
  const intentMutationResult = await requireSuccess(
    harness,
    'router-intent-mutate',
    {
      action: 'click',
      targetRef: bySelector(intentObservation.snapshot, '#router-intent-action').targetRef,
    },
    isolatedOptions,
  );
  const intentMutation = productionDispatchFacts(intentMutationResult, 'router-intent-mutate');
  const intentSuccessor = await routedSuccessor(
    harness,
    'router-intent-successor',
    'Router isolated intent business state verified',
    isolatedOptions,
  );
  decisions.push({
    case: 'isolated_automation_routes_managed',
    requestedEngine: 'auto',
    selectedEngine: intentMutation.selectedEngine,
    reason: 'production_browser_action_dispatch_with_managed_intent',
    productionDispatch: true,
    capability: 'click',
    intent: 'isolated_automation',
    ownerAgentId: AGENT_ID,
    targetOwnerAgentId: AGENT_ID,
    provider: intentMutation.provider,
    observationTraceId: intentObservation.dispatch.traceId,
    mutationTraceId: intentMutation.traceId,
    successorTraceId: intentSuccessor.dispatch.traceId,
    successorVerified: true,
    businessReadback: intentSuccessor.readback,
  });

  const loginObservation = await routedObservation(
    harness,
    'router-login-observe',
    loginReuseOptions,
  );
  const loginMutationResult = await requireSuccess(
    harness,
    'router-login-mutate',
    {
      action: 'click',
      targetRef: bySelector(loginObservation.snapshot, '#router-login-action').targetRef,
    },
    loginReuseOptions,
  );
  const loginMutation = productionDispatchFacts(loginMutationResult, 'router-login-mutate');
  const loginSuccessor = await routedSuccessor(
    harness,
    'router-login-successor',
    'Router login reuse recovery business state verified',
    loginReuseOptions,
  );
  decisions.push({
    case: 'login_reuse_without_lease_recovers_managed',
    requestedEngine: 'auto',
    selectedEngine: loginMutation.selectedEngine,
    reason: 'production_browser_action_dispatch_without_relay_lease',
    productionDispatch: true,
    capability: 'click',
    intent: 'login_reuse',
    ownerAgentId: AGENT_ID,
    targetOwnerAgentId: AGENT_ID,
    provider: loginMutation.provider,
    observationTraceId: loginObservation.dispatch.traceId,
    mutationTraceId: loginMutation.traceId,
    successorTraceId: loginSuccessor.dispatch.traceId,
    successorVerified: true,
    businessReadback: loginSuccessor.readback,
  });

  const capabilityObservation = await routedObservation(
    harness,
    'router-capability-observe',
    loginReuseOptions,
  );
  const capabilityMutationResult = await requireSuccess(
    harness,
    'router-capability-mutate',
    {
      action: 'fill_form',
      formData: { '#router-capability-input': 'controlled capability value' },
    },
    loginReuseOptions,
  );
  const capabilityMutation = productionDispatchFacts(
    capabilityMutationResult,
    'router-capability-mutate',
  );
  const capabilitySuccessor = await routedSuccessor(
    harness,
    'router-capability-successor',
    'Router capability fallback business state verified',
    loginReuseOptions,
  );
  decisions.push({
    case: 'unsupported_relay_capability_recovers_managed',
    requestedEngine: 'auto',
    selectedEngine: capabilityMutation.selectedEngine,
    reason: 'production_browser_action_fill_form_dispatched_to_managed',
    productionDispatch: true,
    capability: 'fill_form',
    intent: 'login_reuse',
    ownerAgentId: AGENT_ID,
    targetOwnerAgentId: AGENT_ID,
    provider: capabilityMutation.provider,
    observationTraceId: capabilityObservation.dispatch.traceId,
    mutationTraceId: capabilityMutation.traceId,
    successorTraceId: capabilitySuccessor.dispatch.traceId,
    successorVerified: true,
    businessReadback: capabilitySuccessor.readback,
  });

  const ownerObservation = await routedObservation(
    harness,
    'router-owner-observe',
    isolatedOptions,
  );
  const ownerTargetRef = bySelector(ownerObservation.snapshot, '#router-owner-action').targetRef;
  const attackerAgentId = 'controlled-router-attacker';
  const blockedMutationResult = await execute(
    harness,
    'router-owner-blocked-mutate',
    { action: 'click', targetRef: ownerTargetRef },
    {
      engine: 'auto',
      browserSessionMode: 'managed',
      agentId: attackerAgentId,
    },
  );
  assert(!blockedMutationResult.success, 'Cross-Agent router targetRef unexpectedly mutated');
  const blockedCode = stableResultCode(blockedMutationResult);
  assert(
    ['SURFACE_ELEMENT_REF_NOT_FOUND', 'SURFACE_TARGET_REVISION_CHANGED'].includes(blockedCode),
    'Cross-Agent router targetRef failed without an ownership code: ' + blockedCode,
  );
  const blockedMutation = productionDispatchFacts(
    blockedMutationResult,
    'router-owner-blocked-mutate',
  );
  const unchanged = await routedSuccessor(
    harness,
    'router-owner-unchanged',
    'Router owner waiting',
    isolatedOptions,
  );
  const ownerRecoveryObservation = await routedObservation(
    harness,
    'router-owner-recovery-observe',
    isolatedOptions,
  );
  const ownerMutationResult = await requireSuccess(
    harness,
    'router-owner-mutate',
    {
      action: 'click',
      targetRef: bySelector(
        ownerRecoveryObservation.snapshot,
        '#router-owner-action',
      ).targetRef,
    },
    isolatedOptions,
  );
  const ownerMutation = productionDispatchFacts(ownerMutationResult, 'router-owner-mutate');
  const ownerSuccessor = await routedSuccessor(
    harness,
    'router-owner-successor',
    'Router owner recovery business state verified',
    isolatedOptions,
  );
  decisions.push({
    case: 'wrong_owner_target_blocked_then_owner_recovers',
    requestedEngine: 'auto',
    selectedEngine: ownerMutation.selectedEngine,
    reason: 'production_browser_action_owner_fence_then_owned_retry',
    recoveryCode: blockedCode,
    productionDispatch: true,
    capability: 'click',
    intent: 'isolated_automation',
    ownerAgentId: attackerAgentId,
    targetOwnerAgentId: AGENT_ID,
    provider: ownerMutation.provider,
    observationTraceId: ownerObservation.dispatch.traceId,
    mutationTraceId: ownerMutation.traceId,
    successorTraceId: ownerSuccessor.dispatch.traceId,
    successorVerified: true,
    businessReadback: ownerSuccessor.readback,
    blockedMutationTraceId: blockedMutation.traceId,
    recoveryObservationTraceId: ownerRecoveryObservation.dispatch.traceId,
    blockedCode,
    unchangedReadback: unchanged.readback,
  });

  return {
    businessReadback:
      'Production browser_action observe, mutation, successor verification, and owner fail-closed routing verified',
    decisions,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (hasFlag(args, 'help')) {
    usage();
    return;
  }
  const campaignProof = surfaceAcceptanceCampaignProofFields();
  if (!hasFlag(args, 'allow-system-clipboard')) {
    throw new Error('--allow-system-clipboard is required before any clipboard mutation');
  }
  const outputDir = resolve(requireStringOption(args, 'out'));
  const baseManagedProofOption = getStringOption(args, 'base-managed-proof');
  const baseManagedProofPath = baseManagedProofOption ? resolve(baseManagedProofOption) : null;
  if (baseManagedProofPath && dirname(baseManagedProofPath) !== outputDir) {
    throw new Error('--out must equal the directory containing --base-managed-proof');
  }
  mkdirSync(outputDir, { recursive: true });
  const runLogPath = join(outputDir, 'controlled-complex-run.log');
  writeFileSync(runLogPath, '', 'utf8');
  const jsonOnly = hasFlag(args, 'json');
  const rawCanary = 'surface-controlled-canary-' + randomUUID();
  const canaryFingerprint = sha256Text(rawCanary);
  const log = (message: string) => {
    const safe = message.split(rawCanary).join('[redacted-controlled-canary]');
    writeFileSync(runLogPath, new Date().toISOString() + ' ' + safe + '\n', {
      encoding: 'utf8',
      flag: 'a',
    });
    if (!jsonOnly) console.log(safe);
  };

  process.env.CODE_AGENT_BROWSER_PROVIDER = 'system-chrome-cdp';
  process.env.CODE_AGENT_BROWSER_VISIBLE = hasFlag(args, 'visible') ? '1' : '0';
  const [
    applicationRunRegistryModule,
    managedBrowserAdapterModule,
    surfaceRuntimeModule,
    browserActionModule,
  ] = await Promise.all([
    import('../../src/host/app/applicationRunRegistry.ts'),
    import('../../src/host/services/surfaceExecution/ManagedBrowserProviderAdapter.ts'),
    import('../../src/host/services/surfaceExecution/SurfaceExecutionRuntime.ts'),
    import('../../src/host/tools/vision/browserAction.ts'),
  ]);
  const {
    getApplicationRunRegistry,
    resetApplicationRunRegistryForTests,
  } = applicationRunRegistryModule;
  const {
    getManagedBrowserProviderAdapter,
    resetManagedBrowserProviderAdapterForTests,
    surfaceIdentityFromToolContext,
  } = managedBrowserAdapterModule;
  const {
    getSurfaceExecutionRuntime,
    resetSurfaceExecutionRuntimeForTests,
  } = surfaceRuntimeModule;
  browserActionTool = browserActionModule.browserActionTool;
  const sourceFingerprint = surfaceAcceptanceSourceFingerprint();
  let baseManagedProof: unknown = null;
  let baseManagedProofText: string | null = null;
  if (baseManagedProofPath) {
    baseManagedProofText = readFileSync(baseManagedProofPath, 'utf8');
    baseManagedProof = JSON.parse(baseManagedProofText) as unknown;
    const record = baseManagedProof as Record<string, unknown>;
    assert(record.status === 'passed', 'Base Managed proof is not passed');
    assert(surfaceFingerprintEquals(record.sourceFingerprint, sourceFingerprint),
      'Base Managed proof sourceFingerprint is stale before controlled complex execution');
  }

  resetManagedBrowserProviderAdapterForTests();
  resetSurfaceExecutionRuntimeForTests();
  resetApplicationRunRegistryForTests();
  const registry = getApplicationRunRegistry();
  registry.start({ runId: RUN_ID, sessionId: CONVERSATION_ID, workspace: process.cwd() });
  const runtime = getSurfaceExecutionRuntime();
  const adapter = getManagedBrowserProviderAdapter();
  const harness: Harness = {
    events: [],
    results: [],
    permissionRequests: [],
    sequence: 0,
  };
  const identity = surfaceIdentityFromToolContext(contextFor(harness, 'identity'));
  assert(identity, 'Controlled complex Surface identity was unavailable');
  const fixture = await startFixtureServer();
  const startedAt = new Date().toISOString();
  const evidence = {} as ControlledComplexProofV1['complexEvidence'];
  let originalClipboard: string | null = null;
  let clipboardMutated = false;
  let cleanupComplete = false;
  let managedService: BrowserService | null = null;
  let canonicalManagedProofUpdated = false;

  try {
    log('Navigating Managed System Chrome to controlled local fixture');
    await requireSuccess(harness, 'navigate-fixture', {
      action: 'navigate',
      url: fixture.baseUrl,
    });
    const service = adapter.getBrowserService(identity);
    managedService = service;
    const managedSessionState = service.getSessionState();
    assert(managedSessionState.provider === 'system-chrome-cdp',
      'Controlled complex acceptance requires System Chrome without provider fallback');
    assert(managedSessionState.profileMode === 'isolated',
      'Controlled complex acceptance requires an isolated Managed profile');
    const browserVersion = service.getActiveTab()?.page.context().browser()?.version() || '';
    assert(browserVersion, 'Managed System Chrome browser version is unavailable');

    const reactBefore = await snapshot(harness, 'react-before');
    const reorderRef = bySelector(reactBefore, '#react-reorder').targetRef;
    const staleBetaRef = bySelector(reactBefore, '#react-beta').targetRef;
    await requireSuccess(harness, 'react-reorder', { action: 'click', targetRef: reorderRef });
    const staleBeta = await execute(harness, 'react-stale-beta', {
      action: 'click',
      targetRef: staleBetaRef,
    });
    assert(!staleBeta.success, 'Pre-reorder React targetRef unexpectedly remained executable');
    const staleCode = stableResultCode(staleBeta);
    assert(['STALE_TARGET_REF', 'SURFACE_ELEMENT_REF_NOT_FOUND', 'SURFACE_STATE_STALE']
      .includes(staleCode), 'React stale ref failed without a stable stale code: ' + staleCode);
    const reactAfter = await snapshot(harness, 'react-after');
    const freshBetaRef = bySelector(reactAfter, '#react-beta').targetRef;
    assert(reactAfter.snapshotId !== reactBefore.snapshotId, 'React reorder reused snapshot identity');
    assert(freshBetaRef.refId !== staleBetaRef.refId, 'React reorder reused targetRef identity');
    assert(freshBetaRef.documentRevision !== staleBetaRef.documentRevision,
      'React reorder reused document revision');
    await requireSuccess(harness, 'react-fresh-beta', { action: 'click', targetRef: freshBetaRef });
    evidence.reactReorder = {
      businessReadback: await readback(harness, 'react-readback', 'React selected beta'),
      screenshot: await screenshotEvidence(harness, outputDir, 'react-reorder'),
      facts: {
        priorSnapshotId: reactBefore.snapshotId,
        freshSnapshotId: reactAfter.snapshotId,
        staleCode,
      },
    };

    const iframeSnapshot = await snapshot(harness, 'iframe-snapshot');
    const iframeDocument = iframeSnapshot.frameDocuments?.find((frame) => (
      frame.status === 'captured' && frame.url.includes('/iframe-child')
    ));
    assert(iframeDocument, 'Same-origin iframe document was not captured');
    const iframeTarget = findTarget(iframeSnapshot, (candidate) => (
      candidate.targetRef.frameId === iframeDocument.frameId
      && candidate.selectorHint === '#iframe-action'
    ), 'Same-origin iframe action');
    assert(iframeTarget.targetRef.documentRevision === iframeDocument.documentRevision,
      'Iframe targetRef document revision does not match its captured frame');
    await requireSuccess(harness, 'iframe-click', {
      action: 'click',
      targetRef: iframeTarget.targetRef,
    });
    evidence.iframe = {
      businessReadback: await readback(harness, 'iframe-readback', 'Iframe action verified'),
      screenshot: await screenshotEvidence(harness, outputDir, 'iframe'),
      facts: {
        frameId: iframeDocument.frameId,
        documentRevision: iframeDocument.documentRevision,
      },
    };

    const oopifSnapshot = await snapshot(harness, 'oopif-snapshot');
    const oopifDocument = oopifSnapshot.frameDocuments?.find((frame) => (
      frame.url.includes('localhost:') && frame.url.includes('/oopif-child')
    ));
    assert(oopifDocument, 'Cross-site iframe was absent from the real DOM snapshot');
    assert(oopifDocument.status === 'unavailable'
      && oopifDocument.reason === 'oopif_requires_dedicated_cdp_session',
    'Cross-site iframe did not fail closed as a real unavailable OOPIF');
    assert(!oopifSnapshot.interactiveElements.some((candidate) => (
      candidate.targetRef.frameId === oopifDocument.frameId
    )), 'Unavailable OOPIF exposed an interactive targetRef');
    const forgedBase = bySelector(oopifSnapshot, '#hover-target').targetRef;
    const forgedOopif: BrowserTargetRef = {
      ...forgedBase,
      frameId: oopifDocument.frameId,
    };
    const forgedOopifResult = await execute(harness, 'oopif-forged-ref', {
      action: 'click',
      targetRef: forgedOopif,
    });
    assert(!forgedOopifResult.success, 'Forged OOPIF targetRef unexpectedly executed');
    evidence.oopif = {
      businessReadback: 'OOPIF unavailable boundary and forged targetRef rejection verified',
      screenshot: await screenshotEvidence(harness, outputDir, 'oopif'),
      facts: {
        frameId: oopifDocument.frameId,
        reason: oopifDocument.reason,
        rejectionCode: stableResultCode(forgedOopifResult),
      },
    };

    const shadowSnapshot = await snapshot(harness, 'shadow-snapshot');
    const closedLeak = shadowSnapshot.interactiveElements.find((candidate) => (
      candidate.selectorHint === '#closed-shadow-action'
      || candidate.text.includes('Closed shadow forbidden target')
    ));
    assert(!closedLeak,
      'Closed Shadow DOM leaked an executable ref; product parser must filter closed descendants');
    const openShadow = findTarget(shadowSnapshot, (candidate) => (
      candidate.shadowRoot === true && candidate.selectorHint === '#open-shadow-action'
    ), 'Open Shadow DOM action');
    const forgedClosed: BrowserTargetRef = {
      ...openShadow.targetRef,
      refId: 'closed-shadow-unavailable',
    };
    const forgedClosedResult = await execute(harness, 'closed-shadow-forged-ref', {
      action: 'click',
      targetRef: forgedClosed,
    });
    assert(!forgedClosedResult.success, 'Forged closed Shadow DOM targetRef unexpectedly executed');
    const freshShadow = await snapshot(harness, 'shadow-fresh-open');
    const freshOpenShadow = findTarget(freshShadow, (candidate) => (
      candidate.shadowRoot === true && candidate.selectorHint === '#open-shadow-action'
    ), 'Fresh open Shadow DOM action');
    await requireSuccess(harness, 'open-shadow-click', {
      action: 'click',
      targetRef: freshOpenShadow.targetRef,
    });
    evidence.shadowDom = {
      businessReadback: await readback(
        harness,
        'shadow-readback',
        'Open shadow action verified',
      ) + '; closed shadow target remained unavailable',
      screenshot: await screenshotEvidence(harness, outputDir, 'shadow-dom'),
      facts: { closedRefRejectionCode: stableResultCode(forgedClosedResult) },
    };

    const hoverSnapshot = await snapshot(harness, 'hover-snapshot');
    await requireSuccess(harness, 'hover-action', {
      action: 'hover',
      targetRef: bySelector(hoverSnapshot, '#hover-target').targetRef,
    });
    evidence.hover = {
      businessReadback: await readback(
        harness,
        'hover-readback',
        'Hover business state verified',
      ),
      screenshot: await screenshotEvidence(harness, outputDir, 'hover'),
    };

    const dragSnapshot = await snapshot(harness, 'drag-snapshot');
    const dragSource = bySelector(dragSnapshot, '#drag-source').targetRef;
    const dragDestination = bySelector(dragSnapshot, '#drag-destination').targetRef;
    assert(dragSource.snapshotId === dragDestination.snapshotId,
      'Drag source and destination did not originate from one snapshot');
    await requireSuccess(harness, 'drag-action', {
      action: 'drag',
      targetRef: dragSource,
      destinationTargetRef: dragDestination,
    });
    evidence.drag = {
      businessReadback: await readback(
        harness,
        'drag-readback',
        'Drag business state verified',
      ),
      screenshot: await screenshotEvidence(harness, outputDir, 'drag'),
    };

    originalClipboard = await captureClipboard(service);
    await service.runScript(
      'window.__expectedClipboardSha256 = ' + JSON.stringify(canaryFingerprint),
    );
    const clipboardSnapshot = await snapshot(harness, 'clipboard-snapshot');
    await requireSuccess(harness, 'clipboard-focus', {
      action: 'click',
      targetRef: bySelector(clipboardSnapshot, '#clipboard-target').targetRef,
    });
    await requireSuccess(harness, 'clipboard-write', {
      action: 'write_clipboard',
      clipboardText: rawCanary,
    });
    clipboardMutated = true;
    await requireSuccess(harness, 'clipboard-paste', {
      action: 'press_key',
      key: process.platform === 'darwin' ? 'Meta+V' : 'Control+V',
    });
    await requireSuccess(harness, 'clipboard-settle', { action: 'wait', timeout: 100 });
    evidence.clipboard = {
      businessReadback: await readback(
        harness,
        'clipboard-readback',
        'Clipboard paste business state verified',
      ),
      screenshot: await screenshotEvidence(harness, outputDir, 'clipboard'),
      facts: {
        canaryFingerprint,
        clipboardRestored: false,
      },
    };

    await service.runScript(
      "setTimeout(() => { const accepted = confirm('Controlled dismiss policy'); "
      + "document.querySelector('#dialog-status').textContent = accepted "
      + "? 'Dialog unexpectedly accepted' : 'Dialog dismiss business state verified'; }, 0); 'scheduled';",
    );
    await pollDialog(service);
    await requireSuccess(harness, 'dialog-dismiss', {
      action: 'handle_dialog',
      dialogAction: 'dismiss',
    });
    await readback(harness, 'dialog-dismiss-readback', 'Dialog dismiss business state verified');
    await service.runScript(
      "setTimeout(() => { const accepted = confirm('Controlled accept policy'); "
      + "document.querySelector('#dialog-status').textContent = accepted "
      + "? 'Dialog accept business state verified' : 'Dialog unexpectedly dismissed'; }, 0); 'scheduled';",
    );
    await pollDialog(service);
    await requireSuccess(harness, 'dialog-accept', {
      action: 'handle_dialog',
      dialogAction: 'accept',
    });
    assert(service.getDialogState().pending === false, 'Dialog remained pending after handling');
    evidence.dialog = {
      businessReadback: await readback(
        harness,
        'dialog-accept-readback',
        'Dialog accept business state verified',
      ) + '; dismiss business state verified',
      screenshot: await screenshotEvidence(harness, outputDir, 'dialog'),
      facts: {
        defaultPolicy: 'pause',
        acceptedWithExplicitPermission: true,
      },
    };

    const downloadSnapshot = await snapshot(harness, 'download-snapshot');
    const downloadRef = bySelector(downloadSnapshot, '#download-target').targetRef;
    let fullDownloadArtifact: BrowserArtifactSummary | null = null;
    const downloadResult = await adapter.execute({
      identity,
      operationId: 'controlled-download-' + randomUUID(),
      action: 'wait_for_download',
      params: { targetRef: downloadRef },
      executeProvider: async (_signal, browserService) => {
        fullDownloadArtifact = await browserService.waitForDownload({ targetRef: downloadRef });
        return {
          success: true,
          output: 'Controlled download completed',
          metadata: { browserArtifact: fullDownloadArtifact },
        };
      },
    });
    harness.results.push(downloadResult);
    assert(downloadResult.success, 'Managed controlled download failed: ' + downloadResult.error);
    assert(fullDownloadArtifact, 'Managed download did not return a full artifact summary');
    const downloadedPath = (fullDownloadArtifact as BrowserArtifactSummary).artifactPath;
    assert(readFileSync(downloadedPath, 'utf8') === DOWNLOAD_CONTENT,
      'Downloaded artifact content did not match server payload');
    const savedDownload = copyOwnedArtifact(
      downloadedPath,
      outputDir,
      'controlled-download.txt',
    );
    assert(savedDownload.sha256 === (fullDownloadArtifact as BrowserArtifactSummary).sha256,
      'Downloaded artifact sha256 changed during proof capture');
    assert(savedDownload.bytes === (fullDownloadArtifact as BrowserArtifactSummary).size,
      'Downloaded artifact byte count changed during proof capture');
    assert(fixture.state.downloadRequests === 1,
      'Controlled fixture did not observe exactly one download request');
    evidence.download = {
      businessReadback: await readback(
        harness,
        'download-readback',
        'Download requested',
      ) + '; server payload hash and bytes verified',
      artifact: savedDownload,
      facts: {
        serverDownloadRequests: fixture.state.downloadRequests,
        mimeType: (fullDownloadArtifact as BrowserArtifactSummary).mimeType,
      },
    };

    const router = await routerEvidence(harness);

    await requireSuccess(harness, 'auth-navigate', {
      action: 'navigate',
      url: fixture.baseUrl + '/login',
    });
    const authUserSnapshot = await snapshot(harness, 'auth-user-snapshot');
    await requireSuccess(harness, 'auth-user-type', {
      action: 'type',
      targetRef: bySelector(authUserSnapshot, '#auth-user').targetRef,
      text: AUTH_USERNAME,
    });
    const authPasswordSnapshot = await snapshot(harness, 'auth-password-snapshot');
    await requireSuccess(harness, 'auth-password-type', {
      action: 'type',
      targetRef: bySelector(authPasswordSnapshot, '#auth-password').targetRef,
      text: AUTH_PASSWORD,
    });
    const authSubmitSnapshot = await snapshot(harness, 'auth-submit-snapshot');
    await requireSuccess(harness, 'auth-submit', {
      action: 'click',
      targetRef: bySelector(authSubmitSnapshot, '#auth-submit').targetRef,
    });
    const activePage = service.getActiveTab()?.page;
    assert(activePage, 'Managed browser lost the active page during controlled login');
    await activePage.waitForURL(fixture.baseUrl + '/protected', { timeout: 10_000 });
    const authReadback = await readback(
      harness,
      'auth-protected-readback',
      'Authenticated fixture session verified',
    );
    assert(fixture.state.loginPosts === 1 && fixture.state.protectedReads >= 1,
      'Controlled login was not verified by server POST and protected read counters');
    const cookies = await activePage.context().cookies(fixture.baseUrl);
    const sessionCookie = cookies.find((cookie) => cookie.name === AUTH_COOKIE_NAME);
    assert(sessionCookie?.httpOnly === true && sessionCookie.sameSite === 'Strict',
      'Controlled session cookie did not preserve HttpOnly/SameSite=Strict');
    const visibleCookies = await service.runScript<string>('document.cookie');
    assert(!visibleCookies.includes(AUTH_COOKIE_NAME),
      'HttpOnly controlled session cookie was visible to page JavaScript');
    evidence.auth = {
      businessReadback: authReadback
        + '; server POST and HttpOnly/SameSite session cookie verified',
      screenshot: await screenshotEvidence(harness, outputDir, 'auth'),
      facts: {
        formPostCount: fixture.state.loginPosts,
        protectedReadCount: fixture.state.protectedReads,
        cookieHttpOnly: true,
        cookieSameSite: 'Strict',
        cookieHiddenFromDocument: true,
        profileMode: service.getSessionState().profileMode,
      },
    };

    if (clipboardMutated && originalClipboard !== null) {
      await restoreClipboard(service, originalClipboard);
      clipboardMutated = false;
      const clipboardFacts = evidence.clipboard.facts as Record<string, unknown>;
      clipboardFacts.clipboardRestored = true;
    }

    const endFingerprint = surfaceAcceptanceSourceFingerprint();
    assert(surfaceFingerprintEquals(sourceFingerprint, endFingerprint),
      'Surface source changed during controlled complex execution; refusing proof');
    const proof: ControlledComplexProofV1 = {
      version: 1,
      status: 'passed',
      ...campaignProof,
      acceptance: 'surface-execution-controlled-complex',
      startedAt,
      finishedAt: new Date().toISOString(),
      worktree: process.cwd(),
      head: gitSha('HEAD'),
      originMain: gitSha('origin/main'),
      mergeBase: mergeBase(),
      sourceFingerprint: endFingerprint,
      fixtureOrigin: fixture.baseUrl,
      provider: 'system-chrome-cdp',
      browserVersion,
      assertions: {
        reactReorderFreshObservationVerified: true,
        iframeExactTargetVerified: true,
        oopifUnavailableFailClosed: true,
        openShadowTargetVerified: true,
        closedShadowFailClosed: true,
        hoverBusinessStateVerified: true,
        dragBusinessStateVerified: true,
        clipboardBusinessStateVerified: true,
        dialogPolicyBusinessStateVerified: true,
        downloadArtifactAndBusinessStateVerified: true,
        routerCapabilityOwnershipIntentVerified: true,
        managedAuthenticatedSessionVerified: true,
      },
      complexEvidence: evidence,
      routerEvidence: router,
      redactionCanary: {
        fingerprint: canaryFingerprint,
        rawAbsentFromResults: true,
        rawAbsentFromEvents: true,
        rawAbsentFromProof: true,
      },
      permissionRequests: harness.permissionRequests,
    };
    withoutCanary(harness.results, rawCanary, 'Browser action results');
    withoutCanary(harness.events, rawCanary, 'Surface event stream');
    withoutCanary(proof, rawCanary, 'Controlled complex proof');
    const proofIssues = validateControlledComplexProof(proof, endFingerprint, rawCanary);
    assert(proofIssues.length === 0, 'Controlled complex proof is invalid: ' + proofIssues.join('; '));

    const controlledProofPath = join(outputDir, 'controlled-complex-proof.json');
    await runtime.endRun(identity);
    assert(!service.isRunning(), 'Managed System Chrome remained active after endRun cleanup');
    cleanupComplete = true;
    atomicWriteJson(controlledProofPath, proof);
    let aggregatedProofPath: string | null = null;
    if (baseManagedProofPath) {
      assert(readFileSync(baseManagedProofPath, 'utf8') === baseManagedProofText,
        'Base Managed proof changed during controlled complex execution; refusing overwrite');
      const merged = mergeControlledComplexIntoManagedProof({
        managedProof: baseManagedProof,
        controlledProof: proof,
        currentSourceFingerprint: endFingerprint,
        rawCanary,
      });
      aggregatedProofPath = baseManagedProofPath;
      atomicWriteJson(aggregatedProofPath, merged);
      canonicalManagedProofUpdated = true;
    }
    log('Controlled complex proof passed and cleanup completed');
    const output = {
      ok: true,
      controlledProofPath,
      aggregatedProofPath,
      runLogPath,
      sourceFingerprint: endFingerprint.sha256,
      assertions: proof.assertions,
    };
    if (jsonOnly) printJson(output);
    else printKeyValue('Surface Execution Controlled Complex Acceptance', [
      ['ok', true],
      ['controlledProofPath', controlledProofPath],
      ['aggregatedProofPath', aggregatedProofPath],
      ['sourceFingerprint', endFingerprint.sha256],
      ['runLogPath', runLogPath],
    ]);
  } catch (error) {
    let failureMessage = sanitizeMessage(error, rawCanary);
    if (clipboardMutated && originalClipboard !== null && managedService?.isRunning()) {
      try {
        await restoreClipboard(managedService, originalClipboard);
        clipboardMutated = false;
      } catch (restoreError) {
        failureMessage += '; clipboard restore failed: '
          + sanitizeMessage(restoreError, rawCanary);
      }
    }
    const failure = {
      version: 1,
      status: 'failed',
      ...campaignProof,
      acceptance: 'surface-execution-controlled-complex',
      recordedAt: new Date().toISOString(),
      sourceFingerprint,
      fixtureOrigin: fixture.baseUrl,
      failure: failureMessage,
      canonicalManagedProofUntouched: !canonicalManagedProofUpdated,
    };
    atomicWriteJson(join(outputDir, 'controlled-complex-failure.json'), failure);
    throw new Error(failure.failure, { cause: error });
  } finally {
    if (clipboardMutated && originalClipboard !== null && managedService?.isRunning()) {
      await restoreClipboard(managedService, originalClipboard).catch(() => undefined);
    }
    if (!cleanupComplete) await runtime.endRun(identity).catch(() => undefined);
    await closeServer(fixture.server);
    registry.clear();
    resetManagedBrowserProviderAdapterForTests();
    resetSurfaceExecutionRuntimeForTests();
    resetApplicationRunRegistryForTests();
  }
}

main().catch(finishWithError);
