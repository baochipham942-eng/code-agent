import {
  finishWithError,
  hasFlag,
  parseArgs,
  printJson,
  printKeyValue,
} from './_helpers.ts';
import { createServer, type Server } from 'http';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  formatAcceptanceError,
  makeSystemChromeProviderOptions,
  SYSTEM_CHROME_CDP_PROVIDER,
} from './browser-computer-system-chrome.ts';
import {
  browserService,
  type BrowserArtifactSummary,
  type BrowserDomSnapshot,
} from '../../src/main/services/infra/browserService.ts';
import { browserActionTool } from '../../src/main/tools/vision/browserAction.ts';
import type { Tool, ToolContext, ToolExecutionResult } from '../../src/main/tools/types.ts';
import type {
  ManagedBrowserAccountStateSummary,
  WorkbenchActionTrace,
} from '../../src/shared/contract/desktop.ts';
import { sanitizeBrowserComputerToolResult } from '../../src/shared/utils/browserComputerRedaction.ts';

interface BenchmarkCaseResult {
  id: string;
  ok: boolean;
  durationMs: number;
  evidence: Record<string, unknown>;
  failures: string[];
}

interface BrowserTaskRecipeStep {
  action: string;
  args: Record<string, unknown>;
}

interface BrowserTaskRecipeDraft {
  id: string;
  name: string;
  sourceTraceId: string | null;
  fixtureOnly: true;
  allowedOrigins: string[];
  steps: BrowserTaskRecipeStep[];
}

interface FixtureServer {
  server: Server;
  origin: string;
}

function usage(): void {
  console.log(`Browser Task Benchmark

Usage:
  npm run acceptance:browser-task-benchmark -- [options]

Options:
  --visible        Launch managed browser in visible mode.
  --provider <id>  Browser provider. Default: system-chrome-cdp.
  --keep-browser   Keep the managed browser open after the benchmark.
  --json           Print JSON only.
  --help           Show this help.

What it validates:
  - BT-01 navigation_snapshot
  - BT-02 form_fill redaction
  - BT-03 extract_schema
  - BT-04 login_like_mock account state
  - BT-05 download_upload_mock artifacts
  - BT-06 failure_recovery stale targetRef retry
  - BT-07 redaction_export surfaces
  - fixture-only trace to recipe draft and rerun`);
}

function html(title: string, body: string, script = ''): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>${title}</title>
    ${script ? `<script>${script}</script>` : ''}
  </head>
  <body>
    <main>
      ${body}
    </main>
  </body>
