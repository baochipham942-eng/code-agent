// ============================================================================
// MCP Rate Limit — 429 Retry-After 遵守（N-CONNECTOR-POLISH-AUDIT-FU2）
// ============================================================================
// 覆盖：头解析表（delta-seconds / HTTP-date / retry-after-ms）、延迟计算（照等/封顶/
// ±25% 抖动）、可中止等待、tools/call 重试包装（不 reconnect）、MCPClient 集成
// （429→等待→同 client 重打成功、超上限出路文案、预算耗尽回落既有分类）、
// 连接阶段共用延迟函数、以及「重试成功不进断路器失败账」的簿记钉子。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  callMcpToolWithRateLimitRetry,
  computeMcpRateLimitDelayMs,
  noteMcpRateLimitedResponse,
  sleepMcpRateLimit,
  takeMcpRetryAfterMs,
} from '../../../src/host/mcp/mcpRateLimit';
import { retryTransientRemoteMCPConnection } from '../../../src/host/mcp/mcpTransport';
import { MCPClient } from '../../../src/host/mcp/mcpClient';
import { MCPToolRegistry } from '../../../src/host/mcp/mcpToolRegistry';
import { MCP_TIMEOUTS } from '../../../src/shared/constants';
import { handleToolResultBookkeeping } from '../../../src/host/agent/runtime/toolResultLifecycle';
import { ArtifactState } from '../../../src/host/agent/runtime/artifactState';
import { ControlState } from '../../../src/host/agent/runtime/controlState';
import { setProtocolToolRegistryPort } from '../../../src/host/tools/protocolToolRegistration';
import { resetCitationService } from '../../../src/host/services/citation/citationService';
import { resetInputSanitizer } from '../../../src/host/security/inputSanitizer';
import { SdkError, SdkErrorCode } from '@modelcontextprotocol/client';
import type { AgentEvent, ToolCall } from '../../../src/shared/contract';
import type { ContextAssembly } from '../../../src/host/agent/runtime/contextAssembly';
import type { RuntimeContext } from '../../../src/host/agent/runtime/runtimeContext';
import type { RuntimeControlPort } from '../../../src/host/agent/runtime/runtimeControl';
import type { ToolExecutionResult } from '../../../src/host/tools/types';

/** SDK 对 Streamable HTTP POST 非 2xx 抛的 SdkHttpError 形状（无响应头，status 是唯一线索）。 */
function rateLimitError(): Error & { status: number } {
  return Object.assign(new Error('Error POSTing to endpoint: rate limited, retry later'), { status: 429 });
}

/** 便捷：构造一个 429 Response 并记录到 serverName。 */
async function note429(serverName: string, headers: Record<string, string>): Promise<void> {
  await noteMcpRateLimitedResponse(serverName, Promise.resolve(new Response('rate limited', {
    status: 429,
    headers,
  })));
}

describe('mcpRateLimit Retry-After header parsing', () => {
  it.each([
    ['delta-seconds 2', { 'retry-after': '2' }, 2000],
    ['fractional seconds', { 'retry-after': '0.5' }, 500],
    ['large seconds pass through raw (cap applies later)', { 'retry-after': '120' }, 120_000],
    ['retry-after-ms wins over retry-after', { 'retry-after-ms': '250', 'retry-after': '5' }, 250],
    ['no headers -> null', {}, null],
    ['garbage header -> null', { 'retry-after': 'not-a-number-or-date' }, null],
    ['HTTP-date in the past -> null', { 'retry-after': new Date(Date.now() - 60_000).toUTCString() }, null],
  ])('%s', async (_label, headers, expected) => {
    await note429('parse', headers);
    expect(takeMcpRetryAfterMs('parse')).toBe(expected);
  });

  it('HTTP-date in the future parses to the remaining delta', async () => {
    // HTTP-date 只有秒分辨率：+3s 的时刻被截到整秒，剩余 delta 落在 (2s, 3s]。
    await note429('parse-date', { 'retry-after': new Date(Date.now() + 3000).toUTCString() });
    const hint = takeMcpRetryAfterMs('parse-date');
    expect(hint).not.toBeNull();
    expect(hint as number).toBeGreaterThan(2000);
    expect(hint as number).toBeLessThanOrEqual(3000);
  });

  it('a non-429 response records nothing', async () => {
    await noteMcpRateLimitedResponse('parse-200', Promise.resolve(new Response('ok', { status: 200 })));
    expect(takeMcpRetryAfterMs('parse-200')).toBeUndefined();
  });

  it('taking the hint consumes it (one-shot per 429 response)', async () => {
    await note429('parse-once', { 'retry-after': '1' });
    expect(takeMcpRetryAfterMs('parse-once')).toBe(1000);
    expect(takeMcpRetryAfterMs('parse-once')).toBeUndefined();
  });

  it('a 429 without the header is recorded as null (seen, no hint)', async () => {
    await note429('parse-null', {});
    expect(takeMcpRetryAfterMs('parse-null')).toBeNull();
  });
});

