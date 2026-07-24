import { beforeEach, describe, expect, it, vi } from 'vitest';

const getMcpConfigPathMock = vi.fn();
const getMcpScopedConfigPathsMock = vi.fn();
const ensureConfigDirMock = vi.fn();
const ensureUserConfigDirMock = vi.fn();
const pathExistsMock = vi.fn();
const readFileMock = vi.fn();
const writeFileMock = vi.fn();
const setIntegrationMock = vi.hoisted(() => vi.fn());
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

vi.mock('../../../src/host/services/core/configService', () => ({
  getConfigService: () => ({
    setIntegration: setIntegrationMock,
  }),
}));

vi.mock('../../../src/host/context/contextHealthService', () => ({
  getContextHealthService: () => ({
    clearMcpServerAcrossSessions: vi.fn(),
  }),
}));

vi.mock('../../../src/host/config', () => ({
  getMcpConfigPath: (...args: unknown[]) => getMcpConfigPathMock(...args),
  getMcpScopedConfigPaths: (...args: unknown[]) => getMcpScopedConfigPathsMock(...args),
  ensureConfigDir: (...args: unknown[]) => ensureConfigDirMock(...args),
  ensureUserConfigDir: (...args: unknown[]) => ensureUserConfigDirMock(...args),
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
  getMcpScopedConfigPathsMock.mockReset();
  ensureConfigDirMock.mockReset();
  ensureUserConfigDirMock.mockReset();
  pathExistsMock.mockReset();
  readFileMock.mockReset();
  writeFileMock.mockReset();
  setIntegrationMock.mockReset();
  setIntegrationMock.mockResolvedValue(undefined);

  getMcpConfigPathMock.mockReturnValue({
    new: '/tmp/work/.code-agent/mcp.json',
    legacy: '/tmp/work/.claude/settings.json',
  });
  getMcpScopedConfigPathsMock.mockReturnValue({
    user: '/tmp/user-data/mcp.json',
  });
  ensureConfigDirMock.mockResolvedValue('/tmp/work/.code-agent');
  ensureUserConfigDirMock.mockResolvedValue('/tmp/user-data');
  pathExistsMock.mockResolvedValue(false);
  readFileMock.mockRejectedValue(new Error('ENOENT'));
  writeFileMock.mockResolvedValue(undefined);
  mcpClientMock.getServerStates.mockReturnValue([]);
  mcpClientMock.disconnect.mockResolvedValue(undefined);
  coordinatorMock.cancelFlowForServerIdentity.mockReturnValue(false);
});

async function invokeMcpAction(
  action: string,
  payload?: unknown,
  workingDirectory: string | null = '/tmp/work',
) {
  const ipcMain = { handle: vi.fn() };
  registerMcpHandlers(ipcMain as never, {
    getWorkingDirectory: () => workingDirectory ?? undefined,
  });
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

  it('persists user-scoped servers to the user config without touching the working directory', async () => {
    const response = await invokeMcpAction('addServer', {
      scope: 'user',
      config: {
        name: 'global_docs',
        type: 'stdio',
        command: 'npx',
      },
    }, '/Applications/Agent Neo.app/Contents/Resources') as {
      success: boolean;
      data?: { configPath: string };
    };

    expect(response).toMatchObject({
      success: true,
      data: {
        configPath: '/tmp/user-data/mcp.json',
      },
    });
    expect(getMcpScopedConfigPathsMock).toHaveBeenCalledWith();
    expect(ensureUserConfigDirMock).toHaveBeenCalledOnce();
    expect(getMcpConfigPathMock).not.toHaveBeenCalled();
    expect(ensureConfigDirMock).not.toHaveBeenCalled();
    expect(writeFileMock).toHaveBeenCalledWith(
      '/tmp/user-data/mcp.json',
      expect.any(String),
    );
  });

  it('persists user-scoped servers when no working directory is available', async () => {
    const response = await invokeMcpAction('addServer', {
      scope: 'user',
      config: {
        name: 'no_project',
        type: 'stdio',
        command: 'npx',
      },
    }, null) as { success: boolean; error?: { message: string } };

    expect(response.success).toBe(true);
    expect(response.error?.message).not.toBe('Working directory is unavailable');
    expect(writeFileMock).toHaveBeenCalledWith(
      '/tmp/user-data/mcp.json',
      expect.any(String),
    );
  });

  it.each([
    ['explicit project scope', 'project'],
    ['default project scope', undefined],
  ])('keeps %s persistence in the working directory', async (_label, scope) => {
    const response = await invokeMcpAction('addServer', {
      ...(scope ? { scope } : {}),
      config: {
        name: scope ? 'explicit_project' : 'default_project',
        type: 'stdio',
        command: 'npx',
      },
    }) as { success: boolean; data?: { configPath: string } };

    expect(response).toMatchObject({
      success: true,
      data: {
        configPath: '/tmp/work/.code-agent/mcp.json',
      },
    });
    expect(getMcpConfigPathMock).toHaveBeenCalledWith('/tmp/work');
    expect(ensureConfigDirMock).toHaveBeenCalledWith('/tmp/work');
    expect(ensureUserConfigDirMock).not.toHaveBeenCalled();
  });

  it('stores marked env secrets and persists only references', async () => {
    const fakeSecret = 'SENSITIVE_PERSISTED_SECRET_91ca';
    const response = await invokeMcpAction('addServer', {
      config: {
        name: 'feishu',
        type: 'stdio',
        command: 'npx',
        env: {
          APP_ID: 'cli_app_id',
          APP_SECRET: fakeSecret,
        },
      },
      secretEnvKeys: ['APP_SECRET'],
    }) as { success: boolean };

    expect(response.success).toBe(true);
    expect(setIntegrationMock).toHaveBeenCalledWith('mcp_feishu', {
      APP_SECRET: fakeSecret,
    });
    expect(writeFileMock).toHaveBeenCalledOnce();
    expect(writeFileMock.mock.invocationCallOrder[0]).toBeLessThan(
      setIntegrationMock.mock.invocationCallOrder[0],
    );
    const persistedContent = String(writeFileMock.mock.calls[0][1]);
    expect(persistedContent).toContain('secureref:mcp_feishu.APP_SECRET');
    expect(persistedContent).not.toContain(fakeSecret);
    expect(persistedContent).toContain('cli_app_id');
    expect(mcpClientMock.addServer).toHaveBeenCalledWith(expect.objectContaining({
      env: {
        APP_ID: 'cli_app_id',
        APP_SECRET: 'secureref:mcp_feishu.APP_SECRET',
      },
      scope: 'runtime',
    }));
  });

  it('does not store extracted secrets when persistence fails for a duplicate server', async () => {
    pathExistsMock.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    readFileMock.mockResolvedValue(JSON.stringify({
      servers: [{
        name: 'duplicate_secret',
        type: 'stdio',
        command: 'npx',
        enabled: false,
      }],
    }));

    const response = await invokeMcpAction('addServer', {
      config: {
        name: 'duplicate_secret',
        type: 'stdio',
        command: 'npx',
        env: {
          APP_SECRET: 'must-not-be-orphaned',
        },
      },
      secretEnvKeys: ['APP_SECRET'],
    }) as { success: boolean; error?: { message: string } };

    expect(response.success).toBe(false);
    expect(response.error?.message).toContain('already exists');
    expect(setIntegrationMock).not.toHaveBeenCalled();
    expect(writeFileMock).not.toHaveBeenCalled();
    expect(mcpClientMock.addServer).not.toHaveBeenCalled();
  });

  it('keeps env values unchanged when no secret key list is provided', async () => {
    const fakeSecret = 'legacy-plaintext-secret';
    const response = await invokeMcpAction('addServer', {
      config: {
        name: 'legacy',
        type: 'stdio',
        command: 'npx',
        env: {
          API_KEY: fakeSecret,
        },
      },
    }) as { success: boolean };

    expect(response.success).toBe(true);
    expect(setIntegrationMock).not.toHaveBeenCalled();
    const persistedContent = String(writeFileMock.mock.calls[0][1]);
    expect(persistedContent).toContain(fakeSecret);
    expect(persistedContent).not.toContain('secureref:');
  });

  it('stores marked header secrets while preserving public headers', async () => {
    const fakeSecret = 'remote-header-secret';
    const response = await invokeMcpAction('addServer', {
      config: {
        name: 'remote_docs',
        type: 'http',
        url: 'https://example.com/mcp',
        headers: {
          'X-Client-Id': 'public-client-id',
          Authorization: fakeSecret,
        },
      },
      secretHeaderKeys: ['Authorization'],
    }) as { success: boolean };

    expect(response.success).toBe(true);
    expect(setIntegrationMock).toHaveBeenCalledWith('mcp_remote_docs', {
      Authorization: fakeSecret,
    });
    const persistedContent = String(writeFileMock.mock.calls[0][1]);
    expect(persistedContent).toContain('secureref:mcp_remote_docs.Authorization');
    expect(persistedContent).not.toContain(fakeSecret);
    expect(persistedContent).toContain('public-client-id');
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
