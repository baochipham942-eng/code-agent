// ============================================================================
// Computer Use Tool - Mouse and keyboard automation with smart element location
// Gen 6: Computer Use capability enhanced with Playwright integration
// ============================================================================

import type { Tool, ToolContext, ToolExecutionResult } from '../types';
import type { ComputerSurfaceState } from '../../../shared/contract/desktop';
import { isComputerUseEnabled } from '../../services/cloud/featureFlagService';
import { getComputerSurface } from '../../services/desktop/computerSurface';
import { acquireComputerSurfaceLock } from '../../services/desktop/computerSurfaceLock';
import { isMultiAgentMode } from '../../services/multiAgentMode';
import { persistBrowserComputerProofFromResult } from '../../session/browserComputerProofStore';
import {
  appendBrowserWorkbenchNote,
  buildBrowserWorkbenchBlockedResult,
  ensureManagedBrowserSessionForWorkbench,
  evaluateBrowserWorkbenchPolicy,
} from './browserWorkbenchIntent';
import {
  executeSmartAction,
  isSmartAction,
} from './computerUseSmartBrowserActions';
import {
  executeLinuxAction,
  executeMacOSAction,
  executeWindowsAction,
} from './computerUsePlatformActions';
import {
  normalizeComputerActionAliases,
  resolveMacOSApplicationAlias,
} from './computerUseAppAliases';
import {
  buildComputerSurfacePreflightBlockedResult,
  classifyComputerSurfaceActionFailure,
  executeSurfaceReadAction,
  getEvidenceSummaryFromMetadata,
  isBackgroundComputerSurfaceMode,
  isSurfaceReadAction,
  withComputerSurfaceMetadata,
} from './computerUseSurfaceRuntime';
import {
  buildBrowserComputerProof,
  renderBrowserComputerEvidenceCard,
  type BrowserComputerEvidenceInput,
  type BrowserComputerVisualObservation,
} from '../../../shared/utils/browserComputerRedaction';
import { buildAgentPointerEventFromToolCall } from '../../../shared/utils/agentPointer';

export { resolveMacOSApplicationAlias };

// Extended action types with smart location capabilities
type ActionType =
  | 'get_state' | 'observe' | 'get_ax_elements' | 'get_windows' | 'diagnose_app'
  | 'click' | 'doubleClick' | 'rightClick' | 'move' | 'type' | 'key' | 'scroll' | 'drag'
  // Extended atomic primitives + batch
  | 'mouse_down' | 'mouse_up' | 'open_application' | 'write_clipboard' | 'computer_batch'
  // Richer interactions
  | 'hold_key' | 'triple_click' | 'cursor_position'
  // Smart location actions (Playwright-powered)
  | 'locate_element' | 'locate_text' | 'locate_role'
  | 'smart_click' | 'smart_type' | 'smart_hover'
  | 'get_elements';

export interface ComputerAction {
  action: ActionType;
  targetApp?: string;
  requestedTargetApp?: string;
  targetAppAliasApplied?: boolean;
  x?: number;
  y?: number;
  /**
   * 坐标空间。'image' 表示 x/y/toX/toY 来自视觉分析截图（分析图像像素空间），
   * 执行前会换算成逻辑屏幕点。缺省 'screen'（= 现有行为，不换算）。
   */
  coordSpace?: 'screen' | 'image';
  /** [coordSpace=image] 模型看到的分析图像像素尺寸；缺省时回退到 computerSurface 缓存的最近一次 */
  imageWidth?: number;
  imageHeight?: number;
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
  // computer_batch
  actions?: ComputerAction[];
  /** [computer_batch] 子动作间延迟 (ms)，让 UI settle。默认 0，capped MAX_SETTLE_MS */
  settleMs?: number;
  /** [computer_batch] true 时 batch 完成后抓一次 observe 快照塞进 metadata.postBatchObserve */
  observeAfter?: boolean;
  // hold_key
  duration?: number;
}

