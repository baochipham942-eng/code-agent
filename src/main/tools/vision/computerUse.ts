// ============================================================================
// Computer Use Tool - Mouse and keyboard automation with smart element location
// Gen 6: Computer Use capability enhanced with Playwright integration
// ============================================================================

import type { Tool, ToolContext, ToolExecutionResult } from '../types';
import type {
  ComputerSurfaceAxQuality,
  ComputerSurfaceFailureKind,
  ComputerSurfaceState,
  WorkbenchActionTrace,
} from '../../../shared/contract/desktop';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { isComputerUseEnabled } from '../../services/cloud/featureFlagService';
import { getComputerSurface } from '../../services/desktop/computerSurface';
import { browserService } from '../../services/infra/browserService.js';
import {
  appendBrowserWorkbenchNote,
  buildBrowserWorkbenchBlockedResult,
  ensureManagedBrowserSessionForWorkbench,
  evaluateBrowserWorkbenchPolicy,
} from './browserWorkbenchIntent';

const execFileAsync = promisify(execFile);

// Extended action types with smart location capabilities
type ActionType =
  | 'get_state' | 'observe' | 'get_ax_elements' | 'get_windows' | 'diagnose_app'
  | 'click' | 'doubleClick' | 'rightClick' | 'move' | 'type' | 'key' | 'scroll' | 'drag'
  // Smart location actions (Playwright-powered)
  | 'locate_element' | 'locate_text' | 'locate_role'
  | 'smart_click' | 'smart_type' | 'smart_hover'
  | 'get_elements';

interface ComputerAction {
  action: ActionType;
  targetApp?: string;
  x?: number;
  y?: number;
  pid?: number;
  windowId?: number;
  windowRef?: string;
  bundleId?: string;
  title?: string;
  windowLocalPoint?: { x: number; y: number };
  windowX?: number;
  windowY?: number;
  button?: 'left' | 'right';
  clickCount?: number;
  text?: string;
  key?: string;
  modifiers?: string[];
  direction?: 'up' | 'down' | 'left' | 'right';
  amount?: number;
  toX?: number;
  toY?: number;
  // Smart location parameters
  selector?: string;
  role?: string;
  name?: string;
  axPath?: string;
  exact?: boolean;
  timeout?: number;
  includeScreenshot?: boolean;
  limit?: number;
  maxDepth?: number;
}

