// ============================================================================
// initializeCLIServices --bare 纯净模式（N-HEADLESS-BARE-BUILTIN）
// 走真公共入口 initializeCLIServices/buildCLIConfig/syncCLIWorkingDirectory/cleanup，
// mock 只打在模块边界（skills 发现、MCP client、数据库、配置服务等）。
// 钉住的不变量：--bare 下 skills 走 builtin-only、hooks/MCP 仍跳过，
// 且 CODE_AGENT_ENABLE_ARGUS_MCP=1 也不能把 MCP 自动接入带回来；
// 不带 --bare 时三者照常开启（历史行为逐字节不变）。
// ============================================================================
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  // 模拟发现服务的 builtin-only 翻转：bootstrap 的 setBuiltinOnly 真改它，指纹据此如实报告
  const skillServiceState = { builtinOnly: false };
  return {
    skillServiceState,
    skillInitialize: vi.fn(async () => {}),
    skillEnsureInitialized: vi.fn(async () => {}),
    skillSetBuiltinOnly: vi.fn((builtinOnly: boolean) => {
      skillServiceState.builtinOnly = builtinOnly;
    }),
    initMCPClient: vi.fn(async () => {}),
    mcpDisconnectAll: vi.fn(async () => {}),
    getMCPClient: vi.fn(),
    initCLIDatabase: vi.fn(),
    probeEnvCapabilities: vi.fn(async () => {}),
    reapChildProcesses: vi.fn(async () => {}),
  };
});

vi.mock('../../../src/host/services/skills', () => ({
  getSkillDiscoveryService: () => ({
    initialize: mocks.skillInitialize,
    ensureInitialized: mocks.skillEnsureInitialized,
    setBuiltinOnly: mocks.skillSetBuiltinOnly,
    isBuiltinOnly: () => mocks.skillServiceState.builtinOnly,
    isInitialized: () => true,
    getAllSkills: () => [],
  }),
}));

vi.mock('../../../src/host/mcp/mcpClient', () => ({
  initMCPClient: mocks.initMCPClient,
  getMCPClient: () => ({
    disconnectAll: mocks.mcpDisconnectAll,
    // 指纹实况快照从这里读：非 bare 的 mcpServers 必须真的来自 getStatus()
    getStatus: () => ({ connectedServers: ['cli-bare-stub-mcp'] }),
  }),
}));

// computer-use 安装态固定未安装：MCP 触发只剩 env 一条路，测试可控
vi.mock('../../../src/host/plugins/builtin/computerUse/installState', () => ({
  isComputerUseCapabilityInstalledSync: () => false,
}));

vi.mock('../../../src/host/services/core/configService', () => ({
  initConfigService: () => ({
    initialize: async () => {},
    getSettings: () => ({}),
    getApiKey: () => 'test-key',
  }),
  getConfigService: () => ({
    initialize: async () => {},
    getSettings: () => ({}),
    getApiKey: () => 'test-key',
  }),
}));

// 数据库 mock 成 null：走 bootstrap 既有的 fail-safe 分支（警告后继续，durable run 跳过）
vi.mock('../../../src/cli/database', () => ({
  initCLIDatabase: mocks.initCLIDatabase,
}));
vi.mock('../../../src/cli/session', () => ({
  getCLISessionManager: () => ({}),
}));
vi.mock('../../../src/cli/cliLedgerSink', () => ({
  createCliLedgerSink: () => ({}),
}));
vi.mock('../../../src/host/tools/toolLedgerSink', () => ({
  setToolLedgerSink: () => {},
}));

vi.mock('../../../src/host/agent/agentLoop', () => ({
  AgentLoop: vi.fn(),
}));
vi.mock('../../../src/host/tools/toolExecutor', () => ({
  ToolExecutor: class {
    setWorkingDirectory = vi.fn();
  },
}));
vi.mock('../../../src/host/tools/protocolRegistry', () => ({
  getProtocolRegistry: vi.fn(() => ({})),
}));
vi.mock('../../../src/host/telemetry', () => ({
  getTelemetryCollector: vi.fn(),
}));
vi.mock('../../../src/host/services/core/envCapabilities', () => ({
  probeEnvCapabilities: mocks.probeEnvCapabilities,
}));
vi.mock('../../../src/host/tools/shell/shutdownReaper', () => ({
  reapChildProcesses: mocks.reapChildProcesses,
}));

import {
  buildCLIConfig,
  cleanup,
  getCLIEnvironmentFingerprint,
  initializeCLIServices,
  syncCLIWorkingDirectory,
  whenCLIMcpReady,
} from '../../../src/cli/bootstrap';
import { SWARM_TRACE } from '../../../src/shared/constants/storage';

