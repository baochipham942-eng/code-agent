import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isFirecrawlRateLimited,
  annotateFirecrawlError,
  scrapeWithFirecrawl,
  searchWithFirecrawl,
} from '../../../../src/main/tools/web/firecrawlClient';

function makeResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  } as Response;
}

describe('Firecrawl 限流识别与提示 (P3)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('isFirecrawlRateLimited 识别 429 与 rate limit 文案', () => {
    expect(isFirecrawlRateLimited('HTTP 429: too many requests')).toBe(true);
    expect(isFirecrawlRateLimited('Rate limit exceeded')).toBe(true);
    expect(isFirecrawlRateLimited('HTTP 500: server error')).toBe(false);
    expect(isFirecrawlRateLimited('network timeout')).toBe(false);
  });

  it('keyless 限流时附带配置 key 的可操作提示', () => {
    const annotated = annotateFirecrawlError('HTTP 429: too many requests', false);
    expect(annotated).toContain('FIRECRAWL_API_KEY');
  });

  it('已配置 key 时限流不再建议配置 key', () => {
    const annotated = annotateFirecrawlError('HTTP 429: too many requests', true);
    expect(annotated).not.toContain('FIRECRAWL_API_KEY');
  });

  it('非限流错误不附加提示', () => {
    const annotated = annotateFirecrawlError('HTTP 500: server error', false);
    expect(annotated).toBe('HTTP 500: server error');
  });

  it('scrape keyless 命中 429 返回带提示的错误', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      makeResponse('rate limit exceeded', false, 429),
    ));
    const result = await scrapeWithFirecrawl('https://example.com', {
      configService: { getServiceApiKey: vi.fn(() => undefined) } as never,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('FIRECRAWL_API_KEY');
    }
  });

  it('search keyless 命中 429 返回带提示的错误', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      makeResponse('rate limit exceeded', false, 429),
    ));
    const result = await searchWithFirecrawl('agent neo', 3, {
      configService: { getServiceApiKey: vi.fn(() => undefined) } as never,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('FIRECRAWL_API_KEY');
    }
  });
});
