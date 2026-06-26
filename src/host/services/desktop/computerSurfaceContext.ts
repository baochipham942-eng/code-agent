import { execFile } from 'child_process';
import { promisify } from 'util';
import type { ComputerSurfaceSnapshot } from '../../../shared/contract/desktop';
import {
  formatExecError,
  getExecStdout,
  isLikelyAccessibilityPermissionError,
  sameAppName,
} from './backgroundCgEventBridge';

const execFileAsync = promisify(execFile);

type ComputerSurfaceWindowContext = Pick<ComputerSurfaceSnapshot, 'appName' | 'windowTitle'>;

export interface ComputerSurfaceProcessStatus {
  running: boolean | null;
  permissionDenied?: boolean;
  error?: string;
}

export async function getComputerSurfaceProcessStatus(targetApp: string): Promise<ComputerSurfaceProcessStatus> {
  if (process.platform !== 'darwin') {
    return { running: null };
  }

  try {
    const stdout = getExecStdout(await execFileAsync('osascript', [
      '-e',
      'on run argv',
      '-e',
      'set targetApp to item 1 of argv',
      '-e',
      'tell application "System Events"',
      '-e',
      'if exists application process targetApp then return "running"',
      '-e',
      'return "missing"',
      '-e',
      'end tell',
      '-e',
      'end run',
      targetApp,
    ], {
      timeout: 3_000,
      maxBuffer: 1024 * 256,
    }));
    const text = stdout.trim();
    const lines = text.split(/\r?\n/).filter(Boolean);
    if (text === 'running') return { running: true };
    if (text === 'missing') return { running: false };
    if (lines.length >= 2) return { running: true };
    if (lines.length === 1 && sameAppName(lines[0], targetApp)) return { running: false };
    return { running: false };
  } catch (error) {
    const message = formatExecError(error);
    return {
      running: null,
      permissionDenied: isLikelyAccessibilityPermissionError(message),
      error: message,
    };
  }
}

export async function getFrontmostComputerSurfaceContext(): Promise<ComputerSurfaceWindowContext> {
  if (process.platform !== 'darwin') {
    return {};
  }

  try {
    const stdout = getExecStdout(await execFileAsync('osascript', [
      '-e',
      'tell application "System Events" to set frontApp to first application process whose frontmost is true',
      '-e',
      'tell application "System Events" to set appName to name of frontApp',
      '-e',
      'tell application "System Events" to set winTitle to ""',
      '-e',
      'tell application "System Events" to if exists window 1 of frontApp then set winTitle to name of window 1 of frontApp',
      '-e',
      'return appName & "\n" & winTitle',
    ]));
    const [appName, ...titleParts] = stdout.trim().split('\n');
    return {
      appName: appName || null,
      windowTitle: titleParts.join('\n') || null,
    };
  } catch {
    return {};
  }
}

export async function getTargetComputerSurfaceContext(targetApp: string): Promise<ComputerSurfaceWindowContext> {
  if (process.platform !== 'darwin') {
    return {};
  }

  try {
    const stdout = getExecStdout(await execFileAsync('osascript', [
      '-e',
      'on run argv',
      '-e',
      'set targetApp to item 1 of argv',
      '-e',
      'tell application "System Events"',
      '-e',
      'if not (exists application process targetApp) then return targetApp & "\n"',
      '-e',
      'tell application process targetApp',
      '-e',
      'set winTitle to ""',
      '-e',
      'if exists window 1 then set winTitle to name of window 1',
      '-e',
      'return name & "\n" & winTitle',
      '-e',
      'end tell',
      '-e',
      'end tell',
      '-e',
      'end run',
      targetApp,
    ]));
    const text = stdout.trim();
    const [appName, ...titleParts] = text.split('\n');
    if (sameAppName(appName || '', targetApp) && titleParts.length === 0) {
      return {
        appName: null,
        windowTitle: null,
      };
    }
    return {
      appName: appName || targetApp,
      windowTitle: titleParts.join('\n') || null,
    };
  } catch {
    return {
      appName: targetApp,
      windowTitle: null,
    };
  }
}
