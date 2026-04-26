import {
  finishWithError,
  hasFlag,
  parseArgs,
  printJson,
  printKeyValue,
} from './_helpers.ts';
import { createServer, type Server } from 'http';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import {
  formatAcceptanceError,
  makeSystemChromeProviderOptions,
  SYSTEM_CHROME_CDP_PROVIDER,
} from './browser-computer-system-chrome.ts';
import { browserService } from '../../src/main/services/infra/browserService.ts';
import { browserActionTool } from '../../src/main/tools/vision/browserAction.ts';
import { computerUseTool } from '../../src/main/tools/vision/computerUse.ts';
import type { Tool, ToolContext, ToolExecutionResult } from '../../src/main/tools/types.ts';
import type { BrowserDomSnapshot } from '../../src/main/services/infra/browserService.ts';
import type {
  ManagedBrowserSessionState,
  WorkbenchActionTrace,
} from '../../src/shared/contract/desktop.ts';

function usage(): void {
  console.log(`Browser / Computer phase3 workflow smoke

Usage:
  npm run acceptance:browser-computer-workflow -- [options]

Options:
  --visible        Launch managed browser in visible mode.
  --provider <id>  Browser provider. Default: system-chrome-cdp.
  --keep-browser   Keep the managed browser open after the smoke.
  --json           Print JSON only.
  --help           Show this help.

What it validates:
  - managed browser can run an isolated workflow page
  - browser_action can observe DOM before acting
  - browser_action can perform one safe click inside the managed browser
  - DOM/readback state reflects the click
  - browser workbench trace metadata captures the action, mode, params, and success
  - computer_use remains limited to read-only state observation`);
}

