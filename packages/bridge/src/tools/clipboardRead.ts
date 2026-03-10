import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ToolDefinition } from '../types';

const execFileAsync = promisify(execFile);

async function readClipboard(): Promise<string> {
  if (process.platform === 'darwin') {
    const { stdout } = await execFileAsync('pbpaste');
    return stdout;
  }
  if (process.platform === 'win32') {
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-Command', 'Get-Clipboard']);
    return stdout;
  }
  try {
    const { stdout } = await execFileAsync('xclip', ['-selection', 'clipboard', '-o']);
    return stdout;
  } catch {
    const { stdout } = await execFileAsync('wl-paste');
    return stdout;
  }
}

export const clipboardReadTool: ToolDefinition = {
  name: 'clipboard_read',
  permissionLevel: 'L1_READ',
  description: 'Read text from the system clipboard.',
  async run() {
    const content = await readClipboard();
    return JSON.stringify({ content }, null, 2);
  },
};
