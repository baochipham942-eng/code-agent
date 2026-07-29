import {
  SdkErrorCode,
  SdkHttpError,
  UnauthorizedError,
} from '@modelcontextprotocol/client';

export const MCP_TOOL_DELIVERY_UNKNOWN_CODE = 'MCP_TOOL_DELIVERY_UNKNOWN' as const;
export const OAUTH_AUTHORIZATION_REQUIRED_ERROR_PREFIX = 'oauth-authorization-required';

export function isOAuthAuthorizationRequiredError(error: unknown): boolean {
  if (UnauthorizedError.isInstance(error)) return true;
  if (SdkHttpError.isInstance(error)) {
    return error.code === SdkErrorCode.ClientHttpAuthentication || error.status === 401;
  }
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: unknown; status?: unknown };
  return candidate.code === SdkErrorCode.ClientHttpAuthentication || candidate.status === 401;
}

export function formatMcpConnectionError(error: unknown): string {
  if (isOAuthAuthorizationRequiredError(error)) {
    const message = error instanceof Error ? error.message : 'authorization required';
    return `${OAUTH_AUTHORIZATION_REQUIRED_ERROR_PREFIX}: ${message}`;
  }
  return error instanceof Error ? error.message : 'Unknown error';
}

/** The connection failed after dispatch, so the server may already have executed the tool. */
export class MCPToolDeliveryUnknownError extends Error {
  readonly code = MCP_TOOL_DELIVERY_UNKNOWN_CODE;
  readonly deliveryStatus = 'unknown' as const;
  readonly serverName: string;
  readonly toolName: string;
  readonly originalError: unknown;

  constructor(serverName: string, toolName: string, originalError: unknown) {
    super(
      `MCP connection interrupted during ${serverName}/${toolName}; `
      + 'the tool may already have executed, so it was not replayed automatically',
    );
    this.name = 'MCPToolDeliveryUnknownError';
    this.serverName = serverName;
    this.toolName = toolName;
    this.originalError = originalError;
  }
}
