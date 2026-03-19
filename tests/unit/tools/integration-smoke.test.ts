// ============================================================================
// Smoke Tests — 验证 WebFetch/WebSearch/Grep 优化后的核心行为
// ============================================================================

import { describe, it, expect, vi } from 'vitest';
import { grepTool } from '../../../src/main/tools/shell/grep';
import { smartHtmlToText } from '../../../src/main/tools/network/htmlUtils';
import { fetchDocument, clearFetchCache } from '../../../src/main/tools/network/fetchDocument';
import { WEB_FETCH, GREP } from '../../../src/shared/constants';

const cwd = process.cwd();
const ctx = { workingDirectory: cwd } as any;

describe('Grep Tool — execFile + pagination', () => {
  it('should find matches using execFile (no shell)', async () => {
    const result = await grepTool.execute(
      { pattern: 'export const GREP', path: 'src/shared/constants/tools.ts' },
      ctx
    );
    expect(result.success).toBe(true);
    expect(result.output).toContain('export const GREP');
  });

  it('should apply head_limit pagination', async () => {
    const result = await grepTool.execute(
      { pattern: 'export', path: 'src/shared/constants/tools.ts', head_limit: 3 },
      ctx
    );
    expect(result.success).toBe(true);
    expect(result.output).toContain('showing 1-3 of');
  });

  it('should apply offset + head_limit', async () => {
    const result = await grepTool.execute(
      { pattern: 'export', path: 'src/shared/constants/tools.ts', head_limit: 2, offset: 2 },
      ctx
    );
    expect(result.success).toBe(true);
    expect(result.output).toContain('showing 3-4 of');
  });

  it('should handle no matches gracefully', async () => {
    const result = await grepTool.execute(
      { pattern: 'ZZZZZ_NONEXISTENT_12345', path: 'src/shared/constants/tools.ts' },
      ctx
    );
    expect(result.success).toBe(true);
    expect(result.output).toContain('No matches found');
  });

  it('should support type filter', async () => {
    const result = await grepTool.execute(
      { pattern: 'fetchDocument', path: 'src/main/tools/network', type: 'ts' },
      ctx
    );
    expect(result.success).toBe(true);
    expect(result.output).toContain('fetchDocument');
  });

  it('should handle special regex chars via execFile safely', async () => {
    // This pattern contains shell-dangerous chars — execFile should handle it safely
    const result = await grepTool.execute(
      { pattern: 'export const \\w+', path: 'src/shared/constants/tools.ts' },
      ctx
    );
    expect(result.success).toBe(true);
    expect(result.output).toContain('export const');
  });
});

describe('htmlUtils — baseUrl + inline merge + blockquote + li nesting', () => {
  it('should resolve relative links with baseUrl', () => {
    const html = '<body><p>See <a href="/docs/api">API docs</a></p></body>';
    const result = smartHtmlToText(html, 'https://example.com');
    expect(result).toContain('[API docs](https://example.com/docs/api)');
  });

  it('should merge inline text in paragraphs', () => {
    const html = '<body><p>Start <strong>bold</strong> middle <em>italic</em> end</p></body>';
    const result = smartHtmlToText(html);
    // All inline content should be on one line
    const contentLine = result.split('\n').find(l => l.includes('Start'));
    expect(contentLine).toBeDefined();
    expect(contentLine).toContain('bold');
    expect(contentLine).toContain('italic');
    expect(contentLine).toContain('end');
  });

  it('should prefix blockquote lines with >', () => {
    const html = '<body><blockquote><p>Wise words</p></blockquote></body>';
    const result = smartHtmlToText(html);
    expect(result).toMatch(/>\s*Wise words/);
  });

  it('should not duplicate nested li text', () => {
    const html = `<body><ul>
      <li>Parent item
        <ul><li>Child item</li></ul>
      </li>
    </ul></body>`;
    const result = smartHtmlToText(html);
    const parentCount = (result.match(/Parent item/g) || []).length;
    expect(parentCount).toBe(1);
    expect(result).toContain('- Child item');
  });
});

describe('Constants — WEB_FETCH + GREP additions', () => {
  it('should have WEB_FETCH constants', () => {
    expect(WEB_FETCH.TIMEOUT).toBe(30_000);
    expect(WEB_FETCH.MAX_RETRIES).toBe(1);
    expect(WEB_FETCH.RETRY_DELAY).toBe(1000);
    expect(WEB_FETCH.CACHE_TTL).toBe(900_000);
    expect(WEB_FETCH.CACHE_MAX_ENTRIES).toBe(50);
    expect(WEB_FETCH.TRUSTED_DOCS_MAX_CHARS).toBe(100_000);
    expect(WEB_FETCH.RETRYABLE_STATUS).toEqual([429, 500, 502, 503, 504]);
  });

  it('should have GREP.EAGAIN_RETRY_THREADS', () => {
    expect(GREP.EAGAIN_RETRY_THREADS).toBe(1);
  });
});

describe('fetchDocument — cache behavior', () => {
  it('should export clearFetchCache', () => {
    expect(typeof clearFetchCache).toBe('function');
    clearFetchCache(); // Should not throw
  });
});
