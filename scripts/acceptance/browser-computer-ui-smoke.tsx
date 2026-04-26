import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  finishWithError,
  hasFlag,
  parseArgs,
  printJson,
  printKeyValue,
} from './_helpers.ts';
import {
  closeSystemChromeSession,
  formatAcceptanceError,
  launchSystemChromeSession,
} from './browser-computer-system-chrome.ts';
import type { ToolCall } from '../../src/shared/contract/index.ts';
import type { TraceNode } from '../../src/shared/contract/trace.ts';
import { ToolCallDisplay } from '../../src/renderer/components/features/chat/MessageBubble/ToolCallDisplay/index.tsx';
import { ToolStepGroup } from '../../src/renderer/components/features/chat/ToolStepGroup.tsx';

const SECRET = 'phase4-secret@example.com';
const SELECTOR = '#phase4-email';

function usage(): void {
  console.log(`Browser / Computer phase4 UI smoke

Usage:
  npm run acceptance:browser-computer-ui -- [options]

Options:
  --keep-browser   Keep the Chrome process open after the smoke.
  --json           Print JSON only.
  --help           Show this help.

What it validates:
  - real ToolCallDisplay markup renders in a system Chrome headless browser
  - browser_action action preview shows action, target, risk, mode, and trace
  - typed text is redacted from collapsed summaries and expanded error details
  - grouped tool steps preserve trace metadata in rendered markup`);
}

function makeToolCall(overrides: Partial<ToolCall>): ToolCall {
  return {
    id: 'tool-1',
    name: 'browser_action',
    arguments: {},
    result: {
      toolCallId: 'tool-1',
      success: true,
      output: 'ok',
    },
    ...overrides,
  };
}

function makeGroupedTraceNodes(): TraceNode[] {
  return [
    {
      id: 'node-phase4-browser-type',
      type: 'tool_call',
      content: '',
      timestamp: Date.now(),
      toolCall: {
        id: 'tool-grouped-phase4',
        name: 'browser_action',
        args: {
          action: 'type',
          selector: SELECTOR,
          text: SECRET,
        },
        result: `Typed "${SECRET}" into ${SELECTOR}`,
        success: true,
        metadata: {
          traceId: 'trace-phase4-grouped-type',
          workbenchTrace: {
            id: 'trace-phase4-grouped-type',
            mode: 'headless',
          },
        },
      },
    },
    {
      id: 'node-phase4-browser-fill-form',
      type: 'tool_call',
      content: '',
      timestamp: Date.now(),
      toolCall: {
        id: 'tool-grouped-phase4-fill-form',
        name: 'browser_action',
        args: {
          action: 'fill_form',
          text: SECRET,
          formData: {
            [SELECTOR]: SECRET,
          },
        },
        result: `Filled form with ${SECRET}`,
        success: true,
        metadata: {
          traceId: 'trace-phase4-grouped-fill-form',
          workbenchTrace: {
            id: 'trace-phase4-grouped-fill-form',
            mode: 'headless',
          },
        },
      },
    },
  ];
}

