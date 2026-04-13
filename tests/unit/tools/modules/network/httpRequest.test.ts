// ============================================================================
// http_request (native ToolModule) Tests — P0-6.3 Batch 8
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type {
  ToolContext,
  CanUseToolFn,
  Logger,
} from '../../../../../src/main/protocol/tools';

import { httpRequestModule } from '../../../../../src/main/tools/modules/network/httpRequest';

function makeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  const ctrl = new AbortController();
  return {
    sessionId: 'test-session',
    workingDir: process.cwd(),
    abortSignal: ctrl.signal,
    logger: makeLogger(),
    emit: () => void 0,
    ...overrides,
  } as unknown as ToolContext;
}

const allowAll: CanUseToolFn = async () => ({ allow: true });
const denyAll: CanUseToolFn = async () => ({ allow: false, reason: 'blocked' });

async function run(
  args: Record<string, unknown>,
  ctx: ToolContext = makeCtx(),
  canUseTool: CanUseToolFn = allowAll,
  onProgress?: (p: { stage: string }) => void,
) {
  const handler = await httpRequestModule.createHandler();
  return handler.execute(args, ctx, canUseTool, onProgress as never);
}

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function makeResponse(opts: {
  status?: number;
  statusText?: string;
  ok?: boolean;
  body?: string;
  headers?: Record<string, string>;
}) {
  const status = opts.status ?? 200;
  const ok = opts.ok ?? (status >= 200 && status < 300);
  const headers = new Headers(opts.headers ?? {});
  return {
    ok,
    status,
    statusText: opts.statusText ?? 'OK',
    headers,
    text: async () => opts.body ?? '',
    json: async () => JSON.parse(opts.body ?? '{}'),
  };
}

