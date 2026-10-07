// N-RUNENTRY-IDEMPOTENT：POST /run 对 clientMessageId 的幂等重放。
// 前提（ai-24 audit 09-30）：run 结束后同 clientMessageId 的重试会再起一轮并追加
// 重复用户消息。验收口径：已存在同 id 用户消息 → 不建新 run、不追加消息、返回
// 200 {replayed:true,...}；该 run 仍活跃时维持现有 409；不同 id 照常新建。
import express from 'express';
import http from 'http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';
import type { Message } from '../../../src/shared/contract';
import {
  DURABLE_RUN_SCHEMA_VERSION,
  type PendingOperation,
  type RunCheckpoint,
  type RunEngineRef,
  type RunOwnerLease,
} from '../../../src/shared/contract/durableRun';
import type { DurableCheckpointInput, PrepareOperationInput } from '../../../src/host/runtime/durableRunKernel';
import { createAgentRouter } from '../../../src/web/routes/agent';
import { setDbAvailable } from '../../../src/web/helpers/sessionCache';
import {
  inMemorySessionsProjection as inMemorySessions,
  sessionMessagesProjection as sessionMessages,
} from '../../../src/web/helpers/webSessionStore';
import { RunRegistry } from '../../../src/host/runtime/runRegistry';
import { QueuedInputRepository } from '../../../src/host/services/core/repositories/QueuedInputRepository';
import { sseClients } from '../../../src/web/helpers/sse';
import { DurableRunRepository } from '../../../src/host/services/core/repositories/DurableRunRepository';

const mockCreateAgentLoop = vi.fn();
const mockCreateRunToolExecutor = vi.fn((..._args: unknown[]) => ({ execute: vi.fn() }));
const configServiceMocks = vi.hoisted(() => ({
  onSettingsUpdated: vi.fn(),
  getSettings: vi.fn(() => ({
    permissions: {
      autoApprove: { read: true, write: false, execute: false, network: false },
      devModeAutoApprove: false,
    },
    models: { default: 'openai', providers: {}, routing: {} },
  })),
  isDevModeAutoApproveEnabled: vi.fn(() => false),
}));
const mockBroadcastSSE = vi.hoisted(() => vi.fn());
const projectServiceMocks = vi.hoisted(() => ({
  getWorkspaceScope: vi.fn(),
}));

// durable 归因桩：路由侧只依赖 getLatestRootRunAsOf / get 两个读。
const durableStub = vi.hoisted(() => ({
  getLatestRootRunAsOf: vi.fn<() => Promise<unknown>>(async () => null),
  get: vi.fn<() => Promise<unknown>>(async () => null),
}));
const mockDb = vi.hoisted(() => ({
  getDb: vi.fn(() => ({})),
  getSession: vi.fn<() => { id: string; title: string; metadata?: Record<string, unknown> }>(() => ({
    id: 'session-existing',
    title: 'Existing',
  })),
  createSessionWithId: vi.fn(),
  updateSession: vi.fn(),
  addMessage: vi.fn(),
  updateMessage: vi.fn(),
  getMessages: vi.fn(() => []),
  getMessageById: vi.fn<() => Message | null>(() => null),
  getDurableRunRepository: vi.fn(() => durableStub),
  getSessionForkLineage: vi.fn<() => unknown>(() => null),
  getSessionForkContextSource: vi.fn<() => unknown>(() => null),
  getSessionForkContextHandoff: vi.fn<() => unknown>(() => null),
  prepareSessionForkContextHandoff: vi.fn(() => ({})),
  markSessionForkContextHandoffDispatching: vi.fn(() => ({})),
  markSessionForkContextHandoffConsumed: vi.fn(() => ({})),
}));
vi.spyOn(QueuedInputRepository.prototype, 'enqueue').mockImplementation(() => undefined);

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
  createRunToolExecutor: (...args: unknown[]) => mockCreateRunToolExecutor(...args),
  getToolExecutor: vi.fn(() => undefined),
}));

vi.mock('../../../src/host/services/core/configService', async () => {
  const actual = await vi.importActual<typeof import('../../../src/host/services/core/configService')>(
    '../../../src/host/services/core/configService',
  );
  return {
    ...actual,
    getConfigService: () => configServiceMocks,
  };
});

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

vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => mockDb,
}));

