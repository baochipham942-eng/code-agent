// ============================================================================
// .mcp.json 配置文件加载集成测试（G25 Item 2）
//
// 真实链路：项目目录放 .code-agent/mcp.json → 真实 loadMcpConfigFiles
//   （真实 getMcpScopedConfigPaths 路径解析 + 真实文件读取 + 格式规范化）→
//   MCPClient.addServer + connect → 真实 stdio 子进程 → 工具被发现
// ============================================================================

import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { loadMcpConfigFiles } from '../../../src/host/mcp/mcpConfigFile';
import { MCPClient } from '../../../src/host/mcp/mcpClient';

const loggerMocks = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../../../src/host/services/infra/logger', () => ({
  logger: loggerMocks,
  createLogger: () => loggerMocks,
}));

const FIXTURE = path.resolve(__dirname, '../../fixtures/mcp/list-changed-server.mjs');

describe('.mcp.json config file loading (integration)', () => {
  let tmpWd: string;
  let client: MCPClient | undefined;

  afterEach(async () => {
    if (client) {
      await client.disconnectAll();
      client = undefined;
    }
    if (tmpWd) {
      await fs.rm(tmpWd, { recursive: true, force: true });
    }
  });

  it('loads project-scoped .mcp.json and connects the server it declares', async () => {
    tmpWd = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-wd-'));
    const configDir = path.join(tmpWd, '.code-agent');
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(
      path.join(configDir, 'mcp.json'),
      JSON.stringify({
        servers: [
          { name: 'projectfix', type: 'stdio', command: 'node', args: [FIXTURE], enabled: true, lazyLoad: false },
        ],
      }),
    );

    // 真实路径解析 + 真实文件读取
    const configs = await loadMcpConfigFiles(tmpWd);
    expect(configs).toHaveLength(1);
    expect(configs[0]).toMatchObject({ name: 'projectfix', scope: 'project', enabled: true });

    // 加载出来的配置真的能连上
    client = new MCPClient();
    client.addServer(configs[0]);
    await client.connect(configs[0]);

    const toolNames = client
      .getToolDefinitions()
      .map((d) => d.name)
      .filter((n) => n.startsWith('mcp__projectfix__'))
      .sort();
    expect(toolNames).toEqual(['mcp__projectfix__add_dynamic_tool', 'mcp__projectfix__ping']);
    expect(client.getServerState('projectfix')?.config.scope).toBe('project');
  }, 20000);

  it('returns user -> project -> local order so local overrides project', async () => {
    tmpWd = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-wd-'));
    const configDir = path.join(tmpWd, '.code-agent');
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(
      path.join(configDir, 'mcp.json'),
      JSON.stringify({ servers: [{ name: 'shared', command: 'project-cmd' }] }),
    );
    await fs.writeFile(
      path.join(configDir, 'mcp.local.json'),
      JSON.stringify({ mcpServers: { shared: { command: 'local-cmd' } } }),
    );

    const configs = await loadMcpConfigFiles(tmpWd);
    expect(configs.map((c) => c.scope)).toEqual(['project', 'local']);
    expect(configs.map((c) => (c as { command: string }).command)).toEqual([
      'project-cmd',
      'local-cmd',
    ]);
  });
});