export const computerUseTool: Tool = {
  name: 'computer_use',
  description: `Control the computer with mouse, keyboard, and smart element location. Also exposed as "Computer" (capital C) — both names map to the same capability set; either entry is fine.

Desktop routing contract:
- Before any desktop click/type/key/scroll/drag, first confirm Computer Surface readiness, permission state, target app/window, and a fresh observation/snapshot.
- Do not use desktop actions for plain URL reading or static page summaries. Prefer lightweight fetch/read/search tools unless the task needs login, forms, multi-page interaction, dynamic UI state, screenshots, or visual verification.
- Coordinate actions need an explicit source: observe/screenshot/cursor evidence for screen/image coordinates, get_ax_elements/locate_role for axPath, or get_windows for pid/windowId/windowRef/windowLocalPoint.
- If permission, foreground window, snapshot, or coordinate/locator evidence is missing, return a blocked reason plus the next read action instead of guessing. After any desktop action, call observe/get_state again before claiming the final UI state.

## Basic Actions (coordinate-based):
- get_state: Return Computer Surface readiness, mode, approvals, and last action
- observe: Return frontmost app/window snapshot before choosing an action
- get_ax_elements: List accessible elements for a target app/window through macOS Accessibility
- get_windows: List scored visible macOS window candidates with pid/windowId/windowRef/bounds for background CGEvent debugging
- diagnose_app: Diagnose target app process/window/TCC/AX/CGEvent readiness in one call
- click/doubleClick/rightClick: Click at x,y coordinates
- move: Move mouse to x,y
- type: Type text. Without targetApp+axPath this fires global keystrokes at whatever app is frontmost RIGHT NOW — if a video call or another app steals focus mid-task your input lands in the wrong window. Prefer the headless form: targetApp + axPath (axPath comes from get_ax_elements or locate_role). Coordinate-form (x,y) also fires global keystrokes after a click.
- key: Press keyboard key/shortcut. Same caveat as type — global keyboard event sent to the frontmost app. Cmd+N etc. cannot be routed via background AX; if you only need to invoke a menu item, prefer get_ax_elements to find the AXMenuItem and click its axPath instead of a global shortcut.
- scroll: Scroll in direction (up/down/left/right)
- drag: Drag from x,y to toX,toY
- mouse_down / mouse_up: Press or release the mouse button at x,y without the matching counterpart. Use to build custom drag rhythms (sliders/canvas) or hold-to-select. Always pair them.
- open_application: Launch or activate a macOS app (targetApp param, e.g. "Safari").
- write_clipboard: Set the system pasteboard to text (text param). Faster than type for large/formatted content and immune to focus shifts.
- computer_batch: Execute a list of actions sequentially in one call (actions param). Stops on first failure. Nested batch is rejected. Pass settleMs (~150-300) to insert a delay between sub-actions so the UI can settle (click→type / click→click); pass observeAfter:true to capture an observe snapshot after the batch into metadata.postBatchObserve.
- hold_key: Press one or more modifier keys (cmd/alt/ctrl/shift/fn) for a duration ms then release. Pass via modifiers (or single key). Use for shift-multi-select, hold-space-to-pan, hold-cmd-to-drop-copy patterns.
- triple_click: Triple-click at x,y to select a line/paragraph. Fallback: doubleClick + click if app does not respond.
- cursor_position: Return current cursor coordinates without moving the mouse. Output is "x,y", metadata.x / metadata.y populated.

## Smart Actions (Playwright-powered, browser only unless noted):
- locate_element: [browser only] Find element by CSS selector, return coordinates
- locate_text: [browser only] Find element by text content, return coordinates
- locate_role: Find element by ARIA role and name. Dual-mode:
    * Browser (no targetApp): returns coordinates via Playwright
    * Desktop (targetApp + role [+ name]): returns axPath via macOS Accessibility, feed it back to click/doubleClick/type
- smart_click: [browser only] Click element by selector or text (no coordinates needed)
- smart_type: [browser only] Type into element by selector (no coordinates needed)
- smart_hover: [browser only] Hover over element by selector
- get_elements: [browser only] List interactive elements on page

## Parameters:
- action: The action to perform
- x, y: Screen coordinates (for basic mouse actions)
- coordSpace: 'screen' (default) or 'image'. Set 'image' when x/y came from a screenshot you analyzed — they will be scaled from the analyzed-image space to logical screen points before clicking. Pass imageWidth/imageHeight (from screenshot metadata.analyzedWidth/Height) alongside it.
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
- settleMs: [computer_batch] Delay in ms between sub-actions (default: 0, capped at 5000)
- observeAfter: [computer_batch] Capture an observe snapshot after the batch (default: false)

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
- {"action": "locate_role", "role": "button", "name": "Submit"} - browser, returns coordinates
- {"action": "locate_role", "targetApp": "Notes", "role": "textbox"} - desktop, returns axPath; chain with {"action": "type", "targetApp": "Notes", "axPath": "...", "text": "hi"} to fill it
- {"action": "smart_type", "selector": "#email", "text": "user@example.com"}
- {"action": "get_elements"} - list all interactive elements

## Desktop operation contract
1. Observe first: use observe, get_state, get_windows, get_ax_elements, or diagnose_app before choosing a desktop action.
2. Keep coordinate provenance clear: screen coordinates must come from the current screenshot; axPath must come from the current Accessibility tree; windowLocalPoint must come from get_windows for the same target window.
3. Do not mix sources across windows, apps, or stale screenshots. If the active app/window changed, observe again.
4. Treat action success as event delivery only. Re-observe after click/type/batch to verify the UI result before continuing.
5. Prefer targetApp + axPath or targetApp + role/name for text fields and buttons. Use raw coordinates only when Accessibility cannot identify the target.

## Standard recipe for filling a desktop text field (avoids "keystrokes-go-to-wrong-app" bugs)
1. {"action":"observe", "targetApp":"Notes"} - confirm targetApp is reachable
2. {"action":"get_ax_elements", "targetApp":"Notes"} - list element axPaths
3. {"action":"locate_role", "targetApp":"Notes", "role":"textbox", "name":"..."} - resolve to a single axPath
4. {"action":"type", "targetApp":"Notes", "axPath":"...", "text":"..."} - background AX keystroke, immune to frontmost-app changes

If a tool result includes metadata.foregroundFallbackWarning, it means your last keyboard action ran as a global keystroke. Re-run the recipe above with targetApp+axPath before continuing — subsequent app switches will misroute further input.

IMPORTANT: locate_element / locate_text / smart_* / get_elements require a launched browser via browser_action. locate_role with targetApp is the only smart action that works on desktop apps (returns axPath via macOS Accessibility).`,
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
          'mouse_down', 'mouse_up', 'open_application', 'write_clipboard', 'computer_batch',
          'hold_key', 'triple_click', 'cursor_position',
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
        description: 'Expected target app for desktop actions. If omitted, the frontmost app is used. With axPath or role/name/selector on macOS, background Accessibility can target the app without requiring it to be frontmost. For open_application, this is the app name to launch (e.g. "Safari", "Visual Studio Code").',
      },
      actions: {
        type: 'array',
        items: { type: 'object' },
        description: '[computer_batch] Sequential list of action descriptors to execute in one call. Nested computer_batch is rejected.',
      },
      settleMs: {
        type: 'number',
        description: '[computer_batch] Delay in ms inserted after each sub-action before the next runs. Default 0. Use ~150-300 for click→type or click→click sequences so the UI can settle. Capped at 5000.',
      },
      observeAfter: {
        type: 'boolean',
        description: '[computer_batch] When true, capture an observe snapshot after the batch completes into metadata.postBatchObserve so you can verify the end state. Default false.',
      },
      y: {
        type: 'number',
        description: 'Y coordinate on screen (for basic mouse actions)',
      },
      coordSpace: {
        type: 'string',
        enum: ['screen', 'image'],
        description: 'Coordinate space for x/y/toX/toY. Use "image" when the coordinates came from a screenshot you analyzed (they get scaled to logical screen points before clicking). Default "screen".',
      },
      imageWidth: {
        type: 'number',
        description: '[coordSpace=image] Pixel width of the analyzed screenshot the coordinates came from (see screenshot result metadata.analyzedWidth). Falls back to the last analyzed screenshot if omitted.',
      },
      imageHeight: {
        type: 'number',
        description: '[coordSpace=image] Pixel height of the analyzed screenshot the coordinates came from (see screenshot result metadata.analyzedHeight).',
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
        description: 'Text to type, text to locate, or text to write to clipboard (write_clipboard)',
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
        items: { type: 'string', enum: ['cmd', 'ctrl', 'alt', 'shift', 'fn'] },
        description: 'Modifier keys to hold during action. For hold_key, this is the list of modifier keys to press together.',
      },
      duration: {
        type: 'number',
        description: '[hold_key] Duration in milliseconds to hold the key(s) down before releasing. Default 1000.',
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

    const action = normalizeComputerActionAliases(params as unknown as ComputerAction);
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
        agentId: context.agentId,
      }));
    }

    const computerSurface = getComputerSurface();
    if (isSurfaceReadAction(action.action)) {
      const result = await executeSurfaceReadAction(computerSurface, action);
      return appendBrowserWorkbenchNote(withComputerUseProof(result, action, context), workbenchNotes);
    }

    const earlySurfaceBlock = buildComputerSurfacePreflightBlockedResult(action, computerSurface);
    if (earlySurfaceBlock) {
      return appendBrowserWorkbenchNote(withComputerUseProof(earlySurfaceBlock, action, context), workbenchNotes);
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
      return appendBrowserWorkbenchNote(withComputerUseProof({
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
      }, action, context), workbenchNotes);
    }

    // Smart actions 走 BrowserService（已经按 agentId 池化，多 agent 并发 OK），
    // 不抢 frontmost / 全局键鼠 — 不进 ComputerSurface mutex。
    // 真正抢桌面资源的 write 路径（background_ax / background_cgevent /
    // macOS/linux/win32 native）必须串行。
    const needsSurfaceLock = !isSmartAction(action.action);
    const surfaceLockSlot = needsSurfaceLock ? await acquireComputerSurfaceLock() : null;

    try {
      let result: ToolExecutionResult;

      // Smart actions use Playwright (browser must be running).
      // Exception: locate_role with targetApp routes to macOS background AX
      // so the model can locate desktop-app elements without a browser.
      if (isSmartAction(action.action)) {
        if (action.action === 'locate_role' && action.targetApp) {
          result = await computerSurface.locateBackgroundElement(action);
        } else {
          result = await executeSmartAction(action, context.agentId);
        }
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
          resultMetadata: result.metadata,
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

      result = attachForegroundKeystrokeWarning(result, action, surfaceAuth?.state.mode || null);
      return appendBrowserWorkbenchNote(withComputerUseProof(result, action, context), workbenchNotes);
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
        return appendBrowserWorkbenchNote(withComputerUseProof(withComputerSurfaceMetadata(result, {
          state: computerSurface.getState({
            targetApp: surfaceAuth.state.targetApp || undefined,
            blockedReason: errorMessage,
            mode: surfaceAuth.state.mode,
          }),
          trace: completedTrace,
          sensitive: surfaceAuth.sensitive,
        }), action, context), workbenchNotes);
      }
      return appendBrowserWorkbenchNote(withComputerUseProof(result, action, context), workbenchNotes);
    } finally {
      surfaceLockSlot?.release();
    }
  },
};