</html>`;
}

async function startFixtureServer(runId: string): Promise<FixtureServer> {
  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url || '/', 'http://127.0.0.1');
    response.setHeader('cache-control', 'no-store');

    if (requestUrl.pathname === '/download/report.txt') {
      response.writeHead(200, {
        'content-type': 'text/plain; charset=utf-8',
        'content-disposition': 'attachment; filename="phase6-report.txt"',
      });
      response.end(`download:${runId}`);
      return;
    }

    if (requestUrl.pathname === '/nav') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(html(
        'BT-01 Navigation Snapshot',
        `<h1>BT-01 Navigation Snapshot</h1>
        <p id="nav-status">Ready</p>
        <button id="benchmark-nav-action" onclick="document.body.dataset.navClicked='yes';document.querySelector('#nav-status').textContent='Clicked'">Run nav action</button>`,
      ));
      return;
    }

    if (requestUrl.pathname === '/form') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(html(
        'BT-02 Form Fill',
        `<h1>BT-02 Form Fill</h1>
        <label for="benchmark-email">Email</label>
        <input id="benchmark-email" placeholder="email" autocomplete="off" />
        <button id="form-submit" onclick="submitBenchmarkForm()">Submit</button>
        <p id="form-status">Waiting</p>`,
        `function submitBenchmarkForm() {
          const value = document.querySelector('#benchmark-email').value || '';
          window.__formSubmitLength = value.length;
          document.body.dataset.formSubmitted = value.length > 0 ? 'yes' : 'no';
          document.querySelector('#form-status').textContent = value.length > 0 ? 'Submitted' : 'Missing';
        }`,
      ));
      return;
    }

    if (requestUrl.pathname === '/extract') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(html(
        'BT-03 Extract Schema',
        `<h1>BT-03 Extract Schema</h1>
        <script id="benchmark-data" type="application/json">${JSON.stringify({
          runId,
          invoice: {
            id: `inv-${runId}`,
            total: 42.25,
            currency: 'USD',
            lines: [
              { sku: 'browser-agent', qty: 1 },
            ],
          },
        })}</script>
        <table>
          <tbody>
            <tr><th>Invoice</th><td>inv-${runId}</td></tr>
            <tr><th>Total</th><td>42.25</td></tr>
          </tbody>
        </table>`,
      ));
      return;
    }

    if (requestUrl.pathname === '/login') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(html(
        'BT-04 Login Like Mock',
        `<h1>BT-04 Login Like Mock</h1>
        <p id="account-status">Logged Out</p>
        <button id="mock-login-button" onclick="markLoggedIn()">Mock Login</button>`,
        `const RUN_ID = ${JSON.stringify(runId)};
        function markLoggedIn() {
          document.cookie = 'benchmark_session=' + RUN_ID + '; path=/; max-age=3600; SameSite=Lax';
          localStorage.setItem('benchmark_login', RUN_ID);
          sessionStorage.setItem('benchmark_session_tab', RUN_ID);
          document.body.dataset.loggedIn = 'yes';
          document.querySelector('#account-status').textContent = 'Logged In';
        }
        function readBenchmarkAccountState() {
          return {
            hasCookie: document.cookie.includes(RUN_ID),
            localStorageOk: localStorage.getItem('benchmark_login') === RUN_ID,
            sessionStorageOk: sessionStorage.getItem('benchmark_session_tab') === RUN_ID,
            status: document.querySelector('#account-status')?.textContent || null
          };
        }`,
      ));
      return;
    }

    if (requestUrl.pathname === '/transfer') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(html(
        'BT-05 Download Upload',
        `<h1>BT-05 Download Upload</h1>
        <a id="download-link" href="/download/report.txt" download>Download report</a>
        <input id="upload-input" type="file" onchange="readUpload(this)" />
        <p id="upload-status">No upload</p>`,
        `function readUpload(input) {
          const file = input.files && input.files[0];
          if (!file) return;
          file.text().then((text) => {
            window.__uploadReadback = { name: file.name, size: file.size, textLength: text.length, textHash: text };
            document.querySelector('#upload-status').textContent = file.name + ':' + file.size;
          });
        }`,
      ));
      return;
    }

    if (requestUrl.pathname === '/recovery') {
      const step = requestUrl.searchParams.get('step') || '1';
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(html(
        'BT-06 Failure Recovery',
        `<h1>BT-06 Failure Recovery</h1>
        <p id="recovery-status">Step ${step}</p>
        <button id="recovery-button" onclick="window.__recoveryClicked='${step}';document.querySelector('#recovery-status').textContent='Recovered ${step}'">Recover ${step}</button>`,
      ));
      return;
    }

    if (requestUrl.pathname === '/recipe') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(html(
        'BT Recipe Fixture',
        `<h1>BT Recipe Fixture</h1>
        <p id="recipe-status">Ready</p>
        <button id="recipe-run" onclick="window.__recipeRunCount=(window.__recipeRunCount||0)+1;document.querySelector('#recipe-status').textContent='Recipe Done'">Run recipe</button>`,
      ));
      return;
    }

    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('not found');
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Benchmark fixture server did not expose a TCP port');
  }
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

function closeServer(server: Server | null): Promise<void> {
  if (!server) {
    return Promise.resolve();
  }
  return new Promise((resolve) => server.close(() => resolve()));
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function makeToolContext(provider: string, mode: 'headless' | 'visible'): ToolContext {
  return {
    workingDirectory: process.cwd(),
    sessionId: 'browser-task-benchmark',
    requestPermission: async () => true,
    executionIntent: {
      browserSessionMode: 'managed',
      browserProvider: provider,
      preferBrowserSession: true,
      allowBrowserAutomation: true,
      browserSessionSnapshot: {
        ready: true,
        provider,
        mode,
      },
    },
  };
}

async function executeTool(
  tool: Tool,
  params: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  return tool.execute(params, context);
}

async function runTool(
  tool: Tool,
  params: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const result = await executeTool(tool, params, context);
  if (!result.success) {
    throw new Error(result.error || `${tool.name} failed`);
  }
  return result;
}

function getMetadata<T>(result: ToolExecutionResult, key: string): T | null {
  return (result.metadata?.[key] as T | undefined) || null;
}

function findElement(snapshot: BrowserDomSnapshot | null, selector: string) {
  return snapshot?.interactiveElements.find((element) => element.selectorHint === selector) || null;
}

async function runCase(
  id: string,
  fn: () => Promise<Record<string, unknown>>,
): Promise<BenchmarkCaseResult> {
  const startedAt = Date.now();
  try {
    const evidence = await fn();
    const failures = Array.isArray(evidence.failures)
      ? evidence.failures.filter((item): item is string => typeof item === 'string')
      : [];
    const { failures: _failures, ...publicEvidence } = evidence;
    return {
      id,
      ok: failures.length === 0,
      durationMs: Date.now() - startedAt,
      evidence: publicEvidence,
      failures,
    };
  } catch (error) {
    return {
      id,
      ok: false,
      durationMs: Date.now() - startedAt,
      evidence: {},
      failures: [error instanceof Error ? error.message : String(error)],
    };
  }
}

function makeLaunchOptions(
  provider: string,
  mode: 'headless' | 'visible',
  profileMode?: 'persistent' | 'isolated',
): Record<string, unknown> {
  const base = provider === SYSTEM_CHROME_CDP_PROVIDER
    ? makeSystemChromeProviderOptions(mode)
    : { mode, provider };
  return {
    ...base,
    ...(profileMode ? { profileMode } : {}),
    leaseOwner: 'browser_task_benchmark',
  };
}

function createExpiredStorageState(origin: string, runId: string): Record<string, unknown> {
  return {
    cookies: [{
      name: 'benchmark_expired',
      value: `expired-${runId}`,
      domain: '127.0.0.1',
      path: '/',
      expires: Math.max(1, Math.floor(Date.now() / 1000) - 60),
      httpOnly: false,
      secure: false,
      sameSite: 'Lax',
    }],
    origins: [{
      origin,
      localStorage: [],
    }],
  };
}

function includesSensitiveValue(value: unknown, needles: string[]): boolean {
  const text = JSON.stringify(value);
  return needles.some((needle) => needle.length > 0 && text.includes(needle));
}

function createRecipeDraftFromTrace(
  sourceTrace: WorkbenchActionTrace | null,
  origin: string,
): BrowserTaskRecipeDraft {
  const targetRef = sourceTrace?.params?.targetRef as { selector?: unknown } | undefined;
  const selector = typeof targetRef?.selector === 'string' ? targetRef.selector : '#recipe-run';
  return {
    id: `recipe_${Date.now()}`,
    name: 'Fixture recipe from successful trace',
    sourceTraceId: sourceTrace?.id ?? null,
    fixtureOnly: true,
    allowedOrigins: [origin],
    steps: [
      { action: 'navigate', args: { url: `${origin}/recipe` } },
      { action: 'click', args: { selector } },
    ],
  };
}

async function runFixtureRecipe(
  recipe: BrowserTaskRecipeDraft,
  context: ToolContext,
): Promise<{ passed: boolean; stepCount: number; status: string | null; runCount: number }> {
  for (const step of recipe.steps) {
    const url = typeof step.args.url === 'string' ? step.args.url : null;
    if (url && !recipe.allowedOrigins.some((origin) => url.startsWith(`${origin}/`))) {
      throw new Error(`Recipe URL is outside controlled fixture origins: ${url}`);
    }
    await runTool(browserActionTool, {
      action: step.action,
      ...step.args,
    }, context);
  }

  const readback = await browserService.runScript<{ status: string | null; runCount: number }>(`(() => ({
    status: document.querySelector('#recipe-status')?.textContent || null,
    runCount: window.__recipeRunCount || 0
  }))()`);
  return {
    passed: readback.status === 'Recipe Done' && readback.runCount === 1,
    stepCount: recipe.steps.length,
    status: readback.status,
    runCount: readback.runCount,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (hasFlag(args, 'help')) {
    usage();
    return;
  }

  if (hasFlag(args, 'visible')) {
    process.env.CODE_AGENT_BROWSER_VISIBLE = '1';
  }

  const provider = getProvider(args);
  const mode = hasFlag(args, 'visible') ? 'visible' : 'headless';
  const context = makeToolContext(provider, mode);
  const runId = `bt-${Date.now()}`;
  const cases: BenchmarkCaseResult[] = [];
  let fixture: FixtureServer | null = null;
  let tmpDir: string | null = null;
  let recipeDraft: BrowserTaskRecipeDraft | null = null;
  let recipeResult: { passed: boolean; stepCount: number; status: string | null; runCount: number } | null = null;
  let recoveryReportStatus: string | null = null;

  try {
    fixture = await startFixtureServer(runId);
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-agent-browser-task-benchmark-'));
    const storageStatePath = path.join(tmpDir, 'storage-state.json');
    const expiredStorageStatePath = path.join(tmpDir, 'expired-storage-state.json');
    const uploadFilePath = path.join(tmpDir, 'phase6-upload.txt');
    fs.writeFileSync(uploadFilePath, `upload:${runId}`);
    fs.writeFileSync(expiredStorageStatePath, JSON.stringify(createExpiredStorageState(fixture.origin, runId), null, 2));

    await browserService.close().catch(() => undefined);
    await browserService.launch(makeLaunchOptions(provider, mode, 'persistent')).catch((error) => {
      throw new Error(formatAcceptanceError(error));
    });

    cases.push(await runCase('BT-01 navigation_snapshot', async () => {
      const failures: string[] = [];
      await runTool(browserActionTool, { action: 'navigate', url: `${fixture!.origin}/nav` }, context);
      const domResult = await runTool(browserActionTool, { action: 'get_dom_snapshot' }, context);
      const a11yResult = await runTool(browserActionTool, { action: 'get_a11y_snapshot' }, context);
      const snapshot = getMetadata<BrowserDomSnapshot>(domResult, 'domSnapshot');
      const target = findElement(snapshot, '#benchmark-nav-action');
      const trace = getMetadata<WorkbenchActionTrace>(domResult, 'workbenchTrace');

      if (snapshot?.title !== 'BT-01 Navigation Snapshot') {
        failures.push(`Unexpected page title: ${snapshot?.title || 'missing'}.`);
      }
      if (!snapshot?.headings.some((heading) => heading.text === 'BT-01 Navigation Snapshot')) {
        failures.push('Heading was not captured in DOM snapshot.');
      }
      if (!target?.targetRef?.refId) {
        failures.push('Interactive element did not include targetRef.');
      }
      if (!a11yResult.success) {
        failures.push('Accessibility snapshot did not succeed.');
      }

      return {
        title: snapshot?.title ?? null,
        headingCount: snapshot?.headings.length ?? 0,
        interactiveCount: snapshot?.interactiveElements.length ?? 0,
        targetRefId: target?.targetRef?.refId ?? null,
        snapshotId: snapshot?.snapshotId ?? null,
        traceId: trace?.id ?? null,
        failures,
      };
    }));

    cases.push(await runCase('BT-02 form_fill', async () => {
      const failures: string[] = [];
      const secretText = `phase6-secret-${runId}@example.test`;
      await runTool(browserActionTool, { action: 'navigate', url: `${fixture!.origin}/form` }, context);
      const snapshotResult = await runTool(browserActionTool, { action: 'get_dom_snapshot' }, context);
      const snapshot = getMetadata<BrowserDomSnapshot>(snapshotResult, 'domSnapshot');
      const input = findElement(snapshot, '#benchmark-email');
      const submit = findElement(snapshot, '#form-submit');
      const typeResult = await runTool(browserActionTool, {
        action: 'type',
        ...(input?.targetRef ? { targetRef: input.targetRef } : { selector: '#benchmark-email' }),
        text: secretText,
      }, context);
      const clickResult = await runTool(browserActionTool, {
        action: 'click',
        ...(submit?.targetRef ? { targetRef: submit.targetRef } : { selector: '#form-submit' }),
      }, context);
      const readback = await browserService.runScript<{ submitted: string | null; length: number; status: string | null }>(`(() => ({
        submitted: document.body.dataset.formSubmitted || null,
        length: window.__formSubmitLength || 0,
        status: document.querySelector('#form-status')?.textContent || null
      }))()`);
      const typeTrace = getMetadata<WorkbenchActionTrace>(typeResult, 'workbenchTrace');
      const sanitizedTypeResult = sanitizeBrowserComputerToolResult('browser_action', {
        action: 'type',
        text: secretText,
      }, typeResult);

      if (readback.submitted !== 'yes' || readback.length !== secretText.length || readback.status !== 'Submitted') {
        failures.push('Form submit did not capture the typed input length.');
      }
      if (includesSensitiveValue(typeResult, [secretText])) {
        failures.push('Raw type tool result leaked typed text.');
      }
      if (includesSensitiveValue(typeTrace?.params, [secretText])) {
        failures.push('Workbench trace params leaked typed text.');
      }
      if (includesSensitiveValue(sanitizedTypeResult, [secretText])) {
        failures.push('Sanitized type result leaked typed text.');
      }

      return {
        submitted: readback.submitted,
        typedLength: readback.length,
        typeTraceId: typeTrace?.id ?? null,
        clickTraceId: getMetadata<WorkbenchActionTrace>(clickResult, 'workbenchTrace')?.id ?? null,
        sanitizedPreview: sanitizedTypeResult.output ?? null,
        failures,
      };
    }));

    cases.push(await runCase('BT-03 extract_schema', async () => {
      const failures: string[] = [];
      await runTool(browserActionTool, { action: 'navigate', url: `${fixture!.origin}/extract` }, context);
      const extracted = await browserService.runScript<{
        runId?: string;
        invoice?: { id?: string; total?: number; currency?: string; lines?: Array<{ sku?: string; qty?: number }> };
      }>(`(() => JSON.parse(document.querySelector('#benchmark-data').textContent))()`);

      if (extracted.runId !== runId) {
        failures.push('Extracted runId did not match fixture.');
      }
      if (!extracted.invoice?.id || typeof extracted.invoice.total !== 'number' || extracted.invoice.currency !== 'USD') {
        failures.push('Extracted invoice did not match schema.');
      }
      if (!Array.isArray(extracted.invoice?.lines) || extracted.invoice.lines[0]?.sku !== 'browser-agent') {
        failures.push('Extracted invoice lines did not match schema.');
      }

      return {
        invoiceId: extracted.invoice?.id ?? null,
        total: extracted.invoice?.total ?? null,
        currency: extracted.invoice?.currency ?? null,
        lineCount: extracted.invoice?.lines?.length ?? 0,
        failures,
      };
    }));

    cases.push(await runCase('BT-04 login_like_mock', async () => {
      const failures: string[] = [];
      await runTool(browserActionTool, { action: 'navigate', url: `${fixture!.origin}/login` }, context);
      const loginSnapshotResult = await runTool(browserActionTool, { action: 'get_dom_snapshot' }, context);
      const loginSnapshot = getMetadata<BrowserDomSnapshot>(loginSnapshotResult, 'domSnapshot');
      const loginButton = findElement(loginSnapshot, '#mock-login-button');
      await runTool(browserActionTool, {
        action: 'click',
        ...(loginButton?.targetRef ? { targetRef: loginButton.targetRef } : { selector: '#mock-login-button' }),
      }, context);
      const loggedIn = await browserService.runScript<{ hasCookie: boolean; localStorageOk: boolean; sessionStorageOk: boolean; status: string | null }>('readBenchmarkAccountState()');
      const accountStateResult = await runTool(browserActionTool, { action: 'get_account_state' }, context);
      const accountState = getMetadata<ManagedBrowserAccountStateSummary>(accountStateResult, 'browserAccountState');
      await runTool(browserActionTool, { action: 'export_storage_state', storageStatePath }, context);

      await browserService.close();
      await browserService.launch(makeLaunchOptions(provider, mode, 'persistent')).catch((error) => {
        throw new Error(formatAcceptanceError(error));
      });
      await runTool(browserActionTool, { action: 'navigate', url: `${fixture!.origin}/login` }, context);
      const persistentReadback = await browserService.runScript<{ hasCookie: boolean; localStorageOk: boolean; sessionStorageOk: boolean; status: string | null }>('readBenchmarkAccountState()');

      await browserService.close();
      await browserService.launch(makeLaunchOptions(provider, mode, 'isolated')).catch((error) => {
        throw new Error(formatAcceptanceError(error));
      });
      await runTool(browserActionTool, { action: 'navigate', url: `${fixture!.origin}/login` }, context);
      const isolatedBeforeImport = await browserService.runScript<{ hasCookie: boolean; localStorageOk: boolean }>('readBenchmarkAccountState()');
      await runTool(browserActionTool, { action: 'import_storage_state', storageStatePath }, context);
      await runTool(browserActionTool, { action: 'reload' }, context);
      const importedReadback = await browserService.runScript<{ hasCookie: boolean; localStorageOk: boolean; sessionStorageOk: boolean; status: string | null }>('readBenchmarkAccountState()');
      const expiredImportResult = await runTool(browserActionTool, {
        action: 'import_storage_state',
        storageStatePath: expiredStorageStatePath,
      }, context);
      const expiredState = getMetadata<ManagedBrowserAccountStateSummary>(expiredImportResult, 'browserAccountState');

      if (!loggedIn.hasCookie || !loggedIn.localStorageOk || !loggedIn.sessionStorageOk) {
        failures.push('Mock login did not set cookie/localStorage/sessionStorage.');
      }
      if (accountState?.status !== 'available') {
        failures.push(`Account state was not available after mock login: ${accountState?.status || 'missing'}.`);
      }
      if (!persistentReadback.hasCookie || !persistentReadback.localStorageOk) {
        failures.push('Persistent profile did not recover cookie/localStorage after relaunch.');
      }
      if (isolatedBeforeImport.hasCookie || isolatedBeforeImport.localStorageOk) {
        failures.push('Isolated profile unexpectedly shared persistent account state before import.');
      }
      if (!importedReadback.hasCookie || !importedReadback.localStorageOk) {
        failures.push('Imported storageState did not recover cookie/localStorage in isolated profile.');
      }
      if (expiredState?.status !== 'account_state_expired') {
        failures.push(`Expired storageState was not classified as account_state_expired: ${expiredState?.status || 'missing'}.`);
      }

      return {
        accountStatus: accountState?.status ?? null,
        cookieCount: accountState?.cookieCount ?? null,
        persistentRecovered: persistentReadback.hasCookie && persistentReadback.localStorageOk,
        isolatedSharedBeforeImport: isolatedBeforeImport.hasCookie || isolatedBeforeImport.localStorageOk,
        importedRecovered: importedReadback.hasCookie && importedReadback.localStorageOk,
        expiredStatus: expiredState?.status ?? null,
        failures,
      };
    }));

    cases.push(await runCase('BT-05 download_upload_mock', async () => {
      const failures: string[] = [];
      await runTool(browserActionTool, { action: 'navigate', url: `${fixture!.origin}/transfer` }, context);
      const downloadResult = await runTool(browserActionTool, {
        action: 'wait_for_download',
        selector: '#download-link',
      }, context);
      const downloadArtifact = getMetadata<BrowserArtifactSummary>(downloadResult, 'browserArtifact');
      const uploadResult = await runTool(browserActionTool, {
        action: 'upload_file',
        selector: '#upload-input',
        uploadFilePath,
      }, context);
      const uploadArtifact = getMetadata<BrowserArtifactSummary>(uploadResult, 'browserArtifact');
      const uploadReadback = await browserService.runScript<{ name: string | null; size: number; textLength: number; textHash: string | null }>(`new Promise((resolve) => {
        const started = Date.now();
        const poll = () => {
          if (window.__uploadReadback || Date.now() - started > 3000) {
            resolve(window.__uploadReadback || { name: null, size: 0, textLength: 0, textHash: null });
            return;
          }
          setTimeout(poll, 50);
        };
        poll();
      })`);

      if (downloadArtifact?.name !== 'phase6-report.txt' || downloadArtifact.sha256 !== sha256(`download:${runId}`)) {
        failures.push('Download artifact did not match expected name/hash.');
      }
      if (uploadArtifact?.name !== 'phase6-upload.txt' || uploadArtifact.sha256 !== sha256(`upload:${runId}`)) {
        failures.push('Upload artifact did not match expected name/hash.');
      }
      if (uploadReadback.name !== 'phase6-upload.txt' || uploadReadback.textHash !== `upload:${runId}`) {
        failures.push('Upload fixture did not read back file name/content.');
      }

      return {
        downloadArtifactName: downloadArtifact?.name ?? null,
        downloadArtifactSha256: downloadArtifact?.sha256 ?? null,
        uploadArtifactName: uploadArtifact?.name ?? null,
        uploadArtifactSha256: uploadArtifact?.sha256 ?? null,
        uploadReadbackName: uploadReadback.name,
        failures,
      };
    }));

    cases.push(await runCase('BT-06 failure_recovery', async () => {
      const failures: string[] = [];
      await runTool(browserActionTool, { action: 'navigate', url: `${fixture!.origin}/recovery?step=1` }, context);
      const firstSnapshotResult = await runTool(browserActionTool, { action: 'get_dom_snapshot' }, context);
      const firstSnapshot = getMetadata<BrowserDomSnapshot>(firstSnapshotResult, 'domSnapshot');
      const staleTarget = findElement(firstSnapshot, '#recovery-button')?.targetRef;
      if (!staleTarget) {
        failures.push('Recovery fixture did not expose the initial targetRef.');
      }

      await runTool(browserActionTool, { action: 'navigate', url: `${fixture!.origin}/recovery?step=2` }, context);
      const staleResult = staleTarget
        ? await executeTool(browserActionTool, { action: 'click', targetRef: staleTarget }, context)
        : { success: false, error: 'missing targetRef', metadata: {} };
      const recoveryOutcome = staleResult.metadata?.browserComputerRecoveryActionOutcome as { status?: string; retryHint?: string } | undefined;
      recoveryReportStatus = typeof recoveryOutcome?.status === 'string' ? recoveryOutcome.status : null;
      const freshSnapshotResult = await runTool(browserActionTool, { action: 'get_dom_snapshot' }, context);
      const freshSnapshot = getMetadata<BrowserDomSnapshot>(freshSnapshotResult, 'domSnapshot');
      const freshTarget = findElement(freshSnapshot, '#recovery-button')?.targetRef;
      const retryResult = await runTool(browserActionTool, {
        action: 'click',
        ...(freshTarget ? { targetRef: freshTarget } : { selector: '#recovery-button' }),
      }, context);
      const retryReadback = await browserService.runScript<{ clicked: string | null; status: string | null }>(`(() => ({
        clicked: window.__recoveryClicked || null,
        status: document.querySelector('#recovery-status')?.textContent || null
      }))()`);

      if (staleResult.success) {
        failures.push('Stale targetRef click unexpectedly succeeded.');
      }
      if (staleResult.metadata?.code !== 'STALE_TARGET_REF' || recoveryOutcome?.status !== 'recoverable') {
        failures.push('Stale targetRef did not return recoverable metadata.');
      }
      if (retryReadback.clicked !== '2' || retryReadback.status !== 'Recovered 2') {
        failures.push('Fresh targetRef retry did not recover the action.');
      }

      return {
        staleCode: staleResult.metadata?.code ?? null,
        recoveryStatus: recoveryOutcome?.status ?? null,
        retryHint: recoveryOutcome?.retryHint ?? null,
        retryTraceId: getMetadata<WorkbenchActionTrace>(retryResult, 'workbenchTrace')?.id ?? null,
        retryStatus: retryReadback.status,
        failures,
      };
    }));

    cases.push(await runCase('BT-07 redaction_export', async () => {
      const failures: string[] = [];
      const secret = `phase6-redaction-secret-${runId}`;
      const cookieValue = `cookie-value-${runId}`;
      const screenshotBase64 = 'data:image/png;base64,QUJDREVGRw==';
      const rawResult: ToolExecutionResult = {
        success: true,
        output: `Typed ${secret} safely`,
        metadata: {
          screenshotBase64,
          cookie: { value: cookieValue },
          browserWorkbenchState: {
            profileDir: '/Users/linchen/private/profile',
            artifactDir: '/Users/linchen/private/artifacts',
            storageState: { cookies: [{ value: cookieValue }] },
          },
          workbenchTrace: {
            id: 'trace-redaction',
            targetKind: 'browser',
            toolName: 'browser_action',
            action: 'type',
            startedAtMs: Date.now(),
            params: {
              action: 'type',
              text: secret,
              cookie: cookieValue,
              storageStatePath: '/Users/linchen/private/storage-state.json',
            },
            success: true,
          },
        },
      };
      const safeResult = sanitizeBrowserComputerToolResult('browser_action', {
        action: 'type',
        text: secret,
      }, rawResult);
      const safeJson = JSON.stringify(safeResult);

      if (safeJson.includes(secret)) {
        failures.push('Sanitized export still contained typed secret.');
      }
      if (safeJson.includes(cookieValue)) {
        failures.push('Sanitized export still contained cookie value.');
      }
      if (safeJson.includes('QUJDREVGRw') || safeJson.includes('screenshotBase64')) {
        failures.push('Sanitized export still contained screenshot base64.');
      }
      if (safeJson.includes('/Users/linchen/private')) {
        failures.push('Sanitized export still contained raw local paths.');
      }

      return {
        secretRedacted: !safeJson.includes(secret),
        cookieRedacted: !safeJson.includes(cookieValue),
        screenshotBase64Removed: !safeJson.includes('QUJDREVGRw') && !safeJson.includes('screenshotBase64'),
        rawPathRemoved: !safeJson.includes('/Users/linchen/private'),
        failures,
      };
    }));

    const recipeSourceTrace = await createRecipeSourceTrace(fixture.origin, context);
    recipeDraft = createRecipeDraftFromTrace(recipeSourceTrace, fixture.origin);
    recipeResult = await runFixtureRecipe(recipeDraft, context);
    if (!recipeResult.passed) {
      cases.push({
        id: 'BT-08 recipe_fixture_runner',
        ok: false,
        durationMs: 0,
        evidence: recipeResult,
        failures: ['Fixture recipe runner did not complete the controlled recipe.'],
      });
    }

    const failures = cases.flatMap((item) => item.failures.map((failure) => `${item.id}: ${failure}`));
    if (!recipeDraft?.sourceTraceId) {
      failures.push('recipe: missing source trace id.');
    }
    if (!recipeResult?.passed) {
      failures.push('recipe: fixture recipe rerun failed.');
    }

    const result = {
      ok: failures.length === 0,
      provider,
      mode,
      fixtureOrigin: fixture.origin,
      passedCases: cases.filter((item) => item.ok).length,
      totalCases: cases.length,
      cases,
      recoveryReportStatus,
      recipe: {
        draftId: recipeDraft?.id ?? null,
        sourceTraceId: recipeDraft?.sourceTraceId ?? null,
        fixtureOnly: recipeDraft?.fixtureOnly ?? null,
        allowedOrigins: recipeDraft?.allowedOrigins ?? [],
        stepCount: recipeDraft?.steps.length ?? 0,
        runnerPassed: recipeResult?.passed ?? false,
        runnerStatus: recipeResult?.status ?? null,
      },
      failures,
    };

    if (hasFlag(args, 'json')) {
      printJson(result);
    } else {
      printKeyValue('Browser Task Benchmark Summary', [
        ['browserProvider', provider],
        ['browserMode', mode],
        ['passedCases', result.passedCases],
        ['totalCases', result.totalCases],
        ['recoveryReportStatus', result.recoveryReportStatus],
        ['recipeDraftId', result.recipe.draftId],
        ['recipeSourceTraceId', result.recipe.sourceTraceId],
        ['recipeRunnerPassed', result.recipe.runnerPassed],
      ]);
      if (failures.length > 0) {
        console.log('\nFailures');
        for (const failure of failures) {
          console.log(`- ${failure}`);
        }
      } else {
        console.log('\nBrowser task benchmark passed.');
      }
    }

    if (failures.length > 0) {
      process.exit(1);
    }
  } finally {
    if (!hasFlag(args, 'keep-browser')) {
      await browserService.close().catch(() => undefined);
    }
    await closeServer(fixture?.server ?? null).catch(() => undefined);
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }
}

async function createRecipeSourceTrace(
  origin: string,
  context: ToolContext,
): Promise<WorkbenchActionTrace | null> {
  await runTool(browserActionTool, { action: 'navigate', url: `${origin}/recipe` }, context);
  const snapshotResult = await runTool(browserActionTool, { action: 'get_dom_snapshot' }, context);
  const snapshot = getMetadata<BrowserDomSnapshot>(snapshotResult, 'domSnapshot');
  const recipeTarget = findElement(snapshot, '#recipe-run');
  const clickResult = await runTool(browserActionTool, {
    action: 'click',
    ...(recipeTarget?.targetRef ? { targetRef: recipeTarget.targetRef } : { selector: '#recipe-run' }),
  }, context);
  return getMetadata<WorkbenchActionTrace>(clickResult, 'workbenchTrace');
}

function getProvider(args: ReturnType<typeof parseArgs>): string {
  const value = args.options.provider;
  if (value === undefined || value === true) {
    return SYSTEM_CHROME_CDP_PROVIDER;
  }
  return Array.isArray(value) ? value[value.length - 1] : value;
}

main().catch((error) => finishWithError(formatAcceptanceError(error)));
