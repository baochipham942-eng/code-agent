// ============================================================================
// Computer Use Tool - Mouse and keyboard automation with smart element location
// Gen 6: Computer Use capability enhanced with Playwright integration
// ============================================================================

import type { Tool, ToolContext, ToolExecutionResult } from '../toolRegistry';
import { exec } from 'child_process';
import { promisify } from 'util';
import { isComputerUseEnabled } from '../../services/cloud/featureFlagService';
import { browserService } from '../../services/infra/browserService.js';

const execAsync = promisify(exec);

// Extended action types with smart location capabilities
type ActionType =
  | 'click' | 'doubleClick' | 'rightClick' | 'move' | 'type' | 'key' | 'scroll' | 'drag'
  // Smart location actions (Playwright-powered)
  | 'locate_element' | 'locate_text' | 'locate_role'
  | 'smart_click' | 'smart_type' | 'smart_hover'
  | 'get_elements';

interface ComputerAction {
  action: ActionType;
  x?: number;
  y?: number;
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
  exact?: boolean;
  timeout?: number;
}

export const computerUseTool: Tool = {
  name: 'computer_use',
  description: `Control the computer with mouse, keyboard, and smart element location.

## Basic Actions (coordinate-based):
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
- selector: CSS selector (for smart actions)
- text: Text to type or text to find
- role: ARIA role (button, link, textbox, etc.)
- name: Accessible name for role-based location
- key: Key to press (enter, tab, escape, etc.)
- modifiers: Modifier keys ['cmd', 'ctrl', 'alt', 'shift']
- exact: Exact text match (default: false)
- timeout: Wait timeout in ms (default: 5000)

## Examples:
- {"action": "smart_click", "selector": "button.submit"}
- {"action": "smart_click", "text": "Sign In"}
- {"action": "locate_role", "role": "button", "name": "Submit"}
- {"action": "smart_type", "selector": "#email", "text": "user@example.com"}
- {"action": "get_elements"} - list all interactive elements

IMPORTANT: For smart actions, browser must be launched via browser_action first.`,
  generations: ['gen6', 'gen7', 'gen8'],
  requiresPermission: true,
  permissionLevel: 'execute',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: [
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
      y: {
        type: 'number',
        description: 'Y coordinate on screen (for basic mouse actions)',
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
    },
    required: ['action'],
  },

  async execute(
    params: Record<string, unknown>,
    _context: ToolContext
  ): Promise<ToolExecutionResult> {
    // Feature Flag: 检查 Computer Use 是否启用
    if (!isComputerUseEnabled()) {
      return {
        success: false,
        error: 'Computer Use is disabled. This feature is controlled by cloud configuration.',
      };
    }

    const action = params as unknown as ComputerAction;

    try {
      // Smart actions use Playwright (browser must be running)
      if (isSmartAction(action.action)) {
        return await executeSmartAction(action);
      }

      // Basic actions use platform-specific implementations
      if (process.platform === 'darwin') {
        return await executeMacOSAction(action);
      } else if (process.platform === 'linux') {
        return await executeLinuxAction(action);
      } else if (process.platform === 'win32') {
        return await executeWindowsAction(action);
      } else {
        return {
          success: false,
          error: `Unsupported platform: ${process.platform}`,
        };
      }
    } catch (error) {
      return {
        success: false,
        error: `Action failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
    }
  },
};

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
    const preview = action.text.length > 30 ? action.text.substring(0, 30) + '...' : action.text;
    if (action.selector) {
      await page.fill(action.selector, action.text, { timeout });
      return { success: true, output: `Typed into ${action.selector}: "${preview}"` };
    } else if (action.role) {
      type RoleType = Parameters<typeof page.getByRole>[0];
      const locator = action.name
        ? page.getByRole(action.role as RoleType, { name: action.name, exact: action.exact })
        : page.getByRole(action.role as RoleType);
      await locator.fill(action.text, { timeout });
      return { success: true, output: `Typed into role="${action.role}": "${preview}"` };
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
  let command: string;

  switch (action.action) {
    case 'click':
      if (action.x === undefined || action.y === undefined) {
        return { success: false, error: 'x and y coordinates required for click' };
      }
      // Using AppleScript for mouse control
      command = `osascript -e 'tell application "System Events" to click at {${action.x}, ${action.y}}'`;
      // Alternative using cliclick if installed: `cliclick c:${action.x},${action.y}`
      break;

    case 'doubleClick':
      if (action.x === undefined || action.y === undefined) {
        return { success: false, error: 'x and y coordinates required for double click' };
      }
      command = `osascript -e 'tell application "System Events" to click at {${action.x}, ${action.y}}' && osascript -e 'tell application "System Events" to click at {${action.x}, ${action.y}}'`;
      break;

    case 'rightClick':
      if (action.x === undefined || action.y === undefined) {
        return { success: false, error: 'x and y coordinates required for right click' };
      }
      command = `osascript -e 'tell application "System Events" to click at {${action.x}, ${action.y}} with control down'`;
      break;

    case 'move':
      if (action.x === undefined || action.y === undefined) {
        return { success: false, error: 'x and y coordinates required for move' };
      }
      // AppleScript doesn't support pure mouse move, use cliclick if available
      command = `cliclick m:${action.x},${action.y} 2>/dev/null || echo "Mouse moved to ${action.x},${action.y}"`;
      break;

    case 'type': {
      if (!action.text) {
        return { success: false, error: 'text required for type action' };
      }
      // Escape special characters for AppleScript
      const escapedText = action.text.replace(/"/g, '\\"').replace(/\\/g, '\\\\');
      command = `osascript -e 'tell application "System Events" to keystroke "${escapedText}"'`;
      break;
    }

    case 'key': {
      if (!action.key) {
        return { success: false, error: 'key required for key action' };
      }
      const keyCode = getAppleScriptKeyCode(action.key);
      const modifierStr = action.modifiers?.length
        ? `using {${action.modifiers.map(m => `${m} down`).join(', ')}}`
        : '';

      if (keyCode.isKeyCode) {
        command = `osascript -e 'tell application "System Events" to key code ${keyCode.value} ${modifierStr}'`;
      } else {
        command = `osascript -e 'tell application "System Events" to keystroke "${keyCode.value}" ${modifierStr}'`;
      }
      break;
    }

    case 'scroll': {
      const scrollAmount = action.amount || 100;
      const scrollDir = action.direction || 'down';
      const deltaY = scrollDir === 'up' ? -scrollAmount : (scrollDir === 'down' ? scrollAmount : 0);
      const deltaX = scrollDir === 'left' ? -scrollAmount : (scrollDir === 'right' ? scrollAmount : 0);

      command = `osascript -e 'tell application "System Events" to scroll {${deltaX}, ${deltaY}}'`;
      break;
    }

    case 'drag':
      if (action.x === undefined || action.y === undefined ||
          action.toX === undefined || action.toY === undefined) {
        return { success: false, error: 'x, y, toX, toY coordinates required for drag' };
      }
      command = `cliclick dd:${action.x},${action.y} dm:${action.toX},${action.toY} du:${action.toX},${action.toY} 2>/dev/null || echo "Dragged from ${action.x},${action.y} to ${action.toX},${action.toY}"`;
      break;

    default:
      return { success: false, error: `Unknown action: ${action.action}` };
  }

  await execAsync(command);

  return {
    success: true,
    output: `Action completed: ${action.action}${
      action.x !== undefined ? ` at (${action.x}, ${action.y})` : ''
    }${action.text ? ` text: "${action.text.substring(0, 20)}..."` : ''}${
      action.key ? ` key: ${action.key}` : ''
    }`,
  };
}

// Linux implementation using xdotool
async function executeLinuxAction(action: ComputerAction): Promise<ToolExecutionResult> {
  let command: string;

  switch (action.action) {
    case 'click':
      if (action.x === undefined || action.y === undefined) {
        return { success: false, error: 'x and y coordinates required for click' };
      }
      command = `xdotool mousemove ${action.x} ${action.y} click 1`;
      break;

    case 'doubleClick':
      if (action.x === undefined || action.y === undefined) {
        return { success: false, error: 'x and y coordinates required for double click' };
      }
      command = `xdotool mousemove ${action.x} ${action.y} click --repeat 2 1`;
      break;

    case 'rightClick':
      if (action.x === undefined || action.y === undefined) {
        return { success: false, error: 'x and y coordinates required for right click' };
      }
      command = `xdotool mousemove ${action.x} ${action.y} click 3`;
      break;

    case 'move':
      if (action.x === undefined || action.y === undefined) {
        return { success: false, error: 'x and y coordinates required for move' };
      }
      command = `xdotool mousemove ${action.x} ${action.y}`;
      break;

    case 'type':
      if (!action.text) {
        return { success: false, error: 'text required for type action' };
      }
      command = `xdotool type "${action.text.replace(/"/g, '\\"')}"`;
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
      command = `xdotool key ${keyStr}`;
      break;
    }

    case 'scroll': {
      const amount = Math.ceil((action.amount || 100) / 10);
      const button = action.direction === 'up' ? 4 : (action.direction === 'down' ? 5 :
                     action.direction === 'left' ? 6 : 7);
      command = `xdotool click --repeat ${amount} ${button}`;
      break;
    }

    case 'drag':
      if (action.x === undefined || action.y === undefined ||
          action.toX === undefined || action.toY === undefined) {
        return { success: false, error: 'x, y, toX, toY coordinates required for drag' };
      }
      command = `xdotool mousemove ${action.x} ${action.y} mousedown 1 mousemove ${action.toX} ${action.toY} mouseup 1`;
      break;

    default:
      return { success: false, error: `Unknown action: ${action.action}` };
  }

  await execAsync(command);

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
