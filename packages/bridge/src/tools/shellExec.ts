import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { ensureSandboxDir } from '../security/sandbox';
import { validateCommand } from '../security/commandFilter';
import type { ToolDefinition } from '../types';

const SHELL_KILL_GRACE_MS = 1_000;

function killShellProcessTree(child: Pick<ChildProcess, 'pid' | 'kill'>, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;

  if (process.platform === 'win32') {
    const args = ['/pid', String(child.pid), '/T'];
    if (signal === 'SIGKILL') args.push('/F');
    try {
      const killer = spawn('taskkill', args, { stdio: 'ignore', windowsHide: true });
      killer.once('error', () => {
        try { child.kill(signal); } catch { /* already exited */ }
      });
    } catch {
      try { child.kill(signal); } catch { /* already exited */ }
    }
    return;
  }

  try {
    process.kill(-child.pid, signal);
  } catch {
    try { child.kill(signal); } catch { /* already exited */ }
  }
}

export const shellExecTool: ToolDefinition = {
  name: 'shell_exec',
  permissionLevel: 'L3_EXECUTE',
  description: 'Execute a shell command inside the sandbox with timeout and command filtering.',
  async run(params, context) {
    if (context.abortSignal?.aborted) {
      throw new Error('Command cancelled before launch');
    }
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
    const child = spawn(shell, shellArgs, {
      cwd,
      env: process.env,
      detached: process.platform !== 'win32',
      windowsHide: true,
    });
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
      let settled = false;
      let childClosed = false;
      let killEscalationTimer: NodeJS.Timeout | undefined;
      const cleanup = (): void => {
        clearTimeout(timer);
        context.abortSignal?.removeEventListener('abort', onAbort);
      };
      const terminateTree = (): void => {
        killShellProcessTree(child, 'SIGTERM');
        if (!killEscalationTimer) {
          killEscalationTimer = setTimeout(() => {
            if (!childClosed) killShellProcessTree(child, 'SIGKILL');
          }, SHELL_KILL_GRACE_MS);
          killEscalationTimer.unref();
        }
      };
      const resolveOnce = (code: number): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(code);
      };
      const rejectOnce = (error: Error): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const onAbort = (): void => {
        if (settled) return;
        terminateTree();
        rejectOnce(new Error('Command cancelled'));
      };
      const timer = setTimeout(() => {
        if (settled) return;
        terminateTree();
        rejectOnce(new Error(`Command timed out after ${timeout}ms`));
      }, timeout);

      child.once('error', (error) => {
        rejectOnce(error);
      });

      child.once('close', (code) => {
        childClosed = true;
        if (killEscalationTimer) clearTimeout(killEscalationTimer);
        resolveOnce(code ?? 0);
      });
      context.abortSignal?.addEventListener('abort', onAbort, { once: true });
      if (context.abortSignal?.aborted) onAbort();
    });

    context.wsBroadcast('shell_exit', { streamId, exitCode });
    return JSON.stringify({ cwd, command, exitCode, stdout, stderr }, null, 2);
  },
};
