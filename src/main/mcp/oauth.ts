// ============================================================================
// MCP OAuth - OAuth 2.0 认证流程
// 支持 Authorization Code Flow，用于连接需要 OAuth 的远程 MCP 服务器
// ============================================================================

import * as http from 'http';
import { URL } from 'url';
import * as fs from 'fs/promises';
import * as path from 'path';
import { createLogger } from '../services/infra/logger';
import type { MCPOAuthConfig, OAuthTokens } from './types';

const logger = createLogger('MCP-OAuth');

// Token 存储路径
const TOKEN_STORE_PATH = path.join(
  process.env.HOME || process.env.USERPROFILE || '.',
  '.code-agent',
  'mcp-tokens.json'
);

// 默认回调端口和路径
const DEFAULT_CALLBACK_PORT = 19876;
const DEFAULT_REDIRECT_URI = `http://localhost:${DEFAULT_CALLBACK_PORT}/callback`;

// Token 过期提前刷新时间（5 分钟）
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;

// ----------------------------------------------------------------------------
// Token Store
// ----------------------------------------------------------------------------

interface TokenStore {
  [serverKey: string]: OAuthTokens;
}

async function loadTokenStore(): Promise<TokenStore> {
  try {
    const data = await fs.readFile(TOKEN_STORE_PATH, 'utf-8');
    return JSON.parse(data);
  } catch {
    return {};
  }
}

async function saveTokenStore(store: TokenStore): Promise<void> {
  const dir = path.dirname(TOKEN_STORE_PATH);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(TOKEN_STORE_PATH, JSON.stringify(store, null, 2), 'utf-8');
}

/**
 * 获取服务器的 Token 存储 key
 */
function getServerKey(config: MCPOAuthConfig): string {
  // 使用 authorizationUrl + clientId 作为唯一标识
  return `${config.authorizationUrl}::${config.clientId}`;
}

// ----------------------------------------------------------------------------
// Token Management
// ----------------------------------------------------------------------------

/**
 * 获取已存储的 Token（如果有效）
 */
export async function getStoredToken(config: MCPOAuthConfig): Promise<OAuthTokens | null> {
  const store = await loadTokenStore();
  const key = getServerKey(config);
  const tokens = store[key];

  if (!tokens) {
    return null;
  }

  // 检查 access_token 是否过期
  if (tokens.expiresAt && Date.now() >= tokens.expiresAt - TOKEN_REFRESH_BUFFER_MS) {
    // Token 即将过期，尝试刷新
    if (tokens.refreshToken) {
      logger.info('Access token expired or expiring soon, attempting refresh...');
      try {
        const refreshed = await refreshAccessToken(config, tokens.refreshToken);
        // 更新存储
        store[key] = refreshed;
        await saveTokenStore(store);
        return refreshed;
      } catch (error) {
        logger.warn('Token refresh failed, need re-authorization', { error: String(error) });
        // 删除无效 token
        delete store[key];
        await saveTokenStore(store);
        return null;
      }
    }
    // 没有 refresh_token，token 已过期
    logger.info('Access token expired, no refresh token available');
    delete store[key];
    await saveTokenStore(store);
    return null;
  }

  return tokens;
}

/**
 * 存储 Token
 */
async function storeToken(config: MCPOAuthConfig, tokens: OAuthTokens): Promise<void> {
  const store = await loadTokenStore();
  const key = getServerKey(config);
  store[key] = tokens;
  await saveTokenStore(store);
}

/**
 * 删除已存储的 Token
 */
export async function clearStoredToken(config: MCPOAuthConfig): Promise<void> {
  const store = await loadTokenStore();
  const key = getServerKey(config);
  delete store[key];
  await saveTokenStore(store);
}

// ----------------------------------------------------------------------------
// OAuth Flow
// ----------------------------------------------------------------------------

/**
 * 生成随机 state 参数（防 CSRF）
 */
