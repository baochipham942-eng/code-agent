// ============================================================================
// Bash (native ToolModule) Tests — P0-6.3 Batch 2a
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type {
  ToolContext,
  CanUseToolFn,
  Logger,
} from '../../../../../src/main/protocol/tools';

// -----------------------------------------------------------------------------
// Mock heavy peers to keep tests isolated / fast
// -----------------------------------------------------------------------------

vi.mock('../../../../../src/main/tools/shell/dynamicDescription', () => ({
  generateBashDescription: () => Promise.resolve(null),
}));

vi.mock('../../../../../src/main/tools/dataFingerprint', () => ({
  extractBashFacts: () => null,
  dataFingerprintStore: { recordFact: () => {} },
}));

vi.mock('../../../../../src/main/services/codex/codexSandbox', () => ({
  isCodexSandboxEnabled: () => false,
  runInCodexSandbox: () => Promise.resolve({ success: false }),
}));

vi.mock('../../../../../src/main/security/commandSafety', () => ({
  isKnownSafeCommand: () => true,
}));

vi.mock('../../../../../src/main/services/infra/shellEnvironment', () => ({
  getShellPathDiagnostics: () => ({
    path: process.env.PATH || '',
    source: 'process',
    pathEntryCount: (process.env.PATH || '').split(':').filter(Boolean).length,
    degraded: false,
    fallbackApplied: false,
    fallbackEntries: [],
  }),
}));

// backgroundTasks + ptyExecutor are stubbed so we don't actually spawn children
const startBackgroundTaskMock = vi.fn();
const createPtySessionMock = vi.fn();
const getPtySessionOutputMock = vi.fn();

vi.mock('../../../../../src/main/tools/shell/backgroundTasks', () => ({
  startBackgroundTask: (...args: unknown[]) => startBackgroundTaskMock(...args),
}));

vi.mock('../../../../../src/main/tools/shell/ptyExecutor', () => ({
  createPtySession: (...args: unknown[]) => createPtySessionMock(...args),
  getPtySessionOutput: (...args: unknown[]) => getPtySessionOutputMock(...args),
}));

// OS 沙箱 gating 测试：用 spy 替换真实包装（跨平台确定性），并打开 OS_SANDBOX flag。
// 真实隔离另由 tests/integration/sandbox/seatbeltWrap.test.ts 用 sandbox-exec 验证。
const { wrapMock, cleanupMock } = vi.hoisted(() => {
  process.env.OS_SANDBOX_ENABLED = 'true';
  return { wrapMock: vi.fn(), cleanupMock: vi.fn() };
});
vi.mock('../../../../../src/main/sandbox', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../../src/main/sandbox')>()),
  wrapCommandForSandbox: (...args: unknown[]) => wrapMock(...args),
}));

import {
  bashModule,
  rewriteImplicitBackgroundCommand,
  looksLikeCodeImageGeneration,
} from '../../../../../src/main/tools/modules/shell/bash';
import { getPermissionModeManager } from '../../../../../src/main/permissions/modes';

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function makeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  const ctrl = new AbortController();
  return {
    sessionId: 'test-session',
    workingDir: process.cwd(),
    abortSignal: ctrl.signal,
    logger: makeLogger(),
    emit: () => void 0,
    ...overrides,
  };
}

