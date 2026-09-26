import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  InsufficientScopeError,
  METHOD_NOT_FOUND,
  ProtocolError,
  SdkError,
  SdkErrorCode,
  SdkHttpError,
} from '@modelcontextprotocol/client';

import {
  formatMcpConnectionError,
  formatMcpConnectorErrorExit,
  isMcpInsufficientScopeError,
  isMcpServiceUnavailableError,
  isOAuthAuthorizationRequiredError,
  MCPCredentialsMissingError,
} from '../../../src/host/mcp/mcpErrors';
import {
  isMcpToolConnectionInterruptionError,
  isRetryableRemoteMCPConnectionError,
  retryTransientRemoteMCPConnection,
} from '../../../src/host/mcp/mcpTransport';
import { resolveSecretRefs } from '../../../src/host/mcp/secretRef';
import { MCPClient } from '../../../src/host/mcp/mcpClient';
import { MCPToolRegistry } from '../../../src/host/mcp/mcpToolRegistry';

function setupFailingToolCall(rejection: Error) {
  const mcpClient = new MCPClient();
  const registry = (mcpClient as unknown as { registry: MCPToolRegistry }).registry;
  const clients = (mcpClient as unknown as { clients: Map<string, unknown> }).clients;
  clients.set('remote', {});
  registry.tools.push({
    name: 'mutate',
    description: 'test tool',
    inputSchema: { type: 'object' },
    serverName: 'remote',
    annotations: { readOnlyHint: true },
  });

  vi.spyOn(registry, 'callExternalTool').mockRejectedValue(rejection);
  const retrySpy = vi.spyOn(registry, 'retryToolCall');
  const reconnectSpy = vi.spyOn(mcpClient, 'reconnect');
  return { mcpClient, retrySpy, reconnectSpy };
}

function forbidden(status = 403): SdkHttpError {
  return new SdkHttpError(SdkErrorCode.ClientHttpForbidden, 'the server denied access', { status });
}

function unavailableStatusError(status: number): SdkHttpError {
  return new SdkHttpError(SdkErrorCode.ClientHttpUnexpectedContent, 'endpoint refused', { status });
}