export const computerUseTool: Tool = {
  name: 'computer_use',
  description: `Control the computer with mouse, keyboard, and smart element location.

## Basic Actions (coordinate-based):
- get_state: Return Computer Surface readiness, mode, approvals, and last action
- observe: Return frontmost app/window snapshot before choosing an action
- get_ax_elements: List accessible elements for a target app/window through macOS Accessibility
- get_windows: List scored visible macOS window candidates with pid/windowId/windowRef/bounds for background CGEvent debugging
- diagnose_app: Diagnose target app process/window/TCC/AX/CGEvent readiness in one call
- click/doubleClick/rightClick: Click at x,y coordinates
- move: Move mouse to x,y
- type: Type text into focused element
- key: Press keyboard key with optional modifiers
- scroll: Scroll in direction (up/down/left/right)
- drag: Drag from x,y to toX,toY

## Smart Actions (Playwright-powered, for browser):
- locate_element: Find element by CSS selector, return coordinates
- locate_text: Find element by text content, return coordinates
- locate_role: Find element by ARIA role and name
- smart_click: Click element by selector or text (no coordinates needed)
- smart_type: Type into element by selector (no coordinates needed)
- smart_hover: Hover over element by selector
- get_elements: List interactive elements on page

## Parameters:
- action: The action to perform
- x, y: Screen coordinates (for basic mouse actions)
- targetApp: Expected app for desktop actions. With axPath or role/name/selector on macOS, Computer Surface can use background Accessibility instead of the foreground cursor.
- pid/windowId/windowRef/windowLocalPoint: macOS background CGEvent target from get_windows, for closed-source app debugging without foreground activation
- bundleId/title: Optional expected target identity from get_windows; checked before background CGEvent clicks
- selector: CSS selector (for smart actions)
- text: Text to type or text to find
- role: ARIA role (button, link, textbox, etc.)
- name: Accessible name for role-based location
- axPath: Background Accessibility path returned by get_ax_elements, for stable target app element addressing
- key: Key to press (enter, tab, escape, etc.)
- modifiers: Modifier keys ['cmd', 'ctrl', 'alt', 'shift']
- exact: Exact text match (default: false)
- timeout: Wait timeout in ms (default: 5000)
- includeScreenshot: Include a screenshot path for observe (default: false)
- limit: Maximum elements for get_ax_elements (default: 40)
- maxDepth: Maximum Accessibility tree depth for get_ax_elements (default: 4)

## Examples:
- {"action": "get_state"} - check Computer Surface readiness
- {"action": "observe", "includeScreenshot": true} - inspect the frontmost app/window
- {"action": "get_ax_elements", "targetApp": "Finder"} - list accessible buttons/fields for a target app
- {"action": "get_windows", "targetApp": "Preview"} - list target windows for background CGEvent click debugging
- {"action": "diagnose_app", "targetApp": "Preview"} - diagnose target app windows, permissions, AX, and CGEvent suitability
- {"action": "click", "targetApp": "Finder", "axPath": "1.2.3"} - press an element returned by get_ax_elements
- {"action": "click", "targetApp": "Preview", "pid": 123, "windowId": 456, "windowLocalPoint": {"x": 50, "y": 80}} - send a background CGEvent click to a chosen window
- {"action": "click", "targetApp": "Finder", "role": "button", "name": "Back"} - press an accessible element through the background macOS surface
- {"action": "smart_click", "selector": "button.submit"}
- {"action": "smart_click", "text": "Sign In"}
- {"action": "locate_role", "role": "button", "name": "Submit"}
- {"action": "smart_type", "selector": "#email", "text": "user@example.com"}
- {"action": "get_elements"} - list all interactive elements

IMPORTANT: For smart actions, browser must be launched via browser_action first.`,
  requiresPermission: true,
  permissionLevel: 'execute',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: [
          'get_state', 'observe',
          'get_ax_elements',
          'diagnose_app',
          'get_windows',
          'click', 'doubleClick', 'rightClick', 'move', 'type', 'key', 'scroll', 'drag',
          'locate_element', 'locate_text', 'locate_role',
          'smart_click', 'smart_type', 'smart_hover', 'get_elements'
        ],
        description: 'The action to perform',
      },
      x: {
        type: 'number',
        description: 'X coordinate on screen (for basic mouse actions)',
      },
      targetApp: {
        type: 'string',
        description: 'Expected target app for desktop actions. If omitted, the frontmost app is used. With axPath or role/name/selector on macOS, background Accessibility can target the app without requiring it to be frontmost.',
      },
      y: {
        type: 'number',
        description: 'Y coordinate on screen (for basic mouse actions)',
      },
      pid: {
        type: 'number',
        description: 'macOS process id returned by get_windows for background CGEvent actions',
      },
      windowId: {
        type: 'number',
        description: 'macOS CGWindowID returned by get_windows for background CGEvent actions',
      },
      windowRef: {
        type: 'string',
        description: 'Stable macOS window reference returned by get_windows; includes pid/windowId plus title/bounds identity hash',
      },
      bundleId: {
        type: 'string',
        description: 'Expected macOS bundle identifier for target app/window filtering and stale-window checks',
      },
      title: {
        type: 'string',
        description: 'Expected target window title for get_windows filtering and stale-window checks',
      },
      windowLocalPoint: {
        type: 'object',
        properties: {
          x: { type: 'number' },
          y: { type: 'number' },
        },
        description: 'Point inside the target window for background CGEvent actions',
      },
      windowX: {
        type: 'number',
        description: 'X coordinate inside the target window for background CGEvent actions',
      },
      windowY: {
        type: 'number',
        description: 'Y coordinate inside the target window for background CGEvent actions',
      },
      button: {
        type: 'string',
        enum: ['left', 'right'],
        description: 'Mouse button for background CGEvent actions',
      },
      clickCount: {
        type: 'number',
        description: 'Click count for background CGEvent actions',
      },
      selector: {
        type: 'string',
        description: 'CSS selector for smart element location',
      },
      text: {
        type: 'string',
        description: 'Text to type or text content to locate',
      },
      role: {
        type: 'string',
        enum: ['button', 'link', 'textbox', 'checkbox', 'radio', 'combobox', 'listbox', 'menu', 'menuitem', 'tab', 'dialog', 'alert'],
        description: 'ARIA role for element location',
      },
      name: {
        type: 'string',
        description: 'Accessible name for role-based location',
      },
      axPath: {
        type: 'string',
        description: 'Background Accessibility path returned by get_ax_elements for target app element addressing',
      },
      key: {
        type: 'string',
        description: 'Key to press (enter, tab, escape, space, backspace, delete, up, down, left, right, etc.)',
      },
      modifiers: {
        type: 'array',
        items: { type: 'string', enum: ['cmd', 'ctrl', 'alt', 'shift'] },
        description: 'Modifier keys to hold during action',
      },
      direction: {
        type: 'string',
        enum: ['up', 'down', 'left', 'right'],
        description: 'Scroll direction',
      },
      amount: {
        type: 'number',
        description: 'Amount to scroll (in pixels)',
      },
      toX: {
        type: 'number',
        description: 'Destination X coordinate (for drag action)',
      },
      toY: {
        type: 'number',
        description: 'Destination Y coordinate (for drag action)',
      },
      exact: {
        type: 'boolean',
        description: 'Require exact text match (default: false)',
      },
      timeout: {
        type: 'number',
        description: 'Wait timeout in milliseconds (default: 5000)',
      },
      includeScreenshot: {
        type: 'boolean',
        description: 'Include screenshot path for observe action (default: false)',
      },
      limit: {
        type: 'number',
        description: 'Maximum elements to return for get_ax_elements (default: 40, max: 80)',
      },
      maxDepth: {
        type: 'number',
        description: 'Maximum Accessibility tree depth for get_ax_elements (default: 4, max: 8)',
      },
    },
    required: ['action'],
  },

  async execute(
    params: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolExecutionResult> {
    // Feature Flag: 检查 Computer Use 是否启用
    if (!isComputerUseEnabled()) {
      return {
        success: false,
        error: 'Computer Use is disabled. This feature is controlled by cloud configuration.',
      };
    }

    const action = params as unknown as ComputerAction;
    const workbenchPolicy = evaluateBrowserWorkbenchPolicy({
      toolName: 'computer_use',
      action: action.action,
      executionIntent: context.executionIntent,
    });
    if (workbenchPolicy.decision === 'block') {
      return buildBrowserWorkbenchBlockedResult(workbenchPolicy, {
        toolName: 'computer_use',
        action: action.action,
      });
    }

    const workbenchNotes: Array<string | null | undefined> = [workbenchPolicy.note];
    if (workbenchPolicy.preferManagedBrowser && isSmartAction(action.action)) {
      workbenchNotes.push(await ensureManagedBrowserSessionForWorkbench({
        executionIntent: context.executionIntent,
      }));
    }

    const computerSurface = getComputerSurface();
    if (isSurfaceReadAction(action.action)) {
      const result = await executeSurfaceReadAction(computerSurface, action);
      return appendBrowserWorkbenchNote(result, workbenchNotes);
    }

    const earlySurfaceBlock = buildComputerSurfacePreflightBlockedResult(action, computerSurface);
    if (earlySurfaceBlock) {
      return appendBrowserWorkbenchNote(earlySurfaceBlock, workbenchNotes);
    }

    const surfaceAuth = isSmartAction(action.action)
      ? null
      : await computerSurface.authorizeAction(action, context);
    if (surfaceAuth && !surfaceAuth.allowed) {
      const completedTrace = await computerSurface.recordAction(surfaceAuth.trace, {
        success: false,
        error: surfaceAuth.reason || 'Computer Surface authorization failed',
        failureKind: surfaceAuth.failureKind || surfaceAuth.trace.failureKind || surfaceAuth.state.failureKind || null,
        blockingReasons: surfaceAuth.blockingReasons || surfaceAuth.trace.blockingReasons || surfaceAuth.state.blockingReasons,
        recommendedAction: surfaceAuth.recommendedAction || surfaceAuth.trace.recommendedAction || surfaceAuth.state.recommendedAction || null,
      });
      const failureKind = surfaceAuth.failureKind || completedTrace.failureKind || surfaceAuth.state.failureKind || null;
      const blockingReasons = surfaceAuth.blockingReasons || completedTrace.blockingReasons || surfaceAuth.state.blockingReasons;
      const recommendedAction = surfaceAuth.recommendedAction || completedTrace.recommendedAction || surfaceAuth.state.recommendedAction || null;
      return appendBrowserWorkbenchNote({
        success: false,
        error: surfaceAuth.reason || 'Computer Surface authorization failed',
        metadata: {
          code: 'COMPUTER_SURFACE_BLOCKED',
          workbenchBlocked: true,
          computerSurface: surfaceAuth.state,
          computerSurfaceMode: surfaceAuth.state.mode,
          backgroundSurface: isBackgroundComputerSurfaceMode(surfaceAuth.state.mode),
          foregroundFallback: surfaceAuth.state.mode === 'foreground_fallback',
          background: surfaceAuth.state.background,
          requiresForeground: surfaceAuth.state.requiresForeground,
          approvalScope: surfaceAuth.state.approvalScope,
          safetyNote: surfaceAuth.state.safetyNote,
          targetApp: surfaceAuth.state.targetApp || null,
          sensitiveAction: surfaceAuth.sensitive,
          traceId: completedTrace.id,
          workbenchTrace: completedTrace,
          failureKind,
          blockingReasons,
          recommendedAction,
          evidenceSummary: completedTrace.evidenceSummary || surfaceAuth.state.evidenceSummary,
        },
      }, workbenchNotes);
    }

    try {
      let result: ToolExecutionResult;

      // Smart actions use Playwright (browser must be running)
      if (isSmartAction(action.action)) {
        result = await executeSmartAction(action);
      } else if (surfaceAuth?.state.mode === 'background_ax') {
        result = await computerSurface.executeBackgroundAction(action);
      } else if (surfaceAuth?.state.mode === 'background_cgevent') {
        result = await computerSurface.executeBackgroundCgEventAction(action);
      } else if (process.platform === 'darwin') {
        result = await executeMacOSAction(action);
      } else if (process.platform === 'linux') {
        result = await executeLinuxAction(action);
      } else if (process.platform === 'win32') {
        result = await executeWindowsAction(action);
      } else {
        result = {
          success: false,
          error: `Unsupported platform: ${process.platform}`,
        };
      }

      if (surfaceAuth) {
        const failureKind = result.success
          ? null
          : classifyComputerSurfaceActionFailure(result.error || '', surfaceAuth.state.mode);
        const completedTrace = await computerSurface.recordAction(surfaceAuth.trace, {
          success: result.success,
          error: result.error || null,
          failureKind,
          blockingReasons: result.success ? undefined : result.error ? [result.error] : undefined,
          recommendedAction: result.success
            ? null
            : surfaceAuth.state.mode === 'background_ax'
              ? 'Refresh AX elements and retry with a current axPath or role/name locator.'
              : surfaceAuth.state.mode === 'background_cgevent'
                ? 'Run get_windows again and retry with the current pid, windowId, and window-local point.'
                : 'Observe the foreground window and retry with a verified target.',
          evidenceSummary: getEvidenceSummaryFromMetadata(result.metadata),
        });
        result = withComputerSurfaceMetadata(result, {
          state: computerSurface.getState({
            targetApp: surfaceAuth.state.targetApp || undefined,
            blockedReason: result.success ? null : result.error || null,
            mode: surfaceAuth.state.mode,
            failureKind,
            blockingReasons: result.success ? undefined : result.error ? [result.error] : undefined,
            evidenceSummary: getEvidenceSummaryFromMetadata(result.metadata),
          }),
          trace: completedTrace,
          sensitive: surfaceAuth.sensitive,
        });
      }

      return appendBrowserWorkbenchNote(result, workbenchNotes);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const result: ToolExecutionResult = {
        success: false,
        error: `Action failed: ${errorMessage}`,
      };
      if (surfaceAuth) {
        const completedTrace = await computerSurface.recordAction(surfaceAuth.trace, {
          success: false,
          error: errorMessage,
          failureKind: 'action_execution_failed',
          blockingReasons: [errorMessage],
          recommendedAction: 'Inspect the before/after evidence and retry with a verified target.',
        });
        return appendBrowserWorkbenchNote(withComputerSurfaceMetadata(result, {
          state: computerSurface.getState({
            targetApp: surfaceAuth.state.targetApp || undefined,
            blockedReason: errorMessage,
            mode: surfaceAuth.state.mode,
          }),
          trace: completedTrace,
          sensitive: surfaceAuth.sensitive,
        }), workbenchNotes);
      }
      return appendBrowserWorkbenchNote(result, workbenchNotes);
    }
  },
};

