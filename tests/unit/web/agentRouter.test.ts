import express from 'express';
import http from 'http';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCLIAgent } from '../../../src/cli/adapter';
import { createAgentRouter, type ActiveAgentLoop } from '../../../src/web/routes/agent';
import { inMemorySessions, sessionMessages, setDbAvailable } from '../../../src/web/helpers/sessionCache';

const mockRun = vi.fn();
const mockCancel = vi.fn();
const mockSteer = vi.fn();
const mockCreateAgentLoop = vi.fn();
const agentEngineMocks = vi.hoisted(() => ({
  codexRun: vi.fn(),
  claudeRun: vi.fn(),
  resolveExternalEngineLaunch: vi.fn(),
  ledgerUpsertTask: vi.fn(),
  ledgerAppendEvent: vi.fn(),
  ledgerQueueNotification: vi.fn(),
  enqueueReviewSession: vi.fn(),
}));
const mockDb = vi.hoisted(() => ({
  getSession: vi.fn(() => ({
    id: 'session-existing',
    title: 'Existing',
  })),
  createSessionWithId: vi.fn(),
  updateSession: vi.fn(),
  addMessage: vi.fn(),
  updateMessage: vi.fn(),
  getMessages: vi.fn(() => []),
}));

vi.mock('../../../src/cli/adapter', () => ({
  createCLIAgent: vi.fn(async () => ({
    getConfig: () => ({
      modelConfig: {
        provider: 'xiaomi',
        model: 'mimo-v2.5-pro',
        apiKey: 'mock-key',
      },
      systemPrompt: '',
    }),
  })),
}));

vi.mock('../../../src/cli/bootstrap', () => ({
  createAgentLoop: (...args: unknown[]) => mockCreateAgentLoop(...args),
  getToolExecutor: vi.fn(() => undefined),
}));

vi.mock('../../../src/main/session/modelSessionState', () => ({
  getModelSessionState: () => ({
    getOverride: vi.fn(() => null),
  }),
}));

vi.mock('../../../src/main/services/agentEngine', () => ({
  CodexCliAdapter: vi.fn(function CodexCliAdapterMock() {
    return {
      run: agentEngineMocks.codexRun,
    };
  }),
  ClaudeCodeAdapter: vi.fn(function ClaudeCodeAdapterMock() {
    return {
      run: agentEngineMocks.claudeRun,
    };
  }),
  resolveExternalEngineLaunch: (...args: unknown[]) => agentEngineMocks.resolveExternalEngineLaunch(...args),
}));

vi.mock('../../../src/main/tasks/backgroundTaskLedger', () => ({
  getBackgroundTaskLedger: () => ({
    upsertTask: agentEngineMocks.ledgerUpsertTask,
    appendEvent: agentEngineMocks.ledgerAppendEvent,
    queueNotification: agentEngineMocks.ledgerQueueNotification,
  }),
}));

vi.mock('../../../src/main/evaluation/reviewQueueService', () => ({
  ReviewQueueService: {
    getInstance: () => ({
      enqueueSession: agentEngineMocks.enqueueReviewSession,
    }),
  },
}));

vi.mock('../../../src/main/services/core/databaseService', () => ({
  getDatabase: () => mockDb,
}));

vi.mock('../../../src/main/telemetry', () => ({
  getTelemetryCollector: () => ({
    endSession: vi.fn(),
  }),
}));

let server: http.Server | undefined;
let baseUrl = '';
const activeAgentLoops = new Map<string, ActiveAgentLoop>();
const originalCodeAgentDataDir = process.env.CODE_AGENT_DATA_DIR;
let tempDataDir: string | undefined;

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

