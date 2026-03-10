import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveSandboxPath } from '../security/sandbox';
import type { ToolDefinition } from '../types';

const execFileAsync = promisify(execFile);

export const openFileTool: ToolDefinition = {
  name: 'open_file',
  permissionLevel: 'L2_WRITE',
  description: 'Open a file with the OS default application.',
  async run(params, context) {
    const filePath = resolveSandboxPath(String(params.path ?? ''), context.config.workingDirectories);
    if (process.platform === 'darwin') {
      await execFileAsync('open', [filePath]);
    } else if (process.platform === 'win32') {
      await execFileAsync('cmd', ['/c', 'start', '', filePath]);
    } else {
      await execFileAsync('xdg-open', [filePath]);
    }
    return JSON.stringify({ path: filePath, opened: true }, null, 2);
  },
};
