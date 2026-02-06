// ============================================================================
// CitationExtractor Tests [E1]
// ============================================================================

import { describe, it, expect } from 'vitest';
import { extractCitations } from '../../../src/main/services/citation/citationExtractor';

describe('CitationExtractor', () => {
  // --------------------------------------------------------------------------
  // read_file
  // --------------------------------------------------------------------------
  describe('read_file', () => {
    it('should extract file citation', () => {
      const citations = extractCitations(
        'read_file',
        'tc-1',
        { file_path: 'src/app.ts' },
        'const x = 1;'
      );
      expect(citations).toHaveLength(1);
      expect(citations[0].type).toBe('file');
      expect(citations[0].source).toBe('src/app.ts');
    });

    it('should include offset as location', () => {
      const citations = extractCitations(
        'read_file',
        'tc-1',
        { file_path: 'src/app.ts', offset: 10, limit: 20 },
        'const x = 1;'
      );
      expect(citations).toHaveLength(1);
      expect(citations[0].location).toContain('10');
    });
  });

  // --------------------------------------------------------------------------
  // grep
  // --------------------------------------------------------------------------
  describe('grep', () => {
    it('should extract file references from grep output', () => {
      const output = `src/app.ts:10:const x = 1;
src/main.ts:5:import { x } from './app';`;
      const citations = extractCitations('grep', 'tc-1', { pattern: 'x' }, output);
      expect(citations.length).toBeGreaterThanOrEqual(2);
      expect(citations.some(c => c.source === 'src/app.ts')).toBe(true);
      expect(citations.some(c => c.source === 'src/main.ts')).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // glob
  // --------------------------------------------------------------------------
  describe('glob', () => {
    it('should extract file paths', () => {
      const output = `src/app.ts
src/main.ts
src/utils.ts`;
      const citations = extractCitations('glob', 'tc-1', { pattern: '**/*.ts' }, output);
      expect(citations).toHaveLength(3);
      expect(citations.every(c => c.type === 'file')).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // web_fetch
  // --------------------------------------------------------------------------
  describe('web_fetch', () => {
    it('should extract URL citation', () => {
      const citations = extractCitations(
        'web_fetch',
        'tc-1',
        { url: 'https://example.com/api' },
        'Response body...'
      );
      expect(citations).toHaveLength(1);
      expect(citations[0].type).toBe('url');
      expect(citations[0].source).toBe('https://example.com/api');
    });
  });

  // --------------------------------------------------------------------------
  // web_search
  // --------------------------------------------------------------------------
  describe('web_search', () => {
    it('should extract URLs from search results', () => {
      const output = `1. Example - https://example.com
2. Test - https://test.com/page`;
      const citations = extractCitations(
        'web_search',
        'tc-1',
        { query: 'test' },
        output
      );
      expect(citations.length).toBeGreaterThanOrEqual(2);
      expect(citations.every(c => c.type === 'url')).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // read_xlsx
  // --------------------------------------------------------------------------
  describe('read_xlsx', () => {
    it('should extract document citation', () => {
      const citations = extractCitations(
        'read_xlsx',
        'tc-1',
        { file_path: 'data/report.xlsx' },
        'Sheet1 data...'
      );
      expect(citations).toHaveLength(1);
      expect(citations[0].type).toBe('cell');
      expect(citations[0].source).toBe('data/report.xlsx');
    });
  });

  // --------------------------------------------------------------------------
  // Unknown tool
  // --------------------------------------------------------------------------
  describe('Unknown tool', () => {
    it('should return empty array for unknown tools', () => {
      const citations = extractCitations('unknown_tool', 'tc-1', {}, 'output');
      expect(citations).toHaveLength(0);
    });
  });

  // --------------------------------------------------------------------------
  // ID uniqueness
  // --------------------------------------------------------------------------
  describe('ID', () => {
    it('should generate unique IDs', () => {
      const c1 = extractCitations('read_file', 'tc-1', { file_path: 'a.ts' }, 'content1');
      const c2 = extractCitations('read_file', 'tc-2', { file_path: 'a.ts' }, 'content2');
      expect(c1).toHaveLength(1);
      expect(c2).toHaveLength(1);
      expect(c1[0].id).not.toBe(c2[0].id);
    });
  });
});
