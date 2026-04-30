// ============================================================================
// WebFetch Unified Tool - Consolidates web_fetch + http_request into 1
// Phase 2: Tool Schema Consolidation (Group 6: 2->1)
// ============================================================================

import type { Tool, ToolContext, ToolExecutionResult } from '../types';
import { webFetchTool } from './webFetch';
import { executeHttpRequest } from '../modules/network/httpRequest';
import { invokeNativeFromLegacy } from '../modules/_helpers/invokeNativeFromLegacy';

export const WebFetchUnifiedTool: Tool = {
  name: 'WebFetch',
  description: `Unified web request tool combining smart page fetching and raw HTTP API calls.

Use this only when you already have a specific URL. If you still need to discover URLs, call WebSearch first.

Actions:
- fetch: Fetch a URL and extract information using AI-powered content extraction.
  Best for reading web pages, documentation, articles. Includes caching and smart truncation.
  (requires url, prompt; optional max_chars)

- request: Make raw HTTP requests to APIs with full control over method, headers, and body.
  Best for calling REST APIs, webhooks, or any HTTP endpoint where you need the raw response.
  (requires url; optional method, headers, body, timeout)

IMPORTANT: Both actions WILL FAIL for authenticated/private URLs (Google Docs, Confluence, etc.).
For GitHub URLs, prefer bash with gh CLI.
Do not retry the same failing URL with the same arguments. If fetch fails because of HTTP status, auth, or crawler blocking, switch strategy or report the failure.

Examples:
- Fetch a webpage: { "action": "fetch", "url": "https://docs.example.com/guide", "prompt": "Extract the installation steps" }
- GET API call: { "action": "request", "url": "https://api.example.com/data" }
- POST with JSON: { "action": "request", "url": "https://api.example.com/create", "method": "POST", "body": "{\\"name\\": \\"test\\"}", "headers": { "Content-Type": "application/json" } }`,

  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['fetch', 'request'],
        description: 'The web action to perform: fetch (AI extraction) or request (raw HTTP)',
      },
      // --- shared ---
      url: {
        type: 'string',
        description: 'Target URL (must be fully-formed, e.g., "https://example.com")',
      },
      // --- fetch params ---
      prompt: {
        type: 'string',
        description: '[fetch] What information to extract from the page',
      },
      max_chars: {
        type: 'number',
        description: '[fetch] Maximum characters in the extracted output (default: 8000)',
      },
      // --- request params ---
      method: {
        type: 'string',
        description: '[request] HTTP method: GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS (default: GET)',
      },
      headers: {
        type: 'object',
        description: '[request] Request headers as key-value pairs',
        additionalProperties: true,
      },
      body: {
        type: 'string',
        description: '[request] Request body string (for POST/PUT/PATCH)',
      },
      timeout: {
        type: 'number',
        description: '[request] Timeout in milliseconds (default: 30000, max: 300000)',
      },
    },
    required: ['action', 'url'],
  },

  requiresPermission: true,
  permissionLevel: 'network',

  async execute(
    params: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolExecutionResult> {
    const validationError = validateWebFetchUnifiedParams(params);
    if (validationError) return validationError;

    const action = params.action as string;

    switch (action) {
      case 'fetch':
        return webFetchTool.execute(params, context);

      case 'request':
        return invokeNativeFromLegacy(executeHttpRequest, params, context, 'webfetch-unified-delegate');

      default:
        return {
          success: false,
          error: `Unknown action: ${action}. Valid actions: fetch, request`,
        };
    }
  },
};

function validateWebFetchUnifiedParams(params: Record<string, unknown>): ToolExecutionResult | null {
  const action = params.action;
  if (action !== 'fetch' && action !== 'request') {
    return {
      success: false,
      error: 'Invalid WebFetch action. Use "fetch" or "request".',
    };
  }

  if (typeof params.url !== 'string' || params.url.trim().length === 0) {
    return {
      success: false,
      error: 'WebFetch requires a non-empty url.',
    };
  }

  if (action === 'fetch' && (typeof params.prompt !== 'string' || params.prompt.trim().length === 0)) {
    return {
      success: false,
      error: 'WebFetch action "fetch" requires a non-empty prompt.',
    };
  }

  return null;
}
