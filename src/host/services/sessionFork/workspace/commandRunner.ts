import { spawn } from 'node:child_process';
import path from 'node:path';

import type {
  WorkspaceCommand,
  WorkspaceCommandResult,
  WorkspaceCommandRunner,
} from './types';

export class WorkspaceCommandError extends Error {
  constructor(
    public readonly code: string,
    public readonly command: WorkspaceCommand,
    message: string,
    public readonly stderr = '',
  ) {
    super(message);
    this.name = 'WorkspaceCommandError';
  }
}

export class NodeWorkspaceCommandRunner implements WorkspaceCommandRunner {
  async run(command: WorkspaceCommand): Promise<WorkspaceCommandResult> {
    if (command.executable !== 'git') {
      throw new WorkspaceCommandError('EXECUTABLE_NOT_ALLOWED', command, 'only git is allowed');
    }
    if (!path.isAbsolute(command.cwd) || command.cwd.includes('\0')) {
      throw new WorkspaceCommandError('INVALID_COMMAND_CWD', command, 'command cwd must be an absolute path');
    }
    if (command.args.some((argument) => argument.includes('\0'))) {
      throw new WorkspaceCommandError('INVALID_COMMAND_ARGUMENT', command, 'command arguments cannot contain NUL');
    }

    return await new Promise<WorkspaceCommandResult>((resolve, reject) => {
      const child = spawn(command.executable, command.args, {
        cwd: command.cwd,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let settled = false;
      let timedOut = false;
      let forceKillTimeout: NodeJS.Timeout | undefined;
      const timeoutMs = command.timeoutMs ?? 30_000;
      const timeout = setTimeout(() => {
        if (settled) return;
        timedOut = true;
        child.kill('SIGTERM');
        forceKillTimeout = setTimeout(() => child.kill('SIGKILL'), 2_000);
      }, timeoutMs);

      child.stdout.on('data', (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
      child.stderr.on('data', (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
      child.once('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (forceKillTimeout) clearTimeout(forceKillTimeout);
        reject(new WorkspaceCommandError(
          'COMMAND_START_FAILED',
          command,
          error.message,
          Buffer.concat(stderr).toString('utf8'),
        ));
      });
      child.once('close', (exitCode, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (forceKillTimeout) clearTimeout(forceKillTimeout);
        const stderrBuffer = Buffer.concat(stderr);
        if (timedOut) {
          reject(new WorkspaceCommandError(
            'COMMAND_TIMEOUT',
            command,
            `git command timed out after ${timeoutMs}ms`,
            stderrBuffer.toString('utf8'),
          ));
          return;
        }
        if (exitCode !== 0) {
          reject(new WorkspaceCommandError(
            'COMMAND_FAILED',
            command,
            `git exited with ${exitCode ?? signal ?? 'unknown'}`,
            stderrBuffer.toString('utf8'),
          ));
          return;
        }
        resolve({ stdout: Buffer.concat(stdout), stderr: stderrBuffer });
      });

      if (command.input) child.stdin.end(command.input);
      else child.stdin.end();
    });
  }
}
