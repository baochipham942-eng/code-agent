import http from 'http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServeRequestHandler } from '../../../src/cli/commands/serve';
import type { CLIGlobalOptions } from '../../../src/cli/types';

const mocks = vi.hoisted(() => ({
  createCLIAgent: vi.fn(),
  createAgentLoop: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock('../../../src/cli/adapter', () => ({
  createCLIAgent: mocks.createCLIAgent,
}));

vi.mock('../../../src/cli/bootstrap', () => ({
  createAgentLoop: mocks.createAgentLoop,
  cleanup: vi.fn(),
  initializeCLIServices: vi.fn(),
}));

vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({
    error: mocks.loggerError,
  }),
}));

let server: http.Server | undefined;
let baseUrl = '';

async function startServeApi(globalOpts: Partial<CLIGlobalOptions> = {}) {
  server = http.createServer(createServeRequestHandler({
    host: '127.0.0.1',
    port: 0,
    globalOpts: globalOpts as CLIGlobalOptions,
  }));
  await new Promise<void>((resolve) => {
    server?.listen(0, '127.0.0.1', resolve);
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

async function readJson(response: Response): Promise<unknown> {
  return response.json() as Promise<unknown>;
}

async function postRun(body: unknown): Promise<Response> {
  return fetch(`${baseUrl}/api/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(async () => {
  await closeServer();
  vi.useRealTimers();
});

describe('createServeRequestHandler', () => {
  it('serves health, idle status, CORS preflight, cancel, and not-found responses', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1700000000000);
    await startServeApi();

    const preflight = await fetch(`${baseUrl}/anything`, { method: 'OPTIONS' });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe('*');
    expect(preflight.headers.get('access-control-allow-methods')).toBe('GET, POST, OPTIONS');

    const health = await fetch(`${baseUrl}/api/health`);
    expect(health.status).toBe(200);
    expect(await readJson(health)).toEqual({
      status: 'ok',
      timestamp: 1700000000000,
    });

    const status = await fetch(`${baseUrl}/api/status`);
    expect(status.status).toBe(200);
    expect(await readJson(status)).toEqual({ running: false });

    const cancel = await fetch(`${baseUrl}/api/cancel`, { method: 'POST' });
    expect(cancel.status).toBe(404);
    expect(await readJson(cancel)).toEqual({ error: 'No task running' });

    const missing = await fetch(`${baseUrl}/missing`);
    expect(missing.status).toBe(404);
    expect(await readJson(missing)).toEqual({ error: 'Not Found' });
  });

  it('rejects invalid run request bodies before creating an agent', async () => {
    await startServeApi();

    const invalidJson = await postRun('{');
    expect(invalidJson.status).toBe(400);
    expect(await readJson(invalidJson)).toEqual({ error: 'Invalid JSON' });

    const missingPrompt = await postRun({ prompt: '' });
    expect(missingPrompt.status).toBe(400);
    expect(await readJson(missingPrompt)).toEqual({ error: 'Missing prompt' });

    expect(mocks.createCLIAgent).not.toHaveBeenCalled();
    expect(mocks.createAgentLoop).not.toHaveBeenCalled();
  });

  it('streams run events, exposes running status, rejects concurrent runs, and dispatches cancel requests', async () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1000);
    let finishRun!: () => void;
    const runGate = new Promise<void>((resolve) => {
      finishRun = resolve;
    });
    const run = vi.fn(async () => {
      await runGate;
    });
    mocks.createCLIAgent.mockResolvedValue({
      getConfig: () => ({ model: 'agent-config' }),
    });
    const cancel = vi.fn(async () => {
      finishRun();
    });
    mocks.createAgentLoop.mockImplementation((_config: unknown, emit: (event: { type: string; data: unknown }) => void) => ({
      run: vi.fn(async (prompt: string) => {
        emit({ type: 'message', data: { prompt, text: 'started' } });
        await run(prompt);
      }),
      cancel,
    }));
    await startServeApi({
      project: '/global-project',
      model: 'global-model',
      provider: 'global-provider',
      debug: true,
    });

    const runResponse = await postRun({
      prompt: 'build endpoint tests',
      project: '/request-project',
      model: 'request-model',
      provider: 'request-provider',
    });

    expect(runResponse.status).toBe(200);
    expect(runResponse.headers.get('content-type')).toContain('text/event-stream');
    expect(mocks.createCLIAgent).toHaveBeenCalledWith({
      project: '/request-project',
      model: 'request-model',
      provider: 'request-provider',
      json: true,
      debug: true,
    });

    nowSpy.mockReturnValue(1250);
    const status = await fetch(`${baseUrl}/api/status`);
    expect(await readJson(status)).toEqual({
      running: true,
      taskId: 'task-1000',
      task: 'build endpoint tests',
      startTime: 1000,
      duration: 250,
    });

    const conflict = await postRun({ prompt: 'second task' });
    expect(conflict.status).toBe(409);
    expect(await readJson(conflict)).toEqual({
      error: 'A task is already running',
      taskId: 'task-1000',
    });

    const cancelResponse = await fetch(`${baseUrl}/api/cancel`, { method: 'POST' });
    expect(cancelResponse.status).toBe(202);
    expect(await readJson(cancelResponse)).toEqual({
      message: 'cancel_requested',
      taskId: 'task-1000',
    });
    expect(cancel).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledWith('user');

    nowSpy.mockReturnValue(1500);
    const streamText = await runResponse.text();
    expect(streamText).toContain('event: task_start');
    expect(streamText).toContain('data: {"taskId":"task-1000","prompt":"build endpoint tests"}');
    expect(streamText).toContain('event: message');
    expect(streamText).toContain('data: {"prompt":"build endpoint tests","text":"started"}');
    expect(streamText).toContain('event: task_cancelled');
    expect(streamText).toContain('data: {"taskId":"task-1000","duration":250}');
    expect(run).toHaveBeenCalledWith('build endpoint tests');

    const idle = await fetch(`${baseUrl}/api/status`);
    expect(await readJson(idle)).toEqual({ running: false });
  });

  it('falls back to global agent options and streams agent loop errors before clearing state', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(2000);
    mocks.createCLIAgent.mockResolvedValue({
      getConfig: () => ({ model: 'fallback-config' }),
    });
    mocks.createAgentLoop.mockReturnValue({
      run: vi.fn(async () => {
        throw new Error('loop failed');
      }),
    });
    await startServeApi({
      project: '/global-project',
      model: 'global-model',
      provider: 'global-provider',
    });

    const response = await postRun({ prompt: 'fail gracefully' });

    expect(response.status).toBe(200);
    expect(mocks.createCLIAgent).toHaveBeenCalledWith({
      project: '/global-project',
      model: 'global-model',
      provider: 'global-provider',
      json: true,
      debug: undefined,
    });
    await expect(response.text()).resolves.toContain('event: error\ndata: {"message":"loop failed"}');

    const status = await fetch(`${baseUrl}/api/status`);
    expect(await readJson(status)).toEqual({ running: false });
  });
});
