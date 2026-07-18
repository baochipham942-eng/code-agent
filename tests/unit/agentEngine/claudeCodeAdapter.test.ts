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
  enqueueSession: vi.fn(),
  registryGet: vi.fn(),
  shellEnv: {} as Record<string, string | undefined>,
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

vi.mock('../../../src/host/evaluation/reviewQueueService', () => ({
  ReviewQueueService: {
    getInstance: () => ({
      enqueueSession: mocks.enqueueSession,
    }),
  },
}));

vi.mock('../../../src/host/services/agentEngine/agentEngineRegistry', () => ({
  getAgentEngineRegistry: () => ({
    get: mocks.registryGet,
  }),
}));

vi.mock('../../../src/host/services/infra/shellEnvironment', () => ({
  getShellPath: () => '/usr/local/bin:/usr/bin:/bin',
  getShellEnvironmentValue: (key: string) => mocks.shellEnv[key],
}));

import {
  buildClaudeCodeArgs,
  ClaudeCodeAdapter,
  parseClaudeCodeJsonLine,
} from '../../../src/host/services/agentEngine/claudeCodeAdapter';
import { createClaudeResumeLaunch } from '../../../src/host/services/agentEngine/externalEngineResumeBuilders';
import type { ExternalEngineDurableLifecycle } from '../../../src/host/services/agentEngine/externalEngineDurableLifecycle';

describe('Claude Code adapter helpers', () => {
  it('uses Claude Code print mode with plan permissions and read-only tools', () => {
    const args = buildClaudeCodeArgs('workspace_write', 'sonnet');

    expect(args).toContain('-p');
    expect(args).toContain('--verbose');
    expect(args).toContain('--model');
    expect(args[args.indexOf('--model') + 1]).toBe('sonnet');
    expect(args).toContain('--safe-mode');
    expect(args).not.toContain('--setting-sources');
    expect(args).toContain('--disable-slash-commands');
    expect(args).toContain('stream-json');
    expect(args).toContain('plan');
    expect(args).toContain('--tools');
    expect(args).toContain('Read,Glob,Grep,LS');
    expect(args).toContain('--no-chrome');
    expect(args).toContain('--strict-mcp-config');
    expect(args).toContain('--include-partial-messages');
    expect(args).not.toContain('--no-session-persistence');
    expect(args).not.toContain('--dangerously-skip-permissions');
    expect(args).not.toContain('--allow-dangerously-skip-permissions');
    expect(args).not.toContain('bypassPermissions');
  });

  it('parses Claude Code stream-json assistant, tool, and result events', () => {
    expect(parseClaudeCodeJsonLine(JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'thinking' },
          { type: 'tool_use', name: 'Read', input: { file_path: 'x.ts' } },
        ],
      },
    }))).toMatchObject({
      textDelta: 'thinking',
      toolName: 'Read',
    });

    expect(parseClaudeCodeJsonLine(JSON.stringify({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'streaming' },
      },
      session_id: 'claude-session',
    }))).toMatchObject({
      textDelta: 'streaming',
      textDeltaSource: 'stream',
      externalSessionId: 'claude-session',
    });

    expect(parseClaudeCodeJsonLine(JSON.stringify({
      type: 'result',
      subtype: 'success',
      result: 'final answer',
      session_id: 'claude-session',
    }))).toMatchObject({
      finalText: 'final answer',
      externalSessionId: 'claude-session',
      status: 'Claude Code result: success',
    });

    expect(parseClaudeCodeJsonLine(JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: true,
      api_error_status: 401,
      result: 'Failed to authenticate. API Error: 401 Invalid authentication credentials',
      session_id: 'claude-session',
    }))).toMatchObject({
      finalText: 'Failed to authenticate. API Error: 401 Invalid authentication credentials',
      error: 'Failed to authenticate. API Error: 401 Invalid authentication credentials',
      statusCode: 401,
      status: 'Claude Code result: success',
    });
  });
});

