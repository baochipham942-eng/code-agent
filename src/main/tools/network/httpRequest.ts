// ============================================================================
// HTTP Request Tool - General-purpose HTTP API client
// Gen4: Network request capability with security controls
// ============================================================================

import type { Tool, ToolContext, ToolExecutionResult } from '../toolRegistry';
import { createLogger } from '../../services/infra/logger';
import { NETWORK_TOOL_TIMEOUTS } from '../../../shared/constants';

const logger = createLogger('HttpRequest');

// Security constants
const DEFAULT_TIMEOUT = NETWORK_TOOL_TIMEOUTS.HTTP_DEFAULT;
const MAX_TIMEOUT = NETWORK_TOOL_TIMEOUTS.HTTP_MAX;
const MAX_RESPONSE_SIZE = 10 * 1024 * 1024; // 10MB

// HTTP methods
const VALID_METHODS: string[] = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'];

// Blocked IP patterns (SSRF protection)
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

// Blocked hostnames (cloud metadata services)
const BLOCKED_HOSTS = [
  'localhost',
  'metadata.google.internal',
  '169.254.169.254',
  'metadata.azure.com',
  'fd00:ec2::254',
  '100.100.100.200', // Alibaba Cloud
];

/**
 * Validate URL for SSRF protection
 */
function validateUrl(url: string): { valid: boolean; error?: string } {
  try {
    const parsed = new URL(url);

    // Only allow http/https
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return { valid: false, error: `Protocol not allowed: ${parsed.protocol}. Only http:// and https:// are allowed.` };
    }

    // Check blocked hosts
    const hostname = parsed.hostname.toLowerCase();
    if (BLOCKED_HOSTS.includes(hostname)) {
      return { valid: false, error: `Access to ${hostname} is blocked (internal/metadata service)` };
    }

    // Check IP patterns
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

/**
 * Check content length from headers
 */
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

export const httpRequestTool: Tool = {
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

  generations: ['gen4', 'gen5', 'gen6', 'gen7', 'gen8'],
  requiresPermission: true,
  permissionLevel: 'network',

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

  async execute(
    params: Record<string, unknown>,
    _context: ToolContext
  ): Promise<ToolExecutionResult> {
    const url = params.url as string;
    const method = ((params.method as string) || 'GET').toUpperCase();
    const headers = (params.headers as Record<string, string>) || {};
    const body = params.body as string | undefined;
    const timeout = Math.min(
      Math.max((params.timeout as number) || DEFAULT_TIMEOUT, 1000),
      MAX_TIMEOUT
    );

    const startTime = Date.now();

    // Validate method
    if (!VALID_METHODS.includes(method as typeof VALID_METHODS[number])) {
      return {
        success: false,
        error: `Invalid HTTP method: ${method}. Allowed: ${VALID_METHODS.join(', ')}`,
      };
    }

    // Validate URL (SSRF protection)
    const urlValidation = validateUrl(url);
    if (!urlValidation.valid) {
      logger.warn('SSRF attempt blocked', { url, error: urlValidation.error });
      return {
        success: false,
        error: urlValidation.error,
      };
    }

    try {
      // Create AbortController for timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);

      // Build request options
      const requestOptions: RequestInit = {
        method,
        headers: {
          'User-Agent': 'CodeAgent/1.0',
          ...headers,
        },
        signal: controller.signal,
        redirect: 'follow',
      };

      // Add body for appropriate methods
      if (body && ['POST', 'PUT', 'PATCH'].includes(method)) {
        requestOptions.body = body;
      }

      // Execute request
      logger.info('HTTP request', { url, method });
      const response = await fetch(url, requestOptions);
      clearTimeout(timeoutId);

      // Check response size
      const sizeCheck = checkContentLength(response.headers);

      // Read response body
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

      // Truncate large responses
      const maxOutputLength = 100000;
      if (responseBody.length > maxOutputLength) {
        responseBody = responseBody.substring(0, maxOutputLength) + '\n\n... (truncated, response too large)';
      }

      const duration = Date.now() - startTime;

      // Build output
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

      // Filter sensitive headers
      const sensitiveHeaders = ['set-cookie', 'cookie', 'authorization'];
      for (const [key, value] of response.headers.entries()) {
        if (!sensitiveHeaders.includes(key.toLowerCase())) {
          outputParts.push(`${key}: ${value}`);
        }
      }

      outputParts.push('');
      outputParts.push('--- Response Body ---');
      outputParts.push(responseBody);

      return {
        success: response.ok,
        output: outputParts.join('\n'),
        metadata: {
          status: response.status,
          statusText: response.statusText,
          duration,
          url,
          method,
          contentType,
        },
      };
    } catch (error: unknown) {
      const duration = Date.now() - startTime;

      // Handle abort (timeout)
      if (error instanceof Error && error.name === 'AbortError') {
        return {
          success: false,
          error: `Request timed out after ${timeout}ms`,
        };
      }

      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('HTTP request failed', { url, method, error: errorMessage, duration });

      return {
        success: false,
        error: `HTTP request failed: ${errorMessage}`,
      };
    }
  },
};
