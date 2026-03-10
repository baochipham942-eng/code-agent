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
  'click', 'doubleClick', 'rightClick', 'move', 'type', 'key', 'scroll', 'drag',
  'locate_element', 'locate_text', 'locate_role',
  'smart_click', 'smart_type', 'smart_hover', 'get_elements',
] as const;

export const ComputerTool: Tool = {
  name: 'Computer',
  description: `Unified computer control tool combining screenshot capture and mouse/keyboard automation.

## Screenshot action (screenshot tool):
- screenshot: Capture screen or window screenshot with optional AI analysis

## Basic mouse/keyboard actions (coordinate-based):
- click / doubleClick / rightClick: Click at x,y coordinates
- move: Move mouse to x,y
- type: Type text into focused element
- key: Press keyboard key with optional modifiers
- scroll: Scroll in direction (up/down/left/right)
- drag: Drag from x,y to toX,toY

## Smart actions (Playwright-powered, for browser):
- locate_element: Find element by CSS selector, return coordinates
- locate_text: Find element by text content, return coordinates
- locate_role: Find element by ARIA role and name
- smart_click: Click element by selector or text (no coordinates needed)
- smart_type: Type into element by selector (no coordinates needed)
- smart_hover: Hover over element by selector
- get_elements: List interactive elements on page

## Parameters:
- action: The action to perform (see above)
- target: [screenshot] 'screen' or 'window' (default: 'screen')
- windowName: [screenshot] Name of window to capture
- outputPath: [screenshot] Where to save the screenshot
- region: [screenshot] Specific region {x, y, width, height}
- analyze: [screenshot] Enable AI analysis (default: false)
- prompt: [screenshot] Custom prompt for AI analysis
- x, y: Screen coordinates (for basic mouse actions)
- toX, toY: Destination coordinates (for drag)
- selector: CSS selector (for smart actions)
- text: Text to type or text to find
- role: ARIA role (button, link, textbox, etc.)
- name: Accessible name for role-based location
- key: Key to press (enter, tab, escape, etc.)
- modifiers: Modifier keys ['cmd', 'ctrl', 'alt', 'shift']
- direction: Scroll direction (up/down/left/right)
- amount: Scroll amount in pixels
- exact: Exact text match (default: false)
- timeout: Wait timeout in ms (default: 5000)

IMPORTANT: For smart actions, browser must be launched via Browser tool first.`,
  requiresPermission: true,
  permissionLevel: 'execute', // highest among sub-tools: execute > write
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: [
          'screenshot',
          // computer_use basic actions
          'click', 'doubleClick', 'rightClick', 'move', 'type', 'key', 'scroll', 'drag',
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
        description: '[screenshot] Enable AI analysis of screenshot content (default: false)',
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
        description: 'Text to type or text content to locate',
      },
      key: {
        type: 'string',
        description: 'Key to press (enter, tab, escape, space, backspace, etc.)',
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
      exact: {
        type: 'boolean',
        description: 'Require exact text match (default: false)',
      },
      timeout: {
        type: 'number',
        description: 'Wait timeout in milliseconds (default: 5000)',
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
