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

vi.mock('../../../src/main/platform', () => ({
  getLogsPath: () => mocks.getLogsPath(),
  BrowserWindow: {
    getAllWindows: () => [{ webContents: { send: mocks.webContentsSend } }],
  },
}));

vi.mock('../../../src/main/services/infra/sessionManager', () => ({
  getSessionManager: () => ({
    addMessageToSession: mocks.addMessageToSession,
    updateSession: mocks.updateSession,
  }),
}));

vi.mock('../../../src/main/services/infra/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../../../src/main/tasks/backgroundTaskLedger', () => ({
  getBackgroundTaskLedger: () => ({
    upsertTask: mocks.upsertTask,
    appendEvent: mocks.appendEvent,
    addOutputRef: mocks.addOutputRef,
    queueNotification: mocks.queueNotification,
  }),
}));

vi.mock('../../../src/main/services/agentEngine/agentEngineRegistry', () => ({
  getAgentEngineRegistry: () => ({
    get: mocks.registryGet,
  }),
}));

import {
  buildMimoArgs,
  MimoCliAdapter,
  parseMimoJsonLine,
} from '../../../src/main/services/agentEngine/mimoCliAdapter';

describe('buildMimoArgs', () => {
  it('builds `mimo run "<prompt>" --format json` with the prompt as a positional arg', () => {
    const args = buildMimoArgs('inspect only', 'mimo-coder');
    expect(args).toEqual(['run', 'inspect only', '--format', 'json', '--model', 'mimo-coder']);
    // prompt must be a CLI arg, never sent over stdin
    expect(args[1]).toBe('inspect only');
    expect(args[args.indexOf('--format') + 1]).toBe('json');
  });

  it('omits --model when no model is provided', () => {
    expect(buildMimoArgs('hi')).toEqual(['run', 'hi', '--format', 'json']);
  });
});

describe('parseMimoJsonLine', () => {
  it('returns null for blank or non-JSON lines', () => {
    expect(parseMimoJsonLine('')).toBeNull();
    expect(parseMimoJsonLine('   ')).toBeNull();
    expect(parseMimoJsonLine('not json')).toBeNull();
  });

  it('extracts streamed assistant text deltas', () => {
    expect(parseMimoJsonLine(JSON.stringify({ type: 'message_delta', delta: 'streamed text' })))
      .toMatchObject({ textDelta: 'streamed text' });
    expect(parseMimoJsonLine(JSON.stringify({ type: 'assistant', text: 'hello' })))
      .toMatchObject({ textDelta: 'hello' });
  });

  it('maps final result text, tool calls, and CLI errors', () => {
    expect(parseMimoJsonLine(JSON.stringify({ type: 'result', result: 'final answer' })))
      .toMatchObject({ finalText: 'final answer' });

    expect(parseMimoJsonLine(JSON.stringify({
      type: 'tool_call',
      item: { name: 'Read', type: 'tool_use' },
    }))).toMatchObject({ toolName: 'Read' });

    expect(parseMimoJsonLine(JSON.stringify({
      type: 'error',
      error: { message: 'API Error: 429 quota exhausted', status: 429 },
    }))).toMatchObject({ error: 'API Error: 429 quota exhausted', statusCode: 429 });
  });

  it('does not treat result payloads as streaming deltas', () => {
    const parsed = parseMimoJsonLine(JSON.stringify({ type: 'result', result: 'done', text: 'done' }));
    expect(parsed?.finalText).toBe('done');
    expect(parsed?.textDelta).toBeUndefined();
  });
});

