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
// 2026-07-29：这个文件同日被两个会话分别修过，合并后取两边各自更强的一半。
//   起因——默认清单里 cua-driver 的 enabled = cuaEnabled && (darwin || win32)，
//   而原用例直接拿 getDefaultMCPServers() 当输入，于是在 Linux CI 上一半变红、
//   另一半**假绿**（`not.toContain('cua-driver')` 恒过，因为它本来就 disabled）。
//   ① 平台闸必须在测试里钉死，而不是按平台跳过——跳过等于 CI 永远不验这条逻辑，
//      门自带盲区。所以下面涉及真实默认清单的用例一律 stub process.platform。
//   ② picker 本身是纯函数，它的其余不变量（去重 / argus / 不夹带别的 server /
//      enabled 过滤）用合成清单喂，跟默认清单和宿主环境彻底解耦。
const CUA_SUPPORTED_PLATFORM = 'darwin';
const CUA_UNSUPPORTED_PLATFORM = 'linux';

/** 在钉死的 process.platform 下执行——覆盖平台闸，且任何 runner 上都真跑。 */
function withPlatform<T>(platform: string, fn: () => T): T {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, 'platform', original);
  }
}

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

afterEach(() => {
  delete process.env.CODE_AGENT_ENABLE_CUA;
  delete process.env.CODE_AGENT_ENABLE_ARGUS_MCP;
  delete process.env.CODE_AGENT_CUA_DRIVER_PATH;
});

describe('平台闸：cua-driver 的 enabled 受 process.platform 门控', () => {
  it('CUA 开启 + 受支持平台 → 返回 cua-driver 待补注册', () => {
    withPlatform(CUA_SUPPORTED_PLATFORM, () => {
      process.env.CODE_AGENT_ENABLE_CUA = '1';
      const picked = pickEnvGatedComputerUseServers(getDefaultMCPServers(), new Set(['context7']));
      expect(picked.map((s) => s.name)).toContain('cua-driver');
    });
  });

  it('CUA 开启但平台不支持（linux）→ 不返回 cua-driver', () => {
    withPlatform(CUA_UNSUPPORTED_PLATFORM, () => {
      process.env.CODE_AGENT_ENABLE_CUA = '1';
      const picked = pickEnvGatedComputerUseServers(getDefaultMCPServers(), new Set());
      expect(picked.map((s) => s.name)).not.toContain('cua-driver');
    });
  });

  it('受支持平台但 CUA 未开启 → 不返回 cua-driver', () => {
    withPlatform(CUA_SUPPORTED_PLATFORM, () => {
      const picked = pickEnvGatedComputerUseServers(getDefaultMCPServers(), new Set());
      expect(picked.map((s) => s.name)).not.toContain('cua-driver');
    });
  });
});

describe('pickEnvGatedComputerUseServers 的纯逻辑（合成清单，与宿主环境解耦）', () => {
  it('云端清单已含同名 server → 不重复注册', () => {
    const picked = pickEnvGatedComputerUseServers(
      defaultsFixture({ cuaEnabled: true }),
      new Set(['cua-driver']),
    );
    expect(picked.map((s) => s.name)).not.toContain('cua-driver');
  });

  it('未启用 → 不返回（任何平台上都真的在守 enabled 过滤）', () => {
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

// 真实默认清单上的形态。同样 stub 平台，所以 Linux runner 上照跑不跳过。
describe('真实默认清单上的 cua-driver 形态', () => {
  it('显式开启时保持 lazy，避免未使用 Computer Use 时常驻空转', () => {
    withPlatform(CUA_SUPPORTED_PLATFORM, () => {
      process.env.CODE_AGENT_ENABLE_CUA = '1';
      const cua = getDefaultMCPServers().find((s) => s.name === 'cua-driver');
      expect(cua, 'cua-driver 应出现在受支持平台的默认清单里').toBeTruthy();
      // lazyLoad 只在 MCPStdioServerConfig 分支上；cua-driver 是 stdio server，按同一惯例窄化访问。
      expect((cua as { lazyLoad?: boolean } | undefined)?.lazyLoad).toBe(true);
      // toEqual 而非 toMatchObject：CUA_DRIVER_MCP_MODE 曾在这里躺了很久——上游从来
      // 没有这个变量、Neo 自己也没有一处读它，却被断言钉住，制造「配置生效」的错觉。
      // 全等断言让下一个凭空加进来的 env 立刻打红。
      expect((cua as { env?: Record<string, string> } | undefined)?.env).toEqual({
        CUA_DRIVER_RS_UPDATE_CHECK: '0',
        CUA_DRIVER_RS_TELEMETRY_ENABLED: 'false',
      });
    });
  });

  it('签名 helper 通过 bundle 内 launcher 启动，禁止默认 mcp 重启旧 CuaDriver', () => {
    withPlatform(CUA_SUPPORTED_PLATFORM, () => {
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
});
