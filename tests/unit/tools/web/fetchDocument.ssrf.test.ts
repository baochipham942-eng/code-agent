// ============================================================================
// N-WEBFETCH-BLOCK-PRIVATE-NET — fetchDocument SSRF 守卫
//
// 复现（裸 main 上的不安全现状）见证据档 ①：环回直达 + 公网 302 跟随到环回
// 都曾真实成立。本文件是修复后的守卫断言：
//   - 初始 URL：仅 http/https 公网，私网/环回/链路本地/云元数据字面量全拒；
//   - 重定向：manual 逐跳跟随，每跳过同一道守卫（含非 http 协议目标）；
//   - 公网直达与公网→公网跨域重定向不受影响，crossDomainRedirect 语义保留。
// ============================================================================
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../src/host/services/core/configService', () => ({
  getConfigService: () => ({
    onSettingsUpdated: vi.fn(),
    getServiceApiKey: vi.fn(() => undefined),
  }),
}));

import { clearFetchCache, fetchDocument } from '../../../../src/host/tools/web/fetchDocument';
import { SEARCH_API_ENDPOINTS, WEB_FETCH } from '../../../../src/shared/constants';

function makeResponse(options: {
  ok: boolean;
  status: number;
  statusText?: string;
  body: unknown;
  url?: string;
  contentType?: string;
  location?: string;
}): Response {
  return {
    ok: options.ok,
    status: options.status,
    statusText: options.statusText ?? '',
    url: options.url ?? '',
    headers: {
      get: (key: string) => {
        const k = key.toLowerCase();
        if (k === 'content-type') return options.contentType ?? '';
        if (k === 'location') return options.location ?? null;
        return null;
      },
    },
    text: async () => typeof options.body === 'string' ? options.body : JSON.stringify(options.body),
  } as Response;
}

type Route = { match: (url: string) => boolean; respond: (url: string) => Response };

/** Firecrawl 端点一律 429，逼原生路径（守卫行为与 provider 无关） */
function firecrawlUnavailable(): Route {
  return {
    match: url => url === SEARCH_API_ENDPOINTS.firecrawlScrape,
    respond: () => makeResponse({
      ok: false, status: 429, statusText: 'Too Many Requests',
      body: '{"success":false,"error":"rate limit"}',
    }),
  };
}

/**
 * 模拟 undici fetch 的重定向语义：manual 模式原样返回 3xx（跟随由 fetchDocument
 * 自己做），follow 模式自递归跟随——后者用于证明裸 main 上的跟随行为（复现已留档）。
 */
function makeFetchRouter(routes: Route[]): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async (input: string | URL | Request, init?: { redirect?: string }): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    for (const route of routes) {
      if (!route.match(url)) continue;
      const response = route.respond(url);
      const location = response.headers.get('location');
      const isRedirect = response.status >= 300 && response.status < 400 && location;
      if (isRedirect && init?.redirect !== 'manual') {
        return (await mock(location, init)) as Response;
      }
      return response;
    }
    throw new Error(`fetch-router: unexpected fetch ${url}`);
  });
  return mock;
}

/** 捕获期望中的拒绝并返回 Error（rejects.toThrow 之外还要看全文时用） */
async function captureRejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (e) {
    return e instanceof Error ? e : new Error(String(e));
  }
  return new Error('expected rejection but promise resolved');
}

/** 断言某 URL 被守卫拒绝且 fetch 一次都没被调（不抓取、不泄露给 Firecrawl） */
async function expectRefused(url: string): Promise<void> {
  const fetchMock = makeFetchRouter([]);
  vi.stubGlobal('fetch', fetchMock);
  await expect(fetchDocument(url)).rejects.toThrow(/web_fetch blocked/);
  expect(fetchMock).not.toHaveBeenCalled();
}

