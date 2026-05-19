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

vi.mock('../../../src/main/evaluation/reviewQueueService', () => ({
  ReviewQueueService: {
    getInstance: () => ({
      enqueueSession: mocks.enqueueSession,
    }),
  },
}));

vi.mock('../../../src/main/services/agentEngine/agentEngineRegistry', () => ({
  getAgentEngineRegistry: () => ({
    get: mocks.registryGet,
  }),
}));

import {
  buildClaudeCodeArgs,
  ClaudeCodeAdapter,
  parseClaudeCodeJsonLine,
} from '../../../src/main/services/agentEngine/claudeCodeAdapter';

describe('Claude Code adapter helpers', () => {
  it('uses Claude Code print mode with plan permissions and read-only tools', () => {
    const args = buildClaudeCodeArgs('workspace_write');

    expect(args).toContain('-p');
    expect(args).toContain('--verbose');
    expect(args).toContain('--setting-sources');
    expect(args).toContain('local');
    expect(args).toContain('--disable-slash-commands');
    expect(args).toContain('stream-json');
    expect(args).toContain('plan');
    expect(args).toContain('--tools');
    expect(args).toContain('Read,Glob,Grep,LS');
    expect(args).toContain('--no-chrome');
    expect(args).toContain('--strict-mcp-config');
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
  });
});

describe('ClaudeCodeAdapter.run', () => {
  let tempDir: string;
  let workspaceRoot: string;
  const oldAnthropicKey = process.env.ANTHROPIC_API_KEY;
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
  });

  afterEach(async () => {
    if (oldAnthropicKey === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = oldAnthropicKey;
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

  it('runs Claude Code through stdin, writes logs, and keeps sensitive env values out of child env and ledger', async () => {
    process.env.ANTHROPIC_API_KEY = 'super-secret-value';
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
        '--setting-sources',
        'local',
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
    expect(spawnOptions.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(spawnOptions.env.OPENAI_API_KEY).toBeUndefined();
    expect(spawnOptions.env.GITHUB_TOKEN).toBeUndefined();
    expect(JSON.stringify(spawnOptions.env)).not.toContain('super-secret-value');

    const firstTask = mocks.upsertTask.mock.calls[0][0];
    expect(firstTask.command).toContain('<prompt:redacted>');
    expect(firstTask.command).toContain('--verbose');
    expect(firstTask.command).toContain('--setting-sources local');
    expect(firstTask.command).toContain('--disable-slash-commands');
    expect(firstTask.command).toContain('--tools Read,Glob,Grep,LS');
    expect(firstTask.metadata.env.redacted).toEqual(expect.arrayContaining([
      'ANTHROPIC_API_KEY',
      'GITHUB_TOKEN',
      'OPENAI_API_KEY',
    ]));
    expect(JSON.stringify(firstTask)).not.toContain('super-secret-value');

    const textDeltas = mocks.webContentsSend.mock.calls
      .map((call) => call[1])
      .filter((event) => event?.type === 'message_delta')
      .map((event) => event.data.text);
    expect(textDeltas).toEqual(['streamed ', 'text']);

    const logPath = result.logPath || '';
    expect(logPath).toContain(path.join('agent-engines', 'claude-code'));
    await expect(fs.readFile(logPath, 'utf8')).resolves.toContain('final text');
    await expect(fs.readFile(logPath.replace(/\.log$/, '.last.md'), 'utf8')).resolves.toBe('final text');
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
