// ============================================================================
// Web Search Tool Tests
// ============================================================================
//
// Unit tests for exported utility functions:
// - formatAge: ISO date → relative age string
// - formatAsTable: search results → markdown table
// - buildDomainQuerySuffix: domain filter → query suffix
// - mergeSearchResults: multi-source results → deduplicated output
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  formatAge,
  formatAsTable,
  buildDomainQuerySuffix,
  mergeSearchResults,
  deduplicateResults,
  normalizeTitleForDedup,
} from '../../../../src/main/tools/web/webSearch';

// ============================================================================
// formatAge
// ============================================================================

describe('formatAge', () => {
  it('should return "just now" for dates less than 1 hour ago', () => {
    const now = new Date();
    now.setMinutes(now.getMinutes() - 30);
    expect(formatAge(now.toISOString())).toBe('just now');
  });

  it('should return hours ago for dates less than 24 hours', () => {
    const now = new Date();
    now.setHours(now.getHours() - 5);
    expect(formatAge(now.toISOString())).toBe('5 hours ago');
  });

  it('should return "1 day ago" for ~24 hours', () => {
    const now = new Date();
    now.setHours(now.getHours() - 30);
    expect(formatAge(now.toISOString())).toBe('1 day ago');
  });

  it('should return days ago for dates less than 30 days', () => {
    const now = new Date();
    now.setDate(now.getDate() - 5);
    expect(formatAge(now.toISOString())).toBe('5 days ago');
  });

  it('should return months ago for dates more than 30 days', () => {
    const now = new Date();
    now.setDate(now.getDate() - 65);
    expect(formatAge(now.toISOString())).toBe('2 months ago');
  });

  it('should return "1 month ago" for ~35 days', () => {
    const now = new Date();
    now.setDate(now.getDate() - 35);
    expect(formatAge(now.toISOString())).toBe('1 month ago');
  });

  it('should return undefined for invalid date', () => {
    expect(formatAge('not-a-date')).toBeUndefined();
  });

  it('should return undefined for empty string', () => {
    expect(formatAge('')).toBeUndefined();
  });

  it('should handle date-only string (YYYY-MM-DD)', () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 3);
    const dateStr = yesterday.toISOString().slice(0, 10);
    const result = formatAge(dateStr);
    expect(result).toMatch(/\d+ days? ago/);
  });
});

// ============================================================================
// formatAsTable
// ============================================================================

describe('formatAsTable', () => {
  it('should format results as markdown list with descriptions', () => {
    const searchResult = {
      success: true,
      output: '',
      result: {
        results: [
          { title: 'Product A Launch', url: 'https://example.com/a', age: '2 days ago', snippet: 'A new AI tool for developers', source: 'exa' },
          { title: 'Product B Update', url: 'https://example.com/b', age: '5 days ago', snippet: 'Major update to B platform', source: 'exa' },
        ],
        sources: ['exa'],
        duration: 500,
      },
    };

    const output = formatAsTable(searchResult);
    expect(output).toContain('### 1. Product A Launch (2 days ago)');
    expect(output).toContain('A new AI tool for developers');
    expect(output).toContain('https://example.com/a');
    expect(output).toContain('### 2. Product B Update (5 days ago)');
    expect(output).toContain('Major update to B platform');
    expect(output).toContain('Sources: exa');
  });

  it('should return empty message when no results', () => {
    const searchResult = {
      success: true,
      output: '',
      result: { results: [], sources: ['exa'] },
    };

    const output = formatAsTable(searchResult);
    expect(output).toContain('No results found');
  });

  it('should truncate long titles to 100 chars', () => {
    const longTitle = 'A'.repeat(150);
    const searchResult = {
      success: true,
      output: '',
      result: {
        results: [{ title: longTitle, url: 'https://example.com', age: 'now', source: 'exa' }],
      },
    };

    const output = formatAsTable(searchResult);
    // Title should be truncated (100 chars + "### 1. " prefix + " (now)")
    expect(output).not.toContain('A'.repeat(150));
  });

  it('should omit age when missing', () => {
    const searchResult = {
      success: true,
      output: '',
      result: {
        results: [{ title: 'Test', url: 'https://example.com', source: 'exa' }],
      },
    };

    const output = formatAsTable(searchResult);
    expect(output).toContain('### 1. Test\n');
    expect(output).not.toContain('unknown');
  });

  it('should handle undefined result data', () => {
    const searchResult = {
      success: true,
      output: '',
    };

    const output = formatAsTable(searchResult);
    expect(output).toContain('No results found');
  });

  it('should include snippet when available', () => {
    const searchResult = {
      success: true,
      output: '',
      result: {
        results: [
          { title: 'With Snippet', url: 'https://a.com', snippet: 'This is a description', source: 'exa' },
          { title: 'No Snippet', url: 'https://b.com', source: 'exa' },
        ],
      },
    };

    const output = formatAsTable(searchResult);
    expect(output).toContain('This is a description');
    // Item without snippet should still have title and URL
    expect(output).toContain('### 2. No Snippet');
    expect(output).toContain('https://b.com');
  });
});

