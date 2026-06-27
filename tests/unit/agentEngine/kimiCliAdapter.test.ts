import { EventEmitter } from 'events';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  getLogsPath: vi.fn(),
  webContentsSend: vi.fn(),
  addMessageToSession: vi.fn(),
  updateSession: vi.fn(),
  upsertTask: vi.fn(),
  appendEvent: vi.fn(),
  addOutputRef: vi.fn(),
  queueNotification: vi.fn(),
  registryGet: vi.fn(),
}));

vi.mock('child_process', () => ({
  spawn: (...args: unknown[]) => mocks.spawn(...args),
}));

vi.mock('../../../src/host/platform', () => ({
  getLogsPath: () => mocks.getLogsPath(),
  AppWindow: {
    getAllWindows: () => [{ webContents: { send: mocks.webContentsSend } }],
  },
}));

vi.mock('../../../src/host/services/infra/sessionManager', () => ({
  getSessionManager: () => ({
    addMessageToSession: mocks.addMessageToSession,
    updateSession: mocks.updateSession,
  }),
}));

vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../../../src/host/task/backgroundTaskLedger', () => ({
  getBackgroundTaskLedger: () => ({
    upsertTask: mocks.upsertTask,
    appendEvent: mocks.appendEvent,
    addOutputRef: mocks.addOutputRef,
    queueNotification: mocks.queueNotification,
  }),
}));

vi.mock('../../../src/host/services/agentEngine/agentEngineRegistry', () => ({
  getAgentEngineRegistry: () => ({
    get: mocks.registryGet,
  }),
}));

import {
  buildKimiArgs,
  KimiCliAdapter,
  parseKimiJsonLine,
} from '../../../src/host/services/agentEngine/kimiCliAdapter';

describe('buildKimiArgs', () => {
  it('builds `kimi -p "<prompt>" --output-format stream-json -m <model>` with prompt as a positional arg', () => {
    const args = buildKimiArgs('inspect only', 'kimi-k2.5');
    expect(args).toEqual(['-p', 'inspect only', '--output-format', 'stream-json', '-m', 'kimi-k2.5']);
    // prompt must be a CLI arg (no stdin pipe), no --print / no `kimi run`
    expect(args[0]).toBe('-p');
    expect(args[1]).toBe('inspect only');
    expect(args).not.toContain('--print');
    expect(args).not.toContain('run');
    expect(args[args.indexOf('--output-format') + 1]).toBe('stream-json');
  });

  it('omits -m when no model is provided', () => {
    expect(buildKimiArgs('hi')).toEqual(['-p', 'hi', '--output-format', 'stream-json']);
  });
});

describe('parseKimiJsonLine', () => {
  it('returns null for blank or non-JSON lines', () => {
    expect(parseKimiJsonLine('')).toBeNull();
    expect(parseKimiJsonLine('not json')).toBeNull();
  });

  it('extracts streamed text deltas and session id', () => {
    expect(parseKimiJsonLine(JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'thinking' }] },
      session_id: 'kimi-session',
    }))).toMatchObject({ textDelta: 'thinking', externalSessionId: 'kimi-session' });

    expect(parseKimiJsonLine(JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'streaming' } },
    }))).toMatchObject({ textDelta: 'streaming' });
  });

  it('maps final result text, tool calls, and auth errors with status code', () => {
    expect(parseKimiJsonLine(JSON.stringify({
      type: 'result',
      subtype: 'success',
      result: 'final answer',
      session_id: 'kimi-session',
    }))).toMatchObject({
      finalText: 'final answer',
      externalSessionId: 'kimi-session',
      status: 'Kimi Code result: success',
    });

    expect(parseKimiJsonLine(JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_call', name: 'Read' }] },
    }))).toMatchObject({ toolName: 'Read' });

    expect(parseKimiJsonLine(JSON.stringify({
      type: 'result',
      is_error: true,
      api_error_status: 401,
      result: 'Failed to authenticate. Invalid authentication credentials',
    }))).toMatchObject({
      finalText: 'Failed to authenticate. Invalid authentication credentials',
      error: 'Failed to authenticate. Invalid authentication credentials',
      statusCode: 401,
    });
  });
});

