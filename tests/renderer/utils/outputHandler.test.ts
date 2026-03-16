// ============================================================================
// outputHandler.test.ts - 大输出处理工具测试
// ============================================================================

import { describe, it, expect } from 'vitest';
import {
  processOutput,
  formatSize,
  searchInContent,
  highlightMatches,
} from '../../../src/renderer/utils/outputHandler';

// ============================================================================
// formatSize
// ============================================================================

describe('formatSize', () => {
  it('should format bytes', () => {
    expect(formatSize(0)).toBe('0 B');
    expect(formatSize(512)).toBe('512 B');
    expect(formatSize(1023)).toBe('1023 B');
  });

  it('should format kilobytes', () => {
    expect(formatSize(1024)).toBe('1.0 KB');
    expect(formatSize(1536)).toBe('1.5 KB');
    expect(formatSize(10240)).toBe('10.0 KB');
  });

  it('should format megabytes', () => {
    expect(formatSize(1048576)).toBe('1.0 MB');
    expect(formatSize(5242880)).toBe('5.0 MB');
  });
});

// ============================================================================
// searchInContent
// ============================================================================

describe('searchInContent', () => {
  it('should return empty array for empty keyword', () => {
    expect(searchInContent('hello world', '')).toEqual([]);
  });

  it('should find single match', () => {
    const result = searchInContent('hello world', 'world');
    expect(result).toEqual([6]);
  });

  it('should find multiple matches', () => {
    const result = searchInContent('abcabc', 'abc');
    expect(result).toEqual([0, 3]);
  });

  it('should be case-insensitive', () => {
    const result = searchInContent('Hello HELLO hello', 'hello');
    expect(result).toEqual([0, 6, 12]);
  });

  it('should return empty array when no match found', () => {
    expect(searchInContent('hello', 'xyz')).toEqual([]);
  });

  it('should handle special characters in content', () => {
    const result = searchInContent('path/to/file.ts', 'file');
    expect(result).toEqual([8]);
  });
});

// ============================================================================
// highlightMatches
// ============================================================================

describe('highlightMatches', () => {
  it('should return content unchanged for empty keyword', () => {
    expect(highlightMatches('hello', '')).toBe('hello');
  });

  it('should wrap matches with mark tag', () => {
    const result = highlightMatches('hello world', 'world');
    expect(result).toContain('<mark');
    expect(result).toContain('world');
    expect(result).toContain('</mark>');
  });

  it('should use custom highlight class', () => {
    const result = highlightMatches('hello', 'hello', 'bg-red-500');
    expect(result).toContain('bg-red-500');
  });

  it('should highlight all occurrences', () => {
    const result = highlightMatches('foo bar foo', 'foo');
    const markCount = (result.match(/<mark/g) || []).length;
    expect(markCount).toBe(2);
  });

  it('should escape regex special characters in keyword', () => {
    const result = highlightMatches('a.b.c', '.');
    // Should match literal dots, not regex wildcards treating everything as a match
    const markCount = (result.match(/<mark/g) || []).length;
    expect(markCount).toBe(2); // two dots
  });
});

// ============================================================================
// processOutput
// ============================================================================

describe('processOutput', () => {
  it('should handle string content', () => {
    const result = processOutput('hello');
    expect(result.preview).toBe('hello');
    expect(result.metadata.truncated).toBe(false);
    expect(result.isBinary).toBe(false);
    expect(result.metadata.originalSize).toBe(5);
  });

  it('should handle null content', () => {
    const result = processOutput(null);
    expect(result.preview).toBe('');
    expect(result.metadata.originalSize).toBe(0);
  });

  it('should handle undefined content', () => {
    const result = processOutput(undefined);
    expect(result.preview).toBe('');
  });

  it('should JSON-stringify object content', () => {
    const result = processOutput({ key: 'value' });
    expect(result.preview).toContain('"key"');
    expect(result.preview).toContain('"value"');
    expect(result.metadata.truncated).toBe(false);
  });

  it('should handle number content', () => {
    const result = processOutput(42);
    expect(result.preview).toBe('42');
  });

  it('should not truncate small content', () => {
    const content = 'x'.repeat(1000);
    const result = processOutput(content);
    expect(result.metadata.truncated).toBe(false);
    expect(result.preview).toBe(content);
  });

  it('should truncate content exceeding MAX_SIZE (400KB)', () => {
    const content = 'a'.repeat(500 * 1024); // 500KB
    const result = processOutput(content);
    expect(result.metadata.truncated).toBe(true);
    expect(result.preview.length).toBeLessThan(content.length);
  });

  it('should truncate content exceeding LINE_LIMIT (500 lines)', () => {
    const lines = Array.from({ length: 600 }, (_, i) => `line ${i}`);
    const content = lines.join('\n');
    const result = processOutput(content);
    expect(result.metadata.truncated).toBe(true);
    expect(result.preview).toContain('lines omitted');
  });

  it('should detect binary content', () => {
    // Create string with many non-printable characters (>10%)
    const binaryChars = String.fromCharCode(0, 1, 2, 3, 4, 5, 6, 7);
    const content = binaryChars.repeat(20);
    const result = processOutput(content);
    expect(result.isBinary).toBe(true);
    expect(result.preview).toContain('Binary content');
  });

  it('should not flag normal text as binary', () => {
    const content = 'Hello world\nLine 2\tTabbed';
    const result = processOutput(content);
    expect(result.isBinary).toBe(false);
  });

  it('should report correct line count', () => {
    const content = 'line1\nline2\nline3';
    const result = processOutput(content);
    expect(result.metadata.lineCount).toBe(3);
  });
});
