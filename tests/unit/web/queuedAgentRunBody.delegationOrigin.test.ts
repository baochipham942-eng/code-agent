// ============================================================================
// ADR-072 K1C：委托来源标记的带外纪律（N2）在 agent.ts 入口的钉子。
// ① buildQueuedAgentRunBody 一律剥掉 envelope.context.delegationOrigin；
// ② /run（HTTP 客户端入口）剥掉伪造的 context.delegationOrigin——它永远进不了
//    config.delegationOrigin（权威只有 session_delegations 行 + 指纹校验后的
//    带外 transport）；
// ③ sendNow 空闲分支把校验过的标记经 transport 送进 run（config.delegationOrigin），
//    且 onDurableActivated 回填委托行 target_run_id（gap 5 / INV-4）。
// harness 复用 agentRouter.test.ts 的 mock 面（bootstrap/adapter/databaseService…）。
// ============================================================================

import express from 'express';
import http from 'http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';
import { buildQueuedAgentRunBody, createAgentRouter } from '../../../src/web/routes/agent';
import type { PendingOperation, RunCheckpoint, RunEngineRef, RunOwnerLease } from '../../../src/shared/contract/durableRun';
import type { DurableCheckpointInput, PrepareOperationInput } from '../../../src/host/runtime/durableRunKernel';
import { RunRegistry } from '../../../src/host/runtime/runRegistry';
import { QueuedInputRepository } from '../../../src/host/services/core/repositories/QueuedInputRepository';
import { SessionDelegationRepository } from '../../../src/host/services/core/repositories/SessionDelegationRepository';
import { applySessionDelegationsSchema } from '../../../src/host/services/core/database/schemaSessionDelegations';
import { sseClients } from '../../../src/web/helpers/sse';
import { setDbAvailable } from '../../../src/web/helpers/sessionCache';