describe('KimiCliAdapter.run', () => {
  let tempDir: string;
  let workspaceRoot: string;
  const ENV_KEYS = ['KIMI_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'KIMI_CODE_HOME'] as const;
  const originalEnv: Partial<Record<typeof ENV_KEYS[number], string>> = {};

  beforeEach(async () => {
    vi.clearAllMocks();
    for (const key of ENV_KEYS) {
      originalEnv[key] = process.env[key];
    }
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kimi-adapter-test-'));
    workspaceRoot = path.join(tempDir, 'workspace');
    await fs.mkdir(workspaceRoot, { recursive: true });
    mocks.getLogsPath.mockReturnValue(path.join(tempDir, 'logs'));
    mocks.registryGet.mockResolvedValue({
      kind: 'kimi_code',
      label: 'Kimi Code',
      installState: 'installed',
      runtimeState: 'ready',
      executable: true,
      binaryPath: '/opt/homebrew/bin/kimi',
    });
    mocks.addMessageToSession.mockResolvedValue(undefined);
    mocks.updateSession.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    for (const key of ENV_KEYS) {
      if (originalEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originalEnv[key];
      }
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('runs Kimi via positional prompt arg, parses JSONL from stdout, and does NOT inject API keys into child env', async () => {
    // Kimi CLI does not read API keys from env vars — assert they are stripped.
    process.env.KIMI_API_KEY = 'kimi-secret-value';
    process.env.OPENAI_API_KEY = 'openai-secret-value';
    process.env.ANTHROPIC_API_KEY = 'anthropic-secret-value';

    let child: ReturnType<typeof createMockChild> | undefined;
    mocks.spawn.mockImplementation(() => {
      child = createMockChild([
        JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'kimi streamed' }] } }),
        JSON.stringify({ type: 'result', subtype: 'success', result: 'kimi final answer', session_id: 'kimi-session' }),
      ], 0);
      return child;
    });

    const result = await new KimiCliAdapter().run({
      sessionId: 'session-1',
      prompt: 'inspect only',
      cwd: workspaceRoot,
      workspaceRoot,
      model: 'kimi-k2.5',
      kimiCodeHome: path.join(tempDir, 'kimi-home'),
      timeoutMs: 20_000,
      stallWarningMs: 10_000,
    });

    expect(result).toMatchObject({
      engine: 'kimi_code',
      status: 'completed',
      outputText: 'kimi final answer',
      exitCode: 0,
    });

    expect(mocks.spawn).toHaveBeenCalledWith(
      '/opt/homebrew/bin/kimi',
      expect.any(Array),
      expect.objectContaining({ cwd: await fs.realpath(workspaceRoot), stdio: ['ignore', 'pipe', 'pipe'] }),
    );
    const args = mocks.spawn.mock.calls[0][1] as string[];
    expect(args[0]).toBe('-p');
    expect(args[1]).toBe('inspect only');
    expect(args[args.indexOf('--output-format') + 1]).toBe('stream-json');
    expect(args[args.indexOf('-m') + 1]).toBe('kimi-k2.5');

    const spawnOptions = mocks.spawn.mock.calls[0][2] as { env: NodeJS.ProcessEnv };
    // No API key env vars — Kimi reads credentials from KIMI_CODE_HOME, not env.
    expect(spawnOptions.env.KIMI_API_KEY).toBeUndefined();
    expect(spawnOptions.env.OPENAI_API_KEY).toBeUndefined();
    expect(spawnOptions.env.ANTHROPIC_API_KEY).toBeUndefined();
    // Per-session credential isolation directory is honored.
    expect(spawnOptions.env.KIMI_CODE_HOME).toBe(path.join(tempDir, 'kimi-home'));
    expect(JSON.stringify(spawnOptions.env)).not.toContain('secret-value');

    const firstTask = mocks.upsertTask.mock.calls[0][0];
    expect(firstTask.command).toContain('kimi -p');
    expect(firstTask.command).toContain('--output-format stream-json');
    expect(firstTask.command).toContain('<prompt:redacted>');
    expect(firstTask.command).not.toContain('inspect only');
  });

  it('tolerates an empty streamed response (exit 0, no text) as a recognizable failure, not a crash', async () => {
    mocks.spawn.mockImplementation(() => createMockChild([
      JSON.stringify({ type: 'system', subtype: 'init' }),
    ], 0));

    const result = await new KimiCliAdapter().run({
      sessionId: 'session-1',
      prompt: 'inspect only',
      cwd: workspaceRoot,
      workspaceRoot,
      timeoutMs: 20_000,
      stallWarningMs: 10_000,
    });

    expect(result).toMatchObject({
      engine: 'kimi_code',
      status: 'failed',
      exitCode: 0,
    });
    expect(result.error).toContain('empty response');
    const assistantMessage = mocks.addMessageToSession.mock.calls
      .map((call) => call[1])
      .find((message) => message?.role === 'assistant');
    expect(assistantMessage?.role).toBe('assistant');
  });

  it('classifies Kimi auth failures from stderr', async () => {
    mocks.spawn.mockImplementation(() => createMockChild([], 1, 'Error: not logged in. Run `kimi login`.'));

    const result = await new KimiCliAdapter().run({
      sessionId: 'session-1',
      prompt: 'inspect only',
      cwd: workspaceRoot,
      workspaceRoot,
      timeoutMs: 20_000,
      stallWarningMs: 10_000,
    });

    expect(result).toMatchObject({
      engine: 'kimi_code',
      status: 'failed',
      exitCode: 1,
      failure: { category: 'auth', reason: 'auth_failed' },
    });
  });

  it('rejects workspace-write permission profile before spawning Kimi', async () => {
    await expect(new KimiCliAdapter().run({
      sessionId: 'session-1',
      prompt: 'inspect only',
      cwd: workspaceRoot,
      workspaceRoot,
      permissionProfile: 'workspace_write',
    })).rejects.toThrow(/read-only/);
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it('throws when the engine descriptor is not installed', async () => {
    mocks.registryGet.mockResolvedValue({
      kind: 'kimi_code',
      label: 'Kimi Code',
      installState: 'missing',
      runtimeState: 'not_configured',
      executable: false,
      lastError: 'PATH discovery pending (engine-expansion §5②).',
    });
    await expect(new KimiCliAdapter().run({
      sessionId: 'session-1',
      prompt: 'inspect only',
      cwd: workspaceRoot,
      workspaceRoot,
    })).rejects.toThrow(/PATH discovery pending/);
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it('reassembles a JSON object split across two stdout data events', async () => {
    // 一个 result 对象被劈成两个 data chunk：前半无换行，后半补全 + 换行。
    // 验证 partial-line 跨 chunk 拼接（stdoutBuffer），而非每个 chunk 独立解析。
    const fullLine = JSON.stringify({ type: 'result', subtype: 'success', result: 'reassembled kimi answer', session_id: 'kimi-session' });
    const splitAt = fullLine.indexOf('result"') + 4; // 切在 JSON 中间，确保单独任一半都不是合法 JSON
    let child: ReturnType<typeof createMockChildRaw> | undefined;
    mocks.spawn.mockImplementation(() => {
      child = createMockChildRaw([
        Buffer.from(fullLine.slice(0, splitAt)),
        Buffer.from(`${fullLine.slice(splitAt)}\n`),
      ], 0);
      return child;
    });

    const result = await new KimiCliAdapter().run({
      sessionId: 'session-1',
      prompt: 'inspect only',
      cwd: workspaceRoot,
      workspaceRoot,
      timeoutMs: 20_000,
      stallWarningMs: 10_000,
    });

    expect(result).toMatchObject({
      engine: 'kimi_code',
      status: 'completed',
      outputText: 'reassembled kimi answer',
      exitCode: 0,
    });
  });
});

function createMockChild(stdoutLines: string[], exitCode: number, stderrText = '') {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    exitCode: number | null;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.exitCode = null;
  child.kill = vi.fn(() => {
    child.exitCode = 1;
    setImmediate(() => child.emit('close', 1));
    return true;
  });

  setImmediate(() => {
    for (const line of stdoutLines) {
      child.stdout.emit('data', Buffer.from(`${line}\n`));
    }
    if (stderrText) {
      child.stderr.emit('data', Buffer.from(stderrText));
    }
    child.exitCode = exitCode;
    child.emit('close', exitCode);
  });

  return child;
}

// 像 createMockChild，但逐个 emit 调用方给的原始 Buffer chunk（不补换行），
// 用于模拟 JSONL 在 chunk 边界处被劈开的场景。
function createMockChildRaw(chunks: Buffer[], exitCode: number) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    exitCode: number | null;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.exitCode = null;
  child.kill = vi.fn(() => {
    child.exitCode = 1;
    setImmediate(() => child.emit('close', 1));
    return true;
  });

  setImmediate(() => {
    for (const chunk of chunks) {
      child.stdout.emit('data', chunk);
    }
    child.exitCode = exitCode;
    child.emit('close', exitCode);
  });

  return child;
}
