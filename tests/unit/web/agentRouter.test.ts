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
  mimoRun: vi.fn(),
  kimiRun: vi.fn(),
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

vi.mock('../../../src/host/services/agentEngine', () => ({
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
}));

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
      expect(activeAgentLoops.has('session-disconnect')).toBe(true);
    });

    controller.abort();

    await waitForAssertion(() => {
      expect(mockCancel).toHaveBeenCalledWith('user');
    });
  });

  describe('/api/run SSE per-token 并发上限（WP3-4）', () => {
    // 外层 beforeEach 的 releaseRun 是单值会被并发 run 覆盖（只能释放最后一个），
    // 本组测试开 N 条并发流，改用 per-loop 释放器（cancel 只放行自己的 run）；
    // 每个测试收尾必须排空（放行全部悬挂 run + 等 activeAgentLoops 清零），
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
      while (Date.now() < deadline && activeAgentLoops.size > 0) {
        pendingReleases.splice(0).forEach((release) => release());
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      pendingReleases.splice(0).forEach((release) => release());
      expect(activeAgentLoops.size).toBe(0);
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
    const addMessageToSession = vi.fn(async () => undefined);
    await closeServer();
    await startAgentApi({
      tryGetSessionManager: async () => ({
        addMessageToSession,
        getMessages: vi.fn(async () => []),
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
    const cliAgentArgs = vi.mocked(createCLIAgent).mock.calls[0][0];
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
