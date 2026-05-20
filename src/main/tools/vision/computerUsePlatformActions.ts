import { execFile } from 'child_process';
import { promisify } from 'util';
import type { ToolExecutionResult } from '../types';
import { getComputerSurface } from '../../services/desktop/computerSurface';
import { COMPUTER_BATCH } from '../../../shared/constants';
import { imageCoordsToScreenPoints } from './coordinateTransform';
import { normalizeComputerActionAliases } from './computerUseAppAliases';
import { isFiniteNumber } from './computerUseGuards';
import type { ComputerAction } from './computerUse';

const execFileAsync = promisify(execFile);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function normalizeImageSpaceCoords(action: ComputerAction): Promise<ComputerAction> {
  if (action.coordSpace !== 'image' || process.platform !== 'darwin') return action;
  const surface = getComputerSurface();
  const cached = surface.getLastAnalyzedImageDims();
  const analyzedWidth = isFiniteNumber(action.imageWidth) ? action.imageWidth : cached?.width ?? null;
  const analyzedHeight = isFiniteNumber(action.imageHeight) ? action.imageHeight : cached?.height ?? null;
  const displayInfo = await surface.getDisplayInfo().catch(() => null);
  const ctx = {
    analyzedWidth,
    analyzedHeight,
    displayPointWidth: displayInfo?.pointWidth ?? null,
    displayPointHeight: displayInfo?.pointHeight ?? null,
  };
  const next: ComputerAction = { ...action };
  if (isFiniteNumber(action.x) && isFiniteNumber(action.y)) {
    const point = imageCoordsToScreenPoints({ x: action.x, y: action.y }, ctx);
    next.x = point.x;
    next.y = point.y;
  }
  if (isFiniteNumber(action.toX) && isFiniteNumber(action.toY)) {
    const point = imageCoordsToScreenPoints({ x: action.toX, y: action.toY }, ctx);
    next.toX = point.x;
    next.toY = point.y;
  }
  return next;
}

