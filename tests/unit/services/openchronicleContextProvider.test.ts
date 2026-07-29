import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  loadSettings: vi.fn(),
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../../../src/host/services/external/openchronicleSupervisor', () => ({
  loadSettings: mocks.loadSettings,
}));

vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => mocks.logger,
}));

function rpcResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...init.headers },
    ...init,
  });
}

function contextResult(resultType?: 'complete' | 'input_required'): unknown {
  return {
    jsonrpc: '2.0',
    id: 2,
    result: {
      ...(resultType ? { resultType } : {}),
      content: [{
        type: 'text',
        text: JSON.stringify({
          recent_captures_headline: [{
            time: '2026-07-29T09:30:00.000Z',
            app_name: 'Code',
            window_title: 'OpenChronicle compatibility',
          }],
        }),
      }],
    },
  };
}

async function loadProvider() {
  vi.resetModules();
  return import('../../../src/host/services/external/openchronicleContextProvider');
}

describe('openchronicleContextProvider MCP compatibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadSettings.mockResolvedValue({
      enabled: true,
      autoInjectContext: true,
      blacklistApps: [],
      blacklistUrlPatterns: [],
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses one stateless tools/call request with protocol metadata', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(rpcResponse(contextResult('complete')));
    vi.stubGlobal('fetch', fetchMock);
    const { fetchOpenchronicleContext } = await loadProvider();

    const context = await fetchOpenchronicleContext();

    expect(context).toContain('[Code] OpenChronicle compatibility');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(request).toMatchObject({
      method: 'tools/call',
      params: {
        name: 'current_context',
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientInfo': {
            name: 'code-agent-screen-memory',
            version: '1',
          },
        },
      },
    });
    expect(fetchMock.mock.calls[0]?.[1]?.headers).not.toHaveProperty('mcp-session-id');
  });

  it('falls back to initialize plus session header and caches the legacy mode', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('unsupported', { status: 400 }))
      .mockResolvedValueOnce(rpcResponse(
        { jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18' } },
        { headers: { 'mcp-session-id': 'legacy-session-1' } },
      ))
      .mockResolvedValueOnce(rpcResponse(contextResult()))
      .mockResolvedValueOnce(rpcResponse(
        { jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18' } },
        { headers: { 'mcp-session-id': 'legacy-session-2' } },
      ))
      .mockResolvedValueOnce(rpcResponse(contextResult()));
    vi.stubGlobal('fetch', fetchMock);
    const { fetchOpenchronicleContext } = await loadProvider();

    await expect(fetchOpenchronicleContext()).resolves.toContain('[Code] OpenChronicle compatibility');
    await expect(fetchOpenchronicleContext()).resolves.toContain('[Code] OpenChronicle compatibility');

    const methods = fetchMock.mock.calls.map((call) => JSON.parse(String(call[1]?.body)).method);
    expect(methods).toEqual(['tools/call', 'initialize', 'tools/call', 'initialize', 'tools/call']);
    expect(fetchMock.mock.calls[2]?.[1]?.headers).toMatchObject({
      'mcp-session-id': 'legacy-session-1',
    });
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      'OpenChronicle stateless tools/call unsupported; falling back to legacy initialize',
    );
  });

  it('logs and returns null when stateless and legacy paths both fail', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('unsupported', { status: 404 }))
      .mockResolvedValueOnce(new Response('unavailable', { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);
    const { fetchOpenchronicleContext } = await loadProvider();

    await expect(fetchOpenchronicleContext()).resolves.toBeNull();
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      'OpenChronicle stateless and legacy MCP paths both failed',
    );
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      'OpenChronicle legacy initialize HTTP failure',
      { status: 503 },
    );
  });

  it('logs input_required and does not treat it as a completed result', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(rpcResponse(contextResult('input_required'))));
    const { fetchOpenchronicleContext } = await loadProvider();

    await expect(fetchOpenchronicleContext()).resolves.toBeNull();
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      'OpenChronicle stateless tools/call requires additional input',
      { toolName: 'current_context' },
    );
  });
});
