// Schema-only file (P0-7 方案 A — single source of truth)
// Pure type-only — does not pull legacy tool code at import time.
import type { ToolSchema } from '../../../protocol/tools';

export const browserActionSchema: ToolSchema = {
  name: 'browser_action',
  description: `Control a browser for web automation and testing (tabs, click/type, screenshots, DOM/a11y snapshots, forms, uploads/downloads, account state).

Routing: prefer web_fetch/search for plain reads; use browser_action for login/session, multi-page, or visual work. After mutations, refresh DOM/a11y evidence before claiming final state.
engine (ADR-041): optional auto|managed|relay (default auto). Explicit managed/relay never silent-switches. managed=Neo isolated browser; relay=user-attached Chrome tab.
Profile login reuse: list_profiles; import_profile_cookies requires userConfirmed=true (Browser Surface); clear_cookies clears managed profile cookies. Never log cookie values.
storageState file path: export_storage_state / import_storage_state for CI/scripts.`,
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
        description: 'Browser profile source for list_profiles/import_profile_cookies (chrome, edge, brave, arc, …)',
      },
      profileId: {
        type: 'string',
        description: 'Browser profile id for import_profile_cookies (e.g. Default, Profile 1)',
      },
      domainAllowlist: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional domain allowlist for import_profile_cookies',
      },
      userConfirmed: {
        type: 'boolean',
        description: 'Required true for import_profile_cookies — only set after explicit user approval (ADR-041)',
      },
    },
    required: ['action'],
  },
  category: 'vision',
  permissionLevel: 'execute',
  readOnly: false,
  allowInPlanMode: false,
};
