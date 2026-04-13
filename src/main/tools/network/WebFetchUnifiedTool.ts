// ============================================================================
// WebFetch Unified Tool - Consolidates web_fetch + http_request into 1
// Phase 2: Tool Schema Consolidation (Group 6: 2->1)
// ============================================================================

import type { Tool, ToolContext, ToolExecutionResult } from '../types';
import { webFetchTool } from './webFetch';
import { executeHttpRequest } from '../migrated/network/httpRequest';
import type {
  ToolContext as ProtocolToolContext,
  ToolResult as ProtocolToolResult,
} from '../../protocol/tools';

// http_request 已迁移为 native ToolModule。WebFetchUnifiedTool 仍是 legacy Tool，
// 需要最小 shim 桥接新签名。
async function invokeHttpRequestNative(
  params: Record<string, unknown>,
  legacyCtx: ToolContext,
): Promise<ToolExecutionResult> {
  const protocolCtx: ProtocolToolContext = {
    sessionId: 'webfetch-unified-delegate',
    workingDir: legacyCtx.workingDirectory,
    abortSignal: new AbortController().signal,
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    emit: () => {},
  };
  const result: ProtocolToolResult<string> = await executeHttpRequest(
    params,
    protocolCtx,
    async () => ({ allow: true }),
  );
  if (result.ok) {
    return { success: true, output: result.output, metadata: result.meta };
  }
  return { success: false, error: result.error, metadata: result.meta };
}

export const WebFetchUnifiedTool: Tool = {
  name: 'WebFetch',
  description: `Unified web request tool combining smart page fetching and raw HTTP API calls.

Actions:
- fetch: Fetch a URL and extract information using AI-powered content extraction.
  Best for reading web pages, documentation, articles. Includes caching and smart truncation.
  (requires url, prompt; optional max_chars)

- request: Make raw HTTP requests to APIs with full control over method, headers, and body.
  Best for calling REST APIs, webhooks, or any HTTP endpoint where you need the raw response.
  (requires url; optional method, headers, body, timeout)

IMPORTANT: Both actions WILL FAIL for authenticated/private URLs (Google Docs, Confluence, etc.).
For GitHub URLs, prefer bash with gh CLI.

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
    required: ['action'],
  },

  requiresPermission: true,
  permissionLevel: 'network',

  async execute(
    params: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolExecutionResult> {
    const action = params.action as string;

    switch (action) {
      case 'fetch':
        return webFetchTool.execute(params, context);

      case 'request':
        return invokeHttpRequestNative(params, context);

      default:
        return {
          success: false,
          error: `Unknown action: ${action}. Valid actions: fetch, request`,
        };
    }
  },
};
