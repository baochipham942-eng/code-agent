// ============================================================================
// Bash Tool - Execute shell commands with background support
// ============================================================================

import { exec } from 'child_process';
import { promisify } from 'util';
import type { Tool, ToolContext, ToolExecutionResult } from '../toolRegistry';
import { BASH } from '../../../shared/constants';
import { startBackgroundTask } from './backgroundTasks';

const execAsync = promisify(exec);

export const bashTool: Tool = {
  name: 'bash',
  description: `Execute shell commands in a persistent shell session with optional timeout.

IMPORTANT: Use for terminal operations (git, npm, docker, etc.) ONLY.
DO NOT use for file operations - use specialized tools instead:
- File search: Use glob (NOT find or ls)
- Content search: Use grep (NOT grep or rg)
- Read files: Use read_file (NOT cat/head/tail)
- Edit files: Use edit_file (NOT sed/awk)
- Write files: Use write_file (NOT echo/cat with heredoc)

Usage notes:
- Always quote file paths with spaces: cd "/path/with spaces"
- Use absolute paths, avoid cd when possible
- Chain dependent commands with && (e.g., git add . && git commit -m "msg")
- Independent commands can be called in parallel in separate tool calls
- Output is truncated at 30000 characters
- Default timeout is 120 seconds (can be overridden)

Background execution:
- Set run_in_background=true for long-running commands
- Returns a task_id immediately
- Use task_output tool to check status and get output
- Use kill_shell tool to terminate background tasks

Git best practices:
- NEVER use --force push unless explicitly requested
- NEVER skip hooks (--no-verify) unless explicitly requested
- Always check git status before committing`,

  generations: ['gen1', 'gen2', 'gen3', 'gen4', 'gen5', 'gen6', 'gen7', 'gen8'],
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
        description: 'Timeout in milliseconds (default: 120000, max: 600000)',
      },
      working_directory: {
        type: 'string',
        description: 'Working directory for the command',
      },
      run_in_background: {
        type: 'boolean',
        description: 'Run command in background and return immediately with task_id',
      },
      description: {
        type: 'string',
        description: 'Short description of what this command does (for logging)',
      },
    },
    required: ['command'],
  },

  async execute(
    params: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolExecutionResult> {
    const command = params.command as string;
    const timeout = Math.min((params.timeout as number) || BASH.DEFAULT_TIMEOUT, 600000);
    const workingDirectory =
      (params.working_directory as string) || context.workingDirectory;
    const runInBackground = params.run_in_background as boolean;

    // Background execution
    if (runInBackground) {
      const result = startBackgroundTask(command, workingDirectory, timeout);

      if (!result.success) {
        return {
          success: false,
          error: result.error || 'Failed to start background task',
        };
      }

      const output = `Background task started.

<task-id>${result.taskId}</task-id>
<task-type>bash</task-type>
<output-file>${result.outputFile}</output-file>
<status>running</status>
<summary>Command "${command.substring(0, 50)}${command.length > 50 ? '...' : ''}" started in background.</summary>

Use task_output tool with task_id="${result.taskId}" to check status and retrieve output.
Use kill_shell tool with task_id="${result.taskId}" to terminate if needed.`;

      return {
        success: true,
        output,
        metadata: {
          taskId: result.taskId,
          outputFile: result.outputFile,
          background: true,
        },
      };
    }

    // Foreground execution
    try {
      const { stdout, stderr } = await execAsync(command, {
        timeout,
        cwd: workingDirectory,
        maxBuffer: BASH.MAX_BUFFER,
        env: {
          ...process.env,
          PATH: process.env.PATH,
        },
      });

      let output = stdout;
      if (stderr) {
        output += `\n[stderr]: ${stderr}`;
      }

      // Truncate if too long
      if (output.length > BASH.MAX_OUTPUT_LENGTH) {
        output = output.substring(0, BASH.MAX_OUTPUT_LENGTH) + '\n... (output truncated)';
      }

      return {
        success: true,
        output,
      };
    } catch (error: any) {
      // Handle timeout
      if (error.killed && error.signal === 'SIGTERM') {
        return {
          success: false,
          error: `Command timed out after ${timeout / 1000} seconds. Consider using run_in_background=true for long-running commands.`,
          output: error.stdout || undefined,
        };
      }

      return {
        success: false,
        error: error.message || 'Command execution failed',
        output: error.stdout || undefined,
      };
    }
  },
};
