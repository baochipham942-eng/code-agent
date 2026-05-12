// ============================================================================
// Bash (P0-6.3 Batch 2a — shell: native ToolModule rewrite)
//
// 旧版: src/main/tools/shell/bash.ts (legacy Tool + wrapLegacyTool)
// 改造点：
// - 4 参数签名 (args, ctx, canUseTool, onProgress)
// - inline canUseTool 闸门 + onProgress 事件
// - 走 ctx.logger（不 import services/infra/logger）
// - 行为保真（对齐 legacy bash.ts 所有分支）：
//   * self-referential bash(...) 调用解包（JSON / keyword）
//   * tool-confusion 预检（write_file/edit_file/... 不允许在 bash 里执行）
//   * heredoc 截断预检
//   * PTY 模式（usePty: createPtySession + optional waitForCompletion）
//   * 后台任务（run_in_background: startBackgroundTask，返回 task_id）
//   * Codex 沙箱路由（启用且非安全命令则委托）
//   * 前台 spawn：spawn + getShellPath + sanitizedEnv
//   * 输出截断（MAX_OUTPUT_LENGTH truncateMiddle + guidance 文本）
//   * stderr 合并 + dataFingerprintStore 指纹提取
//   * cwd 前缀 + dynamicDescription metadata
//   * 超时 / 非零退出 / spawn error 分类错误
// - meta 字段（taskId / sessionId / background / pty / codexThreadId / description 等）放 meta
// ============================================================================

import { spawn } from 'child_process';
import type {
  ToolHandler,
  ToolModule,
  ToolContext,
  CanUseToolFn,
  ToolProgressFn,
  ToolResult,
} from '../../../protocol/tools';
import { bashSchema as schema } from './bash.schema';
import { BASH } from '../../../../shared/constants';
import { startBackgroundTask } from '../../shell/backgroundTasks';
import { createPtySession, getPtySessionOutput } from '../../shell/ptyExecutor';
import { generateBashDescription } from '../../shell/dynamicDescription';
import { getShellPathDiagnostics } from '../../../services/infra/shellEnvironment';
import { extractBashFacts, dataFingerprintStore } from '../../dataFingerprint';
import { createFileArtifact, createVirtualArtifact } from '../../artifacts/artifactMeta';
import { createSanitizedEnv } from '../../../utils/sanitizeEnv';
import { truncateMiddle } from '../../../utils/truncate';
import { checkCommandPolicy } from './commandPolicy';

const MAX_TIMEOUT_MS = BASH.MAX_TIMEOUT;
const BACKGROUND_TRAILING_OPERATOR = /(?:^|[;\n])\s*([^;&|\n][\s\S]*?)\s*&\s*$/;
const MAX_LIVE_OUTPUT_DELTA_LENGTH = 2_000;

/**
 * 解包 self-referential 工具调用：
 *  - bash({"command": "actual_cmd"})  → "actual_cmd"
 *  - bash(command="actual_cmd")       → "actual_cmd"
 * 当模型把工具调用字串当成 bash command 时的防御性修正。
 */