function withComputerSurfaceMetadata(
  result: ToolExecutionResult,
  args: {
    state: ComputerSurfaceState;
    trace: WorkbenchActionTrace;
    sensitive: boolean;
  },
): ToolExecutionResult {
  return {
    ...result,
    metadata: {
      ...(result.metadata || {}),
      computerSurface: args.state,
      computerSurfaceMode: args.state.mode,
      backgroundSurface: isBackgroundComputerSurfaceMode(args.state.mode),
      foregroundFallback: args.state.mode === 'foreground_fallback',
      background: args.state.background,
      requiresForeground: args.state.requiresForeground,
      approvalScope: args.state.approvalScope,
      safetyNote: args.state.safetyNote,
      targetApp: args.state.targetApp || null,
      sensitiveAction: args.sensitive,
      traceId: args.trace.id,
      workbenchTrace: args.trace,
      failureKind: args.trace.failureKind || args.state.failureKind || (!result.success ? 'action_execution_failed' : null),
      blockingReasons: args.trace.blockingReasons || args.state.blockingReasons || (!result.success && result.error ? [result.error] : undefined),
      recommendedAction: args.trace.recommendedAction || args.state.recommendedAction || null,
      evidenceSummary: args.trace.evidenceSummary || args.state.evidenceSummary || result.metadata?.evidenceSummary,
      axQuality: args.trace.axQuality || args.state.axQuality || null,
    },
  };
}

function isBackgroundComputerSurfaceMode(mode: ComputerSurfaceState['mode']): boolean {
  return mode === 'background_ax' || mode === 'background_cgevent';
}