// ============================================================================
// buildDomainQuerySuffix
// ============================================================================

describe('buildDomainQuerySuffix', () => {
  it('should return empty string for no filter', () => {
    expect(buildDomainQuerySuffix()).toBe('');
    expect(buildDomainQuerySuffix(undefined)).toBe('');
  });

  it('should build site: operators for allowed domains', () => {
    const result = buildDomainQuerySuffix({
      allowed: ['docs.python.org', 'github.com'],
    });
    expect(result).toBe(' site:docs.python.org OR site:github.com');
  });

  it('should build -site: operators for blocked domains', () => {
    const result = buildDomainQuerySuffix({
      blocked: ['pinterest.com', 'quora.com'],
    });
    expect(result).toBe(' -site:pinterest.com -site:quora.com');
  });

  it('should combine allowed and blocked domains', () => {
    const result = buildDomainQuerySuffix({
      allowed: ['github.com'],
      blocked: ['pinterest.com'],
    });
    expect(result).toContain('site:github.com');
    expect(result).toContain('-site:pinterest.com');
  });

  it('should return empty string for empty arrays', () => {
    expect(buildDomainQuerySuffix({ allowed: [], blocked: [] })).toBe('');
  });
});

// ============================================================================
// mergeSearchResults
// ============================================================================