const allowAll: CanUseToolFn = async () => ({ allow: true });
const denyAll: CanUseToolFn = async () => ({ allow: false, reason: 'blocked' });

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe('bashModule (native)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    startBackgroundTaskMock.mockReset();
    createPtySessionMock.mockReset();
    getPtySessionOutputMock.mockReset();
  });

  describe('schema', () => {
    it('has correct metadata', () => {
      expect(bashModule.schema.name).toBe('Bash');
      expect(bashModule.schema.category).toBe('shell');
      expect(bashModule.schema.permissionLevel).toBe('execute');
      expect(bashModule.schema.readOnly).toBe(false);
      expect(bashModule.schema.allowInPlanMode).toBe(false);
      expect(bashModule.schema.inputSchema.required).toContain('command');
    });

    it('exposes advanced parameters (pty / background / cols / rows)', () => {
      const props = bashModule.schema.inputSchema.properties as Record<string, unknown>;
      expect(props.pty).toBeDefined();
      expect(props.run_in_background).toBeDefined();
      expect(props.cols).toBeDefined();
      expect(props.rows).toBeDefined();
      expect(props.wait_for_completion).toBeDefined();
      expect(props.working_directory).toBeDefined();
    });
  });

  describe('validation', () => {
    it('rejects missing command', async () => {
      const handler = await bashModule.createHandler();
      const result = await handler.execute({}, makeCtx(), allowAll);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
    });

    it('rejects non-string command', async () => {
      const handler = await bashModule.createHandler();
      const result = await handler.execute({ command: 123 }, makeCtx(), allowAll);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
    });
  });

  describe('canUseTool gate', () => {
    it('returns PERMISSION_DENIED when canUseTool denies', async () => {
      const handler = await bashModule.createHandler();
      const result = await handler.execute(
        { command: 'echo "hi"' },
        makeCtx(),
        denyAll,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('PERMISSION_DENIED');
    });

    it('returns ABORTED when abortSignal fired before execute', async () => {
      const ctrl = new AbortController();
      ctrl.abort();
      const handler = await bashModule.createHandler();
      const result = await handler.execute(
        { command: 'echo "hi"' },
        makeCtx({ abortSignal: ctrl.signal }),
        allowAll,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('ABORTED');
    });
  });

  describe('onProgress events', () => {
    it('emits starting + completing for a simple foreground command', async () => {
      const handler = await bashModule.createHandler();
      const events: string[] = [];
      const onProgress = (p: { stage: string }) => events.push(p.stage);
      const result = await handler.execute(
        { command: 'echo "hello"' },
        makeCtx(),
        allowAll,
        onProgress,
      );
      expect(result.ok).toBe(true);
      expect(events).toContain('starting');
      expect(events).toContain('completing');
    });

    it('emits live stdout and stderr deltas for a foreground command', async () => {
      const handler = await bashModule.createHandler();
      const emit = vi.fn();
      const result = await handler.execute(
        { command: 'printf "out"; printf "err" >&2' },
        makeCtx({ currentToolCallId: 'tool-live-1', emit }),
        allowAll,
      );

      expect(result.ok).toBe(true);
      expect(emit).toHaveBeenCalledWith(expect.objectContaining({
        type: 'tool_output_delta',
        data: expect.objectContaining({
          toolCallId: 'tool-live-1',
          stream: 'stdout',
          content: expect.stringContaining('out'),
        }),
      }));
      expect(emit).toHaveBeenCalledWith(expect.objectContaining({
        type: 'tool_output_delta',
        data: expect.objectContaining({
          toolCallId: 'tool-live-1',
          stream: 'stderr',
          content: expect.stringContaining('err'),
        }),
      }));
    });
  });

  describe('foreground execution', () => {
    it('executes a simple command and returns output with cwd prefix', async () => {
      const handler = await bashModule.createHandler();
      const result = await handler.execute(
        { command: 'echo "hello"' },
        makeCtx(),
        allowAll,
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toMatch(/\[cwd: .+\]/);
        expect(result.output).toContain('hello');
      }
    });

    it('includes shell PATH diagnostics metadata without dumping environment variables', async () => {
      const handler = await bashModule.createHandler();
      const result = await handler.execute(
        { command: 'echo "$PATH"' },
        makeCtx(),
        allowAll,
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.meta?.shellPath).toEqual({
          source: 'process',
          pathEntryCount: expect.any(Number),
          degraded: false,
          fallbackApplied: false,
          fallbackEntries: [],
        });
        expect(JSON.stringify(result.meta?.shellPath)).not.toContain('HOME=');
        expect(JSON.stringify(result.meta?.shellPath)).not.toContain('TOKEN=');
      }
    });

    it('returns non-zero exit as FS_ERROR with stderr/stdout merged into meta.output', async () => {
      const handler = await bashModule.createHandler();
      const result = await handler.execute(
        { command: 'exit 1' },
        makeCtx(),
        allowAll,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeDefined();
        expect(result.code).toBe('FS_ERROR');
        expect(result.meta?.shellPath).toBeDefined();
      }
    });

    it('surfaces stderr/stdout in the model-visible error on non-zero exit', async () => {
      // 回归锁：模型可见通道是 result.error（messageProcessor 取 output||error，不读 meta.output）。
      // 命令失败时 traceback 必须出现在 error 里，否则模型只看到 exit code 会瞎重试。
      const handler = await bashModule.createHandler();
      const result = await handler.execute(
        { command: 'echo "BOOM_STDERR_MARKER" >&2; exit 1' },
        makeCtx(),
        allowAll,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('BOOM_STDERR_MARKER');
      }
    });

    it('captures stderr as part of output', async () => {
      const handler = await bashModule.createHandler();
      const result = await handler.execute(
        { command: 'echo "err" >&2' },
        makeCtx(),
        allowAll,
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('[stderr]');
        expect(result.output).toContain('err');
      }
    });

    it('respects timeout parameter (TIMEOUT code)', async () => {
      const handler = await bashModule.createHandler();
      const result = await handler.execute(
        { command: 'sleep 100', timeout: 500 },
        makeCtx(),
        allowAll,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('TIMEOUT');
        expect(result.error).toContain('timed out');
      }
    }, 10_000);

    it('aborts a foreground command when the run signal fires', async () => {
      const ctrl = new AbortController();
      const handler = await bashModule.createHandler();
      const resultPromise = handler.execute(
        { command: 'sleep 5', timeout: 10_000 },
        makeCtx({ abortSignal: ctrl.signal }),
        allowAll,
      );

      setTimeout(() => ctrl.abort(), 30);
      const result = await resultPromise;

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('ABORTED');
      }
    }, 5_000);

    it('respects working_directory override', async () => {
      const handler = await bashModule.createHandler();
      const result = await handler.execute(
        { command: 'pwd', working_directory: '/tmp' },
        makeCtx({ workingDir: '/var' }),
        allowAll,
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        // resolved symlinks on macOS: /tmp → /private/tmp; check both
        expect(result.output).toMatch(/\[cwd: \/tmp\]/);
        expect(result.output).toMatch(/(\/private)?\/tmp/);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Foreground command that spawns a long-lived background child
  // 回归：模型常发 `python3 -m http.server 8088 & echo started` 这类命令，`&` 在
  // 命令中间（非结尾），不被 rewriteImplicitBackgroundCommand 当后台，落到前台 spawn。
  // 旧实现只在子进程 'close'（stdio 管道 EOF）才 resolve，被后台化的孙子进程继承并
  // 持有 stdout 管道写端 → EOF 永不到达 → 工具永不返回，整个 run 挂死。
  // ---------------------------------------------------------------------------
  describe('foreground command with long-lived background child', () => {
    const markers: string[] = [];
    afterEach(() => {
      for (const m of markers.splice(0)) {
        try { rmSync(m, { force: true }); } catch { /* ignore */ }
      }
    });
    const lineCount = (file: string): number =>
      existsSync(file) ? readFileSync(file, 'utf-8').split('\n').filter(Boolean).length : 0;
    const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

    it('D1: returns promptly without waiting for a backgrounded child to exit', async () => {
      const handler = await bashModule.createHandler();
      const startedAt = Date.now();
      // sleep 8 被后台化并继承 stdout 管道；前台 echo 立即完成、shell 立即退出。
      // 工具应在 shell 退出时返回，而不是死等 8 秒后 sleep 释放管道。
      const result = await handler.execute(
        { command: 'sleep 8 & echo d1-started' },
        makeCtx(),
        allowAll,
      );
      const elapsed = Date.now() - startedAt;
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('d1-started');
      }
      expect(elapsed).toBeLessThan(3000);
    }, 20_000);

    it('D2: reaps the whole process group (backgrounded grandchild) on timeout', async () => {
      const handler = await bashModule.createHandler();
      const marker = join(tmpdir(), `bash-d2-${process.pid}-${Date.now()}.log`);
      markers.push(marker);
      // 后台子 shell 持续往 marker 追加；前台 sleep 8 撑住 shell 直到超时。
      // 超时后必须杀掉整个进程组：工具应及时返回 TIMEOUT，且后台循环停止写入。
      const exec = handler.execute(
        {
          command: `( for i in $(seq 1 80); do echo tick >> "${marker}"; sleep 0.1; done ) & sleep 8`,
          timeout: 700,
        },
        makeCtx(),
        allowAll,
      );
      // 防止 buggy 代码把测试本身挂死：自带 4s 兜底，超过即视为未及时返回。
      const result = (await Promise.race([
        exec,
        delay(4000).then(() => ({ ok: false, code: 'TEST_TIMEOUT' as const })),
      ])) as { ok: boolean; code?: string };

      expect(result.ok).toBe(false);
      expect(result.code).toBe('TIMEOUT');

      const linesAtReturn = lineCount(marker);
      await delay(800);
      const linesLater = lineCount(marker);
      expect(linesLater).toBe(linesAtReturn);
    }, 15_000);
  });

  describe('pre-flight validation', () => {
    it('rejects tool confusion (e.g. write_file(...))', async () => {
      const handler = await bashModule.createHandler();
      const result = await handler.execute(
        { command: 'write_file({"path": "x"})' },
        makeCtx(),
        allowAll,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('INVALID_ARGS');
        expect(result.error).toContain('工具混淆');
      }
    });

    it('rejects truncated heredoc (no body)', async () => {
      const handler = await bashModule.createHandler();
      const result = await handler.execute(
        { command: "bash -c 'cat <<EOF'" },
        makeCtx(),
        allowAll,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
    });

    it('rejects near-empty heredoc body (<20 chars)', async () => {
      const cmd = `python3 <<PYEOF\nx=1\nPYEOF\n`;
      const handler = await bashModule.createHandler();
      const result = await handler.execute({ command: cmd }, makeCtx(), allowAll);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
    });
  });

  describe('self-reference unwrap', () => {
    it('unwraps bash({"command":"echo hi"}) → echo hi', async () => {
      const handler = await bashModule.createHandler();
      const result = await handler.execute(
        { command: 'bash({"command": "echo unwrap-json"})' },
        makeCtx(),
        allowAll,
      );
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.output).toContain('unwrap-json');
    });

    it('unwraps bash(command="echo hi") → echo hi', async () => {
      const handler = await bashModule.createHandler();
      const result = await handler.execute(
        { command: 'bash(command="echo unwrap-kw")' },
        makeCtx(),
        allowAll,
      );
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.output).toContain('unwrap-kw');
    });
  });

  describe('run_in_background', () => {
    it('does not rewrite inline ampersands that are followed by another command', () => {
      expect(rewriteImplicitBackgroundCommand('echo one & echo two')).toEqual({
        command: 'echo one & echo two',
        rewritten: false,
      });
    });

    it('treats a trailing shell ampersand as background mode', async () => {
      startBackgroundTaskMock.mockReturnValue({
        success: true,
        taskId: 'task-trailing-amp',
        outputFile: '/tmp/task-trailing-amp.log',
      });
      const handler = await bashModule.createHandler();
      const result = await handler.execute(
        { command: 'python3 -m http.server 8000 &' },
        makeCtx(),
        allowAll,
      );

      expect(startBackgroundTaskMock).toHaveBeenCalledWith(
        'python3 -m http.server 8000',
        expect.any(String),
        expect.any(Number),
        expect.objectContaining({ sessionId: 'test-session' }),
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('<task-id>task-trailing-amp</task-id>');
        expect(result.meta?.background).toBe(true);
      }
    });

    it('returns task meta + friendly message on success', async () => {
      startBackgroundTaskMock.mockReturnValue({
        success: true,
        taskId: 'task-abc',
        outputFile: '/tmp/task-abc.log',
      });
      const handler = await bashModule.createHandler();
      const result = await handler.execute(
        { command: 'sleep 100', run_in_background: true },
        makeCtx(),
        allowAll,
      );
      expect(startBackgroundTaskMock).toHaveBeenCalled();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('<task-id>task-abc</task-id>');
        expect(result.output).toContain('Background task started');
        expect(result.meta?.taskId).toBe('task-abc');
        expect(result.meta?.background).toBe(true);
      }
    });

    it('returns FS_ERROR when startBackgroundTask fails', async () => {
      startBackgroundTaskMock.mockReturnValue({
        success: false,
        error: 'too many tasks',
      });
      const handler = await bashModule.createHandler();
      const result = await handler.execute(
        { command: 'sleep 100', run_in_background: true },
        makeCtx(),
        allowAll,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('FS_ERROR');
        expect(result.error).toContain('too many tasks');
      }
    });
  });

  describe('pty mode', () => {
    it('returns session meta immediately when wait_for_completion is false', async () => {
      createPtySessionMock.mockReturnValue({
        success: true,
        sessionId: 'pty-1',
        outputFile: '/tmp/pty-1.log',
      });
      const handler = await bashModule.createHandler();
      const result = await handler.execute(
        { command: 'vim /tmp/x', pty: true },
        makeCtx(),
        allowAll,
      );
      expect(createPtySessionMock).toHaveBeenCalled();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('<session-id>pty-1</session-id>');
        expect(result.meta?.pty).toBe(true);
        expect(result.meta?.sessionId).toBe('pty-1');
      }
    });

    it('wait_for_completion success path returns truncated output + meta.duration', async () => {
      createPtySessionMock.mockReturnValue({
        success: true,
        sessionId: 'pty-2',
        outputFile: '/tmp/pty-2.log',
      });
      getPtySessionOutputMock.mockResolvedValue({
        status: 'completed',
        output: 'done',
        exitCode: 0,
        duration: 42,
      });
      const handler = await bashModule.createHandler();
      const result = await handler.execute(
        { command: 'ls', pty: true, wait_for_completion: true },
        makeCtx(),
        allowAll,
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toBe('done');
        expect(result.meta?.duration).toBe(42);
        expect(result.meta?.exitCode).toBe(0);
      }
    });

    it('wait_for_completion failure path returns FS_ERROR with exit code', async () => {
      createPtySessionMock.mockReturnValue({
        success: true,
        sessionId: 'pty-3',
        outputFile: '/tmp/pty-3.log',
      });
      getPtySessionOutputMock.mockResolvedValue({
        status: 'failed',
        output: 'boom',
        exitCode: 2,
        duration: 10,
      });
      const handler = await bashModule.createHandler();
      const result = await handler.execute(
        { command: 'ls', pty: true, wait_for_completion: true },
        makeCtx(),
        allowAll,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('FS_ERROR');
        expect(result.error).toContain('exited with code 2');
      }
    });

    it('createPtySession failure surfaces as FS_ERROR', async () => {
      createPtySessionMock.mockReturnValue({
        success: false,
        error: 'pty unavailable',
      });
      const handler = await bashModule.createHandler();
      const result = await handler.execute(
        { command: 'vim', pty: true },
        makeCtx(),
        allowAll,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('FS_ERROR');
        expect(result.error).toContain('pty unavailable');
      }
    });
  });
});

