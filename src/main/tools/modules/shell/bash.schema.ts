// Schema-only file (P0-7 方案 A — single source of truth)
import type { ToolSchema } from '../../../protocol/tools';

export const bashSchema: ToolSchema = {
  name: 'Bash',
  description: `Executes a bash command. Working directory persists across calls.

Returns: stdout/stderr (combined), exit code if non-zero, signal if terminated, background PIDs if started.

For common file/search operations, dedicated tools are faster and more reliable:
- File listing: Glob (instead of \`find\` / \`ls\`)
- Content search: Grep (instead of \`grep\` / \`rg\`)
- Read files: Read (instead of \`cat\` / \`head\` / \`tail\` / \`sed -n\`)
- Edit files: Edit (instead of \`sed\` / \`awk\`)
- Write files: Write (instead of \`echo >\` / \`cat <<EOF\`)

For everything else — running scripts, git, build/install, invoking any CLI on PATH (jq, ffmpeg, opencli, jina, mineru, pdftotext ...), or probing the environment with \`which\` / \`<cli> --help\` to learn what tools are available — Bash is your tool. When the built-in tools fall short (anti-scraping responses, niche formats, structured data wrangling), fall back to Bash and explore. The <env-capabilities> block in your context lists CLIs already detected locally; if a needed one is missing, \`command -v X\` confirms availability before use.

Git: NEVER \`--force\` push or \`--no-verify\` unless explicitly requested.`,
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
