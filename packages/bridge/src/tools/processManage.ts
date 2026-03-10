import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ToolDefinition } from '../types';

const execFileAsync = promisify(execFile);

async function listProcesses(): Promise<string> {
  if (process.platform === 'win32') {
    const { stdout } = await execFileAsync('tasklist');
    return stdout;
  }
  const { stdout } = await execFileAsync('ps', ['-axo', 'pid,ppid,comm,args']);
  return stdout;
}

async function killProcess(pid: number): Promise<void> {
  process.kill(pid, 'SIGTERM');
}

export const processManageTool: ToolDefinition = {
  name: 'process_manage',
  permissionLevel: 'L3_EXECUTE',
  description: 'List processes or terminate a process by pid.',
  async run(params) {
    const action = String(params.action ?? 'list');
    if (action === 'kill') {
      const pid = Number(params.pid);
      if (!Number.isInteger(pid)) {
        throw new Error('pid is required for kill action');
      }
      await killProcess(pid);
      return JSON.stringify({ pid, killed: true }, null, 2);
    }
    const output = await listProcesses();
    return JSON.stringify({ action: 'list', output }, null, 2);
  },
};
