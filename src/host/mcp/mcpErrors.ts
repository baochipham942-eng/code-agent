import {
  InsufficientScopeError,
  METHOD_NOT_FOUND,
  ProtocolError,
  SdkErrorCode,
  SdkHttpError,
  UnauthorizedError,
} from '@modelcontextprotocol/client';

export const MCP_TOOL_DELIVERY_UNKNOWN_CODE = 'MCP_TOOL_DELIVERY_UNKNOWN' as const;
const MCP_TASK_UNAVAILABLE_CODE = 'MCP_TASK_UNAVAILABLE' as const;
const MCP_CREDENTIALS_MISSING_CODE = 'MCP_CREDENTIALS_MISSING' as const;
const OAUTH_AUTHORIZATION_REQUIRED_ERROR_PREFIX = 'oauth-authorization-required';
const INSUFFICIENT_SCOPE_ERROR_PREFIX = 'mcp-insufficient-scope';
const SERVICE_UNAVAILABLE_ERROR_PREFIX = 'mcp-service-unavailable';

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
  // 设置页 state.error 面向用户：中文短句。给模型的英文出路在 formatMcpConnectorErrorExit。
  const userFacing = formatMcpConnectorErrorForUser(error);
  if (userFacing) return userFacing;
  return error instanceof Error ? error.message : 'Unknown error';
}

// ----------------------------------------------------------------------------
// 连接器设计态错误：权限范围不足 / 服务端不可用（Muse connectors.md 借鉴）
// 两类的共同点：重试和重连都改变不了结果，错误文本必须给用户下一步出路。
// 判据保守匹配：拿不准就归 unknown，绝不把临时故障误判成设计态。
// ----------------------------------------------------------------------------

/**
 * 服务端明确声明「不支持」的 HTTP 状态：重试无意义（503 是临时过载，不在此列）。
 * 不含 404：MCP Streamable HTTP 对过期 Mcp-Session-Id 必须回 404，客户端应重建会话。
 * 连接阶段「端点不存在」的 404 只在 formatMcpConnectionError / connectPhase 出路里认。
 */
const UNAVAILABLE_HTTP_STATUSES = new Set([405, 501]);

const INSUFFICIENT_SCOPE_MESSAGE_PATTERN = new RegExp(
  [
    'insufficient[ _-]scope',
    'insufficient permissions?',
    '(?:missing|required|lacking|not granted)\\s+(?:[\\w.-]+\\s+){0,2}scope\\b',
    '\\bscope\\b[^.!?\\n]{0,80}\\b(?:required|missing|not granted|insufficient|denied)\\b',
  ].join('|'),
  'i',
);

const SERVICE_UNAVAILABLE_MESSAGE_PATTERN = new RegExp(
  [
    'method not found',
    'not available for (?:this |your )?(?:account|region|plan)',
    'not available in (?:this |your )?(?:account|region|plan)',
    '(?:method|tool|operation)\\b[^.!?\\n]{0,80}\\bnot supported by (?:this )?server',
    'no longer available',
    'not implemented',
  ].join('|'),
  'i',
);

/** 明示临时性的措辞出现时按临时故障处理，不落入 unavailable（宁可漏判不可误判）。 */
const TRANSIENT_OUTAGE_MESSAGE_PATTERN = /temporarily|try again (?:later|soon)|under maintenance|momentarily/i;

function errorMessageOf(error: unknown): string | undefined {
  return error instanceof Error && typeof error.message === 'string' ? error.message : undefined;
}

function httpStatusOf(error: unknown): number | undefined {
  if (SdkHttpError.isInstance(error)) return error.status;
  if (!error || typeof error !== 'object') return undefined;
  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' ? status : undefined;
}

function jsonRpcErrorCodeOf(error: unknown): number | undefined {
  if (ProtocolError.isInstance(error)) return error.code;
  if (!error || typeof error !== 'object') return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'number' ? code : undefined;
}

/** 只看错误对象上的 headers / data.headers 两个已知位置，不深挖。 */
function wwwAuthenticateChallengeOf(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const record = error as { headers?: unknown; data?: unknown };
  const candidates = [
    record.headers,
    record.data && typeof record.data === 'object'
      ? (record.data as { headers?: unknown }).headers
      : undefined,
  ];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
    for (const [key, value] of Object.entries(candidate as Record<string, unknown>)) {
      if (key.toLowerCase() === 'www-authenticate' && typeof value === 'string') {
        return value;
      }
    }
  }
  return undefined;
}

/** 权限范围不足：重连无用，出路是去连接器设置补授权或换账号。 */
export function isMcpInsufficientScopeError(error: unknown): boolean {
  // SDK 已把 WWW-Authenticate: insufficient_scope 挑战解析成 InsufficientScopeError（带 requiredScope）。
  if (InsufficientScopeError.isInstance(error)) return true;
  if (SdkHttpError.isInstance(error)) {
    return error.code === SdkErrorCode.ClientHttpForbidden || error.status === 403;
  }
  if (!error || typeof error !== 'object') return false;
  if (isOAuthAuthorizationRequiredError(error)) return false;
  const candidate = error as { code?: unknown; status?: unknown };
  if (candidate.code === SdkErrorCode.ClientHttpForbidden || candidate.status === 403) return true;
  const challenge = wwwAuthenticateChallengeOf(error);
  if (challenge?.toLowerCase().includes('insufficient_scope')) return true;
  const message = errorMessageOf(error);
  return message !== undefined && INSUFFICIENT_SCOPE_MESSAGE_PATTERN.test(message);
}

