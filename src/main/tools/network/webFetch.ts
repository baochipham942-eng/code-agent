// ============================================================================
// Web Fetch Tool - Fetch content from URLs with AI-powered extraction
// ============================================================================

import type { Tool, ToolContext, ToolExecutionResult } from '../toolRegistry';
import {
  smartHtmlToText,
  smartTruncate,
  buildExtractionPrompt,
  fallbackHtmlToText,
} from './htmlUtils';

const DEFAULT_MAX_CHARS = 8000;

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
      max_chars: {
        type: 'number',
        description: 'Maximum characters in the extracted output (default: 8000)',
      },
    },
    required: ['url', 'prompt'],
  },

  async execute(
    params: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolExecutionResult> {
    const url = params.url as string;
    const prompt = params.prompt as string;
    const maxChars = (params.max_chars as number) || DEFAULT_MAX_CHARS;

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
        // JSON: just truncate, no AI extraction needed
        if (content.length > maxChars) {
          content = smartTruncate(content, maxChars);
        }
      } else {
        const rawHtml = await response.text();

        // Step 1: cheerio HTML → structured text (fallback to regex)
        content = smartHtmlToText(rawHtml);

        // Step 2: AI extraction if modelCallback available
        if (context.modelCallback && content.length > 0) {
          try {
            const extractionPrompt = buildExtractionPrompt(prompt, content, maxChars);
            const extracted = await context.modelCallback(extractionPrompt);

            // Use AI result if substantive (> 50 chars)
            if (extracted && extracted.trim().length > 50) {
              content = extracted.trim();
            } else {
              // AI returned too little — fall back to smart truncation
              content = smartTruncate(content, maxChars);
            }
          } catch {
            // AI extraction failed — fall back to smart truncation
            content = smartTruncate(content, maxChars);
          }
        } else {
          // No modelCallback — smart truncation only
          content = smartTruncate(content, maxChars);
        }
      }

      return {
        success: true,
        output: `Fetched content from: ${url}\n` +
          `Prompt: ${prompt}\n\n` +
          `Content:\n${content}`,
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return {
        success: false,
        error: `Failed to fetch URL: ${message}`,
      };
    }
  },
};
