// ============================================================================
// DocumentParser Tests [E5]
// ============================================================================

import { describe, it, expect, beforeEach } from 'vitest';
import {
  DocumentContextService,
  getDocumentContextService,
  resetDocumentContextService,
} from '../../../src/main/context/documentContext/documentContextService';
import { CodeParser } from '../../../src/main/context/documentContext/parsers/codeParser';
import { MarkdownParser } from '../../../src/main/context/documentContext/parsers/markdownParser';
import { PdfParser } from '../../../src/main/context/documentContext/parsers/pdfParser';
import { ParsedDocumentImpl, estimateTokenCount } from '../../../src/main/context/documentContext/parsedDocumentImpl';

// --------------------------------------------------------------------------
// ParsedDocumentImpl
// --------------------------------------------------------------------------
describe('ParsedDocumentImpl', () => {
  it('should calculate totalTokens from sections', () => {
    const doc = new ParsedDocumentImpl('code', 'test.ts', [
      { id: 's1', title: 'A', content: 'hello world', type: 'paragraph', importance: 0.8, tokenEstimate: 3 },
      { id: 's2', title: 'B', content: 'foo bar baz', type: 'paragraph', importance: 0.5, tokenEstimate: 3 },
    ]);
    expect(doc.totalTokens).toBe(6);
  });

  it('getTopSections should respect token budget', () => {
    const doc = new ParsedDocumentImpl('code', 'test.ts', [
      { id: 's1', title: 'Important', content: 'x'.repeat(400), type: 'code', importance: 0.9, tokenEstimate: 100 },
      { id: 's2', title: 'Less', content: 'y'.repeat(400), type: 'paragraph', importance: 0.3, tokenEstimate: 100 },
      { id: 's3', title: 'Medium', content: 'z'.repeat(400), type: 'paragraph', importance: 0.6, tokenEstimate: 100 },
    ]);

    // 只够 150 tokens - 应该选高 importance 的
    const top = doc.getTopSections(150);
    expect(top.length).toBeLessThanOrEqual(2);
    // 高 importance 的应该先被选
    expect(top[0].id).toBe('s1');
  });

  it('toCompressedString should produce output within budget', () => {
    const doc = new ParsedDocumentImpl('code', 'test.ts', [
      { id: 's1', title: 'A', content: 'x'.repeat(1000), type: 'code', importance: 0.9, tokenEstimate: 250 },
      { id: 's2', title: 'B', content: 'y'.repeat(1000), type: 'paragraph', importance: 0.3, tokenEstimate: 250 },
    ]);

    const compressed = doc.toCompressedString(300);
    const tokens = estimateTokenCount(compressed);
    expect(tokens).toBeLessThanOrEqual(350); // 允许小误差
  });
});

// --------------------------------------------------------------------------
// estimateTokenCount
// --------------------------------------------------------------------------
describe('estimateTokenCount', () => {
  it('should estimate ~4 chars per token', () => {
    const text = 'x'.repeat(100);
    const estimate = estimateTokenCount(text);
    expect(estimate).toBeGreaterThan(20);
    expect(estimate).toBeLessThan(30);
  });

  it('should handle empty string', () => {
    expect(estimateTokenCount('')).toBe(0);
  });
});

// --------------------------------------------------------------------------
// CodeParser
// --------------------------------------------------------------------------
describe('CodeParser', () => {
  const parser = new CodeParser();

  it('should parse .ts files', () => {
    expect(parser.canParse('src/app.ts')).toBe(true);
    expect(parser.canParse('src/app.tsx')).toBe(true);
  });

  it('should not parse non-code files', () => {
    expect(parser.canParse('doc.pdf')).toBe(false);
    expect(parser.canParse('data.xlsx')).toBe(false);
  });

  it('should extract functions and classes', async () => {
    const code = `
import { foo } from 'bar';

export class MyService {
  constructor() {}
  doWork(): void {
    console.log('work');
  }
}

export function helper() {
  return 42;
}
`;
    const doc = await parser.parse(code, 'src/service.ts');
    expect(doc.sections.length).toBeGreaterThan(0);
    expect(doc.type).toBe('code');
  });

  it('should assign higher importance to exports', async () => {
    const code = `
export function publicFn() { return 1; }
function privateFn() { return 2; }
`;
    const doc = await parser.parse(code, 'src/mod.ts');
    const publicSection = doc.sections.find(s => s.content.includes('publicFn'));
    const privateSection = doc.sections.find(s => s.content.includes('privateFn'));

    if (publicSection && privateSection) {
      expect(publicSection.importance).toBeGreaterThanOrEqual(privateSection.importance);
    }
  });
});