function buildComputerSurfacePreflightBlockedResult(
  action: ComputerAction,
  computerSurface: ReturnType<typeof getComputerSurface>,
): ToolExecutionResult | null {
  if (!shouldBlockMissingDesktopLocator(action)) {
    return null;
  }

  const blockingReasons = [
    'Background Accessibility action needs axPath, selector, or role plus name for a stable target locator.',
  ];
  const recommendedAction = 'Run computer_use.get_ax_elements for the target app and retry with the returned axPath.';
  const trace: WorkbenchActionTrace = {
    id: `computer_trace_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    targetKind: 'computer',
    toolName: 'computer_use',
    action: action.action,
    mode: 'background_ax',
    startedAtMs: Date.now(),
    params: redactComputerActionParams(action),
    success: false,
    error: blockingReasons[0],
    failureKind: 'locator_missing',
    blockingReasons,
    recommendedAction,
  };
  const state = computerSurface.getState({
    targetApp: action.targetApp || undefined,
    blockedReason: blockingReasons[0],
    approvalScope: 'blocked',
    mode: 'background_ax',
    failureKind: 'locator_missing',
    blockingReasons,
    recommendedAction,
  });

  return {
    success: false,
    error: blockingReasons[0],
    metadata: {
      code: 'COMPUTER_SURFACE_BLOCKED',
      workbenchBlocked: true,
      computerSurface: state,
      computerSurfaceMode: state.mode,
      backgroundSurface: true,
      foregroundFallback: false,
      background: state.background,
      requiresForeground: state.requiresForeground,
      approvalScope: state.approvalScope,
      safetyNote: state.safetyNote,
      targetApp: action.targetApp || null,
      sensitiveAction: false,
      traceId: trace.id,
      workbenchTrace: trace,
      failureKind: 'locator_missing',
      blockingReasons,
      recommendedAction,
    },
  };
}

function shouldBlockMissingDesktopLocator(action: ComputerAction): boolean {
  if (isSmartAction(action.action) || isSurfaceReadAction(action.action)) {
    return false;
  }
  if (!action.targetApp || !['click', 'doubleClick'].includes(action.action)) {
    return false;
  }
  if (isFiniteNumber(action.x) && isFiniteNumber(action.y)) {
    return false;
  }
  if (hasBackgroundCgEventLocator(action)) {
    return false;
  }
  return !hasDesktopElementLocator(action);
}

function hasDesktopElementLocator(action: ComputerAction): boolean {
  return Boolean(action.axPath || action.selector || (action.role && action.name));
}

function hasBackgroundCgEventLocator(action: ComputerAction): boolean {
  const hasWindowIdentity = (isFiniteNumber(action.pid) && isFiniteNumber(action.windowId))
    || isValidWindowRef(action.windowRef);
  const hasWindowPoint = Boolean(
    (action.windowLocalPoint && isFiniteNumber(action.windowLocalPoint.x) && isFiniteNumber(action.windowLocalPoint.y))
    || (isFiniteNumber(action.windowX) && isFiniteNumber(action.windowY)),
  );
  return hasWindowIdentity && hasWindowPoint;
}

function isValidWindowRef(value: unknown): value is string {
  return typeof value === 'string' && /^cgwin:\d+:\d+:[a-f0-9]{12}$/i.test(value);
}

function classifyComputerSurfaceActionFailure(
  error: string,
  mode: ComputerSurfaceState['mode'],
): ComputerSurfaceFailureKind {
  const message = error.toLowerCase();
  if (/not authorized|not permitted|operation not permitted|assistive access|accessibility|privacy|tcc/.test(message)) {
    return 'permission_denied';
  }
  if (/target app is not running|application isn't running|app is not running/.test(message)) {
    return 'target_app_not_running';
  }
  if (/target window verification failed|stale|not visible now|target window not found|window not found|windowref|windowid|window id/.test(message)) {
    return 'target_window_not_found';
  }
  if (/target element not found|element not found|no matching element|could not find/.test(message)) {
    return 'locator_missing';
  }
  if (/multiple matches|ambiguous|more than one/.test(message)) {
    return 'locator_ambiguous';
  }
  if (/coordinate|screen point|invalid index|outside/.test(message)) {
    return 'coordinate_untrusted';
  }
  return mode === 'background_ax' && /ax|accessibility|ui element/.test(message)
    ? 'ax_unavailable'
    : 'action_execution_failed';
}

function getComputerSurfaceReliabilityFromMetadata(
  metadata: Record<string, unknown>,
  result?: ToolExecutionResult,
  mode: ComputerSurfaceState['mode'] = 'background_ax',
): {
  failureKind: ComputerSurfaceFailureKind | null;
  blockingReasons?: string[];
  recommendedAction: string | null;
  axQuality: ComputerSurfaceAxQuality | null;
} {
  const failureKind = isComputerSurfaceFailureKind(metadata.failureKind)
    ? metadata.failureKind
    : !result?.success && result?.error
      ? classifyComputerSurfaceActionFailure(result.error, mode)
      : null;
  const blockingReasons = Array.isArray(metadata.blockingReasons)
    ? metadata.blockingReasons.filter((item): item is string => typeof item === 'string')
    : undefined;
  const recommendedAction = typeof metadata.recommendedAction === 'string'
    ? metadata.recommendedAction
    : null;
  const axQuality = isComputerSurfaceAxQuality(metadata.axQuality)
    ? metadata.axQuality
    : null;
  return {
    failureKind,
    blockingReasons,
    recommendedAction,
    axQuality,
  };
}

function isComputerSurfaceFailureKind(value: unknown): value is ComputerSurfaceFailureKind {
  return typeof value === 'string' && [
    'permission_denied',
    'target_app_not_running',
    'target_not_frontmost',
    'target_window_not_found',
    'ax_unavailable',
    'ax_tree_poor',
    'locator_missing',
    'locator_ambiguous',
    'coordinate_untrusted',
    'action_execution_failed',
    'evidence_unavailable',
  ].includes(value);
}

function isComputerSurfaceAxQuality(value: unknown): value is ComputerSurfaceAxQuality {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record.score === 'number'
    && ['good', 'usable', 'poor'].includes(String(record.grade))
    && typeof record.elementCount === 'number'
    && Array.isArray(record.reasons);
}

function redactComputerActionParams(action: ComputerAction): Record<string, unknown> {
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(action)) {
    redacted[key] = key === 'text' && typeof value === 'string'
      ? `[redacted ${value.length} chars]`
      : value;
  }
  return redacted;
}

function getEvidenceSummaryFromMetadata(metadata: Record<string, unknown> | undefined): string[] | undefined {
  const value = metadata?.evidenceSummary;
  if (!Array.isArray(value)) return undefined;
  const summary = value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
  return summary.length > 0 ? summary : undefined;
}

function isSurfaceReadAction(action: ActionType): boolean {
  return action === 'get_state'
    || action === 'observe'
    || action === 'get_ax_elements'
    || action === 'get_windows'
    || action === 'diagnose_app';
}

async function executeSurfaceReadAction(
  computerSurface: ReturnType<typeof getComputerSurface>,
  action: ComputerAction,
): Promise<ToolExecutionResult> {
  if (action.action === 'observe') {
    return observeComputerSurface(computerSurface, action);
  }

  if (action.action === 'get_ax_elements') {
    return listComputerSurfaceElements(computerSurface, action);
  }

  if (action.action === 'get_windows') {
    return listComputerSurfaceWindows(computerSurface, action);
  }

  if (action.action === 'diagnose_app') {
    return diagnoseComputerSurfaceApp(computerSurface, action);
  }

  return getComputerSurfaceStateResult(computerSurface.getState({
    targetApp: action.targetApp || undefined,
  }));
}

function getComputerSurfaceStateResult(state: ComputerSurfaceState): ToolExecutionResult {
  return {
    success: true,
    output: formatComputerSurfaceState(state),
    metadata: {
      computerSurface: state,
      computerSurfaceMode: state.mode,
      backgroundSurface: isBackgroundComputerSurfaceMode(state.mode),
      foregroundFallback: state.mode === 'foreground_fallback',
      background: state.background,
      requiresForeground: state.requiresForeground,
      approvalScope: state.approvalScope,
      safetyNote: state.safetyNote,
      targetApp: state.targetApp || null,
    },
  };
}

async function observeComputerSurface(
  computerSurface: ReturnType<typeof getComputerSurface>,
  action: Pick<ComputerAction, 'includeScreenshot' | 'targetApp'>,
): Promise<ToolExecutionResult> {
  const snapshot = await computerSurface.observe({
    includeScreenshot: action.includeScreenshot,
    targetApp: action.targetApp,
  });
  const state = computerSurface.getState({
    targetApp: snapshot.appName || undefined,
  });
  const label = action.targetApp ? 'Target' : 'Frontmost';
  return {
    success: true,
    output: [
      formatComputerSurfaceState(state),
      `${label}: ${snapshot.appName || action.targetApp || 'unknown'}${snapshot.windowTitle ? ` · ${snapshot.windowTitle}` : ''}`,
      snapshot.screenshotPath ? `Screenshot: ${snapshot.screenshotPath}` : null,
    ].filter(Boolean).join('\n'),
    metadata: {
      computerSurface: state,
      computerSurfaceMode: state.mode,
      backgroundSurface: isBackgroundComputerSurfaceMode(state.mode),
      foregroundFallback: state.mode === 'foreground_fallback',
      background: state.background,
      requiresForeground: state.requiresForeground,
      approvalScope: state.approvalScope,
      safetyNote: state.safetyNote,
      targetApp: state.targetApp || null,
      computerSurfaceSnapshot: snapshot,
    },
  };
}

async function listComputerSurfaceElements(
  computerSurface: ReturnType<typeof getComputerSurface>,
  action: ComputerAction,
): Promise<ToolExecutionResult> {
  const result = await computerSurface.listBackgroundElements(action);
  const reliability = getComputerSurfaceReliabilityFromMetadata(result.metadata || {}, result, 'background_ax');
  const state = computerSurface.getState({
    targetApp: action.targetApp || undefined,
    blockedReason: result.success ? null : result.error || null,
    mode: 'background_ax',
    failureKind: reliability.failureKind,
    blockingReasons: reliability.blockingReasons,
    recommendedAction: reliability.recommendedAction,
    axQuality: reliability.axQuality,
  });
  return {
    ...result,
    metadata: {
      ...(result.metadata || {}),
      computerSurface: state,
      computerSurfaceMode: state.mode,
      backgroundSurface: isBackgroundComputerSurfaceMode(state.mode),
      foregroundFallback: state.mode === 'foreground_fallback',
      background: state.background,
      requiresForeground: state.requiresForeground,
      approvalScope: state.approvalScope,
      safetyNote: state.safetyNote,
      targetApp: state.targetApp || action.targetApp || null,
      failureKind: reliability.failureKind,
      blockingReasons: reliability.blockingReasons,
      recommendedAction: reliability.recommendedAction,
      axQuality: reliability.axQuality,
    },
  };
}

async function listComputerSurfaceWindows(
  computerSurface: ReturnType<typeof getComputerSurface>,
  action: ComputerAction,
): Promise<ToolExecutionResult> {
  const result = await computerSurface.listBackgroundCgEventWindows({
    targetApp: action.targetApp,
    bundleId: action.bundleId,
    title: action.title,
    pid: action.pid,
    windowId: action.windowId,
    limit: action.limit,
    timeoutMs: action.timeout,
  });
  const metadata = result.metadata || {};
  const reliability = getComputerSurfaceReliabilityFromMetadata(metadata, result, 'background_cgevent');
  const state = computerSurface.getState({
    targetApp: action.targetApp || undefined,
    blockedReason: result.success ? null : result.error || null,
    mode: 'background_cgevent',
    failureKind: reliability.failureKind,
    blockingReasons: reliability.blockingReasons,
    recommendedAction: reliability.recommendedAction,
  });
  return {
    ...result,
    metadata: {
      ...metadata,
      computerSurface: state,
      computerSurfaceMode: state.mode,
      backgroundSurface: true,
      foregroundFallback: false,
      background: state.background,
      requiresForeground: state.requiresForeground,
      approvalScope: state.approvalScope,
      safetyNote: state.safetyNote,
      targetApp: action.targetApp || null,
      failureKind: reliability.failureKind,
      blockingReasons: reliability.blockingReasons,
      recommendedAction: reliability.recommendedAction,
    },
  };
}

async function diagnoseComputerSurfaceApp(
  computerSurface: ReturnType<typeof getComputerSurface>,
  action: ComputerAction,
): Promise<ToolExecutionResult> {
  const result = await computerSurface.diagnoseApp(action);
  const metadata = result.metadata || {};
  const reliability = getComputerSurfaceReliabilityFromMetadata(metadata, result, 'background_cgevent');
  const state = computerSurface.getState({
    targetApp: action.targetApp || undefined,
    blockedReason: result.success ? null : result.error || null,
    mode: 'background_cgevent',
    failureKind: reliability.failureKind,
    blockingReasons: reliability.blockingReasons,
    recommendedAction: reliability.recommendedAction,
  });
  return {
    ...result,
    metadata: {
      ...metadata,
      computerSurface: state,
      computerSurfaceMode: state.mode,
      backgroundSurface: true,
      foregroundFallback: false,
      background: state.background,
      requiresForeground: state.requiresForeground,
      approvalScope: state.approvalScope,
      safetyNote: state.safetyNote,
      targetApp: action.targetApp || null,
      failureKind: reliability.failureKind,
      blockingReasons: reliability.blockingReasons,
      recommendedAction: reliability.recommendedAction,
    },
  };
}

function formatComputerSurfaceState(state: ComputerSurfaceState): string {
  const parts = [
    `Computer Surface: ${state.ready ? 'ready' : 'not ready'}`,
    `mode=${state.mode}`,
    `background=${state.background ? 'yes' : 'no'}`,
  ];
  if (state.requiresForeground) {
    parts.push('foreground=current app/window');
  }
  if (state.mode === 'background_ax') {
    parts.push('targeting=macOS Accessibility');
  }
  if (state.mode === 'background_cgevent') {
    parts.push('targeting=macOS CGEvent');
  }
  if (state.approvalScope) {
    parts.push(`approval=${state.approvalScope}`);
  }
  if (state.targetApp) {
    parts.push(`target=${state.targetApp}`);
  }
  if (state.blockedReason) {
    parts.push(`blocked=${state.blockedReason}`);
  }
  if (state.lastAction?.id) {
    parts.push(`lastTrace=${state.lastAction.id}`);
  }
  if (state.axQuality) {
    parts.push(`axQuality=${state.axQuality.grade}:${state.axQuality.score}`);
  }
  if (state.failureKind) {
    parts.push(`failure=${state.failureKind}`);
  }
  return parts.join(' · ');
}

// Check if action is a smart (Playwright-based) action
function isSmartAction(action: ActionType): boolean {
  return [
    'locate_element', 'locate_text', 'locate_role',
    'smart_click', 'smart_type', 'smart_hover', 'get_elements'
  ].includes(action);
}

// Execute smart actions using Playwright browserService
async function executeSmartAction(action: ComputerAction): Promise<ToolExecutionResult> {
  // Verify browser is running
  if (!browserService.isRunning()) {
    return {
      success: false,
      error: 'Browser not running. Use browser_action with action="launch" first, then "new_tab" to open a page.',
    };
  }

  const activeTab = browserService.getActiveTab();
  if (!activeTab) {
    return {
      success: false,
      error: 'No active tab. Use browser_action with action="new_tab" first.',
    };
  }

  const page = activeTab.page;
  const timeout = action.timeout || 5000;

  switch (action.action) {
    case 'locate_element':
      return await locateBySelector(page, action.selector, timeout);

    case 'locate_text':
      return await locateByText(page, action.text, action.exact, timeout);

    case 'locate_role':
      return await locateByRole(page, action.role, action.name, action.exact, timeout);

    case 'smart_click':
      return await smartClick(page, action, timeout);

    case 'smart_type':
      return await smartType(page, action, timeout);

    case 'smart_hover':
      return await smartHover(page, action, timeout);

    case 'get_elements':
      return await getInteractiveElements(page);

    default:
      return { success: false, error: `Unknown smart action: ${action.action}` };
  }
}

// Helper: Locate element by CSS selector
async function locateBySelector(
  page: import('playwright').Page,
  selector: string | undefined,
  timeout: number
): Promise<ToolExecutionResult> {
  if (!selector) {
    return { success: false, error: 'selector required for locate_element' };
  }
  try {
    const element = await page.waitForSelector(selector, { timeout });
    if (!element) {
      return { success: false, error: `Element not found: ${selector}` };
    }
    const box = await element.boundingBox();
    if (!box) {
      return { success: false, error: 'Element has no bounding box (may be hidden)' };
    }
    const centerX = Math.round(box.x + box.width / 2);
    const centerY = Math.round(box.y + box.height / 2);
    return {
      success: true,
      output: `Element found at (${centerX}, ${centerY})\nBounding box: x=${Math.round(box.x)}, y=${Math.round(box.y)}, width=${Math.round(box.width)}, height=${Math.round(box.height)}`,
      metadata: { x: centerX, y: centerY, box },
    };
  } catch {
    return { success: false, error: `Element not found within ${timeout}ms: ${selector}` };
  }
}

// Helper: Locate element by text content
async function locateByText(
  page: import('playwright').Page,
  text: string | undefined,
  exact: boolean | undefined,
  timeout: number
): Promise<ToolExecutionResult> {
  if (!text) {
    return { success: false, error: 'text required for locate_text' };
  }
  try {
    const textSelector = exact ? `text="${text}"` : `text=${text}`;
    const element = await page.waitForSelector(textSelector, { timeout });
    if (!element) {
      return { success: false, error: `Text not found: "${text}"` };
    }
    const box = await element.boundingBox();
    if (!box) {
      return { success: false, error: 'Element has no bounding box (may be hidden)' };
    }
    const centerX = Math.round(box.x + box.width / 2);
    const centerY = Math.round(box.y + box.height / 2);
    return {
      success: true,
      output: `Text "${text}" found at (${centerX}, ${centerY})`,
      metadata: { x: centerX, y: centerY, box },
    };
  } catch {
    return { success: false, error: `Text not found within ${timeout}ms: "${text}"` };
  }
}

// Helper: Locate element by ARIA role
async function locateByRole(
  page: import('playwright').Page,
  role: string | undefined,
  name: string | undefined,
  exact: boolean | undefined,
  timeout: number
): Promise<ToolExecutionResult> {
  if (!role) {
    return { success: false, error: 'role required for locate_role' };
  }
  try {
    type RoleType = Parameters<typeof page.getByRole>[0];
    const locator = name
      ? page.getByRole(role as RoleType, { name, exact })
      : page.getByRole(role as RoleType);

    await locator.waitFor({ timeout });
    const box = await locator.boundingBox();
    if (!box) {
      return { success: false, error: 'Element has no bounding box (may be hidden)' };
    }
    const centerX = Math.round(box.x + box.width / 2);
    const centerY = Math.round(box.y + box.height / 2);
    return {
      success: true,
      output: `Role="${role}"${name ? ` name="${name}"` : ''} found at (${centerX}, ${centerY})`,
      metadata: { x: centerX, y: centerY, box },
    };
  } catch {
    return { success: false, error: `Role not found within ${timeout}ms: role="${role}"${name ? ` name="${name}"` : ''}` };
  }
}

// Helper: Smart click by selector, text, or role
async function smartClick(
  page: import('playwright').Page,
  action: ComputerAction,
  timeout: number
): Promise<ToolExecutionResult> {
  if (!action.selector && !action.text && !action.role) {
    return { success: false, error: 'selector, text, or role required for smart_click' };
  }
  try {
    if (action.selector) {
      await page.click(action.selector, { timeout });
      return { success: true, output: `Clicked element: ${action.selector}` };
    } else if (action.text) {
      const textSelector = action.exact ? `text="${action.text}"` : `text=${action.text}`;
      await page.click(textSelector, { timeout });
      return { success: true, output: `Clicked text: "${action.text}"` };
    } else if (action.role) {
      type RoleType = Parameters<typeof page.getByRole>[0];
      const locator = action.name
        ? page.getByRole(action.role as RoleType, { name: action.name, exact: action.exact })
        : page.getByRole(action.role as RoleType);
      await locator.click({ timeout });
      return { success: true, output: `Clicked role="${action.role}"${action.name ? ` name="${action.name}"` : ''}` };
    }
    return { success: false, error: 'No valid target specified' };
  } catch (e) {
    return { success: false, error: `Click failed: ${e instanceof Error ? e.message : 'Unknown error'}` };
  }
}

// Helper: Smart type into element by selector or role
async function smartType(
  page: import('playwright').Page,
  action: ComputerAction,
  timeout: number
): Promise<ToolExecutionResult> {
  if (!action.selector && !action.role) {
    return { success: false, error: 'selector or role required for smart_type' };
  }
  if (action.text === undefined) {
    return { success: false, error: 'text required for smart_type' };
  }
  try {
    const lengthPreview = `${action.text.length} chars`;
    if (action.selector) {
      await page.fill(action.selector, action.text, { timeout });
      return { success: true, output: `Typed ${lengthPreview} into ${action.selector}` };
    } else if (action.role) {
      type RoleType = Parameters<typeof page.getByRole>[0];
      const locator = action.name
        ? page.getByRole(action.role as RoleType, { name: action.name, exact: action.exact })
        : page.getByRole(action.role as RoleType);
      await locator.fill(action.text, { timeout });
      return { success: true, output: `Typed ${lengthPreview} into role="${action.role}"` };
    }
    return { success: false, error: 'No valid target specified' };
  } catch (e) {
    return { success: false, error: `Type failed: ${e instanceof Error ? e.message : 'Unknown error'}` };
  }
}

// Helper: Smart hover by selector or text
async function smartHover(
  page: import('playwright').Page,
  action: ComputerAction,
  timeout: number
): Promise<ToolExecutionResult> {
  if (!action.selector && !action.text) {
    return { success: false, error: 'selector or text required for smart_hover' };
  }
  try {
    if (action.selector) {
      await page.hover(action.selector, { timeout });
      return { success: true, output: `Hovered over: ${action.selector}` };
    } else if (action.text) {
      const textSelector = action.exact ? `text="${action.text}"` : `text=${action.text}`;
      await page.hover(textSelector, { timeout });
      return { success: true, output: `Hovered over text: "${action.text}"` };
    }
    return { success: false, error: 'No valid target specified' };
  } catch (e) {
    return { success: false, error: `Hover failed: ${e instanceof Error ? e.message : 'Unknown error'}` };
  }
}

// Helper: Get all interactive elements on page
async function getInteractiveElements(
  page: import('playwright').Page
): Promise<ToolExecutionResult> {
  try {
    const selector = 'button, a, input, select, textarea, [role="button"], [role="link"], [onclick], [tabindex]';
    const elements = await page.locator(selector).all();

    if (elements.length === 0) {
      return { success: true, output: 'No interactive elements found on page.' };
    }

    const results: Array<{
      index: number;
      tag: string;
      role: string;
      text: string;
      selector: string;
      x: number;
      y: number;
    }> = [];

    // Process up to 30 elements
    const limit = Math.min(elements.length, 30);
    for (let i = 0; i < limit; i++) {
      const el = elements[i];
      try {
        const box = await el.boundingBox();
        if (!box || box.width === 0 || box.height === 0) continue;

        const tagName = await el.evaluate(node => node.tagName.toLowerCase());
        const role = await el.getAttribute('role') || '';
        const text = (await el.textContent() || '').trim().substring(0, 50);
        const placeholder = await el.getAttribute('placeholder') || '';
        const ariaLabel = await el.getAttribute('aria-label') || '';
        const id = await el.getAttribute('id');
        const className = await el.getAttribute('class');

        const displayText = text || placeholder || ariaLabel || '(no text)';
        const selectorHint = id ? `#${id}` : (className ? `.${className.split(' ').filter(Boolean)[0]}` : tagName);

        results.push({
          index: results.length + 1,
          tag: tagName,
          role,
          text: displayText,
          selector: selectorHint,
          x: Math.round(box.x + box.width / 2),
          y: Math.round(box.y + box.height / 2),
        });
      } catch {
        // Skip elements that can't be processed
      }
    }

    if (results.length === 0) {
      return { success: true, output: 'No visible interactive elements found on page.' };
    }

    const output = results.map(el =>
      `${el.index}. <${el.tag}${el.role ? ` role="${el.role}"` : ''}> "${el.text}" at (${el.x}, ${el.y}) - ${el.selector}`
    ).join('\n');

    return {
      success: true,
      output: `Found ${results.length} interactive elements:\n${output}`,
      metadata: { elements: results },
    };
  } catch (e) {
    return { success: false, error: `Failed to get elements: ${e instanceof Error ? e.message : 'Unknown error'}` };
  }
}

