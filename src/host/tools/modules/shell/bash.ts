// ============================================================================
// Bash (P0-6.3 Batch 2a — shell: native ToolModule rewrite)
//
// 旧版: src/host/tools/shell/bash.ts (legacy Tool + wrapLegacyTool)
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
//   * 输出截断（MAX_OUTPUT_LENGTH truncateMiddleErrorAware + guidance 文本）
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
import { BASH, OS_SANDBOX } from '../../../../shared/constants';
import { startBackgroundTask } from '../../shell/backgroundTasks';
import { spawnWindowsShell, killProcessTree } from '../../shell/platformShell';
import { createPtySession, getPtySessionOutput } from '../../shell/ptyExecutor';
import { generateBashDescription } from '../../shell/dynamicDescription';
import { getShellPathDiagnostics } from '../../../services/infra/shellEnvironment';
import { extractBashFacts, dataFingerprintStore } from '../../dataFingerprint';
import { createFileArtifact, createVirtualArtifact } from '../../artifacts/artifactMeta';
import { createSanitizedEnv } from '../../../utils/sanitizeEnv';
import { truncateMiddleErrorAware } from '../../../utils/truncate';
import { spillToolResultArchive, buildSpillNotice } from '../../../utils/toolResultSpill';
import { checkCommandPolicy } from './commandPolicy';
import { rewriteBashCommand } from './rtkRewriter';
import { getPermissionModeManager } from '../../../permissions/modes';
import { wrapCommandForSandbox } from '../../../sandbox';

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
  const inner = selfRefMatch[1]?.trim() ?? '';
  if (inner.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(inner);
      const parsedCommand = parsed && typeof parsed === 'object' && 'command' in parsed
        ? (parsed as { command?: unknown }).command
        : undefined;
      if (typeof parsedCommand === 'string') {
        return parsedCommand;
      }
    } catch {
      /* not valid JSON, keep original */
    }
    return command;
  }
  const kwCommand = inner.match(/^command\s*=\s*["'](.+?)["']/s)?.[1];
  if (kwCommand !== undefined) return kwCommand;
  return command;
}

/**
 * 检测"用代码画图/出图"的命令（设计画布会话硬控用）。大小写不敏感。
 * 仅在 ctx.executionIntent.designCanvasActive===true 时作为拦截判据使用；
 * 普通会话不调用本函数 → 零影响。匹配 dogfood 实测的逃生路径：
 *   - python 图形库（PIL/Pillow/cairosvg/reportlab/matplotlib/...）
 *   - pip 安装图形库
 *   - imagemagick（magick / convert / mogrify 且带图片扩展名）
 *   - 把命令输出重定向写成图片文件（> out.png）
 */
const CODE_IMAGE_PYTHON_LIB = /\b(PIL|Pillow|cairosvg|reportlab|matplotlib|svgwrite|wand|cairo)\b/i;
const CODE_IMAGE_PIP_INSTALL = /\bpip[0-9]*\s+install\b[^\n]*\b(pillow|reportlab|cairosvg|matplotlib|wand|svgwrite)\b/i;
const CODE_IMAGE_MAGICK = /\bmagick\b/i;
const CODE_IMAGE_CONVERT = /\b(convert|mogrify)\b[^\n]*\.(png|jpe?g|gif|webp|bmp|tiff|svg)\b/i;
const CODE_IMAGE_REDIRECT = />\s*\S+\.(png|jpe?g|gif|webp|bmp|tiff|svg)\b/i;

export function looksLikeCodeImageGeneration(command: string): boolean {
  if (!command) return false;
  return (
    CODE_IMAGE_PYTHON_LIB.test(command) ||
    CODE_IMAGE_PIP_INSTALL.test(command) ||
    CODE_IMAGE_MAGICK.test(command) ||
    CODE_IMAGE_CONVERT.test(command) ||
    CODE_IMAGE_REDIRECT.test(command)
  );
}

const DESIGN_CANVAS_REDIRECT_MESSAGE =
  '[设计画布会话] 当前在设计画布会话中：生成/绘制图片必须用 proposeCanvasOps 工具在画布上提议生成（用户审批后由画布出图），不要用 Python/Pillow/imagemagick 等代码方式画图。如确需用代码处理图像，请切到「通用」模式后再试。';

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
  const bodyStartIdx = command.indexOf('\n', heredocMatch.index ?? 0);
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
  const bodyContent = delimMatch ? body.substring(0, delimMatch.index ?? 0) : body;
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

/** 添加 guidance 文本的输出截断；超阈值时先落盘完整输出（GAP-009） */
function truncateOutput(
  output: string,
  spillCtx?: { sessionId?: string; toolCallId?: string },
): string {
  if (output.length <= BASH.MAX_OUTPUT_LENGTH) return output;
  const originalLength = output.length;
  // 截断前落盘完整输出，模型可用 Read/Grep 回查而不必重跑命令
  const spillResult = spillToolResultArchive({
    content: output,
    toolName: schema.name,
    sessionId: spillCtx?.sessionId,
    toolCallId: spillCtx?.toolCallId,
    reason: 'bash-output-limit',
  });
  const truncated = truncateMiddleErrorAware(output, BASH.MAX_OUTPUT_LENGTH);
  return (
    truncated +
    `\n\n[Guidance: Output was ${originalLength} chars, truncated to ${BASH.MAX_OUTPUT_LENGTH}. ` +
    `Use Read tool with offset/limit to read specific sections, or use Edit tool to make targeted changes without reading the entire file.]` +
    (spillResult ? buildSpillNotice(spillResult.archiveRef) : '')
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

    // detached: 让 shell 成为独立进程组组长(pgid === pid)，超时/abort 时可整组 kill，
    // 回收命令里被 `&` 后台化的子/孙进程；否则只杀直接子进程，孤儿后台进程会泄漏。
    // win32 无进程组/bash，PowerShell 执行 + taskkill /T 收树（platformShell）。
    const child = process.platform === 'win32'
      ? spawnWindowsShell(command, { cwd, env })
      : spawn(command, {
          cwd,
          env,
          shell: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: true,
        });
    // 被后台化、存活更久的子进程不应钉住本进程事件循环(settle 时还会 destroy 管道)。
    child.unref();

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let maxBufferExceeded = false;
    let aborted = false;
    let exited = false;
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    let postExitTimer: NodeJS.Timeout | undefined;

    const cleanup = () => {
      clearTimeout(timeoutTimer);
      if (postExitTimer) clearTimeout(postExitTimer);
      abortSignal.removeEventListener('abort', abortHandler);
    };

    // 整组发信号：POSIX detached 下 child.pid 即组长，-pid 命中组内全部(含被后台化的
    // 孙进程)，组不存在(进程已退)时回退到直接子进程；win32 走 taskkill /T 收树。
    const killGroup = (signal: NodeJS.Signals) => {
      killProcessTree(child, signal, { posixGroupKill: true });
    };

    const killChild = () => {
      killGroup('SIGTERM');
      // 宽限后整组仍存活则升级 SIGKILL，确保挂死命令及其后台子进程被回收。
      const escalation = setTimeout(() => {
        if (!exited) killGroup('SIGKILL');
      }, BASH.KILL_GRACE_MS);
      escalation.unref();
    };

    // 'close'(管道 EOF) 与 exit 后兜底共用的收尾逻辑（顺序：abort > timeout > maxBuffer > 非零退出 > 成功）。
    const finalize = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      // 释放对子进程 stdio 管道的持有，避免被后台化、存活更久的孙进程拖住事件循环。
      child.stdout?.destroy();
      child.stderr?.destroy();

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
    };

    const rejectOnce = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      child.stdout?.destroy();
      child.stderr?.destroy();
      reject(error);
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

    // 正常命令：stdio 管道 EOF → 'close' 先触发，捕获全部输出后 settle（行为不变）。
    child.on('close', (code, signal) => {
      finalize(code, signal);
    });

    // shell 已退出但 'close' 可能因被 `&` 后台化的子进程持有 stdout 管道而永不触发。
    // 给极短窗口让正常 'close' 优先；超时则用 exit 结果兜底 settle，避免工具无限挂起。
    child.on('exit', (code, signal) => {
      if (settled) return;
      exited = true;
      exitCode = code;
      exitSignal = signal;
      postExitTimer = setTimeout(() => finalize(exitCode, exitSignal), BASH.POST_EXIT_DRAIN_MS);
      postExitTimer.unref();
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

    // -------------------------------------------------------------------------
    // 设计画布会话硬控（跨进程）：本轮是设计画布会话且命令是"用代码画图"时，
    // 拒绝执行并重定向到 proposeCanvasOps。只在 designCanvasActive===true 时拦，
    // 普通会话（undefined/false）一律放行，零影响。命令不是画图也放行。
    // -------------------------------------------------------------------------
    if (ctx.executionIntent?.designCanvasActive === true && looksLikeCodeImageGeneration(command)) {
      return { ok: false, error: DESIGN_CANVAS_REDIRECT_MESSAGE, code: 'DESIGN_CANVAS_REDIRECT' };
    }

    const timeout = Math.min((args.timeout as number) || BASH.DEFAULT_TIMEOUT, MAX_TIMEOUT_MS);
    const workingDirectory = (args.working_directory as string) || ctx.workingDir;
    const implicitBackground = rewriteImplicitBackgroundCommand(command);
    const normalizedCommand = implicitBackground.command;
    const runInBackground = (args.run_in_background as boolean | undefined) ?? implicitBackground.rewritten;
    const usePty = args.pty as boolean | undefined;
    const cols = (args.cols as number) || 80;
    const rows = (args.rows as number) || 24;
    const waitForCompletion = args.wait_for_completion as boolean | undefined;

    // -------------------------------------------------------------------------
    // OS 沙箱（bypassPermissions / YOLO 档 + 无人值守会话）
    // 把命令包装成带沙箱前缀的 shell 命令，前台/PTY/后台三条路径统一使用，
    // 复用各自执行器已有的流式 / abort / 错误语义。沙箱不可用时硬报错，绝不静默裸跑。
    // 审出 MED：无人值守钳制（bypass→acceptEdits）不能顺带撤掉唯一的 OS 级围栏——
    // unattended 会话不论钳后档位，命令一律带沙箱跑。
    // -------------------------------------------------------------------------
    const permissionModeManager = getPermissionModeManager();
    const shouldSandbox = OS_SANDBOX.ENABLED
      && (permissionModeManager.getModeForSession(ctx.sessionId) === 'bypassPermissions'
        || permissionModeManager.isUnattendedSession(ctx.sessionId));
    let sandboxCleanup: (() => void) | undefined;
    /** shouldSandbox 时把命令包装成带沙箱前缀的 shell 命令，否则原样返回 */
    const applySandbox = (cmd: string): { ok: true; command: string } | { ok: false; error: string } => {
      if (!shouldSandbox) return { ok: true, command: cmd };
      try {
        const wrapped = wrapCommandForSandbox(cmd, { workingDirectory, allowNetwork: true });
        sandboxCleanup = wrapped.cleanup;
        return { ok: true, command: wrapped.command };
      } catch (err) {
        return {
          ok: false,
          error:
            `bypassPermissions 档要求 OS 沙箱可用，但当前不可用：${err instanceof Error ? err.message : String(err)}。` +
            `请安装 bubblewrap（Linux）或切换到 default 档。`,
        };
      }
    };

    onProgress?.({ stage: 'starting', detail: `exec: ${normalizedCommand.slice(0, 60)}` });

    // -------------------------------------------------------------------------
    // PTY 执行
    // -------------------------------------------------------------------------
    if (usePty) {
      const sandboxed = applySandbox(normalizedCommand);
      if (!sandboxed.ok) return { ok: false, error: sandboxed.error, code: 'SANDBOX_UNAVAILABLE' };
      const result = createPtySession({
        command: sandboxed.command,
        cwd: workingDirectory,
        cols,
        rows,
        maxRuntime: timeout,
        sessionId: ctx.sessionId,
        toolCallId: ctx.currentToolCallId,
      });

      if (!result.success) {
        return {
          ok: false,
          error: result.error || 'Failed to create PTY session',
          code: 'FS_ERROR',
        };
      }

      if (waitForCompletion) {
        const sessionId = result.sessionId;
        if (!sessionId) {
          return {
            ok: false,
            error: 'PTY session started without a session id',
            code: 'FS_ERROR',
          };
        }
        const output = await getPtySessionOutput(sessionId, true, timeout);
        if (!output) {
          return {
            ok: false,
            error: 'PTY session ended unexpectedly',
            code: 'FS_ERROR',
          };
        }

        const outputText = truncateOutput(output.output, {
          sessionId: ctx.sessionId,
          toolCallId: ctx.currentToolCallId,
        });
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
          // 把命令输出折进模型可见的 error（meta.output 不会被 messageProcessor 读到）
          error: outputText
            ? `Command exited with code ${output.exitCode}\n${outputText}`
            : `Command exited with code ${output.exitCode}`,
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
      const sandboxed = applySandbox(normalizedCommand);
      if (!sandboxed.ok) return { ok: false, error: sandboxed.error, code: 'SANDBOX_UNAVAILABLE' };
      const result = startBackgroundTask(sandboxed.command, workingDirectory, timeout, {
        sessionId: ctx.sessionId,
        toolCallId: ctx.currentToolCallId,
      });
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
    // rtk rewrite (token-saving, B 方案)
    // 默认关闭, fail-closed; policy 已在上面拦截危险命令,这里只动 spawn 用的命令字符串,
    // 不改 normalizedCommand —— 动态描述/指纹/UI meta 看到的仍是模型原命令
    // -------------------------------------------------------------------------
    const commandForExecution = await rewriteBashCommand(normalizedCommand);

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

    const sandboxedFg = applySandbox(commandForExecution);
    if (!sandboxedFg.ok) return { ok: false, error: sandboxedFg.error, code: 'SANDBOX_UNAVAILABLE' };

    try {
      // 并行：生成动态描述（不阻塞命令执行）
      const descriptionPromise = generateBashDescription(normalizedCommand).catch(() => null);

      const startedAt = Date.now();
      const { stdout, stderr } = await runForegroundCommand({
        command: sandboxedFg.command,
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
      output = truncateOutput(output, {
        sessionId: ctx.sessionId,
        toolCallId: ctx.currentToolCallId,
      });

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
      errorOutput = errorOutput
        ? truncateOutput(errorOutput, { sessionId: ctx.sessionId, toolCallId: ctx.currentToolCallId })
        : errorOutput;

      // 模型可见通道是 result.error（messageProcessor 取 output||error），meta.output 不会被读到。
      // 因此把命令输出折进 error，保证非零退出/超时时模型能看到 traceback / stderr，
      // 而不是只看到 "exit code N" 然后瞎重试。meta.output 保留供 telemetry/artifact 使用。
      const withOutput = (msg: string) => (errorOutput ? `${msg}\n${errorOutput}` : msg);

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
          error: withOutput(`Command timed out after ${timeout / 1000} seconds. Consider using run_in_background=true for long-running commands.`),
          code: 'TIMEOUT',
          meta: { ...(errorOutput ? { output: errorOutput } : {}), shellPath: shellPathMeta },
        };
      }

      return {
        ok: false,
        error: withOutput(errMsg || 'Command execution failed'),
        code: 'FS_ERROR',
        meta: { ...(errorOutput ? { output: errorOutput } : {}), shellPath: shellPathMeta },
      };
    } finally {
      // 清理本次前台命令的临时 sandbox profile（PTY/后台进程异步存活，
      // 其 profile 由 Seatbelt.cleanupOldProfiles 的 10 个上限自动回收）
      sandboxCleanup?.();
    }
  }
}

export const bashModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new BashHandler();
  },
};
