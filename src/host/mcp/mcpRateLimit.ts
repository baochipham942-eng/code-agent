// ============================================================================
// MCP Rate Limit — 连接器 HTTP 429 的 Retry-After 遵守
// ============================================================================
// SdkHttpError 只带 {status, statusText, text}，不含响应头，所以 Retry-After 只能在
// createRemoteMCPFetch 的会话分支截获（noteMcpRateLimitedResponse），重试侧一次性取走
// （takeMcpRetryAfterMs）。等待策略：服务器给了秒数就照等（上限 60s，与模型侧一致）；
// 没给就 400ms 指数退避 ±25% 抖动。服务器要等超过上限时不阻塞调用——把等待秒数作为
// 带出路的文案返回，让模型转告用户稍后自己重试。
import { MCP_TIMEOUTS } from '../../shared/constants';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('MCPRateLimit', { lane: 'mcp' });

export const MCP_RATE_LIMIT_DEFERRED_CODE = 'MCP_RATE_LIMIT_DEFERRED' as const;

function httpStatusOf(error: unknown): number | undefined {
  const status = error && typeof error === 'object' ? (error as { status?: unknown }).status : undefined;
  return typeof status === 'number' ? status : undefined;
}

/** 会话期 429：SDK 对 Streamable HTTP POST 非 2xx 抛 SdkHttpError（status=429）。 */
export function isMcpRateLimitedError(error: unknown): boolean {
  return httpStatusOf(error) === 429;
}

/** retry-after-ms 优先（毫秒），其次 retry-after（delta-seconds 或 HTTP-date）；都没有返回 null。 */
function parseRetryAfterHeaders(headers: { get(name: string): string | null }): number | null {
  const msHeader = headers.get('retry-after-ms');
  if (msHeader !== null) {
    const ms = Number(msHeader);
    if (Number.isFinite(ms) && ms > 0) return ms;
  }
  const header = headers.get('retry-after');
  if (header !== null) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
    const dateMs = Date.parse(header);
    if (Number.isFinite(dateMs)) {
      const delta = dateMs - Date.now();
      if (delta > 0) return delta;
    }
  }
  return null;
}

/** serverName -> 最近一次 429 响应解析出的 Retry-After（null = 429 但无该头）。一次性消费。 */
const rateLimitHints = new Map<string, number | null>();

/**
 * 会话流量的 429 响应在这里截获头（SdkHttpError 不带响应头）；非 429 与 OAuth 分支不受影响。
 * serverName 未提供（本地传输）时原样透传。
 */
export function noteMcpRateLimitedResponse(
  serverName: string | undefined,
  response: Promise<Response>,
): Promise<Response> {
  if (!serverName) return response;
  return response.then((res) => {
    if (res.status === 429) {
      rateLimitHints.set(serverName, parseRetryAfterHeaders(res.headers));
    }
    return res;
  });
}

/** 取走该 server 最近一次 429 的 Retry-After：number=有头，null=429 但无头，undefined=没记到 429。 */
export function takeMcpRetryAfterMs(serverName: string): number | null | undefined {
  const hint = rateLimitHints.get(serverName);
  rateLimitHints.delete(serverName);
  return hint;
}

/**
 * 429 重试等待：有头照等（封顶 RATE_LIMIT_RETRY_AFTER_CAP，不抖动）；无头按
 * RATE_LIMIT_RETRY_BASE 指数退避 ±RATE_LIMIT_JITTER_RATIO 抖动。
 */
export function computeMcpRateLimitDelayMs(options: { retryAfterMs?: number | null; attempt?: number } = {}): number {
  const { retryAfterMs, attempt = 0 } = options;
  if (retryAfterMs != null) {
    return Math.min(Math.max(0, Math.round(retryAfterMs)), MCP_TIMEOUTS.RATE_LIMIT_RETRY_AFTER_CAP);
  }
  const exponential = MCP_TIMEOUTS.RATE_LIMIT_RETRY_BASE * 2 ** attempt;
  const jitter = MCP_TIMEOUTS.RATE_LIMIT_JITTER_RATIO;
  const jittered = exponential * (1 - jitter + Math.random() * jitter * 2);
  return Math.min(Math.round(jittered), MCP_TIMEOUTS.RATE_LIMIT_RETRY_AFTER_CAP);
}

/** 可中止的等待：signal 触发时立刻拒绝（AbortError），由调用侧换算成取消结果。 */
export function sleepMcpRateLimit(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReasonOf(signal));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReasonOf(signal));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function abortReasonOf(signal: AbortSignal | undefined): unknown {
  return signal?.reason instanceof Error
    ? signal.reason
    : new DOMException('MCP rate-limit wait aborted', 'AbortError');
}

/** 服务器要求的等待超过上限：不阻塞调用，等待秒数随错误上抛，由 mcpErrors 换成出路文案。 */
class McpRateLimitDeferredError extends Error {
  readonly code = MCP_RATE_LIMIT_DEFERRED_CODE;
  readonly serverName: string;
  readonly waitMs: number;

  constructor(serverName: string, waitMs: number) {
    super(`Server ${serverName} rate-limited the request and asked to wait ${Math.ceil(waitMs / 1000)}s`);
    this.name = 'McpRateLimitDeferredError';
    this.serverName = serverName;
    this.waitMs = waitMs;
  }
}

/**
 * tools/call 的 429 重试：在同一个 client 上等待后重打，不拆会话（不 reconnect）。
 * 429 是服务器的明确拒绝、请求并未执行，重放没有投递歧义，故不走 replaySafety 门；
 * 重试预算（RATE_LIMIT_MAX_RETRIES）耗尽后原样抛出，回到既有连接中断分类，replay 门保持原样。
 */
export async function callMcpToolWithRateLimitRetry<T>(
  serverName: string,
  call: () => Promise<T>,
  options: { signal?: AbortSignal } = {},
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await call();
    } catch (error) {
      options.signal?.throwIfAborted();
      if (attempt >= MCP_TIMEOUTS.RATE_LIMIT_MAX_RETRIES || !isMcpRateLimitedError(error)) {
        throw error;
      }
      const retryAfterMs = takeMcpRetryAfterMs(serverName);
      if (retryAfterMs != null && retryAfterMs > MCP_TIMEOUTS.RATE_LIMIT_RETRY_AFTER_CAP) {
        throw new McpRateLimitDeferredError(serverName, retryAfterMs);
      }
      const delayMs = computeMcpRateLimitDelayMs({ retryAfterMs: retryAfterMs ?? undefined, attempt });
      logger.warn(
        `MCP server ${serverName} rate-limited the call (HTTP 429); retrying on the same client in ${delayMs}ms`,
        { attempt: attempt + 1, retryAfterMs: retryAfterMs ?? null },
      );
      await sleepMcpRateLimit(delayMs, options.signal);
    }
  }
}
