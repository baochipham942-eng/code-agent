// ============================================================================
// .mcp.json 配置文件 + scope 分层单测（G25 Item 2）
// ============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

const loggerMocks = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../../../src/main/services/infra/logger', () => ({
  logger: loggerMocks,
  createLogger: () => loggerMocks,
}));

// scope 路径由测试动态指向临时目录
const scopePaths = vi.hoisted(() => ({
  current: {} as { user: string; project?: string; local?: string },
}));

vi.mock('../../../src/main/config/configPaths', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/main/config/configPaths')>();
  return {
    ...actual,
    getMcpScopedConfigPaths: () => scopePaths.current,
  };
});

import { loadMcpConfigFiles } from '../../../src/main/mcp/mcpConfigFile';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-config-test-'));
  scopePaths.current = {
    user: path.join(tmpDir, 'user-mcp.json'),
    project: path.join(tmpDir, 'project-mcp.json'),
    local: path.join(tmpDir, 'local-mcp.json'),
  };
  vi.clearAllMocks();
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const write = (p: string | undefined, obj: unknown) => fs.writeFile(p!, JSON.stringify(obj));

describe('loadMcpConfigFiles', () => {
  it('returns empty when no config files exist', async () => {
    expect(await loadMcpConfigFiles('/wd')).toEqual([]);
  });

  it('loads native { servers: [...] } array format and tags scope', async () => {
    await write(scopePaths.current.project, {
      servers: [
        { name: 'fs', command: 'npx', args: ['-y', 'server-fs'], enabled: true },
        { name: 'api', type: 'http-streamable', serverUrl: 'https://x/mcp', enabled: true },
      ],
    });

    const result = await loadMcpConfigFiles('/wd');
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ name: 'fs', command: 'npx', scope: 'project' });
    expect(result[1]).toMatchObject({ name: 'api', type: 'http-streamable', scope: 'project' });
  });

  it('loads Claude Code { mcpServers: {...} } object format', async () => {
    await write(scopePaths.current.user, {
      mcpServers: {
        git: { command: 'npx', args: ['-y', 'server-git'] },
        remote: { type: 'sse', url: 'https://r/sse' },
      },
    });

    const result = await loadMcpConfigFiles('/wd');
    expect(result).toHaveLength(2);
    const git = result.find((s) => s.name === 'git');
    const remote = result.find((s) => s.name === 'remote');
    expect(git).toMatchObject({ name: 'git', type: 'stdio', command: 'npx', enabled: true, scope: 'user' });
    expect(remote).toMatchObject({ name: 'remote', type: 'sse', serverUrl: 'https://r/sse', scope: 'user' });
  });

  it('honors enabled:false in config files', async () => {
    await write(scopePaths.current.user, {
      servers: [{ name: 'off', command: 'x', enabled: false }],
    });
    const result = await loadMcpConfigFiles('/wd');
    expect(result[0]).toMatchObject({ name: 'off', enabled: false });
  });

  it('orders results user -> project -> local for override precedence', async () => {
    await write(scopePaths.current.user, { servers: [{ name: 'a', command: 'user-cmd' }] });
    await write(scopePaths.current.project, { servers: [{ name: 'a', command: 'project-cmd' }] });
    await write(scopePaths.current.local, { servers: [{ name: 'a', command: 'local-cmd' }] });

    const result = await loadMcpConfigFiles('/wd');
    // 三个同名条目按 user -> project -> local 顺序返回，addServer 时后者覆盖前者
    expect(result.map((s) => (s as { command: string }).command)).toEqual([
      'user-cmd',
      'project-cmd',
      'local-cmd',
    ]);
    expect(result.map((s) => s.scope)).toEqual(['user', 'project', 'local']);
  });

  it('skips invalid JSON without throwing', async () => {
    await fs.writeFile(scopePaths.current.project!, '{ not valid json');
    const result = await loadMcpConfigFiles('/wd');
    expect(result).toEqual([]);
    expect(loggerMocks.warn).toHaveBeenCalled();
  });

  it('skips malformed entries (missing name / command+url)', async () => {
    await write(scopePaths.current.project, {
      servers: [
        { name: 'good', command: 'npx' },
        { command: 'no-name' },
        { name: 'no-transport' },
      ],
    });
    const result = await loadMcpConfigFiles('/wd');
    expect(result.map((s) => s.name)).toEqual(['good']);
  });

  it('native servers[] wins over mcpServers{} for same name in one file', async () => {
    await write(scopePaths.current.project, {
      servers: [{ name: 'dup', command: 'native-cmd' }],
      mcpServers: { dup: { command: 'claude-cmd' } },
    });
    const result = await loadMcpConfigFiles('/wd');
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ name: 'dup', command: 'native-cmd' });
  });

  it('only loads user scope when no working directory given', async () => {
    scopePaths.current = { user: path.join(tmpDir, 'user-mcp.json') };
    await write(scopePaths.current.user, { servers: [{ name: 'u', command: 'x' }] });
    const result = await loadMcpConfigFiles();
    expect(result.map((s) => s.name)).toEqual(['u']);
  });
});
