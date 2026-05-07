// Schema-only file (P0-7 方案 A — single source of truth)
// Pure type-only — does not pull legacy tool code at import time.
import type { ToolSchema } from '../../../protocol/tools';

export const computerSchema: ToolSchema = {
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
- mouse_down / mouse_up: Press or release the mouse button at x,y without the matching counterpart. Use these to build custom drag rhythms (slow drag for sliders/canvas) or hold-to-select gestures. Always pair them — every mouse_down must be followed by a mouse_up, otherwise the system stays in a stuck-button state.
- open_application: Launch or activate a macOS app. Pass the app name via targetApp (e.g. targetApp="Safari" or targetApp="Visual Studio Code"). Returns once the launch is initiated; chain observe to confirm it became frontmost.
- write_clipboard: Set the system pasteboard to text. Use this to deliver large or formatted text instead of typing it character by character (much faster, immune to focus shifts). Pass text via the text param.
- computer_batch: Execute a list of actions sequentially in one tool call. Pass the list via the actions param ([{action:"click", x:100, y:200}, {action:"type", text:"hello"}, ...]). Reduces RTT for multi-step interactions. Stops on first failure and returns partial result. Nested computer_batch is rejected.
- hold_key: Press one or more modifier keys for a duration (ms), then release. Limited to modifier keys (cmd, alt, ctrl, shift, fn) — pass them via the modifiers param (or a single key via the key param). Required for shift-multi-select, hold-space-to-pan, hold-cmd-to-drop-copy patterns.
- triple_click: Triple-click at x,y. Selects an entire line/paragraph in most text editors. If the target app does not respond to native triple-click, fall back to doubleClick + click.
- cursor_position: Return the current mouse cursor coordinates without moving anything. Output is "x,y" plus metadata.x / metadata.y.

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
          // computer_use extended actions (atomic mouse/keyboard primitives + batch)
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
        description: '[computer_batch] Sequential list of action descriptors to execute in one call. Each item has the same shape as a normal Computer call (action + per-action params). Nested computer_batch is rejected.',
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
        description: 'Text to type, text content to locate, or text to write to clipboard (write_clipboard)',
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
  category: 'vision',
  permissionLevel: 'execute',
  readOnly: false,
  allowInPlanMode: false,
};
