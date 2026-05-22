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

import { CodexCliAdapter } from '../../../src/main/services/agentEngine/codexCliAdapter';

const ENV_KEYS = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GITHUB_TOKEN', 'CODEX_HOME'] as const;
const originalEnv: Partial<Record<typeof ENV_KEYS[number], string>> = {};

describe('CodexCliAdapter.run', () => {
  let tempDir: string;
  let workspaceRoot: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    for (const key of ENV_KEYS) {
      originalEnv[key] = process.env[key];
    }
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-adapter-test-'));
    workspaceRoot = path.join(tempDir, 'workspace');
    await fs.mkdir(workspaceRoot, { recursive: true });
    mocks.getLogsPath.mockReturnValue(path.join(tempDir, 'logs'));
    mocks.registryGet.mockResolvedValue({
      kind: 'codex_cli',
      installState: 'installed',
      runtimeState: 'ready',
      executable: true,
      binaryPath: '/opt/homebrew/bin/codex',
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

  it('runs Codex CLI with read-only sandbox and strips sensitive API keys from child env and ledger', async () => {
    process.env.OPENAI_API_KEY = 'openai-secret-value';
    process.env.ANTHROPIC_API_KEY = 'anthropic-secret-value';
    process.env.GITHUB_TOKEN = 'github-secret-value';
    process.env.CODEX_HOME = path.join(tempDir, 'codex-home');

    let child: ReturnType<typeof createMockChild> | undefined;
    mocks.spawn.mockImplementation(() => {
      child = createMockChild([
        JSON.stringify({ type: 'message_delta', delta: 'codex streamed text' }),
      ], 0);
      return child;
    });

    const result = await new CodexCliAdapter().run({
      sessionId: 'session-1',
      prompt: 'inspect only',
      cwd: workspaceRoot,
      workspaceRoot,
      model: 'gpt-5',
      timeoutMs: 20_000,
      stallWarningMs: 10_000,
    });

    expect(result).toMatchObject({
      engine: 'codex_cli',
      status: 'completed',
      outputText: 'codex streamed text',
      exitCode: 0,
    });

    const args = mocks.spawn.mock.calls[0][1] as string[];
    expect(mocks.spawn).toHaveBeenCalledWith(
      '/opt/homebrew/bin/codex',
      expect.any(Array),
      expect.objectContaining({ cwd: await fs.realpath(workspaceRoot), stdio: ['pipe', 'pipe', 'pipe'] }),
    );
    expect(args).toContain('--sandbox');
    expect(args).toContain('--model');
    expect(args[args.indexOf('--model') + 1]).toBe('gpt-5');
    expect(args[args.indexOf('--sandbox') + 1]).toBe('read-only');
    expect(args).not.toContain('workspace-write');
    expect(args).toContain('-C');
    expect(args[args.indexOf('-C') + 1]).toBe(await fs.realpath(workspaceRoot));
    expect(args).toContain('--skip-git-repo-check');
    expect(args).toContain('--output-last-message');
    expect(child?.stdin.end).toHaveBeenCalledWith('inspect only');

    const spawnOptions = mocks.spawn.mock.calls[0][2] as { env: NodeJS.ProcessEnv };
    expect(spawnOptions.env.OPENAI_API_KEY).toBeUndefined();
    expect(spawnOptions.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(spawnOptions.env.GITHUB_TOKEN).toBeUndefined();
    expect(spawnOptions.env.CODEX_HOME).toBe(process.env.CODEX_HOME);
    expect(JSON.stringify(spawnOptions.env)).not.toContain('secret-value');

    const firstTask = mocks.upsertTask.mock.calls[0][0];
    expect(firstTask.command).toContain('--model gpt-5');
    expect(firstTask.command).toContain('--sandbox read-only');
    expect(firstTask.metadata.model).toBe('gpt-5');
    expect(firstTask.command).toContain('<prompt:redacted>');
    expect(firstTask.command).not.toContain('inspect only');
    expect(firstTask.metadata.env.redacted).toEqual(expect.arrayContaining([
      'ANTHROPIC_API_KEY',
      'GITHUB_TOKEN',
      'OPENAI_API_KEY',
    ]));
    expect(JSON.stringify(firstTask)).not.toContain('secret-value');
  });

  it('rejects workspace-write permission profile before spawning Codex CLI', async () => {
    await expect(new CodexCliAdapter().run({
      sessionId: 'session-1',
      prompt: 'inspect only',
      cwd: workspaceRoot,
      workspaceRoot,
      permissionProfile: 'workspace_write',
    })).rejects.toThrow(/read-only/);

    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it('rejects cwd outside workspace before spawning Codex CLI', async () => {
    const outsideCwd = path.join(tempDir, 'outside');
    await fs.mkdir(outsideCwd, { recursive: true });

    await expect(new CodexCliAdapter().run({
      sessionId: 'session-1',
      prompt: 'inspect only',
      cwd: outsideCwd,
      workspaceRoot,
    })).rejects.toThrow(/inside workspace/);

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