describe('connector error classification（保守匹配，五种输入各归其类）', () => {
  describe('insufficient_scope', () => {
    it('classifies a structured HTTP 403', () => {
      const error = forbidden();
      expect(isMcpInsufficientScopeError(error)).toBe(true);
      expect(isMcpServiceUnavailableError(error)).toBe(false);
      expect(isOAuthAuthorizationRequiredError(error)).toBe(false);
    });

    it('classifies a bare 403 status on a plain error', () => {
      const error = Object.assign(new Error('denied'), { status: 403 });
      expect(isMcpInsufficientScopeError(error)).toBe(true);
    });

    it('classifies the SDK-parsed WWW-Authenticate insufficient_scope challenge', () => {
      const error = new InsufficientScopeError({
        requiredScope: 'calendar.events',
        errorDescription: 'The request requires higher privileges',
      });
      expect(isMcpInsufficientScopeError(error)).toBe(true);
    });

    it('classifies a raw WWW-Authenticate header carrying insufficient_scope', () => {
      const error = Object.assign(new Error('denied'), {
        headers: { 'WWW-Authenticate': 'Bearer error="insufficient_scope", scope="calendar.events"' },
      });
      expect(isMcpInsufficientScopeError(error)).toBe(true);
    });

    it('classifies a JSON-RPC error whose message names a missing scope', () => {
      const error = new ProtocolError(-32003, 'Insufficient scope: required "calendar.events"');
      expect(isMcpInsufficientScopeError(error)).toBe(true);
    });

    it('does not steal a 401 whose message mentions scope', () => {
      const error = new SdkHttpError(
        SdkErrorCode.ClientHttpAuthentication,
        'insufficient scope for this token',
        { status: 401 },
      );
      expect(isOAuthAuthorizationRequiredError(error)).toBe(true);
      expect(isMcpInsufficientScopeError(error)).toBe(false);
    });
  });

  describe('service_unavailable', () => {
    it.each([404, 405, 501])('classifies HTTP %i as a design-state refusal', (status) => {
      const error = unavailableStatusError(status);
      expect(isMcpServiceUnavailableError(error)).toBe(true);
      expect(isMcpInsufficientScopeError(error)).toBe(false);
    });

    it('classifies JSON-RPC METHOD_NOT_FOUND', () => {
      const error = new ProtocolError(METHOD_NOT_FOUND, 'Method not found: tools/call');
      expect(isMcpServiceUnavailableError(error)).toBe(true);
    });

    it('classifies an explicit region/account refusal message', () => {
      const error = new Error('This connector is not available for this account or region.');
      expect(isMcpServiceUnavailableError(error)).toBe(true);
    });

    it('does not classify a plain 503 as unavailable', () => {
      const error = unavailableStatusError(503);
      expect(isMcpServiceUnavailableError(error)).toBe(false);
    });

    it('does not classify an explicitly temporary outage message', () => {
      const error = new Error('Service temporarily unavailable, please try again later');
      expect(isMcpServiceUnavailableError(error)).toBe(false);
      expect(isMcpInsufficientScopeError(error)).toBe(false);
    });

    it('does not classify a not-supported wording that is explicitly temporary', () => {
      // 「not supported」命中设计态模式，但「temporarily/maintenance」说明是临时故障——护栏必须压过模式匹配。
      const error = new Error('This protocol is not supported temporarily during maintenance');
      expect(isMcpServiceUnavailableError(error)).toBe(false);
    });
  });

  describe('401 oauth path stays intact', () => {
    it('keeps a structured 401 out of both new classes', () => {
      const error = new SdkHttpError(SdkErrorCode.ClientHttpAuthentication, 'login required', { status: 401 });
      expect(isOAuthAuthorizationRequiredError(error)).toBe(true);
      expect(isMcpInsufficientScopeError(error)).toBe(false);
      expect(isMcpServiceUnavailableError(error)).toBe(false);
    });
  });

  describe('credentials_missing', () => {
    it('classifies the pre-send missing-credential error and keeps it away from the oauth label', () => {
      const error = new MCPCredentialsMissingError(
        'MCP credential "mcp_feishu.APP_SECRET" is empty (credentials were not attached); please re-enter it in Connectors',
      );
      expect(error).toBeInstanceOf(MCPCredentialsMissingError);
      expect(isOAuthAuthorizationRequiredError(error)).toBe(false);
      expect(isMcpInsufficientScopeError(error)).toBe(false);
      expect(isMcpServiceUnavailableError(error)).toBe(false);
      expect(formatMcpConnectionError(error)).not.toContain('oauth-authorization-required');
    });
  });

  describe('unknown errors are not misclassified', () => {
    it.each([
      ['plain failure', new Error('connection failed')],
      ['transient SDK timeout', new SdkError(SdkErrorCode.RequestTimeout, 'request timed out')],
      ['empty message', new Error('')],
      ['non-error input', 'not-an-error'],
    ])('leaves %s unclassified', (_label, error) => {
      expect(isMcpInsufficientScopeError(error)).toBe(false);
      expect(isMcpServiceUnavailableError(error)).toBe(false);
      expect(formatMcpConnectorErrorExit(error)).toBeNull();
    });
  });
});

describe('connector design-state errors never auto-retry', () => {
  it.each([
    ['HTTP 403', forbidden()],
    ['HTTP 501 not implemented', unavailableStatusError(501)],
    ['region refusal message', new Error('This connector is not available for this account or region.')],
  ])('%s triggers zero retries at connect level', async (_label, error) => {
    const attempt = vi.fn().mockRejectedValue(error);
    await expect(retryTransientRemoteMCPConnection(attempt, { retryDelayMs: 0 }))
      .rejects.toBe(error);
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(isRetryableRemoteMCPConnectionError(error)).toBe(false);
  });

  it.each([
    ['HTTP 403', forbidden()],
    ['HTTP 404', unavailableStatusError(404)],
    ['method not found', new ProtocolError(METHOD_NOT_FOUND, 'Method not found: tools/call')],
  ])('%s is not treated as a connection interruption, so the tool call is never replayed', (_label, error) => {
    expect(isMcpToolConnectionInterruptionError(error)).toBe(false);
  });

  it('keeps treating session expiry (-32001) without design-state signals as an interruption', () => {
    const error = Object.assign(new Error('session expired'), { code: -32001 });
    expect(isMcpToolConnectionInterruptionError(error)).toBe(true);
  });

  it('does not interrupt-and-replay when a 403 rides on a -32001 code', () => {
    const error = Object.assign(new Error('the server denied access'), { code: -32001, status: 403 });
    expect(isMcpToolConnectionInterruptionError(error)).toBe(false);
  });
});

