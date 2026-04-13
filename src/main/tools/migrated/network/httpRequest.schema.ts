// Schema-only file (P0-7 方案 A — single source of truth)
import type { ToolSchema } from '../../../protocol/tools';

export const httpRequestSchema: ToolSchema = {
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