describe('fetchDocument SSRF guard — initial URL literal forms', () => {
  beforeEach(() => {
    clearFetchCache();
    vi.clearAllMocks();
  });

  afterEach(() => {
    clearFetchCache();
    vi.unstubAllGlobals();
  });

  it.each([
    'http://localhost/x',
    'http://localhost./x',
    'http://foo.localhost/x',
    'http://127.0.0.1:8080/x',
    // WHATWG URL 把下列数字/hex 简写归一成点分 IPv4 再判
    'http://2130706433/x',
    'http://0x7f.1/x',
    'http://127.1/x',
    'http://[::1]/x',
    'http://[::ffff:127.0.0.1]/x',
    'http://10.0.0.5/x',
    'http://192.168.1.1/x',
    'http://172.16.0.1/x',
    'http://169.254.169.254/latest/meta-data',
    'http://metadata.google.internal/computeMetadata/v1',
    'http://0.0.0.0/x',
  ])('refuses %s before any fetch', async (url) => {
    await expectRefused(url);
  });

  it('refuses non-http schemes', async () => {
    await expectRefused('file:///etc/passwd');
    await expectRefused('ftp://example.com/x');
  });

  it('refusal names the host and points the model at the Bash curl path', async () => {
    vi.stubGlobal('fetch', makeFetchRouter([]));
    const error = await captureRejection(fetchDocument('http://192.168.1.1/admin'));
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain('192.168.1.1');
    expect(error.message).toContain('private, loopback, link-local or cloud-metadata');
    expect(error.message).toContain('only reaches public internet URLs');
    expect(error.message).toContain('Bash curl');
  });

  it('public http/https URLs are unaffected (native path succeeds)', async () => {
    const fetchMock = makeFetchRouter([
      firecrawlUnavailable(),
      {
        match: url => url === 'http://example.com/data.json',
        respond: () => makeResponse({
          ok: true, status: 200, statusText: 'OK', body: '{"ok":true}',
          url: 'http://example.com/data.json', contentType: 'application/json',
        }),
      },
    ]);
    vi.stubGlobal('fetch', fetchMock);

    const doc = await fetchDocument('http://example.com/data.json');

    expect(doc).toMatchObject({ content: '{"ok":true}', provider: 'native', finalUrl: 'http://example.com/data.json' });
  });
});

