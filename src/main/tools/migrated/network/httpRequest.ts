// ============================================================================
// http_request (P0-6.3 Batch 8 — network: native ToolModule rewrite)
//
// Generic HTTP client with SSRF protection and response size cap.
// ============================================================================

import type {
  ToolHandler,
  ToolModule,
  ToolContext,
  CanUseToolFn,
  ToolProgressFn,
  ToolResult,
  ToolSchema,
} from '../../../protocol/tools';
import { NETWORK_TOOL_TIMEOUTS, HTTP_MAX_RESPONSE_SIZE } from '../../../../shared/constants';

// ── 安全与限制常量 ─────────────────────────────────────────────────────
const DEFAULT_TIMEOUT = NETWORK_TOOL_TIMEOUTS.HTTP_DEFAULT;
const MAX_TIMEOUT = NETWORK_TOOL_TIMEOUTS.HTTP_MAX;
const MAX_RESPONSE_SIZE = HTTP_MAX_RESPONSE_SIZE;

const VALID_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'] as const;

// SSRF 防护：内网/私网段
const BLOCKED_IP_PATTERNS = [
  /^127\./,                          // Localhost
  /^10\./,                           // Private Class A
  /^172\.(1[6-9]|2[0-9]|3[01])\./,   // Private Class B
  /^192\.168\./,                     // Private Class C
  /^169\.254\./,                     // Link-local
  /^0\./,                            // Current network
  /^::1$/,                           // IPv6 localhost
  /^fc00:/i,                         // IPv6 private
  /^fe80:/i,                         // IPv6 link-local
  /^fd[0-9a-f]{2}:/i,                // IPv6 unique local
];

// 云厂商 metadata 端点
const BLOCKED_HOSTS = [
  'localhost',
  'metadata.google.internal',
  '169.254.169.254',
  'metadata.azure.com',
  'fd00:ec2::254',
  '100.100.100.200', // Alibaba Cloud
];

const schema: ToolSchema = {
  name: 'http_request',
  description: `Make HTTP requests to external APIs.

Supports all common HTTP methods: GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS.

Security restrictions:
- Internal/private networks are blocked (SSRF protection)
- Cloud metadata services are blocked
- Maximum response size: 10MB
- Maximum timeout: 5 minutes

Parameters:
- url (required): Target URL (must be http:// or https://)
- method (optional): HTTP method, default GET
- headers (optional): Request headers as object
- body (optional): Request body string (for POST/PUT/PATCH)
- timeout (optional): Timeout in ms, default 30000, max 300000

Examples:
- GET: { "url": "https://api.example.com/data" }
- POST with JSON: { "url": "https://api.example.com/create", "method": "POST", "body": "{\\"name\\": \\"test\\"}", "headers": { "Content-Type": "application/json" } }
- With auth: { "url": "https://api.example.com/protected", "headers": { "Authorization": "Bearer token" } }`,
  inputSchema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'Target URL (http:// or https://)',
      },
      method: {
        type: 'string',
        description: 'HTTP method: GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS (default: GET)',
      },
      headers: {
        type: 'object',
        description: 'Request headers as key-value pairs',
        additionalProperties: true,
      },
      body: {
        type: 'string',
        description: 'Request body (for POST/PUT/PATCH)',
      },
      timeout: {
        type: 'number',
        description: 'Timeout in milliseconds (default: 30000, max: 300000)',
      },
    },
    required: ['url'],
  },
  category: 'network',
  permissionLevel: 'network',
  readOnly: false,
  allowInPlanMode: false,
};

function validateUrl(url: string): { valid: boolean; error?: string } {
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return {
        valid: false,
        error: `Protocol not allowed: ${parsed.protocol}. Only http:// and https:// are allowed.`,
      };
    }
    const hostname = parsed.hostname.toLowerCase();
    if (BLOCKED_HOSTS.includes(hostname)) {
      return { valid: false, error: `Access to ${hostname} is blocked (internal/metadata service)` };
    }
    for (const pattern of BLOCKED_IP_PATTERNS) {
      if (pattern.test(hostname)) {
        return { valid: false, error: `Access to internal network is blocked: ${hostname}` };
      }
    }
    return { valid: true };
  } catch {
    return { valid: false, error: `Invalid URL format: ${url}` };
  }
}

function checkContentLength(headers: Headers): { ok: boolean; warning?: string } {
  const contentLength = headers.get('content-length');
  if (contentLength) {
    const size = parseInt(contentLength, 10);
    if (size > MAX_RESPONSE_SIZE) {
      return { ok: false, warning: `Response too large: ${size} bytes (max ${MAX_RESPONSE_SIZE})` };
    }
  }
  return { ok: true };
}