describe('connector error exit text（失败态带出路）', () => {
  it('tells the model that reconnecting will not fix a scope error and where to grant it', () => {
    const text = formatMcpConnectorErrorExit(forbidden());
    expect(text).toMatch(/^mcp-insufficient-scope: /);
    expect(text).toContain('Reconnecting will not fix this');
    expect(text).toContain('Settings > Connectors');
    expect(text).toContain('Do not retry automatically');
    expect(text).toContain('the server denied access');
  });

  it('names the missing scope when the SDK parsed the WWW-Authenticate challenge', () => {
    const error = new InsufficientScopeError({ requiredScope: 'calendar.events' });
    expect(formatMcpConnectorErrorExit(error)).toContain('missing scope: calendar.events');
  });

  it('tells the model a design-state refusal is not an outage and to offer an alternative', () => {
    const text = formatMcpConnectorErrorExit(new Error('This connector is not available for this account or region.'));
    expect(text).toMatch(/^mcp-service-unavailable: /);
    expect(text).toContain('not a temporary outage');
    expect(text).toContain('do not retry or reconnect');
    expect(text).toContain('alternative path');
  });

  it('feeds the exit text into connection state formatting', () => {
    expect(formatMcpConnectionError(forbidden())).toMatch(/^mcp-insufficient-scope: /);
    expect(formatMcpConnectionError(unavailableStatusError(404))).toMatch(/^mcp-service-unavailable: /);
    expect(formatMcpConnectionError(new Error('connection failed'))).toBe('connection failed');
  });
});

describe('empty stored credentials fail closed before the request is sent', () => {
  it.each([
    ['empty string', ''],
    ['whitespace only', '   '],
  ])('treats %s as credentials not attached', (_label, stored) => {
    expect(() => resolveSecretRefs(
      { APP_SECRET: 'secureref:mcp_feishu.APP_SECRET' },
      () => ({ APP_SECRET: stored }),
    )).toThrow(MCPCredentialsMissingError);
  });

  it('reports credentials were not attached, not an authorization failure', () => {
    let caught: unknown;
    try {
      resolveSecretRefs(
        { APP_SECRET: 'secureref:mcp_feishu.APP_SECRET' },
        () => ({ APP_SECRET: '' }),
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(MCPCredentialsMissingError);
    expect((caught as Error).message).toContain('credentials were not attached');
    expect((caught as Error).message).toContain('Connectors');
  });
});

describe('tool call failures surface the exit text instead of a bare error', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the insufficient-scope exit text without reconnecting', async () => {
    const { mcpClient, retrySpy, reconnectSpy } = setupFailingToolCall(forbidden());

    const result = await mcpClient.callTool('call-1', 'remote', 'mutate', {});

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/^mcp-insufficient-scope: /);
    expect(result.error).toContain('Settings > Connectors');
    expect(reconnectSpy).not.toHaveBeenCalled();
    expect(retrySpy).not.toHaveBeenCalled();
  });

  it('returns the service-unavailable exit text without reconnecting', async () => {
    const { mcpClient, retrySpy, reconnectSpy } = setupFailingToolCall(unavailableStatusError(404));

    const result = await mcpClient.callTool('call-1', 'remote', 'mutate', {});

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/^mcp-service-unavailable: /);
    expect(result.error).toContain('do not retry or reconnect');
    expect(reconnectSpy).not.toHaveBeenCalled();
    expect(retrySpy).not.toHaveBeenCalled();
  });

  it('keeps the bare message for unclassified failures', async () => {
    const { mcpClient } = setupFailingToolCall(new Error('plain tool failure'));

    const result = await mcpClient.callTool('call-1', 'remote', 'mutate', {});

    expect(result.success).toBe(false);
    expect(result.error).toBe('plain tool failure');
  });
});
