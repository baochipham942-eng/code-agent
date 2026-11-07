// ============================================================================
// N-WEBFETCH-BLOCK-PRIVATE-NET — webFetchUnified 端到端 SSRF 复现与守卫验证
//
// 不 mock fetchDocument：走真实 webFetchUnified handler + 真实 fetchDocument。
// 环回目标用真实 node:http 服务器（127.0.0.1 随机端口），命中计数落内存——
// 修复前（裸 main）两次攻击都会真打到服务器（红）；修复后零命中（绿）。
// ============================================================================
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CanUseToolFn, Logger, ToolContext } from '../../../../../src/host/protocol/tools';

vi.mock('../../../../../src/host/services/core/configService', () => ({
  getConfigService: () => ({
    onSettingsUpdated: vi.fn(),
    getServiceApiKey: vi.fn(() => undefined),
  }),
}));

import { webFetchUnifiedModule } from '../../../../../src/host/tools/modules/network/webFetchUnified';
import { clearFetchCache } from '../../../../../src/host/tools/web/fetchDocument';

function makeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeCtx(): ToolContext {
  return {
    sessionId: 'ssrf-test-session',
    workingDir: process.cwd(),
    abortSignal: new AbortController().signal,
    logger: makeLogger(),
    emit: () => void 0,
  };
}

const allowAll = vi.fn(async () => ({ allow: true })) as unknown as CanUseToolFn;

describe('webFetchUnified SSRF guard (real fetchDocument, real loopback server)', () => {
  let server: http.Server;
  let hits: string[];
  let baseUrl: string;

  beforeEach(async () => {
    clearFetchCache();
    hits = [];
    server = http.createServer((req, res) => {
      hits.push(req.url ?? '/');
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('INTERNAL-SERVICE-SECRET');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    clearFetchCache();
    vi.unstubAllGlobals();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  it('direct loopback fetch never hits the local server; model sees the refusal reason', async () => {
    const handler = await webFetchUnifiedModule.createHandler();

    const result = await handler.execute(
      { action: 'fetch', url: `${baseUrl}/admin`, prompt: 'read the secret' },
      makeCtx(),
      allowAll,
    );

    // 本地服务零命中，模型看到明确拒绝原因与 Bash curl 路径
    expect(hits).toEqual([]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('private');
      expect(result.error).toContain('curl');
    }
  });

  it('action:"request" reaches the same refusal through native http_request (FU1)', async () => {
    const handler = await webFetchUnifiedModule.createHandler();

    const result = await handler.execute(
      { action: 'request', url: `${baseUrl}/admin` },
      makeCtx(),
      allowAll,
    );

    // 与 action:"fetch" 同一道守卫：零命中，错误点名主机并指向 Bash curl 审批路径
    expect(hits).toEqual([]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('internal network');
      expect(result.error).toContain('127.0.0.1');
      expect(result.error).toContain('curl');
    }
  });

  it('public 302 pointing at the local server never lands; hits stay 0', async () => {
    // 公网跳板用 stub（hermetic）；环回目标是真实服务器——守卫必须在第一跳后拦下
    const fetchStub = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url === 'https://public.example/redirect') {
        return {
          ok: false, status: 302, statusText: 'Found', url: '',
          headers: { get: (key: string) => key.toLowerCase() === 'location' ? `${baseUrl}/steal` : null },
          text: async () => '',
        } as unknown as Response;
      }
      throw new Error(`unexpected real fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchStub);

    const handler = await webFetchUnifiedModule.createHandler();

    const result = await handler.execute(
      { action: 'fetch', url: 'https://public.example/redirect', prompt: 'read the secret' },
      makeCtx(),
      allowAll,
    );

    expect(hits).toEqual([]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('private');
    }
  });

  it('public → public cross-domain redirect still succeeds through the real chain', async () => {
    // 正例：守卫只挡私网目标，公网跨域重定向照常工作且 crossDomainRedirect 保留
    const fetchStub = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('firecrawl')) {
        return {
          ok: false, status: 429, statusText: 'Too Many Requests', url: '',
          headers: { get: () => null }, text: async () => '{"success":false}',
        } as unknown as Response;
      }
      if (url === 'https://a.example/start') {
        return {
          ok: false, status: 302, statusText: 'Found', url: '',
          headers: { get: (key: string) => key.toLowerCase() === 'location' ? 'https://b.example/final' : null },
          text: async () => '',
        } as unknown as Response;
      }
      if (url === 'https://b.example/final') {
        return {
          ok: true, status: 200, statusText: 'OK', url: 'https://b.example/final',
          headers: { get: (key: string) => key.toLowerCase() === 'content-type' ? 'text/markdown' : null },
          text: async () => 'public cross-domain landing page with enough content to pass',
        } as unknown as Response;
      }
      throw new Error(`unexpected real fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchStub);

    const handler = await webFetchUnifiedModule.createHandler();
    const result = await handler.execute(
      { action: 'fetch', url: 'https://a.example/start', prompt: 'summarize' },
      makeCtx(),
      allowAll,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.meta).toMatchObject({
        finalUrl: 'https://b.example/final',
        requestedUrl: 'https://a.example/start',
        crossDomainRedirect: true,
      });
    }
    expect(hits).toEqual([]);
  });
});