function buildSmokeMarkup(): string {
  const successCall = makeToolCall({
    id: 'tool-phase4-browser-type',
    name: 'browser_action',
    arguments: {
      action: 'type',
      selector: SELECTOR,
      text: SECRET,
    },
    result: {
      toolCallId: 'tool-phase4-browser-type',
      success: true,
      output: `Typed "${SECRET}" into ${SELECTOR}`,
      metadata: {
        traceId: 'trace-phase4-browser-type',
        workbenchTrace: {
          id: 'trace-phase4-browser-type',
          mode: 'headless',
        },
      },
    },
  });

  const errorCall = makeToolCall({
    id: 'tool-phase4-browser-type-error',
    name: 'browser_action',
    arguments: {
      action: 'type',
      selector: SELECTOR,
      text: SECRET,
    },
    result: {
      toolCallId: 'tool-phase4-browser-type-error',
      success: false,
      error: `Type failed after ${SECRET}`,
      metadata: {
        traceId: 'trace-phase4-browser-type-error',
        workbenchTrace: {
          id: 'trace-phase4-browser-type-error',
          mode: 'headless',
        },
      },
    },
  });

  const managedMissingCall = makeToolCall({
    id: 'tool-phase4-browser-missing',
    name: 'browser_action',
    arguments: {
      action: 'click',
      selector: '#phase4-submit',
    },
    result: {
      toolCallId: 'tool-phase4-browser-missing',
      success: false,
      error: 'Browser not running',
      metadata: {
        traceId: 'trace-phase4-browser-missing',
        workbenchTrace: {
          id: 'trace-phase4-browser-missing',
          mode: 'headless',
        },
      },
    },
  });

  const browserNoSelectorCall = makeToolCall({
    id: 'tool-phase4-browser-no-selector',
    name: 'browser_action',
    arguments: {
      action: 'type',
      text: SECRET,
    },
    result: {
      toolCallId: 'tool-phase4-browser-no-selector',
      success: false,
      error: `Type failed after ${SECRET}`,
    },
  });

  const computerNoSelectorCall = makeToolCall({
    id: 'tool-phase4-computer-no-selector',
    name: 'computer_use',
    arguments: {
      action: 'smart_type',
      text: SECRET,
    },
    result: {
      toolCallId: 'tool-phase4-computer-no-selector',
      success: false,
      error: `No element found after trying ${SECRET}`,
      metadata: {
        computerSurfaceMode: 'foreground_fallback',
      },
    },
  });

  const desktopBlockedCall = makeToolCall({
    id: 'tool-phase4-computer-blocked',
    name: 'computer_use',
    arguments: {
      action: 'type',
      targetApp: 'Google Chrome',
      text: SECRET,
    },
    result: {
      toolCallId: 'tool-phase4-computer-blocked',
      success: false,
      error: `Computer Surface blocked while typing ${SECRET}`,
      metadata: {
        code: 'COMPUTER_SURFACE_BLOCKED',
        targetApp: 'Google Chrome',
        computerSurfaceMode: 'foreground_fallback',
      },
    },
  });

  const body = renderToStaticMarkup(
    React.createElement('main', { 'data-smoke-root': true },
      React.createElement('h1', null, 'Phase4 Browser Computer UI Smoke'),
      React.createElement('section', { 'data-check': 'success-preview' },
        React.createElement(ToolCallDisplay, {
          toolCall: successCall,
          index: 0,
          total: 1,
        }),
      ),
      React.createElement('section', { 'data-check': 'error-details' },
        React.createElement(ToolCallDisplay, {
          toolCall: errorCall,
          index: 1,
          total: 2,
        }),
      ),
      React.createElement('section', { 'data-check': 'managed-missing-next-step' },
        React.createElement(ToolCallDisplay, {
          toolCall: managedMissingCall,
          index: 2,
          total: 4,
        }),
      ),
      React.createElement('section', { 'data-check': 'desktop-blocked-next-step' },
        React.createElement(ToolCallDisplay, {
          toolCall: desktopBlockedCall,
          index: 3,
          total: 6,
        }),
      ),
      React.createElement('section', { 'data-check': 'browser-no-selector-redaction' },
        React.createElement(ToolCallDisplay, {
          toolCall: browserNoSelectorCall,
          index: 4,
          total: 6,
        }),
      ),
      React.createElement('section', { 'data-check': 'computer-no-selector-redaction' },
        React.createElement(ToolCallDisplay, {
          toolCall: computerNoSelectorCall,
          index: 5,
          total: 6,
        }),
      ),
      React.createElement('section', { 'data-check': 'grouped-step' },
        React.createElement(ToolStepGroup, {
          nodes: makeGroupedTraceNodes(),
          defaultExpanded: true,
        }),
      ),
    ),
  );

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>Phase4 Browser Computer UI Smoke</title>
  </head>
  <body>${body}</body>
</html>`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (hasFlag(args, 'help')) {
    usage();
    return;
  }

  const session = await launchSystemChromeSession({
    profilePrefix: 'code-agent-browser-computer-ui-',
  });
  const failures: string[] = [];

  try {
    const context = session.browser.contexts()[0] || await session.browser.newContext();
    const page = context.pages()[0] || await context.newPage();
    const smokeUrl = `data:text/html;charset=utf-8,${encodeURIComponent(buildSmokeMarkup())}`;

    await page.goto(smokeUrl, { waitUntil: 'domcontentloaded' });
    const text = await page.locator('[data-smoke-root]').innerText();
    const html = await page.content();

    const expectedLength = `${SECRET.length} chars`;
    const checks: Array<[string, boolean]> = [
      ['root rendered', text.includes('Phase4 Browser Computer UI Smoke')],
      ['action preview rendered', text.includes('动作') && text.includes('输入')],
      ['target rendered', text.includes(SELECTOR)],
      ['trace rendered', text.includes('trace-phase4-browser-type')],
      ['grouped trace rendered', text.includes('trace-phase4-grouped-type')],
      ['grouped fill_form trace rendered', text.includes('trace-phase4-grouped-fill-form')],
      ['typed length rendered', text.includes(expectedLength)],
      ['arguments redacted', text.includes(`[redacted ${SECRET.length} chars]`)],
      ['managed recovery action rendered', text.includes('可执行') && text.includes('启动隔离浏览器')],
      ['desktop next-step action rendered', text.includes('打开 Desktop status')],
      ['desktop next-step action is non-executing', text.includes('不会执行点击或输入')],
      ['no-selector browser input redacted', text.includes(`输入 ${expectedLength}`)],
      ['no-selector computer input redacted', text.includes(`智能输入 ${expectedLength}`)],
      ['secret absent from visible text', !text.includes(SECRET)],
      ['secret absent from html', !html.includes(SECRET)],
    ];

    for (const [label, ok] of checks) {
      if (!ok) failures.push(label);
    }

    const result = {
      ok: failures.length === 0,
      chrome: {
        provider: session.provider,
        executable: session.executable,
        cdpPort: session.port,
      },
      ui: {
        textLength: text.length,
        containsTrace: text.includes('trace-phase4-browser-type'),
        containsGroupedTrace: text.includes('trace-phase4-grouped-type'),
        containsGroupedFillFormTrace: text.includes('trace-phase4-grouped-fill-form'),
        containsRedaction: text.includes(`[redacted ${SECRET.length} chars]`),
        containsManagedManualPath: text.includes('能力菜单 -> Browser -> Managed'),
        containsDesktopNextStepAction: text.includes('打开 Desktop status'),
        containsNoSelectorBrowserRedaction: text.includes(`输入 ${SECRET.length} chars`),
        containsNoSelectorComputerRedaction: text.includes(`智能输入 ${SECRET.length} chars`),
        containsSecretInText: text.includes(SECRET),
        containsSecretInHtml: html.includes(SECRET),
      },
      failures,
    };

    if (hasFlag(args, 'json')) {
      printJson(result);
    } else {
      printKeyValue('Browser / Computer Phase4 UI Smoke Summary', [
        ['provider', result.chrome.provider],
        ['chromeExecutable', result.chrome.executable],
        ['cdpPort', result.chrome.cdpPort],
        ['textLength', result.ui.textLength],
        ['containsTrace', result.ui.containsTrace],
        ['containsGroupedTrace', result.ui.containsGroupedTrace],
        ['containsGroupedFillFormTrace', result.ui.containsGroupedFillFormTrace],
        ['containsRedaction', result.ui.containsRedaction],
        ['containsManagedManualPath', result.ui.containsManagedManualPath],
        ['containsDesktopNextStepAction', result.ui.containsDesktopNextStepAction],
        ['containsNoSelectorBrowserRedaction', result.ui.containsNoSelectorBrowserRedaction],
        ['containsNoSelectorComputerRedaction', result.ui.containsNoSelectorComputerRedaction],
        ['containsSecretInText', result.ui.containsSecretInText],
        ['containsSecretInHtml', result.ui.containsSecretInHtml],
      ]);

      if (failures.length > 0) {
        console.log('\nFailures');
        for (const failure of failures) {
          console.log(`- ${failure}`);
        }
      } else {
        console.log('\nUI smoke passed.');
      }
    }

    if (failures.length > 0) {
      process.exit(1);
    }
  } finally {
    if (!hasFlag(args, 'keep-browser')) {
      await session.browser.close().catch(() => undefined);
      await closeSystemChromeSession(session).catch(() => undefined);
    }
  }
}

main().catch((error) => finishWithError(formatAcceptanceError(error)));
