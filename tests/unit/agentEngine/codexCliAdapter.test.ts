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

import { CodexCliAdapter } from '../../../src/host/services/agentEngine/codexCliAdapter';
import {
  createCodexContinuationResumeLaunch,
  createCodexResumeLaunch,
} from '../../../src/host/services/agentEngine/externalEngineResumeBuilders';
import type { ExternalEngineDurableLifecycle } from '../../../src/host/services/agentEngine/externalEngineDurableLifecycle';
import { buildTestExternalForkContextHandoff } from '../services/sessionFork/externalForkContextTestFixture';

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

    const assistantMessage = mocks.addMessageToSession.mock.calls
      .map((call) => call[1])
      .find((message) => message?.role === 'assistant');
    expect(assistantMessage?.modelDecision).toMatchObject({
      requestedProvider: 'codex_cli',
      requestedModel: 'gpt-5',
      resolvedProvider: 'codex_cli',
      resolvedModel: 'gpt-5',
      reason: 'user-selected',
      externalEngine: {
        kind: 'codex_cli',
        model: 'gpt-5',
        runtimeState: 'ready',
      },
    });
  });

  it('delivers the validated mapped fork prefix to Codex stdin on the first child run', async () => {
    let child: ReturnType<typeof createMockChild> | undefined;
    mocks.spawn.mockImplementation(() => {
      child = createMockChild([
        JSON.stringify({ type: 'thread.started', thread_id: 'fork-codex-thread' }),
        JSON.stringify({ type: 'message_delta', delta: 'continued child answer' }),
      ], 0);
      return child;
    });
    const forkContextHandoff = buildTestExternalForkContextHandoff('codex_cli');
    const onForkContextDispatchStart = vi.fn(async () => undefined);
    const onForkContextDispatched = vi.fn(async () => undefined);
    const firstLifecycle = {
      runId: 'fork-first-run', attempt: 1, ownerEpoch: 1,
      attachProcess: vi.fn(async () => undefined),
      observeStdout: vi.fn(), observeStderr: vi.fn(), observeModelUsage: vi.fn(), observeNormalizedEvent: vi.fn(),
      persistExternalSessionId: vi.fn(), terminateProcess: vi.fn(async () => undefined),
      finish: vi.fn(async () => undefined),
    } as unknown as ExternalEngineDurableLifecycle;

    await new CodexCliAdapter().run({
      sessionId: 'child-session',
      prompt: 'continue the branch',
      cwd: workspaceRoot,
      workspaceRoot,
      timeoutMs: 20_000,
      stallWarningMs: 10_000,
      forkContextHandoff,
      onForkContextDispatchStart,
      onForkContextDispatched,
      durableLifecycle: firstLifecycle,
    });

    const stdin = child?.stdin.end.mock.calls[0]?.[0] as string;
    expect(stdin).toContain('<<<NEO_SESSION_FORK_CONTEXT_V1>>>');
    expect(stdin).toContain('question one');
    expect(stdin).toContain('answer two');
    expect(stdin).toContain('continue the branch');
    expect(stdin).toContain('Do not infer, resume, or reuse any provider runtime/session identity');
    expect(stdin).not.toContain('externalSessionId');

    const userMessage = mocks.addMessageToSession.mock.calls
      .map((call) => call[1])
      .find((message) => message?.role === 'user');
    expect(userMessage?.content).toBe('continue the branch');

    const firstTask = mocks.upsertTask.mock.calls[0][0];
    expect(firstTask.metadata.forkContext).toMatchObject({
      forkId: 'fork-codex',
      deliveryMode: 'validated_context_handoff',
      messageCount: 4,
      providerNativeFork: false,
    });
    expect(JSON.stringify(firstTask.metadata.forkContext)).not.toContain('question one');
    expect(JSON.stringify(firstTask.metadata.forkContext)).not.toContain('continue the branch');
    expect(onForkContextDispatchStart).toHaveBeenCalledWith(firstTask.metadata.forkContext);
    expect(onForkContextDispatched).toHaveBeenCalledWith(firstTask.metadata.forkContext);
    expect(Object.isFrozen(firstTask.metadata.forkContext)).toBe(true);
    expect(onForkContextDispatchStart.mock.invocationCallOrder[0])
      .toBeLessThan(child!.stdin.end.mock.invocationCallOrder[0]);
    expect(child!.stdin.end.mock.invocationCallOrder[0])
      .toBeLessThan(onForkContextDispatched.mock.invocationCallOrder[0]);
    expect(firstLifecycle.persistExternalSessionId).toHaveBeenCalledWith('fork-codex-thread');
    expect((firstLifecycle.persistExternalSessionId as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0])
      .toBeLessThan(onForkContextDispatched.mock.invocationCallOrder[0]);
    const firstTerminalUpdate = mocks.updateSession.mock.calls.at(-1)?.[1];
    expect(firstTerminalUpdate).toMatchObject({
      status: 'idle',
      engine: {
        kind: 'codex_cli',
        externalSessionId: 'fork-codex-thread',
      },
    });
    const firstArgs = mocks.spawn.mock.calls[0][1] as string[];
    expect(firstArgs).not.toContain('resume');
    expect(firstArgs).not.toContain('fork-codex-thread');

    mocks.spawn.mockClear();
    mocks.addMessageToSession.mockClear();
    mocks.updateSession.mockClear();
    mocks.upsertTask.mockClear();
    let secondChild: ReturnType<typeof createMockChild> | undefined;
    mocks.spawn.mockImplementation(() => {
      secondChild = createMockChild([
        JSON.stringify({ type: 'thread.started', thread_id: 'fork-codex-thread' }),
        JSON.stringify({ type: 'message_delta', delta: 'second turn answer' }),
      ], 0);
      return secondChild;
    });
    const secondLifecycle = {
      runId: 'fork-second-run', attempt: 1, ownerEpoch: 2,
      attachProcess: vi.fn(async () => undefined),
      observeStdout: vi.fn(), observeStderr: vi.fn(), observeModelUsage: vi.fn(), observeNormalizedEvent: vi.fn(),
      persistExternalSessionId: vi.fn(), terminateProcess: vi.fn(async () => undefined),
      finish: vi.fn(async () => undefined),
    } as unknown as ExternalEngineDurableLifecycle;
    const cwd = await fs.realpath(workspaceRoot);
    const resumeLaunch = createCodexContinuationResumeLaunch({
      lifecycle: secondLifecycle,
      sessionId: 'child-session',
      persistedExternalSessionId: firstTerminalUpdate.engine.externalSessionId,
      cwd,
      logsRoot: path.join(tempDir, 'logs'),
      continuationInput: 'second turn request',
      permissionProfile: 'read_only',
    });

    const secondResult = await new CodexCliAdapter().run({
      sessionId: 'child-session',
      prompt: 'second turn request',
      cwd,
      workspaceRoot: cwd,
      permissionProfile: 'read_only',
      durableLifecycle: secondLifecycle,
      resumeLaunch,
    });

    expect(secondResult.status).toBe('completed');
    expect(resumeLaunch.args).toContain('resume');
    expect(resumeLaunch.args).toContain('fork-codex-thread');
    expect(resumeLaunch.args).toContain(
      path.join(tempDir, 'logs', 'agent-engines', 'codex-cli', 'fork-second-run.last.md'),
    );
    expect(secondChild?.stdin.end).toHaveBeenCalledWith('second turn request');
    expect(String(secondChild?.stdin.end.mock.calls[0]?.[0])).not.toContain('NEO_SESSION_FORK_CONTEXT');
    expect(secondLifecycle.persistExternalSessionId).toHaveBeenCalledWith('fork-codex-thread');
    expect(mocks.updateSession.mock.calls.at(-1)?.[1]).toMatchObject({
      status: 'idle',
      engine: {
        externalSessionId: 'fork-codex-thread',
      },
    });
  });

  it('requires a durable fork dispatch lifecycle before spawning Codex', async () => {
    await expect(new CodexCliAdapter().run({
      sessionId: 'child-session',
      prompt: 'continue the branch',
      cwd: workspaceRoot,
      workspaceRoot,
      forkContextHandoff: buildTestExternalForkContextHandoff('codex_cli'),
    })).rejects.toMatchObject({
      code: 'DISPATCH_LIFECYCLE_REQUIRED',
    });

    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(mocks.addMessageToSession).not.toHaveBeenCalled();
  });

  it('does not write fork context to stdin when dispatch-start persistence rejects', async () => {
    let child: ReturnType<typeof createMockChild> | undefined;
    mocks.spawn.mockImplementation(() => {
      child = createMockChild([], 0);
      return child;
    });
    const onForkContextDispatchStart = vi.fn(async () => {
      throw new Error('dispatch-start persistence failed');
    });
    const onForkContextDispatched = vi.fn(async () => undefined);

    await expect(new CodexCliAdapter().run({
      sessionId: 'child-session',
      prompt: 'continue the branch',
      cwd: workspaceRoot,
      workspaceRoot,
      forkContextHandoff: buildTestExternalForkContextHandoff('codex_cli'),
      onForkContextDispatchStart,
      onForkContextDispatched,
    })).rejects.toThrow('dispatch-start persistence failed');

    expect(onForkContextDispatchStart).toHaveBeenCalledTimes(1);
    expect(child?.stdin.end).not.toHaveBeenCalled();
    expect(onForkContextDispatched).not.toHaveBeenCalled();
    expect(child?.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('keeps the fork handoff unconsumed when Codex never confirms a new external session id', async () => {
    let child: ReturnType<typeof createMockChild> | undefined;
    mocks.spawn.mockImplementation(() => {
      child = createMockChild([
        JSON.stringify({ type: 'message_delta', delta: 'answer without identity' }),
      ], 0);
      return child;
    });
    const onForkContextDispatchStart = vi.fn(async () => undefined);
    const onForkContextDispatched = vi.fn(async () => undefined);

    const result = await new CodexCliAdapter().run({
      sessionId: 'child-session',
      prompt: 'continue the branch',
      cwd: workspaceRoot,
      workspaceRoot,
      forkContextHandoff: buildTestExternalForkContextHandoff('codex_cli'),
      onForkContextDispatchStart,
      onForkContextDispatched,
    });

    expect(result).toMatchObject({
      status: 'failed',
      error: 'Codex fork handoff did not confirm a new external session identity',
    });
    expect(onForkContextDispatchStart).toHaveBeenCalledTimes(1);
    expect(child?.stdin.end).toHaveBeenCalledTimes(1);
    expect(onForkContextDispatched).not.toHaveBeenCalled();
  });

  it('keeps the fork handoff unconsumed when Codex confirms identity but exits abnormally', async () => {
    mocks.spawn.mockImplementation(() => createMockChild([
      JSON.stringify({ type: 'thread.started', thread_id: 'failed-fork-thread' }),
      JSON.stringify({ type: 'message_delta', delta: 'partial answer' }),
    ], 1, 'provider failed after identity confirmation'));
    const onForkContextDispatchStart = vi.fn(async () => undefined);
    const onForkContextDispatched = vi.fn(async () => undefined);

    const result = await new CodexCliAdapter().run({
      sessionId: 'child-session',
      prompt: 'continue the branch',
      cwd: workspaceRoot,
      workspaceRoot,
      forkContextHandoff: buildTestExternalForkContextHandoff('codex_cli'),
      onForkContextDispatchStart,
      onForkContextDispatched,
    });

    expect(result.status).toBe('failed');
    expect(onForkContextDispatchStart).toHaveBeenCalledTimes(1);
    expect(onForkContextDispatched).not.toHaveBeenCalled();
  });

  it('writes once then aborts when consumed-state persistence rejects', async () => {
    let child: ReturnType<typeof createMockChild> | undefined;
    mocks.spawn.mockImplementation(() => {
      child = createMockChild([
        JSON.stringify({ type: 'thread.started', thread_id: 'fork-codex-thread' }),
        JSON.stringify({ type: 'message_delta', delta: 'provider acknowledged the fork' }),
      ], 0);
      return child;
    });
    const onForkContextDispatchStart = vi.fn(async () => undefined);
    const onForkContextDispatched = vi.fn(async () => {
      throw new Error('consumed-state persistence failed');
    });

    await expect(new CodexCliAdapter().run({
      sessionId: 'child-session',
      prompt: 'continue the branch',
      cwd: workspaceRoot,
      workspaceRoot,
      forkContextHandoff: buildTestExternalForkContextHandoff('codex_cli'),
      onForkContextDispatchStart,
      onForkContextDispatched,
    })).rejects.toThrow('consumed-state persistence failed');

    expect(onForkContextDispatchStart).toHaveBeenCalledTimes(1);
    expect(child?.stdin.end).toHaveBeenCalledTimes(1);
    expect(onForkContextDispatched).toHaveBeenCalledTimes(1);
    expect(child?.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('persists an observed Codex external session id on a failed terminal path', async () => {
    mocks.spawn.mockImplementation(() => createMockChild([
      JSON.stringify({ type: 'thread.started', thread_id: 'failed-codex-thread' }),
    ], 1, 'runtime failed'));

    const result = await new CodexCliAdapter().run({
      sessionId: 'session-1',
      prompt: 'inspect only',
      cwd: workspaceRoot,
      workspaceRoot,
      timeoutMs: 20_000,
      stallWarningMs: 10_000,
    });

    expect(result.status).toBe('failed');
    expect(mocks.updateSession.mock.calls.at(-1)?.[1]).toMatchObject({
      status: 'error',
      engine: {
        kind: 'codex_cli',
        externalSessionId: 'failed-codex-thread',
      },
    });
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

  it('classifies Codex CLI quota failures for task ledger and result diagnostics', async () => {
    mocks.spawn.mockImplementation(() => createMockChild([], 1, 'API Error: 429 quota exhausted'));

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
      status: 'failed',
      error: 'API Error: 429 quota exhausted',
      exitCode: 1,
      failure: {
        category: 'quota',
        reason: 'quota_exhausted',
        statusCode: 429,
        reliability: { quotaState: 'exhausted' },
      },
    });
    expect(mocks.updateSession).toHaveBeenLastCalledWith(
      'session-1',
      expect.objectContaining({
        status: 'error',
        engine: expect.objectContaining({
          kind: 'codex_cli',
          failure: expect.objectContaining({
            category: 'quota',
            reason: 'quota_exhausted',
            reliability: { quotaState: 'exhausted' },
          }),
        }),
      }),
      { allowEngineUpdate: true },
    );
    expect(mocks.upsertTask).toHaveBeenLastCalledWith(expect.objectContaining({
      failure: expect.objectContaining({
        message: 'API Error: 429 quota exhausted',
        reason: 'quota_exhausted',
      }),
    }));
    expect(mocks.appendEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'agent_engine.failed',
      data: expect.objectContaining({
        failure: expect.objectContaining({
          category: 'quota',
          reason: 'quota_exhausted',
        }),
      }),
    }));
    const assistantMessage = mocks.addMessageToSession.mock.calls
      .map((call) => call[1])
      .find((message) => message?.role === 'assistant');
    expect(assistantMessage).toMatchObject({
      role: 'assistant',
      content: expect.stringContaining('额度或账单状态不可用'),
      modelDecision: expect.objectContaining({
        externalEngine: expect.objectContaining({
          kind: 'codex_cli',
          failure: expect.objectContaining({
            category: 'quota',
            reason: 'quota_exhausted',
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

  it('treats exit 0 with only non-text events as an empty-response failure', async () => {
    mocks.spawn.mockImplementation(() => createMockChild([
      JSON.stringify({ type: 'thread.started', thread_id: 'codex-thread' }),
      JSON.stringify({ type: 'item.completed', item: { type: 'tool_call', name: 'Read' } }),
    ], 0));

    const result = await new CodexCliAdapter().run({
      sessionId: 'session-1',
      prompt: 'inspect only',
      cwd: workspaceRoot,
      workspaceRoot,
      timeoutMs: 20_000,
      stallWarningMs: 10_000,
    });

    expect(result).toMatchObject({
      engine: 'codex_cli',
      status: 'failed',
      exitCode: 0,
    });
    expect(result.error).toContain('empty response');
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

  it('spawns audited resume argv once and fails closed when Codex reports a different thread id', async () => {
    mocks.spawn.mockImplementation(() => createMockChild([
      JSON.stringify({ type: 'message_delta', delta: 'wrong thread', thread_id: 'other-thread' }),
    ], 0));
    const cwd = await fs.realpath(workspaceRoot);
    const lifecycle = {
      runId: 'logical-run', attempt: 2, ownerEpoch: 4,
      attachProcess: vi.fn(async () => undefined),
      observeStdout: vi.fn(), observeStderr: vi.fn(), observeModelUsage: vi.fn(), observeNormalizedEvent: vi.fn(),
      persistExternalSessionId: vi.fn(), terminateProcess: vi.fn(async () => undefined),
      finish: vi.fn(async () => undefined),
    } as unknown as ExternalEngineDurableLifecycle;
    const resumeLaunch = createCodexResumeLaunch({
      runId: 'logical-run', sessionId: 'session-1', attempt: 2, ownerEpoch: 4,
      externalSessionId: 'target-thread', cwd, permissionProfile: 'read_only', lastMessagePath: path.join(tempDir, 'last.md'),
    });
    const result = await new CodexCliAdapter().run({
      sessionId: 'session-1', prompt: '', cwd, workspaceRoot: cwd,
      permissionProfile: 'read_only', durableLifecycle: lifecycle, resumeLaunch,
    });
    expect(result).toMatchObject({ runId: 'logical-run', sessionId: 'session-1', status: 'failed' });
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    expect(mocks.spawn.mock.calls[0][1]).toEqual(resumeLaunch.args);
    expect(lifecycle.terminateProcess).toHaveBeenCalled();
    expect(lifecycle.persistExternalSessionId).not.toHaveBeenCalled();
    expect(mocks.updateSession.mock.calls.at(-1)?.[1]).toMatchObject({
      status: 'error',
      engine: {
        externalSessionId: 'target-thread',
      },
    });
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
