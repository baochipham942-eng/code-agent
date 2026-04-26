import {
  finishWithError,
  hasFlag,
  parseArgs,
  printJson,
  printKeyValue,
} from './_helpers.ts';
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
  let readback: { clicked: string | null; count: number; status: string | null } | null = null;

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

    const clickResult = await runTool(browserActionTool, {
      action: 'click',
      selector: '#phase3-workflow-button',
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
    if (browserStateProvider && browserStateProvider !== provider) {
      failures.push(`Managed browser provider mismatch: expected ${provider}, got ${browserStateProvider}.`);
    }
    if (!beforeSnapshot?.interactiveElements.some((element) => element.selectorHint === '#phase3-workflow-button')) {
      failures.push('Initial DOM snapshot did not include the workflow button.');
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
    if (clickTrace?.params?.selector !== '#phase3-workflow-button') {
      failures.push('Click trace did not preserve the clicked selector.');
    }
    if (!clickTrace?.mode) {
      failures.push('Click trace did not include browser mode.');
    }
    if (computerTrace) {
      failures.push('computer_use.get_state should stay read-only and avoid creating an action trace.');
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
        clickTraceSelector: clickTrace?.params?.selector ?? null,
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
        ['clickTraceSelector', String(result.browser.clickTraceSelector ?? '') || null],
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