function compactComputerProofText(value: unknown, maxChars = 3000): string {
  if (typeof value === 'string') return value.slice(0, maxChars);
  try {
    return JSON.stringify(value).slice(0, maxChars);
  } catch {
    return '';
  }
}

function buildComputerEvidenceInputs(result: ToolExecutionResult, action: ComputerAction): BrowserComputerEvidenceInput[] {
  const metadata = result.metadata || {};
  const evidence: BrowserComputerEvidenceInput[] = [];
  const trace = metadata.workbenchTrace as Record<string, unknown> | undefined;
  const traceId = typeof metadata.traceId === 'string'
    ? metadata.traceId
    : typeof trace?.id === 'string'
      ? trace.id
      : null;
  if (traceId) {
    evidence.push({
      kind: 'trace',
      ref: traceId,
      source: 'computerUse.trace',
      state: 'fresh',
    });
  }
  const snapshot = metadata.computerSurfaceSnapshot as Record<string, unknown> | undefined;
  if (snapshot && typeof snapshot.screenshotPath === 'string') {
    evidence.push({
      kind: 'screenshot',
      ref: snapshot.screenshotPath,
      source: 'computerUse.observe',
      state: 'fresh',
    });
  }
  if (Array.isArray(metadata.elements) || metadata.axQuality || action.axPath || action.role) {
    evidence.push({
      kind: 'computer_ax',
      ref: `computer_ax:${String(metadata.targetApp || action.targetApp || 'frontmost')}:${traceId || Date.now()}`,
      source: 'computerUse.ax',
      state: 'read',
    });
  }
  if (Array.isArray(metadata.windows) || metadata.recommendedWindow) {
    evidence.push({
      kind: 'computer_ax',
      ref: `computer_windows:${String(metadata.targetApp || action.targetApp || 'frontmost')}:${traceId || Date.now()}`,
      source: 'computerUse.windows',
      state: 'read',
    });
  }
  if (typeof metadata.path === 'string') {
    evidence.push({
      kind: 'screenshot',
      ref: metadata.path,
      source: 'computerUse.screenshot',
      state: metadata.analyzed === true ? 'read' : 'fresh',
    });
  }
  return evidence;
}

