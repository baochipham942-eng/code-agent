import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import {
  Client,
  InMemoryResponseCacheStore,
  SdkError,
  SdkErrorCode,
  SdkHttpError,
  SSEClientTransport,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import type { ListChangedHandlers, OAuthClientProvider, Transport } from '@modelcontextprotocol/client';

// ============================================================================
// MCP Transport - 传输层创建和连接管理
// 支持 Stdio / SSE / HTTP Streamable 三种外部传输协议
// ============================================================================
import { fetch as undiciFetch, ProxyAgent } from 'undici';
import { createLogger } from '../services/infra/logger';
import { sanitizeEnv } from '../utils/sanitizeEnv';
import { MCP_TIMEOUTS } from '../../shared/constants';
import type {
  MCPServerConfig,
  MCPStdioServerConfig,
} from './types';
import { isStdioConfig, isSSEConfig, isHttpStreamableConfig } from './types';

const logger = createLogger('MCPTransport');
export const MCP_TASKS_EXTENSION_ID = 'io.modelcontextprotocol/tasks';
/**
 * Thirty seconds removes repeated registry round trips during reconnect/startup bursts without
 * hiding server changes for minutes when notifications are unavailable. A shorter value gives
 * little protection from the ~1.6s registry path; a longer value increases stale-list exposure.
 */
export const MCP_RESPONSE_CACHE_DEFAULT_TTL_MS = 30_000;
const sharedMcpResponseCacheStore = new InMemoryResponseCacheStore();

// Connection timeout constants (configured in shared/constants.ts)
export const SSE_CONNECT_TIMEOUT = MCP_TIMEOUTS.SSE_CONNECT;
export const STDIO_CONNECT_TIMEOUT = MCP_TIMEOUTS.STDIO_CONNECT;
export const STDIO_FIRST_RUN_TIMEOUT = MCP_TIMEOUTS.FIRST_RUN;
export const REMOTE_MCP_CONNECT_MAX_ATTEMPTS = 2;
export const REMOTE_MCP_CONNECT_RETRY_DELAY_MS = 400;
const mcpProxyAgents = new Map<string, ProxyAgent>();
const RETRYABLE_SDK_ERROR_CODES = new Set<string>([
  SdkErrorCode.NotConnected,
  SdkErrorCode.RequestTimeout,
  SdkErrorCode.ConnectionClosed,
  SdkErrorCode.SendFailed,
  SdkErrorCode.EraNegotiationFailed,
]);
const RETRYABLE_SYSTEM_ERROR_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EPIPE',
]);

function errorRecord(error: unknown): Record<string, unknown> | undefined {
  return error && typeof error === 'object' ? error as Record<string, unknown> : undefined;
}

function findSystemErrorCode(error: unknown): string | undefined {
  let current = errorRecord(error);
  const visited = new Set<object>();
  while (current && !visited.has(current)) {
    visited.add(current);
    if (typeof current.code === 'string' && RETRYABLE_SYSTEM_ERROR_CODES.has(current.code)) {
      return current.code;
    }
    current = errorRecord(current.cause);
  }
  return undefined;
}

function sdkErrorCode(error: unknown): string | undefined {
  const code = errorRecord(error)?.code;
  return typeof code === 'string' ? code : undefined;
}

function retryableHttpStatus(error: unknown): boolean {
  const status = SdkHttpError.isInstance(error)
    ? error.status
    : errorRecord(error)?.status;
  return typeof status === 'number'
    && (status === 408 || status === 429 || status >= 500);
}