vi.mock('../../../src/host/services/project/projectService', () => ({
  getProjectService: () => ({
    getWorkspaceScope: projectServiceMocks.getWorkspaceScope,
  }),
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
        schemaVersion: DURABLE_RUN_SCHEMA_VERSION, runId: input.runId, sessionId: input.sessionId,
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
        schemaVersion: DURABLE_RUN_SCHEMA_VERSION, runId: input.runId, sessionId: input.sessionId,
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

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

let persistedMessages: Message[] = [];

async function startAgentApi(deps: {
  tryGetSessionManager?: () => Promise<unknown>;
  registerCompanionRun?: Parameters<typeof createAgentRouter>[0]['registerCompanionRun'];
  publishCompanionEvent?: Parameters<typeof createAgentRouter>[0]['publishCompanionEvent'];
} = {}) {
  const app = express();
  app.use(express.json());
  app.use('/api', createAgentRouter({
    runRegistry,
    pendingLocalToolCalls: new Map(),
    logger,
    tryGetSessionManager: deps.tryGetSessionManager ?? (async () => null),
    tryGetCLISessionManager: deps.tryGetSessionManager ?? (async () => null),
    getSupabaseForSession: async () => null,
    registerCompanionRun: deps.registerCompanionRun,
    publishCompanionEvent: deps.publishCompanionEvent,
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
    server?.closeAllConnections();
  });
  server = undefined;
  baseUrl = '';
}

async function waitForAssertion(assertion: () => void, timeoutMs = 3000): Promise<void> {
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

/** 一轮能自然跑完的 loop：发一条 assistant message 事件后 resolve。 */
function completingLoop() {
  return {
    run: vi.fn(async (_prompt: string, onEvent: (event: { type: string; data: unknown }) => void) => {
      onEvent({
        type: 'message',
        data: { id: `assistant-${Date.now()}`, role: 'assistant', content: '完成了', timestamp: Date.now() },
      });
    }),
    cancel: vi.fn(),
    steer: vi.fn(),
  };
}

function sessionManagerMock() {
  return {
    addMessageToSession: vi.fn(async (_sessionId: string, message: Message) => {
      const existing = persistedMessages.findIndex((candidate) => candidate.id === message.id);
      if (existing >= 0) persistedMessages[existing] = message;
      else persistedMessages.push(message);
    }),
    getMessages: vi.fn(async () => [...persistedMessages]),
    getSession: vi.fn(async (sessionId: string) => ({
      id: sessionId,
      title: 'Existing',
      workingDirectory: '/tmp/runentry-idempotent',
    })),
    updateSession: vi.fn(async () => undefined),
  };
}

/** durable 归因桩统一回一条 envelope（生产里由 durable_runs 的 as-of 查询给出）。 */
function attributeDurableRun(envelope: {
  runId: string;
  status: string;
  nextEventSeq?: number;
  checkpointSeq?: number;
}) {
  const full = {
    runId: envelope.runId,
    sessionId: 'unused',
    status: envelope.status,
    cursor: { nextEventSeq: envelope.nextEventSeq ?? 5, checkpointSeq: envelope.checkpointSeq ?? 2 },
  };
  durableStub.getLatestRootRunAsOf.mockImplementation(async () => full);
  durableStub.get.mockImplementation(async (...args: unknown[]) => (args[0] === envelope.runId ? full : null));
}

describe('POST /run clientMessageId idempotent replay', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    persistedMessages = [];
    runRegistry.clear();
    sseClients.clear();
    runRegistry.configureDurableKernel(testRunKernel);
    inMemorySessions.clear();
    sessionMessages.clear();
    setDbAvailable(true);
    durableStub.getLatestRootRunAsOf.mockImplementation(async () => null);
    durableStub.get.mockImplementation(async () => null);
    mockCreateAgentLoop.mockImplementation(() => completingLoop());
    await startAgentApi({ tryGetSessionManager: async () => sessionManagerMock() });
  });

  afterEach(async () => {
    await closeServer();
    runRegistry.clear();
    sseClients.clear();
    inMemorySessions.clear();
    sessionMessages.clear();
    setDbAvailable(false);
  });

  it('首发起 run；结束后同 id 重发 → 200 replayed、不建新 run、消息数不变', async () => {
    const first = await fetch(`${baseUrl}/api/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt: '跑一轮',
        sessionId: 'session-idem',
        clientMessageId: 'msg-idem-1',
      }),
    });
    expect(first.status).toBe(200);
    // 整读 SSE 流：text() resolve 即首轮自然收尾（响应 end 前注册表已释放）。
    const firstRaw = await first.text();
    const firstRunId = parseSSEData(firstRaw, 'task_start')?.runId as string;
    expect(firstRunId).toEqual(expect.any(String));
    await waitForAssertion(() => expect(runRegistry.hasSession('session-idem')).toBe(false));
    expect(mockCreateAgentLoop).toHaveBeenCalledTimes(1);
    // 预持久化 user + 落库 assistant。
    expect(persistedMessages.map((message) => message.id)).toEqual(
      expect.arrayContaining(['msg-idem-1']),
    );
    const messageCountAfterFirst = persistedMessages.length;
    expect(messageCountAfterFirst).toBe(2);

    attributeDurableRun({ runId: firstRunId, status: 'completed', nextEventSeq: 5, checkpointSeq: 2 });

    const second = await fetch(`${baseUrl}/api/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt: '跑一轮',
        sessionId: 'session-idem',
        clientMessageId: 'msg-idem-1',
      }),
    });
    expect(second.status).toBe(200);
    expect(second.headers.get('content-type')).toContain('application/json');
    await expect(second.json()).resolves.toEqual({
      replayed: true,
      sessionId: 'session-idem',
      clientMessageId: 'msg-idem-1',
      runId: firstRunId,
      status: 'completed',
      eventCursor: { nextEventSeq: 5, checkpointSeq: 2 },
    });
    expect(mockCreateAgentLoop).toHaveBeenCalledTimes(1);
    expect(persistedMessages.length).toBe(messageCountAfterFirst);
    expect(logger.info).toHaveBeenCalledWith('run entry replayed', {
      sessionId: 'session-idem',
      clientMessageId: 'msg-idem-1',
      runId: firstRunId,
    });
  });

  it('不同 clientMessageId → 照常新建 run', async () => {
    const first = await fetch(`${baseUrl}/api/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt: '第一问',
        sessionId: 'session-idem-diff',
        clientMessageId: 'msg-idem-a',
      }),
    });
    expect(first.status).toBe(200);
    const firstRaw = await first.text();
    const firstRunId = parseSSEData(firstRaw, 'task_start')?.runId as string;
    await waitForAssertion(() => expect(runRegistry.hasSession('session-idem-diff')).toBe(false));

    attributeDurableRun({ runId: firstRunId, status: 'completed' });

    const controller = new AbortController();
    const second = await fetch(`${baseUrl}/api/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt: '第二问',
        sessionId: 'session-idem-diff',
        clientMessageId: 'msg-idem-b',
      }),
      signal: controller.signal,
    });
    expect(second.status).toBe(200);
    await readSSEUntilWithoutClosing(second, 'event: task_start');
    await waitForAssertion(() => expect(mockCreateAgentLoop).toHaveBeenCalledTimes(2));
    expect(persistedMessages.some((message) => message.id === 'msg-idem-b')).toBe(true);

    controller.abort();
    await waitForAssertion(() => expect(runRegistry.hasSession('session-idem-diff')).toBe(false));
  });

  it('同 id 且该 run 仍活跃 → 维持现有 409（activeRunId）', async () => {
    let releaseActive: (() => void) | undefined;
    mockCreateAgentLoop.mockImplementation(() => ({
      run: vi.fn(() => new Promise<void>((resolve) => {
        releaseActive = resolve;
      })),
      cancel: vi.fn(() => {
        releaseActive?.();
      }),
      steer: vi.fn(),
    }));

    const controller = new AbortController();
    const first = await fetch(`${baseUrl}/api/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt: '长任务',
        sessionId: 'session-idem-active',
        clientMessageId: 'msg-idem-active',
      }),
      signal: controller.signal,
    });
    expect(first.status).toBe(200);
    const taskStartRaw = await readSSEUntilWithoutClosing(first, 'event: task_start');
    const activeRunId = parseSSEData(taskStartRaw, 'task_start')?.runId as string;
    await waitForAssertion(() => expect(runRegistry.getBySessionId('session-idem-active')?.isAttached).toBe(true));
    // 预持久化已把用户消息落库（run 之前），重试能查到这条消息。
    await waitForAssertion(() => expect(persistedMessages.some((m) => m.id === 'msg-idem-active')).toBe(true));

    // as-of 归因命中的是仍在跑的这轮。
    attributeDurableRun({ runId: activeRunId, status: 'running' });

    const second = await fetch(`${baseUrl}/api/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt: '长任务',
        sessionId: 'session-idem-active',
        clientMessageId: 'msg-idem-active',
      }),
    });
    expect(second.status).toBe(409);
    expect(second.headers.get('content-type')).toContain('application/json');
    await expect(second.json()).resolves.toMatchObject({
      code: 'RUN_SESSION_CONFLICT',
      sessionId: 'session-idem-active',
      activeRunId,
    });
    expect(mockCreateAgentLoop).toHaveBeenCalledTimes(1);

    controller.abort();
    await waitForAssertion(() => expect(runRegistry.hasSession('session-idem-active')).toBe(false));
  });

  it('companion（connectedClient:false）重放：resolve 既有 runId、不再起 run、不再发 run_started', async () => {
    await closeServer();
    let startCompanionRun: Parameters<
      NonNullable<Parameters<typeof createAgentRouter>[0]['registerCompanionRun']>
    >[0] | undefined;
    const publish = vi.fn();
    await startAgentApi({
      tryGetSessionManager: async () => sessionManagerMock(),
      registerCompanionRun: (run) => {
        startCompanionRun = run;
      },
      publishCompanionEvent: publish,
    });

    const first = await startCompanionRun!({
      version: 1,
      sessionId: 'session-comp-idem',
      prompt: '手机指令',
      clientMessageId: 'cmd-idem-1',
    });
    const firstRunId = first.runId;
    expect(firstRunId).toEqual(expect.any(String));
    await waitForAssertion(() => expect(runRegistry.hasSession('session-comp-idem')).toBe(false));
    expect(persistedMessages.some((message) => message.id === 'cmd-idem-1')).toBe(true);

    attributeDurableRun({ runId: firstRunId, status: 'completed' });

    const second = await startCompanionRun!({
      version: 1,
      sessionId: 'session-comp-idem',
      prompt: '手机指令',
      clientMessageId: 'cmd-idem-1',
    });
    expect(second.runId).toBe(firstRunId);
    expect(mockCreateAgentLoop).toHaveBeenCalledTimes(1);
    // 重放不产生新的 run_started（首轮那一次除外）。
    const runStartedCount = publish.mock.calls.filter(
      ([sessionId, kind]) => sessionId === 'session-comp-idem' && kind === 'run_started',
    ).length;
    expect(runStartedCount).toBe(1);
  });
});

