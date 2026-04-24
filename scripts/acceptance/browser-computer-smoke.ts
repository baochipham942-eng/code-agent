import {
  finishWithError,
  hasFlag,
  parseArgs,
  printJson,
  printKeyValue,
} from './_helpers.ts';
import { browserService } from '../../src/main/services/infra/browserService.ts';
import { browserActionTool } from '../../src/main/tools/vision/browserAction.ts';
import { computerUseTool } from '../../src/main/tools/vision/computerUse.ts';
import type { Tool, ToolContext, ToolExecutionResult } from '../../src/main/tools/types.ts';
import type {
  BrowserDomSnapshot,
} from '../../src/main/services/infra/browserService.ts';
import type {
  ComputerSurfaceSnapshot,
  ComputerSurfaceState,
  ManagedBrowserSessionState,
} from '../../src/shared/contract/desktop.ts';

function usage(): void {
  console.log(`Browser / Computer workbench smoke

Usage:
  npm run acceptance:browser-computer -- [options]

Options:
  --visible        Launch managed browser in visible mode.
  --keep-browser   Keep the managed browser open after the smoke.
  --json           Print JSON only.
  --help           Show this help.

What it validates:
  - managed browser can launch headless by default
  - browser_action can navigate to an isolated data URL
  - DOM snapshot includes the smoke page interactive element
  - browser workbench state exposes a running session
  - computer_use can read Computer Surface state and frontmost snapshot without approval`);
}

function makeSmokeUrl(): string {
  const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>Phase2 Browser Computer Smoke</title>
  </head>
  <body>
    <main>
      <h1>Phase2 Smoke</h1>
      <button id="phase2-smoke-button">Ready</button>
    </main>
  </body>
</html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function makeToolContext(): ToolContext {
  return {
    workingDirectory: process.cwd(),
    sessionId: 'browser-computer-smoke',
    requestPermission: async () => true,
    executionIntent: {
      browserSessionMode: 'managed',
      preferBrowserSession: true,
      allowBrowserAutomation: true,
      browserSessionSnapshot: {
        ready: true,
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

  const context = makeToolContext();
  const failures: string[] = [];
  let navigateResult: ToolExecutionResult | null = null;
  let domSnapshot: BrowserDomSnapshot | null = null;
  let browserState: ManagedBrowserSessionState | null = null;
  let computerSurface: ComputerSurfaceState | null = null;
  let computerSurfaceSnapshot: ComputerSurfaceSnapshot | null = null;

  try {
    await browserService.close().catch(() => undefined);

    navigateResult = await runTool(browserActionTool, {
      action: 'navigate',
      url: makeSmokeUrl(),
    }, context);

    const domResult = await runTool(browserActionTool, {
      action: 'get_dom_snapshot',
    }, context);
    domSnapshot = getMetadata<BrowserDomSnapshot>(domResult, 'domSnapshot');

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
    computerSurface = getMetadata<ComputerSurfaceState>(
      computerStateResult,
      'computerSurface',
    );

    const observeResult = await runTool(computerUseTool, {
      action: 'observe',
      includeScreenshot: false,
    }, context);
    computerSurfaceSnapshot = getMetadata<ComputerSurfaceSnapshot>(
      observeResult,
      'computerSurfaceSnapshot',
    );

    if (!browserState?.running) {
      failures.push('Managed browser session is not running.');
    }
    if (!browserState?.activeTab?.url?.startsWith('data:text/html')) {
      failures.push('Managed browser did not stay on the isolated smoke page.');
    }
    if (!domSnapshot?.headings.some((heading) => heading.text === 'Phase2 Smoke')) {
      failures.push('DOM snapshot did not include the smoke heading.');
    }
    if (!domSnapshot?.interactiveElements.some((element) => element.selectorHint === '#phase2-smoke-button')) {
      failures.push('DOM snapshot did not include the smoke button.');
    }
    if (!computerSurface) {
      failures.push('Computer Surface state was not returned.');
    }
    if (!computerSurfaceSnapshot) {
      failures.push('Computer Surface observe snapshot was not returned.');
    }

    const result = {
      ok: failures.length === 0,
      browser: {
        running: browserState?.running ?? false,
        mode: browserState?.mode ?? null,
        activeTab: browserState?.activeTab ?? null,
        traceId: navigateResult.metadata?.traceId ?? null,
        domHeadingCount: domSnapshot?.headings.length ?? 0,
        domInteractiveCount: domSnapshot?.interactiveElements.length ?? 0,
      },
      computerSurface,
      computerSurfaceSnapshot,
      failures,
    };

    if (hasFlag(args, 'json')) {
      printJson(result);
    } else {
      printKeyValue('Browser / Computer Workbench Smoke Summary', [
        ['browserRunning', result.browser.running],
        ['browserMode', result.browser.mode],
        ['activeUrl', result.browser.activeTab?.url?.slice(0, 80) ?? null],
        ['traceId', result.browser.traceId as string | null],
        ['domHeadings', result.browser.domHeadingCount],
        ['domInteractiveElements', result.browser.domInteractiveCount],
        ['computerSurfaceReady', computerSurface?.ready ?? null],
        ['computerSurfaceMode', computerSurface?.mode ?? null],
        ['frontmostApp', computerSurfaceSnapshot?.appName ?? null],
        ['frontmostWindow', computerSurfaceSnapshot?.windowTitle ?? null],
      ]);

      if (failures.length > 0) {
        console.log('\nFailures');
        for (const failure of failures) {
          console.log(`- ${failure}`);
        }
      } else {
        console.log('\nSmoke passed.');
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

main().catch(finishWithError);