describe('MimoCliAdapter.run', () => {
  let tempDir: string;
  let workspaceRoot: string;
  const ENV_KEYS = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GITHUB_TOKEN', 'MIMO_HOME'] as const;
  const originalEnv: Partial<Record<typeof ENV_KEYS[number], string>> = {};

  beforeEach(async () => {
    vi.clearAllMocks();
    for (const key of ENV_KEYS) {
      originalEnv[key] = process.env[key];
    }
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mimo-adapter-test-'));
    workspaceRoot = path.join(tempDir, 'workspace');
    await fs.mkdir(workspaceRoot, { recursive: true });
    mocks.getLogsPath.mockReturnValue(path.join(tempDir, 'logs'));
    mocks.registryGet.mockResolvedValue({
      kind: 'mimo_code',
      label: 'MiMo-Code',
      installState: 'installed',
      runtimeState: 'ready',
      executable: true,
      binaryPath: '/opt/homebrew/bin/mimo',
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

  it('runs MiMo via positional prompt arg, parses JSONL, and strips sensitive keys from child env + ledger', async () => {
    process.env.OPENAI_API_KEY = 'openai-secret-value';
    process.env.ANTHROPIC_API_KEY = 'anthropic-secret-value';
    process.env.GITHUB_TOKEN = 'github-secret-value';
    process.env.MIMO_HOME = path.join(tempDir, 'mimo-home');

    let child: ReturnType<typeof createMockChild> | undefined;
    mocks.spawn.mockImplementation(() => {
      child = createMockChild([
        JSON.stringify({ type: 'message_delta', delta: 'mimo streamed text' }),
        JSON.stringify({ type: 'result', result: 'mimo final answer' }),
      ], 0);
      return child;
    });

    const result = await new MimoCliAdapter().run({
      sessionId: 'session-1',
      prompt: 'inspect only',
      cwd: workspaceRoot,
      workspaceRoot,
      model: 'mimo-coder',
      timeoutMs: 20_000,
      stallWarningMs: 10_000,
    });

    expect(result).toMatchObject({
      engine: 'mimo_code',
      status: 'completed',
      outputText: 'mimo final answer',
      exitCode: 0,
    });

    expect(mocks.spawn).toHaveBeenCalledWith(
      '/opt/homebrew/bin/mimo',
      expect.any(Array),
      expect.objectContaining({ cwd: await fs.realpath(workspaceRoot), stdio: ['ignore', 'pipe', 'pipe'] }),
    );
    const args = mocks.spawn.mock.calls[0][1] as string[];
    expect(args[0]).toBe('run');
    expect(args).toContain('inspect only');
    expect(args).toContain('--format');
    expect(args[args.indexOf('--format') + 1]).toBe('json');
    expect(args[args.indexOf('--model') + 1]).toBe('mimo-coder');

    const spawnOptions = mocks.spawn.mock.calls[0][2] as { env: NodeJS.ProcessEnv };
    expect(spawnOptions.env.OPENAI_API_KEY).toBeUndefined();
    expect(spawnOptions.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(spawnOptions.env.GITHUB_TOKEN).toBeUndefined();
    expect(spawnOptions.env.MIMO_HOME).toBe(process.env.MIMO_HOME);
    expect(JSON.stringify(spawnOptions.env)).not.toContain('secret-value');

    const firstTask = mocks.upsertTask.mock.calls[0][0];
    expect(firstTask.command).toContain('mimo run');
    expect(firstTask.command).toContain('--format json');
    expect(firstTask.command).toContain('<prompt:redacted>');
    expect(firstTask.command).not.toContain('inspect only');
    expect(firstTask.metadata.env.redacted).toEqual(expect.arrayContaining([
      'ANTHROPIC_API_KEY',
      'GITHUB_TOKEN',
      'OPENAI_API_KEY',
    ]));

    const assistantMessage = mocks.addMessageToSession.mock.calls
      .map((call) => call[1])
      .find((message) => message?.role === 'assistant');
    expect(assistantMessage?.modelDecision).toMatchObject({
      requestedProvider: 'mimo_code',
      resolvedProvider: 'mimo_code',
      reason: 'user-selected',
      externalEngine: { kind: 'mimo_code', model: 'mimo-coder' },
    });
  });

  it('classifies MiMo quota failures for ledger and result diagnostics', async () => {
    mocks.spawn.mockImplementation(() => createMockChild([], 1, 'API Error: 429 quota exhausted'));

    const result = await new MimoCliAdapter().run({
      sessionId: 'session-1',
      prompt: 'inspect only',
      cwd: workspaceRoot,
      workspaceRoot,
      model: 'mimo-coder',
      timeoutMs: 20_000,
      stallWarningMs: 10_000,
    });

    expect(result).toMatchObject({
      engine: 'mimo_code',
      status: 'failed',
      error: 'API Error: 429 quota exhausted',
      exitCode: 1,
      failure: { category: 'quota', reason: 'quota_exhausted', statusCode: 429 },
    });
    expect(mocks.appendEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'agent_engine.failed',
      data: expect.objectContaining({
        failure: expect.objectContaining({ category: 'quota', reason: 'quota_exhausted' }),
      }),
    }));
  });

  it('tolerates an empty streamed response (exit 0, no text) as a recognizable failure, not a crash', async () => {
    // 只发一个非正文事件（无 textDelta / finalText），CLI 正常退出 0。
    // 与 Kimi 对称：应归一成可识别失败（empty response），不落到「completed without text output」兜底成功。
    mocks.spawn.mockImplementation(() => createMockChild([
      JSON.stringify({ type: 'tool_call', item: { name: 'Read', type: 'tool_use' } }),
    ], 0));

    const result = await new MimoCliAdapter().run({
      sessionId: 'session-1',
      prompt: 'inspect only',
      cwd: workspaceRoot,
      workspaceRoot,
      timeoutMs: 20_000,
      stallWarningMs: 10_000,
    });

    expect(result).toMatchObject({
      engine: 'mimo_code',
      status: 'failed',
      exitCode: 0,
    });
    expect(result.error).toContain('empty response');
    const assistantMessage = mocks.addMessageToSession.mock.calls
      .map((call) => call[1])
      .find((message) => message?.role === 'assistant');
    expect(assistantMessage?.role).toBe('assistant');
  });

  it('rejects workspace-write permission profile before spawning MiMo', async () => {
    await expect(new MimoCliAdapter().run({
      sessionId: 'session-1',
      prompt: 'inspect only',
      cwd: workspaceRoot,
      workspaceRoot,
      permissionProfile: 'workspace_write',
    })).rejects.toThrow(/read-only/);
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it('rejects cwd outside workspace before spawning MiMo', async () => {
    const outsideCwd = path.join(tempDir, 'outside');
    await fs.mkdir(outsideCwd, { recursive: true });
    await expect(new MimoCliAdapter().run({
      sessionId: 'session-1',
      prompt: 'inspect only',
      cwd: outsideCwd,
      workspaceRoot,
    })).rejects.toThrow(/inside workspace/);
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it('throws when the engine descriptor is not installed', async () => {
    mocks.registryGet.mockResolvedValue({
      kind: 'mimo_code',
      label: 'MiMo-Code',
      installState: 'missing',
      runtimeState: 'not_configured',
      executable: false,
      lastError: 'PATH discovery pending (engine-expansion §5②).',
    });
    await expect(new MimoCliAdapter().run({
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
    const fullLine = JSON.stringify({ type: 'result', result: 'reassembled mimo answer' });
    const splitAt = fullLine.indexOf('result"') + 4; // 切在 JSON 中间，确保单独任一半都不是合法 JSON
    let child: ReturnType<typeof createMockChildRaw> | undefined;
    mocks.spawn.mockImplementation(() => {
      child = createMockChildRaw([
        Buffer.from(fullLine.slice(0, splitAt)),
        Buffer.from(`${fullLine.slice(splitAt)}\n`),
      ], 0);
      return child;
    });

    const result = await new MimoCliAdapter().run({
      sessionId: 'session-1',
      prompt: 'inspect only',
      cwd: workspaceRoot,
      workspaceRoot,
      timeoutMs: 20_000,
      stallWarningMs: 10_000,
    });

    expect(result).toMatchObject({
      engine: 'mimo_code',
      status: 'completed',
      outputText: 'reassembled mimo answer',
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