function makeWorkflowUrl(): string {
  const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>Phase3 Browser Computer Workflow</title>
    <script>
      window.__phase3ClickCount = 0;
      function markClicked() {
        window.__phase3ClickCount += 1;
        document.body.dataset.phase3Clicked = 'yes';
        document.querySelector('#phase3-status').textContent = 'Clicked';
        document.querySelector('#phase3-workflow-button').textContent = 'Clicked';
      }
    </script>
  </head>
  <body>
    <main>
      <h1>Phase3 Workflow</h1>
      <p id="phase3-status">Waiting</p>
      <button id="phase3-workflow-button" onclick="markClicked()">Run safe action</button>
    </main>
  </body>
</html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

async function startMockLoginServer(runId: string): Promise<{ server: Server; url: string }> {
  const server = createServer((request, response) => {
    if (request.url === '/download/report.txt') {
      response.writeHead(200, {
        'content-type': 'text/plain; charset=utf-8',
        'content-disposition': 'attachment; filename="phase4-report.txt"',
        'cache-control': 'no-store',
      });
      response.end(`download:${runId}`);
      return;
    }
    if (request.url !== '/mock-login') {
      response.writeHead(404).end('not found');
      return;
    }
    const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>Phase3 AccountState Mock Login</title>
    <script>
      const RUN_ID = ${JSON.stringify(runId)};
      function markLoggedIn() {
        document.cookie = 'mock_session=' + RUN_ID + '; path=/; max-age=3600; SameSite=Lax';
        localStorage.setItem('mock_login', RUN_ID);
        sessionStorage.setItem('mock_session_tab', RUN_ID);
        document.body.dataset.loggedIn = 'yes';
        document.querySelector('#account-status').textContent = 'Logged In';
        document.querySelector('#mock-login-button').textContent = 'Logged In';
      }
      function readState() {
        return {
          cookie: document.cookie,
          localStorage: localStorage.getItem('mock_login'),
          sessionStorage: sessionStorage.getItem('mock_session_tab'),
          status: document.querySelector('#account-status')?.textContent || null,
        };
      }
      function markUpload(input) {
        const file = input.files && input.files[0];
        if (!file) return;
        file.text().then((text) => {
          window.__uploadReadback = { name: file.name, size: file.size, text };
          document.querySelector('#upload-status').textContent = file.name + ':' + file.size;
        });
      }
    </script>
  </head>
  <body>
    <main>
      <h1>Phase3 AccountState</h1>
      <p id="account-status">Logged Out</p>
      <button id="mock-login-button" onclick="markLoggedIn()">Mock Login</button>
      <a id="mock-download-link" href="/download/report.txt" download>Download report</a>
      <input id="mock-upload-input" type="file" onchange="markUpload(this)" />
      <p id="upload-status">No upload</p>
    </main>
  </body>
</html>`;
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    });
    response.end(html);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Mock login server did not expose a TCP port');
  }
  return {
    server,
    url: `http://127.0.0.1:${address.port}/mock-login`,
  };
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

function makeToolContext(): ToolContext {
  const mode = process.env.CODE_AGENT_BROWSER_VISIBLE === '1' ? 'visible' : 'headless';
  return {
    workingDirectory: process.cwd(),
    sessionId: 'browser-computer-workflow-smoke',
    requestPermission: async () => true,
    executionIntent: {
      browserSessionMode: 'managed',
      browserProvider: SYSTEM_CHROME_CDP_PROVIDER,
      preferBrowserSession: true,
      allowBrowserAutomation: true,
      browserSessionSnapshot: {
        ready: true,
        provider: SYSTEM_CHROME_CDP_PROVIDER,
        mode,
      },
    },
  };
}

async function runTool(
  tool: Tool,
  params: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const result = await tool.execute(params, context);
  if (!result.success) {
    throw new Error(result.error || `${tool.name} failed`);
  }
  return result;
}

function getMetadata<T>(result: ToolExecutionResult, key: string): T | null {
  return (result.metadata?.[key] as T | undefined) || null;
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

  const context = makeToolContext();
  const failures: string[] = [];
  let browserState: ManagedBrowserSessionState | null = null;
  let beforeSnapshot: BrowserDomSnapshot | null = null;
  let afterSnapshot: BrowserDomSnapshot | null = null;
  let navigateTrace: WorkbenchActionTrace | null = null;
  let clickTrace: WorkbenchActionTrace | null = null;
  let computerTrace: WorkbenchActionTrace | null = null;
  let clickTargetRefId: string | null = null;
  let readback: { clicked: string | null; count: number; status: string | null } | null = null;
  let mockServer: Server | null = null;
  let storageTmpDir: string | null = null;
  let storageStatePath: string | null = null;
  let accountExportStatus: string | null = null;
  let persistentRecovered = false;
  let importedRecovered = false;
  let downloadArtifact: Record<string, unknown> | null = null;
  let uploadArtifact: Record<string, unknown> | null = null;
  let uploadReadback: { name: string | null; size: number; text: string | null } | null = null;
  const accountRunId = `account-${Date.now()}`;

  try {
    await browserService.close().catch(() => undefined);
    await browserService.launch(makeLaunchOptions(provider, mode)).catch((error) => {
      throw new Error(formatAcceptanceError(error));
    });

    const navigateResult = await runTool(browserActionTool, {
      action: 'navigate',
      url: makeWorkflowUrl(),
    }, context);
    navigateTrace = getMetadata<WorkbenchActionTrace>(navigateResult, 'workbenchTrace');

    const beforeResult = await runTool(browserActionTool, {
      action: 'get_dom_snapshot',
    }, context);
    beforeSnapshot = getMetadata<BrowserDomSnapshot>(beforeResult, 'domSnapshot');
    const workflowButton = beforeSnapshot?.interactiveElements.find((element) =>
      element.selectorHint === '#phase3-workflow-button'
    );
    clickTargetRefId = workflowButton?.targetRef?.refId ?? null;

    const clickResult = await runTool(browserActionTool, {
      action: 'click',
      ...(workflowButton?.targetRef
        ? { targetRef: workflowButton.targetRef }
        : { selector: '#phase3-workflow-button' }),
    }, context);
    clickTrace = getMetadata<WorkbenchActionTrace>(clickResult, 'workbenchTrace');

    readback = await browserService.runScript(`(() => {
      return {
        clicked: document.body.dataset.phase3Clicked || null,
        count: window.__phase3ClickCount || 0,
        status: document.querySelector('#phase3-status')?.textContent || null,
      };
    })()`);

    const afterResult = await runTool(browserActionTool, {
      action: 'get_dom_snapshot',
    }, context);
    afterSnapshot = getMetadata<BrowserDomSnapshot>(afterResult, 'domSnapshot');

    const mock = await startMockLoginServer(accountRunId);
    mockServer = mock.server;
    storageTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-agent-browser-account-'));
    storageStatePath = path.join(storageTmpDir, 'storage-state.json');
    const uploadFilePath = path.join(storageTmpDir, 'phase4-upload.txt');
    fs.writeFileSync(uploadFilePath, `upload:${accountRunId}`);

    await runTool(browserActionTool, {
      action: 'navigate',
      url: mock.url,
    }, context);
    const loginSnapshotResult = await runTool(browserActionTool, {
      action: 'get_dom_snapshot',
    }, context);
    const loginSnapshot = getMetadata<BrowserDomSnapshot>(loginSnapshotResult, 'domSnapshot');
    const loginButton = loginSnapshot?.interactiveElements.find((element) =>
      element.selectorHint === '#mock-login-button'
    );
    await runTool(browserActionTool, {
      action: 'click',
      ...(loginButton?.targetRef
        ? { targetRef: loginButton.targetRef }
        : { selector: '#mock-login-button' }),
    }, context);
    const loggedInState = await browserService.runScript<{ cookie: string; localStorage: string | null; sessionStorage: string | null; status: string | null }>('readState()');
    const exportResult = await runTool(browserActionTool, {
      action: 'export_storage_state',
      storageStatePath,
    }, context);
    const exportedAccount = getMetadata<Record<string, unknown>>(exportResult, 'browserAccountState');
    accountExportStatus = typeof exportedAccount?.status === 'string' ? exportedAccount.status : null;

    await browserService.close();
    await browserService.launch(makeLaunchOptions(provider, mode)).catch((error) => {
      throw new Error(formatAcceptanceError(error));
    });
    await runTool(browserActionTool, {
      action: 'navigate',
      url: mock.url,
    }, context);
    const persistentState = await browserService.runScript<{ cookie: string; localStorage: string | null; sessionStorage: string | null; status: string | null }>('readState()');
    persistentRecovered = persistentState.cookie.includes(accountRunId) && persistentState.localStorage === accountRunId;

    await browserService.close();
    await browserService.launch({
      ...makeLaunchOptions(provider, mode),
      profileMode: 'isolated',
    }).catch((error) => {
      throw new Error(formatAcceptanceError(error));
    });
    await runTool(browserActionTool, {
      action: 'import_storage_state',
      storageStatePath,
    }, context);
    await runTool(browserActionTool, {
      action: 'navigate',
      url: mock.url,
    }, context);
    const importedState = await browserService.runScript<{ cookie: string; localStorage: string | null; sessionStorage: string | null; status: string | null }>('readState()');
    importedRecovered = importedState.cookie.includes(accountRunId) && importedState.localStorage === accountRunId;

    const downloadResult = await runTool(browserActionTool, {
      action: 'wait_for_download',
      selector: '#mock-download-link',
    }, context);
    downloadArtifact = getMetadata<Record<string, unknown>>(downloadResult, 'browserArtifact');

    const uploadResult = await runTool(browserActionTool, {
      action: 'upload_file',
      selector: '#mock-upload-input',
      uploadFilePath,
    }, context);
    uploadArtifact = getMetadata<Record<string, unknown>>(uploadResult, 'browserArtifact');
    uploadReadback = await browserService.runScript<{ name: string | null; size: number; text: string | null }>(`new Promise((resolve) => {
      const started = Date.now();
      const poll = () => {
        if (window.__uploadReadback || Date.now() - started > 3000) {
          resolve(window.__uploadReadback || { name: null, size: 0, text: null });
          return;
        }
        setTimeout(poll, 50);
      };
      poll();
    })`);

    const workbenchStateResult = await runTool(browserActionTool, {
      action: 'get_workbench_state',
    }, context);
    browserState = getMetadata<ManagedBrowserSessionState>(
      workbenchStateResult,
      'browserWorkbenchState',
    );

    const computerStateResult = await runTool(computerUseTool, {
      action: 'get_state',
    }, context);
    computerTrace = getMetadata<WorkbenchActionTrace>(computerStateResult, 'workbenchTrace');

    if (!browserState?.running) {
      failures.push('Managed browser session is not running.');
    }
    const browserStateProvider = (browserState as { provider?: string | null } | null)?.provider ?? null;
    const browserLeaseStatus = browserState?.lease?.status ?? null;
    const browserProxyMode = browserState?.proxy?.mode ?? null;
    const externalBridgeStatus = browserState?.externalBridge?.status ?? null;
    if (browserStateProvider && browserStateProvider !== provider) {
      failures.push(`Managed browser provider mismatch: expected ${provider}, got ${browserStateProvider}.`);
    }
    if (browserLeaseStatus !== 'active') {
      failures.push(`Managed browser lease was not active: ${browserLeaseStatus || 'missing'}.`);
    }
    if (browserProxyMode !== 'direct') {
      failures.push(`Managed browser proxy mode should default to direct: ${browserProxyMode || 'missing'}.`);
    }
    if (externalBridgeStatus !== 'unsupported') {
      failures.push(`External browser bridge should remain unsupported by default: ${externalBridgeStatus || 'missing'}.`);
    }
    if (!beforeSnapshot?.interactiveElements.some((element) => element.selectorHint === '#phase3-workflow-button')) {
      failures.push('Initial DOM snapshot did not include the workflow button.');
    }
    if (!clickTargetRefId) {
      failures.push('Initial DOM snapshot did not include a targetRef for the workflow button.');
    }
    if (readback?.clicked !== 'yes' || readback.count !== 1 || readback.status !== 'Clicked') {
      failures.push('Safe browser click did not update page state.');
    }
    if (!afterSnapshot?.interactiveElements.some((element) =>
      element.selectorHint === '#phase3-workflow-button' && element.text === 'Clicked'
    )) {
      failures.push('After-click DOM snapshot did not reflect the clicked button.');
    }
    if (clickTrace?.targetKind !== 'browser' || clickTrace.action !== 'click' || clickTrace.success !== true) {
      failures.push('Click trace did not capture a successful browser action.');
    }
    const clickedTargetRef = clickTrace?.params?.targetRef as { refId?: string; snapshotId?: string } | undefined;
    if (clickTargetRefId && clickedTargetRef?.refId !== clickTargetRefId) {
      failures.push('Click trace did not preserve the clicked targetRef.');
    }
    if (!clickTrace?.mode) {
      failures.push('Click trace did not include browser mode.');
    }
    if (computerTrace) {
      failures.push('computer_use.get_state should stay read-only and avoid creating an action trace.');
    }
    if (!loggedInState.cookie.includes(accountRunId) || loggedInState.localStorage !== accountRunId || loggedInState.status !== 'Logged In') {
      failures.push('Mock login fixture did not set cookie/localStorage state.');
    }
    if (accountExportStatus !== 'available') {
      failures.push(`Exported account state summary was not available: ${accountExportStatus || 'missing'}.`);
    }
    if (!persistentRecovered) {
      failures.push('Persistent profile did not recover mock login cookie/localStorage after browser relaunch.');
    }
    if (!importedRecovered) {
      failures.push('Imported storageState did not restore mock login cookie/localStorage in an isolated profile.');
    }
    if (downloadArtifact?.name !== 'phase4-report.txt' || downloadArtifact?.sha256 !== sha256(`download:${accountRunId}`)) {
      failures.push('Download artifact did not match expected name/hash.');
    }
    if (uploadArtifact?.name !== 'phase4-upload.txt' || uploadArtifact?.sha256 !== sha256(`upload:${accountRunId}`)) {
      failures.push('Upload artifact summary did not match expected name/hash.');
    }
    if (uploadReadback?.name !== 'phase4-upload.txt' || uploadReadback.text !== `upload:${accountRunId}`) {
      failures.push('Upload fixture did not read back the selected file name/content.');
    }

    const result = {
      ok: failures.length === 0,
      browser: {
        providerRequested: provider,
        provider: browserStateProvider || provider,
        running: browserState?.running ?? false,
        mode: browserState?.mode ?? null,
        activeTab: browserState?.activeTab ?? null,
        navigateTraceId: navigateTrace?.id ?? null,
        clickTraceId: clickTrace?.id ?? null,
        clickTraceAction: clickTrace?.action ?? null,
        clickTraceMode: clickTrace?.mode ?? null,
        clickTraceTargetRef: clickedTargetRef?.refId ?? null,
        leaseStatus: browserLeaseStatus,
        proxyMode: browserProxyMode,
        externalBridgeStatus,
        accountExportStatus,
        persistentRecovered,
        importedRecovered,
        downloadArtifactName: downloadArtifact?.name ?? null,
        downloadArtifactSha256: downloadArtifact?.sha256 ?? null,
        uploadArtifactName: uploadArtifact?.name ?? null,
        uploadReadback,
        readback,
      },
      dom: {
        beforeInteractiveCount: beforeSnapshot?.interactiveElements.length ?? 0,
        afterInteractiveCount: afterSnapshot?.interactiveElements.length ?? 0,
      },
      failures,
    };

    if (hasFlag(args, 'json')) {
      printJson(result);
    } else {
      printKeyValue('Browser / Computer Phase3 Workflow Smoke Summary', [
        ['browserProviderRequested', result.browser.providerRequested],
        ['browserProvider', result.browser.provider],
        ['browserRunning', result.browser.running],
        ['browserMode', result.browser.mode],
        ['activeUrl', result.browser.activeTab?.url?.slice(0, 80) ?? null],
        ['navigateTraceId', result.browser.navigateTraceId],
        ['clickTraceId', result.browser.clickTraceId],
        ['clickTraceAction', result.browser.clickTraceAction],
        ['clickTraceMode', result.browser.clickTraceMode],
        ['clickTraceTargetRef', String(result.browser.clickTraceTargetRef ?? '') || null],
        ['leaseStatus', result.browser.leaseStatus],
        ['proxyMode', result.browser.proxyMode],
        ['externalBridgeStatus', result.browser.externalBridgeStatus],
        ['accountExportStatus', result.browser.accountExportStatus],
        ['persistentAccountRecovered', result.browser.persistentRecovered],
        ['importedStorageStateRecovered', result.browser.importedRecovered],
        ['downloadArtifactName', result.browser.downloadArtifactName],
        ['uploadArtifactName', result.browser.uploadArtifactName],
        ['uploadReadback', uploadReadback ? `${uploadReadback.name}:${uploadReadback.size}` : null],
        ['clicked', readback?.clicked ?? null],
        ['clickCount', readback?.count ?? null],
        ['status', readback?.status ?? null],
      ]);

      if (failures.length > 0) {
        console.log('\nFailures');
        for (const failure of failures) {
          console.log(`- ${failure}`);
        }
      } else {
        console.log('\nWorkflow smoke passed.');
      }
    }

    if (failures.length > 0) {
      process.exit(1);
    }
  } finally {
    if (!hasFlag(args, 'keep-browser')) {
      await browserService.close().catch(() => undefined);
    }
    await closeServer(mockServer).catch(() => undefined);
    if (storageTmpDir) {
      fs.rmSync(storageTmpDir, { recursive: true, force: true });
    }
  }
}

function getProvider(args: ReturnType<typeof parseArgs>): string {
  const value = args.options.provider;
  if (value === undefined || value === true) {
    return SYSTEM_CHROME_CDP_PROVIDER;
  }
  return Array.isArray(value) ? value[value.length - 1] : value;
}

function makeLaunchOptions(provider: string, mode: 'headless' | 'visible'): Record<string, unknown> {
  if (provider === SYSTEM_CHROME_CDP_PROVIDER) {
    return makeSystemChromeProviderOptions(mode);
  }
  return { mode, provider };
}

main().catch((error) => finishWithError(formatAcceptanceError(error)));