// ---------------------------------------------------------------------------
// 设计画布会话硬控：用代码画图 → 重定向到 proposeCanvasOps
// ---------------------------------------------------------------------------
describe('looksLikeCodeImageGeneration', () => {
  it('matches python 图形库 / pip 装库 / imagemagick / 图片重定向 / heredoc 含 PIL', () => {
    const positives = [
      'python3 -c "from PIL import Image"',
      'python3 -c "import PIL"',
      'pip install pillow',
      'pip3 install reportlab cairosvg',
      'magick poster.png -resize 50% out.png',
      'convert in.svg out.png',
      'mogrify -resize 800x in.jpg',
      'python gen.py > out.png',
      'python3 draw.py > /tmp/poster.jpeg',
      'python3 <<PY\nimport cairosvg\ncairosvg.svg2png(url="a.svg")\nPY',
    ];
    for (const cmd of positives) {
      expect(looksLikeCodeImageGeneration(cmd), `should match: ${cmd}`).toBe(true);
    }
  });

  it('does NOT match ordinary non-image commands', () => {
    const negatives = [
      'ls -la',
      'cat foo.txt',
      'npm run build',
      'python3 script.py',
      'echo hi',
      'git status',
      'grep convert file.txt', // convert 不带图片扩展名不应误命中
      'convert this idea into a plan', // 自然语言里出现 convert，但无图片扩展名
      '',
    ];
    for (const cmd of negatives) {
      expect(looksLikeCodeImageGeneration(cmd), `should NOT match: ${cmd}`).toBe(false);
    }
  });
});

