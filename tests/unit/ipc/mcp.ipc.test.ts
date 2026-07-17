import { beforeEach, describe, expect, it, vi } from 'vitest';

const getMcpConfigPathMock = vi.fn();
const ensureConfigDirMock = vi.fn();
const pathExistsMock = vi.fn();
const readFileMock = vi.fn();
const writeFileMock = vi.fn();
const mcpClientMock = vi.hoisted(() => ({
  getStatus: vi.fn(),
  getTools: vi.fn(),
  getResources: vi.fn(),
  getServerStates: vi.fn(),
  getServerState: vi.fn(),
  getServerIdentity: vi.fn(),
  addServer: vi.fn(),
  setServerEnabled: vi.fn(),
  reconnect: vi.fn(),
  disconnect: vi.fn(),
}));
const coordinatorMock = vi.hoisted(() => ({
  cancelFlowForServerIdentity: vi.fn(),
}));
const secureStorageValues = vi.hoisted(() => new Map<string, string>());
const secureStorageMock = vi.hoisted(() => ({
  get: vi.fn((key: string) => secureStorageValues.get(key)),
  set: vi.fn((key: string, value: string) => {
    secureStorageValues.set(key, value);
  }),
  delete: vi.fn((key: string) => {
    secureStorageValues.delete(key);
  }),
}));

vi.mock('../../../src/host/mcp/mcpClient', () => ({
  getMCPClient: () => mcpClientMock,
  refreshMCPServersFromCloud: vi.fn(),
  isHttpStreamableConfig: (config: { type?: string }) => config.type === 'http-streamable',
}));

vi.mock('../../../src/host/mcp/mcpOAuthCoordinator', () => ({
  getMcpOAuthCoordinator: () => coordinatorMock,
}));

vi.mock('../../../src/host/services/core/secureStorage', () => ({
  getSecureStorage: () => secureStorageMock,
}));

vi.mock('../../../src/host/context/contextHealthService', () => ({
  getContextHealthService: () => ({
    clearMcpServerAcrossSessions: vi.fn(),
  }),
}));

vi.mock('../../../src/host/config', () => ({
  getMcpConfigPath: (...args: unknown[]) => getMcpConfigPathMock(...args),
  ensureConfigDir: (...args: unknown[]) => ensureConfigDirMock(...args),
  pathExists: (...args: unknown[]) => pathExistsMock(...args),
}));

vi.mock('fs/promises', () => ({
  default: {
    readFile: (...args: unknown[]) => readFileMock(...args),
    writeFile: (...args: unknown[]) => writeFileMock(...args),
  },
  readFile: (...args: unknown[]) => readFileMock(...args),
  writeFile: (...args: unknown[]) => writeFileMock(...args),
}));

import {
  normalizeMcpSettingsServerConfig,
  persistMcpSettingsServerConfig,
  registerMcpHandlers,
} from '../../../src/host/ipc/mcp.ipc';

beforeEach(() => {
  for (const mock of Object.values(mcpClientMock)) {
    mock.mockReset();
  }
  coordinatorMock.cancelFlowForServerIdentity.mockReset();
  secureStorageValues.clear();
  secureStorageMock.get.mockClear();
  secureStorageMock.set.mockClear();
  secureStorageMock.delete.mockClear();
  getMcpConfigPathMock.mockReset();
  ensureConfigDirMock.mockReset();
  pathExistsMock.mockReset();
  readFileMock.mockReset();
  writeFileMock.mockReset();

  getMcpConfigPathMock.mockReturnValue({
    new: '/tmp/work/.code-agent/mcp.json',
    legacy: '/tmp/work/.claude/settings.json',
  });
  ensureConfigDirMock.mockResolvedValue('/tmp/work/.code-agent');
  pathExistsMock.mockResolvedValue(false);
  readFileMock.mockRejectedValue(new Error('ENOENT'));
  writeFileMock.mockResolvedValue(undefined);
  mcpClientMock.getServerStates.mockReturnValue([]);
  mcpClientMock.disconnect.mockResolvedValue(undefined);
  coordinatorMock.cancelFlowForServerIdentity.mockReturnValue(false);
});

async function invokeMcpAction(action: string, payload?: unknown) {
  const ipcMain = { handle: vi.fn() };
  registerMcpHandlers(ipcMain as never);
  const handler = ipcMain.handle.mock.calls[0][1] as (_event: unknown, request: { action: string; payload?: unknown }) => Promise<unknown>;
  return handler({}, { action, payload });
}