function unwrapSelfReference(command: string): string {
  const selfRefMatch = command.match(/^\s*bash\s*\(\s*([\s\S]*)\s*\)\s*$/);
  if (!selfRefMatch) return command;
  const inner = selfRefMatch[1].trim();
  if (inner.startsWith('{')) {
    try {
      const parsed = JSON.parse(inner);
      if (parsed.command && typeof parsed.command === 'string') {
        return parsed.command;
      }
    } catch {
      /* not valid JSON, keep original */
    }
    return command;
  }
  const kwMatch = inner.match(/^command\s*=\s*["'](.+?)["']/s);
  if (kwMatch) return kwMatch[1];
  return command;
}

/** 检测模型把别的工具调用当成 bash 命令传入 */
function detectToolConfusion(command: string): string | null {
  const m = command.match(/^\s*(write_file|edit_file|read_file|read_xlsx|glob|grep)\s*\(/);
  return m ? m[1] : null;
}

/** heredoc 完整性预检：空 body 或 <20 字符视为被截断 */
function detectHeredocTruncation(command: string): { ok: true } | { ok: false; reason: string } {
  const heredocMatch = command.match(/<<-?\s*['"]?(\w+)['"]?\s*$/m);
  if (!heredocMatch) return { ok: true };
  const delimiter = heredocMatch[1];
  const delimiterPattern = new RegExp(`^${delimiter}\\s*$`, 'm');
  const bodyStartIdx = command.indexOf('\n', heredocMatch.index!);
  if (bodyStartIdx < 0) {
    return {
      ok: false,
      reason:
        `❌ heredoc 不完整: 缺少脚本内容和结束符 ${delimiter}。\n` +
        `请改用 write_file 将脚本写入文件，然后用 bash 执行: python3 <文件路径>`,
    };
  }
  const body = command.substring(bodyStartIdx + 1);
  const delimMatch = body.match(delimiterPattern);
  const bodyContent = delimMatch ? body.substring(0, delimMatch.index!) : body;
  if (bodyContent.trim().length < 20) {
    return {
      ok: false,
      reason:
        `❌ heredoc 内容被截断（仅 ${bodyContent.trim().length} 字符）。\n` +
        `长脚本请改用 write_file 写入文件，然后用 bash 执行: python3 <文件路径>`,
    };
  }
  return { ok: true };
}

/** 添加 guidance 文本的输出截断 */
function truncateOutput(output: string): string {
  if (output.length <= BASH.MAX_OUTPUT_LENGTH) return output;
  const originalLength = output.length;
  const truncated = truncateMiddle(output, BASH.MAX_OUTPUT_LENGTH);
  return (
    truncated +
    `\n\n[Guidance: Output was ${originalLength} chars, truncated to ${BASH.MAX_OUTPUT_LENGTH}. ` +
    `Use Read tool with offset/limit to read specific sections, or use Edit tool to make targeted changes without reading the entire file.]`
  );
}

class BashForegroundExecutionError extends Error {
  stdout: string;
  stderr: string;
  killed?: boolean;
  signal?: NodeJS.Signals;
  code?: number | string | null;

  constructor(
    message: string,
    details: {
      stdout?: string;
      stderr?: string;
      killed?: boolean;
      signal?: NodeJS.Signals;
      code?: number | string | null;
      name?: string;
    } = {},
  ) {
    super(message);
    this.name = details.name || 'BashForegroundExecutionError';
    this.stdout = details.stdout || '';
    this.stderr = details.stderr || '';
    this.killed = details.killed;
    this.signal = details.signal;
    this.code = details.code;
  }
}

function emitToolOutputDelta(
  ctx: ToolContext,
  stream: 'stdout' | 'stderr',
  content: string,
  startedAt: number,
): void {
  if (!ctx.currentToolCallId || !content) return;

  const truncated = content.length > MAX_LIVE_OUTPUT_DELTA_LENGTH;
  const liveContent = truncated ? content.slice(-MAX_LIVE_OUTPUT_DELTA_LENGTH) : content;
  ctx.emit({
    type: 'tool_output_delta',
    data: {
      toolCallId: ctx.currentToolCallId,
      toolName: schema.name,
      stream,
      content: liveContent,
      elapsedMs: Date.now() - startedAt,
      ...(truncated ? { truncated: true } : {}),
    },
  });
}

function runForegroundCommand(options: {
  command: string;
  cwd: string;
  timeout: number;
  env: NodeJS.ProcessEnv;
  abortSignal: AbortSignal;
  ctx: ToolContext;
  startedAt: number;
}): Promise<{ stdout: string; stderr: string }> {
  const {
    command,
    cwd,
    timeout,
    env,
    abortSignal,
    ctx,
    startedAt,
  } = options;

  return new Promise((resolve, reject) => {
    if (abortSignal.aborted) {
      reject(new BashForegroundExecutionError('aborted', { code: 'ABORT_ERR', name: 'AbortError' }));
      return;
    }

    const child = spawn(command, {
      cwd,
      env,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let maxBufferExceeded = false;
    let aborted = false;

    const cleanup = () => {
      clearTimeout(timeoutTimer);
      abortSignal.removeEventListener('abort', abortHandler);
    };

    const rejectOnce = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    const killChild = () => {
      try {
        child.kill('SIGTERM');
      } catch {
        // Child may have already exited.
      }
    };

    const abortHandler = () => {
      aborted = true;
      killChild();
    };

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      killChild();
    }, timeout);

    abortSignal.addEventListener('abort', abortHandler, { once: true });

    const appendOutput = (stream: 'stdout' | 'stderr', chunk: Buffer | string) => {
      const text = chunk.toString();
      if (stream === 'stdout') {
        stdout += text;
      } else {
        stderr += text;
      }
      emitToolOutputDelta(ctx, stream, text, startedAt);

      if (stdout.length + stderr.length > BASH.MAX_BUFFER && !maxBufferExceeded) {
        maxBufferExceeded = true;
        killChild();
      }
    };

    child.stdout?.on('data', (chunk: Buffer | string) => appendOutput('stdout', chunk));
    child.stderr?.on('data', (chunk: Buffer | string) => appendOutput('stderr', chunk));

    child.on('error', (error) => {
      rejectOnce(error);
    });

    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      cleanup();

      if (aborted) {
        reject(new BashForegroundExecutionError('aborted', {
          stdout,
          stderr,
          code: 'ABORT_ERR',
          name: 'AbortError',
        }));
        return;
      }

      if (timedOut) {
        reject(new BashForegroundExecutionError(`Command timed out after ${timeout / 1000} seconds`, {
          stdout,
          stderr,
          killed: true,
          signal: 'SIGTERM',
          code,
        }));
        return;
      }

      if (maxBufferExceeded) {
        reject(new BashForegroundExecutionError(`stdout maxBuffer length exceeded (${BASH.MAX_BUFFER})`, {
          stdout,
          stderr,
          killed: true,
          signal: signal || 'SIGTERM',
          code,
        }));
        return;
      }

      if (code && code !== 0) {
        reject(new BashForegroundExecutionError(`Command failed with exit code ${code}`, {
          stdout,
          stderr,
          code,
          ...(signal ? { signal } : {}),
        }));
        return;
      }

      resolve({ stdout, stderr });
    });
  });
}

export function rewriteImplicitBackgroundCommand(command: string): { command: string; rewritten: boolean } {
  const trimmed = command.trim();
  const match = trimmed.match(BACKGROUND_TRAILING_OPERATOR);
  if (!match) {
    return { command, rewritten: false };
  }

  const candidate = match[1]?.trim();
  if (!candidate) {
    return { command, rewritten: false };
  }

  return {
    command: candidate,
    rewritten: true,
  };
}

interface BashMeta extends Record<string, unknown> {
  taskId?: string;
  sessionId?: string;
  outputFile?: string;
  background?: boolean;
  pty?: boolean;
  cols?: number;
  rows?: number;
  exitCode?: number;
  duration?: number;
  description?: string;
  codexThreadId?: string;
  shellPath?: {
    source: string;
    pathEntryCount: number;
    degraded: boolean;
    fallbackApplied: boolean;
    fallbackEntries: string[];
  };
}

class BashHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;

  async execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<string>> {
    const rawCommand = args.command;
    if (typeof rawCommand !== 'string') {
      return { ok: false, error: 'command must be a string', code: 'INVALID_ARGS' };
    }

    const permit = await canUseTool(schema.name, args);
    if (!permit.allow) {
      return { ok: false, error: `permission denied: ${permit.reason}`, code: 'PERMISSION_DENIED' };
    }
    if (ctx.abortSignal.aborted) {
      return { ok: false, error: 'aborted', code: 'ABORTED' };
    }

    const command = unwrapSelfReference(rawCommand);
    const timeout = Math.min((args.timeout as number) || BASH.DEFAULT_TIMEOUT, MAX_TIMEOUT_MS);
    const workingDirectory = (args.working_directory as string) || ctx.workingDir;
    const implicitBackground = rewriteImplicitBackgroundCommand(command);
    const normalizedCommand = implicitBackground.command;
    const runInBackground = (args.run_in_background as boolean | undefined) ?? implicitBackground.rewritten;
    const usePty = args.pty as boolean | undefined;
    const cols = (args.cols as number) || 80;
    const rows = (args.rows as number) || 24;
    const waitForCompletion = args.wait_for_completion as boolean | undefined;

    onProgress?.({ stage: 'starting', detail: `exec: ${normalizedCommand.slice(0, 60)}` });

    // -------------------------------------------------------------------------
    // PTY 执行
    // -------------------------------------------------------------------------
    if (usePty) {
      const result = createPtySession({
        command: normalizedCommand,
        cwd: workingDirectory,
        cols,
        rows,
        maxRuntime: timeout,
      });

      if (!result.success) {
        return {
          ok: false,
          error: result.error || 'Failed to create PTY session',
          code: 'FS_ERROR',
        };
      }

      if (waitForCompletion) {
        const output = await getPtySessionOutput(result.sessionId!, true, timeout);
        if (!output) {
          return {
            ok: false,
            error: 'PTY session ended unexpectedly',
            code: 'FS_ERROR',
          };
        }

        const outputText = truncateOutput(output.output);
        const meta: BashMeta = {
          sessionId: result.sessionId,
          exitCode: output.exitCode,
          duration: output.duration,
          pty: true,
        };

        if (output.status === 'completed') {
          onProgress?.({ stage: 'completing', percent: 100 });
          return { ok: true, output: outputText, meta };
        }
        return {
          ok: false,
          error: `Command exited with code ${output.exitCode}`,
          code: 'FS_ERROR',
          meta: { ...meta, output: outputText },
        };
      }

      const msg = `PTY session started.

<session-id>${result.sessionId}</session-id>
<session-type>pty</session-type>
<output-file>${result.outputFile}</output-file>
<status>running</status>
<terminal-size>${cols}x${rows}</terminal-size>
<summary>PTY session for "${normalizedCommand.substring(0, 50)}${normalizedCommand.length > 50 ? '...' : ''}" started.</summary>

Use process_write/process_submit to send input to this session.
Use process_poll to check for new output.
Use process_kill to terminate the session.`;

      onProgress?.({ stage: 'completing', percent: 100 });
      return {
        ok: true,
        output: msg,
        meta: {
          sessionId: result.sessionId,
          outputFile: result.outputFile,
          artifact: result.outputFile
            ? await createFileArtifact(result.outputFile, schema.name, ctx, { kind: 'process-log', mimeType: 'text/plain' })
            : undefined,
          pty: true,
          cols,
          rows,
        },
      };
    }

    // -------------------------------------------------------------------------
    // 后台任务
    // -------------------------------------------------------------------------
    if (runInBackground) {
      const result = startBackgroundTask(normalizedCommand, workingDirectory, timeout);
      if (!result.success) {
        return {
          ok: false,
          error: result.error || 'Failed to start background task',
          code: 'FS_ERROR',
        };
      }

      const msg = `Background task started.

<task-id>${result.taskId}</task-id>
<task-type>bash</task-type>
<output-file>${result.outputFile}</output-file>
<status>running</status>
<summary>Command "${normalizedCommand.substring(0, 50)}${normalizedCommand.length > 50 ? '...' : ''}" started in background.</summary>

Use task_output tool with task_id="${result.taskId}" to check status and retrieve output.
Use kill_shell tool with task_id="${result.taskId}" to terminate if needed.`;

      onProgress?.({ stage: 'completing', percent: 100 });
      return {
        ok: true,
        output: msg,
        meta: {
          taskId: result.taskId,
          outputFile: result.outputFile,
          artifact: result.outputFile
            ? await createFileArtifact(result.outputFile, schema.name, ctx, { kind: 'process-log', mimeType: 'text/plain' })
            : undefined,
          background: true,
        },
      };
    }

    // -------------------------------------------------------------------------
    // 工具混淆预检
    // -------------------------------------------------------------------------
    const confusedTool = detectToolConfusion(normalizedCommand);
    if (confusedTool) {
      return {
        ok: false,
        error:
          `❌ 工具混淆: "${confusedTool}(...)" 不是 shell 命令。请直接使用 ${confusedTool} 工具，而不是在 bash 中调用。\n\n` +
          `正确用法: 调用 ${confusedTool} 工具并传入 JSON 参数\n` +
          `错误用法: bash(command="${confusedTool}({...})")`,
        code: 'INVALID_ARGS',
      };
    }

    // -------------------------------------------------------------------------
    // heredoc 截断预检
    // -------------------------------------------------------------------------
    const heredocCheck = detectHeredocTruncation(normalizedCommand);
    if (!heredocCheck.ok) {
      return { ok: false, error: heredocCheck.reason, code: 'INVALID_ARGS' };
    }

    // -------------------------------------------------------------------------
    // 命令策略硬阻断（BLOCK 档：永远不该执行的危险模式）
    // CONFIRM 档由 agent/confirmationGate.ts 在工具调用层处理
    // -------------------------------------------------------------------------
    const policyDecision = checkCommandPolicy(normalizedCommand);
    if (!policyDecision.allowed) {
      return {
        ok: false,
        error: `命令被策略拒绝：${policyDecision.reason}`,
        code: 'POLICY_DENIED',
      };
    }

    // -------------------------------------------------------------------------
    // 前台 spawn
    // -------------------------------------------------------------------------
    const shellPathDiagnostics = getShellPathDiagnostics();
    const shellPathMeta = {
      source: shellPathDiagnostics.source,
      pathEntryCount: shellPathDiagnostics.pathEntryCount,
      degraded: shellPathDiagnostics.degraded,
      fallbackApplied: shellPathDiagnostics.fallbackApplied,
      fallbackEntries: shellPathDiagnostics.fallbackEntries,
    };

    try {
      // 并行：生成动态描述（不阻塞命令执行）
      const descriptionPromise = generateBashDescription(normalizedCommand).catch(() => null);

      const startedAt = Date.now();
      const { stdout, stderr } = await runForegroundCommand({
        command: normalizedCommand,
        cwd: workingDirectory,
        timeout,
        abortSignal: ctx.abortSignal,
        ctx,
        startedAt,
        env: createSanitizedEnv({
          PATH: shellPathDiagnostics.path,
        }),
      });

      let output = stdout;
      if (stderr) {
        output += `\n[stderr]: ${stderr}`;
      }
      output = truncateOutput(output);

      const dynamicDesc = await descriptionPromise;

      // 源数据锚定：从 bash 输出中提取关键事实
      const bashFact = extractBashFacts(normalizedCommand, output);
      if (bashFact) {
        dataFingerprintStore.recordFact(bashFact);
      }

      const cwdPrefix = `[cwd: ${workingDirectory}]\n`;

      onProgress?.({ stage: 'completing', percent: 100 });
      ctx.logger.debug('Bash done', { command: normalizedCommand.slice(0, 80), hasStderr: !!stderr });

      return {
        ok: true,
        output: cwdPrefix + output,
        meta: {
          ...(dynamicDesc ? { description: dynamicDesc } : {}),
          process: {
            command: normalizedCommand,
            cwd: workingDirectory,
            background: false,
            pty: false,
          },
          shellPath: shellPathMeta,
          artifact: createVirtualArtifact({
            sourceTool: schema.name,
            kind: 'process-output',
            sessionId: ctx.sessionId,
            name: 'Bash output',
            mimeType: 'text/plain',
            contentLength: output.length,
            preview: output.slice(0, 500),
            metadata: { cwd: workingDirectory, command: normalizedCommand.slice(0, 200) },
          }),
        },
      };
    } catch (error: unknown) {
      const errObj = (error ?? {}) as Record<string, unknown>;
      const errMsg = error instanceof Error ? error.message : String(error);

      // 合并 stdout + stderr，确保 traceback 等错误信息对模型可见
      let errorOutput = String(errObj.stdout || '');
      if (errObj.stderr) {
        errorOutput += (errorOutput ? '\n' : '') + `[stderr]: ${String(errObj.stderr)}`;
      }

      // 超时：child_process 超时会 killed + SIGTERM
      if (ctx.abortSignal.aborted || errObj.name === 'AbortError' || errObj.code === 'ABORT_ERR') {
        return {
          ok: false,
          error: 'aborted',
          code: 'ABORTED',
          meta: { ...(errorOutput ? { output: errorOutput } : {}), shellPath: shellPathMeta },
        };
      }

      if (errObj.killed && errObj.signal === 'SIGTERM') {
        return {
          ok: false,
          error: `Command timed out after ${timeout / 1000} seconds. Consider using run_in_background=true for long-running commands.`,
          code: 'TIMEOUT',
          meta: { ...(errorOutput ? { output: errorOutput } : {}), shellPath: shellPathMeta },
        };
      }

      return {
        ok: false,
        error: errMsg || 'Command execution failed',
        code: 'FS_ERROR',
        meta: { ...(errorOutput ? { output: errorOutput } : {}), shellPath: shellPathMeta },
      };
    }
  }
}

export const bashModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new BashHandler();
  },
};