function inferComputerVisualObservation(result: ToolExecutionResult, action: ComputerAction): BrowserComputerVisualObservation {
  const metadata = result.metadata || {};
  if (Array.isArray(metadata.elements) || metadata.axQuality || action.axPath || action.role) {
    return { observed: true, source: 'ax' };
  }
  if (Array.isArray(metadata.windows) || metadata.recommendedWindow || metadata.appDiagnosis) {
    return { observed: true, source: 'trace' };
  }
  if ((metadata.computerSurfaceSnapshot as Record<string, unknown> | undefined)?.screenshotPath) {
    return {
      observed: false,
      source: 'none',
      cannotObserveScreen: true,
      reason: 'screenshot_path_only',
    };
  }
  return { observed: false, source: 'none', reason: 'no_ax_or_analyzed_screenshot' };
}

function withComputerUseProof(
  result: ToolExecutionResult,
  action: ComputerAction,
  context?: ToolContext,
): ToolExecutionResult {
  const metadata = result.metadata || {};
  const trace = metadata.workbenchTrace && typeof metadata.workbenchTrace === 'object'
    ? metadata.workbenchTrace as Record<string, unknown>
    : null;
  const traceId = typeof metadata.traceId === 'string'
    ? metadata.traceId
    : typeof trace?.id === 'string'
      ? trace.id
      : `computer_pointer_${Date.now()}`;
  const pointerEvent = buildAgentPointerEventFromToolCall({
    id: traceId,
    name: 'computer_use',
    arguments: action as unknown as Record<string, unknown>,
    result: {
      success: result.success,
      error: result.error,
      metadata,
    },
  });
  const traceWithPointer = trace
    ? { ...trace, agentPointerEvent: pointerEvent }
    : trace;
  const computerSurfaceWithPointer = traceWithPointer
    && metadata.computerSurface
    && typeof metadata.computerSurface === 'object'
    && !Array.isArray(metadata.computerSurface)
    ? {
        ...(metadata.computerSurface as Record<string, unknown>),
        lastAction: traceWithPointer,
      }
    : metadata.computerSurface;
  const manualTakeoverText = [
    result.output,
    result.error,
    compactComputerProofText(metadata.blockingReasons),
    compactComputerProofText(metadata.recommendedAction),
    compactComputerProofText(metadata.computerSurface),
  ].filter(Boolean).join('\n');
  const proof = buildBrowserComputerProof({
    evidence: buildComputerEvidenceInputs(result, action),
    targetRef: {
      targetApp: action.targetApp || metadata.targetApp || null,
      axPath: action.axPath || null,
      role: action.role || null,
      name: action.name || null,
      windowRef: action.windowRef || metadata.targetWindowRef || null,
    },
    approval: {
      approvalScope: metadata.approvalScope || null,
      sensitiveAction: metadata.sensitiveAction === true,
      workbenchBlocked: metadata.workbenchBlocked === true,
    },
    manualTakeoverText,
    manualTakeoverResumeRequires: [
      'computer_use.observe',
      'computer_use.get_ax_elements',
      'browser_action.get_dom_snapshot',
      'browser_action.get_a11y_snapshot',
      'browser_action.get_account_state',
    ],
    visualObservation: inferComputerVisualObservation(result, action),
    agentPointerEvent: pointerEvent,
  });
  const resultWithProof: ToolExecutionResult = {
    ...result,
    metadata: {
      ...metadata,
      workbenchTrace: traceWithPointer || metadata.workbenchTrace,
      computerSurface: computerSurfaceWithPointer,
      agentPointerEvent: pointerEvent,
      evidenceRefs: proof.evidenceRefs,
      browserComputerProof: proof,
      browserComputerEvidenceCard: renderBrowserComputerEvidenceCard(proof),
      ...(proof.visualObservation?.cannotObserveScreen ? { cannotObserveScreen: true } : {}),
    },
  };
  persistBrowserComputerProofFromResult(resultWithProof, {
    sessionId: context?.sessionId,
    toolCallId: context?.currentToolCallId,
    toolName: 'computer_use',
  });
  return resultWithProof;
}

