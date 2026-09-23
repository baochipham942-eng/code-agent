import { describe, expect, it } from 'vitest';
import { toAcpMcpServers } from '../../../src/host/services/agentEngine/acpMcpServers';
import { isStdioConfig, type MCPServerConfig } from '../../../src/host/mcp/types';

const trusted = {
  projectStdioTrusted: true,
  localStdioTrusted: true,
  mcpCapabilities: { http: true, sse: true },
};

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
    ], trusted);

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
    }], trusted);

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
    ], { ...trusted, mcpCapabilities: { sse: true } });

    expect(result.servers.map((server) => server.name)).toEqual(['keep']);
    expect(result.dropped).toEqual([{ name: 'remote', reason: 'capability', transport: 'http' }]);
  });

  it('folderTrust 未信任时 project 级 stdio 被拒，global 与远端 url 保留', () => {
    const result = toAcpMcpServers([
      stdio({ name: 'global-stdio', scope: 'user', args: ['g.js'] }),
      stdio({ name: 'project-stdio', scope: 'project', args: ['p.js'] }),
      {
        name: 'project-http',
        type: 'http-streamable',
        serverUrl: 'https://example.com/mcp',
        enabled: true,
        scope: 'project',
      },
      stdio({ name: 'local-stdio', scope: 'local', args: ['l.js'] }),
    ], {
      projectStdioTrusted: false,
      localStdioTrusted: false,
      mcpCapabilities: { http: true, sse: true },
    });

    expect(result.servers.map((server) => server.name)).toEqual(['global-stdio', 'project-http']);
    expect(result.dropped).toEqual([
      { name: 'project-stdio', reason: 'folder_trust' },
      { name: 'local-stdio', reason: 'folder_trust' },
    ]);
  });

  it('空配置返回空 servers', () => {
    expect(toAcpMcpServers([], trusted).servers).toEqual([]);
  });

  it('secretRef 经 fake resolver 解析后才透传，结果里不留引用', () => {
    const result = toAcpMcpServers([
      stdio({ name: 'secret-stdio', env: { TOKEN: 'secureref:demo.token' } }),
    ], {
      ...trusted,
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
    ], trusted);

    expect(result.servers).toEqual([]);
    expect(result.dropped).toEqual([{ name: 'secret-stdio', reason: 'secret' }]);
    expect(JSON.stringify(result)).not.toContain('secureref:');
  });
});