describe('mcpRateLimit delay computation', () => {
  it('honours a server hint exactly, without jitter', () => {
    expect(computeMcpRateLimitDelayMs({ retryAfterMs: 2000 })).toBe(2000);
    expect(computeMcpRateLimitDelayMs({ retryAfterMs: 250 })).toBe(250);
  });

  it('clamps the hint at the honour cap', () => {
    expect(computeMcpRateLimitDelayMs({ retryAfterMs: 120_000 })).toBe(MCP_TIMEOUTS.RATE_LIMIT_RETRY_AFTER_CAP);
  });

  it('without a hint uses 400ms exponential backoff with ±25% jitter', () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const base = MCP_TIMEOUTS.RATE_LIMIT_RETRY_BASE * 2 ** attempt;
      for (let i = 0; i < 200; i += 1) {
        const delay = computeMcpRateLimitDelayMs({ attempt });
        expect(delay).toBeGreaterThanOrEqual(Math.floor(base * 0.75));
        expect(delay).toBeLessThanOrEqual(Math.ceil(base * 1.25));
      }
    }
  });
});

describe('mcpRateLimit abortable sleep', () => {
  it('resolves after the delay', async () => {
    const startedAt = Date.now();
    await sleepMcpRateLimit(30);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(25);
  });

  it('rejects immediately on an already-aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(sleepMcpRateLimit(30, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('an abort during the wait cancels it before the timer fires', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 60);
    const startedAt = Date.now();
    await expect(sleepMcpRateLimit(2000, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(Date.now() - startedAt).toBeLessThan(1000);
  });
});

describe('callMcpToolWithRateLimitRetry', () => {
  it('server asks for 2s: waits at least 2s, then retries on the same caller and succeeds', async () => {
    await note429('wait-2s', { 'retry-after': '2' });
    const attempts: number[] = [];
    const startedAt = Date.now();
    const result = await callMcpToolWithRateLimitRetry('wait-2s', async () => {
      attempts.push(Date.now());
      if (attempts.length === 1) throw rateLimitError();
      return 'ok-after-retry' as const;
    });
    expect(result).toBe('ok-after-retry');
    expect(attempts).toHaveLength(2);
    expect(attempts[1] - attempts[0]).toBeGreaterThanOrEqual(2000);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(2000);
  });

  it('429 without a header backs off exponentially instead of hammering', async () => {
    await note429('no-hint', {});
    const attempts: number[] = [];
    await callMcpToolWithRateLimitRetry('no-hint', async () => {
      attempts.push(Date.now());
      if (attempts.length === 1) throw rateLimitError();
      return 'ok';
    });
    expect(attempts).toHaveLength(2);
    const waited = attempts[1] - attempts[0];
    expect(waited).toBeGreaterThanOrEqual(MCP_TIMEOUTS.RATE_LIMIT_RETRY_BASE * 0.75 - 5);
    expect(waited).toBeLessThanOrEqual(MCP_TIMEOUTS.RATE_LIMIT_RETRY_BASE * 1.25 + 500);
  });

  it('hint over the cap defers instead of sleeping, with wait seconds attached', async () => {
    await note429('over-cap', { 'retry-after': '61' });
    const calls: number[] = [];
    const startedAt = Date.now();
    await expect(callMcpToolWithRateLimitRetry('over-cap', async () => {
      calls.push(Date.now());
      throw rateLimitError();
    })).rejects.toMatchObject({
      code: 'MCP_RATE_LIMIT_DEFERRED',
      serverName: 'over-cap',
      waitMs: 61_000,
    });
    expect(calls).toHaveLength(1);
    expect(Date.now() - startedAt).toBeLessThan(1000);
  });

  it('non-429 errors are rethrown untouched without a retry', async () => {
    const call = vi.fn().mockRejectedValueOnce(new SdkError(SdkErrorCode.ConnectionClosed, 'connection closed'));
    await expect(callMcpToolWithRateLimitRetry('passthrough', call)).rejects.toMatchObject({
      code: SdkErrorCode.ConnectionClosed,
    });
    expect(call).toHaveBeenCalledOnce();
  });

  it('aborting during the wait cancels the retry loop', async () => {
    await note429('abort-wait', { 'retry-after': '2' });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 60);
    const startedAt = Date.now();
    await expect(callMcpToolWithRateLimitRetry('abort-wait', async () => {
      throw rateLimitError();
    }, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(Date.now() - startedAt).toBeLessThan(1000);
  });

  it('exhausts the bounded retry budget then rethrows the original error', async () => {
    await note429('exhaust', { 'retry-after': '0.01' });
    const call = vi.fn().mockImplementation(async () => { throw rateLimitError(); });
    await expect(callMcpToolWithRateLimitRetry('exhaust', call)).rejects.toMatchObject({ status: 429 });
    expect(call).toHaveBeenCalledTimes(1 + MCP_TIMEOUTS.RATE_LIMIT_MAX_RETRIES);
  });
});

// ----------------------------------------------------------------------------
// MCPClient 集成：真 callToolInternal 路径（registry/client 内部结构与 replay 测试同法）
// ----------------------------------------------------------------------------

function setupRateLimitedClient(serverName: string, hintHeaders: Record<string, string>) {
  const mcpClient = new MCPClient();
  const registry = (mcpClient as unknown as { registry: MCPToolRegistry }).registry;
  const clients = (mcpClient as unknown as { clients: Map<string, unknown> }).clients;
  clients.set(serverName, {});
  registry.tools.push({
    name: 'probe',
    description: 'test tool',
    inputSchema: { type: 'object' },
    serverName,
  });

  const externalCalls: number[] = [];
  const retrySpy = vi.fn();
  const reconnectSpy = vi.spyOn(mcpClient, 'reconnect').mockResolvedValue({ success: true });
  const callExternal = vi.fn().mockImplementation(async () => {
    externalCalls.push(Date.now());
    if (externalCalls.length === 1) {
      await note429(serverName, hintHeaders);
      throw rateLimitError();
    }
    retrySpy();
    return { toolCallId: 'call-1', success: true, output: 'ok-after-retry' };
  });
  vi.spyOn(registry, 'callExternalTool').mockImplementation(callExternal);
  return { mcpClient, externalCalls, retrySpy, reconnectSpy };
}

describe('MCPClient.callTool on HTTP 429', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetCitationService();
    resetInputSanitizer();
  });

  it('waits the server-declared delay, retries on the same client, and never reconnects', async () => {
    const { mcpClient, externalCalls, reconnectSpy } = setupRateLimitedClient('rate-a', { 'retry-after': '0.05' });
    const startedAt = Date.now();
    const result = await mcpClient.callTool('call-1', 'rate-a', 'probe', {});
    expect(result.success).toBe(true);
    expect((result as { output?: string }).output).toBe('ok-after-retry');
    expect(externalCalls).toHaveLength(2);
    expect(externalCalls[1] - externalCalls[0]).toBeGreaterThanOrEqual(45);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(45);
    expect(reconnectSpy).not.toHaveBeenCalled();
  });

  it('a retry that succeeds after the wait is not counted as a circuit-breaker failure', async () => {
    const { mcpClient } = setupRateLimitedClient('rate-breaker', { 'retry-after': '0.05' });
    const result = await mcpClient.callTool('call-1', 'rate-breaker', 'probe', {});
    expect(result.success).toBe(true);

    // 把 429→等待→重试成功拿到的真实 ToolResult 喂给真实的工具结果簿记：
    // 走 recordSuccess，不走 recordFailure，也就没有 CIRCUIT_BREAKER_TRIPPED 事件。
    const events: AgentEvent[] = [];
    const recordFailure = vi.fn().mockReturnValue(false);
    const recordSuccess = vi.fn();
    const ctx = {
      sessionId: 'session-rate-limit',
      artifact: ArtifactState.forTest(),
      control: ControlState.forTest(),
      needsReinference: false,
      onEvent: (event: AgentEvent) => events.push(event),
      circuitBreaker: {
        recordFailure,
        recordSuccess,
        generateWarningMessage: () => '',
        generateUserErrorMessage: () => '',
      },
      goalTracker: { recordAction: () => undefined },
      nudgeManager: { recordVerification: () => undefined },
      antiPatternDetector: {
        trackToolFailure: () => undefined,
        clearToolFailure: () => undefined,
        trackDuplicateCall: () => undefined,
        trackSuccessfulWrite: () => undefined,
      },
    } as unknown as RuntimeContext;
    const contextAssembly = {
      injectSystemMessage: () => undefined,
      pushPersistentSystemContext: () => undefined,
    } as unknown as ContextAssembly;
    const runtimeControl = {
      setPlanMode: () => undefined,
      isPlanMode: () => false,
      generateAutoContinuationPrompt: () => '',
    } satisfies RuntimeControlPort;
    const toolCall: ToolCall = { id: 'call-1', name: 'mcp__rate-breaker__probe', arguments: {} };
    const normalizedResult: ToolExecutionResult = { success: result.success, output: (result as { output?: string }).output ?? '' };

    await handleToolResultBookkeeping({ ctx, contextAssembly, runtimeControl, toolCall, normalizedResult, toolResult: result });

    expect(recordSuccess).toHaveBeenCalled();
    expect(recordFailure).not.toHaveBeenCalled();
    expect(events.some((event) => (event.data as { code?: string } | undefined)?.code === 'CIRCUIT_BREAKER_TRIPPED')).toBe(false);
  });

  it('an over-cap Retry-After returns the wait-seconds exit sentence without sleeping', async () => {
    const { mcpClient, reconnectSpy } = setupRateLimitedClient('rate-over', { 'retry-after': '61' });
    const startedAt = Date.now();
    const result = await mcpClient.callTool('call-1', 'rate-over', 'probe', {});
    expect(result.success).toBe(false);
    expect((result as { error?: string }).error).toContain('mcp-rate-limit-deferred');
    expect((result as { error?: string }).error).toContain('61s');
    expect((result as { error?: string }).error).toContain('Do not retry automatically');
    expect(Date.now() - startedAt).toBeLessThan(1000);
    expect(reconnectSpy).not.toHaveBeenCalled();
  });

  it('a persistent 429 falls back to the existing connection-interruption classification', async () => {
    const mcpClient = new MCPClient();
    const registry = (mcpClient as unknown as { registry: MCPToolRegistry }).registry;
    (mcpClient as unknown as { clients: Map<string, unknown> }).clients.set('rate-stuck', {});
    registry.tools.push({
      name: 'probe',
      description: 'test tool',
      inputSchema: { type: 'object' },
      serverName: 'rate-stuck',
    });
    const callExternal = vi.fn().mockImplementation(async () => {
      await note429('rate-stuck', { 'retry-after': '0.01' });
      throw rateLimitError();
    });
    vi.spyOn(registry, 'callExternalTool').mockImplementation(callExternal);
    const reconnectSpy = vi.spyOn(mcpClient, 'reconnect').mockResolvedValue({ success: true });

    await expect(mcpClient.callTool('call-1', 'rate-stuck', 'probe', {}))
      .rejects.toMatchObject({ code: 'MCP_TOOL_DELIVERY_UNKNOWN' });
    expect(callExternal).toHaveBeenCalledTimes(1 + MCP_TIMEOUTS.RATE_LIMIT_MAX_RETRIES);
    expect(reconnectSpy).toHaveBeenCalledOnce();
  });
});