describe('mergeSearchResults', () => {
  it('should merge results from multiple sources', () => {
    const results = [
      {
        source: 'exa',
        success: true,
        results: [
          { title: 'Product A', url: 'https://exa.com/a', snippet: 'EXA result' },
        ],
      },
      {
        source: 'brave',
        success: true,
        results: [
          { title: 'Product B', url: 'https://brave.com/b', snippet: 'Brave result' },
        ],
      },
    ];

    const merged = mergeSearchResults('test query', results, [], 100);
    expect(merged.success).toBe(true);
    expect(merged.output).toContain('Product A');
    expect(merged.output).toContain('Product B');
    expect((merged.result as any).results).toHaveLength(2);
  });

  it('should deduplicate by URL', () => {
    const results = [
      {
        source: 'exa',
        success: true,
        results: [
          { title: 'Product A', url: 'https://example.com/article', snippet: 'from EXA' },
        ],
      },
      {
        source: 'brave',
        success: true,
        results: [
          { title: 'Product A (duplicate)', url: 'https://example.com/article', snippet: 'from Brave' },
        ],
      },
    ];

    const merged = mergeSearchResults('test', results, [], 100);
    const allResults = (merged.result as any).results;
    expect(allResults).toHaveLength(1);
    expect(allResults[0].source).toBe('exa'); // first source wins
  });

  it('should deduplicate by normalized title', () => {
    // Same product from different sources (the FlashAI 2.0 case)
    const results = [
      {
        source: 'exa',
        success: true,
        results: [
          {
            title: 'FlashLabs Launches FlashAI 2.0: Enterprise Voice AI Platform',
            url: 'https://aijourn.com/flashlabs-flashai-2-0',
            snippet: 'from AI Journal',
          },
        ],
      },
      {
        source: 'exa',
        success: true,
        results: [
          {
            title: 'FlashLabs Launches FlashAI 2.0: Enterprise Voice AI Platform',
            url: 'https://prnewswire.com/flashlabs-flashai-2-0',
            snippet: 'from PR Newswire',
          },
        ],
      },
    ];

    const merged = mergeSearchResults('AI products', results, [], 100);
    const allResults = (merged.result as any).results;
    expect(allResults).toHaveLength(1);
  });

  it('should be case-insensitive for title dedup', () => {
    const results = [
      {
        source: 'exa',
        success: true,
        results: [
          { title: 'NEW AI Product Launch', url: 'https://a.com/1', snippet: '' },
        ],
      },
      {
        source: 'brave',
        success: true,
        results: [
          { title: 'new ai product launch', url: 'https://b.com/2', snippet: '' },
        ],
      },
    ];

    const merged = mergeSearchResults('test', results, [], 100);
    const allResults = (merged.result as any).results;
    expect(allResults).toHaveLength(1);
  });

  it('should not deduplicate different titles with same URL pattern', () => {
    const results = [
      {
        source: 'exa',
        success: true,
        results: [
          { title: 'Product A', url: 'https://example.com/a', snippet: '' },
          { title: 'Product B', url: 'https://example.com/b', snippet: '' },
        ],
      },
    ];

    const merged = mergeSearchResults('test', results, [], 100);
    const allResults = (merged.result as any).results;
    expect(allResults).toHaveLength(2);
  });

  it('should include AI summary from Perplexity', () => {
    const results = [
      {
        source: 'perplexity',
        success: true,
        answer: 'Here is a summary of AI products this week...',
        citations: ['https://example.com/1', 'https://example.com/2'],
      },
    ];

    const merged = mergeSearchResults('AI products', results, [], 100);
    expect(merged.output).toContain('AI Summary');
    expect(merged.output).toContain('Here is a summary');
    expect(merged.output).toContain('Citations');
  });

  it('should include failed source note', () => {
    const results = [
      {
        source: 'exa',
        success: true,
        results: [{ title: 'A', url: 'https://a.com', snippet: '' }],
      },
    ];
    const failed = ['brave: HTTP 429'];

    const merged = mergeSearchResults('test', results, failed, 100);
    expect(merged.output).toContain('Some sources failed');
    expect(merged.output).toContain('brave: HTTP 429');
  });

  it('should include query and source in header', () => {
    const results = [
      {
        source: 'exa',
        success: true,
        results: [{ title: 'A', url: 'https://a.com', snippet: '' }],
      },
    ];

    const merged = mergeSearchResults('my search query', results, [], 1234);
    expect(merged.output).toContain('my search query');
    expect(merged.output).toContain('exa');
  });

  it('should include age in result output', () => {
    const results = [
      {
        source: 'exa',
        success: true,
        results: [
          { title: 'Product A', url: 'https://a.com', snippet: '', age: '2 days ago' },
        ],
      },
    ];

    const merged = mergeSearchResults('test', results, [], 100);
    expect(merged.output).toContain('2 days ago');
  });

  it('should return sources array in result', () => {
    const results = [
      { source: 'exa', success: true, results: [{ title: 'A', url: 'https://a.com', snippet: '' }] },
      { source: 'brave', success: true, results: [{ title: 'B', url: 'https://b.com', snippet: '' }] },
    ];

    const merged = mergeSearchResults('test', results, [], 100);
    expect((merged.result as any).sources).toEqual(['exa', 'brave']);
  });
});

// ============================================================================
// deduplicateResults
// ============================================================================

// ============================================================================
// normalizeTitleForDedup
// ============================================================================

describe('normalizeTitleForDedup', () => {
  it('should lowercase and trim', () => {
    expect(normalizeTitleForDedup('  Hello World  ')).toBe('hello world');
  });

  it('should collapse multiple whitespace', () => {
    expect(normalizeTitleForDedup('Hello   World   Test')).toBe('hello world test');
  });

  it('should truncate to 60 chars', () => {
    const long = 'A'.repeat(100);
    expect(normalizeTitleForDedup(long)).toHaveLength(60);
  });

  it('should produce same result for syndicated titles with different endings', () => {
    const title1 = 'FlashLabs Launches FlashAI 2.0: Enterprise Voice AI Platform for Human-Level AI Voice Agents and Real-Time Call Center Automation';
    const title2 = 'FlashLabs Launches FlashAI 2.0: Enterprise Voice AI Platform for Human-Level AI Voice Agents and Real-Time Call Center Automation - PR Newswire';
    // First 60 chars are identical
    expect(normalizeTitleForDedup(title1)).toBe(normalizeTitleForDedup(title2));
  });

  it('should return empty for empty input', () => {
    expect(normalizeTitleForDedup('')).toBe('');
  });
});

