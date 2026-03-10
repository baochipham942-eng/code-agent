// ============================================================================
// Browser Tool - Unified browser navigation and automation
// ============================================================================
// Merges browser_navigate and browser_action into a single tool
// with an `action` parameter dispatching to the original implementations.
// ============================================================================

import type { Tool, ToolContext, ToolExecutionResult } from '../types';
import { browserNavigateTool } from './browserNavigate';
import { browserActionTool } from './browserAction';

// Actions from browserActionTool (kept as-is since they don't conflict)
const BROWSER_ACTION_ACTIONS = [
  'launch', 'close', 'new_tab', 'close_tab', 'list_tabs', 'switch_tab',
  'navigate', 'back', 'forward', 'reload',
  'click', 'click_text', 'type', 'press_key', 'scroll',
  'screenshot', 'get_content', 'get_elements', 'wait', 'fill_form', 'get_logs',
] as const;

export const BrowserTool: Tool = {
  name: 'Browser',
  description: `Unified browser control tool combining navigation and automation.

Use action="navigate" to delegate to the browser_action navigate, or use the simple OS-level
browser opener actions. For full Playwright-based browser automation, use the browser_action actions.

## Simple OS-level browser control (browser_navigate):
- open: Open a URL in the system browser
- nav_back / nav_forward: Navigate browser history via OS-level scripting
- refresh: Refresh current page via OS-level scripting
- close_window: Close the browser window
- newTab / switchTab: Tab management via OS-level scripting

## Full Playwright-based browser automation (browser_action):
- launch / close: Start or stop the Playwright browser
- new_tab / close_tab / list_tabs / switch_tab: Tab management
- navigate / back / forward / reload: Navigation controls
- click / click_text / type / press_key / scroll: Page interactions
- screenshot: Capture page screenshot (with optional AI analysis)
- get_content / get_elements: Read page content
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
  requiresPermission: true,
  permissionLevel: 'execute', // highest among sub-tools: execute > write
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
          'navigate', 'back', 'forward', 'reload',
          'click', 'click_text', 'type', 'press_key', 'scroll',
          'screenshot', 'get_content', 'get_elements', 'wait', 'fill_form', 'get_logs',
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
      text: {
        type: 'string',
        description: '[Playwright] Text to type or element text to click',
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

  async execute(
    params: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolExecutionResult> {
    const action = params.action as string;

    // --- OS-level browser_navigate actions ---
    // Remap unified action names back to browser_navigate's original action names
    const navigateActionMap: Record<string, string> = {
      open: 'open',
      nav_back: 'back',
      nav_forward: 'forward',
      refresh: 'refresh',
      close_window: 'close',
      newTab: 'newTab',
      switchTab: 'switchTab',
    };

    if (action in navigateActionMap) {
      const remappedParams = {
        ...params,
        action: navigateActionMap[action],
      };
      return browserNavigateTool.execute(remappedParams, context);
    }

    // --- Playwright browser_action actions ---
    if ((BROWSER_ACTION_ACTIONS as readonly string[]).includes(action)) {
      return browserActionTool.execute(params, context);
    }

    return {
      success: false,
      error: `Unknown action: ${action}. Valid actions: ${[...Object.keys(navigateActionMap), ...BROWSER_ACTION_ACTIONS].join(', ')}`,
    };
  },
};
