// ============================================================================
// N-WEBFETCH-BLOCK-PRIVATE-NET — contentExtractor（web_search auto_extract）
// 的 SSRF 行为：搜索结果 URL 是攻击者可影响的输入，私网条目必须被守卫拒绝并
// 跳过，同批公网结果照常抽取，批次整体不失败。不 mock fetchDocument——走真守卫。
// ============================================================================
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolExecutionResult } from '../../../../src/host/tools/types';

vi.mock('../../../../src/host/services/core/configService', () => ({
  getConfigService: () => ({
    onSettingsUpdated: vi.fn(),
    getServiceApiKey: vi.fn(() => undefined),
  }),
}));

import { autoExtractFallback } from '../../../../src/host/tools/web/search';
import { clearFetchCache } from '../../../../src/host/tools/web/fetchDocument';

describe('autoExtractFallback SSRF guard (real fetchDocument)', () => {
  beforeEach(() => {
    clearFetchCache();
    vi.clearAllMocks();
  });

  afterEach(() => {
    clearFetchCache();
    vi.unstubAllGlobals();
  });

  it('skips a private URL among search results without failing the batch', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('firecrawl')) {
        return {
          ok: false, status: 429, statusText: 'Too Many Requests', url: '',
          headers: { get: () => null }, text: async () => '{"success":false}',
        } as unknown as Response;
      }
      if (url === 'https://developers.openai.com/codex') {
        return {
          ok: true, status: 200, statusText: 'OK', url: 'https://developers.openai.com/codex',
          headers: { get: (key: string) => key.toLowerCase() === 'content-type' ? 'text/markdown' : null },
          text: async () => 'public documentation content long enough to be extracted properly',
        } as unknown as Response;
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const searchResult: ToolExecutionResult = {
      success: true,
      output: '',
      result: {
        results: [
          {
            title: 'Internal admin panel',
            url: 'http://192.168.1.1/admin',
            snippet: 'attacker-influenced search result pointing inside the LAN',
            source: 'brave',
          },
          {
            title: 'OpenAI Codex documentation',
            url: 'https://developers.openai.com/codex',
            snippet: 'Official documentation for Codex.',
            source: 'exa',
          },
        ],
      },
    };

    const output = await autoExtractFallback(searchResult, 2);

    // 私网条目被守卫拒绝 → 跳过（fetch 从未以该 URL 被调用）；公网条目照常抽取
    const calledUrls = fetchMock.mock.calls.map(call => String(call[0]));
    expect(calledUrls).not.toContain('http://192.168.1.1/admin');
    expect(output).toContain('https://developers.openai.com/codex');
    expect(output).toContain('public documentation content');
  });
});
