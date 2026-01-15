// ============================================================================
// Bash Tool - Execute shell commands
// ============================================================================

import { exec } from 'child_process';
import { promisify } from 'util';
import type { Tool, ToolContext, ToolExecutionResult } from '../ToolRegistry';

const execAsync = promisify(exec);

export const bashTool: Tool = {
  name: 'bash',
  description: 'Execute a shell command in the terminal',
  generations: ['gen1', 'gen2', 'gen3', 'gen4'],
  requiresPermission: true,
  permissionLevel: 'execute',
  inputSchema: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'The command to execute',
      },
      timeout: {
        type: 'number',
        description: 'Timeout in milliseconds (default: 120000)',
      },
      working_directory: {
        type: 'string',
        description: 'Working directory for the command',
      },
    },
    required: ['command'],
  },

  async execute(
    params: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolExecutionResult> {
    const command = params.command as string;
    const timeout = (params.timeout as number) || 120000;
    const workingDirectory =
      (params.working_directory as string) || context.workingDirectory;

    try {
      const { stdout, stderr } = await execAsync(command, {
        timeout,
        cwd: workingDirectory,
        maxBuffer: 10 * 1024 * 1024, // 10MB
        env: {
          ...process.env,
          // Ensure we have a proper PATH
          PATH: process.env.PATH,
        },
      });

      let output = stdout;
      if (stderr) {
        output += `\n[stderr]: ${stderr}`;
      }

      // Truncate if too long
      if (output.length > 30000) {
        output = output.substring(0, 30000) + '\n... (output truncated)';
      }

      return {
        success: true,
        output,
      };
    } catch (error: any) {
      return {
        success: false,
        error: error.message || 'Command execution failed',
        output: error.stdout || undefined,
      };
    }
  },
};
