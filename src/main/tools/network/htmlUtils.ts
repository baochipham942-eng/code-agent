// ============================================================================
// HTML Utilities - cheerio-based HTML parsing + smart truncation + AI extraction
// Shared by webFetch (P0) and webSearch auto_extract (P2)
// ============================================================================

import * as cheerio from 'cheerio';
import type { AnyNode, Element } from 'domhandler';

// Noise selectors to remove before content extraction
const NOISE_SELECTORS = [
  'nav', 'footer', 'header', 'aside',
  '.sidebar', '.ad', '.ads', '.advertisement',
  '.cookie-notice', '.cookie-banner',
  'script', 'style', 'noscript', 'iframe',
  '[role="navigation"]', '[role="banner"]',
  '.social-share', '.comments', '.related-posts',
].join(', ');

// Content-priority selectors (tried in order)
const CONTENT_SELECTORS = [
  'main',
  'article',
  '[role="main"]',
  '.content',
  '.post-content',
  '.article-content',
  '#content',
  '.entry-content',
  '.page-content',
];

/**
 * Convert HTML to structured text using cheerio.
 * Removes noise regions, prioritizes content areas, preserves semantic structure.
 */
export function smartHtmlToText(html: string): string {
  try {
    const $ = cheerio.load(html);

    // Remove noise elements
    $(NOISE_SELECTORS).remove();

    // Try to find main content area
    let $content: cheerio.Cheerio<AnyNode> | null = null;
    for (const selector of CONTENT_SELECTORS) {
      const found = $(selector);
      if (found.length > 0 && found.text().trim().length > 100) {
        $content = found.first();
        break;
      }
    }

    // Fall back to body if no content area found
    const $root = $content || $('body');
    if (!$root.length) {
      return $.text().trim();
    }

    // Convert to structured text
    const lines: string[] = [];
    processNode($root, $, lines);

    return lines
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  } catch {
    // cheerio failed — return raw text extraction
    return fallbackHtmlToText(html);
  }
}

/**
 * Recursively process DOM nodes into structured text.
 */
function processNode(
  $el: cheerio.Cheerio<AnyNode>,
  $: cheerio.CheerioAPI,
  lines: string[]
): void {
  $el.contents().each((_, node) => {
    if (node.type === 'text') {
      const text = $(node).text().trim();
      if (text) lines.push(text);
      return;
    }

    if (node.type !== 'tag') return;

    const $node = $(node);
    const tag = node.tagName?.toLowerCase();

    // Headings → markdown
    if (/^h[1-6]$/.test(tag)) {
      const level = parseInt(tag[1]);
      const text = $node.text().trim();
      if (text) {
        lines.push('');
        lines.push('#'.repeat(level) + ' ' + text);
        lines.push('');
      }
      return;
    }

    // Lists
    if (tag === 'li') {
      const text = $node.text().trim();
      if (text) lines.push('- ' + text);
      return;
    }

    // Code blocks
    if (tag === 'pre') {
      const code = $node.text().trim();
      if (code) {
        lines.push('');
        lines.push('```');
        lines.push(code);
        lines.push('```');
        lines.push('');
      }
      return;
    }

    // Inline code
    if (tag === 'code' && node.parentNode && (node.parentNode as Element).tagName !== 'pre') {
      const text = $node.text().trim();
      if (text) lines.push('`' + text + '`');
      return;
    }

    // Block-level elements: recurse into children to preserve inline semantics
    if (['p', 'div', 'section', 'blockquote'].includes(tag)) {
      lines.push('');
      if (tag === 'blockquote') lines.push('> ');
      processNode($node, $, lines);
      lines.push('');
      return;
    }

    // Tables: simple text extraction
    if (tag === 'table') {
      lines.push('');
      $node.find('tr').each((_, tr) => {
        const cells: string[] = [];
        $(tr).find('th, td').each((__, cell) => {
          cells.push($(cell).text().trim());
        });
        if (cells.length > 0) lines.push(cells.join(' | '));
      });
      lines.push('');
      return;
    }

    // Links: preserve href
    if (tag === 'a') {
      const text = $node.text().trim();
      const href = $node.attr('href');
      if (text && href && href.startsWith('http')) {
        lines.push(`[${text}](${href})`);
      } else if (text) {
        lines.push(text);
      }
      return;
    }

    // Other elements: recurse
    processNode($node, $, lines);
  });
}

/**
 * Truncate text at paragraph boundary, avoiding mid-sentence cuts.
 */
export function smartTruncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;

  // Find last paragraph break before maxChars
  const truncated = text.substring(0, maxChars);
  const lastParagraphBreak = truncated.lastIndexOf('\n\n');

  if (lastParagraphBreak > maxChars * 0.5) {
    return truncated.substring(0, lastParagraphBreak) + '\n\n... (content truncated)';
  }

  // Fall back to last newline
  const lastNewline = truncated.lastIndexOf('\n');
  if (lastNewline > maxChars * 0.5) {
    return truncated.substring(0, lastNewline) + '\n\n... (content truncated)';
  }

  // Last resort: hard cut
  return truncated + '\n\n... (content truncated)';
}

/**
 * Build AI extraction prompt for modelCallback.
 */
export function buildExtractionPrompt(
  userPrompt: string,
  rawContent: string,
  maxChars: number = 8000
): string {
  // Truncate input to ~30K chars for model consumption (~10K tokens)
  const inputContent = rawContent.length > 30000
    ? rawContent.substring(0, 30000) + '\n\n[... remaining content truncated]'
    : rawContent;

  return `Extract the most relevant information from this web page content based on the user's request.

User's request: "${userPrompt}"

Web page content:
---
${inputContent}
---

Instructions:
- Extract ONLY information relevant to the user's request
- Preserve key facts, data, code examples, and important details
- Use markdown formatting for structure (headings, lists, code blocks)
- Keep the response under ${maxChars} characters
- If the page has no relevant content, say so briefly
- Do NOT add information that isn't in the source content`;
}

/**
 * Fallback: regex-based HTML to text (same as original webFetch implementation).
 * Used when cheerio parsing fails.
 */
export function fallbackHtmlToText(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\n\s*\n/g, '\n\n')
    .trim();
}
