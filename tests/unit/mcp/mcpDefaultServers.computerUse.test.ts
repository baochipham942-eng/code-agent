import * as path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import {
  pickEnvGatedComputerUseServers,
  getDefaultMCPServers,
} from '../../../src/host/mcp/mcpDefaultServers';
import type { MCPServerConfig } from '../../../src/host/mcp/types';

// 背景（2026-06-11 真机验证）：initMCPClient 里云端 MCP 清单与本地默认清单
// 是「二选一」，云端清单存在时本地默认清单整体被跳过——导致 cua-driver/argus
// 这类由环境变量门控的本机能力 server 在有云端配置的机器上永远不会注册。
// computer-use 底座必须独立于云端清单补注册。
//
// 2026-07-29 重写：原先每条都拿 getDefaultMCPServers() 当输入，而默认清单里
// cua-driver 的 enabled = cuaEnabled && (darwin || win32)。后果是同一份测试在
// Linux CI 上一半变红、另一半**假绿**——`not.toContain('cua-driver')` 在那儿
// 永远通过，因为它本来就是 disabled，等于什么都没守。
// 现在拆两层：① picker 是纯函数，喂合成输入 → 平台无关，每个平台都真守逻辑；
// ② 真实默认清单/平台相关的断言显式按平台跑，跳过时理由写在用例名里。
const CUA_SUPPORTED = process.platform === 'darwin' || process.platform === 'win32';

/** 合成一份「默认清单」样本：只放 picker 关心的字段。 */
function defaultsFixture(options: {
  cuaEnabled?: boolean;
  argusEnabled?: boolean;
} = {}): MCPServerConfig[] {
  return [
    { name: 'filesystem', type: 'stdio', command: 'npx', args: [], enabled: true },
    { name: 'context7', type: 'stdio', command: 'npx', args: [], enabled: true },
    { name: 'cua-driver', type: 'stdio', command: 'cua-driver', args: [], enabled: options.cuaEnabled ?? false },
    { name: 'argus', type: 'stdio', command: 'node', args: [], enabled: options.argusEnabled ?? false },
  ] as MCPServerConfig[];
}

describe('pickEnvGatedComputerUseServers — computer-use 底座独立于云端清单', () => {
  it('已启用且未注册 → 返回 cua-driver 待补注册', () => {
    const picked = pickEnvGatedComputerUseServers(
      defaultsFixture({ cuaEnabled: true }),
      new Set(['context7']),
    );
    expect(picked.map((s) => s.name)).toContain('cua-driver');
  });

  it('云端清单已含同名 server → 不重复注册', () => {
    const picked = pickEnvGatedComputerUseServers(
      defaultsFixture({ cuaEnabled: true }),
      new Set(['cua-driver']),
    );
    expect(picked.map((s) => s.name)).not.toContain('cua-driver');
  });

  it('未启用 → 不返回（这条在任何平台都真的在守 enabled 过滤）', () => {
    const picked = pickEnvGatedComputerUseServers(defaultsFixture({ cuaEnabled: false }), new Set());
    expect(picked.map((s) => s.name)).not.toContain('cua-driver');
  });

  it('argus 回退路径同样独立补注册', () => {
    const picked = pickEnvGatedComputerUseServers(defaultsFixture({ argusEnabled: true }), new Set());
    expect(picked.map((s) => s.name)).toContain('argus');
  });

  it('不夹带其他默认 server（filesystem/context7 等仍走原有云端优先逻辑）', () => {
    const picked = pickEnvGatedComputerUseServers(
      defaultsFixture({ cuaEnabled: true, argusEnabled: true }),
      new Set(),
    );
    expect(picked.every((s) => s.name === 'cua-driver' || s.name === 'argus')).toBe(true);
  });
});

// 下面依赖真实默认清单：cua-driver 的 enabled 受 process.platform 门控
// （仅 darwin/win32 supported），Linux 上显式跳过而不是假装通过。
describe.runIf(CUA_SUPPORTED)('真实默认清单上的 cua-driver 形态（仅 macOS / Windows）', () => {
  afterEach(() => {
    delete process.env.CODE_AGENT_ENABLE_CUA;
    delete process.env.CODE_AGENT_CUA_DRIVER_PATH;
  });

  it('显式开启时保持 lazy，避免未使用 Computer Use 时常驻空转', () => {
    process.env.CODE_AGENT_ENABLE_CUA = '1';
    const cua = getDefaultMCPServers().find((s) => s.name === 'cua-driver');
    expect(cua, 'cua-driver 应出现在受支持平台的默认清单里').toBeTruthy();
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
});
