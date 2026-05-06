// Schema-only file (P0-7 方案 A — single source of truth)
// Pure type-only — does not pull legacy tool code at import time.
import type { ToolSchema } from '../../../protocol/tools';

export const computerUseSchema: ToolSchema = {
  name: 'computer_use',
  description: `Control the computer with mouse, keyboard, and smart element location. Also exposed as "Computer" (capital C) — both names map to the same capability set; either entry is fine.

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
- {"action": "locate_role", "role": "button", "name": "Submit"} - browser, returns coordinates
- {"action": "locate_role", "targetApp": "Notes", "role": "textbox"} - desktop, returns axPath; chain with {"action": "type", "targetApp": "Notes", "axPath": "...", "text": "hi"} to fill it
- {"action": "smart_type", "selector": "#email", "text": "user@example.com"}
- {"action": "get_elements"} - list all interactive elements

## Standard recipe for filling a desktop text field (avoids "keystrokes-go-to-wrong-app" bugs)
1. {"action":"observe", "targetApp":"Notes"} - confirm targetApp is reachable
2. {"action":"get_ax_elements", "targetApp":"Notes"} - list element axPaths
3. {"action":"locate_role", "targetApp":"Notes", "role":"textbox", "name":"..."} - resolve to a single axPath
4. {"action":"type", "targetApp":"Notes", "axPath":"...", "text":"..."} - background AX keystroke, immune to frontmost-app changes

If a tool result includes metadata.foregroundFallbackWarning, it means your last keyboard action ran as a global keystroke. Re-run the recipe above with targetApp+axPath before continuing — subsequent app switches will misroute further input.

IMPORTANT: locate_element / locate_text / smart_* / get_elements require a launched browser via browser_action. locate_role with targetApp is the only smart action that works on desktop apps (returns axPath via macOS Accessibility).`,
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
  category: 'vision',
  permissionLevel: 'execute',
  readOnly: false,
  allowInPlanMode: false,
};