describe('ClaudeCodeAdapter.run', () => {
  let tempDir: string;
  let workspaceRoot: string;
  const oldAnthropicKey = process.env.ANTHROPIC_API_KEY;
  const oldAnthropicAuthToken = process.env.ANTHROPIC_AUTH_TOKEN;
  const oldClaudeCodeOAuthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  const oldClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
  const oldOpenAiKey = process.env.OPENAI_API_KEY;
  const oldGithubToken = process.env.GITHUB_TOKEN;

  beforeEach(async () => {
    vi.clearAllMocks();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-adapter-test-'));
    workspaceRoot = path.join(tempDir, 'workspace');
    await fs.mkdir(workspaceRoot, { recursive: true });
    mocks.getLogsPath.mockReturnValue(path.join(tempDir, 'logs'));
    mocks.registryGet.mockResolvedValue({
      kind: 'claude_code',
      installState: 'installed',
      runtimeState: 'ready',
      executable: false,
      binaryPath: '/Users/linchen/.local/bin/claude',
    });
    mocks.addMessageToSession.mockResolvedValue(undefined);
    mocks.updateSession.mockResolvedValue(undefined);
    mocks.shellEnv = {};
  });

  afterEach(async () => {
    if (oldAnthropicKey === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = oldAnthropicKey;
    }
    if (oldAnthropicAuthToken === undefined) {
      delete process.env.ANTHROPIC_AUTH_TOKEN;
    } else {
      process.env.ANTHROPIC_AUTH_TOKEN = oldAnthropicAuthToken;
    }
    if (oldClaudeCodeOAuthToken === undefined) {
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    } else {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = oldClaudeCodeOAuthToken;
    }
    if (oldClaudeConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = oldClaudeConfigDir;
    }
    if (oldOpenAiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = oldOpenAiKey;
    }
    if (oldGithubToken === undefined) {
      delete process.env.GITHUB_TOKEN;
    } else {
      process.env.GITHUB_TOKEN = oldGithubToken;
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('runs Claude Code through stdin, writes logs, and inherits Claude auth without leaking values to the ledger', async () => {
    process.env.ANTHROPIC_API_KEY = 'super-secret-value';
    process.env.ANTHROPIC_AUTH_TOKEN = 'anthropic-auth-secret-value';
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'claude-oauth-secret-value';
    process.env.CLAUDE_CONFIG_DIR = path.join(tempDir, 'claude-config');
    process.env.OPENAI_API_KEY = 'openai-super-secret-value';
    process.env.GITHUB_TOKEN = 'github-super-secret-value';
    let child: ReturnType<typeof createMockChild>;
    mocks.spawn.mockImplementation(() => {
      child = createMockChild([
        JSON.stringify({ type: 'system', subtype: 'init', session_id: 'claude-session' }),
        JSON.stringify({
          type: 'stream_event',
          event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'streamed ' } },
          session_id: 'claude-session',
        }),
        JSON.stringify({
          type: 'stream_event',
          event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'text' } },
          session_id: 'claude-session',
        }),
        JSON.stringify({
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'streamed text' }],
          },
        }),
        JSON.stringify({ type: 'result', subtype: 'success', result: 'final text' }),
      ], 0);
      return child;
    });

    const result = await new ClaudeCodeAdapter().run({
      sessionId: 'session-1',
      prompt: 'inspect only',
      cwd: workspaceRoot,
      workspaceRoot,
      model: 'sonnet',
      timeoutMs: 20_000,
      stallWarningMs: 10_000,
    });

    expect(result).toMatchObject({
      engine: 'claude_code',
      status: 'completed',
      outputText: 'final text',
      exitCode: 0,
    });
    expect(mocks.spawn).toHaveBeenCalledWith(
      '/Users/linchen/.local/bin/claude',
      expect.arrayContaining([
        '-p',
        '--verbose',
        '--model',
        'sonnet',
        '--safe-mode',
        '--disable-slash-commands',
        '--output-format',
        'stream-json',
        '--permission-mode',
        'plan',
        '--tools',
        'Read,Glob,Grep,LS',
      ]),
      expect.objectContaining({ cwd: await fs.realpath(workspaceRoot), stdio: ['pipe', 'pipe', 'pipe'] }),
    );
    expect(mocks.spawn.mock.calls[0][0]).not.toBe('/usr/bin/cc');
    expect(child!.stdin.end).toHaveBeenCalledWith('inspect only');

    const spawnOptions = mocks.spawn.mock.calls[0][2] as { env: NodeJS.ProcessEnv };
    expect(spawnOptions.env.ANTHROPIC_API_KEY).toBe('super-secret-value');
    expect(spawnOptions.env.ANTHROPIC_AUTH_TOKEN).toBe('anthropic-auth-secret-value');
    expect(spawnOptions.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('claude-oauth-secret-value');
    expect(spawnOptions.env.CLAUDE_CONFIG_DIR).toBe(path.join(tempDir, 'claude-config'));
    expect(spawnOptions.env.OPENAI_API_KEY).toBeUndefined();
    expect(spawnOptions.env.GITHUB_TOKEN).toBeUndefined();

    const firstTask = mocks.upsertTask.mock.calls[0][0];
    expect(firstTask.command).toContain('<prompt:redacted>');
    expect(firstTask.command).toContain('--verbose');
    expect(firstTask.command).toContain('--model sonnet');
    expect(firstTask.command).toContain('--safe-mode');
    expect(firstTask.command).not.toContain('--setting-sources local');
    expect(firstTask.command).toContain('--disable-slash-commands');
    expect(firstTask.command).toContain('--tools Read,Glob,Grep,LS');
    expect(firstTask.command).toContain('--strict-mcp-config');
    expect(firstTask.command).toContain('--include-partial-messages');
    expect(firstTask.metadata.model).toBe('sonnet');
    expect(firstTask.metadata.env.keys).toEqual(expect.arrayContaining([
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_AUTH_TOKEN',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'CLAUDE_CONFIG_DIR',
    ]));
    expect(firstTask.metadata.env.redacted).toEqual(expect.arrayContaining([
      'GITHUB_TOKEN',
      'OPENAI_API_KEY',
    ]));
    expect(firstTask.metadata.env.redacted).not.toEqual(expect.arrayContaining([
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_AUTH_TOKEN',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'CLAUDE_CONFIG_DIR',
    ]));
    expect(JSON.stringify(firstTask)).not.toContain('super-secret-value');
    expect(JSON.stringify(firstTask)).not.toContain('anthropic-auth-secret-value');
    expect(JSON.stringify(firstTask)).not.toContain('claude-oauth-secret-value');
    expect(JSON.stringify(firstTask)).not.toContain('openai-super-secret-value');
    expect(JSON.stringify(firstTask)).not.toContain('github-super-secret-value');

    const textDeltas = mocks.webContentsSend.mock.calls
      .map((call) => call[1])
      .filter((event) => event?.type === 'message_delta')
      .map((event) => event.data.text);
    expect(textDeltas).toEqual(['streamed ', 'text']);

    const logPath = result.logPath || '';
    expect(logPath).toContain(path.join('agent-engines', 'claude-code'));
    await expect(fs.readFile(logPath, 'utf8')).resolves.toContain('final text');
    await expect(fs.readFile(logPath.replace(/\.log$/, '.last.md'), 'utf8')).resolves.toBe('final text');

    const assistantMessage = mocks.addMessageToSession.mock.calls
      .map((call) => call[1])
      .find((message) => message?.role === 'assistant');
    expect(assistantMessage?.modelDecision).toMatchObject({
      requestedProvider: 'claude_code',
      requestedModel: 'sonnet',
      resolvedProvider: 'claude_code',
      resolvedModel: 'sonnet',
      reason: 'user-selected',
      externalEngine: {
        kind: 'claude_code',
        model: 'sonnet',
        runtimeState: 'ready',
      },
    });
  });

  it('inherits Claude auth from the captured login shell when the desktop process env is missing it', async () => {
    mocks.shellEnv.ANTHROPIC_AUTH_TOKEN = 'shell-auth-secret-value';
    mocks.shellEnv.CLAUDE_CODE_OAUTH_TOKEN = 'shell-oauth-secret-value';
    mocks.spawn.mockImplementation(() => createMockChild([
      JSON.stringify({ type: 'result', subtype: 'success', result: 'ok' }),
    ], 0));

    await new ClaudeCodeAdapter().run({
      sessionId: 'session-1',
      prompt: 'inspect only',
      cwd: workspaceRoot,
      workspaceRoot,
      timeoutMs: 20_000,
      stallWarningMs: 10_000,
    });

    const spawnOptions = mocks.spawn.mock.calls[0][2] as { env: NodeJS.ProcessEnv };
    expect(spawnOptions.env.ANTHROPIC_AUTH_TOKEN).toBe('shell-auth-secret-value');
    expect(spawnOptions.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('shell-oauth-secret-value');

    const firstTask = mocks.upsertTask.mock.calls[0][0];
    expect(firstTask.metadata.env.keys).toEqual(expect.arrayContaining([
      'ANTHROPIC_AUTH_TOKEN',
      'CLAUDE_CODE_OAUTH_TOKEN',
    ]));
    expect(JSON.stringify(firstTask)).not.toContain('shell-auth-secret-value');
    expect(JSON.stringify(firstTask)).not.toContain('shell-oauth-secret-value');
  });

  it('reconstructs partial stream-json text without duplicating assistant snapshots or terminal clutter', async () => {
    mocks.spawn.mockImplementation(() => createMockChild([
      'Claude Code v9.9.9 terminal footer should stay out of transcript',
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'claude-session' }),
      JSON.stringify({
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'long ' } },
        session_id: 'claude-session',
      }),
      JSON.stringify({
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'reply' } },
        session_id: 'claude-session',
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'long reply' }],
        },
      }),
      'tokens used: 9999',
    ], 0));

    const result = await new ClaudeCodeAdapter().run({
      sessionId: 'session-1',
      prompt: 'write a long reply',
      cwd: workspaceRoot,
      workspaceRoot,
      timeoutMs: 20_000,
      stallWarningMs: 10_000,
    });

    expect(result).toMatchObject({
      engine: 'claude_code',
      status: 'completed',
      outputText: 'long reply',
      exitCode: 0,
    });
    const textDeltas = mocks.webContentsSend.mock.calls
      .map((call) => call[1])
      .filter((event) => event?.type === 'message_delta')
      .map((event) => event.data.text);
    expect(textDeltas).toEqual(['long ', 'reply']);
    const logPath = result.logPath || '';
    await expect(fs.readFile(logPath, 'utf8')).resolves.toContain('tokens used: 9999');
    await expect(fs.readFile(logPath.replace(/\.log$/, '.last.md'), 'utf8')).resolves.toBe('long reply');
  });

  it('records failure when Claude Code exits non-zero', async () => {
    mocks.spawn.mockImplementation(() => createMockChild([], 1, 'boom from claude'));

    const result = await new ClaudeCodeAdapter().run({
      sessionId: 'session-1',
      prompt: 'inspect only',
      cwd: workspaceRoot,
      workspaceRoot,
      timeoutMs: 20_000,
      stallWarningMs: 10_000,
    });

    expect(result).toMatchObject({
      engine: 'claude_code',
      status: 'failed',
      error: 'boom from claude',
      exitCode: 1,
    });
    expect(mocks.enqueueSession).not.toHaveBeenCalled();
    expect(mocks.updateSession).toHaveBeenLastCalledWith(
      'session-1',
      expect.objectContaining({ status: 'error' }),
      { allowEngineUpdate: true },
    );
  });

  it('treats exit 0 with only system and tool events as an empty-response failure', async () => {
    mocks.spawn.mockImplementation(() => createMockChild([
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'claude-session' }),
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'x.ts' } }] },
      }),
    ], 0));

    const result = await new ClaudeCodeAdapter().run({
      sessionId: 'session-1',
      prompt: 'inspect only',
      cwd: workspaceRoot,
      workspaceRoot,
      timeoutMs: 20_000,
      stallWarningMs: 10_000,
    });

    expect(result).toMatchObject({
      engine: 'claude_code',
      status: 'failed',
      exitCode: 0,
    });
    expect(result.error).toContain('empty response');
  });

  it('uses Claude stream-json error text as the failure reason when stderr is empty', async () => {
    mocks.spawn.mockImplementation(() => createMockChild([
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'claude-session' }),
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: true,
        api_error_status: 401,
        result: 'authentication_failed',
        session_id: 'claude-session',
      }),
    ], 1));

    const result = await new ClaudeCodeAdapter().run({
      sessionId: 'session-1',
      prompt: 'inspect only',
      cwd: workspaceRoot,
      workspaceRoot,
      timeoutMs: 20_000,
      stallWarningMs: 10_000,
    });

    expect(result).toMatchObject({
      engine: 'claude_code',
      status: 'failed',
      error: 'authentication_failed',
      outputText: 'authentication_failed',
      exitCode: 1,
      failure: {
        category: 'auth',
        reason: 'auth_failed',
        statusCode: 401,
        reliability: { authState: 'needs_login' },
      },
    });
    expect(mocks.updateSession).toHaveBeenLastCalledWith(
      'session-1',
      expect.objectContaining({
        status: 'error',
        engine: expect.objectContaining({
          kind: 'claude_code',
          failure: expect.objectContaining({
            category: 'auth',
            reason: 'auth_failed',
            statusCode: 401,
            reliability: { authState: 'needs_login' },
          }),
        }),
      }),
      { allowEngineUpdate: true },
    );
    expect(mocks.upsertTask).toHaveBeenLastCalledWith(expect.objectContaining({
      failure: expect.objectContaining({
        message: 'authentication_failed',
        reason: 'auth_failed',
      }),
    }));
    expect(mocks.appendEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'agent_engine.failed',
      data: expect.objectContaining({
        failure: expect.objectContaining({
          category: 'auth',
          reason: 'auth_failed',
        }),
      }),
    }));
    const assistantMessage = mocks.addMessageToSession.mock.calls
      .map((call) => call[1])
      .find((message) => message?.role === 'assistant');
    expect(assistantMessage).toMatchObject({
      role: 'assistant',
      content: expect.stringContaining('Claude Code 认证失败'),
      modelDecision: expect.objectContaining({
        externalEngine: expect.objectContaining({
          kind: 'claude_code',
          failure: expect.objectContaining({
            category: 'auth',
            reason: 'auth_failed',
          }),
        }),
      }),
    });
    expect(mocks.webContentsSend).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        type: 'message',
        data: expect.objectContaining({ role: 'assistant' }),
      }),
    );
  });

  it('rejects cwd outside workspace before spawning Claude Code', async () => {
    const outsideCwd = path.join(tempDir, 'outside');
    await fs.mkdir(outsideCwd, { recursive: true });

    await expect(new ClaudeCodeAdapter().run({
      sessionId: 'session-1',
      prompt: 'inspect only',
      cwd: outsideCwd,
      workspaceRoot,
    })).rejects.toThrow(/inside workspace/);

    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it('rejects workspace-write permission profile before spawning Claude Code', async () => {
    await expect(new ClaudeCodeAdapter().run({
      sessionId: 'session-1',
      prompt: 'inspect only',
      cwd: workspaceRoot,
      workspaceRoot,
      permissionProfile: 'workspace_write',
    })).rejects.toThrow(/read-only/);

    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it('spawns Claude print resume without a new-session fallback and confirms the target session id', async () => {
    mocks.spawn.mockImplementation(() => createMockChild([
      JSON.stringify({ type: 'result', subtype: 'success', result: 'resumed', session_id: 'target-session' }),
    ], 0));
    const cwd = await fs.realpath(workspaceRoot);
    const lifecycle = {
      runId: 'logical-run', attempt: 3, ownerEpoch: 6,
      attachProcess: vi.fn(async () => undefined),
      observeStdout: vi.fn(), observeStderr: vi.fn(), observeModelUsage: vi.fn(), observeNormalizedEvent: vi.fn(),
      persistExternalSessionId: vi.fn(), terminateProcess: vi.fn(async () => undefined),
      finish: vi.fn(async () => undefined),
    } as unknown as ExternalEngineDurableLifecycle;
    const resumeLaunch = createClaudeResumeLaunch({
      runId: 'logical-run', sessionId: 'session-1', attempt: 3, ownerEpoch: 6,
      externalSessionId: 'target-session', cwd, permissionProfile: 'read_only',
    });
    const result = await new ClaudeCodeAdapter().run({
      sessionId: 'session-1', prompt: '', cwd, workspaceRoot: cwd,
      permissionProfile: 'read_only', durableLifecycle: lifecycle, resumeLaunch,
    });
    expect(result).toMatchObject({ runId: 'logical-run', sessionId: 'session-1', status: 'completed' });
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    expect(mocks.spawn.mock.calls[0][1]).toEqual(resumeLaunch.args);
    expect(resumeLaunch.args).toContain('--resume');
    expect(resumeLaunch.args).not.toContain('--no-session-persistence');
    expect(lifecycle.persistExternalSessionId).toHaveBeenCalledWith('target-session');
  });
});

function createMockChild(stdoutLines: string[], exitCode: number, stderrText = '') {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    stdin: { end: ReturnType<typeof vi.fn> };
    exitCode: number | null;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { end: vi.fn() };
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
