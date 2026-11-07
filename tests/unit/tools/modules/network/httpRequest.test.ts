// ============================================================================
// http_request (native ToolModule) Tests — P0-6.3 Batch 8
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type {
  ToolContext,
  CanUseToolFn,
  Logger,
} from '../../../../../src/host/protocol/tools';

const connectorEnv = vi.hoisted(() => ({
  provider: undefined as undefined | {
    id: string;
    displayName: string;
  },
  authorizationHeader: vi.fn(),
}));

vi.mock('../../../../../src/host/connectors/oauth/providerRegistry', () => ({
  findConnectedOAuthProviderForHost: vi.fn(() => connectorEnv.provider),
  getOAuthAuthorizationHeader: connectorEnv.authorizationHeader,
}));

import { httpRequestModule } from '../../../../../src/host/tools/modules/network/httpRequest';
import { WEB_FETCH } from '../../../../../src/shared/constants';

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
  connectorEnv.provider = undefined;
  connectorEnv.authorizationHeader.mockReset().mockResolvedValue('Bearer injected-token');
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
      expect(httpRequestModule.schema.readsUntrustedContent).toBe('block');
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

  // N-WEBFETCH-BLOCK-PRIVATE-NET-FU1 — 字面量绕过与重定向逐跳守卫
  describe('SSRF: literal hostname forms and per-hop redirect guard (FU1)', () => {
    /** 按 URL 路由的 fetch mock，返回值同时记录实际请求过的 URL 序列。 */
    function routeFetchWithRedirects(
      routes: Record<string, { status: number; location?: string; body?: string }>,
    ): string[] {
      const requestedUrls: string[] = [];
      fetchMock.mockImplementation(async (input: unknown) => {
        const requestedUrl = typeof input === 'string' ? input : String(input);
        requestedUrls.push(requestedUrl);
        const route = routes[requestedUrl];
        if (!route) throw new Error(`unexpected fetch target: ${requestedUrl}`);
        return makeResponse({
          status: route.status,
          statusText: route.status >= 300 && route.status < 400 ? 'Found' : 'OK',
          body: route.body,
          headers: route.location
            ? { location: route.location }
            : { 'content-type': 'text/plain' },
        });
      });
      return requestedUrls;
    }

    it.each([
      'http://[::1]/',
      'http://[fd00::1]/',
      'http://a.localhost/',
      'http://localhost./',
    ])('refuses private/loopback literal form %s before any fetch', async (url) => {
      fetchMock.mockResolvedValue(makeResponse({ body: 'leaked' }));
      const result = await run({ url });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('INVALID_ARGS');
        expect(result.error).toMatch(/internal network/);
        expect(result.error).toContain('curl');
      }
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('refuses a 302 pointing at loopback before the second request is sent', async () => {
      const requested = routeFetchWithRedirects({
        'https://public.example/start': { status: 302, location: 'http://127.0.0.1:8080/x' },
        'http://127.0.0.1:8080/x': { status: 200, body: 'INTERNAL-SERVICE-SECRET' },
      });
      const result = await run({ url: 'https://public.example/start' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('INVALID_ARGS');
        expect(result.error).toMatch(/internal network/);
        expect(result.error).toContain('127.0.0.1');
        expect(result.error).toContain('curl');
      }
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(requested).not.toContain('http://127.0.0.1:8080/x');
    });

    it('follows a 302 to a relative path on the same public host and returns the final body', async () => {
      routeFetchWithRedirects({
        'https://public.example/start': { status: 302, location: '/final' },
        'https://public.example/final': { status: 200, body: 'final body' },
      });
      const result = await run({ url: 'https://public.example/start' });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.output).toContain('final body');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('refuses a 302 chain that lands on the cloud metadata service', async () => {
      const requested = routeFetchWithRedirects({
        'https://public.example/one': { status: 302, location: 'https://public.example/two' },
        'https://public.example/two': { status: 302, location: 'http://169.254.169.254/latest/meta-data/' },
        'http://169.254.169.254/latest/meta-data/': { status: 200, body: 'ami-0123456789abcdef0' },
      });
      const result = await run({ url: 'https://public.example/one' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatch(/internal network/);
        expect(result.error).toContain('169.254.169.254');
      }
      expect(requested).not.toContain('169.254.169.254');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('refuses redirect chains longer than WEB_FETCH.MAX_REDIRECTS', async () => {
      const hops = WEB_FETCH.MAX_REDIRECTS + 3;
      const routes: Record<string, { status: number; location?: string; body?: string }> = {};
      for (let i = 0; i < hops; i++) {
        routes[`https://public.example/hop/${i}`] = {
          status: 302,
          location: `https://public.example/hop/${i + 1}`,
        };
      }
      routes[`https://public.example/hop/${hops}`] = { status: 200, body: 'unreachable end' };
      routeFetchWithRedirects(routes);

      const result = await run({ url: 'https://public.example/hop/0' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatch(/Too many redirects/);
      }
      expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(WEB_FETCH.MAX_REDIRECTS + 1);
    });
  });

  // rework r1 — 旧 BLOCKED_HOSTS 明确拦截、收口到 ssrfGuard 后漏掉的两个云元数据地址，
  // 必须维持基线的 deny：直连与重定向逐跳守卫都不放行。
  describe('SSRF: retired BLOCKED_HOSTS metadata entries stay blocked (rework r1)', () => {
    it('refuses Alibaba Cloud ECS metadata 100.100.100.200 before any fetch', async () => {
      fetchMock.mockResolvedValue(makeResponse({ body: 'leaked' }));
      const result = await run({ url: 'http://100.100.100.200/latest/meta-data/' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('INVALID_ARGS');
        expect(result.error).toMatch(/internal network/);
        expect(result.error).toContain('100.100.100.200');
        expect(result.error).toContain('curl');
      }
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('refuses Azure IMDS hostname metadata.azure.com before any fetch', async () => {
      fetchMock.mockResolvedValue(makeResponse({ body: 'leaked' }));
      const result = await run({ url: 'http://metadata.azure.com/metadata/instance' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('INVALID_ARGS');
        expect(result.error).toMatch(/internal network/);
        expect(result.error).toContain('metadata.azure.com');
        expect(result.error).toContain('curl');
      }
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('refuses a 302 hop landing on 100.100.100.200 before the second request is sent', async () => {
      const ecsTarget = 'http://100.100.100.200/latest/meta-data/ram/security-credentials/';
      const requested: string[] = [];
      fetchMock.mockImplementation(async (input: unknown) => {
        const requestedUrl = typeof input === 'string' ? input : String(input);
        requested.push(requestedUrl);
        if (requestedUrl === 'https://public.example/ecsmeta') {
          return makeResponse({
            status: 302,
            statusText: 'Found',
            headers: { location: ecsTarget },
          });
        }
        if (requestedUrl === ecsTarget) {
          return makeResponse({ status: 200, body: 'RAM-TEMP-CREDENTIALS' });
        }
        throw new Error(`unexpected fetch target: ${requestedUrl}`);
      });
      const result = await run({ url: 'https://public.example/ecsmeta' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatch(/internal network/);
        expect(result.error).toContain('100.100.100.200');
      }
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(requested).not.toContain(ecsTarget);
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

  // N-WEBFETCH-BLOCK-PRIVATE-NET-FU1 — 公网流量行为保持不变
  describe('public traffic stays unchanged (FU1)', () => {
    /**
     * 按 URL 路由的 fetch mock。逐调用快照 method/body/headers——requestHeaders
     * 是跨跳共享的可变 Headers 实例（跨域跳转会删凭证头），真实 fetch 在调用时
     * 序列化，mock 也必须拍快照再断言。
     */
    function routeFetchWithRedirects(
      routes: Record<string, { status: number; location?: string; body?: string }>,
    ): Array<{ url: string; method: string; body: unknown; headers: Headers }> {
      const captured: Array<{ url: string; method: string; body: unknown; headers: Headers }> = [];
      fetchMock.mockImplementation(async (input: unknown, options: RequestInit = {}) => {
        const requestedUrl = typeof input === 'string' ? input : String(input);
        const route = routes[requestedUrl];
        if (!route) throw new Error(`unexpected fetch target: ${requestedUrl}`);
        captured.push({
          url: requestedUrl,
          method: options.method ?? 'GET',
          body: options.body,
          headers: new Headers(options.headers),
        });
        return makeResponse({
          status: route.status,
          statusText: route.status >= 300 && route.status < 400 ? 'Found' : 'OK',
          body: route.body,
          headers: route.location
            ? { location: route.location }
            : { 'content-type': 'text/plain' },
        });
      });
      return captured;
    }

    it('plain public GET still returns the final body and meta', async () => {
      fetchMock.mockResolvedValue(
        makeResponse({ status: 200, body: 'plain body', headers: { 'content-type': 'text/plain' } }),
      );
      const result = await run({ url: 'https://example.com/api' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('HTTP 200 OK');
        expect(result.output).toContain('plain body');
        expect(result.meta).toMatchObject({ status: 200, url: 'https://example.com/api', method: 'GET' });
      }
    });

    it('public → public cross-origin redirect still returns the final body', async () => {
      routeFetchWithRedirects({
        'https://a.example/start': { status: 302, location: 'https://b.example/landing' },
        'https://b.example/landing': { status: 200, body: 'landing body' },
      });
      const result = await run({ url: 'https://a.example/start' });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.output).toContain('landing body');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('drops model-supplied credential headers on a cross-origin hop', async () => {
      const captured = routeFetchWithRedirects({
        'https://a.example/start': { status: 302, location: 'https://b.example/landing' },
        'https://b.example/landing': { status: 200, body: 'landing body' },
      });
      await run({
        url: 'https://a.example/start',
        headers: { cookie: 'sid=steal-me', authorization: 'Bearer model-supplied', 'x-safe': 'yes' },
      });
      expect(captured[0].headers.get('cookie')).toBe('sid=steal-me');
      expect(captured[1].headers.has('cookie')).toBe(false);
      expect(captured[1].headers.has('authorization')).toBe(false);
      expect(captured[1].headers.get('x-safe')).toBe('yes');
    });

    it('converts 302 on POST to GET without body on the next hop', async () => {
      const captured = routeFetchWithRedirects({
        'https://public.example/form': { status: 302, location: 'https://public.example/after' },
        'https://public.example/after': { status: 200, body: 'after' },
      });
      const result = await run({ url: 'https://public.example/form', method: 'POST', body: '{"a":1}' });
      expect(result.ok).toBe(true);
      expect(captured[0].method).toBe('POST');
      expect(captured[0].body).toBe('{"a":1}');
      expect(captured[1].method).toBe('GET');
      expect(captured[1].body).toBeUndefined();
    });

    it('keeps method and body across 307 and 308 hops', async () => {
      const captured = routeFetchWithRedirects({
        'https://public.example/s7': { status: 307, location: 'https://public.example/s8' },
        'https://public.example/s8': { status: 308, location: 'https://public.example/end' },
        'https://public.example/end': { status: 200, body: 'end' },
      });
      const result = await run({ url: 'https://public.example/s7', method: 'POST', body: '{"a":1}' });
      expect(result.ok).toBe(true);
      expect(captured[2].method).toBe('POST');
      expect(captured[2].body).toBe('{"a":1}');
    });
  });

  describe('connector authorization and guide prerequisite', () => {
    const provider = { id: 'custom-oauth', displayName: 'Example SaaS' };

    it('blocks the first connector request before reading the guide or touching credentials', async () => {
      connectorEnv.provider = provider;
      const result = await run(
        { url: 'https://api.example.com/items', method: 'POST', body: '{}' },
        makeCtx({ sessionId: 'guide-block-session' }),
      );

      expect(result).toMatchObject({ ok: false, code: 'CONNECTOR_GUIDE_REQUIRED' });
      expect(connectorEnv.authorizationHeader).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('records a guide read, injects Authorization, and keeps the full HTTP request shape', async () => {
      connectorEnv.provider = provider;
      const ctx = makeCtx({ sessionId: 'guide-then-request-session' });

      const guide = await run({ action: 'guide', url: 'https://api.example.com' }, ctx);
      expect(guide).toMatchObject({ ok: true, meta: { action: 'guide', connectorId: 'custom-oauth' } });
      expect(guide.ok && guide.output).toContain('Authorized host: api.example.com');
      expect(fetchMock).not.toHaveBeenCalled();

      fetchMock.mockResolvedValue(makeResponse({ body: 'created' }));
      const result = await run({
        action: 'request',
        url: 'https://api.example.com/items?limit=10',
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer model-supplied' },
        body: '{"name":"test"}',
      }, ctx);

      expect(result.ok).toBe(true);
      expect(connectorEnv.authorizationHeader).toHaveBeenCalledWith(provider);
      const [requestedUrl, options] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(requestedUrl).toBe('https://api.example.com/items?limit=10');
      expect(options.method).toBe('POST');
      expect(options.body).toBe('{"name":"test"}');
      expect(new Headers(options.headers).get('authorization')).toBe('Bearer injected-token');
      expect(options.redirect).toBe('manual');
    });

    it('does not inject credentials into an unmatched public host', async () => {
      fetchMock.mockResolvedValue(makeResponse({ body: 'ok' }));
      await run({ url: 'https://public.example.net/data' }, makeCtx({ sessionId: 'public-session' }));

      expect(connectorEnv.authorizationHeader).not.toHaveBeenCalled();
      expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).has('authorization')).toBe(false);
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

    it('aborts an in-flight fetch when the run signal fires', async () => {
      const ctrl = new AbortController();
      let fetchStarted!: () => void;
      const fetchStartedPromise = new Promise<void>((resolve) => {
        fetchStarted = resolve;
      });
      fetchMock.mockImplementation((_url: string, options: RequestInit) => {
        fetchStarted();
        return new Promise((_resolve, reject) => {
          options.signal?.addEventListener('abort', () => {
            const abortErr = new Error('aborted');
            abortErr.name = 'AbortError';
            reject(abortErr);
          });
        });
      });

      const resultPromise = run(
        { url: 'https://example.com', timeout: 10_000 },
        makeCtx({ abortSignal: ctrl.signal }),
      );

      await fetchStartedPromise;
      ctrl.abort('run_cancelled');
      const result = await resultPromise;

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('ABORTED');
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
