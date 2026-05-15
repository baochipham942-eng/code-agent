import { beforeEach, describe, expect, it, vi } from 'vitest';

const getMcpConfigPathMock = vi.fn();
const ensureConfigDirMock = vi.fn();
const pathExistsMock = vi.fn();
const readFileMock = vi.fn();
const writeFileMock = vi.fn();

vi.mock('../../../src/main/mcp/mcpClient', () => ({
  getMCPClient: () => ({
    getStatus: vi.fn(),
    getTools: vi.fn(),
    getResources: vi.fn(),
    getServerStates: vi.fn(),
    getServerState: vi.fn(),
    addServer: vi.fn(),
    setServerEnabled: vi.fn(),
    reconnect: vi.fn(),
  }),
  refreshMCPServersFromCloud: vi.fn(),
}));

vi.mock('../../../src/main/context/contextHealthService', () => ({
  getContextHealthService: () => ({
    clearMcpServerAcrossSessions: vi.fn(),
  }),
}));

vi.mock('../../../src/main/config', () => ({
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
} from '../../../src/main/ipc/mcp.ipc';

beforeEach(() => {
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
});

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
});
