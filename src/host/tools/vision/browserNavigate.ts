// ============================================================================
// Browser Navigate Tool - legacy compatibility boundary
// ============================================================================

import type { SurfaceExecutionErrorV1 } from '../../../shared/contract/surfaceExecution';
import type { Tool, ToolContext, ToolExecutionResult } from '../types';

type BrowserAction =
  | 'open'
  | 'navigate'
  | 'back'
  | 'forward'
  | 'refresh'
  | 'close'
  | 'newTab'
  | 'switchTab';

export const LEGACY_BROWSER_NAVIGATE_ERROR_CODE = 'SURFACE_POLICY_BLOCKED' as const;

function buildLegacyBrowserNavigateBlockedResult(
  context: ToolContext,
  action: BrowserAction | undefined,
): ToolExecutionResult {
  const surfaceError: SurfaceExecutionErrorV1 = {
    version: 1,
    code: LEGACY_BROWSER_NAVIGATE_ERROR_CODE,
    message: 'browser_navigate cannot directly control user browser tabs without a Surface owner.',
    phase: 'prepare',
    retryable: false,
    userActionRequired: true,
    recommendedAction: 'Use browser_action with Managed Browser, or explicitly authorize a scoped Relay tab lease.',
    surface: 'browser',
    provider: 'legacy-os-browser',
    sessionId: context.sessionId || 'unowned',
    detailsSafe: action ? { action } : undefined,
  };

  return {
    success: false,
    error: `${surfaceError.code}: ${surfaceError.message} ${surfaceError.recommendedAction}`,
    metadata: {
      surfaceExecutionErrorV1: surfaceError,
    },
  };
}

export const browserNavigateTool: Tool = {
  // Keep the public tool name and schema readable for old messages, replay, and
  // session export. Execution fails closed because this legacy path has no
  // durable Run/Agent owner, target revision, grant, or cleanup boundary.
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
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    const action = typeof params.action === 'string'
      ? params.action as BrowserAction
      : undefined;
    return buildLegacyBrowserNavigateBlockedResult(context, action);
  },
};