// macOS implementation using AppleScript/cliclick
async function executeMacOSAction(action: ComputerAction): Promise<ToolExecutionResult> {
  switch (action.action) {
    case 'click':
      if (!isFiniteNumber(action.x) || !isFiniteNumber(action.y)) {
        return { success: false, error: 'x and y coordinates required for click' };
      }
      await runOsaScript([
        `tell application "System Events" to click at {${Math.round(action.x)}, ${Math.round(action.y)}}`,
      ]);
      break;

    case 'doubleClick':
      if (!isFiniteNumber(action.x) || !isFiniteNumber(action.y)) {
        return { success: false, error: 'x and y coordinates required for double click' };
      }
      await runOsaScript([
        `tell application "System Events" to click at {${Math.round(action.x)}, ${Math.round(action.y)}}`,
      ]);
      await runOsaScript([
        `tell application "System Events" to click at {${Math.round(action.x)}, ${Math.round(action.y)}}`,
      ]);
      break;

    case 'rightClick':
      if (!isFiniteNumber(action.x) || !isFiniteNumber(action.y)) {
        return { success: false, error: 'x and y coordinates required for right click' };
      }
      await runOsaScript([
        `tell application "System Events" to click at {${Math.round(action.x)}, ${Math.round(action.y)}} with control down`,
      ]);
      break;

    case 'move':
      if (!isFiniteNumber(action.x) || !isFiniteNumber(action.y)) {
        return { success: false, error: 'x and y coordinates required for move' };
      }
      try {
        await execFileAsync('cliclick', [`m:${Math.round(action.x)},${Math.round(action.y)}`]);
      } catch (error) {
        return { success: false, error: `Mouse move requires cliclick: ${formatExecutionError(error)}` };
      }
      break;

    case 'type': {
      if (!action.text) {
        return { success: false, error: 'text required for type action' };
      }
      await runOsaScript([
        'on run argv',
        'tell application "System Events" to keystroke (item 1 of argv)',
        'end run',
      ], [action.text]);
      break;
    }

    case 'key': {
      if (!action.key) {
        return { success: false, error: 'key required for key action' };
      }
      const keyCode = getAppleScriptKeyCode(action.key);
      const modifierStr = formatAppleScriptModifiers(action.modifiers);

      if (keyCode.isKeyCode) {
        await runOsaScript([
          `tell application "System Events" to key code ${keyCode.value}${modifierStr}`,
        ]);
      } else {
        await runOsaScript([
          'on run argv',
          `tell application "System Events" to keystroke (item 1 of argv)${modifierStr}`,
          'end run',
        ], [String(keyCode.value)]);
      }
      break;
    }

    case 'scroll': {
      const scrollAmount = action.amount || 100;
      const scrollDir = action.direction || 'down';
      const deltaY = scrollDir === 'up' ? -scrollAmount : (scrollDir === 'down' ? scrollAmount : 0);
      const deltaX = scrollDir === 'left' ? -scrollAmount : (scrollDir === 'right' ? scrollAmount : 0);

      await runOsaScript([
        `tell application "System Events" to scroll {${deltaX}, ${deltaY}}`,
      ]);
      break;
    }

    case 'drag':
      if (!isFiniteNumber(action.x) || !isFiniteNumber(action.y) ||
          !isFiniteNumber(action.toX) || !isFiniteNumber(action.toY)) {
        return { success: false, error: 'x, y, toX, toY coordinates required for drag' };
      }
      try {
        await execFileAsync('cliclick', [
          `dd:${Math.round(action.x)},${Math.round(action.y)}`,
          `dm:${Math.round(action.toX)},${Math.round(action.toY)}`,
          `du:${Math.round(action.toX)},${Math.round(action.toY)}`,
        ]);
      } catch (error) {
        return { success: false, error: `Drag requires cliclick: ${formatExecutionError(error)}` };
      }
      break;

    default:
      return { success: false, error: `Unknown action: ${action.action}` };
  }

  const typedTextSuffix = action.text ? ` text: ${action.text.length} chars` : '';
  return {
    success: true,
    output: `Action completed: ${action.action}${
      action.x !== undefined ? ` at (${action.x}, ${action.y})` : ''
    }${typedTextSuffix}${
      action.key ? ` key: ${action.key}` : ''
    }`,
  };
}

