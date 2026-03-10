import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { ensureSandboxDir } from '../security/sandbox';
import { validateCommand } from '../security/commandFilter';
import type { ToolDefinition } from '../types';

export const shellExecTool: ToolDefinition = {
  name: 'shell_exec',
  permissionLevel: 'L3_EXECUTE',
  description: 'Execute a shell command inside the sandbox with timeout and command filtering.',
  async run(params, context) {
    const command = String(params.command ?? '');
    const cwd = await ensureSandboxDir(
      String(params.cwd ?? context.config.workingDirectories[0]),
      context.config.workingDirectories
    );
    const timeout = Number(params.timeout ?? context.config.shellTimeout);
    const validation = validateCommand(command, context.config);
    if (!validation.allowed) {
      throw new Error(validation.reason ?? 'Command rejected');
    }

    const shell = process.platform === 'win32' ? 'powershell.exe' : process.env.SHELL || '/bin/bash';
    const shellArgs =
      process.platform === 'win32'
        ? ['-NoProfile', '-Command', command]
        : ['-lc', command];

    const streamId = randomUUID();
    const child = spawn(shell, shellArgs, { cwd, env: process.env });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      context.wsBroadcast('shell_output', { streamId, source: 'stdout', chunk: text });
    });

    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      context.wsBroadcast('shell_output', { streamId, source: 'stderr', chunk: text });
    });

    const exitCode = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new Error(`Command timed out after ${timeout}ms`));
      }, timeout);

      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });

      child.once('close', (code) => {
        clearTimeout(timer);
        resolve(code ?? 0);
      });
    });

    context.wsBroadcast('shell_exit', { streamId, exitCode });
    return JSON.stringify({ cwd, command, exitCode, stdout, stderr }, null, 2);
  },
};