// --------------------------------------------------------------------------
// MarkdownParser
// --------------------------------------------------------------------------
describe('MarkdownParser', () => {
  const parser = new MarkdownParser();

  it('should parse .md files', () => {
    expect(parser.canParse('README.md')).toBe(true);
    expect(parser.canParse('notes.md')).toBe(true);
  });

  it('should split by headings', async () => {
    const md = `# Title

Introduction paragraph.

## Section A

Content A.

## Section B

Content B.
`;
    const doc = await parser.parse(md, 'doc.md');
    expect(doc.sections.length).toBeGreaterThanOrEqual(2);
    expect(doc.type).toBe('markdown');
  });

  it('should give h1 higher importance than h2', async () => {
    const md = `# Main Title

Some content.

## Sub Section

More content.
`;
    const doc = await parser.parse(md, 'doc.md');
    const h1 = doc.sections.find(s => s.title?.includes('Main Title'));
    const h2 = doc.sections.find(s => s.title?.includes('Sub Section'));
    if (h1 && h2) {
      expect(h1.importance).toBeGreaterThanOrEqual(h2.importance);
    }
  });
});

// --------------------------------------------------------------------------
// PdfParser
// --------------------------------------------------------------------------
describe('PdfParser', () => {
  const parser = new PdfParser();

  it('should parse .pdf files', () => {
    expect(parser.canParse('report.pdf')).toBe(true);
    expect(parser.canParse('doc.txt')).toBe(false);
  });

  it('should split text into paragraphs', async () => {
    const text = `First paragraph about something important.

Second paragraph with details.

Third paragraph.`;
    const doc = await parser.parse(text, 'test.pdf');
    expect(doc.sections.length).toBe(3);
    expect(doc.type).toBe('pdf');
  });

  it('should handle empty content', async () => {
    const doc = await parser.parse('', 'empty.pdf');
    expect(doc.sections).toHaveLength(0);
  });
});

// --------------------------------------------------------------------------
// DocumentContextService
// --------------------------------------------------------------------------
describe('DocumentContextService', () => {
  beforeEach(() => {
    resetDocumentContextService();
  });

  it('should lazy-initialize built-in parsers', () => {
    const service = getDocumentContextService();
    expect(service.canParse('test.ts')).toBe(true);
    expect(service.canParse('doc.md')).toBe(true);
    expect(service.canParse('file.pdf')).toBe(true);
  });

  it('should return null for unsupported files', async () => {
    const service = getDocumentContextService();
    const result = await service.parse('data', 'unknown.xyz');
    expect(result).toBeNull();
  });

  it('should parse code files', async () => {
    const service = getDocumentContextService();
    const result = await service.parse(
      'export function hello() { return "world"; }',
      'src/hello.ts'
    );
    expect(result).not.toBeNull();
    expect(result!.type).toBe('code');
  });

  it('should register custom parsers', () => {
    const service = new DocumentContextService();

    // getParserCount 会触发 ensureInitialized，注册 5 个内置解析器
    const countBefore = service.getParserCount();
    expect(countBefore).toBe(5);

    service.registerParser({
      canParse: (path: string) => path.endsWith('.custom'),
      parse: async () => new ParsedDocumentImpl('code', 'test.custom', []),
    });

    expect(service.getParserCount()).toBe(countBefore + 1);
    expect(service.canParse('test.custom')).toBe(true);
  });
});
