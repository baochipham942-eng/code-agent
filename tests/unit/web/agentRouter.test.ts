import express from 'express';
import http from 'http';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';
import { createCLIAgent } from '../../../src/cli/adapter';
import { createAgentRouter } from '../../../src/web/routes/agent';
import type { Message } from '../../../src/shared/contract';
import type { PendingOperation, RunCheckpoint, RunEngineRef, RunOwnerLease } from '../../../src/shared/contract/durableRun';
import type { DurableCheckpointInput, PrepareOperationInput, PrepareToolOperationInput } from '../../../src/host/runtime/durableRunKernel';
import {
  setDbAvailable,
} from '../../../src/web/helpers/sessionCache';
import {
  inMemorySessionsProjection as inMemorySessions,
  seedSessionMessagesFromPersisted,
  sessionMessagesProjection as sessionMessages,
} from '../../../src/web/helpers/webSessionStore';
import { RunRegistry } from '../../../src/host/runtime/runRegistry';
import { SteerRejectedError } from '../../../src/host/agent/runtime/conversationRuntime';
import { QueuedInputRepository } from '../../../src/host/services/core/repositories/QueuedInputRepository';

const mockRun = vi.fn();
const mockCancel = vi.fn();
const mockSteer = vi.fn();
const mockCreateAgentLoop = vi.fn();
const mockBroadcastSSE = vi.hoisted(() => vi.fn());
const agentEngineMocks = vi.hoisted(() => ({
  codexRun: vi.fn(),
  claudeRun: vi.fn(),
  mimoRun: vi.fn(),
  kimiRun: vi.fn(),
  resolveExternalEngineLaunch: vi.fn(),
  ledgerUpsertTask: vi.fn(),
  ledgerAppendEvent: vi.fn(),
  ledgerQueueNotification: vi.fn(),
  enqueueReviewSession: vi.fn(),
}));
const mockDb = vi.hoisted(() => ({
  getDb: vi.fn(() => ({})),
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
const mockQueuedInputEnqueue = vi.spyOn(QueuedInputRepository.prototype, 'enqueue')
  .mockImplementation(() => undefined);

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
  createRunToolExecutor: vi.fn(() => ({ execute: vi.fn() })),
  getToolExecutor: vi.fn(() => undefined),
}));

vi.mock('../../../src/web/helpers/sse', async () => {
  const actual = await vi.importActual<typeof import('../../../src/web/helpers/sse')>(
    '../../../src/web/helpers/sse',
  );
  return {
    ...actual,
    broadcastSSE: mockBroadcastSSE,
  };
});

const mockGetOverride = vi.hoisted(() => vi.fn<() => unknown>(() => null));
vi.mock('../../../src/host/session/modelSessionState', () => ({
  getModelSessionState: () => ({
    getOverride: mockGetOverride,
  }),
}));

const mockRehydrateOverride = vi.hoisted(() => vi.fn<(session: unknown) => unknown>(() => null));
vi.mock('../../../src/host/session/modelOverridePersistence', () => ({
  rehydrateModelOverrideFromSession: mockRehydrateOverride,
}));

vi.mock('../../../src/host/services/agentEngine', async () => {
  const actual = await vi.importActual<typeof import('../../../src/host/services/agentEngine')>(
    '../../../src/host/services/agentEngine',
  );
  return ({
  ...actual,
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
  MimoCliAdapter: vi.fn(function MimoCliAdapterMock() {
    return {
      run: agentEngineMocks.mimoRun,
    };
  }),
  KimiCliAdapter: vi.fn(function KimiCliAdapterMock() {
    return {
      run: agentEngineMocks.kimiRun,
    };
  }),
  isExternalAgentEngine: (kind: unknown) =>
    kind === 'codex_cli' || kind === 'claude_code' || kind === 'mimo_code' || kind === 'kimi_code',
  resolveExternalEngineLaunch: (...args: unknown[]) => agentEngineMocks.resolveExternalEngineLaunch(...args),
  getRemoteAgentEngineModelCatalogService: () => ({
    resolveModelId: async (_kind: unknown, requested?: string | null) => requested ?? undefined,
  }),
  });
});

vi.mock('../../../src/host/task/backgroundTaskLedger', () => ({
  getBackgroundTaskLedger: () => ({
    upsertTask: agentEngineMocks.ledgerUpsertTask,
    appendEvent: agentEngineMocks.ledgerAppendEvent,
    queueNotification: agentEngineMocks.ledgerQueueNotification,
  }),
}));

vi.mock('../../../src/host/evaluation/reviewQueueService', () => ({
  ReviewQueueService: {
    getInstance: () => ({
      enqueueSession: agentEngineMocks.enqueueReviewSession,
    }),
  },
}));

vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => mockDb,
}));

vi.mock('../../../src/host/telemetry', () => ({
  getTelemetryCollector: () => ({
    endSession: vi.fn(),
  }),
}));

let server: http.Server | undefined;
let baseUrl = '';
const runRegistry = new RunRegistry();
const testRunKernel = {
  createRun: vi.fn(async (input: { runId: string; sessionId: string; engine: RunEngineRef; now: number; initialEngineCursor?: unknown; initialPendingOperations?: PendingOperation[] }) => {
    const owner = { ownerId: 'test', processInstanceId: 'test-process', epoch: 1, leaseExpiresAt: input.now + 60_000 };
    return {
      owner,
      attempt: {
        runId: input.runId, attempt: 1, processInstanceId: 'test-process', ownerId: 'test',
        ownerEpoch: 1, status: 'active' as const, startedAt: input.now,
      },
      envelope: {
        schemaVersion: 1 as const, runId: input.runId, sessionId: input.sessionId,
        engine: input.engine, status: 'running' as const, attempt: 1,
        cursor: { nextEventSeq: 1, checkpointSeq: 0, engineCursor: input.initialEngineCursor }, owner,
        pendingOperations: input.initialPendingOperations ?? [], childRuns: [],
        createdAt: input.now, updatedAt: input.now,
      },
    };
  }),
  createNativeRun: vi.fn(async (input: { runId: string; sessionId: string; now: number }) => {
    const owner = { ownerId: 'test', processInstanceId: 'test-process', epoch: 1, leaseExpiresAt: input.now + 60_000 };
    return {
      owner,
      attempt: {
        runId: input.runId, attempt: 1, processInstanceId: 'test-process', ownerId: 'test',
        ownerEpoch: 1, status: 'active' as const, startedAt: input.now,
      },
      envelope: {
        schemaVersion: 1 as const, runId: input.runId, sessionId: input.sessionId,
        engine: { kind: 'native' as const }, status: 'running' as const, attempt: 1,
        cursor: { nextEventSeq: 1, checkpointSeq: 0 }, owner,
        createdAt: input.now, updatedAt: input.now,
      },
    };
  }),
  heartbeat: vi.fn(async (_runId: string, owner: RunOwnerLease) => owner),
  checkpoint: vi.fn(async (input: DurableCheckpointInput): Promise<RunCheckpoint> => ({
    runId: input.runId,
    checkpointSeq: 1,
    attempt: input.attempt,
    eventSeq: input.events.length,
    status: input.status,
    cursor: { nextEventSeq: 2, checkpointSeq: 1, engineCursor: input.engineCursor },
    state: input.state,
    checksum: 'test-checksum',
    createdAt: input.now,
  })),
  terminal: vi.fn(async () => ({} as never)),
  release: vi.fn(async () => true),
  recoverOnStartup: vi.fn(async () => []),
  prepareOperation: vi.fn((input: PrepareOperationInput) => ({
    runId: input.runId,
    operationId: input.operationId,
    attempt: input.attempt,
    kind: input.kind,
    status: 'prepared' as const,
    idempotencyKey: `stable:${input.runId}:${input.operationId}`,
    sideEffect: true,
    preparedAt: input.now,
    updatedAt: input.now,
  })),
  prepareToolOperation: vi.fn(),
};
const originalCodeAgentDataDir = process.env.CODE_AGENT_DATA_DIR;
let tempDataDir: string | undefined;
let queuedInputTestDb: BetterSqlite3.Database | undefined;

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

async function startAgentApi(deps: {
  tryGetSessionManager?: () => Promise<unknown>;
  tryGetCLISessionManager?: () => Promise<unknown>;
  getSupabaseForSession?: () => Promise<unknown>;
} = {}) {
  const app = express();
  app.use(express.json());
  // Each test scenario mocks only the AgentSessionManagerLike/SupabaseAgentBinding
  // methods it exercises, not the full interface — assert to the real deps
  // shape at the router boundary rather than widening every call site's mock.
  app.use('/api', createAgentRouter({
    runRegistry,
    pendingLocalToolCalls: new Map(),
    logger,
    tryGetSessionManager: deps.tryGetSessionManager ?? (async () => null),
    tryGetCLISessionManager: deps.tryGetCLISessionManager
      ?? deps.tryGetSessionManager
      ?? (async () => null),
    getSupabaseForSession: deps.getSupabaseForSession ?? (async () => null),
  } as Parameters<typeof createAgentRouter>[0]));

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

async function readSSEUntilWithoutClosing(response: globalThis.Response, marker: string): Promise<string> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (!buffer.includes(marker)) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
  }
  reader.releaseLock();
  return buffer;
}

function parseSSEData(raw: string, eventName: string): Record<string, unknown> | null {
  const lines = raw.split('\n');
  const eventIndex = lines.findIndex((line) => line.trim() === `event: ${eventName}`);
  if (eventIndex < 0) return null;
  const dataLine = lines.slice(eventIndex + 1).find((line) => line.trim().startsWith('data:'));
  return dataLine ? JSON.parse(dataLine.trim().slice(5).trim()) as Record<string, unknown> : null;
}

