// Schema-only file (P0-7 方案 A — single source of truth)
// Pure type-only — does not pull legacy tool code at import time.
import type { ToolSchema } from '../../../protocol/tools';

export const browserActionSchema: ToolSchema = {
  name: 'browser_action',
  description: `Control a browser for web automation and testing.

Use this tool to:
- Launch/close browser
- Navigate to URLs and interact with web pages
- Click elements, type text, fill forms
- Take screenshots for visual verification
- Read page content and find elements

Routing contract:
- Prefer lighter web_fetch/http/search/read tools for plain single-URL reading, article summaries, static page extraction, or URL lists.
- Use browser_action when the task needs login/session state, form filling, clicking, upload/download, multi-page navigation, dynamic page state, screenshots, or visual verification.
- Start with get_content/get_dom_snapshot/get_a11y_snapshot when possible; after a mutating browser action, refresh the DOM/a11y evidence before claiming the final page state.
- engine (ADR-041): optional 'auto' | 'managed' | 'relay'. Default auto. managed = Neo isolated browser; relay = user-attached Chrome tab via extension. Explicit engine never silently switches.

Actions:
- launch: Start isolated managed browser (headless by default; set CODE_AGENT_BROWSER_VISIBLE=1 for visible debugging)
- close: Close browser
- new_tab: Open new tab (url optional)
- close_tab: Close a tab
- list_tabs: List all open tabs
- switch_tab: Switch to a specific tab
- navigate: Go to URL
- back/forward/reload: Navigation controls
- set_viewport: Switch the managed browser viewport
- click: Click element by selector
- click_text: Click element by text content
- type: Type text into element
- press_key: Press keyboard key (Enter, Tab, Escape, etc.)
- scroll: Scroll page (up/down)
- screenshot: Capture page screenshot (with optional AI analysis)
- get_content: Get page text and links
- get_elements: Find elements by selector
- get_dom_snapshot: Get structured headings and interactive elements
- get_a11y_snapshot: Get accessibility snapshot when available, with DOM fallback
- get_workbench_state: Return managed browser session/workbench state
- get_account_state: Return cookie/storage summary without values
- export_storage_state: Save Playwright storageState to a local artifact file
- import_storage_state: Import cookies and storage seed from a local storageState file
- list_profiles: List importable local Chromium browser profiles (macOS; no cookie values)
- import_profile_cookies: Import cookies from a local browser profile (requires userConfirmed=true)
- clear_cookies: Clear cookies in the managed browser profile
- wait_for_download: Click an element and save the completed download as an artifact
- upload_file: Set a file input or file chooser target to a user-approved file
- wait: Wait for element or timeout
- fill_form: Fill multiple form fields
- get_logs: Get recent browser operation logs (for debugging)

All operations return detailed logs for transparency.

Examples:
- {"action": "launch"}
- {"action": "new_tab", "url": "https://example.com"}
- {"action": "click", "selector": "button.submit"}
- {"action": "click_text", "text": "Sign In"}
- {"action": "type", "selector": "#search", "text": "hello"}
- {"action": "screenshot"}
- {"action": "screenshot", "analyze": true, "prompt": "描述页面内容"}
- {"action": "get_content"}`,
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: [
          'launch', 'close', 'new_tab', 'close_tab', 'list_tabs', 'switch_tab',
          'navigate', 'back', 'forward', 'reload', 'set_viewport',
          'click', 'click_text', 'type', 'press_key', 'scroll',
          'screenshot', 'get_content', 'get_elements', 'get_dom_snapshot', 'get_a11y_snapshot',
          'get_workbench_state', 'get_account_state', 'export_storage_state', 'import_storage_state',
          'list_profiles', 'import_profile_cookies', 'clear_cookies',
          'wait_for_download', 'upload_file', 'wait', 'fill_form', 'get_logs'
        ],
        description: 'The browser action to perform',
      },
      url: {
        type: 'string',
        description: 'URL for navigate/new_tab actions',
      },
      selector: {
        type: 'string',
        description: 'CSS selector for element interactions. Prefer targetRef from get_dom_snapshot when available.',
      },
      targetRef: {
        type: 'object',
        description: 'Short-lived target reference returned by get_dom_snapshot interactiveElements[].targetRef',
        additionalProperties: true,
      },
      text: {
        type: 'string',
        description: 'Text to type or element text to click',
      },
      key: {
        type: 'string',
        description: 'Key to press (Enter, Tab, Escape, ArrowDown, etc.)',
      },
      direction: {
        type: 'string',
        enum: ['up', 'down'],
        description: 'Scroll direction',
      },
      amount: {
        type: 'number',
        description: 'Scroll amount in pixels (default: 300)',
      },
      tabId: {
        type: 'string',
        description: 'Target tab ID (optional, uses active tab)',
      },
      timeout: {
        type: 'number',
        description: 'Wait timeout in milliseconds (default: 5000)',
      },
      width: {
        type: 'number',
        description: 'Viewport width for set_viewport',
      },
      height: {
        type: 'number',
        description: 'Viewport height for set_viewport',
      },
      fullPage: {
        type: 'boolean',
        description: 'Capture full page screenshot (default: false)',
      },
      formData: {
        type: 'object',
        description: 'Form fields as {selector: value} pairs',
      },
      analyze: {
        type: 'boolean',
        description: 'Enable AI analysis for screenshot action (default: false)',
      },
      prompt: {
        type: 'string',
        description: 'Custom prompt for AI analysis',
      },
      storageStatePath: {
        type: 'string',
        description: 'Local path for import_storage_state/export_storage_state. Export creates an artifact path when omitted.',
      },
      uploadFilePath: {
        type: 'string',
        description: 'Local file path for upload_file. Sensitive paths require permission.',
      },
      secretRef: {
        type: 'string',
        description: 'Reference to a secret value for type actions, e.g. env:CODE_AGENT_BROWSER_SECRET_PASSWORD. The secret value is never returned in output.',
      },
      engine: {
        type: 'string',
        enum: ['auto', 'managed', 'relay'],
        description:
          'ADR-041 browser engine. auto (default) routes by isolation/login intent; managed uses Neo isolated browser; relay drives an attached real Chrome tab. Explicit managed/relay never silently switches engines.',
      },
      source: {
        type: 'string',
        description: 'Browser profile source for import_profile_cookies (chrome, edge, brave, arc, …)',
      },
      profileId: {
        type: 'string',
        description: 'Browser profile id for import_profile_cookies (e.g. Default)',
      },
      domainAllowlist: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional domain allowlist for import_profile_cookies',
      },
      userConfirmed: {
        type: 'boolean',
        description: 'Required true for import_profile_cookies after explicit user approval',
      },
    },
    required: ['action'],
  },
  category: 'vision',
  permissionLevel: 'execute',
  readOnly: false,
  allowInPlanMode: false,
};