describe('bashModule 设计画布会话硬控（designCanvasActive）', () => {
  it('blocks code-based image generation with a proposeCanvasOps redirect when designCanvasActive=true', async () => {
    const handler = await bashModule.createHandler();
    const result = await handler.execute(
      { command: 'python3 -c "from PIL import Image; Image.new(\'RGB\',(8,8)).save(\'x.png\')"' },
      makeCtx({ executionIntent: { designCanvasActive: true } }),
      allowAll,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('DESIGN_CANVAS_REDIRECT');
      expect(result.error).toContain('proposeCanvasOps');
      expect(result.error).toContain('设计画布会话');
    }
  });

  it('does NOT block ordinary commands even when designCanvasActive=true', async () => {
    const handler = await bashModule.createHandler();
    const result = await handler.execute(
      { command: 'echo design-active-but-fine' },
      makeCtx({ executionIntent: { designCanvasActive: true } }),
      allowAll,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.output).toContain('design-active-but-fine');
  });

  it('does NOT block code-based image generation when designCanvasActive is false/undefined (普通会话零回归)', async () => {
    const handler = await bashModule.createHandler();
    // designCanvasActive undefined
    const r1 = await handler.execute(
      { command: 'echo "from PIL import Image"' },
      makeCtx(),
      allowAll,
    );
    expect(r1.ok).toBe(true);
    // designCanvasActive=false explicitly
    const r2 = await handler.execute(
      { command: 'echo "import matplotlib"' },
      makeCtx({ executionIntent: { designCanvasActive: false } }),
      allowAll,
    );
    expect(r2.ok).toBe(true);
  });
});

