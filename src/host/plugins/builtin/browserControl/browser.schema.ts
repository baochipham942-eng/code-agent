// Schema-only file (P0-7 方案 A — single source of truth)
// Pure type-only — does not pull legacy tool code at import time.
import type { ToolSchema } from '../../../protocol/tools';

export const browserSchema: ToolSchema = {
  name: 'Browser',
  description: `Unified browser control tool combining navigation and automation.

Use action="navigate" to delegate to the browser_action navigate, or use the simple OS-level
browser opener actions. For full Playwright-based browser automation, use the browser_action actions.

Routing contract:
- Prefer lighter web_fetch/http/search/read tools for plain single-URL reading, article summaries, static page extraction, or URL lists.
- Use Browser/browser_action when the task needs login/session state, form filling, clicking, upload/download, multi-page navigation, dynamic page state, screenshots, or visual verification.
- Start with get_content/get_dom_snapshot/get_a11y_snapshot when possible; after a mutating browser action, refresh the DOM/a11y evidence before claiming the final page state.

## Simple OS-level browser control (browser_navigate):
- open: Open a URL in the system browser
- nav_back / nav_forward: Navigate browser history via OS-level scripting
- refresh: Refresh current page via OS-level scripting
- close_window: Close the browser window
- newTab / switchTab: Tab management via OS-level scripting

## Full Playwright-based browser automation (browser_action):
- launch / close: Start or stop the isolated managed browser (headless by default)
- new_tab / close_tab / list_tabs / switch_tab: Tab management
- navigate / back / forward / reload / set_viewport: Navigation and viewport controls
- click / click_text / type / press_key / scroll / hover / drag: Page interactions
- get_dialog_state / handle_dialog: Default-pause JavaScript dialog policy
- read_clipboard / write_clipboard: Explicitly approved, redaction-safe browser clipboard policy
- wait_for_download / upload_file: Managed download artifacts and explicitly approved exact-file uploads; Relay upload also requires a fresh targetRef
- screenshot: Capture page screenshot (with optional AI analysis)
- get_content / get_elements / get_dom_snapshot / get_a11y_snapshot / get_workbench_state: Read page content and workbench state
- wait: Wait for elements or timeout
- fill_form: Fill multiple form fields
- get_logs: Get recent browser operation logs

## Parameters:
- action: The browser action to perform (see above)
- url: URL for open/navigate actions
- browser: Which browser to use for OS-level actions (default, chrome, firefox, safari, edge)
- tabIndex: Tab index for switchTab (OS-level)
- selector: CSS selector for element interactions (Playwright)
- text: Text to type or element text to click (Playwright)
- key: Key to press (Playwright)
- direction: Scroll direction up/down (Playwright)
- amount: Scroll amount in pixels (Playwright)
- tabId: Target tab ID (Playwright)
- timeout: Wait timeout in ms (Playwright)
- fullPage: Full page screenshot flag (Playwright)
- formData: Form fields as {selector: value} pairs (Playwright)
- analyze: Enable AI analysis for screenshot (Playwright)
- prompt: Custom prompt for AI analysis (Playwright)`,
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: [
          // OS-level browser_navigate actions (remapped to avoid conflicts)
          'open', 'nav_back', 'nav_forward', 'refresh', 'close_window', 'newTab', 'switchTab',
          // Playwright browser_action actions
          'launch', 'close', 'new_tab', 'close_tab', 'list_tabs', 'switch_tab',
          'navigate', 'back', 'forward', 'reload', 'set_viewport',
          'click', 'click_text', 'type', 'press_key', 'scroll', 'hover', 'drag',
          'get_dialog_state', 'handle_dialog', 'read_clipboard', 'write_clipboard',
          'screenshot', 'get_content', 'get_elements', 'get_dom_snapshot', 'get_a11y_snapshot',
          'get_workbench_state', 'wait_for_download', 'upload_file', 'wait', 'fill_form', 'get_logs',
        ],
        description: 'The browser action to perform',
      },
      // --- browser_navigate params ---
      url: {
        type: 'string',
        description: 'URL to open or navigate to',
      },
      browser: {
        type: 'string',
        enum: ['default', 'chrome', 'firefox', 'safari', 'edge'],
        description: '[OS-level] Which browser to use (default: system default)',
      },
      tabIndex: {
        type: 'number',
        description: '[OS-level] Tab index for switchTab action',
      },
      // --- browser_action params ---
      selector: {
        type: 'string',
        description: '[Playwright] CSS selector for element interactions',
      },
      targetRef: {
        type: 'object',
        description: '[Playwright] Fresh target reference returned by get_dom_snapshot',
        additionalProperties: true,
      },
      destinationTargetRef: {
        type: 'object',
        description: '[Playwright] Fresh destination target reference for drag',
        additionalProperties: true,
      },
      text: {
        type: 'string',
        description: '[Playwright] Text to type or element text to click',
      },
      clipboardText: {
        type: 'string',
        description: '[Playwright] Sensitive text for explicitly approved write_clipboard',
      },
      dialogAction: {
        type: 'string',
        enum: ['accept', 'dismiss'],
        description: '[Playwright] Explicit action for a paused JavaScript dialog',
      },
      dialogPromptText: {
        type: 'string',
        description: '[Playwright] Sensitive response for an accepted prompt dialog',
      },
      uploadFilePath: {
        type: 'string',
        description: '[Playwright] Local file path for upload_file. Every upload requires one-time exact-file approval; Relay also requires a fresh targetRef.',
      },
      engine: {
        type: 'string',
        enum: ['auto', 'managed', 'relay'],
        description: '[Playwright] Browser engine. Explicit managed/relay never silently switches engines.',
      },
      relayDomainScopes: {
        type: 'array',
        items: { type: 'string' },
        description: '[Relay] Exact origins or hostnames approved for the time-bounded tab lease.',
      },
      relayActionScopes: {
        type: 'array',
        items: { type: 'string' },
        description: '[Relay] Explicit approved Browser actions; wildcards are rejected.',
      },
      relayLeaseTtlMs: {
        type: 'number',
        description: '[Relay] Requested lease lifetime in milliseconds, capped at 30 minutes.',
      },
      key: {
        type: 'string',
        description: '[Playwright] Key to press (Enter, Tab, Escape, ArrowDown, etc.)',
      },
      direction: {
        type: 'string',
        enum: ['up', 'down'],
        description: '[Playwright] Scroll direction',
      },
      amount: {
        type: 'number',
        description: '[Playwright] Scroll amount in pixels (default: 300)',
      },
      tabId: {
        type: 'string',
        description: '[Playwright] Target tab ID (optional, uses active tab)',
      },
      timeout: {
        type: 'number',
        description: '[Playwright] Wait timeout in milliseconds (default: 5000)',
      },
      width: {
        type: 'number',
        description: '[Playwright] Viewport width for set_viewport',
      },
      height: {
        type: 'number',
        description: '[Playwright] Viewport height for set_viewport',
      },
      fullPage: {
        type: 'boolean',
        description: '[Playwright] Capture full page screenshot (default: false)',
      },
      formData: {
        type: 'object',
        description: '[Playwright] Form fields as {selector: value} pairs',
      },
      analyze: {
        type: 'boolean',
        description: '[Playwright] Enable AI analysis for screenshot action (default: false)',
      },
      prompt: {
        type: 'string',
        description: '[Playwright] Custom prompt for AI analysis',
      },
    },
    required: ['action'],
  },
  category: 'vision',
  permissionLevel: 'execute',
  readOnly: false,
  allowInPlanMode: false,
};
