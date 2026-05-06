// Schema-only file (P0-7 方案 A — single source of truth)
// Pure type-only — does not pull legacy tool code at import time.
import type { ToolSchema } from '../../../protocol/tools';

export const browserNavigateSchema: ToolSchema = {
  name: 'browser_navigate',
  description: `Control browser navigation and basic interactions.

Use this tool to:
- Open URLs in default browser
- Navigate browser history (back/forward)
- Refresh the current page
- Open new tabs
- Close browser tabs

For more complex browser interactions (clicking, typing in forms),
use the computer_use tool with screenshot for visual guidance.

Parameters:
- action: The browser action to perform
- url: URL to open (for 'open' and 'navigate' actions)
- browser: Specific browser to use (optional, default: system default)`,
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['open', 'navigate', 'back', 'forward', 'refresh', 'close', 'newTab', 'switchTab'],
        description: 'The browser action to perform',
      },
      url: {
        type: 'string',
        description: 'URL to open or navigate to',
      },
      browser: {
        type: 'string',
        enum: ['default', 'chrome', 'firefox', 'safari', 'edge'],
        description: 'Which browser to use (default: system default)',
      },
      tabIndex: {
        type: 'number',
        description: 'Tab index to switch to (for switchTab action)',
      },
    },
    required: ['action'],
  },
  category: 'vision',
  permissionLevel: 'execute',
  readOnly: false,
  allowInPlanMode: false,
};