function generateState(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < 32; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

/**
 * 构建授权 URL
 */
function buildAuthorizationUrl(config: MCPOAuthConfig, state: string): string {
  const url = new URL(config.authorizationUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', config.redirectUri || DEFAULT_REDIRECT_URI);
  url.searchParams.set('state', state);

  if (config.scopes && config.scopes.length > 0) {
    url.searchParams.set('scope', config.scopes.join(' '));
  }

  return url.toString();
}

/**
 * 用 authorization code 换取 token
 */
async function exchangeCodeForToken(
  config: MCPOAuthConfig,
  code: string
): Promise<OAuthTokens> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: config.clientId,
    redirect_uri: config.redirectUri || DEFAULT_REDIRECT_URI,
  });

  if (config.clientSecret) {
    body.set('client_secret', config.clientSecret);
  }

  const response = await fetch(config.tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Token exchange failed: ${response.status} ${errorText}`);
  }

  const data = await response.json() as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    token_type?: string;
    scope?: string;
  };

  const tokens: OAuthTokens = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    tokenType: data.token_type || 'Bearer',
    scope: data.scope,
  };

  if (data.expires_in) {
    tokens.expiresAt = Date.now() + data.expires_in * 1000;
  }

  return tokens;
}

/**
 * 刷新 access token
 */
async function refreshAccessToken(
  config: MCPOAuthConfig,
  refreshToken: string
): Promise<OAuthTokens> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: config.clientId,
  });

  if (config.clientSecret) {
    body.set('client_secret', config.clientSecret);
  }

  const response = await fetch(config.tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Token refresh failed: ${response.status} ${errorText}`);
  }

  const data = await response.json() as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    token_type?: string;
    scope?: string;
  };

  const tokens: OAuthTokens = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || refreshToken, // 保留旧 refresh_token
    tokenType: data.token_type || 'Bearer',
    scope: data.scope,
  };

  if (data.expires_in) {
    tokens.expiresAt = Date.now() + data.expires_in * 1000;
  }

  return tokens;
}

/**
 * 启动 OAuth 授权流程
 *
 * 流程：
 * 1. 启动本地 HTTP server 监听回调
 * 2. 打开系统浏览器到授权 URL
 * 3. 用户在浏览器中授权
 * 4. 接收回调中的 authorization code
 * 5. 用 code 换取 token
 * 6. 存储 token
 *
 * @param config OAuth 配置
 * @param timeout 等待回调的超时时间（ms），默认 120 秒
 * @returns 获取到的 Token
 */