export async function executeMacOSAction(rawAction: ComputerAction): Promise<ToolExecutionResult> {
  const action = await normalizeImageSpaceCoords(rawAction);
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

    case 'mouse_down':
      if (!isFiniteNumber(action.x) || !isFiniteNumber(action.y)) {
        return { success: false, error: 'x and y coordinates required for mouse_down' };
      }
      try {
        await execFileAsync('cliclick', [`dd:${Math.round(action.x)},${Math.round(action.y)}`]);
      } catch (error) {
        return { success: false, error: `mouse_down requires cliclick: ${formatExecutionError(error)}` };
      }
      break;

    case 'mouse_up':
      if (!isFiniteNumber(action.x) || !isFiniteNumber(action.y)) {
        return { success: false, error: 'x and y coordinates required for mouse_up' };
      }
      try {
        await execFileAsync('cliclick', [`du:${Math.round(action.x)},${Math.round(action.y)}`]);
      } catch (error) {
        return { success: false, error: `mouse_up requires cliclick: ${formatExecutionError(error)}` };
      }
      break;

    case 'open_application': {
      const appName = action.targetApp;
      if (!appName || typeof appName !== 'string' || !appName.trim()) {
        return { success: false, error: 'targetApp required for open_application (e.g. "Safari")' };
      }
      try {
        await execFileAsync('open', ['-a', appName]);
      } catch (error) {
        const requested = action.requestedTargetApp && action.requestedTargetApp !== appName
          ? ` (requested as "${action.requestedTargetApp}")`
          : '';
        return { success: false, error: `Failed to open application "${appName}"${requested}: ${formatExecutionError(error)}` };
      }
      return {
        success: true,
        output: `Action completed: open_application target=${appName}${
          action.requestedTargetApp && action.requestedTargetApp !== appName
            ? ` (requested as ${action.requestedTargetApp})`
            : ''
        }`,
        metadata: {
          targetApp: appName,
          requestedTargetApp: action.requestedTargetApp || appName,
          targetAppAliasApplied: action.targetAppAliasApplied === true,
        },
      };
    }

    case 'write_clipboard': {
      if (typeof action.text !== 'string') {
        return { success: false, error: 'text required for write_clipboard' };
      }
      try {
        await runOsaScript([
          'on run argv',
          'set the clipboard to (item 1 of argv)',
          'end run',
        ], [action.text]);
      } catch (error) {
        return { success: false, error: `Failed to write clipboard: ${formatExecutionError(error)}` };
      }
      break;
    }

    case 'computer_batch': {
      if (!Array.isArray(action.actions)) {
        return { success: false, error: 'actions array required for computer_batch' };
      }
      const settleMs = Math.max(
        0,
        Math.min(
          isFiniteNumber(action.settleMs) ? action.settleMs : COMPUTER_BATCH.DEFAULT_SETTLE_MS,
          COMPUTER_BATCH.MAX_SETTLE_MS,
        ),
      );
      const results: Array<{ index: number; action: string; success: boolean; error?: string }> = [];
      for (let index = 0; index < action.actions.length; index++) {
        const rawSub = action.actions[index] as ComputerAction | undefined;
        if (!rawSub || typeof rawSub !== 'object' || typeof rawSub.action !== 'string') {
          return { success: false, error: `Invalid action at index ${index} in computer_batch`, metadata: { results } };
        }
        const sub = normalizeComputerActionAliases(rawSub);
        if (sub.action === 'computer_batch') {
          return { success: false, error: `Nested computer_batch at index ${index} is not allowed`, metadata: { results } };
        }
        const result = await executeMacOSAction(sub);
        results.push({ index, action: sub.action, success: result.success, error: result.error });
        if (!result.success) {
          return {
            success: false,
            error: `batch failed at index ${index} (${sub.action}): ${result.error}`,
            metadata: { results },
          };
        }
        if (settleMs > 0 && index < action.actions.length - 1) {
          await sleep(settleMs);
        }
      }
      let postBatchObserve: unknown = null;
      if (action.observeAfter) {
        postBatchObserve = await getComputerSurface()
          .observe({ includeScreenshot: false })
          .catch(() => null);
      }
      return {
        success: true,
        output: `computer_batch completed: ${results.length} action(s)`,
        metadata: { results, settleMs, postBatchObserve },
      };
    }

    case 'hold_key': {
      const keysList: string[] = [];
      if (Array.isArray(action.modifiers) && action.modifiers.length > 0) {
        keysList.push(...action.modifiers);
      } else if (typeof action.key === 'string' && action.key.trim()) {
        keysList.push(action.key);
      }
      if (keysList.length === 0) {
        return { success: false, error: 'hold_key requires modifiers array or key (cmd/alt/ctrl/shift/fn)' };
      }
      const allowedModifiers = new Set(['cmd', 'alt', 'ctrl', 'shift', 'fn']);
      for (const key of keysList) {
        if (!allowedModifiers.has(key)) {
          return { success: false, error: `hold_key only supports modifier keys (cmd/alt/ctrl/shift/fn). Got: ${key}` };
        }
      }
      const keysArg = keysList.join(',');
      const duration = isFiniteNumber(action.duration) && action.duration > 0 ? action.duration : 1000;
      try {
        await execFileAsync('cliclick', [`kd:${keysArg}`]);
        await new Promise((resolve) => setTimeout(resolve, duration));
        await execFileAsync('cliclick', [`ku:${keysArg}`]);
      } catch (error) {
        try { await execFileAsync('cliclick', [`ku:${keysArg}`]); } catch { /* ignore */ }
        return { success: false, error: `hold_key failed: ${formatExecutionError(error)}` };
      }
      break;
    }

    case 'triple_click':
      if (!isFiniteNumber(action.x) || !isFiniteNumber(action.y)) {
        return { success: false, error: 'x and y coordinates required for triple_click' };
      }
      try {
        await execFileAsync('cliclick', [`tc:${Math.round(action.x)},${Math.round(action.y)}`]);
      } catch (error) {
        return { success: false, error: `triple_click requires cliclick: ${formatExecutionError(error)}` };
      }
      break;

    case 'cursor_position': {
      try {
        const { stdout } = await execFileAsync('cliclick', ['p']);
        const match = stdout.trim().match(/^(-?\d+),(-?\d+)$/);
        if (!match) {
          return { success: false, error: `Failed to parse cursor position output: ${stdout.trim()}` };
        }
        const cx = parseInt(match[1], 10);
        const cy = parseInt(match[2], 10);
        return {
          success: true,
          output: `${cx},${cy}`,
          metadata: { x: cx, y: cy },
        };
      } catch (error) {
        return { success: false, error: `cursor_position requires cliclick: ${formatExecutionError(error)}` };
      }
    }

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

export async function executeLinuxAction(action: ComputerAction): Promise<ToolExecutionResult> {
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
      const modifiers = action.modifiers?.map((modifier) => {
        switch (modifier) {
          case 'cmd': return 'super';
          case 'ctrl': return 'ctrl';
          case 'alt': return 'alt';
          case 'shift': return 'shift';
          default: return modifier;
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

export async function executeWindowsAction(_action: ComputerAction): Promise<ToolExecutionResult> {
  return {
    success: false,
    error: 'Windows computer_use not yet implemented. Consider using AutoHotkey integration.',
  };
}

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
