// 最小假 OAuth MCP 服务端（N-CONNECTOR-POLISH-AUDIT-FU4-SCOPE）：
// 401 挑战只声明 read；write_page 工具要求 write scope，缺失时回 403 insufficient_scope scope="write"。
// 记录每次 /authorize 请求的 scope，证明「重新授权」真的请求了缺的 scope。
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeOAuthMcpServer {
  url: string;
  authorizeScopes: string[];
  toolCallStatuses: number[];
  close(): Promise<void>;
}

export async function startFakeOAuthMcpServer(port = 0): Promise<FakeOAuthMcpServer> {
  const codes = new Map<string, string>();
  const tokens = new Map<string, string>();
  const authorizeScopes: string[] = [];
  const toolCallStatuses: number[] = [];
  let base = '';

  const readBody = (req: http.IncomingMessage) => new Promise<string>((resolve) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => resolve(data));
  });
  const json = (res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', base || 'http://127.0.0.1');
    if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
      return json(res, 200, { resource: `${base}/mcp`, authorization_servers: [base] });
    }
    if (url.pathname.startsWith('/.well-known/oauth-authorization-server')) {
      return json(res, 200, {
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        registration_endpoint: `${base}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
      });
    }
    if (url.pathname === '/register') {
      const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
      return json(res, 201, { ...body, client_id: 'fake-client' });
    }
    if (url.pathname === '/authorize') {
      const scope = url.searchParams.get('scope') ?? '';
      authorizeScopes.push(scope);
      const code = `code-${authorizeScopes.length}`;
      codes.set(code, scope);
      const redirect = new URL(url.searchParams.get('redirect_uri') ?? '');
      redirect.searchParams.set('code', code);
      redirect.searchParams.set('state', url.searchParams.get('state') ?? '');
      res.writeHead(302, { location: redirect.toString() });
      return res.end();
    }
    if (url.pathname === '/token') {
      const form = new URLSearchParams(await readBody(req));
      const scope = codes.get(form.get('code') ?? '');
      if (scope === undefined) return json(res, 400, { error: 'invalid_grant' });
      const accessToken = `at-${tokens.size + 1}`;
      tokens.set(accessToken, scope);
      return json(res, 200, { access_token: accessToken, token_type: 'Bearer', scope });
    }
    if (url.pathname === '/mcp' && req.method === 'POST') {
      const metadata = `resource_metadata="${base}/.well-known/oauth-protected-resource"`;
      const granted = tokens.get((req.headers.authorization ?? '').replace(/^Bearer /, ''));
      if (granted === undefined) {
        return json(res, 401, { error: 'unauthorized' }, { 'www-authenticate': `Bearer ${metadata}, scope="read"` });
      }
      const message = JSON.parse(await readBody(req)) as { id?: number; method: string; params?: { name?: string } };
      if (message.id === undefined) { res.writeHead(202); return res.end(); }
      if (message.method === 'initialize') {
        return json(res, 200, { jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake-notion', version: '1' } } });
      }
      if (message.method === 'tools/list') {
        return json(res, 200, { jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'write_page', description: 'Edit a page', inputSchema: { type: 'object', properties: {} } }] } });
      }
      if (message.method === 'tools/call') {
        if (!granted.split(' ').includes('write')) {
          toolCallStatuses.push(403);
          return json(res, 403, { error: 'insufficient_scope' }, { 'www-authenticate': `Bearer error="insufficient_scope", scope="write", ${metadata}` });
        }
        toolCallStatuses.push(200);
        return json(res, 200, { jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'page edited' }] } });
      }
      return json(res, 200, { jsonrpc: '2.0', id: message.id, result: {} });
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url: `${base}/mcp`,
    authorizeScopes,
    toolCallStatuses,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}
