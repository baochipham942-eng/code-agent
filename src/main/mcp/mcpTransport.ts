// ============================================================================
// MCP Transport - 传输层创建和连接管理
// 支持 Stdio / SSE / HTTP Streamable 三种外部传输协议
// ============================================================================

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { createLogger } from '../services/infra/logger';
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

/**
 * 根据配置类型创建传输层和连接超时
 */
export function createTransport(config: MCPServerConfig): { transport: Transport; connectTimeout: number } {
  if (isHttpStreamableConfig(config)) {
    logger.info(`Using HTTP Streamable transport for ${config.name}: ${config.serverUrl}`);

    const url = new URL(config.serverUrl);
    const requestInit: RequestInit = {};

    if (config.headers) {
      requestInit.headers = config.headers;
    }

    const transport = new StreamableHTTPClientTransport(url, {
      requestInit,
    });
    return { transport, connectTimeout: SSE_CONNECT_TIMEOUT };
  } else if (isSSEConfig(config)) {
    logger.info(`Using SSE transport for ${config.name}: ${config.serverUrl}`);

    const url = new URL(config.serverUrl);
    const eventSourceInit: EventSourceInit = {};

    const transport = new SSEClientTransport(url, {
      eventSourceInit,
    });
    return { transport, connectTimeout: SSE_CONNECT_TIMEOUT };
  } else {
    // Stdio 本地服务器 (默认)
    const stdioConfig = config as MCPStdioServerConfig;
    logger.info(`Using Stdio transport for ${config.name}: ${stdioConfig.command} ${(stdioConfig.args || []).join(' ')}`);

    const transport = new StdioClientTransport({
      command: stdioConfig.command,
      args: stdioConfig.args || [],
      env: {
        ...process.env,
        ...stdioConfig.env,
      } as Record<string, string>,
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
 */
export function createMCPSDKClient(): Client {
  return new Client(
    {
      name: 'code-agent',
      version: '0.1.0',
    },
    {
      capabilities: {},
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
