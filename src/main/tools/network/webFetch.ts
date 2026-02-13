// ============================================================================
// Web Fetch Tool - Fetch content from URLs
// ============================================================================

import type { Tool, ToolContext, ToolExecutionResult } from '../toolRegistry';

export const webFetchTool: Tool = {
  name: 'web_fetch',
  description: `Fetch a single URL and extract information from its content.

Use for: reading a specific webpage, calling an API endpoint, extracting data from a known URL.

For searching the web (when you don't have a specific URL), use web_search instead.`,
  generations: ['gen4', 'gen5', 'gen6', 'gen7', 'gen8'],
  requiresPermission: true,
  permissionLevel: 'network',
  inputSchema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'The URL to fetch content from',
      },
      prompt: {
        type: 'string',
        description: 'What information to extract from the page',
      },
    },
    required: ['url', 'prompt'],
  },

  async execute(
    params: Record<string, unknown>,
    _context: ToolContext
  ): Promise<ToolExecutionResult> {
    const url = params.url as string;
    const prompt = params.prompt as string;

    // Validate URL
    try {
      new URL(url);
    } catch {
      return {
        success: false,
        error: `Invalid URL: ${url}`,
      };
    }

    try {
      // Fetch the page
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; CodeAgent/1.0)',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
        redirect: 'follow',
      });

      if (!response.ok) {
        return {
          success: false,
          error: `HTTP error: ${response.status} ${response.statusText}`,
        };
      }

      const contentType = response.headers.get('content-type') || '';
      let content: string;

      if (contentType.includes('application/json')) {
        const json = await response.json();
        content = JSON.stringify(json, null, 2);
      } else {
        content = await response.text();
        // Basic HTML to text conversion (very simple)
        content = htmlToText(content);
      }

      // Truncate if too long
      if (content.length > 50000) {
        content = content.substring(0, 50000) + '\n\n... (content truncated)';
      }

      return {
        success: true,
        output: `Fetched content from: ${url}\n` +
          `Prompt: ${prompt}\n\n` +
          `Content:\n${content}`,
      };
    } catch (error: any) {
      return {
        success: false,
        error: `Failed to fetch URL: ${error.message}`,
      };
    }
  },
};

// Simple HTML to text conversion
function htmlToText(html: string): string {
  return html
    // Remove script and style tags
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    // Replace common block elements with newlines
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    // Remove all remaining tags
    .replace(/<[^>]+>/g, '')
    // Decode HTML entities
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    // Clean up whitespace
    .replace(/\n\s*\n/g, '\n\n')
    .trim();
}