// ----------------------------------------------------------------------------
// 连接阶段：retryTransientRemoteMCPConnection 对 429 走同一套延迟
// ----------------------------------------------------------------------------

describe('retryTransientRemoteMCPConnection 429 delay', () => {
  it('waits the hinted Retry-After instead of the fixed 400ms', async () => {
    await note429('connect-429', { 'retry-after': '0.08' });
    let attempts = 0;
    const startedAt = Date.now();
    await retryTransientRemoteMCPConnection(async () => {
      attempts += 1;
      if (attempts === 1) throw rateLimitError();
      return 'connected';
    }, { serverName: 'connect-429', retryDelayMs: 5 });
    expect(attempts).toBe(2);
    const elapsed = Date.now() - startedAt;
    expect(elapsed).toBeGreaterThanOrEqual(75);
    expect(elapsed).toBeLessThan(4000);
  });

  it('a 429 without the header uses the shared exponential backoff', async () => {
    await note429('connect-429-nohint', {});
    let attempts = 0;
    const startedAt = Date.now();
    await retryTransientRemoteMCPConnection(async () => {
      attempts += 1;
      if (attempts === 1) throw rateLimitError();
      return 'connected';
    }, { serverName: 'connect-429-nohint', retryDelayMs: 5 });
    expect(attempts).toBe(2);
    const elapsed = Date.now() - startedAt;
    expect(elapsed).toBeGreaterThanOrEqual(MCP_TIMEOUTS.RATE_LIMIT_RETRY_BASE * 0.75 - 10);
    expect(elapsed).toBeLessThan(MCP_TIMEOUTS.RATE_LIMIT_RETRY_BASE * 1.25 + 1000);
  });

  it('non-429 transient failures keep the configured fixed delay', async () => {
    let attempts = 0;
    const startedAt = Date.now();
    await retryTransientRemoteMCPConnection(async () => {
      attempts += 1;
      if (attempts === 1) throw new SdkError(SdkErrorCode.ConnectionClosed, 'connection closed');
      return 'connected';
    }, { retryDelayMs: 40 });
    expect(attempts).toBe(2);
    const elapsed = Date.now() - startedAt;
    expect(elapsed).toBeGreaterThanOrEqual(35);
    expect(elapsed).toBeLessThan(300);
  });
});
