import express from 'express';
import http from 'http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAgentRouter } from '../../../src/web/routes/agent';
import { inMemorySessions, sessionMessages } from '../../../src/web/helpers/sessionCache';

const mockRun = vi.fn();
const mockCancel = vi.fn();
const mockCreateAgentLoop = vi.fn();

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

vi.mock('../../../src/main/telemetry', () => ({
  getTelemetryCollector: () => ({
    endSession: vi.fn(),
  }),
}));

let server: http.Server | undefined;
let baseUrl = '';
const activeAgentLoops = new Map<string, { cancel(reason?: string): void | Promise<void> }>();

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

async function startAgentApi() {
  const app = express();
  app.use(express.json());
  app.use('/api', createAgentRouter({
    activeAgentLoops,
    pendingLocalToolCalls: new Map(),
    logger,
    tryGetSessionManager: async () => null,
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
    }));
    await startAgentApi();
  });

  afterEach(async () => {
    await closeServer();
    activeAgentLoops.clear();
    inMemorySessions.clear();
    sessionMessages.clear();
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
});