describe('DurableRunRepository.getLatestRootRunAsOf', () => {
  it('取 created_at <= 消息时间戳的最近一条 root run（排除 child，早于全部 run 时为 null）', async () => {
    const db = new Database(':memory:') as BetterSqlite3.Database;
    const repository = new DurableRunRepository(db);
    repository.migrate();

    const owner = (now: number): RunOwnerLease => ({
      ownerId: 'test-owner',
      processInstanceId: 'test-process',
      epoch: 1,
      leaseExpiresAt: now + 60_000,
    });
    const createRoot = async (runId: string, sessionId: string, createdAt: number) => {
      const lease = owner(createdAt);
      await repository.create({
        schemaVersion: DURABLE_RUN_SCHEMA_VERSION,
        runId,
        sessionId,
        engine: { kind: 'native' },
        status: 'running',
        attempt: 1,
        cursor: { nextEventSeq: 1, checkpointSeq: 0 },
        owner: lease,
        createdAt,
        updatedAt: createdAt,
      }, {
        runId,
        attempt: 1,
        processInstanceId: lease.processInstanceId,
        ownerId: lease.ownerId,
        ownerEpoch: lease.epoch,
        status: 'active',
        startedAt: createdAt,
      });
    };
    // 会话唯一活跃索引只允许一条非终态 root：历史轮先收成终态再开下一轮，
    // 与生产时序一致（消息落在 run 创建之后、下一轮创建之前）。
    const createTerminalRoot = async (runId: string, sessionId: string, createdAt: number) => {
      await createRoot(runId, sessionId, createdAt);
      await repository.commitTerminal({
        runId,
        attempt: 1,
        expectedOwnerEpoch: 1,
        expectedNextEventSeq: 1,
        status: 'completed',
        reason: 'test',
        event: { type: 'run_completed', payload: { sessionId }, recordedAt: createdAt + 1 },
        terminalAt: createdAt + 1,
      });
    };

    await createTerminalRoot('run-early', 'session-asof', 10);
    await createTerminalRoot('run-mid', 'session-asof', 20);
    // child run：created_at 落在窗口内，但不是消息所属的根 run。
    const childOwner = owner(18);
    await repository.create({
      schemaVersion: DURABLE_RUN_SCHEMA_VERSION,
      runId: 'run-child',
      sessionId: 'session-asof',
      parentRunId: 'run-mid',
      engine: { kind: 'subagent_single' },
      status: 'running',
      attempt: 1,
      cursor: { nextEventSeq: 1, checkpointSeq: 0 },
      owner: childOwner,
      createdAt: 18,
      updatedAt: 18,
    }, {
      runId: 'run-child',
      attempt: 1,
      processInstanceId: childOwner.processInstanceId,
      ownerId: childOwner.ownerId,
      ownerEpoch: childOwner.epoch,
      status: 'active',
      startedAt: 18,
    });
    await createRoot('run-late', 'session-asof', 30);

    expect((await repository.getLatestRootRunAsOf('session-asof', 25))?.runId).toBe('run-mid');
    expect((await repository.getLatestRootRunAsOf('session-asof', 35))?.runId).toBe('run-late');
    expect((await repository.getLatestRootRunAsOf('session-asof', 15))?.runId).toBe('run-early');
    expect(await repository.getLatestRootRunAsOf('session-asof', 5)).toBeNull();
    expect(await repository.getLatestRootRunAsOf('session-other', 35)).toBeNull();

    db.close();
  });
});
