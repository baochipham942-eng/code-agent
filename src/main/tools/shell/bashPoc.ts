// ============================================================================
// Bash (P0-5 POC version)
//
// 验证点：
// 1. canUseTool 独立参数 — 权限判定闭包每次 call 时传入，不放 ctx
// 2. abortSignal 通过 ctx 传入 — tool 自己处理取消（kill 子进程）
// 3. onProgress 独立参数 — tool→UI 的反向进度流
// 4. 零 services 导入 — logger/shellEnv 都走 ctx
// ============================================================================

import { spawn } from 'child_process';
import type {
  ToolHandler,
  ToolModule,
  ToolContext,
  CanUseToolFn,
  ToolProgressFn,
  ToolResult,
  ToolSchema,
} from '../../protocol/tools';

const schema: ToolSchema = {
  name: 'BashPoc',
  description: '执行 shell 命令（P0-5 POC 版本，走 ToolModule + canUseTool）',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: '要执行的命令' },
      timeout: { type: 'number', description: '超时 ms，默认 120000' },
    },
    required: ['command'],
  },
  category: 'shell',
  permissionLevel: 'execute',
  readOnly: false,
  allowInPlanMode: false,
};

interface BashOutput {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 1 * 1024 * 1024; // 1MB 硬上限，POC 版

class BashPocHandler implements ToolHandler<Record<string, unknown>, BashOutput> {
  readonly schema = schema;

  async execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<BashOutput>> {
    const command = args.command as string | undefined;
    const timeout = (args.timeout as number | undefined) ?? DEFAULT_TIMEOUT_MS;

    if (!command || typeof command !== 'string') {
      return { ok: false, error: 'command 必须是字符串', code: 'INVALID_ARGS' };
    }

    // 权限闸门 — 独立参数，不走 ctx
    const permit = await canUseTool(schema.name, { command });
    if (!permit.allow) {
      ctx.logger.warn('BashPoc permission denied', { command, reason: permit.reason });
      return { ok: false, error: `permission denied: ${permit.reason}`, code: 'PERMISSION_DENIED' };
    }

    if (ctx.abortSignal.aborted) {
      return { ok: false, error: 'aborted before start', code: 'ABORTED' };
    }

    onProgress?.({ stage: 'starting', detail: `exec: ${command.slice(0, 60)}` });
    const startedAt = Date.now();

    return new Promise<ToolResult<BashOutput>>((resolve) => {
      const child = spawn('bash', ['-c', command], {
        cwd: ctx.workingDir,
        env: { ...process.env, FORCE_COLOR: '0' },
      });

      let stdout = '';
      let stderr = '';
      let outBytes = 0;
      let killed = false;

      const killWith = (reason: string, code: string) => {
        if (killed) return;
        killed = true;
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 500).unref();
        resolve({ ok: false, error: reason, code });
      };

      // 超时
      const timer = setTimeout(() => {
        killWith(`command timed out after ${timeout}ms`, 'TIMEOUT');
      }, timeout);
      timer.unref();

      // 外部中断
      const onAbort = () => killWith('aborted by ctx.abortSignal', 'ABORTED');
      ctx.abortSignal.addEventListener('abort', onAbort, { once: true });

      child.stdout?.on('data', (chunk: Buffer) => {
        outBytes += chunk.length;
        if (outBytes > MAX_OUTPUT_BYTES) {
          killWith('output exceeded 1MB', 'OUTPUT_TOO_LARGE');
          return;
        }
        stdout += chunk.toString('utf-8');
        onProgress?.({ stage: 'running', detail: `${outBytes} bytes` });
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        outBytes += chunk.length;
        if (outBytes > MAX_OUTPUT_BYTES) {
          killWith('output exceeded 1MB', 'OUTPUT_TOO_LARGE');
          return;
        }
        stderr += chunk.toString('utf-8');
      });

      child.on('close', (exitCode) => {
        clearTimeout(timer);
        ctx.abortSignal.removeEventListener('abort', onAbort);
        if (killed) return; // already resolved

        const durationMs = Date.now() - startedAt;
        onProgress?.({ stage: 'completing', percent: 100 });
        ctx.logger.info('BashPoc done', { command, exitCode, durationMs });

        resolve({
          ok: true,
          output: {
            stdout,
            stderr,
            exitCode: exitCode ?? -1,
            durationMs,
          },
        });
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        ctx.abortSignal.removeEventListener('abort', onAbort);
        if (killed) return;
        killed = true;
        resolve({ ok: false, error: err.message, code: 'SPAWN_ERROR' });
      });
    });
  }
}

export const bashPocModule: ToolModule<Record<string, unknown>, BashOutput> = {
  schema,
  createHandler() {
    return new BashPocHandler();
  },
};
