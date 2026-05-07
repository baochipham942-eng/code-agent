// ============================================================================
// Computer Tool - Unified screenshot and computer control
// ============================================================================
// Merges screenshot and computer_use into a single tool
// with an `action` parameter dispatching to the original implementations.
// ============================================================================

import type { Tool, ToolContext, ToolExecutionResult } from '../types';
import { screenshotTool } from './screenshot';
import { computerUseTool } from './computerUse';

// Actions from computerUseTool
const COMPUTER_USE_ACTIONS = [
  'get_state', 'observe', 'get_ax_elements', 'get_windows', 'diagnose_app',
  'click', 'doubleClick', 'rightClick', 'move', 'type', 'key', 'scroll', 'drag',
  'mouse_down', 'mouse_up', 'open_application', 'write_clipboard', 'computer_batch',
  'hold_key', 'triple_click', 'cursor_position',
  'locate_element', 'locate_text', 'locate_role',
  'smart_click', 'smart_type', 'smart_hover', 'get_elements',
] as const;

export const ComputerTool: Tool = {
  name: 'Computer',
  description: `Unified computer control tool combining screenshot capture and mouse/keyboard automation. Also exposed as "computer_use" — both names map to the same capability set. If the user says "computer_use" or you previously planned with that name, use this tool.

## Screenshot action (screenshot tool):
- screenshot: Capture screen/window. By default the assistant only gets back a file path and does NOT see the pixels — set analyze=true (or chain image_analyze on the saved file) before claiming you observed anything on screen.

## Basic mouse/keyboard actions (coordinate-based):
- get_state / observe / get_ax_elements / get_windows / diagnose_app: Read Computer Surface state, frontmost or target app/window, Accessibility candidates, scored macOS windows, and App-level AX/TCC/CGEvent diagnostics
- click / doubleClick / rightClick: Click at x,y coordinates
- move: Move mouse to x,y
- type: Type text. Without targetApp+axPath this fires global keystrokes at the frontmost app — if focus shifts mid-task (video call popup, OS notification, app switch) input lands in the wrong window. Use targetApp + axPath (from get_ax_elements / locate_role) for headless typing immune to frontmost changes.
- key: Press keyboard shortcut. Same caveat as type. Note: shortcuts (Cmd+N etc.) cannot be routed via background AX — if you just want to trigger a menu item, prefer get_ax_elements to find the AXMenuItem and click its axPath.
- scroll: Scroll in direction (up/down/left/right)
- drag: Drag from x,y to toX,toY
- mouse_down / mouse_up: Press or release the mouse button at x,y without the matching counterpart. Use to build custom drag rhythms (sliders/canvas) or hold-to-select. Always pair them — every mouse_down must be followed by a mouse_up.
- open_application: Launch or activate a macOS app. Pass the app name via targetApp (e.g. "Safari", "Visual Studio Code"). Chain observe to confirm it became frontmost.
- write_clipboard: Set the system pasteboard to text (text param). Faster and focus-shift-immune compared to type for large/formatted text.
- computer_batch: Execute a list of actions sequentially in one tool call (actions param, e.g. [{action:"click",x:100,y:200},{action:"type",text:"hi"}]). Stops on first failure. Nested computer_batch is rejected.
- hold_key: Press one or more modifier keys (cmd/alt/ctrl/shift/fn) for a duration (ms), then release. Pass via modifiers (preferred) or single key. Use for shift-multi-select, hold-space-to-pan, hold-cmd-to-drop-copy.
- triple_click: Triple-click at x,y to select a line/paragraph. Fallback: doubleClick + click if target app does not respond.
- cursor_position: Return current cursor coordinates without moving the mouse. Output is "x,y" plus metadata.x / metadata.y.

## Smart actions (Playwright-powered, browser only unless noted):
- locate_element: [browser only] Find element by CSS selector, return coordinates
- locate_text: [browser only] Find element by text content, return coordinates
- locate_role: Find element by ARIA role and name. Dual-mode:
    * Browser (no targetApp): returns coordinates via Playwright
    * Desktop (targetApp + role [+ name]): returns axPath via macOS Accessibility; chain with click/doubleClick/type using the returned axPath
- smart_click: [browser only] Click element by selector or text (no coordinates needed)
- smart_type: [browser only] Type into element by selector (no coordinates needed)
- smart_hover: [browser only] Hover over element by selector
- get_elements: [browser only] List interactive elements on page

## Parameters:
- action: The action to perform (see above)
- target: [screenshot] 'screen' or 'window' (default: 'screen')
- windowName: [screenshot] Name of window to capture
- outputPath: [screenshot] Where to save the screenshot
- region: [screenshot] Specific region {x, y, width, height}
- analyze: [screenshot] Enable AI analysis (default: false)
- prompt: [screenshot] Custom prompt for AI analysis
- x, y: Screen coordinates (for basic mouse actions)
- pid, windowId, windowRef, windowLocalPoint/windowX/windowY: [macOS CGEvent] Background target returned by get_windows
- bundleId, title: [macOS CGEvent] Expected target identity for get_windows filters and stale-window checks
- toX, toY: Destination coordinates (for drag)
- selector: CSS selector (for smart actions)
- text: Text to type or text to find
- role: ARIA role (button, link, textbox, etc.)
- name: Accessible name for role-based location
- axPath: Background Accessibility path returned by get_ax_elements
- key: Key to press (enter, tab, escape, etc.)
- modifiers: Modifier keys ['cmd', 'ctrl', 'alt', 'shift']
- direction: Scroll direction (up/down/left/right)
- amount: Scroll amount in pixels
- exact: Exact text match (default: false)
- timeout: Wait timeout in ms (default: 5000)
- limit: Maximum elements for get_ax_elements
- maxDepth: Maximum Accessibility tree depth for get_ax_elements

## Standard recipe for filling a desktop text field (avoids "keystrokes-go-to-wrong-app" bugs)
1. observe (confirm targetApp is reachable)
2. get_ax_elements (list element axPaths)
3. locate_role with targetApp + role [+ name] (resolve to a single axPath)
4. type with targetApp + axPath + text (background AX, immune to frontmost-app changes)

If a tool result includes metadata.foregroundFallbackWarning, your last keystroke ran as a global event — re-run the recipe with targetApp+axPath before continuing.

IMPORTANT: locate_element / locate_text / smart_* / get_elements require a launched browser. locate_role with targetApp is the only smart action that works on desktop apps (returns axPath via macOS Accessibility — feed it back to click/type with the same targetApp).`,
  requiresPermission: true,
  permissionLevel: 'execute', // highest among sub-tools: execute > write
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: [
          'screenshot',
          // computer surface read actions
          'get_state', 'observe', 'get_ax_elements', 'get_windows', 'diagnose_app',
          // computer_use basic actions
          'click', 'doubleClick', 'rightClick', 'move', 'type', 'key', 'scroll', 'drag',
          // computer_use extended actions (atomic primitives + batch)
          'mouse_down', 'mouse_up', 'open_application', 'write_clipboard', 'computer_batch',
          // computer_use richer interactions
          'hold_key', 'triple_click', 'cursor_position',
          // computer_use smart actions
          'locate_element', 'locate_text', 'locate_role',
          'smart_click', 'smart_type', 'smart_hover', 'get_elements',
        ],
        description: 'The action to perform',
      },
      // --- screenshot params ---
      target: {
        type: 'string',
        enum: ['screen', 'window'],
        description: '[screenshot] What to capture: full screen or specific window',
      },
      windowName: {
        type: 'string',
        description: '[screenshot] Name of the window to capture',
      },
      outputPath: {
        type: 'string',
        description: '[screenshot] Path to save the screenshot (default: temp directory)',
      },
      region: {
        type: 'object',
        properties: {
          x: { type: 'number' },
          y: { type: 'number' },
          width: { type: 'number' },
          height: { type: 'number' },
        },
        description: '[screenshot] Specific region to capture (x, y, width, height)',
      },
      analyze: {
        type: 'boolean',
        description: '[screenshot] Enable AI analysis (default: false). MUST be true if you intend to verify or describe what is on screen — without it the assistant only sees the file path.',
      },
      prompt: {
        type: 'string',
        description: '[screenshot] Custom prompt for AI analysis',
      },
      // --- computer_use basic params ---
      x: {
        type: 'number',
        description: 'X coordinate on screen (for basic mouse actions)',
      },
      y: {
        type: 'number',
        description: 'Y coordinate on screen (for basic mouse actions)',
      },
      pid: {
        type: 'number',
        description: '[macOS CGEvent] Process id returned by get_windows',
      },
      windowId: {
        type: 'number',
        description: '[macOS CGEvent] CGWindowID returned by get_windows',
      },
      windowRef: {
        type: 'string',
        description: '[macOS CGEvent] Stable window reference returned by get_windows',
      },
      bundleId: {
        type: 'string',
        description: '[macOS CGEvent] Expected target app bundle identifier',
      },
      title: {
        type: 'string',
        description: '[macOS CGEvent] Expected target window title',
      },
      windowLocalPoint: {
        type: 'object',
        properties: {
          x: { type: 'number' },
          y: { type: 'number' },
        },
        description: '[macOS CGEvent] Point inside the target window',
      },
      windowX: {
        type: 'number',
        description: '[macOS CGEvent] X coordinate inside the target window',
      },
      windowY: {
        type: 'number',
        description: '[macOS CGEvent] Y coordinate inside the target window',
      },
      button: {
        type: 'string',
        enum: ['left', 'right'],
        description: '[macOS CGEvent] Mouse button',
      },
      clickCount: {
        type: 'number',
        description: '[macOS CGEvent] Click count',
      },
      targetApp: {
        type: 'string',
        description: 'Expected target app for desktop actions. With axPath or role/name, macOS can use the background Accessibility surface. For open_application, this is the app name to launch (e.g. "Safari", "Visual Studio Code").',
      },
      actions: {
        type: 'array',
        items: { type: 'object' },
        description: '[computer_batch] Sequential list of action descriptors to execute in one call. Each item has the same shape as a normal Computer call. Nested computer_batch is rejected.',
      },
      toX: {
        type: 'number',
        description: 'Destination X coordinate (for drag action)',
      },
      toY: {
        type: 'number',
        description: 'Destination Y coordinate (for drag action)',
      },
      text: {
        type: 'string',
        description: 'Text to type, text to locate, or text to write to clipboard (write_clipboard)',
      },
      key: {
        type: 'string',
        description: 'Key to press (enter, tab, escape, space, backspace, etc.)',
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
      // --- computer_use smart params ---
      selector: {
        type: 'string',
        description: 'CSS selector for smart element location',
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
      exact: {
        type: 'boolean',
        description: 'Require exact text match (default: false)',
      },
      timeout: {
        type: 'number',
        description: 'Wait timeout in milliseconds (default: 5000)',
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
    const action = params.action as string;

    // --- Screenshot action → delegate to screenshotTool ---
    if (action === 'screenshot') {
      return screenshotTool.execute(params, context);
    }

    // --- Computer use actions → delegate to computerUseTool ---
    if ((COMPUTER_USE_ACTIONS as readonly string[]).includes(action)) {
      return computerUseTool.execute(params, context);
    }

    return {
      success: false,
      error: `Unknown action: ${action}. Valid actions: screenshot, ${COMPUTER_USE_ACTIONS.join(', ')}`,
    };
  },
};