async function startAgentApi(deps: {
  tryGetSessionManager?: () => Promise<unknown>;
} = {}) {
  const app = express();
  app.use(express.json());
  app.use('/api', createAgentRouter({
    activeAgentLoops,
    pendingLocalToolCalls: new Map(),
    logger,
    tryGetSessionManager: deps.tryGetSessionManager ?? (async () => null),
    getSupabaseForSession: async () => null,
  }));

  server = await new Promise<http.Server>((resolve) => {
    const nextServer = app.listen(0, '127.0.0.1', () => resolve(nextServer));
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected TCP test server address');
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
}

async function closeServer() {
  if (!server) return;
  await new Promise<void>((resolve, reject) => {
    server?.close((err) => (err ? reject(err) : resolve()));
  });
  server = undefined;
  baseUrl = '';
}

async function waitForAssertion(assertion: () => void, timeoutMs = 1000): Promise<void> {
  const startedAt = Date.now();
  let lastError: unknown;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw lastError;
}

describe('createAgentRouter', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    activeAgentLoops.clear();
    inMemorySessions.clear();
    sessionMessages.clear();
    setDbAvailable(false);
    Object.values(mockDb).forEach((mock) => mock.mockClear());
    agentEngineMocks.resolveExternalEngineLaunch.mockImplementation((session, engine, requestedCwd) => ({
      cwd: requestedCwd || session?.workingDirectory || engine?.cwd,
      workspaceRoot: engine?.cwd || session?.workingDirectory,
      permissionProfile: 'read_only',
    }));
    agentEngineMocks.codexRun.mockReset();
    agentEngineMocks.claudeRun.mockReset();
    agentEngineMocks.ledgerUpsertTask.mockReset();
    agentEngineMocks.ledgerAppendEvent.mockReset();
    agentEngineMocks.ledgerQueueNotification.mockReset();
    agentEngineMocks.enqueueReviewSession.mockReset();
    mockDb.getSession.mockReturnValue({
      id: 'session-existing',
      title: 'Existing',
    });
    mockDb.getMessages.mockReturnValue([]);
    let releaseRun: (() => void) | null = null;
    mockRun.mockImplementation(() => new Promise<void>((resolve) => {
      releaseRun = resolve;
    }));
    mockCancel.mockImplementation(() => {
      releaseRun?.();
    });
    mockCreateAgentLoop.mockImplementation(() => ({
      run: mockRun,
      cancel: mockCancel,
      steer: mockSteer,
    }));
    await startAgentApi();
  });

  afterEach(async () => {
    await closeServer();
    if (tempDataDir) {
      await rm(tempDataDir, { recursive: true, force: true });
      tempDataDir = undefined;
    }
    if (originalCodeAgentDataDir === undefined) {
      delete process.env.CODE_AGENT_DATA_DIR;
    } else {
      process.env.CODE_AGENT_DATA_DIR = originalCodeAgentDataDir;
    }
    activeAgentLoops.clear();
    inMemorySessions.clear();
    sessionMessages.clear();
    setDbAvailable(false);
  });

  it('cancels the active agent loop when the /api/run SSE client disconnects', async () => {
    const controller = new AbortController();
    const response = await fetch(`${baseUrl}/api/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt: '生成一个单文件 HTML 游戏',
        sessionId: 'session-disconnect',
      }),
      signal: controller.signal,
    });

    expect(response.ok).toBe(true);
    await waitForAssertion(() => {
      expect(activeAgentLoops.has('session-disconnect')).toBe(true);
    });

    controller.abort();

    await waitForAssertion(() => {
      expect(mockCancel).toHaveBeenCalledWith('user');
    });
  });

  it('uses clientMessageId as the persisted user message id for /api/run', async () => {
    mockRun.mockResolvedValueOnce(undefined);

    const addMessageToSession = vi.fn(async () => undefined);
    await closeServer();
    await startAgentApi({
      tryGetSessionManager: async () => ({
        addMessageToSession,
        getMessages: vi.fn(async () => []),
        getSession: vi.fn(async () => ({ id: 'session-client-id', title: 'Client id' })),
      }),
    });
    setDbAvailable(true);

    const response = await fetch(`${baseUrl}/api/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt: '第二轮消息',
        sessionId: 'session-client-id',
        clientMessageId: 'client-msg-run-1',
      }),
    });

    expect(response.ok).toBe(true);
    await response.text();

    expect(addMessageToSession).toHaveBeenCalledWith(
      'session-client-id',
      expect.objectContaining({
        id: 'client-msg-run-1',
        role: 'user',
        content: '第二轮消息',
      }),
    );
    expect(sessionMessages.get('session-client-id')?.[0]).toMatchObject({
      id: 'client-msg-run-1',
      role: 'user',
      content: '第二轮消息',
    });
  });

  it('routes /api/interrupt to the active loop steer method', async () => {
    activeAgentLoops.set('session-steer', {
      cancel: mockCancel,
      steer: mockSteer,
    });

    const response = await fetch(`${baseUrl}/api/interrupt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        content: '补一句',
        sessionId: 'session-steer',
        clientMessageId: 'client-msg-1',
        attachments: [{ name: 'note.txt' }],
        context: {
          workingDirectory: '/tmp/project',
          runtimeInput: { mode: 'supplement' },
        },
      }),
    });
    const body = await response.json();

    expect(response.ok).toBe(true);
    expect(body).toEqual({ success: true, data: null });
    expect(mockSteer).toHaveBeenCalledWith(
      '补一句',
      'client-msg-1',
      [{ name: 'note.txt' }],
      {
        workbench: {
          workingDirectory: '/tmp/project',
          runtimeInputMode: 'supplement',
        },
      },
    );
  });

  it('rejects /api/interrupt when there is no active loop for the session', async () => {
    const response = await fetch(`${baseUrl}/api/interrupt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        content: '补一句',
        sessionId: 'missing-session',
      }),
    });
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toMatchObject({
      success: false,
      error: {
        code: 'NO_ACTIVE_RUN',
      },
    });
    expect(mockSteer).not.toHaveBeenCalled();
  });

  it('preserves structured artifact metadata from tool_call_end in the SSE-backed session cache', async () => {
    mockCreateAgentLoop.mockImplementationOnce((_config, onEvent: (event: { type: string; data?: Record<string, unknown> }) => void) => ({
      run: vi.fn(async () => {
        onEvent({
          type: 'tool_call_start',
          data: {
            id: 'tool-read-1',
            name: 'Read',
          },
        });
        onEvent({
          type: 'tool_call_end',
          data: {
            toolCallId: 'tool-read-1',
            success: true,
            output: '# Report',
            metadata: {
              artifact: {
                artifactId: 'artifact-read-report',
                kind: 'text',
                sourceTool: 'Read',
                createdAt: '2026-05-07T00:00:00.000Z',
                name: 'report.md',
                path: 'reports/report.md',
              },
            },
          },
        });
        onEvent({
          type: 'stream_chunk',
          data: {
            content: '已读取报告。',
          },
        });
      }),
      cancel: mockCancel,
      steer: mockSteer,
    }));

    const response = await fetch(`${baseUrl}/api/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt: '读取 reports/report.md',
        sessionId: 'session-artifact-route',
      }),
    });
    const body = await response.text();

    expect(response.ok).toBe(true);
    expect(body).toContain('tool_call_end');

    const cached = sessionMessages.get('session-artifact-route') || [];
    const assistant = cached.find((message) => message.role === 'assistant');
    expect(assistant?.toolCalls?.[0]).toMatchObject({
      id: 'tool-read-1',
      name: 'Read',
      result: {
        success: true,
        output: '# Report',
        metadata: {
          artifact: {
            artifactId: 'artifact-read-report',
            kind: 'text',
            sourceTool: 'Read',
            name: 'report.md',
            path: 'reports/report.md',
          },
        },
      },
    });
  });

  it('hydrates persisted session history when the SSE-backed cache is cold', async () => {
    await closeServer();

    const getMessages = vi.fn(async () => [
      {
        id: 'old-user-1',
        role: 'user',
        content: '上一轮需求',
        timestamp: 100,
      },
      {
        id: 'old-assistant-1',
        role: 'assistant',
        content: '上一轮回答',
        timestamp: 200,
      },
      {
        id: 'old-tool-1',
        role: 'tool',
        content: '工具结果只用于 UI hydrate，不直接喂给 web AgentLoop',
        timestamp: 300,
      },
    ]);
    const getSession = vi.fn(async () => ({
      workingDirectory: '/tmp/persisted-project',
    }));

    mockCreateAgentLoop.mockImplementationOnce(() => ({
      run: vi.fn(async () => undefined),
      cancel: mockCancel,
    }));

    await startAgentApi({
      tryGetSessionManager: async () => ({
        getMessages,
        getSession,
      }),
    });

    const response = await fetch(`${baseUrl}/api/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt: '继续刚才那轮',
        sessionId: 'persisted-session-1',
      }),
    });

    expect(response.ok).toBe(true);
    await response.text();

    expect(getMessages).toHaveBeenCalledWith('persisted-session-1');
    const messagesArg = mockCreateAgentLoop.mock.calls[0][2] as Array<{ id: string; role: string; content: string }>;
    expect(messagesArg.map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
    }))).toEqual([
      { id: 'old-user-1', role: 'user', content: '上一轮需求' },
      { id: 'old-assistant-1', role: 'assistant', content: '上一轮回答' },
      expect.objectContaining({ role: 'user', content: '继续刚才那轮' }),
    ]);

    expect(sessionMessages.get('persisted-session-1')?.map((message) => message.id).slice(0, 2)).toEqual([
      'old-user-1',
      'old-assistant-1',
    ]);
  });

  it('uses context.workingDirectory from the conversation envelope before fallback paths', async () => {
    mockCreateAgentLoop.mockImplementationOnce(() => ({
      run: vi.fn(async () => undefined),
      cancel: mockCancel,
    }));

    const response = await fetch(`${baseUrl}/api/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt: '查一下这个项目',
        sessionId: 'session-context-working-dir',
        context: {
          workingDirectory: '/tmp/context-project',
        },
      }),
    });

    expect(response.ok).toBe(true);
    await response.text();

    expect(createCLIAgent).toHaveBeenCalledWith(expect.objectContaining({
      project: '/tmp/context-project',
    }));
  });

  it('routes Codex engine sessions through the Codex adapter instead of the native web agent', async () => {
    await closeServer();

    const updateSession = vi.fn(async () => undefined);
    const getSession = vi.fn(async () => ({
      id: 'session-codex-engine',
      title: 'Codex engine',
      type: 'chat',
      workingDirectory: '/tmp/codex-workspace',
      engine: {
        kind: 'codex_cli',
        cwd: '/tmp/codex-workspace',
        permissionProfile: 'read_only',
        origin: 'manual',
      },
    }));

    agentEngineMocks.codexRun.mockImplementationOnce(async (request) => {
      request.emitEvent?.({
        type: 'turn_start',
        data: { turnId: 'turn-codex', iteration: 1 },
      });
      request.emitEvent?.({
        type: 'message_delta',
        data: {
          role: 'assistant',
          path: 'content',
          op: 'append',
          text: 'CODEX_ROUTED_OK',
          turnId: 'turn-codex',
        },
      });
      request.emitEvent?.({
        type: 'agent_complete',
        data: null,
      });
      return {
        runId: 'codex-run-1',
        sessionId: request.sessionId,
        engine: 'codex_cli',
        status: 'completed',
        outputText: 'CODEX_ROUTED_OK',
        exitCode: 0,
      };
    });

    await startAgentApi({
      tryGetSessionManager: async () => ({
        getSession,
        updateSession,
      }),
    });

    const response = await fetch(`${baseUrl}/api/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt: '只回复 CODEX_ROUTED_OK',
        sessionId: 'session-codex-engine',
        context: {
          workingDirectory: '/tmp/codex-workspace',
        },
      }),
    });
    const body = await response.text();

    expect(response.ok).toBe(true);
    expect(body).toContain('CODEX_ROUTED_OK');
    expect(agentEngineMocks.codexRun).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-codex-engine',
      prompt: '只回复 CODEX_ROUTED_OK',
      cwd: '/tmp/codex-workspace',
      workspaceRoot: '/tmp/codex-workspace',
      permissionProfile: 'read_only',
    }));
    expect(createCLIAgent).not.toHaveBeenCalled();
    expect(updateSession).toHaveBeenCalledWith(
      'session-codex-engine',
      expect.objectContaining({ status: 'completed' }),
    );
  });

  it('routes Claude Code engine sessions through the Claude adapter instead of the native web agent', async () => {
    await closeServer();

    const updateSession = vi.fn(async () => undefined);
    const getSession = vi.fn(async () => ({
      id: 'session-claude-engine',
      title: 'Claude engine',
      type: 'chat',
      workingDirectory: '/tmp/claude-workspace',
      engine: {
        kind: 'claude_code',
        cwd: '/tmp/claude-workspace',
        permissionProfile: 'read_only',
        origin: 'manual',
      },
    }));

    agentEngineMocks.claudeRun.mockImplementationOnce(async (request) => {
      request.emitEvent?.({
        type: 'turn_start',
        data: { turnId: 'turn-claude', iteration: 1 },
      });
      request.emitEvent?.({
        type: 'message_delta',
        data: {
          role: 'assistant',
          path: 'content',
          op: 'append',
          text: 'CLAUDE_ROUTED_OK',
          turnId: 'turn-claude',
        },
      });
      request.emitEvent?.({
        type: 'agent_complete',
        data: null,
      });
      return {
        runId: 'claude-run-1',
        sessionId: request.sessionId,
        engine: 'claude_code',
        status: 'completed',
        outputText: 'CLAUDE_ROUTED_OK',
        exitCode: 0,
      };
    });

    await startAgentApi({
      tryGetSessionManager: async () => ({
        getSession,
        updateSession,
      }),
    });

    const response = await fetch(`${baseUrl}/api/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt: '只回复 CLAUDE_ROUTED_OK',
        sessionId: 'session-claude-engine',
        context: {
          workingDirectory: '/tmp/claude-workspace',
        },
      }),
    });
    const body = await response.text();

    expect(response.ok).toBe(true);
    expect(body).toContain('CLAUDE_ROUTED_OK');
    expect(agentEngineMocks.claudeRun).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-claude-engine',
      prompt: '只回复 CLAUDE_ROUTED_OK',
      cwd: '/tmp/claude-workspace',
      workspaceRoot: '/tmp/claude-workspace',
      permissionProfile: 'read_only',
    }));
    expect(agentEngineMocks.codexRun).not.toHaveBeenCalled();
    expect(createCLIAgent).not.toHaveBeenCalled();
    expect(updateSession).toHaveBeenCalledWith(
      'session-claude-engine',
      expect.objectContaining({ status: 'completed' }),
    );
  });

  it('does not fall back to native launch when an external engine session is blocked by launch policy', async () => {
    await closeServer();

    const updateSession = vi.fn(async () => undefined);
    const getSession = vi.fn(async () => ({
      id: 'session-channel-engine',
      title: 'Channel engine',
      type: 'chat',
      origin: { kind: 'channel' },
      workingDirectory: '/tmp/channel-workspace',
      engine: {
        kind: 'codex_cli',
        cwd: '/tmp/channel-workspace',
        permissionProfile: 'read_only',
        origin: 'manual',
      },
    }));
    agentEngineMocks.resolveExternalEngineLaunch.mockImplementationOnce(() => {
      throw new Error('External Agent Engine execution is not allowed for channel sessions.');
    });

    await startAgentApi({
      tryGetSessionManager: async () => ({
        getSession,
        updateSession,
      }),
    });

    const response = await fetch(`${baseUrl}/api/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt: 'channel should not auto-launch external engines',
        sessionId: 'session-channel-engine',
        context: {
          workingDirectory: '/tmp/channel-workspace',
        },
      }),
    });
    const body = await response.text();

    expect(response.ok).toBe(true);
    expect(body).toContain('not allowed for channel sessions');
    expect(agentEngineMocks.resolveExternalEngineLaunch).toHaveBeenCalled();
    expect(agentEngineMocks.codexRun).not.toHaveBeenCalled();
    expect(agentEngineMocks.claudeRun).not.toHaveBeenCalled();
    expect(createCLIAgent).not.toHaveBeenCalled();
    expect(updateSession).toHaveBeenLastCalledWith(
      'session-channel-engine',
      expect.objectContaining({ status: 'error' }),
    );
    expect(agentEngineMocks.ledgerUpsertTask).toHaveBeenCalledWith(expect.objectContaining({
      id: 'agent-engine:codex_cli:failed:session-channel-engine',
      kind: 'agent_engine',
      sessionId: 'session-channel-engine',
      source: 'agent_engine',
      status: 'failed',
      cwd: '/tmp/channel-workspace',
      failure: expect.objectContaining({
        message: 'External Agent Engine execution is not allowed for channel sessions.',
        reason: 'launch_policy',
        category: 'agent_engine',
      }),
      metadata: expect.objectContaining({
        engine: 'codex_cli',
        failureStage: 'launch_policy',
      }),
    }));
    expect(agentEngineMocks.ledgerAppendEvent).toHaveBeenCalledWith(expect.objectContaining({
      taskId: 'agent-engine:codex_cli:failed:session-channel-engine',
      type: 'agent_engine.failed',
      status: 'failed',
      message: 'External Agent Engine execution is not allowed for channel sessions.',
    }));
    expect(agentEngineMocks.ledgerQueueNotification).toHaveBeenCalledWith(expect.objectContaining({
      taskId: 'agent-engine:codex_cli:failed:session-channel-engine',
      sessionId: 'session-channel-engine',
      type: 'task_failed',
      title: 'Codex CLI failed',
      message: 'External Agent Engine execution is not allowed for channel sessions.',
    }));
    expect(agentEngineMocks.enqueueReviewSession).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-channel-engine',
      reason: 'failure_followup',
      enqueueSource: 'replay_failure',
      failureCapability: expect.objectContaining({
        sink: 'capability_health',
        category: 'env_failure',
        summary: 'External Agent Engine execution is not allowed for channel sessions.',
      }),
    }));
  });

  it('records a failed task when an external engine adapter throws before returning a result', async () => {
    await closeServer();

    const updateSession = vi.fn(async () => undefined);
    const getSession = vi.fn(async () => ({
      id: 'session-codex-adapter-throw',
      title: 'Codex adapter throw',
      type: 'chat',
      workingDirectory: '/tmp/codex-workspace',
      engine: {
        kind: 'codex_cli',
        cwd: '/tmp/codex-workspace',
        permissionProfile: 'read_only',
        origin: 'manual',
      },
    }));

    agentEngineMocks.codexRun.mockRejectedValueOnce(new Error('Codex adapter exploded before terminal event'));

    await startAgentApi({
      tryGetSessionManager: async () => ({
        getSession,
        updateSession,
      }),
    });

    const response = await fetch(`${baseUrl}/api/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt: 'run codex adapter',
        sessionId: 'session-codex-adapter-throw',
        context: {
          workingDirectory: '/tmp/codex-workspace',
        },
      }),
    });
    const body = await response.text();

    expect(response.ok).toBe(true);
    expect(body).toContain('Codex adapter exploded before terminal event');
    expect(createCLIAgent).not.toHaveBeenCalled();
    expect(updateSession).toHaveBeenLastCalledWith(
      'session-codex-adapter-throw',
      expect.objectContaining({ status: 'error' }),
    );
    expect(agentEngineMocks.ledgerUpsertTask).toHaveBeenCalledWith(expect.objectContaining({
      id: 'agent-engine:codex_cli:failed:session-codex-adapter-throw',
      kind: 'agent_engine',
      sessionId: 'session-codex-adapter-throw',
      source: 'agent_engine',
      status: 'failed',
      cwd: '/tmp/codex-workspace',
      failure: expect.objectContaining({
        message: 'Codex adapter exploded before terminal event',
        reason: 'adapter_run',
        category: 'agent_engine',
      }),
      metadata: expect.objectContaining({
        engine: 'codex_cli',
        failureStage: 'adapter_run',
      }),
    }));
    expect(agentEngineMocks.ledgerQueueNotification).toHaveBeenCalledWith(expect.objectContaining({
      taskId: 'agent-engine:codex_cli:failed:session-codex-adapter-throw',
      sessionId: 'session-codex-adapter-throw',
      type: 'task_failed',
      title: 'Codex CLI failed',
      message: 'Codex adapter exploded before terminal event',
    }));
    expect(agentEngineMocks.enqueueReviewSession).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-codex-adapter-throw',
      reason: 'failure_followup',
      failureCapability: expect.objectContaining({
        sink: 'capability_health',
        category: 'env_failure',
        summary: 'Codex adapter exploded before terminal event',
      }),
    }));
  });

  it('falls back to the app work directory instead of HOME when no working directory is known', async () => {
    await closeServer();
    tempDataDir = await mkdtemp(join(tmpdir(), 'code-agent-data-'));
    process.env.CODE_AGENT_DATA_DIR = tempDataDir;

    mockCreateAgentLoop.mockImplementationOnce(() => ({
      run: vi.fn(async () => undefined),
      cancel: mockCancel,
    }));

    await startAgentApi({
      tryGetSessionManager: async () => ({
        getMessages: vi.fn(async () => []),
        getSession: vi.fn(async () => null),
      }),
    });

    const response = await fetch(`${baseUrl}/api/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt: '普通聊天',
        sessionId: 'session-safe-fallback',
      }),
    });

    expect(response.ok).toBe(true);
    await response.text();

    expect(createCLIAgent).toHaveBeenCalledWith(expect.objectContaining({
      project: join(tempDataDir, 'work'),
    }));
  });

  it('persists assistant output when loop message events were not actually stored', async () => {
    await closeServer();
    setDbAvailable(true);

    const addMessageToSession = vi.fn(async () => undefined);
    const getMessages = vi.fn(async () => []);
    const getSession = vi.fn(async () => ({
      workingDirectory: '/tmp/persisted-project',
    }));

    mockCreateAgentLoop.mockImplementationOnce((_config, onEvent: (event: { type: string; data?: Record<string, unknown> }) => void) => ({
      run: vi.fn(async () => {
        onEvent({
          type: 'message',
          data: {
            id: 'loop-assistant-transient',
            role: 'assistant',
            content: '只发给 UI，未落库',
            timestamp: 200,
          },
        });
        onEvent({
          type: 'stream_chunk',
          data: {
            content: '最终回复',
          },
        });
      }),
      cancel: mockCancel,
    }));

    await startAgentApi({
      tryGetSessionManager: async () => ({
        addMessageToSession,
        getMessages,
        getSession,
      }),
    });

    const response = await fetch(`${baseUrl}/api/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt: '生成最终回复',
        sessionId: 'session-assistant-fallback',
      }),
    });

    expect(response.ok).toBe(true);
    const body = await response.text();
    expect(body).toContain('message_snapshot');
    expect(body).toContain('最终回复');

    expect(addMessageToSession).toHaveBeenCalledWith(
      'session-assistant-fallback',
      expect.objectContaining({
        role: 'user',
        content: '生成最终回复',
      }),
    );
    expect(addMessageToSession).toHaveBeenCalledWith(
      'session-assistant-fallback',
      expect.objectContaining({
        role: 'assistant',
        content: '最终回复',
      }),
    );
  });

  it('drops duplicate sequenced message deltas from /api/run streaming and cache', async () => {
    mockCreateAgentLoop.mockImplementationOnce((_config, onEvent: (event: { type: string; data?: Record<string, unknown> }) => void) => ({
      run: vi.fn(async () => {
        onEvent({
          type: 'message_delta',
          data: {
            role: 'assistant',
            path: 'content',
            op: 'append',
            text: 'hello ',
            turnId: 'turn-1',
            messageId: 'turn-1',
            deltaSeq: 1,
          },
        });
        onEvent({
          type: 'message_delta',
          data: {
            role: 'assistant',
            path: 'content',
            op: 'append',
            text: 'hello ',
            turnId: 'turn-1',
            messageId: 'turn-1',
            deltaSeq: 1,
          },
        });
        onEvent({
          type: 'message_delta',
          data: {
            role: 'assistant',
            path: 'content',
            op: 'append',
            text: 'world',
            turnId: 'turn-1',
            messageId: 'turn-1',
            deltaSeq: 2,
          },
        });
      }),
      cancel: mockCancel,
    }));

    const response = await fetch(`${baseUrl}/api/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt: 'stream with duplicate delta',
        sessionId: 'session-duplicate-delta',
      }),
    });
    const body = await response.text();

    expect(response.ok).toBe(true);
    expect(body).toContain('"text":"hello world"');
    expect(body).not.toContain('"text":"hello hello world"');
    const cached = sessionMessages.get('session-duplicate-delta') || [];
    const assistant = cached.find((message) => message.role === 'assistant');
    expect(assistant?.content).toBe('hello world');
  });
});