describe('mcp.ipc settings add helpers', () => {
  it('normalizes stdio server drafts as disabled lazy-load configs', () => {
    expect(normalizeMcpSettingsServerConfig({
      name: 'filesystem',
      type: 'stdio',
      command: 'npx',
      args: [' -y ', '@modelcontextprotocol/server-filesystem'],
      env: { API_TOKEN: ' secret ' },
    })).toEqual({
      name: 'filesystem',
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem'],
      env: { API_TOKEN: 'secret' },
      enabled: false,
      lazyLoad: true,
    });
  });

  it('normalizes http server drafts to http-streamable without enabling them', () => {
    expect(normalizeMcpSettingsServerConfig({
      name: 'remote_docs',
      type: 'http',
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer token' },
    })).toEqual({
      name: 'remote_docs',
      type: 'http-streamable',
      serverUrl: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer token' },
      enabled: false,
    });
  });

  it('passes through oauth auth for http server drafts', () => {
    expect(normalizeMcpSettingsServerConfig({
      name: 'remote_docs',
      type: 'http',
      url: 'https://example.com/mcp',
      auth: 'oauth',
    })).toEqual({
      name: 'remote_docs',
      type: 'http-streamable',
      serverUrl: 'https://example.com/mcp',
      auth: 'oauth',
      enabled: false,
    });
  });

  it('rejects invalid auth values for settings MCP drafts', () => {
    expect(() => normalizeMcpSettingsServerConfig({
      name: 'remote_docs',
      type: 'http',
      url: 'https://example.com/mcp',
      auth: 'bearer',
    })).toThrow("auth must be 'oauth'");

    expect(() => normalizeMcpSettingsServerConfig({
      name: 'legacy_sse',
      type: 'sse',
      url: 'https://example.com/sse',
      auth: 'oauth',
    })).toThrow("auth must be 'oauth'");
  });

  it('rejects blocked stdio commands and non-http urls', () => {
    expect(() => normalizeMcpSettingsServerConfig({
      name: 'bad_cmd',
      type: 'stdio',
      command: '/bin/rm',
    })).toThrow("Command 'rm' is not allowed");

    expect(() => normalizeMcpSettingsServerConfig({
      name: 'bad_url',
      type: 'sse',
      url: 'file:///tmp/socket',
    })).toThrow('Only http:// and https:// are allowed');
  });

  it('persists new settings MCP configs into .code-agent/mcp.json', async () => {
    const config = normalizeMcpSettingsServerConfig({
      name: 'filesystem',
      type: 'stdio',
      command: 'npx',
    });

    await expect(persistMcpSettingsServerConfig('/tmp/work', config)).resolves.toEqual({
      filePath: '/tmp/work/.code-agent/mcp.json',
    });

    expect(ensureConfigDirMock).toHaveBeenCalledWith('/tmp/work');
    expect(writeFileMock).toHaveBeenCalledWith(
      '/tmp/work/.code-agent/mcp.json',
      JSON.stringify({ servers: [config] }, null, 2),
    );
  });

  it('does not overwrite an existing server entry from settings add', async () => {
    pathExistsMock.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    readFileMock.mockResolvedValue(JSON.stringify({
      servers: [{ name: 'filesystem', type: 'stdio', command: 'npx', enabled: false }],
    }));

    const config = normalizeMcpSettingsServerConfig({
      name: 'filesystem',
      type: 'stdio',
      command: 'npx',
    });

    await expect(persistMcpSettingsServerConfig('/tmp/work', config))
      .rejects.toThrow('already exists');
    expect(writeFileMock).not.toHaveBeenCalled();
  });

  it('summarizes OAuth server state with token presence without leaking token contents', async () => {
    const tokenValue = 'secret-access-token-value';
    const serverIdentity = 'notion:abc123digest';
    secureStorageValues.set(
      `mcp-oauth:${serverIdentity}:tokens`,
      JSON.stringify({ access_token: tokenValue, token_type: 'Bearer' }),
    );
    mcpClientMock.getServerIdentity.mockReturnValue(serverIdentity);
    mcpClientMock.getServerStates.mockReturnValue([
      {
        config: {
          name: 'notion',
          type: 'http-streamable',
          serverUrl: 'https://mcp.notion.com/mcp',
          enabled: true,
          auth: 'oauth',
        },
        status: 'connected',
        toolCount: 2,
        resourceCount: 1,
      },
    ]);

    const response = await invokeMcpAction('getServerStates') as {
      success: boolean;
      data: unknown;
    };

    expect(response.success).toBe(true);
    expect(response.data).toEqual([
      expect.objectContaining({
        authMode: 'oauth',
        hasOAuthTokens: true,
      }),
    ]);
    expect(JSON.stringify(response.data)).not.toContain(tokenValue);
  });

  it('reports hasOAuthTokens false for an OAuth server without stored tokens', async () => {
    mcpClientMock.getServerIdentity.mockReturnValue('notion:abc123digest');
    mcpClientMock.getServerStates.mockReturnValue([
      {
        config: {
          name: 'notion',
          type: 'http-streamable',
          serverUrl: 'https://mcp.notion.com/mcp',
          enabled: true,
          auth: 'oauth',
        },
        status: 'error',
        toolCount: 0,
        resourceCount: 0,
      },
    ]);

    const response = await invokeMcpAction('getServerStates') as {
      success: boolean;
      data: unknown;
    };

    expect(response.success).toBe(true);
    expect(response.data).toEqual([
      expect.objectContaining({
        authMode: 'oauth',
        hasOAuthTokens: false,
      }),
    ]);
  });

  it('signs out OAuth servers by deleting all OAuth credential kinds, cancelling flow, and disconnecting', async () => {
    const serverIdentity = 'notion:abc123digest';
    for (const kind of ['tokens', 'client-info', 'code-verifier', 'discovery']) {
      secureStorageValues.set(`mcp-oauth:${serverIdentity}:${kind}`, `"${kind}-value"`);
    }
    mcpClientMock.getServerIdentity.mockReturnValue(serverIdentity);
    mcpClientMock.getServerState.mockReturnValue({
      config: {
        name: 'notion',
        type: 'http-streamable',
        serverUrl: 'https://mcp.notion.com/mcp',
        enabled: true,
        auth: 'oauth',
      },
      status: 'connected',
      toolCount: 2,
      resourceCount: 1,
    });
    coordinatorMock.cancelFlowForServerIdentity.mockReturnValue(true);

    const response = await invokeMcpAction('signOutServer', { serverName: 'notion' }) as {
      success: boolean;
      data: { success: boolean; hadOAuthTokens: boolean; cancelledFlow: boolean };
    };

    expect(response).toMatchObject({
      success: true,
      data: {
        success: true,
        hadOAuthTokens: true,
        cancelledFlow: true,
      },
    });
    expect(secureStorageMock.delete).toHaveBeenCalledWith(`mcp-oauth:${serverIdentity}:tokens`);
    expect(secureStorageMock.delete).toHaveBeenCalledWith(`mcp-oauth:${serverIdentity}:client-info`);
    expect(secureStorageMock.delete).toHaveBeenCalledWith(`mcp-oauth:${serverIdentity}:code-verifier`);
    expect(secureStorageMock.delete).toHaveBeenCalledWith(`mcp-oauth:${serverIdentity}:discovery`);
    expect(secureStorageValues.size).toBe(0);
    expect(coordinatorMock.cancelFlowForServerIdentity).toHaveBeenCalledWith(serverIdentity);
    expect(mcpClientMock.disconnect).toHaveBeenCalledWith('notion');
    expect(mcpClientMock.reconnect).not.toHaveBeenCalled();
  });

  it('rejects sign-out for non-OAuth servers', async () => {
    mcpClientMock.getServerState.mockReturnValue({
      config: {
        name: 'plain',
        type: 'http-streamable',
        serverUrl: 'https://mcp.example.com/mcp',
        enabled: true,
      },
      status: 'connected',
      toolCount: 0,
      resourceCount: 0,
    });

    const response = await invokeMcpAction('signOutServer', { serverName: 'plain' }) as {
      success: boolean;
      error?: { message: string };
    };

    expect(response.success).toBe(false);
    expect(response.error?.message).toContain('not configured for OAuth');
    expect(secureStorageMock.delete).not.toHaveBeenCalled();
    expect(mcpClientMock.disconnect).not.toHaveBeenCalled();
  });
});