// ============================================================================
// deduplicateResults
// ============================================================================

describe('deduplicateResults', () => {
  it('should remove URL duplicates', () => {
    const result = {
      success: true,
      output: '',
      result: {
        results: [
          { title: 'A', url: 'https://example.com/1', snippet: '' },
          { title: 'B', url: 'https://example.com/1', snippet: '' },
          { title: 'C', url: 'https://example.com/2', snippet: '' },
        ],
      },
    };

    deduplicateResults(result);
    expect((result.result as any).results).toHaveLength(2);
    expect((result.result as any).results[0].title).toBe('A');
    expect((result.result as any).results[1].title).toBe('C');
  });

  it('should remove title duplicates from different URLs (FlashAI case)', () => {
    const result = {
      success: true,
      output: '',
      result: {
        results: [
          {
            title: 'FlashLabs Launches FlashAI 2.0: Enterprise Voice AI Platform',
            url: 'https://aijourn.com/flashlabs',
            snippet: '',
          },
          {
            title: 'FlashLabs Launches FlashAI 2.0: Enterprise Voice AI Platform',
            url: 'https://prnewswire.com/flashlabs',
            snippet: '',
          },
        ],
      },
    };

    deduplicateResults(result);
    expect((result.result as any).results).toHaveLength(1);
    expect((result.result as any).results[0].url).toContain('aijourn'); // first wins
  });

  it('should be case-insensitive for title matching', () => {
    const result = {
      success: true,
      output: '',
      result: {
        results: [
          { title: 'NEW Product Launch', url: 'https://a.com', snippet: '' },
          { title: 'new product launch', url: 'https://b.com', snippet: '' },
        ],
      },
    };

    deduplicateResults(result);
    expect((result.result as any).results).toHaveLength(1);
  });

  it('should not remove results with different titles and URLs', () => {
    const result = {
      success: true,
      output: '',
      result: {
        results: [
          { title: 'Product A', url: 'https://a.com', snippet: '' },
          { title: 'Product B', url: 'https://b.com', snippet: '' },
          { title: 'Product C', url: 'https://c.com', snippet: '' },
        ],
      },
    };

    deduplicateResults(result);
    expect((result.result as any).results).toHaveLength(3);
  });

  it('should handle empty results gracefully', () => {
    const result = { success: true, output: '', result: { results: [] } };
    deduplicateResults(result);
    expect((result.result as any).results).toHaveLength(0);
  });

  it('should handle undefined results gracefully', () => {
    const result = { success: true, output: '' };
    // Should not throw
    expect(() => deduplicateResults(result)).not.toThrow();
  });

  it('should deduplicate syndicated titles with different suffixes', () => {
    const result = {
      success: true,
      output: '',
      result: {
        results: [
          {
            title: 'FlashLabs Launches FlashAI 2.0: Enterprise Voice AI Platform for Human-Level AI Voice Agents and Real-Time Call Center Automation',
            url: 'https://aijourn.com/flashlabs',
            snippet: '',
          },
          {
            title: 'FlashLabs Launches FlashAI 2.0: Enterprise Voice AI Platform for Human-Level AI Voice Agents and Real-Time Call Center Automation - PR Newswire',
            url: 'https://prnewswire.com/flashlabs',
            snippet: '',
          },
        ],
      },
    };

    deduplicateResults(result);
    expect((result.result as any).results).toHaveLength(1);
  });

  it('should keep items with empty titles (no false dedup)', () => {
    const result = {
      success: true,
      output: '',
      result: {
        results: [
          { title: '', url: 'https://a.com', snippet: '' },
          { title: '', url: 'https://b.com', snippet: '' },
        ],
      },
    };

    deduplicateResults(result);
    // Empty titles should not be added to seenTitles set
    expect((result.result as any).results).toHaveLength(2);
  });
});
