import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toAcpMcpServers } from '../../../src/host/services/agentEngine/acpMcpServers';
import { isStdioConfig, type MCPServerConfig } from '../../../src/host/mcp/types';

const loggerWarn = vi.hoisted(() => vi.fn());

vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: loggerWarn,
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const caps = {
  mcpCapabilities: { http: true, sse: true },
};

beforeEach(() => {
  loggerWarn.mockClear();
});

function stdio(partial: Partial<MCPServerConfig> & { name: string }): MCPServerConfig {
  return {
    type: 'stdio',
    command: 'node',
    args: ['server.js'],
    enabled: true,
    scope: 'user',
    ...partial,
  } as MCPServerConfig;
}

describe('toAcpMcpServers', () => {
  it('把 stdio 映射成没有 type 字段的 ACP stdio', () => {
    const result = toAcpMcpServers([
      stdio({ name: 'local-tool', args: ['server.js'], env: { FOO: 'bar' } }),
    ], caps);

    expect(result.servers).toEqual([{
      name: 'local-tool',
      command: 'node',
      args: ['server.js'],
      env: [{ name: 'FOO', value: 'bar' }],
    }]);
    expect(result.dropped).toEqual([]);
  });

  it('把 http-streamable 映射成 ACP http', () => {
    const result = toAcpMcpServers([{
      name: 'remote',
      type: 'http-streamable',
      serverUrl: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer fixture' },
      enabled: true,
      scope: 'user',
    }], caps);

    expect(result.servers).toEqual([{
      type: 'http',
      name: 'remote',
      url: 'https://example.com/mcp',
      headers: [{ name: 'Authorization', value: 'Bearer fixture' }],
    }]);
  });

  it('对方不支持 http 时裁掉 http，stdio 仍保留', () => {
    const result = toAcpMcpServers([
      stdio({ name: 'keep' }),
      {
        name: 'remote',
        type: 'http-streamable',
        serverUrl: 'https://example.com/mcp',
        enabled: true,
        scope: 'user',
      },
    ], { ...caps, mcpCapabilities: { sse: true } });

    expect(result.servers.map((server) => server.name)).toEqual(['keep']);
    expect(result.dropped).toEqual([{ name: 'remote', reason: 'capability', transport: 'http' }]);
  });

  it('未信任目录的 project/local stdio 不进 configs，user 与已放行的远端 url 仍透传', () => {
    // loadMcpConfigFiles 对含 stdio 的未信任文件是整文件不读，这些条目不会出现在入参里。
    const result = toAcpMcpServers([
      stdio({ name: 'user-stdio', scope: 'user', args: ['u.js'] }),
      {
        name: 'project-http',
        type: 'http-streamable',
        serverUrl: 'https://example.com/mcp',
        enabled: true,
        scope: 'project',
      },
    ], caps);

    expect(result.servers.map((server) => server.name)).toEqual(['user-stdio', 'project-http']);
    expect(result.dropped).toEqual([]);
  });

  it('空配置返回空 servers', () => {
    expect(toAcpMcpServers([], caps).servers).toEqual([]);
  });

  it('secretRef 经 fake resolver 解析后才透传，结果里不留引用', () => {
    const result = toAcpMcpServers([
      stdio({ name: 'secret-stdio', env: { TOKEN: 'secureref:demo.token' } }),
    ], {
      ...caps,
      resolveSecrets: (config) => (
        isStdioConfig(config) ? { ...config, env: { TOKEN: 'resolved-token' } } : config
      ),
    });

    expect(result.servers).toEqual([{
      name: 'secret-stdio',
      command: 'node',
      args: ['server.js'],
      env: [{ name: 'TOKEN', value: 'resolved-token' }],
    }]);
    expect(JSON.stringify(result)).not.toContain('secureref:');
  });

  it('未解析的 secretRef 不透传', () => {
    const result = toAcpMcpServers([
      stdio({ name: 'secret-stdio', env: { TOKEN: 'secureref:demo.token' } }),
    ], caps);

    expect(result.servers).toEqual([]);
    expect(result.dropped).toEqual([{ name: 'secret-stdio', reason: 'secret' }]);
    expect(JSON.stringify(result)).not.toContain('secureref:');
    expect(loggerWarn).toHaveBeenCalledWith(
      '[ACP] MCP secret ref remains after resolve',
      { serverName: 'secret-stdio' },
    );
    expect(JSON.stringify(loggerWarn.mock.calls)).not.toContain('secureref:');
  });

  it('user 启用且 local 同名 enabled:false 时后者整条覆盖，servers 里没有它', () => {
    const result = toAcpMcpServers([
      stdio({ name: 'shared', scope: 'user', command: 'user-bin', args: ['user.js'] }),
      stdio({ name: 'shared', scope: 'local', enabled: false, command: 'local-bin', args: ['local.js'] }),
    ], caps);

    expect(result.servers).toEqual([]);
    expect(result.dropped).toEqual([{ name: 'shared', reason: 'disabled' }]);
  });

  it('user stdio 被 project 同名 http 覆盖，对方不支持 http 时两版都不在', () => {
    const result = toAcpMcpServers([
      stdio({ name: 'shared', scope: 'user', command: 'user-bin', args: ['user.js'] }),
      {
        name: 'shared',
        type: 'http-streamable',
        serverUrl: 'https://example.com/mcp',
        enabled: true,
        scope: 'project',
      },
    ], { mcpCapabilities: { sse: true } });

    expect(result.servers).toEqual([]);
    expect(result.dropped).toEqual([{ name: 'shared', reason: 'capability', transport: 'http' }]);
  });

  it('user stdio 被已进入列表的 project stdio 覆盖，只留 project 的 command/args', () => {
    const result = toAcpMcpServers([
      stdio({ name: 'shared', scope: 'user', command: 'user-bin', args: ['user.js'] }),
      stdio({ name: 'shared', scope: 'project', command: 'project-bin', args: ['project.js'] }),
    ], caps);

    expect(result.servers).toEqual([{
      name: 'shared',
      command: 'project-bin',
      args: ['project.js'],
      env: [],
    }]);
    expect(result.dropped).toEqual([]);
  });

  it('解引用抛错时只记 serverName 与 error.name，reason 仍是 secret', () => {
    const result = toAcpMcpServers([
      stdio({ name: 'secret-stdio', env: { TOKEN: 'secureref:demo.token' } }),
    ], {
      ...caps,
      resolveSecrets: () => {
        const error = new Error('TOKEN=secureref:demo.token leaked');
        error.name = 'SecretResolveError';
        throw error;
      },
    });

    expect(result.servers).toEqual([]);
    expect(result.dropped).toEqual([{ name: 'secret-stdio', reason: 'secret' }]);
    expect(loggerWarn).toHaveBeenCalledTimes(1);
    expect(loggerWarn).toHaveBeenCalledWith(
      '[ACP] MCP secret resolve threw',
      { serverName: 'secret-stdio', errorName: 'SecretResolveError' },
    );
    const logged = JSON.stringify(loggerWarn.mock.calls);
    expect(logged).not.toContain('secureref:');
    expect(logged).not.toContain('leaked');
    expect(logged).not.toContain('TOKEN=');
  });
});
