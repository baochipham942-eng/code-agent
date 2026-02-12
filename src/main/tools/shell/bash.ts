// ============================================================================
// Bash Tool - Execute shell commands with background and PTY support
// ============================================================================

import { exec } from 'child_process';
import { promisify } from 'util';
import type { Tool, ToolContext, ToolExecutionResult } from '../toolRegistry';
import { BASH } from '../../../shared/constants';
import { startBackgroundTask } from './backgroundTasks';
import { createPtySession, getPtySessionOutput } from './ptyExecutor';
import { generateBashDescription } from './dynamicDescription';
import { getShellPath } from '../../services/infra/shellEnvironment';
import { extractBashFacts, dataFingerprintStore } from '../dataFingerprint';

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

PTY mode (for interactive commands):
- Set pty=true for commands that require terminal emulation (vim, ssh, etc.)
- PTY sessions support interactive input via process_write/process_submit tools
- Use for commands that need ANSI escape sequences or terminal features

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

  async execute(
    params: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolExecutionResult> {
    let command = params.command as string;

    // Self-referential tool call: model passes bash({"command":"actual_cmd"}) as the command
    // This happens when model outputs the tool call JSON as the command string itself
    const selfRefMatch = command.match(/^\s*bash\s*\(\s*([\s\S]*)\s*\)\s*$/);
    if (selfRefMatch) {
      const inner = selfRefMatch[1].trim();
      if (inner.startsWith('{')) {
        // JSON format: bash({"command": "python3 xxx", ...})
        try {
          const parsed = JSON.parse(inner);
          if (parsed.command && typeof parsed.command === 'string') {
            command = parsed.command;
          }
        } catch { /* not valid JSON, keep original */ }
      } else {
        // Keyword format: bash(command="python3 xxx")
        const kwMatch = inner.match(/^command\s*=\s*["'](.+?)["']/s);
        if (kwMatch) {
          command = kwMatch[1];
        }
      }
    }

    const timeout = Math.min((params.timeout as number) || BASH.DEFAULT_TIMEOUT, 600000);
    const workingDirectory =
      (params.working_directory as string) || context.workingDirectory;
    const runInBackground = params.run_in_background as boolean;
    const usePty = params.pty as boolean;
    const cols = (params.cols as number) || 80;
    const rows = (params.rows as number) || 24;
    const waitForCompletion = params.wait_for_completion as boolean;

    // PTY execution
    if (usePty) {
      const result = createPtySession({
        command,
        cwd: workingDirectory,
        cols,
        rows,
        maxRuntime: timeout,
      });

      if (!result.success) {
        return {
          success: false,
          error: result.error || 'Failed to create PTY session',
        };
      }

      // If waiting for completion, block until done
      if (waitForCompletion) {
        const output = await getPtySessionOutput(result.sessionId!, true, timeout);
        if (!output) {
          return {
            success: false,
            error: 'PTY session ended unexpectedly',
          };
        }

        let outputText = output.output;
        if (outputText.length > BASH.MAX_OUTPUT_LENGTH) {
          outputText = outputText.substring(0, BASH.MAX_OUTPUT_LENGTH) + '\n... (output truncated)';
        }

        return {
          success: output.status === 'completed',
          output: outputText,
          error: output.status === 'failed' ? `Command exited with code ${output.exitCode}` : undefined,
          metadata: {
            sessionId: result.sessionId,
            exitCode: output.exitCode,
            duration: output.duration,
            pty: true,
          },
        };
      }

      // Return session info for interactive use
      const output = `PTY session started.

<session-id>${result.sessionId}</session-id>
<session-type>pty</session-type>
<output-file>${result.outputFile}</output-file>
<status>running</status>
<terminal-size>${cols}x${rows}</terminal-size>
<summary>PTY session for "${command.substring(0, 50)}${command.length > 50 ? '...' : ''}" started.</summary>

Use process_write/process_submit to send input to this session.
Use process_poll to check for new output.
Use process_kill to terminate the session.`;

      return {
        success: true,
        output,
        metadata: {
          sessionId: result.sessionId,
          outputFile: result.outputFile,
          pty: true,
          cols,
          rows,
        },
      };
    }

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

    // Tool confusion pre-check: detect tool calls passed as bash commands
    // e.g. bash(command="write_file({...})") or bash(command="edit_file({...})")
    const toolConfusionMatch = command.match(/^\s*(write_file|edit_file|read_file|read_xlsx|glob|grep)\s*\(/);
    if (toolConfusionMatch) {
      const toolName = toolConfusionMatch[1];
      return {
        success: false,
        error: `❌ 工具混淆: "${toolName}(...)" 不是 shell 命令。请直接使用 ${toolName} 工具，而不是在 bash 中调用。\n\n` +
          `正确用法: 调用 ${toolName} 工具并传入 JSON 参数\n` +
          `错误用法: bash(command="${toolName}({...})")`,
      };
    }

    // Heredoc truncation pre-check: detect empty/truncated heredocs
    // Model generates long Python scripts as heredocs, but maxTokens truncation
    // causes the body to be missing, resulting in empty scripts that succeed but produce nothing
    const heredocMatch = command.match(/<<-?\s*['"]?(\w+)['"]?\s*$/m);
    if (heredocMatch) {
      const delimiter = heredocMatch[1];
      const delimiterPattern = new RegExp(`^${delimiter}\\s*$`, 'm');
      const bodyStartIdx = command.indexOf('\n', heredocMatch.index!);
      if (bodyStartIdx < 0) {
        // No body at all — just the heredoc opener
        return {
          success: false,
          error: `❌ heredoc 不完整: 缺少脚本内容和结束符 ${delimiter}。\n` +
            `请改用 write_file 将脚本写入文件，然后用 bash 执行: python3 <文件路径>`,
        };
      }
      const body = command.substring(bodyStartIdx + 1);
      const delimMatch = body.match(delimiterPattern);
      const bodyContent = delimMatch ? body.substring(0, delimMatch.index!) : body;
      if (bodyContent.trim().length < 20) {
        return {
          success: false,
          error: `❌ heredoc 内容被截断（仅 ${bodyContent.trim().length} 字符）。\n` +
            `长脚本请改用 write_file 写入文件，然后用 bash 执行: python3 <文件路径>`,
        };
      }
    }

    // Foreground execution
    try {
      // 并行：生成动态描述（不阻塞命令执行）
      const descriptionPromise = generateBashDescription(command).catch(() => null);

      const { stdout, stderr } = await execAsync(command, {
        timeout,
        cwd: workingDirectory,
        maxBuffer: BASH.MAX_BUFFER,
        env: {
          ...process.env,
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

      const dynamicDesc = await descriptionPromise;

      // 源数据锚定：从 bash 输出中提取关键事实
      const bashFact = extractBashFacts(command, output);
      if (bashFact) {
        dataFingerprintStore.recordFact(bashFact);
      }

      // 上下文增强：输出头部附加 cwd，引导模型使用绝对路径
      const cwdPrefix = `[cwd: ${workingDirectory}]\n`;

      return {
        success: true,
        output: cwdPrefix + output,
        metadata: dynamicDesc ? { description: dynamicDesc } : undefined,
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
