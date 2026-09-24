import { spawn } from 'node:child_process';
import type { ToolContext } from '../../../protocol/tools';
import { BASH } from '../../../../shared/constants';
import { spawnWindowsShell, killProcessTree } from '../../shell/platformShell';
import type { TimedOutCommandHandoverResult } from '../../shell/timeoutHandover';

const MAX_LIVE_OUTPUT_DELTA_LENGTH = 2_000;
class BashForegroundExecutionError extends Error {
  stdout: string;
  stderr: string;
  killed?: boolean;
  signal?: NodeJS.Signals;
  code?: number | string | null;
  durationMs?: number;

  constructor(
    message: string,
    details: {
      stdout?: string;
      stderr?: string;
      killed?: boolean;
      signal?: NodeJS.Signals;
      code?: number | string | null;
      durationMs?: number;
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
    this.durationMs = details.durationMs;
  }
}
function emitToolOutputDelta(
  toolName: string,
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
      toolName,
      stream,
      content: liveContent,
      elapsedMs: Date.now() - startedAt,
      ...(truncated ? { truncated: true } : {}),
    },
  });
}
export function runForegroundCommand(options: {
  command: string;
  cwd: string;
  timeout: number;
  env: NodeJS.ProcessEnv;
  abortSignal: AbortSignal;
  ctx: ToolContext;
  toolName: string;
  startedAt: number;
  onTimeout?: (input: {
    child: ReturnType<typeof spawn>;
    stdout: string;
    stderr: string;
    startedAt: number;
  }) => TimedOutCommandHandoverResult | null;
}): Promise<{ stdout: string; stderr: string; handover?: TimedOutCommandHandoverResult }> {
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
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    let postExitTimer: NodeJS.Timeout | undefined;

    const cleanup = () => {
      clearTimeout(timeoutTimer);
      if (postExitTimer) clearTimeout(postExitTimer);
      abortSignal.removeEventListener('abort', abortHandler);
    };

    // 整组收树并等到整树确认退出：POSIX detached 下 child.pid 即组长，-pid 命中组内
    // 全部(含被后台化的孙进程)，组不存在(进程已退)时回退到直接子进程；win32 走
    // taskkill /T。SIGTERM → 宽限 → SIGKILL → 探活确认全在 killProcessTree 内部。
    //
    // 只对 child 的进程组发信号，宿主自己不在这个组里（宿主是 spawn 的父进程，
    // detached 让 child 另开了一组）——对照 claude-code #45717：Bash 工具超时的
    // SIGTERM 传播把宿主进程自己杀了。
    let treeExit: Promise<void> | undefined;

    const killChild = () => {
      treeExit = killProcessTree(child, {
        posixGroupKill: true,
        graceMs: BASH.KILL_GRACE_MS,
      });
    };

    // 'close'(管道 EOF) 与 exit 后兜底共用的收尾逻辑（顺序：abort > timeout > maxBuffer > 非零退出 > 成功）。
    const finalize = async (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      // 主动杀过（abort / 超时 / 输出溢出）就等整树确认退出再交还结果——直接子进程
      // 退出不代表树死了，提前 reject 会让调用方以为清理完成而被后台孙进程反咬。
      if (treeExit) await treeExit;
      const durationMs = Date.now() - startedAt;
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
          durationMs,
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
          durationMs,
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
          durationMs,
        }));
        return;
      }

      if (signal) {
        reject(new BashForegroundExecutionError(`Command terminated by signal ${signal}`, {
          stdout,
          stderr,
          signal,
          code,
          durationMs,
        }));
        return;
      }

      if (code && code !== 0) {
        reject(new BashForegroundExecutionError(`Command failed with exit code ${code}`, {
          stdout,
          stderr,
          code,
          durationMs,
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
      const handover = (() => {
        try {
          return options.onTimeout?.({ child, stdout, stderr, startedAt }) ?? null;
        } catch {
          return null;
        }
      })();
      if (handover) {
        settled = true;
        cleanup();
        child.stdout?.removeListener('data', onStdout);
        child.stderr?.removeListener('data', onStderr);
        child.removeListener('error', onError);
        child.removeListener('close', onClose);
        child.removeListener('exit', onExit);
        resolve({ stdout, stderr, handover });
        return;
      }
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
      emitToolOutputDelta(options.toolName, ctx, stream, text, startedAt);

      if (stdout.length + stderr.length > BASH.MAX_BUFFER && !maxBufferExceeded) {
        maxBufferExceeded = true;
        killChild();
      }
    };

    const onStdout = (chunk: Buffer | string) => appendOutput('stdout', chunk);
    const onStderr = (chunk: Buffer | string) => appendOutput('stderr', chunk);
    const onError = (error: Error) => {
      rejectOnce(error);
    };

    // 正常命令：stdio 管道 EOF → 'close' 先触发，捕获全部输出后 settle（行为不变）。
    const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
      void finalize(code, signal);
    };
    child.stdout?.on('data', onStdout);
    child.stderr?.on('data', onStderr);
    child.on('error', onError);
    child.on('close', onClose);

    // shell 已退出但 'close' 可能因被 `&` 后台化的子进程持有 stdout 管道而永不触发。
    // 给极短窗口让正常 'close' 优先；超时则用 exit 结果兜底 settle，避免工具无限挂起。
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      exitCode = code;
      exitSignal = signal;
      postExitTimer = setTimeout(() => void finalize(exitCode, exitSignal), BASH.POST_EXIT_DRAIN_MS);
      postExitTimer.unref();
    };
    child.on('exit', onExit);
  });
}
