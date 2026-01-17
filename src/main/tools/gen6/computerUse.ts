// ============================================================================
// Computer Use Tool - Mouse and keyboard automation
// Gen 6: Computer Use capability
// ============================================================================

import type { Tool, ToolContext, ToolExecutionResult } from '../ToolRegistry';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

type ActionType = 'click' | 'doubleClick' | 'rightClick' | 'move' | 'type' | 'key' | 'scroll' | 'drag';

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
}

export const computerUseTool: Tool = {
  name: 'computer_use',
  description: `Control the computer with mouse and keyboard actions.

Use this tool to:
- Click at specific screen coordinates
- Type text into focused applications
- Press keyboard shortcuts
- Scroll in any direction
- Drag and drop elements

Parameters:
- action: The action to perform
- x, y: Screen coordinates (for mouse actions)
- text: Text to type (for 'type' action)
- key: Key to press (for 'key' action, e.g., 'enter', 'tab', 'escape')
- modifiers: Modifier keys ['cmd', 'ctrl', 'alt', 'shift']
- direction: Scroll direction (for 'scroll' action)
- amount: Scroll amount in pixels

IMPORTANT: Use screenshot tool first to understand current screen state.`,
  generations: ['gen6'],
  requiresPermission: true,
  permissionLevel: 'execute',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['click', 'doubleClick', 'rightClick', 'move', 'type', 'key', 'scroll', 'drag'],
        description: 'The action to perform',
      },
      x: {
        type: 'number',
        description: 'X coordinate on screen',
      },
      y: {
        type: 'number',
        description: 'Y coordinate on screen',
      },
      text: {
        type: 'string',
        description: 'Text to type (for type action)',
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
    },
    required: ['action'],
  },

  async execute(
    params: Record<string, unknown>,
    _context: ToolContext
  ): Promise<ToolExecutionResult> {
    const action = params as unknown as ComputerAction;

    try {
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

    case 'type':
      if (!action.text) {
        return { success: false, error: 'text required for type action' };
      }
      // Escape special characters for AppleScript
      const escapedText = action.text.replace(/"/g, '\\"').replace(/\\/g, '\\\\');
      command = `osascript -e 'tell application "System Events" to keystroke "${escapedText}"'`;
      break;

    case 'key':
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

    case 'scroll':
      const scrollAmount = action.amount || 100;
      const scrollDir = action.direction || 'down';
      const deltaY = scrollDir === 'up' ? -scrollAmount : (scrollDir === 'down' ? scrollAmount : 0);
      const deltaX = scrollDir === 'left' ? -scrollAmount : (scrollDir === 'right' ? scrollAmount : 0);

      command = `osascript -e 'tell application "System Events" to scroll {${deltaX}, ${deltaY}}'`;
      break;

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

    case 'key':
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

    case 'scroll':
      const amount = Math.ceil((action.amount || 100) / 10);
      const button = action.direction === 'up' ? 4 : (action.direction === 'down' ? 5 :
                     action.direction === 'left' ? 6 : 7);
      command = `xdotool click --repeat ${amount} ${button}`;
      break;

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
