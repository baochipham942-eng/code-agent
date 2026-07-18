import * as path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import {
  pickEnvGatedComputerUseServers,
  getDefaultMCPServers,
} from '../../../src/host/mcp/mcpDefaultServers';

// 背景（2026-06-11 真机验证）：initMCPClient 里云端 MCP 清单与本地默认清单
// 是「二选一」，云端清单存在时本地默认清单整体被跳过——导致 cua-driver/argus
// 这类由环境变量门控的本机能力 server 在有云端配置的机器上永远不会注册。
// computer-use 底座必须独立于云端清单补注册。
describe('pickEnvGatedComputerUseServers — computer-use 底座独立于云端清单', () => {
  afterEach(() => {
    delete process.env.CODE_AGENT_ENABLE_CUA;
    delete process.env.CODE_AGENT_ENABLE_ARGUS_MCP;
    delete process.env.CODE_AGENT_CUA_DRIVER_PATH;
  });

  it('CUA 开启且未注册 → 返回 cua-driver 待补注册', () => {
    process.env.CODE_AGENT_ENABLE_CUA = '1';
    const picked = pickEnvGatedComputerUseServers(getDefaultMCPServers(), new Set(['context7']));
    expect(picked.map((s) => s.name)).toContain('cua-driver');
  });

  it('CUA 开启但云端清单已含同名 server → 不重复注册', () => {
    process.env.CODE_AGENT_ENABLE_CUA = '1';
    const picked = pickEnvGatedComputerUseServers(
      getDefaultMCPServers(),
      new Set(['cua-driver']),
    );
    expect(picked.map((s) => s.name)).not.toContain('cua-driver');
  });

  it('CUA 未开启 → 不返回 cua-driver', () => {
    const picked = pickEnvGatedComputerUseServers(getDefaultMCPServers(), new Set());
    expect(picked.map((s) => s.name)).not.toContain('cua-driver');
  });

  it('argus 回退路径同样独立补注册', () => {
    process.env.CODE_AGENT_ENABLE_ARGUS_MCP = '1';
    const picked = pickEnvGatedComputerUseServers(getDefaultMCPServers(), new Set());
    expect(picked.map((s) => s.name)).toContain('argus');
  });

  it('cua-driver 显式开启时保持 lazy，避免未使用 Computer Use 时常驻空转', () => {
    process.env.CODE_AGENT_ENABLE_CUA = '1';
    const cua = getDefaultMCPServers().find((s) => s.name === 'cua-driver');
    // lazyLoad 只在 MCPStdioServerConfig 分支上；cua-driver 是 stdio server，按同一惯例窄化访问。
    expect((cua as { lazyLoad?: boolean } | undefined)?.lazyLoad).toBe(true);
    expect((cua as { env?: Record<string, string> } | undefined)?.env).toMatchObject({
      CUA_DRIVER_MCP_MODE: '1',
      CUA_DRIVER_RS_UPDATE_CHECK: '0',
      CUA_DRIVER_RS_TELEMETRY_ENABLED: 'false',
    });
  });

  it.runIf(process.platform === 'darwin')('签名 helper 通过 bundle 内 launcher 启动，禁止默认 mcp 重启旧 CuaDriver', () => {
    process.env.CODE_AGENT_ENABLE_CUA = '1';
    process.env.CODE_AGENT_CUA_DRIVER_PATH = path.join(
      '/tmp',
      'Agent Neo Computer Use.app',
      'Contents',
      'MacOS',
      'cua-driver',
    );

    const cua = getDefaultMCPServers().find((s) => s.name === 'cua-driver');

    expect(cua).toMatchObject({
      command: path.join(
        '/tmp',
        'Agent Neo Computer Use.app',
        'Contents',
        'Resources',
        'agent-neo-computer-use-mcp.sh',
      ),
      args: [],
    });
  });

  it('不夹带其他默认 server（filesystem/docker 等仍走原有云端优先逻辑）', () => {
    process.env.CODE_AGENT_ENABLE_CUA = '1';
    const picked = pickEnvGatedComputerUseServers(getDefaultMCPServers(), new Set());
    expect(picked.every((s) => s.name === 'cua-driver' || s.name === 'argus')).toBe(true);
  });
});
