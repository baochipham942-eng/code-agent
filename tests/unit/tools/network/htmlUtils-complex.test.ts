// ============================================================================
// HTML Utils Complex Tests
// Real-world HTML structures, deeply nested content, mixed encodings,
// malformed HTML, and performance edge cases
// ============================================================================

import { describe, it, expect } from 'vitest';
import { smartHtmlToText, smartTruncate, fallbackHtmlToText } from '../../../../src/main/tools/web/htmlUtils';

describe('HTML Utils - Complex Scenarios', () => {
  // --------------------------------------------------------------------------
  // Real-world page structures
  // --------------------------------------------------------------------------
  describe('real-world page structures', () => {
    it('should extract content from a documentation page with sidebar', () => {
      const html = `
        <body>
          <nav><ul><li>Home</li><li>Docs</li><li>API</li></ul></nav>
          <aside class="sidebar"><ul><li>Section 1</li><li>Section 2</li></ul></aside>
          <main>
            <h1>API Reference</h1>
            <p>This is the main API documentation content that is very important for developers to read and understand fully.</p>
            <h2>Authentication</h2>
            <p>Use Bearer tokens for authentication.</p>
            <pre><code>Authorization: Bearer YOUR_TOKEN</code></pre>
          </main>
          <footer><p>Copyright 2024</p></footer>
        </body>`;
      const result = smartHtmlToText(html);
      expect(result).toContain('# API Reference');
      expect(result).toContain('## Authentication');
      expect(result).toContain('Bearer YOUR_TOKEN');
      expect(result).not.toContain('Copyright');
      expect(result).not.toContain('Section 1');
    });

    it('should handle blog post with social widgets', () => {
      const html = `
        <body>
          <header><h1>Blog</h1></header>
          <article>
            <h1>My Blog Post</h1>
            <p>This is a really great blog post about programming that contains useful and detailed information about software development.</p>
            <div class="social-share"><button>Share on Twitter</button><button>Share on Facebook</button></div>
            <h2>Code Example</h2>
            <pre>console.log("Hello, World!");</pre>
          </article>
          <div class="comments"><h3>Comments</h3><p>Nice post!</p></div>
          <div class="related-posts"><h3>Related</h3><ul><li>Post 1</li></ul></div>
        </body>`;
      const result = smartHtmlToText(html);
      expect(result).toContain('# My Blog Post');
      expect(result).toContain('console.log');
      expect(result).not.toContain('Share on Twitter');
      expect(result).not.toContain('Nice post!');
      expect(result).not.toContain('Related');
    });

    it('should handle data table extraction', () => {
      const html = `
        <body>
          <main>
            <h1>Sales Data</h1>
            <table>
              <thead><tr><th>Product</th><th>Price</th><th>Quantity</th></tr></thead>
              <tbody>
                <tr><td>Widget A</td><td>$10.99</td><td>100</td></tr>
                <tr><td>Widget B</td><td>$24.99</td><td>50</td></tr>
                <tr><td>Widget C</td><td>$5.49</td><td>200</td></tr>
              </tbody>
            </table>
          </main>
        </body>`;
      const result = smartHtmlToText(html);
      expect(result).toContain('Product | Price | Quantity');
      expect(result).toContain('Widget A | $10.99 | 100');
      expect(result).toContain('Widget C | $5.49 | 200');
    });
  });

  // --------------------------------------------------------------------------
  // Deeply nested structures
  // --------------------------------------------------------------------------
  describe('deeply nested structures', () => {
    it('should handle deeply nested divs', () => {
      const depth = 20;
      let html = '<body>';
      for (let i = 0; i < depth; i++) html += '<div>';
      html += '<p>Deep content here</p>';
      for (let i = 0; i < depth; i++) html += '</div>';
      html += '</body>';
      const result = smartHtmlToText(html);
      expect(result).toContain('Deep content here');
    });

    it('should handle nested lists', () => {
      const html = `
        <body>
          <ul>
            <li>Top level item
              <ul>
                <li>Nested item 1</li>
                <li>Nested item 2</li>
              </ul>
            </li>
          </ul>
        </body>`;
      const result = smartHtmlToText(html);
      expect(result).toContain('- ');
    });

    it('should handle content in role="main" selector', () => {
      const html = `
        <body>
          <div>Header stuff</div>
          <div role="main">
            <p>Main content area with enough text to pass the 100 character threshold for content detection in the smartHtmlToText function.</p>
          </div>
          <div>Footer stuff</div>
        </body>`;
      const result = smartHtmlToText(html);
      expect(result).toContain('Main content area');
    });
  });

  // --------------------------------------------------------------------------
  // Malformed HTML
  // --------------------------------------------------------------------------
  describe('malformed HTML', () => {
    it('should handle unclosed tags', () => {
      const html = '<body><p>Unclosed paragraph<p>Another unclosed</body>';
      const result = smartHtmlToText(html);
      expect(result).toContain('Unclosed paragraph');
    });

    it('should handle mismatched tags', () => {
      const html = '<body><div><p>Content</div></p></body>';
      const result = smartHtmlToText(html);
      expect(result).toContain('Content');
    });

    it('should handle HTML fragments (no body tag)', () => {
      const html = '<h1>Title</h1><p>Content</p>';
      const result = smartHtmlToText(html);
      expect(result).toContain('Title');
      expect(result).toContain('Content');
    });

    it('should handle only text content', () => {
      const result = smartHtmlToText('Just plain text, no HTML at all.');
      expect(result).toContain('Just plain text');
    });
  });

  // --------------------------------------------------------------------------
  // Mixed content types
  // --------------------------------------------------------------------------
  describe('mixed content types', () => {
    it('should handle interspersed code and prose', () => {
      const html = `
        <body>
          <article>
            <p>First, install the package by running this command in your terminal to get started with the development setup:</p>
            <pre>npm install my-package --save-dev</pre>
            <p>Then import the function you need from the package to use it in your application code:</p>
            <pre>import { myFunc } from 'my-package';</pre>
            <p>Call it like this in your code:</p>
            <code>myFunc()</code>
          </article>
        </body>`;
      const result = smartHtmlToText(html);
      expect(result).toContain('```');  // Code fences
      expect(result).toContain('npm install');
      expect(result).toContain('`myFunc()`');  // Inline code
    });

    it('should handle mixed internal and external links', () => {
      const html = `
        <body>
          <main>
            <p>See the <a href="https://docs.example.com">official documentation for the project</a> and check out the <a href="/local-page">local page</a>.</p>
          </main>
        </body>`;
      const result = smartHtmlToText(html);
      expect(result).toContain('[official documentation for the project](https://docs.example.com)');
      expect(result).toContain('local page');  // Internal link text only
    });
  });

  // --------------------------------------------------------------------------
  // smartTruncate edge cases
  // --------------------------------------------------------------------------
  describe('smartTruncate edge cases', () => {
    it('should handle text with only single newlines (no paragraph breaks)', () => {
      const text = Array.from({ length: 50 }, (_, i) => `Line ${i}`).join('\n');
      const result = smartTruncate(text, 100);
      expect(result).toContain('(content truncated)');
    });

    it('should handle paragraph break at exactly 50% boundary', () => {
      const text = 'A'.repeat(50) + '\n\n' + 'B'.repeat(50);
      const result = smartTruncate(text, 80);
      // Paragraph break at position 50 is exactly 50/80 = 62.5% > 50%
      expect(result).toContain('(content truncated)');
    });

    it('should handle single character input exceeding maxChars', () => {
      // maxChars = 0 with non-empty text
      const result = smartTruncate('Hello', 3);
      expect(result).toContain('(content truncated)');
    });

    it('should handle text with trailing whitespace', () => {
      const text = 'Content   \n\n   More content   ';
      const result = smartTruncate(text, 15);
      expect(result).toContain('(content truncated)');
    });
  });

  // --------------------------------------------------------------------------
  // fallbackHtmlToText edge cases
  // --------------------------------------------------------------------------
  describe('fallbackHtmlToText edge cases', () => {
    it('should handle nested script tags', () => {
      const html = 'Before<script>if (x < 3) { alert("xss"); }</script>After';
      const result = fallbackHtmlToText(html);
      expect(result).not.toContain('alert');
      expect(result).toContain('Before');
      expect(result).toContain('After');
    });

    it('should handle multiple HTML entity types', () => {
      const html = '5 &gt; 3 &amp;&amp; 3 &lt; 5 is &quot;true&quot;';
      const result = fallbackHtmlToText(html);
      expect(result).toContain('5 > 3 && 3 < 5');
      expect(result).toContain('"true"');
    });

    it('should handle self-closing br variants', () => {
      const html = 'Line1<br>Line2<br/>Line3<br />Line4';
      const result = fallbackHtmlToText(html);
      expect(result.split('\n').length).toBeGreaterThanOrEqual(4);
    });

    it('should handle heading-level block elements', () => {
      const html = '<h1>Title</h1><h2>Subtitle</h2><h3>Section</h3>';
      const result = fallbackHtmlToText(html);
      expect(result).toContain('Title');
      expect(result).toContain('Subtitle');
    });

    it('should handle deeply nested inline elements', () => {
      const html = '<p><strong><em><a href="#">deep <code>text</code></a></em></strong></p>';
      const result = fallbackHtmlToText(html);
      expect(result).toContain('deep');
      expect(result).toContain('text');
    });
  });

  // --------------------------------------------------------------------------
  // Performance: large inputs
  // --------------------------------------------------------------------------
  describe('performance', () => {
    it('should handle large HTML document without timeout', () => {
      const paragraphs = Array.from({ length: 500 }, (_, i) =>
        `<p>Paragraph ${i} with some content.</p>`
      ).join('\n');
      const html = `<body><main>${paragraphs}</main></body>`;

      const start = Date.now();
      const result = smartHtmlToText(html);
      const elapsed = Date.now() - start;

      expect(result).toContain('Paragraph 0');
      expect(result).toContain('Paragraph 499');
      expect(elapsed).toBeLessThan(5000); // Should finish well within 5s
    });

    it('should handle large table without timeout', () => {
      const rows = Array.from({ length: 200 }, (_, i) =>
        `<tr><td>Row ${i}</td><td>Value ${i}</td><td>${i * 100}</td></tr>`
      ).join('\n');
      const html = `<body><main><table>${rows}</table></main></body>`;

      const result = smartHtmlToText(html);
      expect(result).toContain('Row 0');
      expect(result).toContain('Row 199');
    });
  });
});