export async function executeHttpRequest(
  args: Record<string, unknown>,
  ctx: ToolContext,
  canUseTool: CanUseToolFn,
  onProgress?: ToolProgressFn,
): Promise<ToolResult<string>> {
  const url = args.url;
  const rawMethod = args.method;
  const headersArg = (args.headers as Record<string, string> | undefined) || {};
  const body = args.body as string | undefined;
  const timeoutArg = args.timeout as number | undefined;

  if (typeof url !== 'string' || url.length === 0) {
    return { ok: false, error: 'url is required and must be a string', code: 'INVALID_ARGS' };
  }

  const method = (typeof rawMethod === 'string' ? rawMethod : 'GET').toUpperCase();
  if (!VALID_METHODS.includes(method as typeof VALID_METHODS[number])) {
    return {
      ok: false,
      error: `Invalid HTTP method: ${method}. Allowed: ${VALID_METHODS.join(', ')}`,
      code: 'INVALID_ARGS',
    };
  }

  const timeout = Math.min(Math.max(timeoutArg ?? DEFAULT_TIMEOUT, 1000), MAX_TIMEOUT);

  const urlValidation = validateUrl(url);
  if (!urlValidation.valid) {
    ctx.logger.warn('SSRF attempt blocked', { url, error: urlValidation.error });
    return { ok: false, error: urlValidation.error ?? 'invalid url', code: 'INVALID_ARGS' };
  }

  const permit = await canUseTool(schema.name, args);
  if (!permit.allow) {
    return { ok: false, error: `permission denied: ${permit.reason}`, code: 'PERMISSION_DENIED' };
  }
  if (ctx.abortSignal.aborted) {
    return { ok: false, error: 'aborted', code: 'ABORTED' };
  }

  onProgress?.({ stage: 'starting', detail: `http_request:${method}` });

  const startTime = Date.now();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  // 把外部 abort 也转发到 fetch controller
  const onExternalAbort = () => controller.abort();
  ctx.abortSignal.addEventListener('abort', onExternalAbort);

  try {
    const requestOptions: RequestInit = {
      method,
      headers: {
        'User-Agent': 'CodeAgent/1.0',
        ...headersArg,
      },
      signal: controller.signal,
      redirect: 'follow',
    };
    if (body && ['POST', 'PUT', 'PATCH'].includes(method)) {
      requestOptions.body = body;
    }

    ctx.logger.info('HTTP request', { url, method });
    onProgress?.({ stage: 'running', detail: `${method} ${url}` });

    const response = await fetch(url, requestOptions);

    const sizeCheck = checkContentLength(response.headers);

    const contentType = response.headers.get('content-type') || '';
    let responseBody: string;
    if (contentType.includes('application/json')) {
      try {
        const json = await response.json();
        responseBody = JSON.stringify(json, null, 2);
      } catch {
        responseBody = await response.text();
      }
    } else {
      responseBody = await response.text();
    }

    const maxOutputLength = 100000;
    if (responseBody.length > maxOutputLength) {
      responseBody = responseBody.substring(0, maxOutputLength) + '\n\n... (truncated, response too large)';
    }

    const duration = Date.now() - startTime;
    const outputParts = [
      `HTTP ${response.status} ${response.statusText}`,
      `URL: ${url}`,
      `Method: ${method}`,
      `Duration: ${duration}ms`,
    ];
    if (sizeCheck.warning) {
      outputParts.push(`Warning: ${sizeCheck.warning}`);
    }
    outputParts.push('');
    outputParts.push('--- Response Headers ---');
    const sensitiveHeaders = ['set-cookie', 'cookie', 'authorization'];
    for (const [key, value] of response.headers.entries()) {
      if (!sensitiveHeaders.includes(key.toLowerCase())) {
        outputParts.push(`${key}: ${value}`);
      }
    }
    outputParts.push('');
    outputParts.push('--- Response Body ---');
    outputParts.push(responseBody);

    onProgress?.({ stage: 'completing', percent: 100 });

    return {
      ok: response.ok,
      output: outputParts.join('\n'),
      meta: {
        status: response.status,
        statusText: response.statusText,
        duration,
        url,
        method,
        contentType,
      },
      ...(response.ok ? {} : { error: `HTTP ${response.status} ${response.statusText}` }),
    } as ToolResult<string>;
  } catch (err) {
    const duration = Date.now() - startTime;
    if (ctx.abortSignal.aborted) {
      return { ok: false, error: 'aborted', code: 'ABORTED' };
    }
    if (err instanceof Error && err.name === 'AbortError') {
      return {
        ok: false,
        error: `Request timed out after ${timeout}ms`,
        code: 'TIMEOUT',
        meta: { duration },
      };
    }
    const message = err instanceof Error ? err.message : String(err);
    ctx.logger.error('HTTP request failed', { url, method, error: message, duration });
    return {
      ok: false,
      error: `HTTP request failed: ${message}`,
      code: 'NETWORK_ERROR',
      meta: { duration },
    };
  } finally {
    clearTimeout(timeoutId);
    ctx.abortSignal.removeEventListener('abort', onExternalAbort);
  }
}

class HttpRequestHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;
  execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<string>> {
    return executeHttpRequest(args, ctx, canUseTool, onProgress);
  }
}

export const httpRequestModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new HttpRequestHandler();
  },
};
