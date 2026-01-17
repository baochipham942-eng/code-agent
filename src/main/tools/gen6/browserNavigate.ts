// ============================================================================
// Browser Navigate Tool - Control browser navigation and interaction
// Gen 6: Computer Use capability
// ============================================================================

import type { Tool, ToolContext, ToolExecutionResult } from '../ToolRegistry';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

type BrowserAction = 'open' | 'navigate' | 'back' | 'forward' | 'refresh' | 'close' | 'newTab' | 'switchTab';

export const browserNavigateTool: Tool = {
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
  generations: ['gen6'],
  requiresPermission: true,
  permissionLevel: 'write',
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

  async execute(
    params: Record<string, unknown>,
    _context: ToolContext
  ): Promise<ToolExecutionResult> {
    const action = params.action as BrowserAction;
    const url = params.url as string | undefined;
    const browser = (params.browser as string) || 'default';
    const tabIndex = params.tabIndex as number | undefined;

    try {
      if (process.platform === 'darwin') {
        return await executeMacOSBrowserAction(action, url, browser, tabIndex);
      } else if (process.platform === 'linux') {
        return await executeLinuxBrowserAction(action, url, browser);
      } else if (process.platform === 'win32') {
        return await executeWindowsBrowserAction(action, url, browser);
      } else {
        return {
          success: false,
          error: `Unsupported platform: ${process.platform}`,
        };
      }
    } catch (error) {
      return {
        success: false,
        error: `Browser action failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
    }
  },
};

async function executeMacOSBrowserAction(
  action: BrowserAction,
  url?: string,
  browser?: string,
  tabIndex?: number
): Promise<ToolExecutionResult> {
  const browserApp = getBrowserAppName(browser || 'default', 'darwin');

  switch (action) {
    case 'open':
    case 'navigate':
      if (!url) {
        return { success: false, error: 'URL required for open/navigate action' };
      }

      // Validate URL
      if (!isValidUrl(url)) {
        return { success: false, error: `Invalid URL: ${url}` };
      }

      if (browser === 'default') {
        await execAsync(`open "${url}"`);
      } else {
        await execAsync(`open -a "${browserApp}" "${url}"`);
      }
      return {
        success: true,
        output: `Opened ${url} in ${browserApp}`,
      };

    case 'back':
      await execAsync(`osascript -e 'tell application "${browserApp}" to tell active tab of front window to go back'`);
      return { success: true, output: `Navigated back in ${browserApp}` };

    case 'forward':
      await execAsync(`osascript -e 'tell application "${browserApp}" to tell active tab of front window to go forward'`);
      return { success: true, output: `Navigated forward in ${browserApp}` };

    case 'refresh':
      await execAsync(`osascript -e 'tell application "${browserApp}" to tell active tab of front window to reload'`);
      return { success: true, output: `Refreshed page in ${browserApp}` };

    case 'close':
      await execAsync(`osascript -e 'tell application "${browserApp}" to close front window'`);
      return { success: true, output: `Closed window in ${browserApp}` };

    case 'newTab':
      if (browserApp === 'Google Chrome') {
        await execAsync(`osascript -e 'tell application "Google Chrome" to make new tab at end of tabs of front window'`);
      } else if (browserApp === 'Safari') {
        await execAsync(`osascript -e 'tell application "Safari" to make new tab at end of tabs of front window'`);
      } else {
        // Generic approach using keyboard shortcut
        await execAsync(`osascript -e 'tell application "System Events" to keystroke "t" using command down'`);
      }
      return { success: true, output: `Opened new tab in ${browserApp}` };

    case 'switchTab':
      if (tabIndex === undefined) {
        return { success: false, error: 'tabIndex required for switchTab action' };
      }
      if (browserApp === 'Google Chrome') {
        await execAsync(`osascript -e 'tell application "Google Chrome" to set active tab index of front window to ${tabIndex + 1}'`);
      } else if (browserApp === 'Safari') {
        await execAsync(`osascript -e 'tell application "Safari" to set current tab of front window to tab ${tabIndex + 1} of front window'`);
      }
      return { success: true, output: `Switched to tab ${tabIndex} in ${browserApp}` };

    default:
      return { success: false, error: `Unknown action: ${action}` };
  }
}

async function executeLinuxBrowserAction(
  action: BrowserAction,
  url?: string,
  browser?: string,
  tabIndex?: number
): Promise<ToolExecutionResult> {
  const browserCmd = getBrowserAppName(browser || 'default', 'linux');

  switch (action) {
    case 'open':
    case 'navigate':
      if (!url) {
        return { success: false, error: 'URL required for open/navigate action' };
      }
      if (!isValidUrl(url)) {
        return { success: false, error: `Invalid URL: ${url}` };
      }

      if (browser === 'default') {
        await execAsync(`xdg-open "${url}"`);
      } else {
        await execAsync(`${browserCmd} "${url}"`);
      }
      return { success: true, output: `Opened ${url}` };

    case 'back':
      await execAsync(`xdotool key alt+Left`);
      return { success: true, output: 'Navigated back' };

    case 'forward':
      await execAsync(`xdotool key alt+Right`);
      return { success: true, output: 'Navigated forward' };

    case 'refresh':
      await execAsync(`xdotool key F5`);
      return { success: true, output: 'Refreshed page' };

    case 'close':
      await execAsync(`xdotool key ctrl+w`);
      return { success: true, output: 'Closed tab' };

    case 'newTab':
      await execAsync(`xdotool key ctrl+t`);
      return { success: true, output: 'Opened new tab' };

    case 'switchTab':
      if (tabIndex === undefined) {
        return { success: false, error: 'tabIndex required for switchTab action' };
      }
      if (tabIndex < 9) {
        await execAsync(`xdotool key ctrl+${tabIndex + 1}`);
      }
      return { success: true, output: `Switched to tab ${tabIndex}` };

    default:
      return { success: false, error: `Unknown action: ${action}` };
  }
}

async function executeWindowsBrowserAction(
  action: BrowserAction,
  url?: string,
  browser?: string
): Promise<ToolExecutionResult> {
  switch (action) {
    case 'open':
    case 'navigate':
      if (!url) {
        return { success: false, error: 'URL required for open/navigate action' };
      }
      if (!isValidUrl(url)) {
        return { success: false, error: `Invalid URL: ${url}` };
      }

      await execAsync(`start "" "${url}"`);
      return { success: true, output: `Opened ${url}` };

    default:
      return {
        success: false,
        error: 'Windows browser control requires more implementation. Basic URL opening works.',
      };
  }
}

function getBrowserAppName(browser: string, platform: string): string {
  if (platform === 'darwin') {
    switch (browser) {
      case 'chrome': return 'Google Chrome';
      case 'firefox': return 'Firefox';
      case 'safari': return 'Safari';
      case 'edge': return 'Microsoft Edge';
      default: return 'Safari'; // macOS default
    }
  } else if (platform === 'linux') {
    switch (browser) {
      case 'chrome': return 'google-chrome';
      case 'firefox': return 'firefox';
      case 'edge': return 'microsoft-edge';
      default: return 'xdg-open';
    }
  }
  return browser;
}

function isValidUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return ['http:', 'https:', 'file:'].includes(parsed.protocol);
  } catch {
    return false;
  }
}
