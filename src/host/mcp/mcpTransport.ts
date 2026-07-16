// ============================================================================
// MCP Transport - 传输层创建和连接管理
// 支持 Stdio / SSE / HTTP Streamable 三种外部传输协议
// ============================================================================

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { ListChangedHandlers } from '@modelcontextprotocol/sdk/types.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
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

// Connection timeout constants (configured in shared/constants.ts)
export const SSE_CONNECT_TIMEOUT = MCP_TIMEOUTS.SSE_CONNECT;
export const STDIO_CONNECT_TIMEOUT = MCP_TIMEOUTS.STDIO_CONNECT;
export const STDIO_FIRST_RUN_TIMEOUT = MCP_TIMEOUTS.FIRST_RUN;
export const REMOTE_MCP_CONNECT_MAX_ATTEMPTS = 2;
export const REMOTE_MCP_CONNECT_RETRY_DELAY_MS = 400;
const mcpProxyAgents = new Map<string, ProxyAgent>();

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
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const normalized = message.toLowerCase();
  return [
    'fetch failed',
    'econnreset',
    'etimedout',
    'eai_again',
    'enetunreach',
    'socket hang up',
    'other side closed',
    'terminated',
  ].some((marker) => normalized.includes(marker));
}

export async function retryTransientRemoteMCPConnection<T>(
  attempt: (attemptNumber: number) => Promise<T>,
  options: {
    maxAttempts?: number;
    retryDelayMs?: number;
    onRetry?: (error: unknown, nextAttempt: number) => void;
  } = {},
): Promise<T> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? REMOTE_MCP_CONNECT_MAX_ATTEMPTS);
  const retryDelayMs = Math.max(0, options.retryDelayMs ?? REMOTE_MCP_CONNECT_RETRY_DELAY_MS);

  for (let attemptNumber = 1; attemptNumber <= maxAttempts; attemptNumber += 1) {
    try {
      return await attempt(attemptNumber);
    } catch (error) {
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

  return sanitizeEnv({
    ...allowed,
    ...extra,
  });
}

/**
 * 根据配置类型创建传输层和连接超时
 */
export function createTransport(
  config: MCPServerConfig,
  options: { useProxy?: boolean } = {},
): { transport: Transport; connectTimeout: number } {
  if (isHttpStreamableConfig(config)) {
    logger.info(`Using HTTP Streamable transport for ${config.name}: ${config.serverUrl}`);

    const url = new URL(config.serverUrl);
    const requestInit: RequestInit = {};
    const proxyFetch = options.useProxy ? createRemoteMCPFetch(url) : undefined;

    if (config.headers) {
      requestInit.headers = config.headers;
    }

    const transport = new StreamableHTTPClientTransport(url, {
      requestInit,
      ...(proxyFetch ? { fetch: proxyFetch } : {}),
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
      capabilities: {
        elicitation: {
          form: {},
        },
        tasks: {
          list: {},
          cancel: {},
        },
      },
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
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let isSettled = false;

    const timeoutId = setTimeout(() => {
      if (!isSettled) {
        isSettled = true;
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
        reject(new Error(errorMsg));
      }
    }, connectTimeout);

    client.connect(transport)
      .then(() => {
        if (!isSettled) {
          isSettled = true;
          clearTimeout(timeoutId);
          resolve();
        }
      })
      .catch((err) => {
        if (!isSettled) {
          isSettled = true;
          clearTimeout(timeoutId);
          reject(err);
        }
      });
  });
}
