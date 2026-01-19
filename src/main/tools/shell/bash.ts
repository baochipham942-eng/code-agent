// ============================================================================
// Bash Tool - Execute shell commands
// ============================================================================

import { exec } from 'child_process';
import { promisify } from 'util';
import type { Tool, ToolContext, ToolExecutionResult } from '../ToolRegistry';

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
