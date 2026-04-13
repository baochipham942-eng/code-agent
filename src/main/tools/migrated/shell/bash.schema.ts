// Schema-only file (P0-7 方案 A — single source of truth)
import type { ToolSchema } from '../../../protocol/tools';

export const bashSchema: ToolSchema = {
  name: 'Bash',
  description: `Executes a bash command and returns its output. Use for system commands, running scripts, git operations, and terminal tasks. Working directory persists between calls.

IMPORTANT: Avoid using this tool to run \`find\`, \`grep\`, \`cat\`, \`head\`, \`tail\`, \`sed\`, \`awk\`, or \`echo\` commands. Instead, use the appropriate dedicated tool as this will be much faster and more reliable:
- File search: Use Glob (NOT find or ls)
- Content search: Use Grep (NOT grep or rg)
- Read files: Use Read (NOT cat/head/tail/sed -n/awk/python3 file reads)
- Edit files: Use Edit (NOT sed/awk)
- Write files: Use Write (NOT echo >/cat <<EOF)

Reserve Bash exclusively for: running scripts, git commands, installing packages, compilation, and other system operations that genuinely require shell execution. If you are unsure, default to the dedicated tool.

Git: NEVER --force push or --no-verify unless explicitly requested.`,
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
      pty: {
        type: 'boolean',
        description: 'Use PTY (pseudo-terminal) for interactive commands like vim, ssh, etc.',
      },
      cols: {
        type: 'number',
        description: 'Terminal columns for PTY mode (default: 80)',
      },
      rows: {
        type: 'number',
        description: 'Terminal rows for PTY mode (default: 24)',
      },
      wait_for_completion: {
        type: 'boolean',
        description: 'For PTY mode: wait for command to complete before returning (default: false)',
      },
      description: {
        type: 'string',
        description: 'Short description of what this command does (for logging)',
      },
    },
    required: ['command'],
  },
  category: 'shell',
  permissionLevel: 'execute',
  readOnly: false,
  allowInPlanMode: false,
};