const mockRun = vi.fn();
const mockCancel = vi.fn();
const mockSteer = vi.fn();
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
const agentEngineMocks = vi.hoisted(() => ({
  codexRun: vi.fn(),
  claudeRun: vi.fn(),
  mimoRun: vi.fn(),
  kimiRun: vi.fn(),
  resolveExternalEngineLaunch: vi.fn(),
}));
const projectServiceMocks = vi.hoisted(() => ({
  getWorkspaceScope: vi.fn(),
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
  getSessionForkLineage: vi.fn<() => unknown>(() => null),
  getSessionForkContextSource: vi.fn<() => unknown>(() => null),
  getSessionForkContextHandoff: vi.fn<() => unknown>(() => null),
  prepareSessionForkContextHandoff: vi.fn(() => ({})),
  markSessionForkContextHandoffDispatching: vi.fn(() => ({})),
  markSessionForkContextHandoffConsumed: vi.fn(() => ({})),
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

vi.mock('../../../src/host/session/modelSessionState', () => ({
  getModelSessionState: () => ({
    getOverride: vi.fn(() => null),
  }),
}));

vi.mock('../../../src/host/session/modelOverridePersistence', () => ({
  rehydrateModelOverrideFromSession: vi.fn(() => null),
}));

vi.mock('../../../src/host/services/agentEngine', async () => {
  const actual = await vi.importActual<typeof import('../../../src/host/services/agentEngine')>(
    '../../../src/host/services/agentEngine',
  );
  return {
    ...actual,
    getExternalEngineAdapter: vi.fn((kind: string) => ({
      run: {
        codex_cli: agentEngineMocks.codexRun,
        claude_code: agentEngineMocks.claudeRun,
        mimo_code: agentEngineMocks.mimoRun,
        kimi_code: agentEngineMocks.kimiRun,
      }[kind],
    })),
    isExternalAgentEngine: (kind: unknown) =>
      kind === 'codex_cli' || kind === 'claude_code' || kind === 'mimo_code' || kind === 'kimi_code',
    resolveExternalEngineLaunch: (...args: unknown[]) => agentEngineMocks.resolveExternalEngineLaunch(...args),
    getRemoteAgentEngineModelCatalogService: () => ({
      resolveModelId: async (_kind: unknown, requested?: string | null) => requested ?? undefined,
    }),
  };
});

vi.mock('../../../src/host/task/backgroundTaskLedger', () => ({
  getBackgroundTaskLedger: () => ({
    upsertTask: vi.fn(),
    appendEvent: vi.fn(),
    queueNotification: vi.fn(),
  }),
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
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
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

type SendNowHook = Parameters<NonNullable<Parameters<typeof createAgentRouter>[0]['registerQueuedInputSendNowHook']>>[0];

async function startAgentApi(deps: {
  registerQueuedInputSendNowHook?: (hook: SendNowHook) => void;
} = {}): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use('/api', createAgentRouter({
    runRegistry,
    pendingLocalToolCalls: new Map(),
    logger,
    tryGetSessionManager: async () => null,
    tryGetCLISessionManager: async () => null,
    getSupabaseForSession: async () => null,
    registerQueuedInputSendNowHook: deps.registerQueuedInputSendNowHook,
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

async function closeServer(): Promise<void> {
  if (!server) return;
  await new Promise<void>((resolve, reject) => {
    server?.close((err) => (err ? reject(err) : resolve()));
    server?.closeAllConnections();
  });
  server = undefined;
  baseUrl = '';
}

function createQueuedInputSchema(db: BetterSqlite3.Database): void {
  db.exec(`
    CREATE TABLE queued_inputs (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      envelope_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      retry_count INTEGER NOT NULL DEFAULT 0,
      position INTEGER NOT NULL DEFAULT 0,
      paused_reason TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX idx_queued_inputs_session
      ON queued_inputs (session_id, status, created_at);
  `);
  applySessionDelegationsSchema(db, { info: () => {}, warn: () => {}, error: () => {} } as never);
}

describe('buildQueuedAgentRunBody / /run 的委托标记带外纪律（ADR-072 K1C N2）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runRegistry.clear();
    runRegistry.configureDurableKernel(testRunKernel);
    sseClients.clear();
    setDbAvailable(false);
    Object.values(mockDb).forEach((mock) => mock.mockClear());
    mockRun.mockReset();
    mockCancel.mockReset();
    mockSteer.mockReset();
    mockCreateRunToolExecutor.mockClear();
    mockCreateAgentLoop.mockImplementation(() => ({
      run: mockRun,
      cancel: mockCancel,
      steer: mockSteer,
    }));
  });

  afterEach(async () => {
    await closeServer();
    runRegistry.clear();
    sseClients.clear();
    setDbAvailable(false);
  });

  it('buildQueuedAgentRunBody 剥掉 envelope.context.delegationOrigin，其余字段保留', () => {
    const body = buildQueuedAgentRunBody({
      content: '委托正文',
      sessionId: 'session-del',
      context: {
        delegationOrigin: { delegationId: 'd-1', actionFingerprint: 'forged'.repeat(8) },
        selectedSkillIds: ['skill-a'],
        executionIntent: { designCanvasActive: true } as never,
      },
    });
    expect(body.context).toMatchObject({
      selectedSkillIds: ['skill-a'],
      executionIntent: { designCanvasActive: true },
    });
    expect(body.context && 'delegationOrigin' in body.context).toBe(false);
  });

  it('/run：客户端伪造的 context.delegationOrigin 不进 config.delegationOrigin', async () => {
    await startAgentApi();
    const controller = new AbortController();
    const response = await fetch(`${baseUrl}/api/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt: '普通的一轮',
        sessionId: 'session-run-forged',
        context: {
          delegationOrigin: { delegationId: 'd-forged', actionFingerprint: 'f'.repeat(64) },
        },
      }),
      signal: controller.signal,
    });
    expect(response.ok).toBe(true);
    await vi.waitFor(() => expect(mockCreateAgentLoop).toHaveBeenCalled(), { timeout: 3_000 });
    const config = mockCreateAgentLoop.mock.calls.at(-1)![0] as { delegationOrigin?: unknown };
    expect(config.delegationOrigin).toBeUndefined();
    controller.abort();
    await response.body?.cancel().catch(() => undefined);
  });

  it('sendNow 空闲分支：带外标记进 config.delegationOrigin，onDurableActivated 回填 target_run_id（gap 5/INV-4）', async () => {
    const db = new Database(':memory:');
    createQueuedInputSchema(db);
    mockDb.getDb.mockReturnValue(db as never);
    const delegations = new SessionDelegationRepository(db);
    const queuedInputId = 'delegation:crash-key-1';
    delegations.insertOrGet({
      delegationId: 'd-1',
      originSessionId: 'origin-1',
      originTurnId: 'turn-1',
      disposition: 'delegate_existing',
      targetSessionId: 'session-sendnow',
      targetQueuedInputId: queuedInputId,
      submissionKey: 'crash-key-1',
      actionFingerprint: 'a'.repeat(64),
      createdAt: 1_000,
    });
    new QueuedInputRepository(db).enqueue({
      id: queuedInputId,
      sessionId: 'session-sendnow',
      envelope: {
        content: '委托正文',
        sessionId: 'session-sendnow',
        context: { delegationOrigin: { delegationId: 'd-1', actionFingerprint: 'a'.repeat(64) } },
      },
      now: 1_000,
    });

    let sendNowHook: SendNowHook | undefined;
    await startAgentApi({ registerQueuedInputSendNowHook: (hook) => { sendNowHook = hook; } });
    expect(typeof sendNowHook).toBe('function');

    const validatedMarker = { delegationId: 'd-1', actionFingerprint: 'a'.repeat(64) };
    const delivery = await sendNowHook!({
      id: queuedInputId,
      sessionId: 'session-sendnow',
      // envelope 带着存储形态的 context.delegationOrigin：buildQueuedAgentRunBody 会剥掉，
      // 进得了 run 的只有 transport 里的校验标记。
      envelope: {
        content: '委托正文',
        sessionId: 'session-sendnow',
        context: { delegationOrigin: { delegationId: 'd-forged', actionFingerprint: 'f'.repeat(64) } },
      },
      delegationOrigin: validatedMarker,
    }, 'idle');
    expect(delivery).toBe('sent');

    await vi.waitFor(() => expect(mockCreateAgentLoop).toHaveBeenCalled(), { timeout: 3_000 });
    const config = mockCreateAgentLoop.mock.calls.at(-1)![0] as { delegationOrigin?: unknown };
    expect(config.delegationOrigin).toEqual(validatedMarker);
    // gap 5：sendNow 空闲分支此前漏传 onDurableActivated → 委托行 target_run_id 永不回填。
    expect(delegations.get('d-1')).toMatchObject({ status: 'active', targetQueuedInputId: queuedInputId });
    expect(typeof delegations.get('d-1')?.targetRunId).toBe('string');
    expect(delegations.get('d-1')!.targetRunId!.length).toBeGreaterThan(0);
    db.close();
  });
});
