import fs from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startFakeOAuthMcpServer, type FakeOAuthMcpServer } from '../../helpers/fakeOAuthMcpServer';

const storage = vi.hoisted(() => {
  const values = new Map<string, string>();
  return {
    values,
    get: (key: string) => values.get(key),
    set: (key: string, value: string) => { values.set(key, value); },
    delete: (key: string) => { values.delete(key); },
  };
});
const shell = vi.hoisted(() => ({ opened: [] as string[] }));

vi.mock('../../../src/host/services/core/secureStorage', () => ({ getSecureStorage: () => storage }));
vi.mock('../../../src/host/mcp/mcpOAuthConsent', () => ({
  requestMcpOAuthConsent: vi.fn(async () => ({ granted: true })),
}));
// 「浏览器」：直接请求授权 URL，假 AS 302 回环回调，等价于用户点了同意
vi.mock('../../../src/host/platform/nativeShell', () => ({
  openExternal: vi.fn(async (url: string) => {
    shell.opened.push(url);
    void fetch(url).catch(() => {});
  }),
}));

import { MCPClient } from '../../../src/host/mcp/mcpClient';
import { McpOAuthProvider } from '../../../src/host/mcp/mcpOAuthProvider';
import { reauthorizeMcpServer } from '../../../src/host/mcp/mcpReauthorize';

const EVIDENCE = process.env.FU4_RAW_OUT ?? '/dev/null';
let fake: FakeOAuthMcpServer;

beforeAll(async () => { fake = await startFakeOAuthMcpServer(); });
afterAll(async () => { await fake.close(); });

describe('reauthorize = invalidate tokens + reconnect (item-1 hypothesis against a fake OAuth MCP server)', () => {
  it('403 surfaces requiredScope; plain reconnect re-asks only "read"; reauthorizeMcpServer asks "read write" and the tool then succeeds', async () => {
    const client = new MCPClient();
    const config = { name: 'fake-notion', type: 'http-streamable' as const, serverUrl: fake.url, enabled: true, auth: 'oauth' as const };
    client.addServer(config);

    await client.connect(config).catch(() => {});
    await client.waitForPendingOAuthAuthorization('fake-notion');
    expect(client.isConnected('fake-notion')).toBe(true);
    expect(fake.authorizeScopes).toEqual(['read']);

    const denied = await client.callTool('t1', 'fake-notion', 'write_page', {});
    expect(denied.success).toBe(false);
    expect(denied.metadata).toEqual({ mcpInsufficientScope: { requiredScope: 'write' } });
    expect(fake.authorizeScopes).toEqual(['read']); // 不再静默弹授权

    const identity = client.getServerIdentity('fake-notion')!;
    const provider = new McpOAuthProvider({
      serverIdentity: identity, serverName: 'fake-notion', redirectUrl: () => 'http://127.0.0.1/x', state: () => 'x',
      onRedirectToAuthorization: () => { throw new Error('no'); },
    });
    provider.invalidateCredentials('tokens');
    await client.reconnect('fake-notion');
    await client.waitForPendingOAuthAuthorization('fake-notion');
    fs.appendFileSync(EVIDENCE, `plain reconnect authorize scope: ${JSON.stringify(fake.authorizeScopes.slice(1))}\n`);
    expect(fake.authorizeScopes.slice(1)).toEqual(['read']); // 假设不成立：只重新请求旧 scope

    const result = await reauthorizeMcpServer(client, 'fake-notion', 'write');
    fs.appendFileSync(EVIDENCE, `reauthorizeMcpServer authorize scope: ${JSON.stringify(fake.authorizeScopes.slice(2))} result=${JSON.stringify(result)}\n`);
    expect(result).toEqual({ success: true });
    expect(fake.authorizeScopes.slice(2)).toEqual(['read write']);
    const ok = await client.callTool('t2', 'fake-notion', 'write_page', {});
    expect(ok).toMatchObject({ success: true, output: 'page edited' });
    await client.disconnect('fake-notion');
  }, 60_000);

  it('declined / non-OAuth servers report failure without throwing', async () => {
    const client = new MCPClient();
    client.addServer({ name: 'plain', type: 'http-streamable', serverUrl: fake.url, enabled: true });
    expect(await reauthorizeMcpServer(client, 'plain', 'write')).toMatchObject({ success: false });
    expect(await reauthorizeMcpServer(client, 'missing', 'write')).toMatchObject({ success: false });
  });
});
