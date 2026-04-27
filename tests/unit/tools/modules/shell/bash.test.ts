// ============================================================================
// Bash (native ToolModule) Tests — P0-6.3 Batch 2a
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
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
  getShellPath: () => process.env.PATH,
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

import { bashModule } from '../../../../../src/main/tools/modules/shell/bash';

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
