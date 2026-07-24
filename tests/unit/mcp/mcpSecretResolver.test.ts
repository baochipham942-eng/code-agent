import { beforeEach, describe, expect, it, vi } from 'vitest';

const getConfigServiceMock = vi.hoisted(() => vi.fn());

vi.mock('../../../src/host/services/core/configService', () => ({
  getConfigService: getConfigServiceMock,
}));

import { resolveServerConfigSecrets } from '../../../src/host/mcp/mcpSecretResolver';
import type { MCPServerConfig } from '../../../src/host/mcp/types';

beforeEach(() => {
  getConfigServiceMock.mockReset();
});

describe('resolveServerConfigSecrets', () => {
  it('returns the same config reference when no secret references exist', () => {
    const config: MCPServerConfig = {
      name: 'feishu',
      type: 'stdio',
      command: 'npx',
      env: { APP_ID: 'cli_app_id' },
      enabled: true,
    };

    expect(resolveServerConfigSecrets(config)).toBe(config);
    expect(getConfigServiceMock).not.toHaveBeenCalled();
  });

  it('resolves stdio env and remote headers without changing the source configs', () => {
    getConfigServiceMock.mockReturnValue({
      getIntegration: vi.fn(() => ({
        APP_SECRET: 'stdio-secret',
        Authorization: 'Bearer remote-secret',
      })),
    });
    const stdioConfig: MCPServerConfig = {
      name: 'feishu',
      type: 'stdio',
      command: 'npx',
      env: {
        APP_ID: 'cli_app_id',
        APP_SECRET: 'secureref:mcp_feishu.APP_SECRET',
      },
      enabled: true,
    };
    const httpConfig: MCPServerConfig = {
      name: 'remote',
      type: 'http-streamable',
      serverUrl: 'https://example.com/mcp',
      headers: {
        Authorization: 'secureref:mcp_remote.Authorization',
      },
      enabled: true,
    };

    const resolvedStdio = resolveServerConfigSecrets(stdioConfig);
    const resolvedHttp = resolveServerConfigSecrets(httpConfig);

    expect(resolvedStdio).toEqual({
      ...stdioConfig,
      env: {
        APP_ID: 'cli_app_id',
        APP_SECRET: 'stdio-secret',
      },
    });
    expect(resolvedHttp).toEqual({
      ...httpConfig,
      headers: {
        Authorization: 'Bearer remote-secret',
      },
    });
    expect(stdioConfig.env?.APP_SECRET).toBe('secureref:mcp_feishu.APP_SECRET');
    expect(httpConfig.headers?.Authorization).toBe('secureref:mcp_remote.Authorization');
  });

  it('fails closed when configService is unavailable and a reference exists', () => {
    getConfigServiceMock.mockReturnValue(null);
    const config: MCPServerConfig = {
      name: 'feishu',
      type: 'stdio',
      command: 'npx',
      env: { APP_SECRET: 'secureref:mcp_feishu.APP_SECRET' },
      enabled: true,
    };

    expect(() => resolveServerConfigSecrets(config)).toThrow(/mcp_feishu\.APP_SECRET/);
  });
});