async function runOsaScript(lines: string[], args: string[] = []): Promise<void> {
  await execFileAsync('osascript', [
    ...lines.flatMap((line) => ['-e', line]),
    ...args,
  ]);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function formatAppleScriptModifiers(modifiers: string[] | undefined): string {
  if (!modifiers?.length) {
    return '';
  }
  const mapped = modifiers
    .map((modifier) => {
      switch (modifier) {
        case 'cmd':
          return 'command down';
        case 'ctrl':
          return 'control down';
        case 'alt':
          return 'option down';
        case 'shift':
          return 'shift down';
        default:
          return null;
      }
    })
    .filter((modifier) => modifier !== null);

  return mapped.length > 0 ? ` using {${mapped.join(', ')}}` : '';
}

function formatExecutionError(error: unknown): string {
  if (error instanceof Error) {
    return error.message.replace(/\s+/g, ' ').trim();
  }
  return 'Unknown error';
}

// Linux implementation using xdotool
async function executeLinuxAction(action: ComputerAction): Promise<ToolExecutionResult> {
  switch (action.action) {
    case 'click':
      if (action.x === undefined || action.y === undefined) {
        return { success: false, error: 'x and y coordinates required for click' };
      }
      await execFileAsync('xdotool', ['mousemove', String(action.x), String(action.y), 'click', '1']);
      break;

    case 'doubleClick':
      if (action.x === undefined || action.y === undefined) {
        return { success: false, error: 'x and y coordinates required for double click' };
      }
      await execFileAsync('xdotool', ['mousemove', String(action.x), String(action.y), 'click', '--repeat', '2', '1']);
      break;

    case 'rightClick':
      if (action.x === undefined || action.y === undefined) {
        return { success: false, error: 'x and y coordinates required for right click' };
      }
      await execFileAsync('xdotool', ['mousemove', String(action.x), String(action.y), 'click', '3']);
      break;

    case 'move':
      if (action.x === undefined || action.y === undefined) {
        return { success: false, error: 'x and y coordinates required for move' };
      }
      await execFileAsync('xdotool', ['mousemove', String(action.x), String(action.y)]);
      break;

    case 'type':
      if (!action.text) {
        return { success: false, error: 'text required for type action' };
      }
      await execFileAsync('xdotool', ['type', action.text]);
      break;

    case 'key': {
      if (!action.key) {
        return { success: false, error: 'key required for key action' };
      }
      const modifiers = action.modifiers?.map(m => {
        switch (m) {
          case 'cmd': return 'super';
          case 'ctrl': return 'ctrl';
          case 'alt': return 'alt';
          case 'shift': return 'shift';
          default: return m;
        }
      }).join('+') || '';
      const keyStr = modifiers ? `${modifiers}+${action.key}` : action.key;
      await execFileAsync('xdotool', ['key', keyStr]);
      break;
    }

    case 'scroll': {
      const amount = Math.ceil((action.amount || 100) / 10);
      const button = action.direction === 'up' ? 4 : (action.direction === 'down' ? 5 :
                     action.direction === 'left' ? 6 : 7);
      await execFileAsync('xdotool', ['click', '--repeat', String(amount), String(button)]);
      break;
    }

    case 'drag':
      if (action.x === undefined || action.y === undefined ||
          action.toX === undefined || action.toY === undefined) {
        return { success: false, error: 'x, y, toX, toY coordinates required for drag' };
      }
      await execFileAsync('xdotool', [
        'mousemove', String(action.x), String(action.y),
        'mousedown', '1',
        'mousemove', String(action.toX), String(action.toY),
        'mouseup', '1',
      ]);
      break;

    default:
      return { success: false, error: `Unknown action: ${action.action}` };
  }

  return {
    success: true,
    output: `Action completed: ${action.action}`,
  };
}

// Windows implementation using PowerShell
async function executeWindowsAction(action: ComputerAction): Promise<ToolExecutionResult> {
  // Windows implementation placeholder
  // Would use SendInput API via PowerShell or AutoHotkey
  return {
    success: false,
    error: 'Windows computer_use not yet implemented. Consider using AutoHotkey integration.',
  };
}

// Helper function to get AppleScript key codes
function getAppleScriptKeyCode(key: string): { value: string | number; isKeyCode: boolean } {
  const keyCodes: Record<string, number> = {
    'enter': 36,
    'return': 36,
    'tab': 48,
    'space': 49,
    'delete': 51,
    'backspace': 51,
    'escape': 53,
    'esc': 53,
    'up': 126,
    'down': 125,
    'left': 123,
    'right': 124,
    'home': 115,
    'end': 119,
    'pageup': 116,
    'pagedown': 121,
    'f1': 122,
    'f2': 120,
    'f3': 99,
    'f4': 118,
    'f5': 96,
    'f6': 97,
    'f7': 98,
    'f8': 100,
    'f9': 101,
    'f10': 109,
    'f11': 103,
    'f12': 111,
  };

  const lowerKey = key.toLowerCase();
  if (keyCodes[lowerKey] !== undefined) {
    return { value: keyCodes[lowerKey], isKeyCode: true };
  }

  return { value: key, isKeyCode: false };
}
