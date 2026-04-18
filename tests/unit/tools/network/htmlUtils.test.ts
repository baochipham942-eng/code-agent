// ============================================================================
// HTML Utils Tests
// ============================================================================

import { describe, it, expect } from 'vitest';
import {
  smartHtmlToText,
  smartTruncate,
  buildExtractionPrompt,
  fallbackHtmlToText,
} from '../../../../src/main/tools/web/htmlUtils';

describe('HTML Utilities', () => {
  // --------------------------------------------------------------------------
  // smartHtmlToText
  // --------------------------------------------------------------------------
  describe('smartHtmlToText', () => {
    describe('noise removal', () => {
      it('should remove nav elements', () => {
        const html = '<body><nav>Menu</nav><p>Content</p></body>';
        const result = smartHtmlToText(html);
        expect(result).not.toContain('Menu');
        expect(result).toContain('Content');
      });

      it('should remove footer elements', () => {
        const html = '<body><p>Main text</p><footer>Copyright 2024</footer></body>';
        const result = smartHtmlToText(html);
        expect(result).not.toContain('Copyright');
        expect(result).toContain('Main text');
      });

      it('should remove script and style tags', () => {
        const html = '<body><script>alert("xss")</script><style>.x{}</style><p>Real content</p></body>';
        const result = smartHtmlToText(html);
        expect(result).not.toContain('alert');
        expect(result).not.toContain('.x{}');
        expect(result).toContain('Real content');
      });

      it('should remove sidebar elements', () => {
        const html = '<body><div class="sidebar">Ads</div><p>Article</p></body>';
        const result = smartHtmlToText(html);
        expect(result).not.toContain('Ads');
        expect(result).toContain('Article');
      });

      it('should remove ad elements', () => {
        const html = '<body><div class="advertisement">Buy now!</div><p>News</p></body>';
        const result = smartHtmlToText(html);
        expect(result).not.toContain('Buy now');
        expect(result).toContain('News');
      });

      it('should remove cookie notices', () => {
        const html = '<body><div class="cookie-banner">Accept cookies</div><p>Page content</p></body>';
        const result = smartHtmlToText(html);
        expect(result).not.toContain('Accept cookies');
      });
    });

    describe('content priority', () => {
      it('should prioritize main element content', () => {
        const html = `
          <body>
            <div>Header stuff</div>
            <main><p>This is the main content that matters and is important for the reader to understand</p></main>
            <div>Sidebar stuff</div>
          </body>`;
        const result = smartHtmlToText(html);
        expect(result).toContain('main content');
      });

      it('should prioritize article element', () => {
        const html = `
          <body>
            <div>Layout</div>
            <article><p>Article content that is the primary reading material for the page visitors today</p></article>
          </body>`;
        const result = smartHtmlToText(html);
        expect(result).toContain('Article content');
      });

      it('should fall back to body if no content area found', () => {
        const html = '<body><p>Just body text</p></body>';
        const result = smartHtmlToText(html);
        expect(result).toContain('Just body text');
      });
    });

    describe('semantic structure preservation', () => {
      it('should convert headings to markdown', () => {
        const html = '<body><h1>Title</h1><h2>Subtitle</h2><h3>Section</h3></body>';
        const result = smartHtmlToText(html);
        expect(result).toContain('# Title');
        expect(result).toContain('## Subtitle');
        expect(result).toContain('### Section');
      });

      it('should convert list items to markdown', () => {
        const html = '<body><ul><li>Item 1</li><li>Item 2</li></ul></body>';
        const result = smartHtmlToText(html);
        expect(result).toContain('- Item 1');
        expect(result).toContain('- Item 2');
      });

      it('should wrap code blocks in markdown fences', () => {
        const html = '<body><pre>const x = 1;</pre></body>';
        const result = smartHtmlToText(html);
        expect(result).toContain('```');
        expect(result).toContain('const x = 1;');
      });

      it('should wrap inline code in backticks', () => {
        const html = '<body><p>Use <code>npm install</code> to install</p></body>';
        const result = smartHtmlToText(html);
        expect(result).toContain('`npm install`');
      });

      it('should not double-wrap code inside pre', () => {
        const html = '<body><pre><code>function foo() {}</code></pre></body>';
        const result = smartHtmlToText(html);
        // Should have fence but not backtick-wrapped again
        expect(result).toContain('```');
        expect(result).toContain('function foo() {}');
      });

      it('should extract table data', () => {
        const html = '<body><table><tr><th>Name</th><th>Age</th></tr><tr><td>Alice</td><td>30</td></tr></table></body>';
        const result = smartHtmlToText(html);
        expect(result).toContain('Name | Age');
        expect(result).toContain('Alice | 30');
      });

      it('should convert links to markdown', () => {
        const html = '<body><a href="https://example.com">Click here</a></body>';
        const result = smartHtmlToText(html);
        expect(result).toContain('[Click here](https://example.com)');
      });

      it('should handle links without http href as plain text', () => {
        const html = '<body><a href="/page">Internal link</a></body>';
        const result = smartHtmlToText(html);
        expect(result).toContain('Internal link');
        expect(result).not.toContain('/page');
      });

      it('should handle blockquotes', () => {
        const html = '<body><blockquote>Quoted text here</blockquote></body>';
        const result = smartHtmlToText(html);
        expect(result).toContain('>');
      });
    });

    describe('baseUrl — relative link resolution', () => {
      it('should resolve relative links when baseUrl is provided', () => {
        const html = '<body><a href="/docs/api">API Docs</a></body>';
        const result = smartHtmlToText(html, 'https://example.com');
        expect(result).toContain('[API Docs](https://example.com/docs/api)');
      });

      it('should resolve relative links with path', () => {
        const html = '<body><a href="../guide">Guide</a></body>';
        const result = smartHtmlToText(html, 'https://example.com/docs/ref/');
        expect(result).toContain('[Guide](https://example.com/docs/guide)');
      });

      it('should keep absolute links unchanged with baseUrl', () => {
        const html = '<body><a href="https://other.com/page">Other</a></body>';
        const result = smartHtmlToText(html, 'https://example.com');
        expect(result).toContain('[Other](https://other.com/page)');
      });

      it('should treat relative links as plain text without baseUrl', () => {
        const html = '<body><a href="/page">Internal</a></body>';
        const result = smartHtmlToText(html);
        expect(result).toContain('Internal');
        expect(result).not.toContain('/page');
      });
    });

    describe('inline text merging', () => {
      it('should merge inline text within a paragraph', () => {
        const html = '<body><p>Hello <strong>world</strong> and <em>universe</em></p></body>';
        const result = smartHtmlToText(html);
        // Should be on one line, not split across multiple
        const lines = result.split('\n').filter(Boolean);
        const contentLine = lines.find(l => l.includes('Hello'));
        expect(contentLine).toContain('world');
        expect(contentLine).toContain('universe');
      });
    });

    describe('blockquote prefix', () => {
      it('should prefix blockquote content with >', () => {
        const html = '<body><blockquote><p>Quoted text</p></blockquote></body>';
        const result = smartHtmlToText(html);
        expect(result).toContain('> ');
        expect(result).toMatch(/>\s*Quoted text/);
      });

      it('should handle nested blockquote content', () => {
        const html = '<body><blockquote>Line one<br>Line two</blockquote></body>';
        const result = smartHtmlToText(html);
        expect(result).toContain('>');
      });
    });

    describe('li nesting', () => {
      it('should not duplicate text from nested lists', () => {
        const html = '<body><ul><li>Parent<ul><li>Child</li></ul></li></ul></body>';
        const result = smartHtmlToText(html);
        // "Parent" should appear exactly once
        const parentMatches = result.match(/Parent/g);
        expect(parentMatches?.length).toBe(1);
        expect(result).toContain('- Parent');
        expect(result).toContain('- Child');
      });
    });

    describe('edge cases', () => {
      it('should handle empty HTML', () => {
        const result = smartHtmlToText('');
        expect(result).toBe('');
      });

      it('should handle plain text (no HTML tags)', () => {
        const result = smartHtmlToText('Just plain text');
        expect(result).toContain('Just plain text');
      });

      it('should collapse excessive newlines', () => {
        const html = '<body><p>A</p><p></p><p></p><p>B</p></body>';
        const result = smartHtmlToText(html);
        expect(result).not.toMatch(/\n{3,}/);
      });
    });
  });

  // --------------------------------------------------------------------------
  // smartTruncate
  // --------------------------------------------------------------------------
  describe('smartTruncate', () => {
    it('should return text unchanged if within limit', () => {
      const text = 'Short text';
      expect(smartTruncate(text, 100)).toBe(text);
    });

    it('should truncate at paragraph boundary', () => {
      const text = 'Paragraph one.\n\nParagraph two.\n\nParagraph three.';
      const result = smartTruncate(text, 30);
      expect(result).toContain('Paragraph one.');
      expect(result).toContain('(content truncated)');
    });

    it('should fall back to newline boundary', () => {
      const text = 'Line one\nLine two\nLine three\nLine four';
      const result = smartTruncate(text, 25);
      expect(result).toContain('(content truncated)');
    });

    it('should hard cut as last resort', () => {
      const text = 'A'.repeat(100);
      const result = smartTruncate(text, 50);
      expect(result.length).toBeLessThan(100);
      expect(result).toContain('(content truncated)');
    });

    it('should handle exact limit', () => {
      const text = 'Exact';
      expect(smartTruncate(text, 5)).toBe(text);
    });
  });

  // --------------------------------------------------------------------------
  // buildExtractionPrompt
  // --------------------------------------------------------------------------
  describe('buildExtractionPrompt', () => {
    it('should include user prompt', () => {
      const result = buildExtractionPrompt('find the API docs', 'page content');
      expect(result).toContain('find the API docs');
    });

    it('should include raw content', () => {
      const result = buildExtractionPrompt('query', 'Hello World page content');
      expect(result).toContain('Hello World page content');
    });

    it('should truncate very long content at 30K chars', () => {
      const longContent = 'x'.repeat(50000);
      const result = buildExtractionPrompt('query', longContent);
      expect(result).toContain('[... remaining content truncated]');
      expect(result.length).toBeLessThan(50000);
    });

    it('should not truncate content under 30K', () => {
      const content = 'x'.repeat(1000);
      const result = buildExtractionPrompt('query', content);
      expect(result).not.toContain('[... remaining content truncated]');
    });

    it('should include maxChars instruction', () => {
      const result = buildExtractionPrompt('query', 'content', 5000);
      expect(result).toContain('5000');
    });

    it('should use default maxChars of 8000', () => {
      const result = buildExtractionPrompt('query', 'content');
      expect(result).toContain('8000');
    });
  });

  // --------------------------------------------------------------------------
  // fallbackHtmlToText
  // --------------------------------------------------------------------------
  describe('fallbackHtmlToText', () => {
    it('should remove script tags and content', () => {
      const html = 'Before<script>var x = 1;</script>After';
      expect(fallbackHtmlToText(html)).toBe('BeforeAfter');
    });

    it('should remove style tags and content', () => {
      const html = 'Before<style>.x { color: red; }</style>After';
      expect(fallbackHtmlToText(html)).toBe('BeforeAfter');
    });

    it('should convert block elements to newlines', () => {
      const html = '<p>Para 1</p><p>Para 2</p>';
      const result = fallbackHtmlToText(html);
      expect(result).toContain('Para 1');
      expect(result).toContain('Para 2');
    });

    it('should convert br to newline', () => {
      const html = 'Line 1<br>Line 2<br/>Line 3';
      const result = fallbackHtmlToText(html);
      expect(result).toContain('Line 1');
      expect(result).toContain('Line 2');
      expect(result).toContain('Line 3');
    });

    it('should strip remaining HTML tags', () => {
      const html = '<div><span class="bold">text</span></div>';
      expect(fallbackHtmlToText(html)).toContain('text');
      expect(fallbackHtmlToText(html)).not.toContain('<');
    });

    it('should decode HTML entities', () => {
      const html = '&amp; &lt; &gt; &quot; &nbsp;';
      const result = fallbackHtmlToText(html);
      expect(result).toContain('&');
      expect(result).toContain('<');
      expect(result).toContain('>');
      expect(result).toContain('"');
    });

    it('should collapse multiple blank lines', () => {
      const html = '<p>A</p><p></p><p></p><p>B</p>';
      const result = fallbackHtmlToText(html);
      expect(result).not.toMatch(/\n{3,}/);
    });

    it('should handle empty input', () => {
      expect(fallbackHtmlToText('')).toBe('');
    });
  });
});