function headersWithoutAuthorization(headers: Record<string, string>): Record<string, string> | undefined {
  const sanitized = Object.fromEntries(
    Object.entries(headers).filter(([key]) => key.toLowerCase() !== 'authorization'),
  );
  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

function noProxyMatches(target: URL, rawNoProxy: string | undefined): boolean {
  if (!rawNoProxy) return false;
  const hostname = target.hostname.toLowerCase();
  const hostWithPort = target.port ? `${hostname}:${target.port}` : hostname;
  return rawNoProxy.split(',').map((entry) => entry.trim().toLowerCase()).filter(Boolean).some((entry) => {
    if (entry === '*') return true;
    if (entry === hostWithPort || entry === hostname) return true;
    const domain = entry.startsWith('.') ? entry.slice(1) : entry;
    return hostname.endsWith(`.${domain}`);
  });
}

export function resolveMCPProxyUrl(
  target: URL,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (['localhost', '127.0.0.1', '::1'].includes(target.hostname.toLowerCase())) return undefined;
  const noProxy = env.NO_PROXY || env.no_proxy;
  if (noProxyMatches(target, noProxy)) return undefined;
  return target.protocol === 'https:'
    ? env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy
    : env.HTTP_PROXY || env.http_proxy || env.HTTPS_PROXY || env.https_proxy;
}

function createRemoteMCPFetch(target: URL): typeof globalThis.fetch | undefined {
  const proxyUrl = resolveMCPProxyUrl(target);
  if (!proxyUrl) return undefined;
  let agent = mcpProxyAgents.get(proxyUrl);
  if (!agent) {
    agent = new ProxyAgent(proxyUrl);
    mcpProxyAgents.set(proxyUrl, agent);
  }
  return ((input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) =>
    undiciFetch(input as Parameters<typeof undiciFetch>[0], {
      ...init,
      dispatcher: agent,
    } as Parameters<typeof undiciFetch>[1]) as unknown as Promise<Response>) as typeof globalThis.fetch;
}

export function isRetryableRemoteMCPConnectionError(error: unknown): boolean {
  return RETRYABLE_SDK_ERROR_CODES.has(sdkErrorCode(error) ?? '')
    || retryableHttpStatus(error)
    || findSystemErrorCode(error) !== undefined;
}

export function isMcpToolConnectionInterruptionError(error: unknown): boolean {
  const code = errorRecord(error)?.code;
  return isRetryableRemoteMCPConnectionError(error) || code === -32001;
}

export async function retryTransientRemoteMCPConnection<T>(
  attempt: (attemptNumber: number) => Promise<T>,
  options: {
    maxAttempts?: number;
    retryDelayMs?: number;
    onRetry?: (error: unknown, nextAttempt: number) => void;
    signal?: AbortSignal;
  } = {},
): Promise<T> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? REMOTE_MCP_CONNECT_MAX_ATTEMPTS);
  const retryDelayMs = Math.max(0, options.retryDelayMs ?? REMOTE_MCP_CONNECT_RETRY_DELAY_MS);

  for (let attemptNumber = 1; attemptNumber <= maxAttempts; attemptNumber += 1) {
    options.signal?.throwIfAborted();
    try {
      return await attempt(attemptNumber);
    } catch (error) {
      options.signal?.throwIfAborted();
      if (attemptNumber >= maxAttempts || !isRetryableRemoteMCPConnectionError(error)) {
        throw error;
      }
      options.onRetry?.(error, attemptNumber + 1);
      if (retryDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      }
    }
  }

  throw new Error('Remote MCP connection retry exhausted unexpectedly');
}

export const MCP_STDIO_ENV_ALLOWLIST = [
  'ALL_PROXY',
  'APPDATA',
  'COMSPEC',
  'ComSpec',
  'HOME',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'LOCALAPPDATA',
  'LOGNAME',
  'NODE_EXTRA_CA_CERTS',
  'NO_PROXY',
  'NPM_CONFIG_CACHE',
  'NPM_CONFIG_PREFIX',
  'NPM_CONFIG_REGISTRY',
  'PATH',
  'Path',
  'ProgramData',
  'REQUESTS_CA_BUNDLE',
  'SHELL',
  'SSL_CERT_DIR',
  'SSL_CERT_FILE',
  'SYSTEMROOT',
  'SystemRoot',
  'TEMP',
  'TERM',
  'TMP',
  'TMPDIR',
  'USER',
  'USERNAME',
  'USERPROFILE',
  'WINDIR',
  'XDG_CACHE_HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'all_proxy',
  'https_proxy',
  'http_proxy',
  'no_proxy',
  'npm_config_cache',
  'npm_config_prefix',
  'npm_config_registry',
] as const;

