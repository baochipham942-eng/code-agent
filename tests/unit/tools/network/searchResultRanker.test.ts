import { describe, expect, it } from 'vitest';
import { rankSearchResults, scoreSearchResult } from '../../../../src/host/tools/web/search';
import type { SearchResult } from '../../../../src/host/tools/web/search';

describe('searchResultRanker', () => {
  it('boosts official and canonical evidence over SEO listicles', () => {
    const results: SearchResult[] = [
      {
        title: 'Best AI coding assistant 2026 - top 20 ranked',
        url: 'https://best-tools.example.com/ai-coding-assistant-2026',
        snippet: 'A marketing listicle with affiliate links.',
        source: 'brave',
      },
      {
        title: 'OpenAI Codex documentation',
        url: 'https://developers.openai.com/codex',
        snippet: 'Official documentation for Codex and related developer tools.',
        source: 'exa',
      },
      {
        title: 'GitHub issue discussion',
        url: 'https://github.com/vitest-dev/vitest/issues/123',
        snippet: 'Primary source issue discussion.',
        source: 'exa',
      },
    ];

    const ranked = rankSearchResults(results);

    const seoIndex = ranked.findIndex(result => result.url === 'https://best-tools.example.com/ai-coding-assistant-2026');
    const docsIndex = ranked.findIndex(result => result.url === 'https://developers.openai.com/codex');
    const githubIndex = ranked.findIndex(result => result.url === 'https://github.com/vitest-dev/vitest/issues/123');

    expect(docsIndex).toBeLessThan(seoIndex);
    expect(githubIndex).toBeLessThan(seoIndex);
    expect(scoreSearchResult(ranked[0])).toBeGreaterThan(scoreSearchResult(results[0]));
  });

  it('uses snippet detail and provider reliability as secondary signals', () => {
    const ranked = rankSearchResults([
      {
        title: 'Short snippet',
        url: 'https://example.com/a',
        snippet: 'Tiny',
        source: 'openai',
      },
      {
        title: 'Detailed snippet',
        url: 'https://example.com/b',
        snippet: 'This result has enough detail to explain the content and why it is relevant to the query.',
        source: 'exa',
      },
    ]);

    expect(ranked[0].title).toBe('Detailed snippet');
  });
});
