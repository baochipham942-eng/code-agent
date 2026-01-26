// ============================================================================
// BashTool - Execute shell commands (Decorator Version)
// ============================================================================
//
// 这是使用装饰器重构的 bash 工具示例。
//

import { exec } from 'child_process';
import { promisify } from 'util';
import { Tool, Param, Description, type ITool } from '../decorators';
import type { ToolContext, ToolExecutionResult } from '../toolRegistry';
import { BASH } from '../../../shared/constants';

const execAsync = promisify(exec);

// ----------------------------------------------------------------------------
// Tool Definition using Decorators
// ----------------------------------------------------------------------------

@Tool('bash', {
  generations: 'gen1+',  // gen1 及以上所有代际
  permission: 'execute',
})
@Description(`Execute shell commands in a persistent shell session with optional timeout.

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
- Always check git status before committing`)
@Param('command', {
  type: 'string',
  required: true,
  description: 'The command to execute',
})
@Param('timeout', {
  type: 'number',
  required: false,
  description: 'Timeout in milliseconds (default: 120000)',
})
@Param('working_directory', {
  type: 'string',
  required: false,
  description: 'Working directory for the command',
})
export class BashTool implements ITool {
  async execute(
    params: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolExecutionResult> {
    const command = params.command as string;
    const timeout = (params.timeout as number) || BASH.DEFAULT_TIMEOUT;
    const workingDirectory =
      (params.working_directory as string) || context.workingDirectory;

    try {
      const { stdout, stderr } = await execAsync(command, {
        timeout,
        cwd: workingDirectory,
        maxBuffer: BASH.MAX_BUFFER,
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
      if (output.length > BASH.MAX_OUTPUT_LENGTH) {
        output = output.substring(0, BASH.MAX_OUTPUT_LENGTH) + '\n... (output truncated)';
      }

      return {
        success: true,
        output,
      };
    } catch (error: unknown) {
      const execError = error as { message?: string; stdout?: string };
      return {
        success: false,
        error: execError.message || 'Command execution failed',
        output: execError.stdout || undefined,
      };
    }
  }
}