export function createStdioMCPEnv(
  extra?: Record<string, string | undefined>,
  sourceEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const allowed: Record<string, string | undefined> = {};

  for (const key of MCP_STDIO_ENV_ALLOWLIST) {
    allowed[key] = sourceEnv[key];
  }

  const combined = {
    ...allowed,
    ...extra,
  };
  const noProxyHosts = combined.MCP_NO_PROXY_HOSTS;
  delete combined.MCP_NO_PROXY_HOSTS;

  // 为 chinaDirect 类 server 提供通用的 stdio 子进程代理绕过机制。
  if (noProxyHosts) {
    const seen = new Set<string>();
    const mergedNoProxy = [combined.NO_PROXY, combined.no_proxy, noProxyHosts]
      .flatMap((value) => value?.split(',') ?? [])
      .map((value) => value.trim())
      .filter((value) => {
        if (!value) return false;
        const normalized = value.toLowerCase();
        if (seen.has(normalized)) return false;
        seen.add(normalized);
        return true;
      })
      .join(',');

    combined.NO_PROXY = mergedNoProxy;
    if (combined.no_proxy !== undefined) {
      combined.no_proxy = mergedNoProxy;
    }
  }

  return sanitizeEnv(combined);
}

/**
 * 根据配置类型创建传输层和连接超时
 */
export function createTransport(
  config: MCPServerConfig,
  options: { useProxy?: boolean; authProvider?: OAuthClientProvider } = {},
): { transport: Transport; connectTimeout: number } {
  if (isHttpStreamableConfig(config)) {
    logger.info(`Using HTTP Streamable transport for ${config.name}: ${config.serverUrl}`);

    const url = new URL(config.serverUrl);
    const requestInit: RequestInit = {};
    const proxyFetch = options.useProxy ? createRemoteMCPFetch(url) : undefined;

    if (config.headers) {
      const headers = options.authProvider
        ? headersWithoutAuthorization(config.headers)
        : config.headers;
      if (headers) {
        requestInit.headers = headers;
      }
    }

    const transport = new StreamableHTTPClientTransport(url, {
      requestInit,
      ...(proxyFetch ? { fetch: proxyFetch } : {}),
      ...(options.authProvider ? { authProvider: options.authProvider } : {}),
    });
    return { transport, connectTimeout: SSE_CONNECT_TIMEOUT };
  } else if (isSSEConfig(config)) {
    logger.info(`Using SSE transport for ${config.name}: ${config.serverUrl}`);

    const url = new URL(config.serverUrl);
    const requestInit: RequestInit = {};
    const eventSourceInit: EventSourceInit = {};
    const proxyFetch = options.useProxy ? createRemoteMCPFetch(url) : undefined;

    if (config.headers) {
      requestInit.headers = config.headers;
    }

    const transport = new SSEClientTransport(url, {
      ...(config.headers ? { requestInit } : {}),
      eventSourceInit,
      ...(proxyFetch ? { fetch: proxyFetch } : {}),
    });
    return { transport, connectTimeout: SSE_CONNECT_TIMEOUT };
  } else {
    // Stdio 本地服务器 (默认)
    const stdioConfig = config as MCPStdioServerConfig;
    logger.info(`Using Stdio transport for ${config.name}: ${stdioConfig.command} ${(stdioConfig.args || []).join(' ')}`);

    const transport = new StdioClientTransport({
      command: stdioConfig.command,
      args: stdioConfig.args || [],
      env: createStdioMCPEnv(stdioConfig.env),
    });

    // 首次连接使用更长超时（npx 可能需要下载包）
    const isNpxCommand = stdioConfig.command === 'npx' ||
      stdioConfig.command.endsWith('/npx') ||
      (stdioConfig.args || []).some(arg => arg.includes('npx'));

    const connectTimeout = isNpxCommand
      ? STDIO_FIRST_RUN_TIMEOUT
      : STDIO_CONNECT_TIMEOUT;

    logger.debug(`Stdio connection timeout: ${connectTimeout}ms (npx: ${isNpxCommand})`);
    return { transport, connectTimeout };
  }
}

