// ============================================================================
// Bash Tool (Decorator Version) - Execute shell commands
// ============================================================================

import { exec } from 'child_process';
import { promisify } from 'util';
import { Tool, Param, Description, type ITool, buildToolFromClass } from '../decorators';
import type { ToolContext, ToolExecutionResult } from '../types';
import { BASH } from '../../../shared/constants';
import { getShellPath } from '../../services/infra/shellEnvironment';

const execAsync = promisify(exec);

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
@Tool('bash', { permission: 'execute' })
@Param('command', { type: 'string', required: true, description: 'The command to execute' })
@Param('timeout', { type: 'number', required: false, description: 'Timeout in milliseconds (default: 120000)' })
@Param('working_directory', { type: 'string', required: false, description: 'Working directory for the command' })
class BashToolDecorated implements ITool {
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
          // Use shell-captured PATH for Electron Finder launch compatibility
          PATH: getShellPath(),
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
      const errMsg = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        error: errMsg || 'Command execution failed',
        output: ((error as Record<string, unknown>).stdout as string | undefined) || undefined,
      };
    }
  }
}

// 导出构建后的工具
export const bashToolDecorated = buildToolFromClass(BashToolDecorated);