describe('initializeCLIServices --bare 纯净模式', () => {
  let tmpDir: string;
  let savedDataDir: string | undefined;
  let savedArgusEnv: string | undefined;
  let savedSwarmMode: string | undefined;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-bare-test-'));
    savedDataDir = process.env.CODE_AGENT_DATA_DIR;
    savedArgusEnv = process.env.CODE_AGENT_ENABLE_ARGUS_MCP;
    savedSwarmMode = process.env[SWARM_TRACE.STORAGE_MODE_ENV];
    process.env.CODE_AGENT_DATA_DIR = tmpDir;
    // 全程开着旧底座 env 开关：证明 --bare 连显式 env 触发的自动接入都压得住，
    // 同时非 bare 用例里它保证 MCP init 真的走得到（断言取反不落空）。
    process.env.CODE_AGENT_ENABLE_ARGUS_MCP = '1';
    delete process.env[SWARM_TRACE.STORAGE_MODE_ENV];
    vi.clearAllMocks();
    mocks.skillServiceState.builtinOnly = false;
    mocks.initCLIDatabase.mockResolvedValue(null);
    // initCLIDatabase 返回 null 走 fail-safe 警告分支，静默掉避免刷屏
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    if (savedDataDir === undefined) delete process.env.CODE_AGENT_DATA_DIR;
    else process.env.CODE_AGENT_DATA_DIR = savedDataDir;
    if (savedArgusEnv === undefined) delete process.env.CODE_AGENT_ENABLE_ARGUS_MCP;
    else process.env.CODE_AGENT_ENABLE_ARGUS_MCP = savedArgusEnv;
    if (savedSwarmMode !== undefined) process.env[SWARM_TRACE.STORAGE_MODE_ENV] = savedSwarmMode;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('② --bare：skills 走 builtin-only 初始化，MCP 仍不接入（ARGUS_MCP=1 也不破功），hooks 关闭，指纹 builtin-only', async () => {
    await initializeCLIServices({ bare: true });

    expect(mocks.skillInitialize).toHaveBeenCalledTimes(1);
    // 单一真源接线：bare 把发现服务切进 builtin-only（懒加载路径的守门就在那里）
    expect(mocks.skillSetBuiltinOnly).toHaveBeenCalledWith(true);
    expect(mocks.initMCPClient).not.toHaveBeenCalled();
    expect(buildCLIConfig({ bare: true }).enableHooks).toBe(false);
    expect(getCLIEnvironmentFingerprint()).toEqual({
      bare: true,
      skills: 'builtin-only',
      skillCount: 0,
      skillNames: [],
      hooks: 'skipped',
      mcp: 'skipped',
      mcpServers: [],
    });

    // cwd 同步仍不补等 ensureInitialized（hooks/MCP 行为不变）
    await syncCLIWorkingDirectory('/tmp/bare-workspace');
    expect(mocks.skillEnsureInitialized).not.toHaveBeenCalled();

    // shutdown 一致：从未 init 过 MCP，也就不 disconnect；并复位发现服务 builtin-only
    await cleanup();
    expect(mocks.mcpDisconnectAll).not.toHaveBeenCalled();
    expect(mocks.skillServiceState.builtinOnly).toBe(false);
  });

  it('③ 不带 --bare（默认）：skills/MCP 照常初始化、hooks 开启、指纹如实报告（同一断言取反）', async () => {
    await initializeCLIServices();
    // MCP init 是 fire-and-forget promise，等它真跑完再断言
    await whenCLIMcpReady();

    expect(mocks.skillInitialize).toHaveBeenCalledTimes(1);
    expect(mocks.skillSetBuiltinOnly).toHaveBeenCalledWith(false);
    expect(mocks.initMCPClient).toHaveBeenCalledTimes(1);
    expect(buildCLIConfig({}).enableHooks).toBe(true);
    expect(getCLIEnvironmentFingerprint()).toEqual({
      bare: false,
      skills: 'loaded',
      skillCount: 0,
      hooks: 'loaded',
      mcp: 'loaded',
      mcpServers: ['cli-bare-stub-mcp'],
    });

    await syncCLIWorkingDirectory('/tmp/full-workspace');
    expect(mocks.skillEnsureInitialized).toHaveBeenCalledTimes(1);

    await cleanup();
    expect(mocks.mcpDisconnectAll).toHaveBeenCalledTimes(1);
  });
});