/**
 * 创建 MCP SDK Client 实例
 * 声明 form elicitation 能力，使 MCP 服务器可以请求用户输入
 *
 * @param listChangedHandlers 可选的 listChanged 通知处理器。SDK 仅在 server 声明
 *   对应 listChanged capability 时激活；autoRefresh 默认 true，会自动重新拉取列表
 *   并通过 onChanged(error, items) 回调最新结果。
 */
export function createMCPSDKClient(listChangedHandlers?: ListChangedHandlers): Client {
  return new Client(
    {
      name: 'code-agent',
      version: '0.1.0',
    },
    {
      versionNegotiation: { mode: 'auto' },
      capabilities: {
        elicitation: {
          form: {},
        },
        extensions: {
          [MCP_TASKS_EXTENSION_ID]: {},
        },
      },
      responseCacheStore: sharedMcpResponseCacheStore,
      // Neo is a single-user desktop process, so the SDK's default '' partition is the safe
      // single-tenant posture. Do not bind this cache to OAuth subjects without multi-user hosting.
      defaultCacheTtlMs: MCP_RESPONSE_CACHE_DEFAULT_TTL_MS,
      ...(listChangedHandlers ? { listChanged: listChangedHandlers } : {}),
    }
  );
}

/**
 * 使用超时机制连接 client 到 transport
 */
export async function connectWithTimeout(
  client: Client,
  transport: Transport,
  config: MCPServerConfig,
  connectTimeout: number,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let isSettled = false;
    const cleanup = () => {
      clearTimeout(timeoutId);
      signal?.removeEventListener('abort', handleAbort);
    };
    const handleAbort = () => {
      if (isSettled) return;
      isSettled = true;
      cleanup();
      void transport.close().catch(() => {});
      reject(signal?.reason instanceof Error
        ? signal.reason
        : new DOMException('MCP connection cancelled', 'AbortError'));
    };

    const timeoutId = setTimeout(() => {
      if (!isSettled) {
        isSettled = true;
        cleanup();
        // 超时时尝试关闭 transport，防止资源泄漏
        transport.close().catch(() => {
          // 忽略关闭错误
        });

        // 生成更有帮助的错误消息
        let errorMsg = `Connection to ${config.name} timed out after ${Math.round(connectTimeout / 1000)}s.`;
        if (isStdioConfig(config)) {
          const stdioConfig = config as MCPStdioServerConfig;
          if (stdioConfig.command === 'npx') {
            const packageName = stdioConfig.args?.find(arg => arg.startsWith('@') || !arg.startsWith('-')) || 'package';
            errorMsg += ` This may be due to slow network or package download issues. `;
            errorMsg += `Try running 'npx -y ${packageName}' manually to pre-download the package.`;
          }
        }
        reject(new SdkError(
          SdkErrorCode.RequestTimeout,
          errorMsg,
          { serverName: config.name, timeoutMs: connectTimeout },
        ));
      }
    }, connectTimeout);

    if (signal?.aborted) {
      handleAbort();
      return;
    }
    signal?.addEventListener('abort', handleAbort, { once: true });

    client.connect(transport)
      .then(() => {
        if (!isSettled) {
          isSettled = true;
          cleanup();
          resolve();
        }
      })
      .catch((err) => {
        if (!isSettled) {
          isSettled = true;
          cleanup();
          reject(err);
        }
      });
  });
}
