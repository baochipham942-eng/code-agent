// Schema-only file (P0-7 方案 A — single source of truth)
// Pure type-only — does not pull legacy tool code at import time.
import type { ToolSchema } from '../../../protocol/tools';

export const webFetchSchema: ToolSchema = {
  name: 'web_fetch',
  description: `Fetch a single URL and extract information from its content.

IMPORTANT: This tool WILL FAIL for authenticated or private URLs (Google Docs, Confluence, Jira, etc.).
For GitHub URLs, prefer using bash with gh CLI (e.g., gh pr view, gh issue view, gh api).

Workflow: fetches URL → converts HTML to markdown → AI extraction based on your prompt → returns extracted content.

Use for: reading a specific webpage, calling an API endpoint, extracting data from a known URL.
For searching the web (when you don't have a specific URL), use web_search instead.

Notes:
- URL must be fully-formed (e.g., "https://example.com", not "example.com"). HTTP auto-upgrades to HTTPS.
- Results may be summarized if the content is very large.
- Includes a 15-minute cache — repeated requests to the same URL are fast.
- Cross-domain redirects are reported; you may need to re-fetch the redirect URL.
- This tool is read-only and does not modify any files.`,
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
  category: 'network',
  permissionLevel: 'network',
  readOnly: true,
  allowInPlanMode: true,
};