describe('createAgentRouter', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    runRegistry.clear();
    runRegistry.configureDurableKernel(testRunKernel);
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
    agentEngineMocks.mimoRun.mockReset();
    agentEngineMocks.kimiRun.mockReset();
    agentEngineMocks.ledgerUpsertTask.mockReset();
    agentEngineMocks.ledgerAppendEvent.mockReset();
    agentEngineMocks.ledgerQueueNotification.mockReset();
    agentEngineMocks.enqueueReviewSession.mockReset();
    mockDb.getSession.mockReturnValue({
      id: 'session-existing',
      title: 'Existing',
    });
    mockDb.getMessages.mockReturnValue([]);
    mockDb.getDb.mockReturnValue({});
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
    queuedInputTestDb?.close();
    queuedInputTestDb = undefined;
    if (originalCodeAgentDataDir === undefined) {
      delete process.env.CODE_AGENT_DATA_DIR;
    } else {
      process.env.CODE_AGENT_DATA_DIR = originalCodeAgentDataDir;
    }
    runRegistry.clear();
    inMemorySessions.clear();
    sessionMessages.clear();
    setDbAvailable(false);
  });

  // --------------------------------------------------------------------------
  // /agent 显式选择的路由真相（三层一致性批③）：web 生产路径此前从不发射
  // routing_resolved，解析失败只打 warn 日志（静默兜底）——徽标/路由证据在生产
  // 路径恒空。这里锁死：命中/失败都必须发 routing_resolved，且 requestedAgentId
  // 必须进 AgentLoop config（turnQuality 徽标降级判定用）。
  // --------------------------------------------------------------------------
  describe('/api/run preferredAgentId 路由真相（routing_resolved over SSE）', () => {
    function parseSSEEvent(raw: string, eventName: string): Record<string, unknown> | null {
      const lines = raw.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].trim() === `event: ${eventName}`) {
          const dataLine = lines[i + 1]?.trim();
          if (dataLine?.startsWith('data:')) {
            return JSON.parse(dataLine.slice(5).trim()) as Record<string, unknown>;
          }
        }
      }
      return null;
    }

    async function readSSEUntil(response: globalThis.Response, marker: string, timeoutMs = 2000): Promise<string> {
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline && !buffer.includes(marker)) {
        const chunk = await Promise.race([
          reader.read(),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), Math.max(1, deadline - Date.now()))),
        ]);
        if (!chunk || chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
      }
      await reader.cancel().catch(() => {});
      return buffer;
    }

    it('显式选择命中 → SSE routing_resolved mode=explicit 且 config 带 agentOverride+requestedAgentId', async () => {
      const controller = new AbortController();
      const response = await fetch(`${baseUrl}/api/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          prompt: '看看这个仓库的结构',
          sessionId: 'session-explicit-hit',
          context: { preferredAgentId: 'explore' },
        }),
        signal: controller.signal,
      });
      expect(response.ok).toBe(true);

      const raw = await readSSEUntil(response, 'routing_resolved');
      const payload = parseSSEEvent(raw, 'routing_resolved');
      expect(payload).toMatchObject({
        mode: 'explicit',
        agentId: 'explore',
        requestedAgentId: 'explore',
        fallbackToDefault: false,
      });

      await waitForAssertion(() => {
        expect(mockCreateAgentLoop).toHaveBeenCalled();
      });
      const config = mockCreateAgentLoop.mock.calls[0][0] as {
        agentOverride?: { id: string };
        requestedAgentId?: string;
      };
      expect(config.agentOverride?.id).toBe('explore');
      expect(config.requestedAgentId).toBe('explore');

      controller.abort();
      await waitForAssertion(() => {
        expect(mockCancel).toHaveBeenCalledWith('user');
      });
    });

    it('显式选择解析失败 → SSE routing_resolved 降级信号（fallbackToDefault+requestedAgentId），不再静默', async () => {
      const controller = new AbortController();
      const response = await fetch(`${baseUrl}/api/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          prompt: 'hello',
          sessionId: 'session-explicit-miss',
          context: { preferredAgentId: '__ghost_agent__' },
        }),
        signal: controller.signal,
      });
      expect(response.ok).toBe(true);

      const raw = await readSSEUntil(response, 'routing_resolved');
      const payload = parseSSEEvent(raw, 'routing_resolved');
      expect(payload).toMatchObject({
        mode: 'explicit',
        agentId: 'default',
        agentName: 'default',
        requestedAgentId: '__ghost_agent__',
        fallbackToDefault: true,
      });

      await waitForAssertion(() => {
        expect(mockCreateAgentLoop).toHaveBeenCalled();
      });
      const config = mockCreateAgentLoop.mock.calls[0][0] as {
        agentOverride?: { id: string };
        requestedAgentId?: string;
      };
      expect(config.agentOverride).toBeUndefined();
      expect(config.requestedAgentId).toBe('__ghost_agent__');

      controller.abort();
      await waitForAssertion(() => {
        expect(mockCancel).toHaveBeenCalledWith('user');
      });
    });

    it('preferredAgentId 带空白 → 规整后不产生假降级（requestedAgentId === 实际 agentId）', async () => {
      const controller = new AbortController();
      const response = await fetch(`${baseUrl}/api/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          prompt: 'hi',
          sessionId: 'session-padded-id',
          context: { preferredAgentId: '  explore  ' },
        }),
        signal: controller.signal,
      });
      expect(response.ok).toBe(true);

      const raw = await readSSEUntil(response, 'routing_resolved');
      const payload = parseSSEEvent(raw, 'routing_resolved');
      expect(payload).toMatchObject({
        mode: 'explicit',
        agentId: 'explore',
        requestedAgentId: 'explore',
        fallbackToDefault: false,
      });

      controller.abort();
      await waitForAssertion(() => {
        expect(mockCancel).toHaveBeenCalledWith('user');
      });
    });

    it('无 preferredAgentId → 不发射 routing_resolved（不给无显式选择的轮次加噪音）', async () => {
      const controller = new AbortController();
      const response = await fetch(`${baseUrl}/api/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          prompt: 'hello',
          sessionId: 'session-no-preferred',
        }),
        signal: controller.signal,
      });
      expect(response.ok).toBe(true);

      await waitForAssertion(() => {
        expect(mockCreateAgentLoop).toHaveBeenCalled();
      });
      // 读一小段流（task_start 之后），确认没有 routing_resolved
      const raw = await readSSEUntil(response, 'task_start', 500);
      expect(raw).not.toContain('event: routing_resolved');

      controller.abort();
      await waitForAssertion(() => {
        expect(mockCancel).toHaveBeenCalledWith('user');
      });
    });
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
      expect(runRegistry.hasSession('session-disconnect')).toBe(true);
    });

    controller.abort();

    await waitForAssertion(() => {
      expect(mockCancel).toHaveBeenCalledWith('user');
    });
  });

  it('persists both messages when disconnect cancellation releases the session and drains its queued turn', async () => {
    await closeServer();
    setDbAvailable(true);

    queuedInputTestDb = new Database(':memory:');
    queuedInputTestDb.exec(`
      CREATE TABLE queued_inputs (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        envelope_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued',
        retry_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX idx_queued_inputs_session
        ON queued_inputs (session_id, status, created_at);
    `);
    mockDb.getDb.mockReturnValue(queuedInputTestDb as never);

    const persistedMessages: Message[] = [
      { id: 'prior-user', role: 'user', content: '先执行长任务', timestamp: 1 },
      { id: 'prior-assistant', role: 'assistant', content: '开始执行', timestamp: 2 },
    ];
    const addMessageToSession = vi.fn(async (_sessionId: string, message: Message) => {
      const existing = persistedMessages.findIndex((candidate) => candidate.id === message.id);
      if (existing >= 0) persistedMessages[existing] = message;
      else persistedMessages.push(message);
    });
    const getMessages = vi.fn(async () => [...persistedMessages]);

    let settleCancelledRun: (() => void) | undefined;
    const cancelPriorRun = vi.fn(() => {
      settleCancelledRun?.();
    });
    const queueAfterSettlement = vi.fn().mockRejectedValue(new SteerRejectedError());
    mockCreateAgentLoop
      .mockImplementationOnce((_config, onEvent: (event: { type: string; data?: unknown }) => void) => ({
        run: vi.fn(() => new Promise<void>((resolve) => {
          settleCancelledRun = () => {
            onEvent({ type: 'agent_cancelled', data: null });
            resolve();
          };
        })),
        cancel: cancelPriorRun,
        steer: queueAfterSettlement,
      }))
      .mockImplementationOnce((_config, onEvent: (event: { type: string; data?: unknown }) => void) => ({
        run: vi.fn(async () => {
          onEvent({
            type: 'message',
            data: {
              id: 'drained-loop-assistant',
              role: 'assistant',
              content: '排队轮次已完成',
              timestamp: 4,
            },
          });
        }),
        cancel: vi.fn(),
      }));

    await startAgentApi({
      tryGetSessionManager: async () => ({
        addMessageToSession,
        getMessages,
        getSession: vi.fn(async () => ({
          id: 'session-disconnect-drain-persist',
          title: 'Existing',
          workingDirectory: '/tmp/disconnect-drain-persist',
        })),
        updateSession: vi.fn(async () => undefined),
      }),
    });

    const controller = new AbortController();
    const response = await fetch(`${baseUrl}/api/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt: '正在运行且随后断连',
        sessionId: 'session-disconnect-drain-persist',
        clientMessageId: 'active-user',
      }),
      signal: controller.signal,
    });
    expect(response.ok).toBe(true);
    await waitForAssertion(() => expect(mockCreateAgentLoop).toHaveBeenCalledTimes(1), 3000);

    mockQueuedInputEnqueue.mockImplementationOnce((input) => {
      queuedInputTestDb!.prepare(`
        INSERT INTO queued_inputs (
          id, session_id, envelope_json, status, retry_count, created_at, updated_at
        ) VALUES (?, ?, ?, 'queued', 0, ?, ?)
      `).run(
        input.id,
        input.sessionId,
        'envelope' in input ? JSON.stringify(input.envelope) : input.envelopeJson,
        input.now ?? 10,
        input.now ?? 10,
      );
    });
    const queued = await fetch(`${baseUrl}/api/interrupt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        content: '运行排队轮次',
        sessionId: 'session-disconnect-drain-persist',
        clientMessageId: 'drained-user',
      }),
    });
    expect(queued.ok).toBe(true);
    await expect(queued.json()).resolves.toEqual({
      success: true,
      data: { outcome: 'queued', queuedInputId: 'drained-user' },
    });

    controller.abort();
    await waitForAssertion(() => expect(cancelPriorRun).toHaveBeenCalledWith('user'), 3000);
    await vi.waitFor(() => {
      expect(new QueuedInputRepository(queuedInputTestDb!).getById('drained-user')).toMatchObject({
        status: 'consumed',
      });
    }, { timeout: 3000 });

    const drainedTurn = persistedMessages.filter((message) =>
      message.id === 'drained-user' || message.content === '排队轮次已完成');
    expect(drainedTurn).toEqual([
      expect.objectContaining({ id: 'drained-user', role: 'user', content: '运行排队轮次' }),
      expect.objectContaining({ role: 'assistant', content: '排队轮次已完成' }),
    ]);
  });

  describe('S2 Native Run lifecycle isolation', () => {
    function createPendingLoop() {
      let release: (() => void) | undefined;
      const run = vi.fn(() => new Promise<void>((resolve) => {
        release = resolve;
      }));
      const cancel = vi.fn(() => {
        release?.();
      });
      return {
        run,
        cancel,
        steer: vi.fn(),
        release: () => release?.(),
      };
    }

    async function waitForAttached(sessionId: string): Promise<void> {
      await waitForAssertion(() => {
        expect(runRegistry.getBySessionId(sessionId)?.isAttached).toBe(true);
      }, 3000);
    }

    it('returns an independent runId and rejects a concurrent start for the same session before SSE 200', async () => {
      const controller = new AbortController();
      const first = await fetch(`${baseUrl}/api/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'first', sessionId: 'session-s2-conflict' }),
        signal: controller.signal,
      });
      expect(first.status).toBe(200);

      const taskStartRaw = await readSSEUntilWithoutClosing(first, 'event: task_start');
      const taskStart = parseSSEData(taskStartRaw, 'task_start');
      expect(taskStart?.sessionId).toBe('session-s2-conflict');
      expect(taskStart?.runId).toEqual(expect.any(String));
      expect(taskStart?.runId).not.toBe('session-s2-conflict');

      const second = await fetch(`${baseUrl}/api/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'second', sessionId: 'session-s2-conflict' }),
      });
      expect(second.status).toBe(409);
      expect(second.headers.get('content-type')).toContain('application/json');
      await expect(second.json()).resolves.toMatchObject({
        code: 'RUN_SESSION_CONFLICT',
        sessionId: 'session-s2-conflict',
        activeRunId: taskStart?.runId,
      });
      await waitForAssertion(() => expect(mockCreateAgentLoop).toHaveBeenCalledTimes(1));
      const loopTraceContext = mockCreateAgentLoop.mock.calls[0]?.[7] as {
        traceId?: string;
        spanId?: string;
        runId?: string;
        sessionId?: string;
        attempt?: number;
      };
      expect(loopTraceContext).toMatchObject({
        traceId: expect.stringMatching(/^[0-9a-f]{32}$/),
        spanId: expect.stringMatching(/^[0-9a-f]{16}$/),
        runId: taskStart?.runId,
        sessionId: 'session-s2-conflict',
        attempt: 1,
      });

      controller.abort();
      await waitForAssertion(() => expect(runRegistry.hasSession('session-s2-conflict')).toBe(false), 3000);
    });

    it('allocates distinct temporary sessions for same-millisecond concurrent starts', async () => {
      const loopA = createPendingLoop();
      const loopB = createPendingLoop();
      mockCreateAgentLoop
        .mockImplementationOnce(() => loopA)
        .mockImplementationOnce(() => loopB);
      const controllerA = new AbortController();
      const controllerB = new AbortController();
      const dateNow = vi.spyOn(Date, 'now').mockReturnValue(1_234_567_890);

      const responses = await Promise.all([
        fetch(`${baseUrl}/api/run`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ prompt: 'temporary A' }),
          signal: controllerA.signal,
        }),
        fetch(`${baseUrl}/api/run`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ prompt: 'temporary B' }),
          signal: controllerB.signal,
        }),
      ]).finally(() => {
        dateNow.mockRestore();
      });

      expect(responses.map((response) => response.status)).toEqual([200, 200]);
      expect(runRegistry.size).toBe(2);
      const handles = runRegistry.list();
      expect(new Set(handles.map((handle) => handle.context.sessionId)).size).toBe(2);
      expect(handles.every((handle) => handle.context.sessionId.startsWith('web-session-'))).toBe(true);

      controllerA.abort();
      controllerB.abort();
      loopA.release();
      loopB.release();
      await waitForAssertion(() => expect(runRegistry.size).toBe(0), 3000);
    });

    it('keeps selector-less cancel compatible for exactly one run when POST has no body', async () => {
      const loop = createPendingLoop();
      mockCreateAgentLoop.mockImplementationOnce(() => loop);
      const response = await fetch(`${baseUrl}/api/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'single', sessionId: 'session-s2-single' }),
      });
      expect(response.status).toBe(200);
      await waitForAttached('session-s2-single');

      const cancelled = await fetch(`${baseUrl}/api/cancel`, { method: 'POST' });

      expect(cancelled.status).toBe(200);
      await expect(cancelled.json()).resolves.toMatchObject({
        message: 'Cancelled',
        sessionId: 'session-s2-single',
      });
      expect(loop.cancel).toHaveBeenCalledOnce();
      await response.text();
      await waitForAssertion(() => expect(runRegistry.size).toBe(0), 3000);
    });

    it('requires a selector with multiple runs and cancels only the selected runId', async () => {
      const loopA = createPendingLoop();
      const loopB = createPendingLoop();
      mockCreateAgentLoop.mockImplementation((...args: unknown[]) => (
        args[3] === 'session-s2-a' ? loopA : loopB
      ));

      const controllerA = new AbortController();
      const controllerB = new AbortController();
      const [responseA, responseB] = await Promise.all([
        fetch(`${baseUrl}/api/run`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ prompt: 'A', sessionId: 'session-s2-a' }),
          signal: controllerA.signal,
        }),
        fetch(`${baseUrl}/api/run`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ prompt: 'B', sessionId: 'session-s2-b' }),
          signal: controllerB.signal,
        }),
      ]);
      expect([responseA.status, responseB.status]).toEqual([200, 200]);
      await Promise.all([waitForAttached('session-s2-a'), waitForAttached('session-s2-b')]);

      const ambiguous = await fetch(`${baseUrl}/api/cancel`, {
        method: 'POST',
      });
      expect(ambiguous.status).toBe(409);
      await expect(ambiguous.json()).resolves.toMatchObject({ code: 'RUN_TARGET_REQUIRED' });
      expect(loopA.cancel).not.toHaveBeenCalled();
      expect(loopB.cancel).not.toHaveBeenCalled();

      const runA = runRegistry.getBySessionId('session-s2-a')!;
      const cancelA = await fetch(`${baseUrl}/api/cancel`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ runId: runA.context.runId }),
      });
      expect(cancelA.status).toBe(200);
      await expect(cancelA.json()).resolves.toMatchObject({
        runId: runA.context.runId,
        sessionId: 'session-s2-a',
      });
      expect(loopA.cancel).toHaveBeenCalledOnce();
      expect(loopB.cancel).not.toHaveBeenCalled();
      await waitForAssertion(() => expect(runRegistry.hasSession('session-s2-a')).toBe(false), 3000);
      expect(runRegistry.hasSession('session-s2-b')).toBe(true);

      controllerA.abort();
      controllerB.abort();
      loopA.release();
      loopB.release();
      await waitForAssertion(() => expect(runRegistry.size).toBe(0), 3000);
    });

    it('disconnecting one concurrent response cancels only its captured RunHandle', async () => {
      const loopA = createPendingLoop();
      const loopB = createPendingLoop();
      mockCreateAgentLoop.mockImplementation((...args: unknown[]) => (
        args[3] === 'session-s2-disconnect-a' ? loopA : loopB
      ));
      const controllerA = new AbortController();
      const controllerB = new AbortController();

      await Promise.all([
        fetch(`${baseUrl}/api/run`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ prompt: 'A', sessionId: 'session-s2-disconnect-a' }),
          signal: controllerA.signal,
        }),
        fetch(`${baseUrl}/api/run`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ prompt: 'B', sessionId: 'session-s2-disconnect-b' }),
          signal: controllerB.signal,
        }),
      ]);
      await Promise.all([
        waitForAttached('session-s2-disconnect-a'),
        waitForAttached('session-s2-disconnect-b'),
      ]);

      controllerA.abort();
      await waitForAssertion(() => expect(loopA.cancel).toHaveBeenCalledOnce(), 3000);
      expect(loopB.cancel).not.toHaveBeenCalled();
      expect(runRegistry.hasSession('session-s2-disconnect-b')).toBe(true);

      loopA.release();
      loopB.release();
      await waitForAssertion(() => expect(runRegistry.size).toBe(0), 3000);
      expect(loopB.cancel).not.toHaveBeenCalled();
    });

    it('remembers cancellation before loop attachment and keeps the session reserved until settlement', async () => {
      type Agent = Awaited<ReturnType<typeof createCLIAgent>>;
      let releaseAgent!: (agent: Agent) => void;
      const delayedAgent = new Promise<Agent>((resolve) => {
        releaseAgent = resolve;
      });
      vi.mocked(createCLIAgent).mockReturnValueOnce(delayedAgent);
      const loop = createPendingLoop();
      mockCreateAgentLoop.mockImplementationOnce(() => loop);

      const responsePromise = fetch(`${baseUrl}/api/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'delayed', sessionId: 'session-s2-pre-attach' }),
      });
      await waitForAssertion(() => expect(runRegistry.hasSession('session-s2-pre-attach')).toBe(true), 3000);
      const runId = runRegistry.getBySessionId('session-s2-pre-attach')!.context.runId;

      // A3: /api/cancel waits for settlement — start it without awaiting so agent
      // creation can still complete and deliver the remembered cancel.
      const cancelledPromise = fetch(`${baseUrl}/api/cancel`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ runId }),
      });

      const conflict = await fetch(`${baseUrl}/api/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'must reject', sessionId: 'session-s2-pre-attach' }),
      });
      expect(conflict.status).toBe(409);
      expect(loop.cancel).not.toHaveBeenCalled();

      releaseAgent({
        getConfig: () => ({
          modelConfig: { provider: 'xiaomi', model: 'mimo-v2.5-pro', apiKey: 'mock-key' },
          systemPrompt: '',
        }),
      } as Agent);
      const response = await responsePromise;
      await response.text();
      await waitForAssertion(() => expect(loop.cancel).toHaveBeenCalledOnce(), 3000);
      expect(loop.run).not.toHaveBeenCalled();
      expect(runRegistry.hasSession('session-s2-pre-attach')).toBe(false);

      const cancelled = await cancelledPromise;
      expect(cancelled.status).toBe(200);
      await expect(cancelled.json()).resolves.toMatchObject({
        message: 'Cancelled',
        runId,
        sessionId: 'session-s2-pre-attach',
      });
    });
  });

  describe('/api/run SSE per-token 并发上限（WP3-4）', () => {
    // 外层 beforeEach 的 releaseRun 是单值会被并发 run 覆盖（只能释放最后一个），
    // 本组测试开 N 条并发流，改用 per-loop 释放器（cancel 只放行自己的 run）；
    // 每个测试收尾必须排空（放行全部悬挂 run + 等 RunRegistry 清零），
    // 否则悬挂 handler 泄漏进下一个测试。
    const pendingReleases: Array<() => void> = [];
    beforeEach(() => {
      pendingReleases.length = 0;
      mockCreateAgentLoop.mockImplementation(() => {
        // 注意不能复用 mockRun.mockImplementation（后创建的 loop 会覆盖前者的闭包），
        // 每个 loop 拿独立函数；mockCancel 仅作调用计数 spy。
        let release: (() => void) | null = null;
        return {
          run: () => new Promise<void>((resolve) => {
            release = resolve;
            pendingReleases.push(resolve);
          }),
          cancel: (...args: unknown[]) => {
            mockCancel(...args);
            release?.();
          },
          steer: mockSteer,
        };
      });
    });

    const drainRuns = async (opened: Array<{ controller: AbortController }>) => {
      for (const o of opened) o.controller.abort();
      // 反复排空：run promise 可能在 abort 之后才被 handler 创建（异步 setup 竞态），
      // 单次 splice 会漏掉迟到的 release。
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline && runRegistry.size > 0) {
        pendingReleases.splice(0).forEach((release) => release());
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      pendingReleases.splice(0).forEach((release) => release());
      expect(runRegistry.size).toBe(0);
    };

    const openRun = (sessionId: string, token: string) => {
      const controller = new AbortController();
      const responsePromise = fetch(`${baseUrl}/api/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ prompt: '长任务', sessionId }),
        signal: controller.signal,
      });
      return { controller, responsePromise };
    };

    it('同 token 超并发上限 → 第 N+1 条返回 429 JSON（writeHead 之前拒绝），不起 agent loop', async () => {
      const { WEB_SSE } = await import('../../../src/shared/constants');
      const max = WEB_SSE.MAX_CONCURRENT_PER_TOKEN;
      const opened: Array<{ controller: AbortController; responsePromise: Promise<Response> }> = [];
      try {
        for (let i = 0; i < max; i++) {
          opened.push(openRun(`session-cap-${i}`, 'tok-cap'));
        }
        const responses = await Promise.all(opened.map((o) => o.responsePromise));
        for (const r of responses) expect(r.status).toBe(200);
        await waitForAssertion(() => {
          expect(mockCreateAgentLoop).toHaveBeenCalledTimes(max);
        });

        const overflow = openRun(`session-cap-overflow`, 'tok-cap');
        const overflowRes = await overflow.responsePromise;
        expect(overflowRes.status).toBe(429);
        expect(overflowRes.headers.get('content-type')).toContain('application/json');
        const body = await overflowRes.json();
        expect(typeof body.error).toBe('string');
        expect(mockCreateAgentLoop).toHaveBeenCalledTimes(max); // 超限请求没起 loop
      } finally {
        await drainRuns(opened);
      }
    });

    it('断线释放槽位 → 新连接可进（断线清理）', async () => {
      const { WEB_SSE } = await import('../../../src/shared/constants');
      const max = WEB_SSE.MAX_CONCURRENT_PER_TOKEN;
      const opened: Array<{ controller: AbortController; responsePromise: Promise<Response> }> = [];
      try {
        for (let i = 0; i < max; i++) {
          opened.push(openRun(`session-rel-${i}`, 'tok-rel'));
        }
        await Promise.all(opened.map((o) => o.responsePromise));

        opened[0].controller.abort(); // 断线其中一条
        await waitForAssertion(() => {
          expect(mockCancel).toHaveBeenCalled();
        });

        // 槽位释放后，新连接应被接受（重试等待释放传播）
        let accepted = false;
        const deadline = Date.now() + 3000;
        while (!accepted && Date.now() < deadline) {
          const retry = openRun(`session-rel-new-${Date.now()}`, 'tok-rel');
          const res = await retry.responsePromise;
          retry.controller.abort();
          if (res.status === 200) {
            accepted = true;
          } else {
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
        }
        expect(accepted).toBe(true);
      } finally {
        await drainRuns(opened);
      }
    });

    it('不同 token 各自计数：token A 打满不影响 token B', async () => {
      const { WEB_SSE } = await import('../../../src/shared/constants');
      const max = WEB_SSE.MAX_CONCURRENT_PER_TOKEN;
      const opened: Array<{ controller: AbortController; responsePromise: Promise<Response> }> = [];
      try {
        for (let i = 0; i < max; i++) {
          opened.push(openRun(`session-multi-${i}`, 'tok-full'));
        }
        await Promise.all(opened.map((o) => o.responsePromise));

        const other = openRun('session-other-token', 'tok-free');
        opened.push(other);
        const res = await other.responsePromise;
        expect(res.status).toBe(200);
      } finally {
        await drainRuns(opened);
      }
    });
  });

  it('rejects invalid /api/run bodies before starting an agent loop', async () => {
    const response = await fetch(`${baseUrl}/api/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt: 42,
        sessionId: 'session-invalid-run-body',
      }),
    });
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toEqual({ error: 'Missing prompt' });
    expect(mockCreateAgentLoop).not.toHaveBeenCalled();
    expect(createCLIAgent).not.toHaveBeenCalled();
  });

  it('uses clientMessageId as the persisted user message id for /api/run', async () => {
    mockRun.mockResolvedValueOnce(undefined);

    const persistedMessages: Message[] = [];
    const addMessageToSession = vi.fn(async (_sessionId: string, message: Message) => {
      persistedMessages.push(message);
    });
    await closeServer();
    await startAgentApi({
      tryGetSessionManager: async () => ({
        addMessageToSession,
        getMessages: vi.fn(async () => persistedMessages),
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

  // 工单行为不变清单 #1：工具-only 轮也要把 user 留在多轮上下文。
  it('keeps a tool-only turn user message in cache and includes it in the next run history', async () => {
    mockCreateAgentLoop
      .mockImplementationOnce((_config, onEvent: (event: { type: string; data?: Record<string, unknown> }) => void) => ({
        run: vi.fn(async () => {
          onEvent({ type: 'tool_call_start', data: { id: 'tool-only-1', name: 'Read' } });
          onEvent({
            type: 'tool_call_end',
            data: { toolCallId: 'tool-only-1', success: true, output: 'done' },
          });
        }),
        cancel: mockCancel,
      }))
      .mockImplementationOnce(() => ({
        run: vi.fn(async () => undefined),
        cancel: mockCancel,
      }));

    const first = await fetch(`${baseUrl}/api/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt: '第一轮只调用工具',
        sessionId: 'session-tool-only-history',
        clientMessageId: 'tool-only-user-1',
      }),
    });
    expect(first.ok).toBe(true);
    await first.text();

    expect(sessionMessages.get('session-tool-only-history')).toEqual([
      expect.objectContaining({
        id: 'tool-only-user-1',
        role: 'user',
        content: '第一轮只调用工具',
      }),
      expect.objectContaining({
        role: 'assistant',
        content: '',
        toolCalls: [expect.objectContaining({ id: 'tool-only-1', name: 'Read' })],
      }),
    ]);

    const second = await fetch(`${baseUrl}/api/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt: '第二轮继续',
        sessionId: 'session-tool-only-history',
        clientMessageId: 'tool-only-user-2',
      }),
    });
    expect(second.ok).toBe(true);
    await second.text();

    const secondRunHistory = mockCreateAgentLoop.mock.calls[1]?.[2] as Array<{
      id: string;
      role: string;
      content: string;
    }>;
    expect(secondRunHistory).toEqual([
      expect.objectContaining({ id: 'tool-only-user-1', role: 'user', content: '第一轮只调用工具' }),
      expect.objectContaining({ role: 'assistant', content: '' }),
      expect.objectContaining({ id: 'tool-only-user-2', role: 'user', content: '第二轮继续' }),
    ]);
  });

  // 工单行为不变清单 #2：user 仍 pre-persist，取消后仍不兜底写 assistant。
  // 批 2 拍板变化：统一 DB 真相，loop 已落库的 partial assistant 在当前会话缓存内可见。
  it('projects a persisted partial assistant for a cancelled run without a fallback assistant write', async () => {
    await closeServer();
    setDbAvailable(true);

    const persistedMessages: Message[] = [];
    const addMessageToSession = vi.fn(async (_sessionId: string, message: Message) => {
      persistedMessages.push(message);
    });
    const getMessages = vi.fn(async () => persistedMessages);
    mockCreateAgentLoop.mockImplementationOnce((_config, onEvent: (event: { type: string; data?: unknown }) => void) => ({
      run: vi.fn(async () => {
        onEvent({ type: 'stream_chunk', data: { content: '取消前的 partial' } });
        persistedMessages.push({
          id: 'cancelled-partial-1',
          role: 'assistant',
          content: '取消前的 partial',
          timestamp: 2,
        } as Message);
        onEvent({ type: 'agent_cancelled', data: null });
      }),
      cancel: mockCancel,
    }));

    await startAgentApi({
      tryGetSessionManager: async () => ({
        addMessageToSession,
        getMessages,
        getSession: vi.fn(async () => ({ id: 'session-cancelled-write', title: 'Existing' })),
      }),
    });

    const response = await fetch(`${baseUrl}/api/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt: '请执行后取消',
        sessionId: 'session-cancelled-write',
        clientMessageId: 'cancelled-user-1',
      }),
    });
    expect(response.ok).toBe(true);
    await response.text();

    expect(addMessageToSession).toHaveBeenCalledTimes(1);
    expect(addMessageToSession).toHaveBeenCalledWith(
      'session-cancelled-write',
      expect.objectContaining({ id: 'cancelled-user-1', role: 'user', content: '请执行后取消' }),
    );
    expect(sessionMessages.get('session-cancelled-write')).toEqual([
      expect.objectContaining({ id: 'cancelled-user-1', role: 'user' }),
      expect.objectContaining({
        id: 'cancelled-partial-1',
        role: 'assistant',
        content: '取消前的 partial',
      }),
    ]);
  });

  // 工单行为不变清单 #6：直写 DB 碰到重复 msgId 时转 updateMessage，run 不报错。
  it('updates an existing message idempotently when direct DB persistence hits a duplicate msgId', async () => {
    setDbAvailable(true);
    mockDb.addMessage.mockImplementationOnce(() => {
      throw new Error('SQLITE_CONSTRAINT: UNIQUE constraint failed: messages.id');
    });
    mockRun.mockResolvedValueOnce(undefined);

    const response = await fetch(`${baseUrl}/api/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt: '重复消息仍应成功',
        sessionId: 'session-duplicate-message',
        clientMessageId: 'duplicate-message-id',
      }),
    });

    expect(response.ok).toBe(true);
    await response.text();
    expect(mockDb.updateMessage).toHaveBeenCalledWith(
      'duplicate-message-id',
      expect.objectContaining({
        id: 'duplicate-message-id',
        role: 'user',
        content: '重复消息仍应成功',
      }),
      'session-duplicate-message',
    );
  });

  // 工单行为不变清单 #4：!dbAvailable 时消息和会话元数据全部由内存路径维护。
  it('updates in-memory title, messageCount and updatedAt across memory-only turns', async () => {
    const longPrompt = '内'.repeat(31);
    mockCreateAgentLoop
      .mockImplementationOnce(() => ({ run: vi.fn(async () => undefined), cancel: mockCancel }))
      .mockImplementationOnce(() => ({ run: vi.fn(async () => undefined), cancel: mockCancel }));

    const first = await fetch(`${baseUrl}/api/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: longPrompt, sessionId: 'session-memory-metadata' }),
    });
    await first.text();
    const firstMetadata = { ...inMemorySessions.get('session-memory-metadata')! };

    const second = await fetch(`${baseUrl}/api/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: '第二轮', sessionId: 'session-memory-metadata' }),
    });
    await second.text();
    const finalMetadata = inMemorySessions.get('session-memory-metadata');

    expect(firstMetadata).toMatchObject({
      title: `${'内'.repeat(30)}...`,
      messageCount: 1,
    });
    expect(finalMetadata).toMatchObject({
      title: `${'内'.repeat(30)}...`,
      messageCount: 2,
    });
    expect(finalMetadata!.updatedAt).toBeGreaterThanOrEqual(firstMetadata.updatedAt);
    expect(mockDb.addMessage).not.toHaveBeenCalled();
    expect(mockDb.updateSession).not.toHaveBeenCalled();
  });

  // 工单行为不变清单 #8：空 history 视为新会话，标题截断后按固定顺序广播两类 SSE。
  it('truncates a new-session title to 30 characters and broadcasts both session update events in order', async () => {
    mockRun.mockResolvedValueOnce(undefined);
    const prompt = '题'.repeat(31);

    const response = await fetch(`${baseUrl}/api/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt, sessionId: 'session-new-title-events' }),
    });
    await response.text();

    expect(mockBroadcastSSE.mock.calls).toEqual([
      ['session:updated', {
        sessionId: 'session-new-title-events',
        updates: { status: 'running', updatedAt: expect.any(Number) },
      }],
      ['session:list-updated', undefined],
      ['session:updated', {
        sessionId: 'session-new-title-events',
        updates: { title: `${'题'.repeat(30)}...` },
      }],
      ['session:list-updated', undefined],
      ['session:updated', {
        sessionId: 'session-new-title-events',
        updates: { status: 'completed', updatedAt: expect.any(Number) },
      }],
      ['session:list-updated', undefined],
    ]);
  });

  // 工单行为不变清单 #5：路由缓存 push 保留 thinking/contentParts/artifacts/metadata，user attachments 也保留。
  it('keeps rich assistant fields and user attachments in the SSE-backed cache push', async () => {
    const attachment = {
      id: 'characterization-file',
      type: 'file',
      category: 'text',
      name: 'baseline.txt',
      size: 8,
      mimeType: 'text/plain',
      data: 'baseline',
    };
    const metadata = { turnQuality: { capabilities: { agentId: 'explore', agentName: 'Explorer' } } };
    const chart = '```chart\n{"title":"Baseline","data":[]}\n```';
    mockCreateAgentLoop.mockImplementationOnce((_config, onEvent: (event: { type: string; data?: Record<string, unknown> }) => void) => ({
      run: vi.fn(async () => {
        onEvent({
          type: 'message',
          data: { id: 'rich-loop-final', role: 'assistant', content: chart, timestamp: 2, metadata },
        });
        onEvent({ type: 'stream_chunk', data: { content: '先看图表：' } });
        onEvent({ type: 'stream_reasoning', data: { content: '内部思考' } });
        onEvent({ type: 'tool_call_start', data: { id: 'rich-tool', name: 'Read' } });
        onEvent({ type: 'tool_call_end', data: { toolCallId: 'rich-tool', success: true, output: 'ok' } });
        onEvent({ type: 'stream_chunk', data: { content: chart } });
      }),
      cancel: mockCancel,
    }));

    const response = await fetch(`${baseUrl}/api/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt: '保留富字段',
        sessionId: 'session-rich-cache-characterization',
        attachments: [attachment],
      }),
    });
    await response.text();

    const cached = sessionMessages.get('session-rich-cache-characterization')!;
    expect(cached[0]).toMatchObject({ role: 'user', attachments: [attachment] });
    expect(cached[1]).toMatchObject({
      role: 'assistant',
      thinking: '内部思考',
      metadata,
      contentParts: [
        { type: 'text', text: '先看图表：' },
        { type: 'tool_call', toolCallId: 'rich-tool' },
        { type: 'text', text: chart },
      ],
      artifacts: [expect.objectContaining({ type: 'chart', title: 'Baseline' })],
    });
  });

  // 工单行为不变清单 #7：LRU 逐出后的会话由 loadSessionHistoryForRun 从 SM 水合回缓存。
  it('rehydrates an LRU-evicted session from SessionManager before building the next run history', async () => {
    for (let index = 0; index < 51; index += 1) {
      seedSessionMessagesFromPersisted(`lru-session-${index}`, [{
        id: `lru-message-${index}`,
        role: 'user',
        content: `cached-${index}`,
        timestamp: index,
      }]);
    }
    expect(sessionMessages.has('lru-session-0')).toBe(false);

    await closeServer();
    const getMessages = vi.fn(async () => [{
      id: 'lru-message-restored',
      role: 'user',
      content: '从数据库恢复',
      timestamp: 100,
    }]);
    mockCreateAgentLoop.mockImplementationOnce(() => ({
      run: vi.fn(async () => undefined),
      cancel: mockCancel,
    }));
    await startAgentApi({
      tryGetSessionManager: async () => ({
        getMessages,
        getSession: vi.fn(async () => ({ workingDirectory: '/tmp/lru-session' })),
      }),
    });

    const response = await fetch(`${baseUrl}/api/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: '恢复后继续', sessionId: 'lru-session-0' }),
    });
    await response.text();

    expect(getMessages).toHaveBeenCalledWith('lru-session-0');
    expect(mockCreateAgentLoop.mock.calls[0]?.[2]).toEqual([
      expect.objectContaining({ id: 'lru-message-restored', content: '从数据库恢复' }),
      expect.objectContaining({ role: 'user', content: '恢复后继续' }),
    ]);
    expect(sessionMessages.get('lru-session-0')?.[0]).toMatchObject({
      id: 'lru-message-restored',
      content: '从数据库恢复',
    });
    expect(sessionMessages.size).toBe(50);
  });

  // 工单行为不变清单 #9：Supabase W5 保持 pre-persist user + run 后 assistant 的现状写序。
  it('keeps the Supabase sync path writing the user once before the run and the assistant after it', async () => {
    await closeServer();
    const sessionEq = vi.fn(async () => ({ error: null }));
    const sessionsTable = {
      upsert: vi.fn(async () => ({ error: null })),
      update: vi.fn(() => ({ eq: sessionEq })),
    };
    const messagesTable = {
      insert: vi.fn(async (_message: Record<string, unknown>) => ({ error: null })),
    };
    const from = vi.fn((table: string) => table === 'sessions' ? sessionsTable : messagesTable);
    mockCreateAgentLoop.mockImplementationOnce((_config, onEvent: (event: { type: string; data?: Record<string, unknown> }) => void) => ({
      run: vi.fn(async () => {
        onEvent({ type: 'stream_chunk', data: { content: '云同步回答' } });
      }),
      cancel: mockCancel,
    }));
    await startAgentApi({
      getSupabaseForSession: async () => ({ supabase: { from }, userId: 'user-characterization' }),
    });

    const response = await fetch(`${baseUrl}/api/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt: '云同步问题',
        sessionId: 'session-supabase-characterization',
        clientMessageId: 'supabase-user-message',
      }),
    });
    await response.text();

    expect(messagesTable.insert).toHaveBeenCalledTimes(2);
    expect(messagesTable.insert.mock.calls.map(([message]) => message)).toEqual([
      expect.objectContaining({ id: 'supabase-user-message', role: 'user', content: '云同步问题' }),
      expect.objectContaining({ role: 'assistant', content: '云同步回答' }),
    ]);
    expect(sessionsTable.upsert).toHaveBeenCalledTimes(2);
    expect(sessionsTable.update).toHaveBeenCalledWith(expect.objectContaining({
      title: '云同步问题',
    }));
  });

  it('passes image attachments from /api/run into the agent loop message history', async () => {
    mockRun.mockResolvedValueOnce(undefined);
    const imageAttachment = {
      id: 'att-image-1',
      type: 'image',
      category: 'image',
      name: 'vision-check.png',
      size: 128,
      mimeType: 'image/png',
      data: 'data:image/png;base64,aGVsbG8=',
      path: '/tmp/vision-check.png',
    };

    const response = await fetch(`${baseUrl}/api/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt: '看看这张图',
        sessionId: 'session-image-attachment',
        clientMessageId: 'client-msg-image-1',
        attachments: [imageAttachment],
      }),
    });

    expect(response.ok).toBe(true);
    await response.text();

    const loopMessages = mockCreateAgentLoop.mock.calls[0]?.[2] as Array<{ id: string; attachments?: unknown[] }>;
    expect(loopMessages.at(-1)).toMatchObject({
      id: 'client-msg-image-1',
      attachments: [imageAttachment],
    });
    expect(sessionMessages.get('session-image-attachment')?.[0]).toMatchObject({
      id: 'client-msg-image-1',
      attachments: [imageAttachment],
    });
  });

  it('keeps rich file attachments out of persisted message content', async () => {
    mockRun.mockResolvedValueOnce(undefined);
    const persistedMessages: Message[] = [];
    const addMessageToSession = vi.fn(async (_sessionId: string, message: Message) => {
      persistedMessages.push(message);
    });
    await closeServer();
    await startAgentApi({
      tryGetSessionManager: async () => ({
        addMessageToSession,
        getMessages: vi.fn(async () => persistedMessages),
        getSession: vi.fn(async () => ({ id: 'session-rich-attachments', title: 'Attachments' })),
      }),
    });
    setDbAvailable(true);

    const presentationAttachment = {
      id: 'ppt-1',
      type: 'file',
      category: 'presentation',
      name: 'sample-deck.pptx',
      size: 4096,
      mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      data: 'data:application/vnd.openxmlformats-officedocument.presentationml.presentation;base64,AAAAPPTX',
      path: '/tmp/sample-deck.pptx',
      pptJson: '{"slideCount":6,"slides":[{"index":1,"title":"Intro"}]}',
    };
    const archiveAttachment = {
      id: 'zip-1',
      type: 'file',
      category: 'archive',
      name: 'bundle.zip',
      size: 2048,
      mimeType: 'application/zip',
      data: 'data:application/zip;base64,AAAAZIP',
      path: '/tmp/bundle.zip',
      archiveManifest: {
        format: 'zip',
        supported: true,
        totalFiles: 1,
        entries: [{ path: 'plain.txt', size: 12 }],
      },
    };
    const textAttachment = {
      id: 'text-1',
      type: 'file',
      category: 'text',
      name: 'plain.txt',
      size: 12,
      mimeType: 'text/plain',
      data: 'hello from txt',
      path: '/tmp/plain.txt',
    };

    const response = await fetch(`${baseUrl}/api/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt: '请确认这三个附件',
        sessionId: 'session-rich-attachments',
        clientMessageId: 'client-msg-rich-attachments',
        attachments: [presentationAttachment, archiveAttachment, textAttachment],
      }),
    });

    expect(response.ok).toBe(true);
    await response.text();

    const loopMessages = mockCreateAgentLoop.mock.calls[0]?.[2] as Array<{
      id: string;
      content: string;
      attachments?: Array<Record<string, unknown>>;
    }>;
    const loopUserMessage = loopMessages.at(-1);

    expect(loopUserMessage).toMatchObject({
      id: 'client-msg-rich-attachments',
      content: '请确认这三个附件',
    });
    expect(loopUserMessage?.attachments).toHaveLength(3);
    expect(loopUserMessage?.attachments?.[0]).toMatchObject({
      id: 'ppt-1',
      category: 'presentation',
      pptJson: presentationAttachment.pptJson,
    });
    expect(loopUserMessage?.attachments?.[0]?.data).toBeUndefined();
    expect(loopUserMessage?.attachments?.[1]).toMatchObject({
      id: 'zip-1',
      category: 'archive',
      archiveManifest: archiveAttachment.archiveManifest,
    });
    expect(loopUserMessage?.attachments?.[1]?.data).toBeUndefined();
    expect(loopUserMessage?.attachments?.[2]).toMatchObject({
      id: 'text-1',
      category: 'text',
      data: 'hello from txt',
    });

    expect(addMessageToSession).toHaveBeenCalledWith(
      'session-rich-attachments',
      expect.objectContaining({
        id: 'client-msg-rich-attachments',
        role: 'user',
        content: '请确认这三个附件',
        attachments: loopUserMessage?.attachments,
      }),
    );
    const serialized = JSON.stringify(addMessageToSession.mock.calls[0]?.[1]);
    expect(serialized).not.toContain('<attachment');
    expect(serialized).not.toContain('AAAAPPTX');
    expect(serialized).not.toContain('AAAAZIP');
    expect(sessionMessages.get('session-rich-attachments')?.[0]?.content).toBe('请确认这三个附件');
  });

  it('routes /api/interrupt to the active loop steer method', async () => {
    const handle = runRegistry.start({
      runId: 'run-steer',
      sessionId: 'session-steer',
      workspace: process.cwd(),
    });
    await handle.attach({
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
    expect(body).toEqual({ success: true, data: { outcome: 'steered' } });
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
    expect(mockBroadcastSSE.mock.calls.map(([, event]) => event.type)).toEqual([
      'interrupt_start',
      'interrupt_complete',
    ]);
  });

  it('queues a late /api/interrupt with its raw web context and completes the interrupt', async () => {
    const handle = runRegistry.start({
      runId: 'run-late-steer',
      sessionId: 'session-late-steer',
      workspace: process.cwd(),
    });
    const lateSteer = vi.fn().mockRejectedValue(new SteerRejectedError());
    await handle.attach({ cancel: mockCancel, steer: lateSteer });
    const attachments = [{ name: 'late-note.txt' }];
    const context = {
      workingDirectory: '/tmp/raw-web-project',
      selectedAgent: { id: 'agent-raw', name: 'Raw Context Agent' },
      voiceInput: { inputSource: 'voice', language: 'zh-CN', transcriptChars: 8 },
      runtimeInput: { mode: 'supplement', delivery: 'in_flight' },
    };

    const response = await fetch(`${baseUrl}/api/interrupt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        content: 'settled 后继续',
        sessionId: 'session-late-steer',
        clientMessageId: 'late-web-message-id',
        attachments,
        context,
      }),
    });
    const body = await response.json();

    expect(response.ok).toBe(true);
    expect(body).toEqual({
      success: true,
      data: { outcome: 'queued', queuedInputId: 'late-web-message-id' },
    });
    expect(mockQueuedInputEnqueue).toHaveBeenCalledWith({
      id: 'late-web-message-id',
      sessionId: 'session-late-steer',
      envelope: {
        content: 'settled 后继续',
        clientMessageId: 'late-web-message-id',
        sessionId: 'session-late-steer',
        attachments,
        context,
      },
      now: undefined,
    });
    expect(mockBroadcastSSE.mock.calls.map(([, event]) => event.type)).toEqual([
      'interrupt_start',
      'interrupt_complete',
    ]);
  });

  it('keeps genuine /api/interrupt failures on the INTERRUPT_FAILED path', async () => {
    const handle = runRegistry.start({
      runId: 'run-broken-steer',
      sessionId: 'session-broken-steer',
      workspace: process.cwd(),
    });
    const brokenSteer = vi.fn().mockRejectedValue(new Error('unexpected steer failure'));
    await handle.attach({ cancel: mockCancel, steer: brokenSteer });

    const response = await fetch(`${baseUrl}/api/interrupt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        content: '触发真实错误',
        sessionId: 'session-broken-steer',
      }),
    });
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toMatchObject({
      success: false,
      error: {
        code: 'INTERRUPT_FAILED',
        message: 'unexpected steer failure',
      },
    });
    expect(mockQueuedInputEnqueue).not.toHaveBeenCalled();
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

  it('rejects invalid /api/tool-result bodies before resolving local tool results', async () => {
    const response = await fetch(`${baseUrl}/api/tool-result`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        toolCallId: 42,
        success: true,
      }),
    });
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toEqual({ error: 'Missing toolCallId' });
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

  it('backfills empty session working directory with the resolved run directory', async () => {
    await closeServer();
    const updateSession = vi.fn(async () => undefined);
    mockCreateAgentLoop.mockImplementationOnce(() => ({
      run: vi.fn(async () => undefined),
      cancel: mockCancel,
    }));
    await startAgentApi({
      tryGetSessionManager: async () => ({
        getMessages: vi.fn(async () => []),
        getSession: vi.fn(async () => ({ id: 'session-backfill-empty' })),
        updateSession,
      }),
    });

    const response = await fetch(`${baseUrl}/api/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt: '普通聊天',
        sessionId: 'session-backfill-empty',
        context: { workingDirectory: '/tmp/context-project' },
      }),
    });

    expect(response.ok).toBe(true);
    await response.text();

    expect(updateSession).toHaveBeenCalledWith(
      'session-backfill-empty',
      expect.objectContaining({ workingDirectory: '/tmp/context-project' }),
    );
  });

  it('does not overwrite a persisted session working directory from the run path', async () => {
    await closeServer();
    const updateSession = vi.fn(async () => undefined);
    mockCreateAgentLoop.mockImplementationOnce(() => ({
      run: vi.fn(async () => undefined),
      cancel: mockCancel,
    }));
    await startAgentApi({
      tryGetSessionManager: async () => ({
        getMessages: vi.fn(async () => []),
        getSession: vi.fn(async () => ({ id: 'session-persisted', workingDirectory: '/persisted/project' })),
        updateSession,
      }),
    });

    const response = await fetch(`${baseUrl}/api/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt: '普通聊天',
        sessionId: 'session-persisted',
        context: { workingDirectory: '/tmp/other-project' },
      }),
    });

    expect(response.ok).toBe(true);
    await response.text();

    // runtime 现状不变：context 显式值仍然优先生效
    expect(createCLIAgent).toHaveBeenCalledWith(expect.objectContaining({
      project: '/tmp/other-project',
    }));
    // 但持久化值不被覆盖（只补空）
    expect(updateSession).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ workingDirectory: expect.anything() }),
    );
  });

  it('skips working directory backfill for unpersisted temp sessions', async () => {
    await closeServer();
    const updateSession = vi.fn(async () => undefined);
    mockCreateAgentLoop.mockImplementationOnce(() => ({
      run: vi.fn(async () => undefined),
      cancel: mockCancel,
    }));
    await startAgentApi({
      tryGetSessionManager: async () => ({
        getMessages: vi.fn(async () => []),
        getSession: vi.fn(async () => null),
        updateSession,
      }),
    });

    const response = await fetch(`${baseUrl}/api/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt: '普通聊天',
        context: { workingDirectory: '/tmp/context-project' },
      }),
    });

    expect(response.ok).toBe(true);
    await response.text();

    expect(updateSession).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ workingDirectory: expect.anything() }),
    );
  });

  it('propagates adaptive flag into the agent loop config when session override is auto mode', async () => {
    mockGetOverride.mockReturnValueOnce({
      provider: 'custom-commonstack-claude',
      model: 'anthropic/claude-opus-4-8',
      adaptive: true,
    });
    mockCreateAgentLoop.mockImplementationOnce(() => ({
      run: vi.fn(async () => undefined),
      cancel: mockCancel,
    }));

    const response = await fetch(`${baseUrl}/api/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt: '你好',
        sessionId: 'session-adaptive-auto',
      }),
    });

    expect(response.ok).toBe(true);
    await response.text();

    // 自动模式：override 的 provider/model 只是占位，不当显式模型用（走默认模型）
    expect(vi.mocked(createCLIAgent).mock.calls.length).toBeGreaterThan(0);
    const cliAgentArgs = vi.mocked(createCLIAgent).mock.calls[0]![0]!;
    expect(cliAgentArgs.model).toBeUndefined();
    expect(cliAgentArgs.provider).toBeUndefined();

    // adaptive 标志必须透传进 agent loop 的 modelConfig（vision fallback / adaptiveRouter 的闸门）
    expect(mockCreateAgentLoop).toHaveBeenCalled();
    const loopConfig = mockCreateAgentLoop.mock.calls[0][0] as { modelConfig: { adaptive?: boolean } };
    expect(loopConfig.modelConfig.adaptive).toBe(true);
  });

  it('uses override model/provider as explicit model when override is not adaptive', async () => {
    mockGetOverride.mockReturnValueOnce({
      provider: 'deepseek',
      model: 'deepseek-chat',
    });
    mockCreateAgentLoop.mockImplementationOnce(() => ({
      run: vi.fn(async () => undefined),
      cancel: mockCancel,
    }));

    const response = await fetch(`${baseUrl}/api/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt: '你好',
        sessionId: 'session-explicit-override',
      }),
    });

    expect(response.ok).toBe(true);
    await response.text();

    expect(createCLIAgent).toHaveBeenCalledWith(expect.objectContaining({
      model: 'deepseek-chat',
      provider: 'deepseek',
    }));
    const loopConfig = mockCreateAgentLoop.mock.calls[0][0] as { modelConfig: { adaptive?: boolean } };
    expect(loopConfig.modelConfig.adaptive).toBeUndefined();
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
    const durableRunId = (testRunKernel.createRun.mock.calls.at(-1)?.[0] as { runId: string }).runId;
    expect(body).toContain(durableRunId);
    expect(agentEngineMocks.codexRun).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-codex-engine',
      prompt: '只回复 CODEX_ROUTED_OK',
      cwd: '/tmp/codex-workspace',
      workspaceRoot: '/tmp/codex-workspace',
      permissionProfile: 'read_only',
      durableLifecycle: expect.objectContaining({ runId: durableRunId }),
    }));
    expect(createCLIAgent).not.toHaveBeenCalled();
    expect(updateSession).toHaveBeenCalledWith(
      'session-codex-engine',
      expect.objectContaining({ status: 'completed' }),
    );
  });

  it('uses the durable terminal outcome for the external session and SSE status when completed lacks evidence', async () => {
    await closeServer();

    const updateSession = vi.fn(async () => undefined);
    const getSession = vi.fn(async () => ({
      id: 'session-codex-empty',
      title: 'Codex empty response',
      type: 'chat',
      workingDirectory: '/tmp/codex-workspace',
      engine: {
        kind: 'codex_cli',
        cwd: '/tmp/codex-workspace',
        permissionProfile: 'read_only',
        origin: 'manual',
      },
    }));

    agentEngineMocks.codexRun.mockImplementationOnce(async (request) => ({
      runId: 'codex-run-empty',
      sessionId: request.sessionId,
      engine: 'codex_cli',
      status: 'completed',
      outputText: '',
      exitCode: 0,
    }));

    await startAgentApi({
      tryGetSessionManager: async () => ({ getSession, updateSession }),
    });

    const response = await fetch(`${baseUrl}/api/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt: 'return no text',
        sessionId: 'session-codex-empty',
        context: { workingDirectory: '/tmp/codex-workspace' },
      }),
    });
    await response.text();

    expect(response.ok).toBe(true);
    expect(testRunKernel.terminal).toHaveBeenLastCalledWith(expect.objectContaining({
      status: 'failed',
      reason: 'external_process_exited_without_terminal_evidence',
    }));
    expect(updateSession).toHaveBeenLastCalledWith(
      'session-codex-empty',
      expect.objectContaining({ status: 'error' }),
    );
    expect(mockBroadcastSSE).toHaveBeenCalledWith('session:updated', {
      sessionId: 'session-codex-empty',
      updates: { status: 'error', updatedAt: expect.any(Number) },
    });
  });

  it('外部引擎会话 + 显式 agent 选择 → 发降级 routing_resolved（引擎路径不支持 agent 选择，不再静默）', async () => {
    await closeServer();

    const updateSession = vi.fn(async () => undefined);
    const getSession = vi.fn(async () => ({
      id: 'session-codex-agent-degrade',
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
      request.emitEvent?.({ type: 'agent_complete', data: null });
      return {
        runId: 'codex-run-degrade',
        sessionId: request.sessionId,
        engine: 'codex_cli',
        status: 'completed',
        outputText: 'ok',
        exitCode: 0,
      };
    });

    await startAgentApi({
      tryGetSessionManager: async () => ({ getSession, updateSession }),
    });

    const response = await fetch(`${baseUrl}/api/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt: 'hi',
        sessionId: 'session-codex-agent-degrade',
        context: { preferredAgentId: 'explore' },
      }),
    });
    const raw = await response.text();

    expect(response.ok).toBe(true);
    const lines = raw.split('\n');
    const idx = lines.findIndex((line) => line.trim() === 'event: routing_resolved');
    expect(idx).toBeGreaterThanOrEqual(0);
    const payload = JSON.parse(lines[idx + 1].trim().slice(5).trim()) as Record<string, unknown>;
    expect(payload).toMatchObject({
      mode: 'explicit',
      agentId: 'default',
      agentName: 'Codex CLI',
      requestedAgentId: 'explore',
      fallbackToDefault: true,
    });
    // reason 也走展示名，裸 kind 不得泄进任何 UI 可见文案
    expect(String(payload!.reason)).toContain('Codex CLI');
    expect(String(payload!.reason)).not.toContain('codex_cli');
  });

  it('routes MiMo engine sessions through the MiMo adapter, passing the selected model directly', async () => {
    await closeServer();

    const updateSession = vi.fn(async () => undefined);
    const getSession = vi.fn(async () => ({
      id: 'session-mimo-engine',
      title: 'MiMo engine',
      type: 'chat',
      workingDirectory: '/tmp/mimo-workspace',
      engine: {
        kind: 'mimo_code',
        model: 'mimo-coder',
        cwd: '/tmp/mimo-workspace',
        permissionProfile: 'read_only',
        origin: 'manual',
      },
    }));

    // launch.model 透传 mimo-coder（未注册签名 catalog，不走 resolveModelId）。
    agentEngineMocks.resolveExternalEngineLaunch.mockImplementationOnce((session, engine, requestedCwd) => ({
      cwd: requestedCwd || session?.workingDirectory || engine?.cwd,
      workspaceRoot: engine?.cwd || session?.workingDirectory,
      permissionProfile: 'read_only',
      model: engine?.model,
    }));

    agentEngineMocks.mimoRun.mockImplementationOnce(async (request) => {
      request.emitEvent?.({
        type: 'message_delta',
        data: {
          role: 'assistant',
          path: 'content',
          op: 'append',
          text: 'MIMO_ROUTED_OK',
          turnId: 'turn-mimo',
        },
      });
      request.emitEvent?.({ type: 'agent_complete', data: null });
      return {
        runId: 'mimo-run-1',
        sessionId: request.sessionId,
        engine: 'mimo_code',
        status: 'completed',
        outputText: 'MIMO_ROUTED_OK',
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
        prompt: '只回复 MIMO_ROUTED_OK',
        sessionId: 'session-mimo-engine',
        context: {
          workingDirectory: '/tmp/mimo-workspace',
        },
      }),
    });
    const body = await response.text();

    expect(response.ok).toBe(true);
    expect(body).toContain('MIMO_ROUTED_OK');
    expect(agentEngineMocks.mimoRun).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-mimo-engine',
      prompt: '只回复 MIMO_ROUTED_OK',
      cwd: '/tmp/mimo-workspace',
      workspaceRoot: '/tmp/mimo-workspace',
      permissionProfile: 'read_only',
      model: 'mimo-coder',
    }));
    expect(agentEngineMocks.codexRun).not.toHaveBeenCalled();
    expect(agentEngineMocks.claudeRun).not.toHaveBeenCalled();
    expect(createCLIAgent).not.toHaveBeenCalled();
    expect(updateSession).toHaveBeenCalledWith(
      'session-mimo-engine',
      expect.objectContaining({ status: 'completed' }),
    );
  });

  it('routes Kimi engine sessions through the Kimi adapter, passing the selected model directly', async () => {
    await closeServer();

    const updateSession = vi.fn(async () => undefined);
    const getSession = vi.fn(async () => ({
      id: 'session-kimi-engine',
      title: 'Kimi engine',
      type: 'chat',
      workingDirectory: '/tmp/kimi-workspace',
      engine: {
        kind: 'kimi_code',
        model: 'kimi-k2.5',
        cwd: '/tmp/kimi-workspace',
        permissionProfile: 'read_only',
        origin: 'manual',
      },
    }));

    agentEngineMocks.resolveExternalEngineLaunch.mockImplementationOnce((session, engine, requestedCwd) => ({
      cwd: requestedCwd || session?.workingDirectory || engine?.cwd,
      workspaceRoot: engine?.cwd || session?.workingDirectory,
      permissionProfile: 'read_only',
      model: engine?.model,
    }));

    agentEngineMocks.kimiRun.mockImplementationOnce(async (request) => {
      request.emitEvent?.({
        type: 'message_delta',
        data: {
          role: 'assistant',
          path: 'content',
          op: 'append',
          text: 'KIMI_ROUTED_OK',
          turnId: 'turn-kimi',
        },
      });
      request.emitEvent?.({ type: 'agent_complete', data: null });
      return {
        runId: 'kimi-run-1',
        sessionId: request.sessionId,
        engine: 'kimi_code',
        status: 'completed',
        outputText: 'KIMI_ROUTED_OK',
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
        prompt: '只回复 KIMI_ROUTED_OK',
        sessionId: 'session-kimi-engine',
        context: {
          workingDirectory: '/tmp/kimi-workspace',
        },
      }),
    });
    const body = await response.text();

    expect(response.ok).toBe(true);
    expect(body).toContain('KIMI_ROUTED_OK');
    expect(agentEngineMocks.kimiRun).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-kimi-engine',
      prompt: '只回复 KIMI_ROUTED_OK',
      cwd: '/tmp/kimi-workspace',
      workspaceRoot: '/tmp/kimi-workspace',
      permissionProfile: 'read_only',
      model: 'kimi-k2.5',
    }));
    expect(createCLIAgent).not.toHaveBeenCalled();
    expect(updateSession).toHaveBeenCalledWith(
      'session-kimi-engine',
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
    expect(agentEngineMocks.enqueueReviewSession).not.toHaveBeenCalled();
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
    expect(agentEngineMocks.enqueueReviewSession).not.toHaveBeenCalled();
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

  // 工单行为不变清单 #3：兜底判定必须认「终轮」assistant 是否落库（Codex audit HIGH1）：
  // 多迭代 run 早轮已落库 + 终轮落库失败时，旧 .some() 匹配任一 id 会误跳兜底，
  // 终轮内容+metadata 静默丢失。
  it('fires assistant fallback when an earlier loop message persisted but the final one did not', async () => {
    await closeServer();
    setDbAvailable(true);

    const addMessageToSession = vi.fn(async () => undefined);
    // 早轮 a1 已在库，终轮 a2 缺席
    const getMessages = vi.fn(async () => [
      { id: 'loop-a1', role: 'assistant', content: '早轮工具调用', timestamp: 100 },
    ]);
    const getSession = vi.fn(async () => ({ workingDirectory: '/tmp/persisted-project' }));

    mockCreateAgentLoop.mockImplementationOnce((_config, onEvent: (event: { type: string; data?: Record<string, unknown> }) => void) => ({
      run: vi.fn(async () => {
        onEvent({ type: 'message', data: { id: 'loop-a1', role: 'assistant', content: '早轮工具调用', timestamp: 100 } });
        onEvent({ type: 'message', data: { id: 'loop-a2', role: 'assistant', content: '终轮结论', timestamp: 200 } });
        onEvent({ type: 'stream_chunk', data: { content: '终轮结论' } });
      }),
      cancel: mockCancel,
    }));

    await startAgentApi({
      tryGetSessionManager: async () => ({ addMessageToSession, getMessages, getSession }),
    });

    const response = await fetch(`${baseUrl}/api/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: '多迭代终轮丢失场景', sessionId: 'session-final-lost' }),
    });
    expect(response.ok).toBe(true);
    await response.text();

    expect(addMessageToSession).toHaveBeenCalledWith(
      'session-final-lost',
      expect.objectContaining({ role: 'assistant', content: '终轮结论' }),
    );
  });

  // 工单行为不变清单 #3：终轮已由 loop 落库时，路由不得双插 assistant。
  it('keeps skipping assistant fallback when the final loop message did persist', async () => {
    await closeServer();
    setDbAvailable(true);

    const addMessageToSession = vi.fn(async () => undefined);
    const getMessages = vi.fn(async () => [
      { id: 'loop-a1', role: 'assistant', content: '早轮工具调用', timestamp: 100 },
      { id: 'loop-a2', role: 'assistant', content: '终轮结论', timestamp: 200 },
    ]);
    const getSession = vi.fn(async () => ({ workingDirectory: '/tmp/persisted-project' }));

    mockCreateAgentLoop.mockImplementationOnce((_config, onEvent: (event: { type: string; data?: Record<string, unknown> }) => void) => ({
      run: vi.fn(async () => {
        onEvent({ type: 'message', data: { id: 'loop-a1', role: 'assistant', content: '早轮工具调用', timestamp: 100 } });
        onEvent({ type: 'message', data: { id: 'loop-a2', role: 'assistant', content: '终轮结论', timestamp: 200 } });
        onEvent({ type: 'stream_chunk', data: { content: '终轮结论' } });
      }),
      cancel: mockCancel,
    }));

    await startAgentApi({
      tryGetSessionManager: async () => ({ addMessageToSession, getMessages, getSession }),
    });

    const response = await fetch(`${baseUrl}/api/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: '终轮已落库场景', sessionId: 'session-final-persisted' }),
    });
    expect(response.ok).toBe(true);
    await response.text();

    expect(addMessageToSession).not.toHaveBeenCalledWith(
      'session-final-persisted',
      expect.objectContaining({ role: 'assistant' }),
    );
  });

  // 兜底落库必须带上 message 事件的 metadata（turnQuality 安静徽标数据）——
  // 三处重建（cache push / sm.addMessageToSession / db.addMessage）此前整体丢弃 metadata，
  // reload 后徽标（模型名+agent 名+降级警示）消失。
  it('persists assistant metadata.turnQuality via session manager fallback and cache', async () => {
    await closeServer();
    setDbAvailable(true);

    const turnQualityMetadata = {
      turnQuality: {
        capabilities: {
          agentId: 'explore',
          agentName: 'Explorer',
          requestedAgentId: 'explore',
        },
      },
    };

    const persistedMessages: Message[] = [];
    const addMessageToSession = vi.fn(async (_sessionId: string, message: Message) => {
      persistedMessages.push(message);
    });
    const getMessages = vi.fn(async () => persistedMessages);
    const getSession = vi.fn(async () => ({
      workingDirectory: '/tmp/persisted-project',
    }));

    mockCreateAgentLoop.mockImplementationOnce((_config, onEvent: (event: { type: string; data?: Record<string, unknown> }) => void) => ({
      run: vi.fn(async () => {
        onEvent({
          type: 'message',
          data: {
            id: 'loop-assistant-meta',
            role: 'assistant',
            content: '最终回复',
            timestamp: 200,
            metadata: turnQualityMetadata,
          },
        });
        onEvent({
          type: 'stream_chunk',
          data: { content: '最终回复' },
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
        prompt: '带徽标元数据的回复',
        sessionId: 'session-assistant-metadata',
      }),
    });
    expect(response.ok).toBe(true);
    await response.text();

    expect(addMessageToSession).toHaveBeenCalledWith(
      'session-assistant-metadata',
      expect.objectContaining({
        role: 'assistant',
        metadata: turnQualityMetadata,
      }),
    );
    const cached = sessionMessages.get('session-assistant-metadata') || [];
    const assistant = cached.find((message) => message.role === 'assistant');
    expect(assistant?.metadata).toEqual(turnQualityMetadata);
  });

  it('persists assistant metadata.turnQuality via direct db fallback when SM unavailable', async () => {
    await closeServer();
    setDbAvailable(true);

    const turnQualityMetadata = {
      turnQuality: {
        capabilities: {
          agentId: 'default',
          agentName: 'default',
          requestedAgentId: '__ghost_agent__',
        },
      },
    };

    mockCreateAgentLoop.mockImplementationOnce((_config, onEvent: (event: { type: string; data?: Record<string, unknown> }) => void) => ({
      run: vi.fn(async () => {
        onEvent({
          type: 'message',
          data: {
            id: 'loop-assistant-meta-db',
            role: 'assistant',
            content: '降级回复',
            timestamp: 200,
            metadata: turnQualityMetadata,
          },
        });
        onEvent({
          type: 'stream_chunk',
          data: { content: '降级回复' },
        });
      }),
      cancel: mockCancel,
    }));

    await startAgentApi();

    const response = await fetch(`${baseUrl}/api/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt: '降级场景带元数据',
        sessionId: 'session-assistant-metadata-db',
      }),
    });
    expect(response.ok).toBe(true);
    await response.text();

    expect(mockDb.addMessage).toHaveBeenCalledWith(
      'session-assistant-metadata-db',
      expect.objectContaining({
        role: 'assistant',
        metadata: turnQualityMetadata,
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

  describe('/api/run 会话模型切换跨重启恢复（WP-1 回灌接线）', () => {
    const persistedSession = {
      id: 'session-model-restore',
      title: 'Restored',
      workingDirectory: '/tmp/model-restore-work',
      metadata: { modelOverride: { provider: 'zhipu', model: 'glm-5', setAt: 1 } },
    };

    async function restartWithSession(session: unknown) {
      await closeServer();
      await startAgentApi({
        tryGetSessionManager: async () => ({
          getSession: vi.fn(async () => session),
          getMessages: vi.fn(async () => []),
          updateSession: vi.fn(async () => undefined),
        }),
      });
    }

    async function postRun(body: Record<string, unknown>) {
      mockRun.mockResolvedValueOnce(undefined);
      const response = await fetch(`${baseUrl}/api/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: '继续', sessionId: 'session-model-restore', ...body }),
      });
      expect(response.ok).toBe(true);
      await response.text();
    }

    it('内存 Map 为空时按 persistedSession 回灌并路由到切换值', async () => {
      mockGetOverride.mockReturnValue(null);
      mockRehydrateOverride.mockReturnValue({ provider: 'zhipu', model: 'glm-5', setAt: 1 });
      await restartWithSession(persistedSession);

      await postRun({});

      expect(mockRehydrateOverride).toHaveBeenCalledWith(persistedSession);
      expect(createCLIAgent).toHaveBeenCalledWith(
        expect.objectContaining({ provider: 'zhipu', model: 'glm-5' }),
      );
    });

    it('显式 body.model/provider 仍最优先，不触发回灌', async () => {
      mockGetOverride.mockReturnValue(null);
      mockRehydrateOverride.mockReturnValue({ provider: 'zhipu', model: 'glm-5', setAt: 1 });
      await restartWithSession(persistedSession);

      await postRun({ model: 'deepseek-chat', provider: 'deepseek' });

      expect(mockRehydrateOverride).not.toHaveBeenCalled();
      expect(createCLIAgent).toHaveBeenCalledWith(
        expect.objectContaining({ provider: 'deepseek', model: 'deepseek-chat' }),
      );
    });

    it('半显式 body（只传 model）不拿 override 的 provider 拼杂交配置（audit R1-MED2）', async () => {
      mockGetOverride.mockReturnValue({ provider: 'zhipu', model: 'glm-5', setAt: 1 });
      mockRehydrateOverride.mockReturnValue({ provider: 'zhipu', model: 'glm-5', setAt: 1 });
      await restartWithSession(persistedSession);

      await postRun({ model: 'deepseek-chat' });

      expect(createCLIAgent).toHaveBeenCalledWith(
        expect.objectContaining({ provider: undefined, model: 'deepseek-chat' }),
      );
    });

    it('未切换过的会话（回灌返回 null）不受影响，走默认解析', async () => {
      mockGetOverride.mockReturnValue(null);
      mockRehydrateOverride.mockReturnValue(null);
      await restartWithSession({ ...persistedSession, metadata: undefined });

      await postRun({});

      expect(createCLIAgent).toHaveBeenCalledWith(
        expect.objectContaining({ provider: undefined, model: undefined }),
      );
    });

    it('回灌得到 adaptive 覆盖时透传自动路由标志', async () => {
      mockGetOverride.mockReturnValue(null);
      mockRehydrateOverride.mockReturnValue({ provider: 'zhipu', model: 'glm-5', adaptive: true, setAt: 1 });
      await restartWithSession(persistedSession);

      await postRun({});

      const config = mockCreateAgentLoop.mock.calls[0]?.[0] as { modelConfig: { adaptive?: boolean } };
      expect(config.modelConfig.adaptive).toBe(true);
    });
  });
});