export async function startOAuthFlow(
  config: MCPOAuthConfig,
  timeout: number = 120000
): Promise<OAuthTokens> {
  const state = generateState();
  const redirectUri = config.redirectUri || DEFAULT_REDIRECT_URI;
  const redirectUrl = new URL(redirectUri);
  const callbackPort = parseInt(redirectUrl.port, 10) || DEFAULT_CALLBACK_PORT;
  const callbackPath = redirectUrl.pathname;

  logger.info('Starting OAuth flow', {
    authUrl: config.authorizationUrl,
    callbackPort,
  });

  return new Promise<OAuthTokens>((resolve, reject) => {
    let timeoutHandle: NodeJS.Timeout;

    const server = http.createServer(async (req, res) => {
      const reqUrl = new URL(req.url || '/', `http://localhost:${callbackPort}`);

      if (reqUrl.pathname !== callbackPath) {
        res.writeHead(404);
        res.end('Not Found');
        return;
      }

      // 验证 state
      const receivedState = reqUrl.searchParams.get('state');
      if (receivedState !== state) {
        res.writeHead(400);
        res.end('Invalid state parameter - possible CSRF attack');
        logger.error('OAuth state mismatch', { expected: state, received: receivedState });
        return;
      }

      // 检查错误
      const error = reqUrl.searchParams.get('error');
      if (error) {
        const errorDescription = reqUrl.searchParams.get('error_description') || error;
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`
          <html><body>
            <h2>Authorization Failed</h2>
            <p>${errorDescription}</p>
            <p>You can close this window.</p>
          </body></html>
        `);
        clearTimeout(timeoutHandle);
        server.close();
        reject(new Error(`OAuth authorization failed: ${errorDescription}`));
        return;
      }

      // 获取 authorization code
      const code = reqUrl.searchParams.get('code');
      if (!code) {
        res.writeHead(400);
        res.end('Missing authorization code');
        return;
      }

      try {
        // 用 code 换取 token
        const tokens = await exchangeCodeForToken(config, code);

        // 存储 token
        await storeToken(config, tokens);

        // 返回成功页面
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`
          <html><body>
            <h2>Authorization Successful</h2>
            <p>Code Agent has been authorized. You can close this window.</p>
            <script>setTimeout(() => window.close(), 2000);</script>
          </body></html>
        `);

        clearTimeout(timeoutHandle);
        server.close();

        logger.info('OAuth flow completed successfully');
        resolve(tokens);
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`
          <html><body>
            <h2>Token Exchange Failed</h2>
            <p>${String(err)}</p>
            <p>You can close this window.</p>
          </body></html>
        `);
        clearTimeout(timeoutHandle);
        server.close();
        reject(err);
      }
    });

    // 超时处理
    timeoutHandle = setTimeout(() => {
      server.close();
      reject(new Error(`OAuth flow timed out after ${timeout / 1000}s - user did not authorize in time`));
    }, timeout);

    // 启动服务器
    server.listen(callbackPort, '127.0.0.1', async () => {
      const authUrl = buildAuthorizationUrl(config, state);

      logger.info('OAuth callback server started', { port: callbackPort });
      logger.info('Opening browser for authorization...');

      // 打开系统浏览器（Electron 桌面应用场景，不使用内嵌 webview）
      try {
        const { shell } = await import('../platform').catch(() => ({ shell: null }));
        if (shell) {
          await shell.openExternal(authUrl);
        } else {
          const { exec } = await import('child_process');
          const platform = process.platform;
          let command: string;

          if (platform === 'darwin') {
            command = `open "${authUrl}"`;
          } else if (platform === 'win32') {
            command = `start "" "${authUrl}"`;
          } else {
            command = `xdg-open "${authUrl}"`;
          }

          exec(command, (err) => {
            if (err) {
              logger.warn('Failed to open browser automatically', { error: String(err) });
              // 输出 URL 让用户手动打开
              console.error(`\nPlease open the following URL in your browser to authorize:\n\n  ${authUrl}\n`);
            }
          });
        }
      } catch (err) {
        logger.warn('Failed to open browser', { error: String(err) });
        console.error(`\nPlease open the following URL in your browser to authorize:\n\n  ${authUrl}\n`);
      }
    });

    server.on('error', (err) => {
      clearTimeout(timeoutHandle);
      reject(new Error(`Failed to start OAuth callback server: ${err.message}`));
    });
  });
}

/**
 * 确保有有效的 OAuth Token
 * 如果没有有效 token，会启动 OAuth 流程
 *
 * @param config OAuth 配置
 * @returns 有效的 access token
 */
export async function ensureOAuthToken(config: MCPOAuthConfig): Promise<string> {
  // 检查是否有存储的有效 token
  const stored = await getStoredToken(config);
  if (stored) {
    return stored.accessToken;
  }

  // 没有有效 token，启动 OAuth 流程
  logger.info('No valid token found, starting OAuth flow...');
  const tokens = await startOAuthFlow(config);
  return tokens.accessToken;
}

/**
 * 获取带认证头的 headers
 * 用于 SSE/HTTP MCP 客户端连接时附加认证
 */
export async function getAuthHeaders(
  config: MCPOAuthConfig,
  existingHeaders?: Record<string, string>
): Promise<Record<string, string>> {
  const token = await ensureOAuthToken(config);
  return {
    ...existingHeaders,
    Authorization: `Bearer ${token}`,
  };
}
