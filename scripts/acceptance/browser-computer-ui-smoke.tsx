import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import net from 'net';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { chromium, type Browser } from 'playwright';
import {
  finishWithError,
  hasFlag,
  parseArgs,
  printJson,
  printKeyValue,
} from './_helpers.ts';
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

function makeGroupedTraceNode(): TraceNode {
  return {
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
  };
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
      React.createElement('section', { 'data-check': 'grouped-step' },
        React.createElement(ToolStepGroup, {
          nodes: [makeGroupedTraceNode()],
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

function getChromeExecutable(): string {
  if (process.env.CHROME_PATH) {
    return process.env.CHROME_PATH;
  }

  if (process.platform === 'darwin') {
    return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  }

  return 'google-chrome';
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : null;
      server.close(() => {
        if (port) {
          resolve(port);
        } else {
          reject(new Error('Failed to allocate Chrome debug port'));
        }
      });
    });
  });
}

async function connectToChrome(port: number, timeoutMs = 10_000): Promise<Browser> {
  const start = Date.now();
  let lastError: unknown;

  while (Date.now() - start < timeoutMs) {
    try {
      return await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Failed to connect to Chrome over CDP');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (hasFlag(args, 'help')) {
    usage();
    return;
  }

  const port = await getFreePort();
  const profileDir = mkdtempSync(join(tmpdir(), 'code-agent-browser-computer-ui-'));
  const chrome = spawn(getChromeExecutable(), [
    '--headless=new',
    '--disable-gpu',
    '--disable-background-networking',
    '--disable-sync',
    '--disable-extensions',
    '--disable-component-update',
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=${profileDir}`,
    '--remote-debugging-address=127.0.0.1',
    `--remote-debugging-port=${port}`,
    'about:blank',
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let browser: Browser | null = null;
  const failures: string[] = [];

  try {
    browser = await connectToChrome(port);
    const context = browser.contexts()[0] || await browser.newContext();
    const page = context.pages()[0] || await context.newPage();
    const smokeUrl = `data:text/html;charset=utf-8,${encodeURIComponent(buildSmokeMarkup())}`;

    await page.goto(smokeUrl, { waitUntil: 'domcontentloaded' });
    const text = await page.locator('[data-smoke-root]').innerText();
    const html = await page.content();

    const expectedLength = `${SECRET.length} chars`;
    const checks: Array<[string, boolean]> = [
      ['root rendered', text.includes('Phase4 Browser Computer UI Smoke')],
      ['action preview rendered', text.includes('Action') && text.includes('输入')],
      ['target rendered', text.includes(SELECTOR)],
      ['trace rendered', text.includes('trace-phase4-browser-type')],
      ['grouped trace rendered', text.includes('trace-phase4-grouped-type')],
      ['typed length rendered', text.includes(expectedLength)],
      ['arguments redacted', text.includes(`[redacted ${SECRET.length} chars]`)],
      ['secret absent from visible text', !text.includes(SECRET)],
      ['secret absent from html', !html.includes(SECRET)],
    ];

    for (const [label, ok] of checks) {
      if (!ok) failures.push(label);
    }

    const result = {
      ok: failures.length === 0,
      chrome: {
        executable: getChromeExecutable(),
        cdpPort: port,
      },
      ui: {
        textLength: text.length,
        containsTrace: text.includes('trace-phase4-browser-type'),
        containsGroupedTrace: text.includes('trace-phase4-grouped-type'),
        containsRedaction: text.includes(`[redacted ${SECRET.length} chars]`),
        containsSecretInText: text.includes(SECRET),
        containsSecretInHtml: html.includes(SECRET),
      },
      failures,
    };

    if (hasFlag(args, 'json')) {
      printJson(result);
    } else {
      printKeyValue('Browser / Computer Phase4 UI Smoke Summary', [
        ['chromeExecutable', result.chrome.executable],
        ['cdpPort', result.chrome.cdpPort],
        ['textLength', result.ui.textLength],
        ['containsTrace', result.ui.containsTrace],
        ['containsGroupedTrace', result.ui.containsGroupedTrace],
        ['containsRedaction', result.ui.containsRedaction],
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
    if (browser && !hasFlag(args, 'keep-browser')) {
      await browser.close().catch(() => undefined);
    }
    if (!hasFlag(args, 'keep-browser')) {
      stopChrome(chrome);
      rmSync(profileDir, { recursive: true, force: true });
    }
  }
}

function stopChrome(chrome: ChildProcessWithoutNullStreams): void {
  if (chrome.killed) return;
  chrome.kill('SIGTERM');
}

main().catch(finishWithError);