const KEYSTROKE_ACTIONS_NEEDING_BACKGROUND = new Set<ActionType>(['type', 'key']);

export function attachForegroundKeystrokeWarning(
  result: ToolExecutionResult,
  action: ComputerAction,
  surfaceMode: ComputerSurfaceState['mode'] | null,
): ToolExecutionResult {
  if (!result.success || !KEYSTROKE_ACTIONS_NEEDING_BACKGROUND.has(action.action)) {
    return result;
  }
  const ranAsBackground = surfaceMode === 'background_ax' || surfaceMode === 'background_cgevent';
  if (ranAsBackground) {
    return result;
  }
  const multiAgent = isMultiAgentMode();
  const warning = multiAgent
    ? 'MULTI-AGENT MODE: Keystrokes were sent as global frontmost-app input while other agents may be operating the desktop. Subsequent input WILL collide with concurrent agents. You MUST re-run with targetApp + axPath (locate_role or get_ax_elements first) — coordinate-only / global keystrokes are unsafe in multi-agent mode.'
    : 'Keystrokes were sent to whatever app is frontmost RIGHT NOW. If focus shifts (notification, video call, app switch) further input lands in the wrong window. To stay headless, re-run with targetApp + axPath (locate_role or get_ax_elements first).';
  return {
    ...result,
    metadata: {
      ...(result.metadata || {}),
      foregroundFallbackWarning: warning,
      multiAgentMode: multiAgent,
    },
  };
}