describe('bashModule OS 沙箱 gating（bypassPermissions）', () => {
  const modeMgr = getPermissionModeManager();

  beforeEach(() => {
    vi.clearAllMocks();
    wrapMock.mockReturnValue({ command: 'echo __SANDBOXED__', cleanup: cleanupMock });
    modeMgr.setMode('default', true);
  });
  afterEach(() => {
    modeMgr.setMode('default', true);
  });

  it('default 档：不包装，直接执行原命令', async () => {
    const handler = await bashModule.createHandler();
    const result = await handler.execute({ command: 'echo plain-output' }, makeCtx(), allowAll);
    expect(wrapMock).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.output).toContain('plain-output');
  });

  it('bypassPermissions 档：包装命令并执行包装结果，结束后清理 profile', async () => {
    modeMgr.setMode('bypassPermissions', true);
    const handler = await bashModule.createHandler();
    const result = await handler.execute({ command: 'echo plain-output' }, makeCtx(), allowAll);
    expect(wrapMock).toHaveBeenCalledTimes(1);
    expect(wrapMock).toHaveBeenCalledWith(
      'echo plain-output',
      expect.objectContaining({ allowNetwork: true }),
    );
    expect(result.ok).toBe(true);
    // 跑的是包装后的命令（spy 返回 echo __SANDBOXED__），证明真的走了沙箱包装结果
    if (result.ok) expect(result.output).toContain('__SANDBOXED__');
    expect(cleanupMock).toHaveBeenCalled();
  });

  it('bypassPermissions 档 + 沙箱不可用：硬报错 SANDBOX_UNAVAILABLE，绝不裸跑', async () => {
    modeMgr.setMode('bypassPermissions', true);
    wrapMock.mockImplementation(() => {
      throw new Error('sandbox-exec unavailable');
    });
    const handler = await bashModule.createHandler();
    const result = await handler.execute({ command: 'echo should-not-run' }, makeCtx(), allowAll);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('SANDBOX_UNAVAILABLE');
  });
});