/** 服务端不可用/不支持：设计态，不是临时故障，重试重连都不会改变结果。 */
export function isMcpServiceUnavailableError(error: unknown): boolean {
  const status = httpStatusOf(error);
  if (status !== undefined && UNAVAILABLE_HTTP_STATUSES.has(status)) return true;
  if (jsonRpcErrorCodeOf(error) === METHOD_NOT_FOUND) return true;
  const message = errorMessageOf(error);
  if (message === undefined) return false;
  if (isOAuthAuthorizationRequiredError(error) || isMcpInsufficientScopeError(error)) return false;
  if (TRANSIENT_OUTAGE_MESSAGE_PATTERN.test(message)) return false;
  return SERVICE_UNAVAILABLE_MESSAGE_PATTERN.test(message);
}

function requiredScopeOf(error: unknown): string | undefined {
  return InsufficientScopeError.isInstance(error) && typeof error.requiredScope === 'string'
    ? error.requiredScope
    : undefined;
}

/** 连接阶段（尚无会话）的 404 才表示端点不存在；会话期 404 是过期会话，走重连。 */
function isConnectPhaseEndpointMissing(error: unknown): boolean {
  return httpStatusOf(error) === 404;
}

/** 设置页用户可见短句；模型英文指引见 formatMcpConnectorErrorExit。 */
function formatMcpConnectorErrorForUser(error: unknown): string | null {
  if (isMcpCredentialsMissingError(error)) {
    return '凭据未附上，请到设置 > 连接器重新填写后再试。';
  }
  if (isMcpInsufficientScopeError(error)) {
    return '当前账号未授予所需权限，请到设置 > 连接器补授权或换账号。';
  }
  if (isMcpServiceUnavailableError(error) || isConnectPhaseEndpointMissing(error)) {
    return '该连接器无法完成此请求，请改用服务方官网或其他方式。';
  }
  return null;
}

/**
 * 两类设计态错误的模型可见出路文案；其他错误返回 null（保持原有文本）。
 * 「失败态带出路不带解释」：每条都写明用户下一步能做什么、模型不该做什么。
 * connectPhase：连接阶段（mcp_add_server / 首次 connect）把 404 当端点不存在，不是会话过期。
 */
export function formatMcpConnectorErrorExit(
  error: unknown,
  options?: { connectPhase?: boolean },
): string | null {
  const message = errorMessageOf(error) ?? 'connector error';
  if (isMcpCredentialsMissingError(error)) {
    return [
      message,
      'Tell the user to open Settings > Connectors and re-enter the credential.',
      'This is not an authorization failure — the credential was never attached. Do not retry automatically.',
    ].join(' ');
  }
  if (isMcpInsufficientScopeError(error)) {
    const requiredScope = requiredScopeOf(error);
    return [
      `${INSUFFICIENT_SCOPE_ERROR_PREFIX}: ${message}`,
      `Reconnecting will not fix this: the connected account has not granted the permission this tool needs${requiredScope ? ` (missing scope: ${requiredScope})` : ''}.`,
      'Tell the user to open Settings > Connectors, grant the missing permission for this connector or reconnect with an account that has it, then resend the original request. Do not retry automatically.',
    ].join(' ');
  }
  if (isMcpServiceUnavailableError(error) || (options?.connectPhase && isConnectPhaseEndpointMissing(error))) {
    return [
      `${SERVICE_UNAVAILABLE_ERROR_PREFIX}: ${message}`,
      'This is a provider-side limitation, not a temporary outage — do not retry or reconnect.',
      "Tell the user this connector cannot serve the request, and offer an alternative path (for example, completing the same task on the provider's website).",
    ].join(' ');
  }
  return null;
}

/** 发出请求前凭据就绪失败（secretRef 解析失败 / 字段缺失或为空）——凭据根本没附上，别报成 401 授权失效。 */
export class MCPCredentialsMissingError extends Error {
  readonly code = MCP_CREDENTIALS_MISSING_CODE;

  constructor(message: string) {
    super(message);
    this.name = 'MCPCredentialsMissingError';
  }
}

/** 生产分流：formatMcpConnectionError / formatMcpConnectorErrorExit 按此给出用户/模型文案。 */
function isMcpCredentialsMissingError(error: unknown): boolean {
  if (error instanceof MCPCredentialsMissingError) return true;
  if (!error || typeof error !== 'object') return false;
  return (error as { code?: unknown }).code === MCP_CREDENTIALS_MISSING_CODE;
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

/** Task polling cannot safely converge, so the durable operation must remain reviewable. */
export class MCPTaskUnavailableError extends Error {
  readonly code = MCP_TASK_UNAVAILABLE_CODE;
  readonly serverIdentity: string;
  readonly taskId: string;
  readonly reason: 'unsupported' | 'timeout' | 'terminal_failure' | 'missing_result';
  readonly originalError: unknown;

  constructor(input: {
    serverIdentity: string;
    taskId: string;
    reason: MCPTaskUnavailableError['reason'];
    message: string;
    originalError?: unknown;
  }) {
    super(input.message);
    this.name = 'MCPTaskUnavailableError';
    this.serverIdentity = input.serverIdentity;
    this.taskId = input.taskId;
    this.reason = input.reason;
    this.originalError = input.originalError;
  }
}