describe('fetchDocument SSRF guard — per-hop redirect checks', () => {
  beforeEach(() => {
    clearFetchCache();
    vi.clearAllMocks();
  });

  afterEach(() => {
    clearFetchCache();
    vi.unstubAllGlobals();
  });

  it('public 302 to a loopback target is refused before the second hop is fetched', async () => {
    const fetchMock = makeFetchRouter([
      firecrawlUnavailable(),
      {
        match: url => url === 'https://public.example/redirect',
        respond: () => makeResponse({
          ok: false, status: 302, statusText: 'Found', body: '', location: 'http://127.0.0.1/admin',
        }),
      },
    ]);
    vi.stubGlobal('fetch', fetchMock);

    const error = await captureRejection(fetchDocument('https://public.example/redirect'));

    expect(error.message).toMatch(/web_fetch blocked: 127\.0\.0\.1 is a private/);
    const calledUrls = fetchMock.mock.calls.map(call => String(call[0]));
    expect(calledUrls).toContain('https://public.example/redirect');
    expect(calledUrls).not.toContain('http://127.0.0.1/admin');
  });

  it('public 302 to a cloud-metadata target is refused mid-chain', async () => {
    const fetchMock = makeFetchRouter([
      firecrawlUnavailable(),
      {
        match: url => url === 'https://public.example/redirect',
        respond: () => makeResponse({
          ok: false, status: 302, statusText: 'Found', body: '',
          location: 'http://169.254.169.254/latest/meta-data',
        }),
      },
    ]);
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchDocument('https://public.example/redirect')).rejects.toThrow(/169\.254\.169\.254/);
    expect(fetchMock.mock.calls.map(call => String(call[0]))).not.toContain('http://169.254.169.254/latest/meta-data');
  });

  it('redirect to a non-http scheme (file:) is refused', async () => {
    const fetchMock = makeFetchRouter([
      firecrawlUnavailable(),
      {
        match: url => url === 'https://public.example/redirect',
        respond: () => makeResponse({
          ok: false, status: 302, statusText: 'Found', body: '', location: 'file:///etc/passwd',
        }),
      },
    ]);
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchDocument('https://public.example/redirect')).rejects.toThrow(/only http\/https URLs are allowed/);
  });

  it('relative Location resolves against the current URL (same-domain redirect ok)', async () => {
    const fetchMock = makeFetchRouter([
      firecrawlUnavailable(),
      {
        match: url => url === 'https://a.example/start',
        respond: () => makeResponse({ ok: false, status: 302, statusText: 'Found', body: '', location: '/end' }),
      },
      {
        match: url => url === 'https://a.example/end',
        respond: () => makeResponse({
          ok: true, status: 200, statusText: 'OK', body: 'landed', url: 'https://a.example/end',
          contentType: 'text/plain',
        }),
      },
    ]);
    vi.stubGlobal('fetch', fetchMock);

    const doc = await fetchDocument('https://a.example/start');

    expect(doc).toMatchObject({ content: 'landed', finalUrl: 'https://a.example/end', crossDomainRedirect: false });
  });

  it('public → public cross-domain redirect succeeds and keeps crossDomainRedirect: true', async () => {
    const fetchMock = makeFetchRouter([
      firecrawlUnavailable(),
      {
        match: url => url === 'https://a.example/start',
        respond: () => makeResponse({
          ok: false, status: 302, statusText: 'Found', body: '', location: 'https://b.example/final',
        }),
      },
      {
        match: url => url === 'https://b.example/final',
        respond: () => makeResponse({
          ok: true, status: 200, statusText: 'OK', body: 'cross landed', url: 'https://b.example/final',
          contentType: 'text/plain',
        }),
      },
    ]);
    vi.stubGlobal('fetch', fetchMock);

    const doc = await fetchDocument('https://a.example/start');

    expect(doc).toMatchObject({
      content: 'cross landed',
      finalUrl: 'https://b.example/final',
      crossDomainRedirect: true,
      statusCode: 200,
    });
  });

  it('follows at most WEB_FETCH.MAX_REDIRECTS hops', async () => {
    const maxHops = WEB_FETCH.MAX_REDIRECTS;
    const buildRoute = (n: number): Route => ({
      match: url => url === `https://hop.example/${n}`,
      respond: () => makeResponse({
        ok: false, status: 302, statusText: 'Found', body: '', location: `https://hop.example/${n + 1}`,
      }),
    });
    const routes: Route[] = [firecrawlUnavailable()];
    for (let n = 0; n <= maxHops + 2; n++) routes.push(buildRoute(n));

    // maxHops 跳（maxHops+1 个 URL，最后一个是 200）→ 成功
    const okRouter = makeFetchRouter([
      firecrawlUnavailable(),
      ...routes.slice(0, maxHops + 1),
      {
        match: url => url === `https://hop.example/${maxHops}`,
        respond: () => makeResponse({
          ok: true, status: 200, statusText: 'OK', body: 'just enough', url: '', contentType: 'text/plain',
        }),
      },
    ]);
    vi.stubGlobal('fetch', okRouter);
    const doc = await fetchDocument('https://hop.example/0');
    expect(doc.content).toBe('just enough');
    expect(doc.finalUrl).toBe(`https://hop.example/${maxHops}`);
    vi.unstubAllGlobals();
    // 模块级 LRU 缓存会把成功结果留到下一段——两段之间清掉
    clearFetchCache();

    // maxHops+1 跳 → Too many redirects
    const loopRouter = makeFetchRouter(routes);
    vi.stubGlobal('fetch', loopRouter);
    await expect(fetchDocument('https://hop.example/0')).rejects.toThrow(/Too many redirects/);
  });
});