describe('httpRequestModule (native)', () => {
  describe('schema', () => {
    it('has correct metadata', () => {
      expect(httpRequestModule.schema.name).toBe('http_request');
      expect(httpRequestModule.schema.category).toBe('network');
      expect(httpRequestModule.schema.permissionLevel).toBe('network');
      expect(httpRequestModule.schema.readOnly).toBe(false);
      expect(httpRequestModule.schema.allowInPlanMode).toBe(false);
      expect(httpRequestModule.schema.inputSchema.required).toEqual(['url']);
    });
  });

  describe('validation & errors', () => {
    it('rejects missing url', async () => {
      const result = await run({});
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
    });

    it('rejects empty url string', async () => {
      const result = await run({ url: '' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
    });

    it('rejects invalid http method', async () => {
      const result = await run({ url: 'https://example.com', method: 'WHATEVER' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('INVALID_ARGS');
        expect(result.error).toContain('Invalid HTTP method');
      }
    });

    it('returns PERMISSION_DENIED when canUseTool denies', async () => {
      fetchMock.mockResolvedValue(makeResponse({ body: 'ok' }));
      const result = await run({ url: 'https://example.com' }, makeCtx(), denyAll);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('PERMISSION_DENIED');
    });

    it('returns ABORTED when signal aborted before fetch', async () => {
      const ctrl = new AbortController();
      ctrl.abort();
      const ctx = makeCtx({ abortSignal: ctrl.signal });
      const result = await run({ url: 'https://example.com' }, ctx);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('ABORTED');
    });
  });

  describe('SSRF protection', () => {
    it('blocks 127.0.0.1', async () => {
      const result = await run({ url: 'http://127.0.0.1/' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('INVALID_ARGS');
        expect(result.error).toMatch(/internal network/);
      }
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('blocks AWS metadata service 169.254.169.254', async () => {
      const result = await run({ url: 'http://169.254.169.254/' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('INVALID_ARGS');
        expect(result.error).toMatch(/internal/);
      }
    });

    it('blocks localhost hostname', async () => {
      const result = await run({ url: 'http://localhost:8080' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('INVALID_ARGS');
        expect(result.error).toMatch(/blocked/);
      }
    });

    it('blocks private 10.x.x.x', async () => {
      const result = await run({ url: 'http://10.0.0.1/' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
    });

    it('blocks 192.168.x.x', async () => {
      const result = await run({ url: 'http://192.168.1.1/' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
    });

    it('blocks file:// protocol', async () => {
      const result = await run({ url: 'file:///etc/passwd' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('INVALID_ARGS');
        expect(result.error).toMatch(/Protocol not allowed/);
      }
    });

    it('rejects malformed URL', async () => {
      const result = await run({ url: 'not-a-url' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
    });
  });

  describe('happy paths', () => {
    it('GET returns body and status', async () => {
      fetchMock.mockResolvedValue(
        makeResponse({
          status: 200,
          body: 'hello world',
          headers: { 'content-type': 'text/plain' },
        }),
      );
      const result = await run({ url: 'https://example.com/api' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('HTTP 200 OK');
        expect(result.output).toContain('hello world');
        expect(result.output).toContain('Method: GET');
        expect((result.meta as { status: number }).status).toBe(200);
      }
    });

    it('POST passes body to fetch', async () => {
      fetchMock.mockResolvedValue(makeResponse({ body: 'created' }));
      await run({
        url: 'https://example.com/api',
        method: 'POST',
        body: '{"name":"test"}',
        headers: { 'content-type': 'application/json' },
      });
      expect(fetchMock).toHaveBeenCalled();
      const [, options] = fetchMock.mock.calls[0];
      expect(options.method).toBe('POST');
      expect(options.body).toBe('{"name":"test"}');
    });

    it('parses application/json content-type', async () => {
      fetchMock.mockResolvedValue(
        makeResponse({
          body: '{"ok":true,"value":42}',
          headers: { 'content-type': 'application/json' },
        }),
      );
      const result = await run({ url: 'https://example.com/api' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('"value": 42');
      }
    });

    it('non-2xx status returns ok:false with error', async () => {
      fetchMock.mockResolvedValue(
        makeResponse({ status: 404, statusText: 'Not Found', ok: false, body: 'missing' }),
      );
      const result = await run({ url: 'https://example.com/api' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('HTTP 404');
      }
    });

    it('redacts sensitive headers from output', async () => {
      fetchMock.mockResolvedValue(
        makeResponse({
          body: 'ok',
          headers: { authorization: 'Bearer secret', 'x-ok': 'yes' },
        }),
      );
      const result = await run({ url: 'https://example.com' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).not.toContain('Bearer secret');
        expect(result.output).toContain('x-ok: yes');
      }
    });

    it('truncates very large response body', async () => {
      const huge = 'x'.repeat(150000);
      fetchMock.mockResolvedValue(makeResponse({ body: huge }));
      const result = await run({ url: 'https://example.com' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('truncated, response too large');
      }
    });

    it('warns when content-length exceeds max', async () => {
      fetchMock.mockResolvedValue(
        makeResponse({
          body: 'ok',
          headers: { 'content-length': String(20 * 1024 * 1024) },
        }),
      );
      const result = await run({ url: 'https://example.com' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('Warning: Response too large');
      }
    });
  });

  describe('error mapping', () => {
    it('wraps generic fetch failure as NETWORK_ERROR', async () => {
      fetchMock.mockRejectedValue(new Error('connection refused'));
      const result = await run({ url: 'https://example.com' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('NETWORK_ERROR');
        expect(result.error).toContain('connection refused');
      }
    });

    it('maps AbortError to TIMEOUT', async () => {
      const abortErr = new Error('aborted');
      abortErr.name = 'AbortError';
      fetchMock.mockRejectedValue(abortErr);
      const result = await run({ url: 'https://example.com' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('TIMEOUT');
      }
    });
  });

  describe('onProgress', () => {
    it('emits starting progress', async () => {
      fetchMock.mockResolvedValue(makeResponse({ body: 'ok' }));
      const onProgress = vi.fn();
      await run({ url: 'https://example.com' }, makeCtx(), allowAll, onProgress);
      const stages = onProgress.mock.calls.map((c) => c[0].stage);
      expect(stages).toContain('starting');
    });
  });
});
